'use strict';
// ── WHO ALREADY PAYS THIS PROGRAM: THE ATHLETICS CORPORATE PARTNERS PAGE ────
//
// The warmest local business for an athlete is one that already writes checks
// to that school's athletics. scout.js named this as "the real path to this
// data" and parked it: nothing stored athletic department sponsors. This is
// that store, filled from the school's own public partners page.
//
// HOW, per school, at most once every REFRESH_DAYS:
//   1. The athletics site, from program_source (the staff directory we already
//      read). No athletics site on file: nothing is guessed.
//   2. Two searches on that site ("corporate partners", "sponsors"). A page on
//      that same site whose address or title says partner or sponsor.
//   3. Fetch it. Partner pages are logo walls, so the names live in image alt
//      text, link titles and link targets as much as in visible text. Those
//      strings, cleaned, go to the fast model, which returns only the ones that
//      are businesses or organisations shown as partners. It cannot add a name
//      that is not on the page: anything it returns that is not among the
//      strings is dropped.
//
// PUBLIC EVIDENCE ONLY, and worded as such: "listed as a partner of {school}
// athletics", with the page it came from. Nothing here reads an agent's book.
//
// COLLECT FIRST. This stores and shows the lists (admin page). It does not
// change ranking or pitches yet: the lists get looked at before they steer
// anything a business reads.
//
// COST: two searches and one fast-model call per school per refresh, a few
// schools a day (DAILY_SCHOOLS), only schools where an active agent has an
// athlete. SCHOOL_SPONSORS_OFF=1 stops it.

const DAY = 86400000;
const REFRESH_DAYS = 60;
const DAILY_SCHOOLS = 6;
const MAX_NAMES = 120;

const OFF = () => String(process.env.SCHOOL_SPONSORS_OFF || '').trim() === '1';
const keyOf = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS school_sponsors (
    school_key   TEXT NOT NULL,
    school       TEXT NOT NULL,
    business     TEXT NOT NULL,
    business_key TEXT NOT NULL,
    source_url   TEXT NOT NULL,
    found_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (school_key, business_key)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS school_sponsor_runs (
    school_key TEXT PRIMARY KEY,
    school     TEXT NOT NULL,
    ran_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    url        TEXT,
    found      INTEGER NOT NULL DEFAULT 0,
    note       TEXT
  )`);
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return null; } }

// The school's athletics site, from what the staff reader already found.
async function athleticsHost(pool, school) {
  const r = await pool.query(
    `SELECT staff_url, athletics_contact_url FROM program_source
      WHERE LOWER(TRIM(school)) = LOWER(TRIM($1)) AND (staff_url IS NOT NULL OR athletics_contact_url IS NOT NULL)
      ORDER BY (sport = 'football') DESC LIMIT 1`, [school]).catch(() => ({ rows: [] }));
  const row = r.rows[0];
  if (!row) return null;
  return hostOf(row.staff_url) || hostOf(row.athletics_contact_url);
}

const PARTNER_PATH = /partner|sponsor/i;
// A page on the school's own site that is about its partners. -> [url]
async function partnerPages(host, search) {
  const seen = new Set(), out = [];
  for (const q of [`site:${host} corporate partners`, `site:${host} sponsors`]) {
    let rows = [];
    try { rows = await search(q, 8); } catch (e) { console.warn('[school-sponsors] search:', e.message); }
    for (const r of rows) {
      const h = hostOf(r.url);
      if (!h || (h !== host && !h.endsWith('.' + host))) continue;
      if (!PARTNER_PATH.test(r.url) && !PARTNER_PATH.test(r.title || '')) continue;
      if (/\/(news|article|story|roster|schedule)s?\//i.test(r.url)) continue;
      const u = r.url.split('#')[0];
      if (!seen.has(u)) { seen.add(u); out.push(u); }
    }
    if (out.length >= 2) break;
  }
  return out.slice(0, 2);
}

const JUNK = /^(logo|image|img|photo|icon|banner|partner|partners|sponsor|sponsors|corporate partners|our partners|home|menu|close|search|tickets?|shop|donate|facebook|twitter|instagram|youtube|tiktok|x|linkedin|read more|learn more|click here|view all|back to top|skip to( main)? content|privacy policy|terms of service|accessibility)$/i;
function cleanStr(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ')
    .replace(/\b(logo|image)\b\.?$/i, '').replace(/^(logo|image)( of|:)?\s+/i, '').trim();
}
// Strings a partner page carries: image alt and title, link titles, link
// hosts that leave the site, and short visible lines. -> [string]
function strings(html, host) {
  const out = new Set();
  // The athletics department's own vendors (rights holders, ticketing, web) are on these pages but are not sponsors.
  const VENDOR = /^(learfield|playfly|sidearm( sports)?|paciolan|teamworks|opendorse|ticketmaster|seatgeek|ncaa)$/i;
  const add = (s) => { const c = cleanStr(s); if (c.length >= 2 && c.length <= 80 && !JUNK.test(c) && !VENDOR.test(c) && /[a-z]/i.test(c)) out.add(c); };
  for (const m of String(html).matchAll(/<img\b[^>]*?\b(?:alt|title)\s*=\s*"([^"]{2,120})"/gi)) add(m[1]);
  for (const m of String(html).matchAll(/<a\b[^>]*?\b(?:title|aria-label)\s*=\s*"([^"]{2,120})"/gi)) add(m[1]);
  for (const m of String(html).matchAll(/<a\b[^>]*?\bhref\s*=\s*"(https?:\/\/[^"]+)"/gi)) {
    const h = hostOf(m[1]);
    if (h && h !== host && !h.endsWith('.' + host) && !/facebook|twitter|instagram|youtube|tiktok|linkedin|x\.com|google|apple|sidearm|ncaa|espn|ticketmaster|paciolan|learfield|varsity|teamworks|opendorse/.test(h)) add(h.split('.').slice(-2, -1)[0]);
  }
  const text = require('./webSearchTool').htmlToText(html);
  for (const line of text.split('\n')) if (line.length <= 60) add(line);
  return [...out].slice(0, 400);
}

const VENDOR_KEY = /^(learfield|learfield img|img|playfly|sidearm|sidearm sports|paciolan|teamworks|opendorse|ticketmaster|seatgeek|ncaa|affinity licensing)$/;

// The school or its athletics department under another name ("Pinecrest Athletics",
// "Pinecrest State", "the Trojans" are not sponsors of themselves).
function isSchoolName(k, school) {
  if (/\bathletics?\b|\bathletic department\b/.test(k)) return true;
  const sw = new Set(keyOf(school).split(' ').concat(['university', 'college', 'state', 'the', 'of', 'athletics']));
  return k.split(' ').every((w) => sw.has(w));
}

const SYSTEM = 'You read text pulled from a college athletics department\'s corporate partners or sponsors page. Return ONLY the names of businesses or organizations the page lists as partners or sponsors of the athletics program. Exclude the school itself, its conference, the NCAA, menus, buttons, headings, slogans, people\'s names and anything that is not a business. Copy each name exactly as it appears in the list. Answer with JSON: {"businesses": ["..."]}.';

// The fast model picks the business names. Names must come from the list.
async function pickNames(school, list, chat, opts = {}) {
  const res = await chat({ system: SYSTEM, jsonMode: true, maxTokens: 1500, temperature: 0,
    messages: [{ role: 'user', content: opts.news
      ? `School: ${school}\nHeadlines and summaries of partnership announcements from the school's own athletics site, one per line. Return the business each announces as a partner (not the school, not a person):\n${list.join('\n')}`
      : `School: ${school}\nStrings from the page, one per line:\n${list.join('\n')}` }],
    ledger: { site: 'school-sponsors' } });
  let j = null;
  try { j = JSON.parse(String(res && res.text || '').replace(/^```(json)?|```$/g, '')); } catch (_) { j = null; }
  const asked = new Map(list.map((s) => [keyOf(s), s]));
  const out = [];
  for (const n of (j && Array.isArray(j.businesses) ? j.businesses : [])) {
    const k = keyOf(n);
    if (!k || k.length < 3 || isSchoolName(k, school) || VENDOR_KEY.test(k)) continue;
    // On the page as given: an exact line, or (announcements) words that appear in the text.
    const name = asked.has(k) ? asked.get(k) : (opts.news && opts.haystack.includes(' ' + k + ' ') ? String(n).trim() : null);
    if (!name) continue;
    if (!out.some((x) => keyOf(x) === k)) out.push(name);
  }
  return out.slice(0, MAX_NAMES);
}

// Partnership announcements on the school's own site: headline, summary and
// the story's address, which on most athletics sites spells out the headline.
// -> { lines: [..], urls: Map(line -> url) }
async function partnerNews(host, search) {
  const lines = [], urls = new Map(), seen = new Set();
  for (const q of [`site:${host} partnership`, `site:${host} "official partner"`]) {
    let rows = [];
    try { rows = await search(q, 10); } catch (e) { console.warn('[school-sponsors] search:', e.message); }
    for (const r of rows) {
      const h = hostOf(r.url);
      if (!h || (h !== host && !h.endsWith('.' + host))) continue;
      if (seen.has(r.url)) continue; seen.add(r.url);
      let slug = '';
      try { slug = decodeURIComponent(new URL(r.url).pathname.split('/').filter(Boolean).pop() || '').replace(/\.aspx?$/i, '').replace(/[-_]+/g, ' '); } catch (_) { slug = ''; }
      const line = [r.title, r.snippet, slug].filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 400);
      if (!/partner|sponsor/i.test(line)) continue;
      if (/learfield|sidearm|teamworks|opendorse|multimedia rights|ticketing|web and digital/i.test(line)) continue;
      lines.push(line); urls.set(line, r.url);
    }
  }
  return { lines: lines.slice(0, 30), urls };
}

async function fetchHtml(url, fetchImpl) {
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await (fetchImpl || fetch)(url, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; NILDash/1.0)', accept: 'text/html' } });
    if (!r.ok) return null;
    const body = await r.text();
    return body.slice(0, 800000);
  } catch (_) { return null; } finally { clearTimeout(killer); }
}

// One school. deps: { search, chat, fetch, force }. -> { school, url, found, note }
async function refresh(pool, school, deps = {}) {
  await ensureTables(pool);
  const sk = keyOf(school);
  if (!deps.force) {
    const last = (await pool.query(`SELECT ran_at FROM school_sponsor_runs WHERE school_key = $1`, [sk])).rows[0];
    if (last && Date.now() - new Date(last.ran_at).getTime() < REFRESH_DAYS * DAY) return { school, skipped: 'fresh' };
  }
  const done = async (url, found, note) => {
    await pool.query(`INSERT INTO school_sponsor_runs (school_key, school, ran_at, url, found, note) VALUES ($1,$2,NOW(),$3,$4,$5)
      ON CONFLICT (school_key) DO UPDATE SET school = EXCLUDED.school, ran_at = NOW(), url = EXCLUDED.url, found = EXCLUDED.found, note = EXCLUDED.note`, [sk, school, url, found, note]);
    return { school, url, found, note };
  };
  const host = await athleticsHost(pool, school);
  if (!host) return done(null, 0, 'no athletics site on file');
  const search = deps.search || ((q, n) => { const p = require('./webSearchTool').provider(); if (!p) throw new Error('no search provider'); return p.search(q, n); });
  const chat = deps.chat || ((o) => require('./deepseek').chat(o));
  const store = async (names, url) => {
    for (const n of names) {
      await pool.query(`INSERT INTO school_sponsors (school_key, school, business, business_key, source_url) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (school_key, business_key) DO UPDATE SET business = EXCLUDED.business, source_url = EXCLUDED.source_url, found_at = NOW()`,
      [sk, school, n, keyOf(n), url]);
    }
  };
  const notes = [];
  let total = 0, firstUrl = null;
  // A. The partners page, when the site has one.
  const pages = await partnerPages(host, search);
  for (const url of pages) {
    const html = await fetchHtml(url, deps.fetch);
    if (!html) continue;
    const list = strings(html, host);
    if (list.length < 3) continue;
    let names = [];
    try { names = await pickNames(school, list, chat); } catch (e) { notes.push('model failed on the partners page: ' + e.message); break; }
    if (!names.length) continue;
    await store(names, url); total += names.length; firstUrl = firstUrl || url;
    break;
  }
  if (!pages.length) notes.push(`no partners page on ${host}`);
  // B. Partnership announcements on the same site.
  const news = await partnerNews(host, search);
  if (news.lines.length) {
    const haystack = ' ' + keyOf(news.lines.join(' ')) + ' ';
    let names = [];
    try { names = await pickNames(school, news.lines, chat, { news: true, haystack }); } catch (e) { notes.push('model failed on announcements: ' + e.message); }
    for (const n of names) {
      const k = keyOf(n);
      const line = news.lines.find((l) => (' ' + keyOf(l) + ' ').includes(' ' + k + ' ')) || news.lines[0];
      await store([n], news.urls.get(line));
    }
    total += names.length; firstUrl = firstUrl || (names.length ? news.urls.get(news.lines[0]) : null);
  }
  const found = (await pool.query(`SELECT COUNT(*)::int n FROM school_sponsors WHERE school_key = $1`, [sk])).rows[0].n;
  return done(firstUrl || pages[0] || null, found, total ? null : (notes.join('; ') || 'nothing readable on the partners page or in announcements'));
}

// Schools where an agent who sent anything in the last 30 days has an athlete,
// stalest first. -> [school]
async function dueSchools(pool, { limit = DAILY_SCHOOLS } = {}) {
  await ensureTables(pool);
  const r = await pool.query(
    `SELECT s.school FROM (
        SELECT DISTINCT TRIM(a.data->>'school') AS school
          FROM athletes a JOIN users u ON u.id = a.agent_id AND u.role = 'agent' AND COALESCE(u.archived, false) = false
         WHERE COALESCE(TRIM(a.data->>'school'), '') <> ''
           AND EXISTS (SELECT 1 FROM outreach_logs l WHERE l.agent_id = u.id AND l.sent_at > NOW() - INTERVAL '30 days')) s
       LEFT JOIN school_sponsor_runs x ON x.school_key = LOWER(TRIM(regexp_replace(replace(s.school, '&', ' and '), '[^a-zA-Z0-9]+', ' ', 'g')))
      WHERE x.ran_at IS NULL OR x.ran_at < NOW() - ($1::int || ' days')::interval
      ORDER BY x.ran_at NULLS FIRST LIMIT $2`, [REFRESH_DAYS, limit]);
  return r.rows.map((x) => x.school);
}

let _busy = false;
async function tick(pool, deps = {}) {
  if (OFF() || _busy) return { skipped: OFF() ? 'off' : 'busy' };
  _busy = true;
  try {
    const out = [];
    for (const s of await dueSchools(pool)) {
      try { out.push(await refresh(pool, s, deps)); } catch (e) { out.push({ school: s, error: e.message }); }
    }
    if (out.length) console.log('[school-sponsors]', JSON.stringify(out.map((x) => ({ school: x.school, found: x.found, note: x.note || x.error || null }))));
    return { ran: out };
  } finally { _busy = false; }
}
function start(pool) {
  if (OFF()) { console.log('[school-sponsors] off (SCHOOL_SPONSORS_OFF)'); return; }
  const go = () => tick(pool).catch((e) => console.error('[school-sponsors] tick:', e.message));
  setTimeout(go, 10 * 60 * 1000).unref?.();
  const t = setInterval(go, 24 * 60 * 60 * 1000); if (t.unref) t.unref();
}

// The admin page's data. -> [{ school, ran_at, url, found, note, businesses: [..] }]
async function overview(pool) {
  await ensureTables(pool);
  const runs = (await pool.query(`SELECT * FROM school_sponsor_runs ORDER BY found DESC, school`)).rows;
  const rows = (await pool.query(`SELECT school_key, business FROM school_sponsors ORDER BY business`)).rows;
  const by = new Map();
  for (const r of rows) { if (!by.has(r.school_key)) by.set(r.school_key, []); by.get(r.school_key).push(r.business); }
  return runs.map((r) => ({ school: r.school, ranAt: r.ran_at, url: r.url, found: r.found, note: r.note, businesses: by.get(r.school_key) || [] }));
}
function renderHtml(list) {
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const body = list.map((s) => `<div class="s"><div class="h">${esc(s.school)} <span class="n">${s.found} found</span></div>
    <div class="m">${s.url ? `<a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.url)}</a>` : ''}${s.note ? ` ${esc(s.note)}` : ''}</div>
    ${s.businesses.length ? `<div class="b">${s.businesses.map(esc).join(' · ')}</div>` : ''}</div>`).join('') || '<p class="m">Nothing collected yet. Schools are read a few a day.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>School sponsors</title>
<style>body{margin:0;background:#0F1A14;color:#E8EFEA;font:14px/1.5 system-ui,Arial,sans-serif}.w{max-width:960px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}
.s{border-bottom:1px solid #24382B;padding:14px 0}.h{font-weight:700}.n{color:#C8F135;font-weight:600;margin-left:6px}.m{color:#9FB1A6;font-size:12px;word-break:break-all}.b{margin-top:6px}a{color:#9FB1A6}</style></head>
<body><div class="w"><h1>School sponsors</h1><div class="m">Businesses each school's athletics site lists as partners. Collected, not used in pitches yet.</div>${body}</div></body></html>`;
}

module.exports = { ensureTables, athleticsHost, partnerPages, strings, pickNames, refresh, dueSchools, tick, start, overview, renderHtml, keyOf, REFRESH_DAYS, DAILY_SCHOOLS };
