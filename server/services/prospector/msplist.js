'use strict';
// ── OUR OWN SALES LIST, BUILT BY CITY ───────────────────────────────────────
//
// For each city: the IT companies there (Google listings for managed IT /
// IT support), skipping chains and national firms; the owner of each, found
// and verified (services/prospector/people); three businesses near them with
// an email gap (a gaps-only Prospector run: free, no Hunter credits); and the
// first email written from those three. Every one lands on the outreach list
// as a DRAFT (services/prospector/outreach), waiting for JohnMark's OK.
//
// Hunter credits are spent only on owners: about 1 to 2 per IT company. The
// list is capped per city (default 15) so one big metro does not use the
// month's credits.
//
// A build runs in the background; JohnMark gets an email when it is done.

const Places = require('./places');
const People = require('./people');
const R = require('./run');
const O = require('./outreach');
const suppression = require('../suppression');

const lc = (s) => String(s || '').trim().toLowerCase();
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const MSP_TERMS = ['managed IT services', 'IT support company', 'managed service provider'];
// National firms and retail, never a local owner-run IT company.
const CHAINS = /\b(geek squad|best buy|staples|office ?depot|cdw|dell|hp inc|ibm|accenture|insight enterprises|shi international|connection|ubreakifix|asurion|cpr cell|batteries plus|computer troubleshooters|teksystems|robert half|kforce|apple store|microsoft store|verizon|at&t|t-mobile|comcast|spectrum)\b/i;
const TOP_METROS = [
  'New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Dallas, TX', 'Houston, TX', 'Washington, DC', 'Philadelphia, PA', 'Miami, FL',
  'Atlanta, GA', 'Boston, MA', 'Phoenix, AZ', 'San Francisco, CA', 'Riverside, CA', 'Detroit, MI', 'Seattle, WA', 'Minneapolis, MN',
  'San Diego, CA', 'Tampa, FL', 'Denver, CO', 'Baltimore, MD', 'St. Louis, MO', 'Orlando, FL', 'Charlotte, NC', 'San Antonio, TX',
  'Portland, OR', 'Sacramento, CA', 'Pittsburgh, PA', 'Austin, TX', 'Las Vegas, NV', 'Cincinnati, OH', 'Kansas City, MO', 'Columbus, OH',
  'Indianapolis, IN', 'Cleveland, OH', 'San Jose, CA', 'Nashville, TN', 'Virginia Beach, VA', 'Providence, RI', 'Jacksonville, FL',
  'Milwaukee, WI', 'Raleigh, NC', 'Oklahoma City, OK', 'Memphis, TN', 'Richmond, VA', 'Louisville, KY', 'New Orleans, LA',
  'Salt Lake City, UT', 'Hartford, CT', 'Buffalo, NY', 'Birmingham, AL',
];

// What kind of business, in two or three plain words.
function kindOf(name, category) {
  const s = lc(`${name} ${category}`);
  const rules = [[/orthodont|braces/, 'orthodontist'], [/dent|smile/, 'dental office'], [/vet|animal/, 'vet clinic'], [/physical therap|rehab/, 'physical therapy'],
    [/law|attorney|legal/, 'law firm'], [/cpa|account|tax|bookkeep/, 'accounting firm'], [/insurance/, 'insurance agency'], [/wealth|financial|advis/, 'financial advisor'],
    [/property manage/, 'property management'], [/real estate|realty/, 'real estate office'], [/engineer/, 'engineering firm'], [/church|ministr/, 'church'],
    [/school|academy/, 'private school'], [/medic|clinic|doctor|health|family practice/, 'medical practice']];
  for (const [re, k] of rules) if (re.test(s)) return k;
  return clip(category, 40).toLowerCase() || 'local business';
}
// "123 Main St, Hoover, AL 35244" -> "Hoover"
function townOf(address, area) {
  const parts = String(address || '').split(',').map((x) => x.trim()).filter(Boolean);
  const t = parts.length >= 3 ? parts[parts.length - 2] : parts.length === 2 ? parts[1] : '';
  const town = t.replace(/\s+[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/, '').trim();
  return town && !/\d/.test(town) ? town : String(area || '').split(',')[0].trim();
}
function gapOf(f) {
  const s = (f && f.short) || '';
  return { 'no DMARC': 'no DMARC record', 'no SPF': 'no SPF record', 'duplicate SPF': 'two conflicting SPF records', 'DMARC monitor only': 'DMARC set to monitor only',
    'weak SPF': 'SPF lets anyone send' }[s] || (f && f.problems && f.problems[0] ? clip(f.problems[0].split('.')[0], 80).toLowerCase() : 'an email security gap');
}
function cleanName(n) {
  return clip(n, 120).replace(/\s+[-–|]\s+.*$/, '').replace(/,?\s+(LLC|L\.L\.C\.|Inc\.?|P\.C\.|PC|PLLC|LLP)$/i, '').trim();
}

// Three picks per IT company, different ones for each IT company in the city
// while there are enough: high risk first, a mix of kinds.
function picker(gaps) {
  const order = [...gaps].sort((a, z) => (a.f.level === 'high' ? 0 : 1) - (z.f.level === 'high' ? 0 : 1));
  let i = 0;
  return () => {
    if (!order.length) return [];
    const out = [], kinds = new Set();
    for (let tries = 0; out.length < 3 && tries < order.length * 2; tries++) {
      const g = order[i % order.length]; i++;
      const k = kindOf(g.b.name, g.b.category);
      if (out.some((x) => x.domain === g.b.domain)) continue;
      if (kinds.has(k) && tries < order.length) continue;
      kinds.add(k);
      out.push({ business: cleanName(g.b.name), domain: g.b.domain, kind: k, town: townOf(g.b.address, ''), gap: gapOf(g.f) });
    }
    return out;
  };
}

// One city. -> { area, found, skipped, owners, drafted, gapRun, why[] }
async function buildCity(pool, { area, max = 15, batch, deps = {} } = {}) {
  const out = { area, found: 0, considered: 0, owners: 0, drafted: 0, skipped: [], gapRun: null };
  const places = deps.places || Places;
  const found = await places.find(MSP_TERMS, area, { max: 60 });
  const msps = found.businesses.filter((b) => {
    const why = CHAINS.test(b.name) ? 'national firm' : b.locations > 3 ? 'chain (more than 3 locations)' : null;
    if (why) out.skipped.push({ company: b.name, why });
    return !why;
  });
  out.found = msps.length;
  // Already on the list or a customer: not looked up again.
  await O.ensureTables(pool);
  const known = new Set((await pool.query(`SELECT domain FROM prospector_outreach WHERE domain IS NOT NULL`)).rows.map((r) => r.domain));
  const fresh = msps.filter((b) => { if (known.has(lc(b.domain))) { out.skipped.push({ company: b.name, why: 'already on the list' }); return false; } return true; }).slice(0, max);
  out.considered = fresh.length;
  if (!fresh.length) return out;
  // The businesses with a gap near them: one free run for the city.
  const run = deps.run || R.run;
  const g = await run(pool, { playbook: 'it-msp', area, limit: 1, gapsOnly: true, sender: { name: 'JohnMark Compton', company: 'Compton Group' } }, deps.runDeps || {});
  out.gapRun = g.runId;
  const gaps = (g.gaps || []).filter((x) => x && x.b && x.f);
  if (gaps.length < 3) { out.skipped.push({ company: '(all)', why: `only ${gaps.length} businesses with a gap found in ${area}` }); return out; }
  const next = picker(gaps);
  const findOwner = deps.findOwner || People.one;
  const rows = [];
  for (const b of fresh) {
    const o = await findOwner({ company: b.name, domain: b.domain }, deps.peopleDeps || {}).catch((e) => ({ ok: false, why: e.message }));
    const email = lc(o && (o.email || (o.person && o.person.email)));
    const verified = o && (o.verified === true || o.verify === 'valid' || o.verifyStatus === 'valid');
    if (!o || !o.ok || !email) { out.skipped.push({ company: b.name, why: (o && o.why) || 'no owner found' }); continue; }
    if (!verified) { out.skipped.push({ company: b.name, why: `owner address not verified (${email})` }); continue; }
    if ((await suppression.isSuppressed(pool, email)).suppressed) { out.skipped.push({ company: b.name, why: 'on the suppression list' }); continue; }
    out.owners++;
    rows.push({ email, first: o.first || (o.person && o.person.first) || '', last: o.last || (o.person && o.person.last) || '', company: cleanName(b.name),
      area, picks: next(), checked: g.summary && g.summary.checked, withGap: g.summary && g.summary.withGap });
  }
  const imp = await O.importRows(pool, rows, { batch: batch || `city:${area}`, source: 'msplist' });
  out.drafted = imp.added;
  for (const s of imp.skipped) out.skipped.push({ company: s.company, why: s.why });
  return out;
}

// Several cities, in the background. -> the job, polled with get().
const jobs = new Map();
let seq = 0;
function start(pool, { areas, max = 15, deps = {} } = {}) {
  const list = (Array.isArray(areas) && areas.length ? areas : TOP_METROS).map((a) => clip(a, 80)).filter(Boolean).slice(0, 60);
  const id = 'b' + (++seq) + '_' + Date.now().toString(36);
  const batch = `build ${new Date().toISOString().slice(0, 10)}`;
  const job = { id, batch, status: 'running', total: list.length, done: 0, cities: [], startedAt: new Date().toISOString() };
  jobs.set(id, job);
  (async () => {
    for (const area of list) {
      try { job.cities.push(await buildCity(pool, { area, max, batch, deps })); }
      catch (e) { job.cities.push({ area, error: e.message }); }
      job.done++;
    }
    job.status = 'done';
    const drafted = job.cities.reduce((n, c) => n + (c.drafted || 0), 0);
    const text = `${drafted} new drafts from ${job.total} cities (batch "${batch}").\n\n`
      + job.cities.map((c) => `${c.area}: ${c.error ? 'failed: ' + c.error : `${c.drafted} drafted of ${c.considered} IT companies looked up`}`).join('\n')
      + `\n\nNothing has been sent. Review and approve them at /lab/prospector.`;
    try { await (deps.alert || require('../salesAutopilot').alert)({ subject: `Prospector: ${drafted} new IT company drafts ready for your OK`, text }); }
    catch (e) { console.error('[msplist] alert:', e.message); }
  })().catch((e) => { job.status = 'failed'; job.error = e.message; });
  return job;
}
function get(id) { return jobs.get(String(id)) || null; }

module.exports = { buildCity, start, get, picker, kindOf, townOf, gapOf, cleanName, TOP_METROS, MSP_TERMS, CHAINS };
