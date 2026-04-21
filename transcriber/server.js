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
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Static frontend ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

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
      model: process.env.OPENAI_MODEL || 'gpt-4o',
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
        model: 'gpt-4o',
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
  console.log('🔍 /api/scrape — running scraper + AI discovery…');
  const log = [];

  try {
    // 1. Run the regular scraper
    let scraperJobs = [];
    try {
      const out = await runScraperProcess();
      log.push('✓ scraper.js finished');
      console.log(out);
      if (fs.existsSync(JOBS_FILE)) {
        const d = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        scraperJobs = d.jobs || [];
      }
    } catch (e) {
      log.push('⚠ scraper.js error: ' + e.message);
      console.warn(e.message);
      if (fs.existsSync(JOBS_FILE)) {
        const d = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        scraperJobs = d.jobs || [];
      }
    }

    // 2. AI-discovered jobs via GPT-4o
    let aiJobs = [];
    try {
      aiJobs = await getAIJobs();
      log.push(`✓ GPT-4o returned ${aiJobs.length} AI-discovered jobs`);
      console.log(`  AI jobs: ${aiJobs.length}`);
    } catch (e) {
      log.push('⚠ AI discovery error: ' + e.message);
      console.warn('AI jobs error:', e.message);
    }

    // 3. Merge — AI jobs first, then scraper jobs; deduplicate by id
    const seen = new Set();
    const scrapeDate = new Date().toISOString().slice(0, 10); // stamp the day this scrape ran
    const merged = [...aiJobs, ...scraperJobs].filter(j => {
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

    res.json({ ok: true, total: merged.length, scraper: scraperJobs.length, ai: aiJobs.length, jobs: merged, log });
  } finally {
    scrapeInProgress = false;
  }
});

// ── GET /api/status ───────────────────────────────────────────
app.get('/api/status', (req, res) => res.json({ ok: true, version: '2.0' }));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎙  Transcriber + Trados server → http://localhost:${PORT}`);
  console.log(`   Transcriber UI:  http://localhost:${PORT}/`);
  console.log(`   Trados API:      POST http://localhost:${PORT}/api/trados\n`);
});
