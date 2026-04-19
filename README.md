# Benjy Alper — Hebrew-English Translation Portfolio

A full-stack portfolio site for a professional Hebrew-English translator, including a live job board, AI-powered tools panel, and production Docker deployment.

---

## Project Structure

```
translate/
├── admin.html              # Admin panel (job board + Tools tab)
├── index.html              # Public portfolio site
├── nginx.conf              # Nginx config (serves static + proxies tools server)
├── Dockerfile              # Production Docker image (Railway)
├── start.sh                # Entrypoint: starts nginx + tools server
│
├── JobScraper/
│   ├── scraper.js          # Multi-source job scraper (RSS + APIs + HTML)
│   ├── jobs-data.json      # Job board data (auto-updated by scraper)
│   └── package.json
│
└── transcriber/
    ├── server.js           # Tools API server (port 3007)
    ├── public/index.html   # Standalone Transcriber UI
    ├── .env                # OPENAI_API_KEY + PORT (git-ignored)
    └── package.json
```

---

## Quick Start (Local Development)

### 1. Clone & install

```bash
git clone https://github.com/benjyalper/translate.git
cd translate/transcriber
npm install
```

### 2. Configure API key

```bash
cp .env.example .env
# Edit .env and add your OpenAI API key:
# OPENAI_API_KEY=sk-proj-...
# PORT=3007
```

### 3. Start the Tools server

```bash
cd translate/transcriber
node server.js
# → http://localhost:3007
```

### 4. Open the admin panel

Open `admin.html` in a browser (or via a local web server on port 80).

Default password: `adar1` (set in admin.html lock screen).

---

## Admin Panel

### Job Board Tab (📋 Jobs)

Displays all jobs from `JobScraper/jobs-data.json`.

**⚡ Refresh Jobs button** — fully automated:
1. Calls the tools server at `POST /api/scrape`
2. Runs `scraper.js` (scrapes RemoteOK, WeWorkRemotely, LinkedIn, Remotive, etc.)
3. Asks **GPT-4o** to discover 20 additional Hebrew translation jobs
4. Merges + deduplicates all results → saves to `jobs-data.json`
5. Reloads the job grid automatically

> **Requires**: Tools server running (`node transcriber/server.js`)

### Tools Tab (🛠 Tools)

Two embedded tools accessible from the admin panel:

---

## 🎙 Transcriber Tool

Transcribes Hebrew or English audio to a Word document (.docx) with timestamps.

**Features:**
- Record from microphone or upload an audio file (mp3, wav, webm, m4a, ogg — up to 25 MB)
- Auto-detect language, or force Hebrew / English
- Powered by **OpenAI Whisper** (`whisper-1`, verbose JSON mode)
- Output: `.docx` with a table: Start | End | Transcript
- Hebrew segments rendered right-to-left

**Standalone UI:** `http://localhost:3007/`

**API endpoint:**
```
POST /api/transcribe
Content-Type: multipart/form-data

Fields:
  audio     — audio file (required)
  language  — "he" | "en" | "" (auto-detect)
```

Response:
```json
{
  "ok": true,
  "language": "he",
  "duration": 47.2,
  "segments": [...],
  "fullText": "...",
  "docFile": "transcript_1234567890.docx"
}
```

Download the file:
```
GET /api/download/transcript_1234567890.docx
```

---

## 🔄 Trados Auto-Translator Tool

Translates Trados Studio SDLPPX packages using GPT-4o and returns an SDLRPX return package ready to import.

**Features:**
- Upload any `.sdlppx` Trados package
- Select target language (he-IL / he / iw-IL)
- Extracts SDLXLIFF segments, sends batches of 20 to GPT-4o
- Preserves inline tags (replaces with `{{TAG_N}}` placeholders during translation)
- Returns a valid `.sdlrpx` package importable into Trados Studio 2021+

**API endpoint:**
```
POST /api/trados
Content-Type: multipart/form-data

Fields:
  sdlppx      — .sdlppx file (required, up to 200 MB)
  targetLang  — "he-IL" | "he" | "iw-IL" (default: "he-IL")
```

Response:
```json
{
  "ok": true,
  "translated": 142,
  "total": 142,
  "files": ["file.sdlxliff"],
  "docFile": "TRANSLATED_1234567890.sdlrpx"
}
```

**Importing into Trados Studio:**
1. In Trados Studio → open your project
2. Go to **Project** → **Update Main Translation Memories**
3. Click **Import Return Package** → select the downloaded `.sdlrpx` file
4. All translated segments are imported with `conf="Translated"` status

---

## Job Scraper (Manual)

Run independently to refresh the job board:

```bash
cd JobScraper
npm install
node scraper.js
```

Sources scraped:
- RemoteOK API
- WeWorkRemotely RSS
- WorkingNomads RSS
- Remotive API
- LinkedIn (public job listings)
- Arbeitnow
- The Muse

Plus **GPT-4o AI discovery** (via the tools server's `/api/scrape` endpoint).

---

## Tools Server API Reference

Base URL: `http://localhost:3007`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Standalone Transcriber UI |
| `GET` | `/api/status` | Health check `{"ok":true,"version":"2.0"}` |
| `POST` | `/api/transcribe` | Transcribe audio → .docx |
| `POST` | `/api/trados` | Translate SDLPPX → SDLRPX |
| `POST` | `/api/scrape` | Run scraper + AI job discovery |
| `GET` | `/api/download/:file` | Download output file |

---

## Production Deployment (Railway)

The site runs as a single Docker container on Railway:

```bash
# Build locally (optional test)
docker build -t translate .
docker run -p 80:80 -e OPENAI_API_KEY=sk-proj-... translate
```

The `Dockerfile` uses `nginx:alpine` with a custom `start.sh` that:
1. Starts `node transcriber/server.js` in the background
2. Starts `nginx` in the foreground

The `nginx.conf` proxies `/api/*` requests from the public domain to `localhost:3007`.

### Environment variables (set in Railway dashboard)

| Variable | Value |
|----------|-------|
| `OPENAI_API_KEY` | Your OpenAI API key |
| `PORT` | 3007 (tools server internal port) |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| Tools server | Node.js + Express |
| Transcription | OpenAI Whisper API |
| Translation | OpenAI GPT-4o |
| Word export | `docx` v9.6.1 |
| SDLPPX handling | `adm-zip` |
| Job scraping | `axios` + `cheerio` + `rss-parser` |
| Web server | Nginx |
| Deployment | Railway (Docker) |

---

## License

Private portfolio project — all rights reserved.
