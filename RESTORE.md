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

## The only secret

`OPENAI_API_KEY` — used by the transcriber and the GPT-backed admin tools.
- **Live site:** stored in Railway's env-var dashboard (survives a laptop loss).
- **Local dev:** recreate `transcriber/.env` from `transcriber/.env.example` and paste
  the key. Keep the key itself in a password manager — it is **never** committed
  (`.gitignore` blocks `.env` / `*.env`).

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
