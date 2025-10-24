Governance Dashboard — Local Run Guide

**THIS IS AI GENERATED**

Overview
- Minimal Vite + React app to render the MultiversX governance dashboard UI from `src/App.jsx`.
- Elasticsearch POST requests are cached in-memory for 1 minute.
- Dev server proxies `/es/*` to `https://index.multiversx.com/*` to avoid CORS in local development.

Prerequisites
- Node.js 18+ and npm.

Setup
1) Install dependencies:
   npm install

2) Start the caching API server (terminal A):
   npm run api

3) Start the dev server (terminal B):
   npm run dev

4) Open the printed local URL (typically http://localhost:5173).

Configuration
- ES URL
  - Local dev: frontend calls `/api/events/_search`, proxied to the local cache server on port 3000.
  - To override, set: 
    VITE_ES_URL=https://index.multiversx.com/events/_search npm run dev

Caching
- Server-level in-memory cache for ES POST with TTL 60 seconds.
- Key = upstream ES URL + request body. Changing `size` or filters bypasses cached entries.
- Env overrides: `PORT`, `ES_URL`, `CACHE_TTL_MS`.

Notes
- The UI uses simple shims for Card/Button/Input to avoid external UI kit requirements. Tailwind-like classes in markup are harmless but not required.
- Charts require `recharts`; animations use `framer-motion`. Both are declared in `package.json`.

Data notes
- Direct `vote` events: `_source.address` is the voter; topics are `[proposal, option, userStake, votePower]`.
- Delegated votes: voter is decoded from `topics[2]` (32-byte bech32). Amounts assume 18 decimals.
