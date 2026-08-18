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
wrangler secret put APP_PASSWORD
wrangler secret put SESSION_SECRET

wrangler deploy
```

`APP_PASSWORD` is the shared password shown to authorized staff. Use a long,
random password and distribute it only through an approved channel.

`SESSION_SECRET` signs browser sessions. Generate a separate random value (for
example, with `openssl rand -base64 32`) and never share it. Changing either
`SESSION_SECRET` invalidates active sessions after their next request. Changing
`APP_PASSWORD` changes the password required for future sign-ins. Rotate both
secrets after a password-security event.

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

- The Worker requires the shared password for every API request. Login attempts
  are limited to five per IP address in a 15-minute window, and sessions expire
  after eight hours.

- Your two Slate tokens and Anthropic key live only in the Worker (via
  `wrangler secret`) — never in the frontend or the repo.
- The Worker caches the parameter options in KV for 12 hours to cut down
  on Slate calls; call `GET /api/options?refresh=1` to force a refresh.
- The API also supports a two-step CSV export for integrations. After signing
  in through `POST /api/login` and retaining its session cookie, send
  `POST /api/export` with `{ "prompt": "admitted students for fall 2026" }`.
  The response contains `downloadUrl`; request that URL with `GET` and the
  same session cookie to receive the CSV. Export files are retained in KV for
  15 minutes, then `GET` returns `404`.
- Cloudflare's free tier (100k requests/day) comfortably covers a
  medium-size office.
- Before scaling this beyond testing, move off your personal Anthropic
  key onto an org key so usage is billed and rate-limited separately.
