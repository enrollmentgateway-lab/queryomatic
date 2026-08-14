# Enrollment Query Tool — Setup

Two pieces: a Cloudflare Worker (holds your secrets, calls Slate + Anthropic)
and a static page (goes on GitHub Pages).

## 1. Deploy the Worker

```bash
npm install -g wrangler
wrangler login

cd slate-query-tool
wrangler kv namespace create OPTIONS_CACHE
# paste the returned id into wrangler.toml under [[kv_namespaces]]

wrangler secret put SLATE_TOKEN_PROMPTS
wrangler secret put SLATE_TOKEN_MAINDB
wrangler secret put ANTHROPIC_API_KEY

wrangler deploy
```

Edit `wrangler.toml` first:
- `SLATE_QUERY_URL` — the query that returns the actual export data
- `SLATE_OPTIONS_URL` — a separate Slate query that returns the valid
  values for term/year/status/etc. (the "prompt" endpoint)
- `ALLOWED_ORIGIN` — your GitHub Pages URL, e.g. `https://yourorg.github.io`

`wrangler deploy` prints your Worker URL, e.g.
`https://slate-query-tool.yoursubdomain.workers.dev`.

## 2. Deploy the frontend

Open `index.html` and set:

```js
const WORKER_URL = "https://slate-query-tool.yoursubdomain.workers.dev";
```

Push this repo to GitHub, enable **Settings → Pages → Deploy from branch**,
and point it at the branch/folder containing `index.html`.

## Notes

- Your two Slate tokens and Anthropic key live only in the Worker (via
  `wrangler secret`) — never in the frontend or the repo.
- The Worker caches the parameter options in KV for 12 hours to cut down
  on Slate calls; call `GET /api/options?refresh=1` to force a refresh.
- Cloudflare's free tier (100k requests/day) comfortably covers a
  medium-size office.
- Before scaling this beyond testing, move off your personal Anthropic
  key onto an org key so usage is billed and rate-limited separately.