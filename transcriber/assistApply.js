/**
 * Assisted Apply — Playwright form-filler
 * Opens a visible browser, navigates to a job URL, fills detected fields
 * from profile.json, uploads CV, drops a cover letter, then leaves the
 * window open for the user to review and click "Submit" themselves.
 *
 * Invocation (from server.js as a child process):
 *   node assistApply.js '<JSON payload>'
 *
 * Payload shape:
 *   { jobUrl, jobTitle, jobCompany, coverLetter }
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PROFILE    = JSON.parse(fs.readFileSync(path.join(__dirname, 'profile.json'), 'utf8'));
const CV_DOCX    = path.resolve(__dirname, PROFILE.cvPath);
const CV_PDF     = PROFILE.cvPathPdf ? path.resolve(__dirname, PROFILE.cvPathPdf) : '';

/** Given a file input's `accept` string, pick the best CV format we have.
 *  Preference: PDF (safer default for job apps) → DOCX fallback. Only pick
 *  DOCX if the input explicitly accepts it and NOT PDF. */
function pickCvFor(accept) {
  const a = (accept || '').toLowerCase();
  const mentionsPdf  = /pdf|application\/pdf|\.pdf/.test(a);
  const mentionsDocx = /word|officedocument|\.docx|\.doc\b/.test(a);
  const pdfOk  = !a || mentionsPdf;
  const docxOk = !a || mentionsDocx;

  const havePdf  = CV_PDF  && fs.existsSync(CV_PDF);
  const haveDocx = fs.existsSync(CV_DOCX);

  // Input explicitly lists DOCX but NOT PDF → send DOCX
  if (mentionsDocx && !mentionsPdf && haveDocx) return CV_DOCX;
  // PDF is allowed (either unspecified or explicitly listed) → prefer PDF
  if (pdfOk && havePdf) return CV_PDF;
  // DOCX allowed → send DOCX
  if (docxOk && haveDocx) return CV_DOCX;
  // Fallback — whatever exists, PDF first
  return havePdf ? CV_PDF : CV_DOCX;
}

// Canonical field map → list of regex patterns we'll try against
// label text, placeholder, name, id, aria-label
const FIELD_PATTERNS = {
  fullName:    [/^full\s*name/i, /^your\s*name/i, /^applicant.*name/i, /^name$/i],
  firstName:   [/first\s*name|given\s*name|forename/i],
  lastName:    [/last\s*name|surname|family\s*name/i],
  email:       [/e-?mail/i],
  phone:       [/phone|mobile|cell|tel(?!e)/i],
  linkedin:    [/linked\s*in/i],
  website:     [/website|portfolio\s*url|personal\s*site|homepage/i],
  portfolio:   [/portfolio|work\s*samples/i],
  github:      [/git\s*hub/i],
  location:    [/location|address|city|country/i],
  title:       [/current\s*title|job\s*title|position|role/i],
  headline:    [/headline|tagline|about.*one\s*line/i],
  yearsExperience: [/years?\s*of?\s*experience/i],
  availability: [/availability|start\s*date|when.*start/i],
  rateHourly:  [/hourly\s*rate|rate.*hour|desired\s*rate/i],
  summary:     [/summary|about\s*you|bio|introduction/i],
  coverLetter: [/cover\s*letter|why.*interested|message|pitch|proposal|describe|tell\s*us/i],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pickValue(key, coverLetter) {
  if (key === 'coverLetter') return coverLetter;
  return PROFILE[key];
}

/** Try to classify an input element → returns a FIELD_PATTERNS key, or null */
async function classifyField(el) {
  const attrs = await el.evaluate(node => ({
    name: node.name || '',
    id: node.id || '',
    placeholder: node.placeholder || '',
    ariaLabel: node.getAttribute('aria-label') || '',
    type: (node.type || '').toLowerCase(),
    tagName: node.tagName.toLowerCase(),
  }));

  // Find the nearest label text
  let labelText = '';
  try {
    labelText = await el.evaluate(node => {
      if (node.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
        if (lbl) return lbl.innerText || '';
      }
      const parentLbl = node.closest('label');
      if (parentLbl) return parentLbl.innerText || '';
      // walk up a few levels looking for a label sibling
      let p = node.parentElement;
      for (let i = 0; i < 3 && p; i++) {
        const lbl = p.querySelector('label');
        if (lbl) return lbl.innerText || '';
        p = p.parentElement;
      }
      return '';
    });
  } catch {}

  const haystack = [attrs.name, attrs.id, attrs.placeholder, attrs.ariaLabel, labelText]
    .filter(Boolean).join(' ').trim();
  if (!haystack) return null;

  // Short-circuit by input type
  if (attrs.type === 'email') return 'email';
  if (attrs.type === 'tel')   return 'phone';
  if (attrs.type === 'url' && /linked/i.test(haystack))   return 'linkedin';
  if (attrs.type === 'url' && /git/i.test(haystack))      return 'github';
  if (attrs.type === 'url')   return 'website';

  for (const [key, patterns] of Object.entries(FIELD_PATTERNS)) {
    if (patterns.some(re => re.test(haystack))) return key;
  }
  return null;
}

async function fillForms(page, coverLetter) {
  const filled = [];
  const skipped = [];

  // 1) Handle file inputs (CV upload) — pick PDF vs DOCX based on the input's `accept`
  const fileInputs = await page.locator('input[type="file"]').all();
  for (const el of fileInputs) {
    try {
      const accept = await el.getAttribute('accept').catch(() => '') || '';
      const cvPath = pickCvFor(accept);
      if (!cvPath || !fs.existsSync(cvPath)) { skipped.push('No CV file available for accept="' + accept + '"'); continue; }
      await el.setInputFiles(cvPath).catch(() => {});
      filled.push(`📎 CV uploaded (${path.extname(cvPath).slice(1).toUpperCase()}${accept ? ', accept=' + accept : ''})`);
    } catch (e) { skipped.push('file input: ' + e.message); }
  }

  // 2) Text/email/tel/url inputs + textareas
  const inputs = await page.locator(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea'
  ).all();

  for (const el of inputs) {
    try {
      if (!(await el.isVisible().catch(() => false))) continue;
      if (await el.isDisabled().catch(() => false)) continue;

      const key = await classifyField(el);
      if (!key) continue;
      const value = pickValue(key, coverLetter);
      if (!value) continue;

      await el.fill(String(value), { timeout: 2000 }).catch(() => {});
      filled.push(`✓ ${key}`);
    } catch (e) { /* skip silently */ }
  }

  return { filled, skipped };
}

async function main() {
  const payload = JSON.parse(process.argv[2] || '{}');
  const { jobUrl, jobTitle = '', jobCompany = '', coverLetter = '' } = payload;

  if (!jobUrl) {
    console.error('ERROR: jobUrl is required');
    process.exit(1);
  }

  console.log(`\n🚀 Assisted Apply`);
  console.log(`   Job: ${jobTitle || '(no title)'} @ ${jobCompany || '(no company)'}`);
  console.log(`   URL: ${jobUrl}\n`);

  // Prefer system-installed Chrome (avoids corrupted bundled Chromium issues).
  // Falls back to bundled Chromium if Chrome isn't installed.
  const SYS_CHROME = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find(p => fs.existsSync(p));

  const launchOpts = {
    headless: false,
    args: ['--start-maximized'],
  };
  if (SYS_CHROME) {
    launchOpts.executablePath = SYS_CHROME;
    console.log(`   Using system browser: ${SYS_CHROME}`);
  }
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2500); // let dynamic JS settle

    // Look for an "Apply" button on the listing page and click it (best effort)
    const applySelectors = [
      'button:has-text("Apply")', 'a:has-text("Apply")',
      'button:has-text("Apply now")', 'a:has-text("Apply now")',
      'button:has-text("Quick apply")', 'button:has-text("I\'m interested")',
    ];
    for (const sel of applySelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1200 })) {
          await btn.click({ timeout: 3000 });
          await sleep(2500);
          break;
        }
      } catch {}
    }

    const { filled, skipped } = await fillForms(page, coverLetter);

    // Try frames too (some ATS embed via iframe, e.g. Greenhouse)
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const { filled: f2 } = await fillForms(frame, coverLetter);
        filled.push(...f2.map(s => s + ' (iframe)'));
      } catch {}
    }

    console.log('\n── Filled fields ──');
    filled.forEach(l => console.log('  ' + l));
    if (!filled.length) console.log('  (nothing auto-detected — fill manually)');
    if (skipped.length) {
      console.log('\n── Skipped ──');
      skipped.forEach(l => console.log('  ' + l));
    }

    console.log('\n✋ Review the form, adjust anything, and click Submit yourself.');
    console.log('   The browser window will stay open until you close it.\n');

    // Keep the process alive until the user closes the window
    await new Promise(resolve => {
      browser.on('disconnected', resolve);
      page.on('close', resolve);
    });
  } catch (e) {
    console.error('\n❌ Assisted apply error:', e.message);
    console.log('   Leaving browser open so you can finish manually.\n');
    await new Promise(resolve => browser.on('disconnected', resolve));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
