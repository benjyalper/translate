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

// Keywords that indicate a translation-relevant job
const TITLE_KEYWORDS = /translat|interpret|linguist|locali[sz]|language|hebrew|trilingu|bilingu|proofreader|subtitl|transcrib/i;
const DESC_KEYWORDS  = /hebrew|translat|locali[sz]|linguist/i;

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
  return TITLE_KEYWORDS.test(title) || DESC_KEYWORDS.test(desc);
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

// ── SOURCE 5: LinkedIn public RSS (attempt) ───────────────
async function scrapeLinkedIn() {
  console.log('  Scraping LinkedIn jobs...');
  try {
    const { data } = await axios.get(
      'https://www.linkedin.com/jobs/search/?keywords=hebrew+english+translator&f_WT=2&f_JT=C,P,T',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 12000,
      }
    );
    const $ = cheerio.load(data);
    const jobs = [];
    $('.base-card, .job-search-card').each((i, el) => {
      if (i > 20) return;
      const title = clean($('.base-search-card__title, .job-search-card__title', el).text());
      const company = clean($('.base-search-card__subtitle, .job-search-card__company-name', el).text());
      const location = clean($('.job-search-card__location', el).text());
      const href = $('a.base-card__full-link, a.job-search-card__list-item-link', el).attr('href') || '';
      if (title && isRelevant(title, '')) {
        jobs.push({
          id: makeId('li', title + company),
          title, company, location: location || 'Remote',
          type: 'Remote / Hybrid',
          description: '',
          url: href.split('?')[0],
          source: 'LinkedIn',
          postedDate: today(),
          tags: [],
          salary: '',
        });
      }
    });
    console.log(`  ✓ LinkedIn: ${jobs.length} relevant`);
    return jobs;
  } catch (e) {
    console.warn(`  ✗ LinkedIn: ${e.message}`);
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
