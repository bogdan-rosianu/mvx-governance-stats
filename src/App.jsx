import React, { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PieChart, Pie, ResponsiveContainer, Tooltip, Legend, Cell } from 'recharts'
import { motion } from 'framer-motion'

// --- Config ---
const ES_URL = import.meta.env.VITE_ES_URL ||
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? '/api/events/_search'
    : 'https://index.multiversx.com/events/_search')

const GOVERNANCE_SC = 'erd1qqqqqqqqqqqqqqqpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrlllsrujgla'

const DELEGATION_LABELS = {
  'erd1qqqqqqqqqqqqqpgqxwakt2g7u9atsnr03gqcgmhcv38pt7mkd94q6shuwt': 'Legacy Delegation',
  'erd1qqqqqqqqqqqqqpgq6uzdzy54wnesfnlaycxwymrn9texlnmyah0ssrfvk6': 'xoxno',
  'erd1qqqqqqqqqqqqqpgq4gzfcw7kmkjy8zsf04ce6dl0auhtzjx078sslvrf4e': 'hatom',
}

// --- Simple 1-minute cache for POST JSON ---
const CACHE_TTL_MS = 60_000
const _cache = new Map()
async function postJsonCached(url, body, ttlMs = CACHE_TTL_MS) {
  const key = url + '|' + JSON.stringify(body)
  const now = Date.now()
  const hit = _cache.get(key)
  if (hit && (now - hit.time) < ttlMs) return hit.data

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  _cache.set(key, { time: now, data })
  return data
}

// --- Utilities ---
const hexToAscii = (hex) => {
  if (!hex) return ''
  try {
    const bytes = hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []
    return String.fromCharCode(...bytes).replace(/\u0000+$/g, '')
  } catch {
    return ''
  }
}

const hexToBigInt = (hex) => {
  if (!hex) return 0n
  const h = hex.length % 2 === 1 ? '0' + hex : hex
  try {
    return BigInt('0x' + h)
  } catch {
    return 0n
  }
}

// bech32 encoding for MultiversX (hrp "erd"). Minimal implementation.
const bech32Polymod = (values) => {
  const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if (((b >> i) & 1) !== 0) chk ^= GENERATORS[i]
    }
  }
  return chk
}

const bech32HrpExpand = (hrp) => {
  const ret = []
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5)
  ret.push(0)
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31)
  return ret
}

const bech32CreateChecksum = (hrp, data) => {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])
  const mod = bech32Polymod(values) ^ 1
  const rv = []
  for (let p = 0; p < 6; p++) rv.push((mod >> (5 * (5 - p))) & 31)
  return rv
}

const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

const bech32Encode = (hrp, data) => {
  const combined = data.concat(bech32CreateChecksum(hrp, data))
  let out = hrp + '1'
  for (const d of combined) out += BECH32_ALPHABET[d]
  return out
}

// convert 8-bit bytes to 5-bit groups
const convertBits = (data, from, to, pad = true) => {
  let acc = 0
  let bits = 0
  const ret = []
  const maxv = (1 << to) - 1
  for (const value of data) {
    if (value < 0 || value >> from) return null
    acc = (acc << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      ret.push((acc >> bits) & maxv)
    }
  }
  if (pad) {
    if (bits) ret.push((acc << (to - bits)) & maxv)
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null
  }
  return ret
}

const hexToBech32Erd = (hex32) => {
  if (!hex32) return undefined
  try {
    const bytes = hex32.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []
    if (bytes.length !== 32) return undefined
    const five = convertBits(bytes, 8, 5, true)
    return bech32Encode('erd', five)
  } catch {
    return undefined
  }
}

// Format bigints as eGLD (assume 18 decimals)
const EGLD_DEC = 18n
const thousands = (n) => Number(n).toLocaleString('en-US')
const bigThousands = (bi) => bi.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const formatEgld = (amount) => {
  const neg = amount < 0n
  let a = neg ? -amount : amount
  const int = a / 10n ** EGLD_DEC
  const frac = a % 10n ** EGLD_DEC
  const fracStr = frac.toString().padStart(Number(EGLD_DEC), '0').slice(0, 4)
  return `${neg ? '-' : ''}${bigThousands(int)}.${fracStr} EGLD`
}

// Convert BigInt amount (18 decimals) to a JS number of EGLD, with safe scaling
const toEgldNumber = (amount) => {
  // keep 4 decimals precision: divide by 1e14 as BigInt, then by 1e4 as Number
  const scaled = amount / 10n ** 14n
  return Number(scaled) / 1e4
}

// Voting option decoding
const decodeOption = (hex) => {
  const s = hexToAscii(hex).toLowerCase()
  if (s === 'yes') return 'yes'
  if (s === 'no') return 'no'
  if (s === 'abstain') return 'abstain'
  if (s === 'veto' || s === 'ncv' || s === 'veto_power') return 'veto'
  return 'unknown'
}

// --- Fetching from Elasticsearch ---
const buildQuery = (from = 0, size = 10000) => ({
  from,
  size,
  sort: [{ timestamp: { order: 'asc' } }],
  query: {
    bool: {
      must: [
        {
          bool: {
            should: [
              { term: { address: GOVERNANCE_SC } },
              { term: { logAddress: GOVERNANCE_SC } },
            ],
          },
        },
        { terms: { identifier: ['vote', 'delegateVote'] } },
      ],
    },
  },
})

export default function GovernanceDashboard() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rawHits, setRawHits] = useState([])
  const [limit, setLimit] = useState(10000)

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await postJsonCached(ES_URL, buildQuery(0, limit))
      setRawHits((data?.hits?.hits ?? []))
    } catch (e) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Aggregations ---
  const stats = useMemo(() => {
    const byOption = {
      yes: { option: 'yes', count: 0, power: 0n },
      no: { option: 'no', count: 0, power: 0n },
      abstain: { option: 'abstain', count: 0, power: 0n },
      veto: { option: 'veto', count: 0, power: 0n },
      unknown: { option: 'unknown', count: 0, power: 0n },
    }

    const perCategoryAddresses = {
      yes: new Map(),
      no: new Map(),
      abstain: new Map(),
      veto: new Map(),
      unknown: new Map(),
    }

    let totalPower = 0n

    // Delegation source breakdown
    const delegationBreakdown = new Map()
    const delegationCountBreakdown = new Map()

    for (const hit of rawHits) {
      const s = hit._source
      const id = s.identifier
      const t = s.topics || []
      if (!t.length) continue

      if (id === 'vote') {
        // Topics: [proposal, option, userStake, votePower]
        const option = decodeOption(t[1])
        const voterAddr = s.address
        const userStake = hexToBigInt(t[2])
        const votePower = hexToBigInt(t[3])
        byOption[option].count += 1
        byOption[option].power += votePower
        totalPower += votePower
        // per-address granularity from _source.address
        const m = perCategoryAddresses[option]
        const prev = m.get(voterAddr) ?? { stake: 0n, power: 0n, count: 0 }
        m.set(voterAddr, { stake: prev.stake + userStake, power: prev.power + votePower, count: prev.count + 1 })
      } else if (id === 'delegateVote') {
        // Topics: [proposal, option, voter(32 bytes), userStake, votePower]
        const option = decodeOption(t[1])
        const voterHex = t[2]
        const voterAddr = hexToBech32Erd(voterHex) ?? voterHex
        const userStake = hexToBigInt(t[3])
        const votePower = hexToBigInt(t[4])

        byOption[option].count += 1
        byOption[option].power += votePower
        totalPower += votePower

        const m = perCategoryAddresses[option]
        const prev = m.get(voterAddr) ?? { stake: 0n, power: 0n, count: 0 }
        m.set(voterAddr, { stake: prev.stake + userStake, power: prev.power + votePower, count: prev.count + 1 })

        // delegation source label by the contract in _source.address
        const src = s.address ?? 'others'
        const label = DELEGATION_LABELS[src] ?? 'others'
        delegationBreakdown.set(label, (delegationBreakdown.get(label) ?? 0n) + votePower)
        delegationCountBreakdown.set(label, (delegationCountBreakdown.get(label) ?? 0) + 1)
      }
    }

    const pieDataOptions = Object.values(byOption).map((x) => ({ name: x.option, value: toEgldNumber(x.power) }))

    const pieDelegation = Array.from(delegationBreakdown.entries()).map(([name, power]) => ({ name, value: toEgldNumber(power) }))

    const pieDataOptionsCount = Object.values(byOption).map((x) => ({ name: x.option, value: x.count }))

    const pieDelegationCount = Array.from(delegationCountBreakdown.entries()).map(([name, count]) => ({ name, value: count }))

    const topPerCategory = (opt) =>
      Array.from(perCategoryAddresses[opt].entries())
        .map(([addr, v]) => ({ address: addr, stake: v.stake, power: v.power, count: v.count }))
        .sort((a, b) => Number(b.power - a.power))
        .slice(0, 50)

    return {
      byOption,
      totalPower,
      pieDataOptions,
      pieDelegation,
      lists: {
        yes: topPerCategory('yes'),
        no: topPerCategory('no'),
        abstain: topPerCategory('abstain'),
        veto: topPerCategory('veto'),
        unknown: topPerCategory('unknown'),
      },
      pieDataOptionsCount,
      pieDelegationCount,
    }
  }, [rawHits])

  const optionCards = ['yes', 'no', 'abstain', 'veto', 'unknown'].map((k) => {
    const x = (stats.byOption)[k]
    return (
      <Card key={k} className="rounded-2xl shadow-sm">
        <CardContent className="p-4">
          <div className="text-sm uppercase tracking-wide text-gray-500">{k}</div>
          <div className="text-2xl font-semibold mt-1">{x.count.toLocaleString()} votes</div>
          <div className="text-xs text-gray-500">Power: {formatEgld(BigInt(x.power))}</div>
        </CardContent>
      </Card>
    )
  })

  const Table = ({ rows }) => {
    const [expanded, setExpanded] = useState(false)
    const visible = expanded ? rows : rows.slice(0, 10)
    return (
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-4">Address</th>
              <th className="py-2 pr-4">Vote Power</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.address} className="border-b hover:bg-gray-50">
                <td className="py-2 pr-4 font-mono">{r.address}</td>
                <td className="py-2 pr-4">{formatEgld(r.power)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 10 && (
          <div className="mt-3">
            <Button variant="outline" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'See less' : 'See more'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  const COLORS = {
    yes: '#22c55e', // green-500
    no: '#ef4444', // red-500
    abstain: '#a3a3a3', // neutral-400
    veto: '#f59e0b', // amber-500
    unknown: '#6366f1', // indigo-500
    default: ['#60a5fa', '#34d399', '#f87171', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#4ade80'],
  }

  const formatNumber = (n, decimals = 0) =>
    Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  const valueFormatter = (value) => `${formatNumber(value, 2)} EGLD`
  const valueFormatterVotes = (value) => `${formatNumber(value, 0)}`

  const RADIAN = Math.PI / 180
  const makePercentLabel = (minPercent = 3) => (props) => {
    const { cx, cy, midAngle, outerRadius, percent, name } = props
    const pct = percent * 100
    if (pct < minPercent) return null
    const r = outerRadius + 16
    const x = cx + r * Math.cos(-midAngle * RADIAN)
    const y = cy + r * Math.sin(-midAngle * RADIAN)
    return (
      <text x={x} y={y} fill="#334155" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" className="text-xs">
        {name}: {pct.toFixed(1)}%
      </text>
    )
  }
  const PercentLabel = makePercentLabel(3)
  const makeValueLabel = (minPercent = 3, fmt = (v) => `${v}`) => (props) => {
    const { cx, cy, midAngle, outerRadius, percent, name, value } = props
    const pct = percent * 100
    if (pct < minPercent) return null
    const r = outerRadius + 16
    const x = cx + r * Math.cos(-midAngle * RADIAN)
    const y = cy + r * Math.sin(-midAngle * RADIAN)
    return (
      <text x={x} y={y} fill="#334155" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" className="text-xs">
        {name}: {fmt(value)}
      </text>
    )
  }
  const ValueLabelVotes = makeValueLabel(3, valueFormatterVotes)

  const ChartTable = ({ rows, mode = 'power' }) => {
    const [expanded, setExpanded] = useState(false)
    const sorted = [...rows].sort((a, b) => b.value - a.value)
    const visible = expanded ? sorted : sorted.slice(0, 10)
    const fmt = mode === 'power' ? valueFormatter : valueFormatterVotes
    return (
      <div className="overflow-auto">
        <table className="text-xs" style={{ width: '100%', maxWidth: 360 }}>
          <thead>
            <tr className="text-left border-b">
              <th className="pr-3" style={{ padding: '4px 8px' }}>Name</th>
              <th className="pr-0 text-right" style={{ padding: '4px 8px' }}>Value</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.name} className="border-b hover:bg-gray-50">
                <td className="pr-3" style={{ padding: '4px 8px' }}>{r.name}</td>
                <td className="pr-0 text-right font-medium" style={{ padding: '4px 8px' }}>{fmt(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 10 && (
          <div className="mt-3">
            <Button variant="outline" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'See less' : 'See more'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <motion.h1 initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="text-3xl font-bold">
        MultiversX Governance Dashboard
      </motion.h1>

      <Card className="rounded-2xl">
        <CardContent className="p-4 flex flex-wrap gap-3 items-center">
          <div className="text-sm text-gray-600">Querying ES index for events where address/logAddress =</div>
          <code className="px-2 py-1 bg-gray-100 rounded text-xs font-mono">{GOVERNANCE_SC}</code>
          <div className="ml-auto flex gap-2 items-center">
            <Input
              type="number"
              min={100}
              max={50000}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-32"
              placeholder="size"
            />
            <Button onClick={fetchData} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="text-red-600">Error fetching data: {error}. In dev, a proxy is configured to avoid CORS.</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">{optionCards}</div>

      <Card className="rounded-2xl">
        <CardContent className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <div className="h-80">
              <div className="text-sm mb-2 font-medium">Voting Options (by voting power)</div>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={stats.pieDataOptions} dataKey="value" nameKey="name" labelLine label={PercentLabel} outerRadius={120}>
                    {stats.pieDataOptions.map((entry) => (
                      <Cell key={entry.name} fill={COLORS[entry.name] || '#60a5fa'} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => [valueFormatter(v), 'Power']} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ChartTable rows={stats.pieDataOptions} mode="power" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <div className="h-80">
              <div className="text-sm mb-2 font-medium">Delegated Votes by Source (by voting power)</div>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={stats.pieDelegation} dataKey="value" nameKey="name" labelLine label={PercentLabel} outerRadius={120}>
                    {stats.pieDelegation.map((_, idx) => (
                      <Cell key={idx} fill={COLORS.default[idx % COLORS.default.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => [valueFormatter(v), 'Power']} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ChartTable rows={stats.pieDelegation} mode="power" />
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardContent className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <div className="h-80">
              <div className="text-sm mb-2 font-medium">Voting Options (by number of votes)</div>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                <Pie data={stats.pieDataOptionsCount} dataKey="value" nameKey="name" labelLine label={ValueLabelVotes} outerRadius={120}>
                    {stats.pieDataOptionsCount.map((entry) => (
                      <Cell key={entry.name} fill={COLORS[entry.name] || '#60a5fa'} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => [valueFormatterVotes(v), 'Votes']} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ChartTable rows={stats.pieDataOptionsCount} mode="votes" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <div className="h-80">
              <div className="text-sm mb-2 font-medium">Delegated Votes by Source (by number of votes)</div>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                <Pie data={stats.pieDelegationCount} dataKey="value" nameKey="name" labelLine label={ValueLabelVotes} outerRadius={120}>
                    {stats.pieDelegationCount.map((_, idx) => (
                      <Cell key={idx} fill={COLORS.default[idx % COLORS.default.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => [valueFormatterVotes(v), 'Votes']} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ChartTable rows={stats.pieDelegationCount} mode="votes" />
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardContent className="p-4">
          <div className="text-sm text-gray-500">Total Voting Power</div>
          <div className="text-2xl font-semibold">{formatEgld(stats.totalPower)}</div>
          <div className="mt-2 text-sm text-gray-500">Total Votes</div>
          <div className="text-xl font-semibold">{(
            stats.byOption.yes.count +
            stats.byOption.no.count +
            stats.byOption.abstain.count +
            stats.byOption.veto.count +
            stats.byOption.unknown.count
          ).toLocaleString()}</div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-lg font-semibold mb-3">YES — Top voters by power</div><Table rows={stats.lists.yes} /></CardContent></Card>
        <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-lg font-semibold mb-3">NO — Top voters by power</div><Table rows={stats.lists.no} /></CardContent></Card>
        <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-lg font-semibold mb-3">ABSTAIN — Top voters by power</div><Table rows={stats.lists.abstain} /></CardContent></Card>
        <Card className="rounded-2xl"><CardContent className="p-4"><div className="text-lg font-semibold mb-3">VETO — Top voters by power</div><Table rows={stats.lists.veto} /></CardContent></Card>
      </div>

      <div className="text-xs text-gray-500">
        Notes: Direct `vote` events use `_source.address` as the voter. Delegated votes decode voter from `topics[2]`. Amounts assume 18 decimals. Server cache TTL: 60s.
      </div>
    </div>
  )
}
