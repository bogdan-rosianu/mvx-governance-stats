import http from 'node:http'
import { URL } from 'node:url'

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000
const ES_URL = process.env.ES_URL || 'https://index.multiversx.com/events/_search'
const CACHE_TTL_MS = process.env.CACHE_TTL_MS ? Number(process.env.CACHE_TTL_MS) : 60_000

const cache = new Map()

function send(res, status, headers, body = '') {
  res.writeHead(status, headers)
  res.end(body)
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

const server = http.createServer(async (req, res) => {
  try {
    setCors(res)

    // Handle CORS preflight
    if (req.method === 'OPTIONS') return send(res, 204, {})

    const url = new URL(req.url, `http://${req.headers.host}`)

    if (req.method === 'POST' && url.pathname === '/api/events/_search') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const key = ES_URL + '|' + raw
      const now = Date.now()
      const hit = cache.get(key)
      if (hit && (now - hit.time) < CACHE_TTL_MS) {
        return send(res, 200, {
          'Content-Type': 'application/json',
          'X-Cache': 'HIT',
        }, hit.body)
      }

      const upstream = await fetch(ES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      })
      const text = await upstream.text()
      if (!upstream.ok) {
        return send(res, upstream.status, {
          'Content-Type': 'application/json',
          'X-Cache': 'MISS',
        }, text)
      }
      cache.set(key, { time: now, body: text })
      return send(res, 200, {
        'Content-Type': 'application/json',
        'X-Cache': 'MISS',
      }, text)
    }

    // Fallback route
    send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found')
  } catch (e) {
    send(res, 500, { 'Content-Type': 'text/plain' }, 'Internal Server Error')
  }
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[cache-api] listening on http://localhost:${PORT}`)
})

