# RESTORE — rebuilding the translate stack on a new machine

Everything in this repo (translator website, admin tools, transcriber, and the
Starling Copilot extension) is versioned here. A full rebuild is a clone + install
+ one secret. This file is the checklist.

## What's in this repo

| Piece | Path | What it is |
|-------|------|------------|
| Admin tools | `admin.html` | Single-file toolbox (XBench, Trados, LQA, etc.). Static HTML. |
| Site root | `index.html`, `tools-index.json` | Landing / tool index. Static HTML. |
| Transcriber | `transcriber/` | Node/Express server (`server.js`). Also serves the static tools above. |
| Starling Copilot | `starling-copilot/` | Chrome MV3 extension (Starling + YiCAT adapters). |
| Support | `kb/`, `HebEngExamples/`, `JobScraper/` | Knowledge base / examples / scraper. |

## Secrets / env vars (Railway dashboard; local `transcriber/.env`)

Never committed — `.gitignore` blocks `.env` / `*.env`. Keep them in a password manager.

- **`OPENAI_API_KEY`** — used by the transcriber and the GPT-backed admin tools.
- **`ADMIN_PASSWORD`** — the admin-page login password. The server gates `admin.html`
  and only serves it to a browser holding a valid signed session cookie (set after you
  POST this password to `/api/admin/login`). **Must be set on Railway** — if unset the
  server logs a warning and serves the admin page ungated. Falls back to `ADMIN_TOKEN`
  if `ADMIN_PASSWORD` isn't set.
- **`ADMIN_TOKEN`** — server-side token gating the `/api/firms` data endpoints (sent as
  the `X-Admin-Token` header from the admin UI's sync feature). Keep it set on Railway.
- **`ADMIN_SESSION_SECRET`** (optional) — HMAC key that signs the admin session cookie;
  defaults to `ADMIN_PASSWORD`. Set a separate random value if you want to rotate the
  login password without invalidating existing sessions (or vice-versa).

Local dev: recreate `transcriber/.env` from `transcriber/.env.example` and paste the
values. There is **no password in the page source** anymore — access is server-side.

## New-machine restore steps

1. **Install Node 18.16.0.** (Next 13.5.x and the toolchain here target this; newer
   Node may break things.)

2. **Clone:**
   ```bash
   git clone https://github.com/benjyalper/translate.git
   cd translate
   ```

3. **Fix git TLS for this network** (HTTPS interception re-signs certs, so push/fetch
   fail with "unable to get local issuer certificate" without this):
   ```bash
   git config --global http.sslBackend schannel
   ```

4. **Install deps** (transcriber is the only part with a `package.json`):
   ```bash
   cd transcriber
   npm install
   ```
   If installs hang / fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, point npm at the
   exported Windows root CA bundle first:
   ```bash
   npm config set cafile "C:/Users/<you>/.certs/win-root-ca.pem"
   ```
   (Re-export the PEM from the Windows cert store if you don't have it — see project memory.)

5. **Restore the secret:**
   ```bash
   cp transcriber/.env.example transcriber/.env
   ```
   Edit `transcriber/.env` and paste `OPENAI_API_KEY` from your password manager.

6. **Run the server** (serves the transcriber API *and* the static tools):
   ```bash
   cd transcriber
   npm start
   ```
   Then open the admin tools at `http://localhost:3006/admin.html`
   (port comes from `PORT` in `.env`).

7. **Load the Chrome extension:**
   - Chrome → `chrome://extensions` → enable **Developer mode**
   - **Load unpacked** → select the `starling-copilot/` folder in this repo.

## Backup model (already in place)

- **GitHub** (`benjyalper/translate`) — source of truth for all code.
- **Google Drive** — the repo lives under `G:\My Drive\...`, so Drive is a live 2nd copy.
- **Railway** — runs the deployed site off GitHub, independent of the laptop.
- **Password manager** — the only off-git item: `OPENAI_API_KEY`.

Not backed up by design (regenerable): `transcriber/node_modules/`,
`transcriber/uploads/`, `transcriber/output/`, and any local `.env`.
