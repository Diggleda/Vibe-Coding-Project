# Star Chart Systems (GitHub Pages + AI Chat)

GitHub Pages is static hosting, so it **cannot** safely run OpenAI calls directly from the browser (you would have to ship your API key to every visitor). The included chat uses a small **AI proxy** instead.

This repo supports two modes:

## Local dev (your laptop)

1. Create `.env`:
   - `OPENAI_API_KEY=...`
   - `CCD_AI_OPENAI_MODEL=gpt-4.1`
2. Run: `node server.js`
3. Open the printed `http://localhost:PORT`

## GitHub Pages (production)

### 1) Deploy the AI proxy (recommended: Cloudflare Worker)

Files:
- `worker.js` (edge proxy)
- `wrangler.toml` (build/deploy config for Cloudflare’s GitHub integration)

Steps (Cloudflare Workers):
1. Create a new Worker and paste in `worker.js`.
2. Add Worker secrets/vars:
   - Secret: `OPENAI_API_KEY`
   - Var (optional): `OPENAI_MODEL` (example: `gpt-4.1`)
   - Var (optional): `ALLOWED_ORIGINS` (example: `https://YOURUSER.github.io`)
3. Deploy the Worker and copy its HTTPS URL.

If you connected this GitHub repo to Cloudflare Workers, Cloudflare will run `wrangler deploy` automatically. `wrangler.toml` tells it to deploy `worker.js` (not static assets).

### 2) Point the site at the proxy

Edit `config.js`:
- `window.STAR_CHART_AI_PROXY_BASE = "https://YOUR-WORKER.example.workers.dev";`

Now the chat works seamlessly on GitHub Pages over HTTPS.

If you don’t want to commit `config.js` changes, you can also paste the URL into the UI’s “AI server URL” field and click **Use** (it’s stored in `localStorage`).
