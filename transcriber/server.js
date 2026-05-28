require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const FormData = require('form-data');
const axios    = require('axios');
const AdmZip   = require('adm-zip');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');
const { spawn } = require('child_process');
const {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  TextRun, HeadingLevel, WidthType, AlignmentType, ShadingType, BorderStyle
} = require('docx');

const app  = express();
const PORT = process.env.TOOLS_PORT || 3007; // internal port — never uses Railway's PORT
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn('\n⚠️  OPENAI_API_KEY not set — AI features will return errors but server will still start.\n');
}

// ── Dirs ─────────────────────────────────────────────────────
const OUTPUT_DIR  = path.join(__dirname, 'output');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[OUTPUT_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d); });

// ── CORS (allow admin panel on any local port) ────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Static frontend ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
// Also serve the site root (translate/) so admin.html is reachable at
// http://localhost:3007/admin.html — avoids file:// CORS / Private Network
// Access issues when using Assist Apply locally.
app.use(express.static(path.join(__dirname, '..')));

// ── Multer: audio ─────────────────────────────────────────────
const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `audio_${Date.now()}${path.extname(file.originalname) || '.webm'}`)
});
const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /audio|video|octet-stream/.test(file.mimetype) ||
               /\.(mp3|mp4|m4a|wav|webm|ogg|mpeg|mpga|flac)$/i.test(file.originalname);
    cb(null, ok);
  }
});

// ── Multer: SDLPPX ────────────────────────────────────────────
const sdlppxStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `sdlppx_${Date.now()}.sdlppx`)
});
const uploadSdlppx = multer({
  storage: sdlppxStorage,
  limits: { fileSize: 200 * 1024 * 1024 } // 200 MB
});

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

function fmt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// ── Build Transcription Word doc ──────────────────────────────
async function buildTranscriptDocx(segments, meta) {
  const { filename, language, duration } = meta;
  const dateStr = new Date().toLocaleString('en-GB');

  const hdrCell = (text) => new TableCell({
    shading: { type: ShadingType.SOLID, color: '2563EB' },
    borders: { top:{style:BorderStyle.NONE}, bottom:{style:BorderStyle.NONE},
               left:{style:BorderStyle.NONE}, right:{style:BorderStyle.NONE} },
    children: [new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 20 })] })]
  });

  const dataCell = (text, align = AlignmentType.LEFT, bold = false) => new TableCell({
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
      left:   { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
      right:  { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
    },
    children: [new Paragraph({ alignment: align,
      children: [new TextRun({ text: String(text), bold, size: 20 })] })]
  });

  const doc = new Document({
    creator: 'Hebrew/English Transcriber — benjyalper.com',
    title: `Transcription: ${filename}`,
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 100 },
          children: [new TextRun({ text: '🎙 Transcription', bold: true, size: 36, color: '1E3A8A' })] }),
        new Paragraph({ spacing: { after: 60 }, children: [
          new TextRun({ text: 'File: ', bold: true, size: 20 }),
          new TextRun({ text: filename, size: 20 }),
          new TextRun({ text: '   |   Date: ', bold: true, size: 20 }),
          new TextRun({ text: dateStr, size: 20 }),
        ]}),
        new Paragraph({ spacing: { after: 60 }, children: [
          new TextRun({ text: 'Language: ', bold: true, size: 20 }),
          new TextRun({ text: language || 'Auto-detected', size: 20 }),
          new TextRun({ text: '   |   Duration: ', bold: true, size: 20 }),
          new TextRun({ text: fmt(duration || 0), size: 20 }),
          new TextRun({ text: '   |   Segments: ', bold: true, size: 20 }),
          new TextRun({ text: String(segments.length), size: 20 }),
        ]}),
        new Paragraph({ spacing: { before: 200, after: 200 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2563EB' } }, children: [] }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          columnWidths: [1200, 1200, 7100],
          rows: [
            new TableRow({ tableHeader: true, children: [hdrCell('Start'), hdrCell('End'), hdrCell('Transcript')] }),
            ...segments.map(seg => new TableRow({ children: [
              dataCell(fmt(seg.start), AlignmentType.CENTER, true),
              dataCell(fmt(seg.end),   AlignmentType.CENTER, true),
              dataCell(seg.text.trim()),
            ]}))
          ]
        }),
        new Paragraph({ spacing: { before: 400 }, alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: '— End of Transcription —', italics: true, color: '6B7280', size: 18 })] }),
      ]
    }]
  });
  return Packer.toBuffer(doc);
}

// ─────────────────────────────────────────────────────────────
//  TRADOS HELPERS
// ─────────────────────────────────────────────────────────────

function xmlToPlaceholders(xml) {
  return xml.replace(/<x\s+id="(\d+)"\s*\/>/g, (_, id) => `{{TAG_${id}}}`);
}
function placeholdersToXml(text) {
  return text.replace(/\{\{TAG_(\d+)\}\}/g, (_, id) => `<x id="${id}"/>`);
}
function isTranslatableText(text) {
  const plain = text.replace(/\{\{TAG_\d+\}\}/g, '').trim();
  return plain.length > 0;
}

function extractSegments(content) {
  const segments = [];
  const unitRegex = /<trans-unit\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/trans-unit>/g;
  let unitMatch;
  while ((unitMatch = unitRegex.exec(content)) !== null) {
    const unitId   = unitMatch[1];
    const unitBody = unitMatch[2];
    const segSrcRegex = /<mrk\s+mtype="seg"\s+mid="(\d+)">([\s\S]*?)<\/mrk>/g;
    let srcMatch;
    while ((srcMatch = segSrcRegex.exec(unitBody)) !== null) {
      const mid           = srcMatch[1];
      const rawSourceXml  = srcMatch[2];
      const sourceText    = xmlToPlaceholders(rawSourceXml);
      let targetText = '';
      const tgtBlockMatch = unitBody.match(/<target>([\s\S]*?)<\/target>/);
      if (tgtBlockMatch) {
        const tgtMrk = tgtBlockMatch[1].match(
          new RegExp(`<mrk\\s+mtype="seg"\\s+mid="${mid}">(([\\s\\S]*?))<\\/mrk>`)
        );
        if (tgtMrk) targetText = tgtMrk[2].trim();
      }
      segments.push({ unitId, mid, rawSourceXml, sourceText, targetText, unitStart: unitMatch.index });
    }
  }
  return segments;
}

function insertTranslation(content, seg, hebrewText) {
  const xmlText    = placeholdersToXml(hebrewText);
  const selfClosing = `<mrk mtype="seg" mid="${seg.mid}"/>`;
  const filled      = `<mrk mtype="seg" mid="${seg.mid}">${xmlText}</mrk>`;
  let newContent    = content.replace(selfClosing, filled);
  if (newContent === content) {
    const emptyOpenClose = new RegExp(`<mrk\\s+mtype="seg"\\s+mid="${seg.mid}"\\s*>\\s*<\\/mrk>`);
    newContent = content.replace(emptyOpenClose, filled);
  }
  return newContent.replace(
    new RegExp(`(<sdl:seg\\s+id="${seg.mid}")(\\s*\\/?>)`),
    (match, open, close) => match.includes('conf=') ? match : `${open} conf="Translated"${close}`
  );
}

async function translateBatchGPT(texts) {
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const systemPrompt = `You are a professional translator. Translate each numbered item into Hebrew (he-IL).
Rules:
- Preserve ALL placeholders exactly: {{TAG_0}}, {{TAG_1}}, etc. — do NOT modify them
- Output ONLY the numbered translations, one per line, same order
- Use formal Hebrew suitable for professional documents
- No explanations or notes`;

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: numbered }
      ],
      temperature: 0.2,
    },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 120_000 }
  );

  const output = res.data.choices[0].message.content.trim();
  const lines  = output.split('\n').filter(l => l.trim());
  const translations = [];
  for (const line of lines) {
    const m = line.match(/^\d+\.\s*([\s\S]+)$/);
    if (m) translations.push(m[1].trim());
  }
  while (translations.length < texts.length) translations.push('');
  return translations;
}

async function processXliffFile(xliffPath) {
  let content  = fs.readFileSync(xliffPath, 'utf8');
  const segs   = extractSegments(content);
  const empty  = segs.filter(s => !s.targetText && isTranslatableText(s.sourceText));
  if (empty.length === 0) return { translated: 0, total: segs.length };

  const BATCH = parseInt(process.env.BATCH_SIZE || '20', 10);
  let translated = 0;
  for (let i = 0; i < empty.length; i += BATCH) {
    const batch = empty.slice(i, i + BATCH);
    console.log(`  Translating segments ${i+1}–${Math.min(i+BATCH, empty.length)} of ${empty.length}…`);
    const translations = await translateBatchGPT(batch.map(s => s.sourceText));
    for (let j = 0; j < batch.length; j++) {
      if (translations[j]) { content = insertTranslation(content, batch[j], translations[j]); translated++; }
    }
    if (i + BATCH < empty.length) await new Promise(r => setTimeout(r, 500));
  }
  fs.writeFileSync(xliffPath, content, 'utf8');
  return { translated, total: segs.length };
}

function addDirToZip(zip, baseDir, currentDir) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const full    = path.join(currentDir, entry.name);
    const zipPath = path.relative(baseDir, currentDir);
    if (entry.isDirectory()) addDirToZip(zip, baseDir, full);
    else zip.addLocalFile(full, zipPath);
  }
}

// ─────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────

// ── POST /api/whisper ─────────────────────────────────────────
// Thin proxy to OpenAI's audio endpoints. Browsers can't call them
// directly anymore (OpenAI tightened CORS), so the admin tools route
// through here. Forwards multipart upload + accepts the user's API
// key via the x-openai-key header (or falls back to OPENAI_API_KEY).
//
// Body fields:
//   file       - audio blob (multer "file" field)
//   mode       - 'transcribe' (default) | 'translate'
//   language   - source-language hint (transcribe only, ISO code like 'he')
//   prompt     - optional Whisper context prompt (vocab / code-switching hints)
//
// Uses memory storage so we don't write to disk for every proxy call.
const uploadAudioMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB — Whisper hard-caps at 25 MB but
                                            // give the proxy headroom so OpenAI's clean
                                            // error message bubbles through, not Multer's
  fileFilter: (req, file, cb) => {
    const ok = /audio|video|octet-stream/.test(file.mimetype) ||
               /\.(mp3|mp4|m4a|wav|webm|ogg|mpeg|mpga|flac)$/i.test(file.originalname);
    cb(null, ok);
  }
});

// Multer error handler — catches LIMIT_FILE_SIZE before it bubbles to nginx as a generic 413
app.post('/api/whisper', (req, res, next) => {
  uploadAudioMem.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: { message: 'Upload exceeds server limit (100 MB). Pick a shorter time range in the Transcriber so the client slices first.' } });
    }
    if (err) return res.status(500).json({ error: { message: 'Upload failed: ' + err.message } });
    next();
  });
}, async (req, res) => {
  const userKey = req.headers['x-openai-key'] || OPENAI_API_KEY;
  if (!userKey) return res.status(400).json({ error: { message: 'No API key — set one in the admin panel or configure OPENAI_API_KEY on the server.' } });
  if (!req.file) return res.status(400).json({ error: { message: 'No file uploaded' } });

  const mode = req.body.mode === 'translate' ? 'translate' : 'transcribe';
  const endpoint = mode === 'translate' ? 'translations' : 'transcriptions';

  const form = new FormData();
  form.append('file', req.file.buffer, {
    filename: req.file.originalname || 'audio.wav',
    contentType: req.file.mimetype || 'audio/wav',
  });
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  // /translations does NOT accept the language parameter
  if (mode === 'transcribe' && req.body.language && req.body.language !== 'auto') {
    form.append('language', req.body.language);
  }
  if (req.body.prompt) form.append('prompt', req.body.prompt);

  try {
    console.log(`[whisper-proxy] ${mode} · ${req.file.size/1024/1024 | 0} MB · prompt: ${(req.body.prompt || '').slice(0,40)}…`);
    const response = await axios.post(
      `https://api.openai.com/v1/audio/${endpoint}`,
      form,
      {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${userKey}` },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 180_000,
      }
    );
    res.json(response.data);
  } catch (e) {
    const status = e.response?.status || 500;
    const body   = e.response?.data || { error: { message: e.message || 'whisper proxy failed' } };
    console.error('[whisper-proxy] error', status, body);
    res.status(status).json(body);
  }
});

// ── POST /api/transcribe ──────────────────────────────────────
app.post('/api/transcribe', uploadAudio.single('audio'), async (req, res) => {
  const audioPath = req.file?.path;
  if (!audioPath) return res.status(400).json({ error: 'No audio file received.' });

  const language = req.body.language || 'auto';
  try {
    console.log(`\n📎  Audio: ${req.file.originalname} (${(req.file.size/1024).toFixed(1)} KB) | lang: ${language}`);

    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), {
      filename:    req.file.originalname || 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm',
    });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (language !== 'auto') form.append('language', language);

    console.log('🤖  Sending to Whisper…');
    const whisperRes = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${OPENAI_API_KEY}` },
        maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 120_000 }
    );

    const data     = whisperRes.data;
    const segments = data.segments || [];
    const detectedLang = data.language || language;
    const duration = data.duration || (segments.length ? segments[segments.length-1].end : 0);
    console.log(`✅  ${segments.length} segments, lang: ${detectedLang}, dur: ${fmt(duration)}`);

    const docBuffer = await buildTranscriptDocx(segments, { filename: req.file.originalname || 'audio', language: detectedLang, duration });
    const outName   = `transcript_${Date.now()}.docx`;
    fs.writeFileSync(path.join(OUTPUT_DIR, outName), docBuffer);
    fs.unlinkSync(audioPath);

    res.json({ ok: true, language: detectedLang, duration, segments, fullText: data.text, docFile: outName });

  } catch (err) {
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    console.error('❌ Transcription error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message || 'Transcription failed' });
  }
});

// ── POST /api/trados ──────────────────────────────────────────
app.post('/api/trados', uploadSdlppx.single('sdlppx'), async (req, res) => {
  const sdlppxPath = req.file?.path;
  if (!sdlppxPath) return res.status(400).json({ error: 'No SDLPPX file received.' });

  const targetLang = (req.body.lang || 'he-IL').trim();
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlppx_'));

  try {
    console.log(`\n📦  SDLPPX: ${req.file.originalname} | target: ${targetLang}`);

    // 1. Extract ZIP
    const zip = new AdmZip(sdlppxPath);
    zip.extractAllTo(tmpDir, true);

    // 2. Find target lang folder (exact or partial match)
    const allDirs = fs.readdirSync(tmpDir)
      .filter(d => fs.statSync(path.join(tmpDir, d)).isDirectory());
    const langDir = allDirs.find(d => d === targetLang || d.startsWith(targetLang.split('-')[0]))
      ? path.join(tmpDir, allDirs.find(d => d === targetLang || d.startsWith(targetLang.split('-')[0])))
      : null;

    if (!langDir || !fs.existsSync(langDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.unlinkSync(sdlppxPath);
      return res.status(400).json({ error: `Language folder "${targetLang}" not found. Available: ${allDirs.join(', ')}` });
    }

    // 3. Find SDLXLIFF files
    const xliffFiles = fs.readdirSync(langDir)
      .filter(f => f.endsWith('.sdlxliff'))
      .map(f => path.join(langDir, f));

    if (xliffFiles.length === 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.unlinkSync(sdlppxPath);
      return res.status(400).json({ error: 'No .sdlxliff files found in the target language folder.' });
    }

    console.log(`📄  Found ${xliffFiles.length} SDLXLIFF file(s) in ${path.basename(langDir)}/`);

    // 4. Translate each file
    let totalTranslated = 0, totalSegments = 0;
    for (const xliffPath of xliffFiles) {
      console.log(`  → ${path.basename(xliffPath)}`);
      const { translated, total } = await processXliffFile(xliffPath);
      totalTranslated += translated;
      totalSegments   += total;
    }

    // 5. Create SDLRPX return package
    const base    = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const outName = `${base}_TRANSLATED_${Date.now()}.sdlrpx`;
    const outPath = path.join(OUTPUT_DIR, outName);
    const returnZip = new AdmZip();
    addDirToZip(returnZip, tmpDir, tmpDir);
    returnZip.writeZip(outPath);
    console.log(`✅  SDLRPX saved: ${outName} | translated: ${totalTranslated}/${totalSegments} segments`);

    // Cleanup
    fs.unlinkSync(sdlppxPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({ ok: true, translated: totalTranslated, total: totalSegments, files: xliffFiles.length, docFile: outName });

  } catch (err) {
    if (fs.existsSync(sdlppxPath)) try { fs.unlinkSync(sdlppxPath); } catch {}
    if (fs.existsSync(tmpDir))     try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.error('❌ Trados error:', err.message);
    res.status(500).json({ error: err.message || 'Translation failed' });
  }
});

// ── GET /api/download/:filename ───────────────────────────────
app.get('/api/download/:filename', (req, res) => {
  const safe     = path.basename(req.params.filename);
  const filePath = path.join(OUTPUT_DIR, safe);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  const friendlyName = safe.startsWith('transcript_')
    ? 'Transcription.docx'
    : safe.replace(/^.*_TRANSLATED_\d+/, 'Translated').replace('.sdlrpx', '_return.sdlrpx');
  res.download(filePath, friendlyName);
});

// ── POST /api/scrape ──────────────────────────────────────────
// Runs the JobScraper AND calls GPT-4o to discover extra AI-sourced jobs.
// Merges both into jobs-data.json and returns stats.

// SITE_ROOT: in Docker = /usr/share/nginx/html, locally = parent of transcriber/
const SITE_ROOT    = process.env.SITE_ROOT || path.join(__dirname, '..');
const JOBS_FILE    = path.join(SITE_ROOT, 'JobScraper', 'jobs-data.json');
const SCRAPER_FILE = path.join(SITE_ROOT, 'JobScraper', 'scraper.js');

// Run node scraper.js and resolve when done
function runScraperProcess() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SCRAPER_FILE], {
      cwd: path.dirname(SCRAPER_FILE),
      env: process.env,
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error('Scraper exited with code ' + code + '\n' + out));
    });
    proc.on('error', reject);
  });
}

// Ask GPT-4o to discover Hebrew translation jobs it knows about
async function getAIJobs() {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are a professional job aggregator specialising in Hebrew-English translation work.

List 20 real, active Hebrew-English translation / localisation / transcription jobs from well-known hiring platforms (ProZ, Upwork, LinkedIn, TranslatorsCafe, Gengo, Unbabel, Smartcat, etc.).

Return ONLY a valid JSON array — no markdown, no code fences, no explanation. Each element:
{"id":"ai-<slug>","title":"Job title","company":"Company","location":"Remote","type":"Remote","description":"One sentence max 200 chars","url":"https://platform-url","source":"AI Discovery","postedDate":"${today}","tags":["hebrew","translation"],"salary":""}

Focus on Hebrew-English pairs: document translation, legal/medical, subtitling, interpreting, transcription. Real companies only.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-5.4-mini',
        temperature: 0.3,
        messages: [
          { role: 'system', content: 'You output only raw JSON arrays, never markdown or code fences.' },
          { role: 'user',   content: prompt }
        ],
      }, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 90000,
      });

      const raw  = res.data.choices[0].message.content.trim();
      console.log(`  [getAIJobs attempt ${attempt}] raw[0:80]:`, JSON.stringify(raw.slice(0, 80)));
      // Strip any accidental code fences
      const text = raw.replace(/^```[\w]*\s*/i, '').replace(/```\s*$/, '').trim();
      const jobs = JSON.parse(text);
      if (Array.isArray(jobs) && jobs.length > 0) return jobs;
      console.warn(`  [getAIJobs attempt ${attempt}] Parsed but got ${Array.isArray(jobs) ? 0 : 'non-array'}. Retrying…`);
    } catch(e) {
      console.warn(`  [getAIJobs attempt ${attempt}] Error: ${e.response?.data?.error?.message || e.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return [];
}

let scrapeInProgress = false;

app.post('/api/scrape', async (req, res) => {
  if (scrapeInProgress) {
    return res.json({ ok: false, error: 'Scrape already running — please wait and try again in a moment.' });
  }
  scrapeInProgress = true;
  console.log('🔍 /api/scrape — running real scrapers (AI discovery disabled)…');
  const log = [];

  try {
    // Run the real scraper (free public APIs + translation marketplaces).
    // AI Discovery removed — it hallucinated jobs with placeholder URLs.
    // On failure we DON'T fall back to the existing jobs-data.json
    // (which could be a stale snapshot baked into the docker image).
    // Instead we surface the failure and any captured subprocess output so
    // the admin UI can show the real status.
    let scraperJobs = [];
    let scraperOk = false;
    let scraperRaw = '';
    try {
      scraperRaw = await runScraperProcess();
      scraperOk = true;
      log.push('✓ scraper.js finished');
      console.log(scraperRaw);
      if (fs.existsSync(JOBS_FILE)) {
        const d = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        scraperJobs = d.jobs || [];
      }
    } catch (e) {
      log.push('⚠ scraper.js error: ' + e.message);
      console.warn(e.message);
      // Capture output for debugging but do NOT fall back to old jobs-data.json
      scraperRaw = e.message;
    }

    // Extract per-source counts from the scraper output for the response log
    const sourceHits = [];
    scraperRaw.split('\n').forEach(line => {
      const m = line.match(/^\s*[✓✗]\s+([^:]+):\s*(\d+)?/);
      if (m) sourceHits.push(line.trim());
    });
    if (sourceHits.length) log.push('Source breakdown:', ...sourceHits.slice(0, 25));

    const seen = new Set();
    const scrapeDate = new Date().toISOString().slice(0, 10);
    const merged = scraperJobs.filter(j => {
      if (!j || !j.id) return false;
      if (seen.has(j.id)) return false;
      seen.add(j.id);
      return true;
    }).map(j => ({ ...j, scrapedDate: scrapeDate }))
      .sort((a, b) => new Date(b.postedDate) - new Date(a.postedDate));

    const output = { lastUpdated: new Date().toISOString(), count: merged.length, jobs: merged };
    try {
      fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
      fs.writeFileSync(JOBS_FILE, JSON.stringify(output, null, 2));
      log.push(`✓ Saved ${merged.length} total jobs to jobs-data.json`);
    } catch(e) {
      log.push(`⚠ Could not save jobs-data.json: ${e.message}`);
      console.warn('jobs-data.json write failed:', e.message);
    }

    res.json({ ok: true, total: merged.length, scraper: scraperJobs.length, ai: 0, jobs: merged, log });
  } finally {
    scrapeInProgress = false;
  }
});

// ── POST /api/assist-apply ────────────────────────────────────
// Launches a visible Chromium via Playwright, navigates to the job URL,
// auto-fills detectable fields + uploads CV + pastes a GPT-drafted cover
// letter, then leaves the browser open for the user to review & submit.
// Only runs locally (requires a display — skip on Railway).
app.use(express.json({ limit: '1mb' }));

const ASSIST_SCRIPT = path.join(__dirname, 'assistApply.js');
const PROFILE_FILE  = path.join(__dirname, 'profile.json');

async function draftCoverLetter({ jobTitle, jobCompany, jobDescription }) {
  if (!OPENAI_API_KEY) {
    return `Dear ${jobCompany || 'hiring team'},\n\nI'm Benjy Alper, a Hebrew-English translator with 10+ years of experience and 500+ completed projects across legal, medical, business, technical, and literary work. I'd love to help with "${jobTitle || 'this role'}".\n\nTypical turnaround is under 24 hours. References and sample translations available on request.\n\nBest,\nBenjy\nbenjyalper@hotmail.com | +972 50-991-6633`;
  }
  let profile = {};
  try { profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')); } catch {}

  const prompt = `Write a concise, professional cover letter (120-180 words) for this translation job. Address it to the company if known. Sound human, specific, and confident — no fluff, no em-dashes, no "I am writing to apply".

Job title: ${jobTitle || 'N/A'}
Company: ${jobCompany || 'N/A'}
Description: ${(jobDescription || '').slice(0, 1500)}

Applicant profile:
- Name: ${profile.fullName}
- ${profile.headline}
- ${profile.summary}
- Specializations: ${(profile.specializations || []).join('; ')}
- Tools: ${(profile.tools || []).join(', ')}
- Contact: ${profile.email} | ${profile.phoneDisplay}

Sign off with just the name, email, and phone. No subject line. No placeholders.`;

  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: 'gpt-5.4-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.6, max_completion_tokens: 400 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.warn('cover-letter draft failed:', e.message);
    return `Hello,\n\nI'm Benjy Alper, a Hebrew-English translator with 10+ years of experience. I'd like to be considered for ${jobTitle || 'this role'}.\n\nBest,\nBenjy\nbenjyalper@hotmail.com`;
  }
}

app.post('/api/assist-apply', async (req, res) => {
  const { jobUrl, jobTitle = '', jobCompany = '', jobDescription = '' } = req.body || {};
  if (!jobUrl) return res.status(400).json({ error: 'jobUrl is required' });

  // Guard: Playwright needs a display. Railway containers don't have one.
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_STATIC_URL) {
    return res.status(400).json({ error: 'Assisted apply only runs locally — Railway has no display.' });
  }

  try {
    const coverLetter = await draftCoverLetter({ jobTitle, jobCompany, jobDescription });
    const payload = JSON.stringify({ jobUrl, jobTitle, jobCompany, coverLetter });

    // Spawn detached so the browser keeps running after the HTTP response
    const child = spawn('node', [ASSIST_SCRIPT, payload], {
      cwd: __dirname,
      env: process.env,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => process.stdout.write('[assist] ' + d));
    child.stderr.on('data', d => process.stderr.write('[assist] ' + d));
    child.on('error', e => console.error('assist spawn error:', e.message));

    res.json({ ok: true, message: 'Browser launching — fields will be auto-filled. Review and submit manually.', coverLetter });
  } catch (e) {
    console.error('assist-apply error:', e);
    res.status(500).json({ error: e.message || 'Assisted apply failed' });
  }
});

// ── GET /api/status ───────────────────────────────────────────
app.get('/api/status', (req, res) => res.json({
  ok: true,
  version: '2.1',
  firmsDb: !!process.env.DATABASE_URL,      // is cross-device sync available?
  firmsAuth: !!process.env.ADMIN_TOKEN,     // is it password-protected?
}));

// ─────────────────────────────────────────────────────────────
//  CLIENT / FIRM MEMORY — Postgres-backed cross-device sync
// ─────────────────────────────────────────────────────────────
// Backs the Email tool's per-firm correspondence memory so it syncs
// across devices (laptop + iPhone). The browser never touches Postgres
// directly — it calls these endpoints, which read DATABASE_URL +
// ADMIN_TOKEN from the environment (never hardcoded).

let _pgPool = null;
let _pgInitPromise = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pgPool) {
    const { Pool } = require('pg');
    _pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },   // Railway PG proxy uses SSL
      connectionTimeoutMillis: 10000,
      max: 5,
    });
    _pgPool.on('error', err => console.error('[pg] idle client error:', err.message));
  }
  return _pgPool;
}
async function ensureFirmsTable() {
  const pool = getPool();
  if (!pool) return;
  if (!_pgInitPromise) {
    _pgInitPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS firms (
        id         TEXT PRIMARY KEY,
        name       TEXT,
        data       JSONB NOT NULL,
        updated_at BIGINT
      )`).catch(e => { _pgInitPromise = null; throw e; });
  }
  return _pgInitPromise;
}

// Token gate. If ADMIN_TOKEN is set, require a matching X-Admin-Token
// header. If unset, allow but warn loudly (dev only — set it on Railway).
function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    console.warn('[firms] ADMIN_TOKEN not set — endpoints are UNPROTECTED. Set it on Railway.');
    return next();
  }
  if (req.headers['x-admin-token'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized — bad or missing admin token.' });
  }
  next();
}
function firmsDbGuard(res) {
  if (!getPool()) {
    res.status(503).json({ error: 'Database not configured (DATABASE_URL missing on the server).' });
    return false;
  }
  return true;
}

// GET all firms → { firms: [ ...firmData ] }
app.get('/api/firms', requireAdminToken, async (req, res) => {
  if (!firmsDbGuard(res)) return;
  try {
    await ensureFirmsTable();
    const r = await getPool().query('SELECT data FROM firms ORDER BY updated_at DESC NULLS LAST');
    res.json({ firms: r.rows.map(row => row.data) });
  } catch (e) {
    console.error('[firms] GET failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT { firms: [...] } → upsert each. Does NOT delete firms missing from
// the payload (removals go through DELETE) so two devices can't wipe each
// other's additions on a stale full-sync.
app.put('/api/firms', requireAdminToken, async (req, res) => {
  if (!firmsDbGuard(res)) return;
  const firms = Array.isArray(req.body && req.body.firms) ? req.body.firms : null;
  if (!firms) return res.status(400).json({ error: 'Body must be { firms: [...] }' });
  try {
    await ensureFirmsTable();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      for (const f of firms) {
        if (!f || !f.id) continue;
        await client.query(
          `INSERT INTO firms (id, name, data, updated_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET name=$2, data=$3, updated_at=$4`,
          [f.id, f.name || '', JSON.stringify(f), f.updatedAt || Date.now()]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, count: firms.length });
  } catch (e) {
    console.error('[firms] PUT failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/firms/:id → remove one firm
app.delete('/api/firms/:id', requireAdminToken, async (req, res) => {
  if (!firmsDbGuard(res)) return;
  try {
    await ensureFirmsTable();
    await getPool().query('DELETE FROM firms WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[firms] DELETE failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎙  Transcriber + Trados server → http://localhost:${PORT}`);
  console.log(`   Transcriber UI:  http://localhost:${PORT}/`);
  console.log(`   Trados API:      POST http://localhost:${PORT}/api/trados\n`);
});
