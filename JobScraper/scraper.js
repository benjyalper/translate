/**
 * Hebrew-English Translation Job Scraper
 * Working sources: RemoteOK, WeWorkRemotely, WorkingNomads, Remotive
 * Run: node scraper.js
 * Output: jobs-data.json
 */

const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, 'jobs-data.json');
const parser = new Parser({ timeout: 12000 });

// Job must mention Hebrew specifically — either in title or description
const HEBREW_REQUIRED = /hebrew/i;
const TITLE_KEYWORDS  = /translat|interpret|linguist|locali[sz]|proofreader|subtitl|transcrib/i;

function makeId(src, str) {
  return src + '-' + Buffer.from(str.slice(0, 50)).toString('base64').replace(/[^a-z0-9]/gi,'').slice(0, 20);
}

function clean(t) {
  return (t || '').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
}

function today() { return new Date().toISOString().slice(0, 10); }

function parseDate(d) {
  if (!d) return today();
  try { return new Date(d).toISOString().slice(0, 10); } catch { return today(); }
}

function isRelevant(title, desc) {
  const text = title + ' ' + desc;
  // Must mention Hebrew AND be translation-related
  return HEBREW_REQUIRED.test(text) && (TITLE_KEYWORDS.test(title) || TITLE_KEYWORDS.test(desc));
}

// ── SOURCE 1: RemoteOK API ────────────────────────────────
async function scrapeRemoteOK() {
  console.log('  Scraping RemoteOK...');
  try {
    const { data } = await axios.get('https://remoteok.com/api', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 12000,
    });
    const jobs = Array.isArray(data) ? data.filter(j => j.position) : [];
    const filtered = jobs.filter(j =>
      isRelevant(j.position || '', (j.description || '') + (j.tags || []).join(' '))
    ).map(j => ({
      id: makeId('rok', j.url || j.position + j.company),
      title: clean(j.position),
      company: clean(j.company),
      location: clean(j.location) || 'Remote',
      type: 'Remote',
      description: clean(j.description).slice(0, 500),
      url: j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
      source: 'RemoteOK',
      postedDate: parseDate(j.date),
      tags: (j.tags || []).slice(0, 5),
      salary: j.salary || '',
    }));
    console.log(`  ✓ RemoteOK: ${filtered.length} relevant of ${jobs.length}`);
    return filtered;
  } catch (e) {
    console.warn(`  ✗ RemoteOK: ${e.message}`);
    return [];
  }
}

// ── SOURCE 2: WeWorkRemotely RSS ──────────────────────────
async function scrapeWWR() {
  console.log('  Scraping WeWorkRemotely...');
  try {
    const feed = await parser.parseURL('https://weworkremotely.com/remote-jobs.rss');
    const filtered = (feed.items || []).filter(j =>
      isRelevant(j.title || '', j.contentSnippet || '')
    ).map(j => ({
      id: makeId('wwr', j.link || j.title),
      title: clean(j.title),
      company: clean(j.author || j['dc:creator'] || ''),
      location: 'Remote',
      type: 'Remote',
      description: clean(j.contentSnippet || j.summary || '').slice(0, 500),
      url: j.link || 'https://weworkremotely.com',
      source: 'WeWorkRemotely',
      postedDate: parseDate(j.pubDate),
      tags: [],
      salary: '',
    }));
    console.log(`  ✓ WeWorkRemotely: ${filtered.length} relevant of ${(feed.items||[]).length}`);
    return filtered;
  } catch (e) {
    console.warn(`  ✗ WeWorkRemotely: ${e.message}`);
    return [];
  }
}

// ── SOURCE 3: WorkingNomads API ───────────────────────────
async function scrapeWorkingNomads() {
  console.log('  Scraping WorkingNomads...');
  try {
    const { data } = await axios.get('https://workingnomads.com/api/exposed_jobs/?category=writing-jobs', { timeout: 10000 });
    const jobs = Array.isArray(data) ? data : [];
    const filtered = jobs.filter(j =>
      isRelevant(j.title || '', j.description || '')
    ).map(j => ({
      id: makeId('wn', j.url || j.title + (j.company || '')),
      title: clean(j.title),
      company: clean(j.company),
      location: 'Remote',
      type: 'Remote',
      description: clean(j.description).slice(0, 500),
      url: j.url || 'https://workingnomads.com/jobs',
      source: 'WorkingNomads',
      postedDate: parseDate(j.pub_date),
      tags: [],
      salary: '',
    }));
    console.log(`  ✓ WorkingNomads: ${filtered.length} relevant of ${jobs.length}`);
    return filtered;
  } catch (e) {
    console.warn(`  ✗ WorkingNomads: ${e.message}`);
    return [];
  }
}

// ── SOURCE 4: Remotive API ────────────────────────────────
async function scrapeRemotive() {
  console.log('  Scraping Remotive...');
  try {
    const categories = ['writing', 'all-others'];
    const results = await Promise.all(categories.map(c =>
      axios.get(`https://remotive.com/api/remote-jobs?category=${c}&limit=100`, { timeout: 10000 })
        .then(r => r.data.jobs || []).catch(() => [])
    ));
    const jobs = results.flat();
    const filtered = jobs.filter(j =>
      isRelevant(j.title || '', j.description || '')
    ).map(j => ({
      id: makeId('rem', j.url || j.title + j.company_name),
      title: clean(j.title),
      company: clean(j.company_name),
      location: clean(j.candidate_required_location) || 'Remote',
      type: clean(j.job_type) || 'Remote',
      description: clean(j.description).slice(0, 500),
      url: j.url || 'https://remotive.com',
      source: 'Remotive',
      postedDate: parseDate(j.publication_date),
      tags: (j.tags || []).slice(0, 5),
      salary: j.salary || '',
    }));
    console.log(`  ✓ Remotive: ${filtered.length} relevant of ${jobs.length}`);
    return filtered;
  } catch (e) {
    console.warn(`  ✗ Remotive: ${e.message}`);
    return [];
  }
}

// ── SOURCE 5: LinkedIn (Hebrew-specific search) ───────────
async function scrapeLinkedIn() {
  console.log('  Scraping LinkedIn (hebrew translation)...');
  const searches = [
    'https://www.linkedin.com/jobs/search/?keywords=hebrew+english+translator&f_WT=2',
    'https://www.linkedin.com/jobs/search/?keywords=hebrew+translator&f_WT=2',
    'https://www.linkedin.com/jobs/search/?keywords=%22hebrew+to+english%22+translator',
  ];
  const jobs = [];
  for (const url of searches) {
    try {
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 12000,
      });
      const $ = cheerio.load(data);
      $('.base-card, .job-search-card').each((i, el) => {
        if (i > 15) return;
        const title = clean($('.base-search-card__title, .job-search-card__title', el).text());
        const company = clean($('.base-search-card__subtitle, .job-search-card__company-name', el).text());
        const location = clean($('.job-search-card__location', el).text());
        const href = $('a.base-card__full-link, a.job-search-card__list-item-link', el).attr('href') || '';
        if (title && title.length > 3) {
          jobs.push({
            id: makeId('li', title + company + url),
            title, company: company || 'Company',
            location: location || 'Remote',
            type: 'Remote / Hybrid',
            description: '',
            url: href.split('?')[0] || url,
            source: 'LinkedIn',
            postedDate: today(),
            tags: [],
            salary: '',
          });
        }
      });
    } catch (e) { /* continue */ }
  }
  // Deduplicate within LinkedIn results
  const seen = new Set();
  const unique = jobs.filter(j => { if (seen.has(j.id)) return false; seen.add(j.id); return true; });
  console.log(`  ✓ LinkedIn: ${unique.length} jobs found`);
  return unique;
}

// ── SOURCE 6: Indeed (international, Hebrew-specific) ─────
async function scrapeIndeedHebrew() {
  console.log('  Scraping Indeed (hebrew translation)...');
  try {
    const { data } = await axios.get(
      'https://www.indeed.com/jobs?q=hebrew+english+translator&l=&remotejobs=1&sort=date',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      }
    );
    const $ = cheerio.load(data);
    const jobs = [];
    $('[data-jk], .job_seen_beacon, .tapItem').each((i, el) => {
      if (i > 20) return;
      const title = clean($('.jobTitle span, h2.jobTitle span, [data-testid="jobTitle"]', el).text());
      const company = clean($('.companyName, [data-testid="company-name"]', el).text());
      const location = clean($('.companyLocation, [data-testid="text-location"]', el).text());
      const jk = $(el).attr('data-jk') || $(el).find('[data-jk]').attr('data-jk') || '';
      if (!title || title.length < 3) return;
      jobs.push({
        id: makeId('indeed', title + company + jk),
        title, company: company || 'Company',
        location: location || 'Remote',
        type: 'Remote',
        description: '',
        url: jk ? `https://www.indeed.com/viewjob?jk=${jk}` : 'https://www.indeed.com/jobs?q=hebrew+english+translator',
        source: 'Indeed',
        postedDate: today(),
        tags: [],
        salary: '',
      });
    });
    console.log(`  ✓ Indeed: ${jobs.length} jobs found`);
    return jobs;
  } catch (e) {
    console.warn(`  ✗ Indeed: ${e.message}`);
    return [];
  }
}

// ── SOURCE 7: Arbeitnow API (free, no key) ────────────────
async function scrapeArbeitnow() {
  console.log('  Scraping Arbeitnow API...');
  try {
    const { data } = await axios.get('https://www.arbeitnow.com/api/job-board-api', { timeout: 10000 });
    const jobs = (data.data || []).filter(j => isRelevant(j.title || '', j.description || ''));
    const result = jobs.map(j => ({
      id: makeId('arb', j.slug || j.title),
      title: clean(j.title),
      company: clean(j.company_name),
      location: clean(j.location) || 'Remote',
      type: j.remote ? 'Remote' : 'On-site',
      description: clean(j.description).slice(0, 400),
      url: j.url || 'https://www.arbeitnow.com',
      source: 'Arbeitnow',
      postedDate: j.created_at ? new Date(j.created_at * 1000).toISOString().slice(0, 10) : today(),
      tags: (j.tags || []).slice(0, 5),
      salary: '',
    }));
    console.log(`  ✓ Arbeitnow: ${result.length} relevant of ${(data.data||[]).length}`);
    return result;
  } catch (e) {
    console.warn(`  ✗ Arbeitnow: ${e.message}`);
    return [];
  }
}

// ── SOURCE 8: The Muse API (free, no key needed) ──────────
async function scrapeTheMuse() {
  console.log('  Scraping The Muse API...');
  try {
    const { data } = await axios.get(
      'https://www.themuse.com/api/public/jobs?category=Writing+%26+Editing&category=Content+%26+Copywriting&level=Entry+Level&level=Mid+Level&level=Senior+Level&page=1',
      { timeout: 10000 }
    );
    const jobs = (data.results || []).filter(j => isRelevant(j.name || '', (j.contents || '') + (j.categories||[]).map(c=>c.name).join(' ')));
    const result = jobs.map(j => ({
      id: makeId('muse', j.id || j.name),
      title: clean(j.name),
      company: clean(j.company?.name || ''),
      location: (j.locations || []).map(l => l.name).join(', ') || 'Remote',
      type: clean((j.levels || []).map(l => l.name).join(', ')) || 'Full Time',
      description: clean(j.contents || '').slice(0, 400),
      url: j.refs?.landing_page || 'https://www.themuse.com/jobs',
      source: 'The Muse',
      postedDate: j.publication_date ? j.publication_date.slice(0, 10) : today(),
      tags: (j.categories || []).map(c => c.name).slice(0, 4),
      salary: '',
    }));
    console.log(`  ✓ The Muse: ${result.length} relevant of ${(data.results||[]).length}`);
    return result;
  } catch (e) {
    console.warn(`  ✗ The Muse: ${e.message}`);
    return [];
  }
}

// ── SOURCE 9: LinkedIn (extra searches) ───────────────────
async function scrapeLinkedInExtra() {
  console.log('  Scraping LinkedIn (additional searches)...');
  const searches = [
    'https://www.linkedin.com/jobs/search/?keywords=%22hebrew%22+%22translation%22&f_WT=2',
    'https://www.linkedin.com/jobs/search/?keywords=hebrew+localization+specialist',
    'https://www.linkedin.com/jobs/search/?keywords=hebrew+linguist+remote',
  ];
  const jobs = [];
  for (const url of searches) {
    try {
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 12000,
      });
      const $ = cheerio.load(data);
      $('.base-card, .job-search-card').each((i, el) => {
        if (i > 15) return;
        const title = clean($('.base-search-card__title, .job-search-card__title', el).text());
        const company = clean($('.base-search-card__subtitle, .job-search-card__company-name', el).text());
        const location = clean($('.job-search-card__location', el).text());
        const href = $('a.base-card__full-link, a.job-search-card__list-item-link', el).attr('href') || '';
        if (title && title.length > 3) {
          jobs.push({
            id: makeId('liex', title + company + url),
            title, company: company || 'Company',
            location: location || 'Remote',
            type: 'Remote / Hybrid',
            description: '',
            url: href.split('?')[0] || url,
            source: 'LinkedIn',
            postedDate: today(),
            tags: [],
            salary: '',
          });
        }
      });
    } catch { /* continue */ }
    await new Promise(r => setTimeout(r, 800));
  }
  const seen = new Set();
  const unique = jobs.filter(j => { if (seen.has(j.id)) return false; seen.add(j.id); return true; });
  console.log(`  ✓ LinkedIn (extra): ${unique.length} jobs found`);
  return unique;
}

// ── SOURCE 10: Jooble (free public search) ────────────────
async function scrapeJooble() {
  console.log('  Scraping Jooble...');
  try {
    const { data } = await axios.get(
      'https://jooble.org/jobs-hebrew-english-translator/remote',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      }
    );
    const $ = cheerio.load(data);
    const jobs = [];
    $('article, [class*="job"], .vacancy').each((i, el) => {
      if (i > 25) return;
      const title = clean($('h2, h1, [class*="title"], a', el).first().text());
      const company = clean($('[class*="company"], [class*="employer"]', el).first().text());
      const location = clean($('[class*="location"], [class*="city"]', el).first().text());
      const href = $('a', el).first().attr('href') || '';
      const desc = clean($('p, [class*="description"]', el).first().text()).slice(0, 300);
      if (!title || title.length < 4) return;
      if (!isRelevant(title, desc)) return;
      jobs.push({
        id: makeId('jooble', title + company + i),
        title, company: company || 'Company',
        location: location || 'Remote',
        type: 'Remote',
        description: desc,
        url: href.startsWith('http') ? href : 'https://jooble.org' + href,
        source: 'Jooble',
        postedDate: today(),
        tags: [],
        salary: '',
      });
    });
    console.log(`  ✓ Jooble: ${jobs.length} jobs found`);
    return jobs;
  } catch (e) {
    console.warn(`  ✗ Jooble: ${e.message}`);
    return [];
  }
}

// ── SOURCE 8: Adzuna API (free, no key needed for basic) ──
async function scrapeAdzuna() {
  console.log('  Scraping Adzuna...');
  // Free public search — no key required for basic HTML scrape
  const countries = ['us', 'gb', 'au'];
  const jobs = [];
  for (const cc of countries) {
    try {
      const { data } = await axios.get(
        `https://www.adzuna.com/${cc}/search?q=hebrew+english+translator&w=remote&sort_by=date`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: 12000,
        }
      );
      const $ = cheerio.load(data);
      $('[class*="Result"], article, .result').each((i, el) => {
        if (i > 15) return;
        const title = clean($('h2 a, h3 a, [class*="title"] a', el).first().text());
        const company = clean($('[class*="company"], [class*="employer"]', el).first().text());
        const location = clean($('[class*="location"]', el).first().text());
        const href = $('h2 a, h3 a, a[class*="title"]', el).first().attr('href') || '';
        const desc = clean($('p, [class*="desc"]', el).first().text()).slice(0, 300);
        if (!title || title.length < 4) return;
        if (!isRelevant(title, desc)) return;
        jobs.push({
          id: makeId('adz', title + company + cc),
          title, company: company || 'Company',
          location: location || 'Remote',
          type: 'Remote',
          description: desc,
          url: href.startsWith('http') ? href : `https://www.adzuna.com${href}`,
          source: 'Adzuna',
          postedDate: today(),
          tags: [],
          salary: clean($('[class*="salary"]', el).text()),
        });
      });
    } catch { /* continue */ }
  }
  console.log(`  ✓ Adzuna: ${jobs.length} jobs found`);
  return jobs;
}

// ── SOURCE 9: Jobrapido ────────────────────────────────────
async function scrapeJobrapido() {
  console.log('  Scraping Jobrapido...');
  try {
    const { data } = await axios.get(
      'https://us.jobrapido.com/jobpreview/search?w=hebrew+english+translator&l=remote',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 12000,
      }
    );
    const $ = cheerio.load(data);
    const jobs = [];
    $('[class*="job"], article, .result-item').each((i, el) => {
      if (i > 20) return;
      const title = clean($('h2, h3, [class*="title"]', el).first().text());
      const company = clean($('[class*="company"]', el).first().text());
      const href = $('a', el).first().attr('href') || '';
      const desc = clean($('p, [class*="desc"]', el).first().text()).slice(0, 300);
      if (!title || title.length < 4) return;
      if (!isRelevant(title, desc)) return;
      jobs.push({
        id: makeId('jr', title + company + i),
        title, company: company || 'Company',
        location: 'Remote',
        type: 'Remote',
        description: desc,
        url: href.startsWith('http') ? href : 'https://us.jobrapido.com' + href,
        source: 'Jobrapido',
        postedDate: today(),
        tags: [],
        salary: '',
      });
    });
    console.log(`  ✓ Jobrapido: ${jobs.length} jobs found`);
    return jobs;
  } catch (e) {
    console.warn(`  ✗ Jobrapido: ${e.message}`);
    return [];
  }
}

// ── SOURCE 10: Google Jobs (via search HTML) ──────────────
async function scrapeGoogle() {
  console.log('  Scraping Google Jobs...');
  const queries = [
    'hebrew english translator jobs remote',
    'hebrew to english translation freelance',
    '"hebrew translator" remote job',
  ];
  const jobs = [];
  for (const q of queries) {
    try {
      const { data } = await axios.get('https://www.google.com/search', {
        params: { q, ibp: 'htl;jobs', hl: 'en', gl: 'us' },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      });
      const $ = cheerio.load(data);
      // Google Jobs cards
      $('[data-ved] [jscontroller], .job-posting, [class*="job"]').each((i, el) => {
        if (i > 30) return;
        const title = clean($('h2, h3, [class*="title"]', el).first().text());
        const company = clean($('[class*="company"], [class*="employer"]', el).first().text());
        const location = clean($('[class*="location"]', el).first().text());
        if (!title || title.length < 5) return;
        if (!isRelevant(title, company + ' ' + location)) return;
        jobs.push({
          id: makeId('google', title + company + q),
          title, company: company || 'Company',
          location: location || 'Remote',
          type: 'Remote',
          description: '',
          url: `https://www.google.com/search?q=${encodeURIComponent(q)}&ibp=htl;jobs`,
          source: 'Google Jobs',
          postedDate: today(),
          tags: [],
          salary: '',
        });
      });

      // Also extract JSON-LD job postings embedded in page
      const jsonMatches = data.match(/"@type"\s*:\s*"JobPosting"[\s\S]*?"hiringOrganization"/g) || [];
      try {
        const blocks = data.match(/\{[^{}]*"@type"\s*:\s*"JobPosting"[^{}]*\}/g) || [];
        blocks.forEach(block => {
          try {
            const j = JSON.parse(block);
            if (!j.title) return;
            if (!isRelevant(j.title, j.description || '')) return;
            jobs.push({
              id: makeId('gjld', j.title + (j.hiringOrganization?.name || '')),
              title: clean(j.title),
              company: clean(j.hiringOrganization?.name || 'Company'),
              location: clean(j.jobLocation?.address?.addressLocality || 'Remote'),
              type: clean(j.employmentType || 'Full Time'),
              description: clean(j.description || '').slice(0, 400),
              url: j.url || j.sameAs || `https://www.google.com/search?q=${encodeURIComponent(q)}&ibp=htl;jobs`,
              source: 'Google Jobs',
              postedDate: j.datePosted ? j.datePosted.slice(0, 10) : today(),
              tags: [],
              salary: j.baseSalary?.value?.value || '',
            });
          } catch {}
        });
      } catch {}

    } catch (e) { /* continue to next query */ }
    await new Promise(r => setTimeout(r, 1500)); // polite delay between queries
  }
  const seen = new Set();
  const unique = jobs.filter(j => { if (seen.has(j.id)) return false; seen.add(j.id); return true; });
  console.log(`  ✓ Google Jobs: ${unique.length} jobs found`);
  return unique;
}

// ── SOURCE 8: Glassdoor (via search) ─────────────────────
async function scrapeGlassdoor() {
  console.log('  Scraping Glassdoor...');
  try {
    const { data } = await axios.get(
      'https://www.glassdoor.com/Job/remote-hebrew-translator-jobs-SRCH_IL.0,6_IS11047_KO7,24.htm',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.glassdoor.com/',
        },
        timeout: 15000,
      }
    );
    const $ = cheerio.load(data);
    const jobs = [];
    $('[data-test="jobListing"], .react-job-listing, li[data-jobid]').each((i, el) => {
      if (i > 20) return;
      const title = clean($('[data-test="job-title"], .job-title, a[data-test="job-link"]', el).text());
      const company = clean($('[data-test="employer-name"], .employer-name', el).text());
      const location = clean($('[data-test="emp-location"], .location', el).text());
      const href = $('a[data-test="job-link"], a.jobLink', el).attr('href') || '';
      if (!title || title.length < 3) return;
      jobs.push({
        id: makeId('gd', title + company),
        title, company: company || 'Company',
        location: location || 'Remote',
        type: 'Full Time / Contract',
        description: '',
        url: href ? (href.startsWith('http') ? href : 'https://www.glassdoor.com' + href) : 'https://www.glassdoor.com/Job/hebrew-translator-jobs-SRCH_KO0,17.htm',
        source: 'Glassdoor',
        postedDate: today(),
        tags: [],
        salary: '',
      });
    });
    console.log(`  ✓ Glassdoor: ${jobs.length} jobs found`);
    return jobs;
  } catch (e) {
    console.warn(`  ✗ Glassdoor: ${e.message}`);
    return [];
  }
}

// ── SOURCE 9: Upwork (targeted search page) ───────────────
async function scrapeUpwork() {
  console.log('  Scraping Upwork...');
  try {
    const { data } = await axios.get(
      'https://www.upwork.com/nx/search/jobs/?q=hebrew+english+translation&sort=recency&per_page=20',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      }
    );
    const $ = cheerio.load(data);
    const jobs = [];
    $('article, .job-tile, [data-test="job-tile"]').each((i, el) => {
      if (i > 20) return;
      const title = clean($('h2, h3, [data-test="job-title"], .job-title', el).first().text());
      const desc = clean($('p, [data-test="job-description-text"], .description', el).first().text()).slice(0, 400);
      const href = $('a', el).first().attr('href') || '';
      if (!title || title.length < 3) return;
      jobs.push({
        id: makeId('uw', title + i),
        title, company: 'Upwork Client',
        location: 'Remote',
        type: 'Freelance',
        description: desc,
        url: href ? (href.startsWith('http') ? href : 'https://www.upwork.com' + href) : 'https://www.upwork.com/nx/search/jobs/?q=hebrew+english+translation',
        source: 'Upwork',
        postedDate: today(),
        tags: [],
        salary: clean($('[data-test="budget"], .budget', el).text()),
      });
    });
    console.log(`  ✓ Upwork: ${jobs.length} jobs found`);
    return jobs;
  } catch (e) {
    console.warn(`  ✗ Upwork: ${e.message}`);
    return [];
  }
}

// ── SOURCE 10: Freelancer.com ─────────────────────────────
async function scrapeFreelancer() {
  console.log('  Scraping Freelancer.com...');
  try {
    const { data } = await axios.get(
      'https://www.freelancer.com/jobs/translation/hebrew/?language=hebrew',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      }
    );
    const $ = cheerio.load(data);
    const jobs = [];
    $('.JobSearchCard-item, .project-details, [class*="JobCard"]').each((i, el) => {
      if (i > 20) return;
      const title = clean($('a[class*="Title"], h2, h3, .project-title', el).first().text());
      const desc = clean($('p, [class*="Description"]', el).first().text()).slice(0, 300);
      const href = $('a[class*="Title"], a.project-title', el).first().attr('href') || '';
      const budget = clean($('[class*="Budget"], .budget', el).text());
      if (!title || title.length < 3) return;
      jobs.push({
        id: makeId('fl', title + i),
        title, company: 'Freelancer Client',
        location: 'Remote',
        type: 'Freelance / Project',
        description: desc,
        url: href ? (href.startsWith('http') ? href : 'https://www.freelancer.com' + href) : 'https://www.freelancer.com/jobs/translation/hebrew/',
        source: 'Freelancer',
        postedDate: today(),
        tags: ['translation', 'hebrew'],
        salary: budget,
      });
    });
    console.log(`  ✓ Freelancer: ${jobs.length} jobs found`);
    return jobs;
  } catch (e) {
    console.warn(`  ✗ Freelancer: ${e.message}`);
    return [];
  }
}

// ── DEDUPLICATE ───────────────────────────────────────────
function deduplicate(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    const key = j.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  console.log('\n🔍 Hebrew–English Translation Job Scraper');
  console.log('==========================================');
  console.log(`Started: ${new Date().toLocaleString()}\n`);

  const results = await Promise.allSettled([
    scrapeRemoteOK(),
    scrapeWWR(),
    scrapeWorkingNomads(),
    scrapeRemotive(),
    scrapeLinkedIn(),
    scrapeLinkedInExtra(),
    scrapeArbeitnow(),
    scrapeTheMuse(),
  ]);

  const allJobs = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const jobs = deduplicate(allJobs).sort((a, b) => new Date(b.postedDate) - new Date(a.postedDate));

  const output = {
    lastUpdated: new Date().toISOString(),
    count: jobs.length,
    jobs,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n✅ Done! Found ${jobs.length} relevant jobs.`);
  console.log(`   Saved to: jobs-data.json`);
  console.log(`   Timestamp: ${new Date().toLocaleString()}\n`);
}

main().catch(console.error);
