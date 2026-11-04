'use strict';
// ── FINDING HEAD COACHING CHANGES IN THE NEWS ───────────────────────────────
//
// Once a day (6 to 7am Central, before the morning email) the Portal Room
// reads the news for FBS head football coaches who were fired, resigned,
// retired or left, and adds each one to portal_coaching_changes with the
// article it came from. Every card and board in the Portal Room shows
// "New head coach coming" from that table (services/portalRoom/
// coachingChanges).
//
// A wrong "new head coach" is worse than a missing one (Oct 2026: the staff
// table's titles showed a change at nearly every school), so a story has to
// clear every gate:
//   1. it comes from a known sports news outlet or the school's own site;
//   2. its headline is about a departure, not a rumor ("hot seat", "could",
//      "candidates", "expected to");
//   3. the model, reading only that headline and snippet, says it is the HEAD
//      FOOTBALL coach of a named school leaving, with the date;
//   4. that school is an FBS school (schools.canonical, which refuses
//      namesakes like Tennessee State) and its name is in the story itself;
//   5. the date is within the last 10 days, and the school has no change on
//      file from the last 60 days already.
// Each one added is emailed to JohnMark with its link, and the admin route
// DELETE /api/admin/portal/coaching-change/:school takes a wrong one out.
// Off with PORTAL_COACH_WATCH=off.

const Schools = require('./schools');
const Coaching = require('./coachingChanges');

const on = () => String(process.env.PORTAL_COACH_WATCH || '').toLowerCase() !== 'off';
const QUERIES = [
  'college football head coach fired',
  'head football coach fired',
  'head football coach resigns',
  'head football coach retires',
  'football program parts ways with head coach',
];
const OUTLETS = /(^|\.)(espn\.com|cbssports\.com|on3\.com|247sports\.com|foxsports\.com|si\.com|apnews\.com|usatoday\.com|nytimes\.com|theathletic\.com|yahoo\.com|nbcsports\.com|footballscoop\.com|saturdaydownsouth\.com|saturdaytradition\.com|actionnetwork\.com|sportingnews\.com|stadiumtalk\.com|al\.com|ajc\.com|tennessean\.com|dallasnews\.com|houstonchronicle\.com|latimes\.com|chicagotribune\.com|freep\.com|desmoinesregister\.com|azcentral\.com|orlandosentinel\.com|sun-sentinel\.com|nola\.com|kansascity\.com|star-telegram\.com|wral\.com|newsobserver\.com|cfbeveryday\.com)$/i;
const RUMOR = /\bhot seat\b|\bcould\b|\bmight\b|\bexpected to\b|\bcandidates?\b|\brumou?r|\bconsidering\b|\bpotential\b|\bpredict|\bshould\b|\bwho will\b|\blist of\b|\branking/i;
const DEPARTURE = /\bfired\b|\bfires\b|\bresign|\bretire|\bparts? ways\b|\bdismiss|\bout as\b|\bleaves?\b|\bstep(s|ping)? down\b|\bterminated\b|\breliev/i;
const MAX_AGE_DAYS = 10, DEDUPE_DAYS = 60;
const chicagoDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d || new Date());
const centralHour = (now) => parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(now), 10);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };

async function serperNews(q) {
  const key = String(process.env.SERPER_API_KEY || '').trim();
  if (!key) throw new Error('SERPER_API_KEY is not set');
  const r = await fetch(process.env.SERPER_NEWS_URL || 'https://google.serper.dev/news', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-API-KEY': key }, body: JSON.stringify({ q, tbs: 'qdr:w', num: 20 }),
  });
  if (!r.ok) throw new Error('news search ' + r.status);
  const j = await r.json();
  return (j.news || []).map((n) => ({ title: n.title || '', snippet: n.snippet || '', link: n.link || '', source: n.source || '', date: n.date || '' }));
}

// The school's own athletics site counts as a source for its own news.
function schoolSite(host, school) {
  const s = Schools.all().find((x) => x.name === school);
  return !!(s && s.domain && host && (host === s.domain || host.endsWith('.' + s.domain)));
}

// Gate 3: the model reads the headline and snippet only.
async function extract(item, deps = {}) {
  if (deps.extract) return deps.extract(item);
  const ai = require('../../ai');
  const prompt = `A news headline and snippet follow. Decide if it reports that the HEAD FOOTBALL COACH of a specific college has left the job (fired, resigned, retired, or left for another job). Not an assistant or coordinator, not another sport, not a rumor or hot-seat story, not only a hiring.
HEADLINE: ${JSON.stringify(item.title)}
SNIPPET: ${JSON.stringify(item.snippet)}
PUBLISHED: ${JSON.stringify(item.date)} (today is ${chicagoDay()})
Return ONLY JSON: {"departure":true|false,"school":"the college's name as written","coach":"full name","how":"fired|resigned|retired|left","date":"YYYY-MM-DD the day it happened, or null","interim":"name or null","newCoach":"name or null"}`;
  const raw = await ai.oneShot(prompt, 'You read sports news and return strict JSON. When unsure, departure is false.', 300);
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// One pass. -> { added: [...], skipped: [{title, why}] }
async function run(pool, { now = new Date(), deps = {} } = {}) {
  const search = deps.search || serperNews;
  const seen = new Set(), items = [];
  for (const q of QUERIES) {
    let res = [];
    try { res = await search(q); } catch (e) { console.warn('[portal/coach-watch] search:', e.message); }
    for (const it of res) { if (it.link && !seen.has(it.link)) { seen.add(it.link); items.push(it); } }
  }
  const existing = await Coaching.load(pool, { now });
  const added = [], skipped = [];
  const today = chicagoDay(now);
  for (const it of items) {
    const host = hostOf(it.link);
    const text = `${it.title} ${it.snippet}`;
    if (RUMOR.test(it.title)) { skipped.push({ title: it.title, why: 'rumor' }); continue; }
    if (!DEPARTURE.test(text) || !/\bcoach/i.test(text)) { skipped.push({ title: it.title, why: 'not a departure' }); continue; }
    let x = null;
    try { x = await extract(it, deps); } catch (e) { skipped.push({ title: it.title, why: 'could not read' }); continue; }
    if (!x || x.departure !== true) { skipped.push({ title: it.title, why: 'not a head coach leaving' }); continue; }
    const school = Schools.canonical(x.school);
    if (!school) { skipped.push({ title: it.title, why: 'not FBS: ' + x.school }); continue; }
    // Gate 1 here: we know the school, so its own site counts too.
    if (!OUTLETS.test(host) && !schoolSite(host, school)) { skipped.push({ title: it.title, why: 'unknown outlet: ' + host }); continue; }
    const named = [school, x.school].some((n) => n && text.toLowerCase().includes(String(n).toLowerCase()));
    if (!named) { skipped.push({ title: it.title, why: 'school not in the story' }); continue; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || '')) ? x.date : null;
    if (!date) { skipped.push({ title: it.title, why: 'no date' }); continue; }
    const age = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000);
    if (age < -1 || age > MAX_AGE_DAYS) { skipped.push({ title: it.title, why: 'too old: ' + date }); continue; }
    const have = existing.get(school);
    if (have && Math.abs(Date.parse(have.date + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000 <= DEDUPE_DAYS) { skipped.push({ title: it.title, why: 'already on file' }); continue; }
    if (added.some((a) => a.school === school)) continue;
    const how = ['fired', 'resigned', 'retired', 'left'].includes(x.how) ? x.how : 'left';
    const row = { school, coach: String(x.coach || '').slice(0, 80) || null, how, date, interim: x.interim || null, newCoach: x.newCoach || null, source: it.link };
    await Coaching.add(pool, row);
    added.push({ ...row, title: it.title });
  }
  if (added.length) {
    try { require('./index').clearCache(); } catch (_) {}
    try {
      const text = ['The Portal Room found these head coaching changes in the news and added them:', '',
        ...added.map((a) => `- ${a.school}: ${a.coach || 'head coach'} ${a.how} ${a.date}. ${a.source}`), '',
        'If one is wrong, tell Claude and it comes out (DELETE /api/admin/portal/coaching-change/<school>).'].join('\n');
      await (deps.notify || notify)({ subject: `Portal Room: ${added.length} coaching change${added.length === 1 ? '' : 's'} added`, text });
    } catch (e) { console.warn('[portal/coach-watch] notify:', e.message); }
  }
  return { items: items.length, added, skipped };
}

async function notify(msg) {
  if (!process.env.RESEND_API_KEY) return;
  const resend = require('../resendChecked').makeResend(process.env.RESEND_API_KEY);
  await resend.emails.send({ from: process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>', to: process.env.PORTAL_LEAD_ALERT_TO || 'john@comptongroupllc.com', subject: msg.subject, text: msg.text });
}

async function remove(pool, school) {
  const s = Schools.canonical(school);
  if (!s) { const e = new Error('unknown FBS school'); e.status = 400; throw e; }
  await Coaching.ensureTable(pool);
  const r = await pool.query(`DELETE FROM portal_coaching_changes WHERE school = $1 AND sport = 'football'`, [s]);
  try { require('./index').clearCache(); } catch (_) {}
  return { school: s, removed: r.rowCount };
}

let _ready = null;
// The daily tick: 6 to 7am Central, once a day.
async function tick(pool, { now = new Date(), deps = {} } = {}) {
  if (!on()) return { skipped: 'off' };
  const h = centralHour(now);
  if (h !== 6) return { skipped: 'not the hour' };
  if (!_ready) _ready = pool.query(`CREATE TABLE IF NOT EXISTS portal_coach_watch_runs (day DATE PRIMARY KEY, added INTEGER, at TIMESTAMPTZ DEFAULT NOW())`).catch((e) => { _ready = null; throw e; });
  await _ready;
  const c = await pool.query(`INSERT INTO portal_coach_watch_runs (day) VALUES ($1) ON CONFLICT DO NOTHING RETURNING day`, [chicagoDay(now)]);
  if (!c.rows.length) return { skipped: 'already today' };
  const r = await run(pool, { now, deps });
  await pool.query(`UPDATE portal_coach_watch_runs SET added = $2 WHERE day = $1`, [chicagoDay(now), r.added.length]);
  return r;
}

module.exports = { on, run, tick, remove, extract, QUERIES, OUTLETS, RUMOR, DEPARTURE };
