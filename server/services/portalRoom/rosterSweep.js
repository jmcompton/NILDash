'use strict';
// ── EVERY FBS FOOTBALL ROSTER, READ FROM THE SCHOOL'S OWN SITE ──────────────
//
// The Portal Room's need board counts who is in each position room and who is
// likely leaving. That starts here: one roster page per FBS school, read off
// the athletics site the program map already knows, stored in program_roster.
// A SHARED asset like the program map: built by a job, read by every agent.
//
// READING. The roster parser the university import already uses
// (universityRosterImport.parseRoster: Sidearm cards, the newer Sidearm person
// cards, and any table with a Name column). When that finds too few players
// with a position, the page's text goes to the fast model, which copies the
// players out. It reads the FETCHED page, never a search, and never invents.
//
// WHEN. Once a night between 9 and 11pm Central, a slice of the schools whose
// roster is oldest (SLICE a night), so the whole of FBS refreshes every few
// days and no one site is hit more than once a night. During the portal season
// (Dec 1 to Jan 31) a roster is stale after 2 days instead of 6.
// Off with PORTAL_ROSTER_SWEEP=off. Model fallback off with
// PORTAL_ROSTER_MODEL=off.

const crypto = require('crypto');
const cheerio = require('cheerio');
const P = require('./positions');
const Schools = require('./schools');

const UA = 'Mozilla/5.0 (compatible; NILDashBot/1.0; +https://mynildash.com)';
const MIN_OK = 50;            // a real FBS roster lists 100+; under 50 with positions is a bad read
const SLICE = 45;             // schools a night
const PAUSE_MS = 1500;
const FETCH_MS = 20000;
const MODEL_MS = 60000;
const MAX_BYTES = 4_000_000;
const MODEL_PER_NIGHT = 10;   // at most this many model reads a sweep (about 40 cents)
const MODEL_RETRY_DAYS = 7;   // and never the same school twice in a week

const on = () => String(process.env.PORTAL_ROSTER_SWEEP || '').toLowerCase() !== 'off';
const modelOn = () => String(process.env.PORTAL_ROSTER_MODEL || '').toLowerCase() !== 'off';

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS program_roster (
    school TEXT NOT NULL, sport TEXT NOT NULL DEFAULT 'football',
    season TEXT, roster_url TEXT, players JSONB DEFAULT '[]'::jsonb,
    player_count INT DEFAULT 0, with_position INT DEFAULT 0, with_year INT DEFAULT 0,
    parse_via TEXT, status TEXT, error TEXT, tried JSONB DEFAULT '[]'::jsonb, hash TEXT,
    fetched_at TIMESTAMPTZ, PRIMARY KEY (school, sport))`);
  // fetched_at is when the roster ON FILE was read; last_attempt_at and
  // last_error are the latest try, good or bad, so a dead site cannot pass
  // for a fresh read. model_tried_at keeps the model from re-reading the same
  // unreadable page every night.
  await pool.query(`ALTER TABLE program_roster ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE program_roster ADD COLUMN IF NOT EXISTS last_error TEXT`);
  await pool.query(`ALTER TABLE program_roster ADD COLUMN IF NOT EXISTS model_tried_at TIMESTAMPTZ`);
  await pool.query(`CREATE TABLE IF NOT EXISTS portal_sweep_runs (run_date DATE PRIMARY KEY, started_at TIMESTAMPTZ DEFAULT NOW(), summary JSONB)`);
}

// The football season a roster belongs to: Feb onward is this year's.
function seasonOf(now = new Date()) { return now.getUTCMonth() >= 1 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; }

function inPortalSeason(now = new Date()) {
  const m = now.getUTCMonth();
  return m === 11 || m === 0;
}
function staleDays(now) { return inPortalSeason(now) ? 2 : 6; }

// Best first. The host the staff page lives on is the surest (the program map
// proved it); then the domain on file, with and without www.
function candidateUrls(domain, staffUrl, now = new Date()) {
  const season = seasonOf(now);
  const hosts = [];
  try { if (staffUrl) hosts.push(new URL(staffUrl).origin); } catch (_) { /* bad url on file */ }
  if (domain) { hosts.push(`https://${domain}`); if (!/^www\./.test(domain)) hosts.push(`https://www.${domain}`); }
  const urls = [];
  for (const h of [...new Set(hosts)]) urls.push(`${h}/sports/football/roster`, `${h}/sports/football/roster/${season}`);
  return [...new Set(urls)];
}

async function fetchPage(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: ctl.signal });
    if (!r.ok) return { ok: false, status: r.status, url };
    let html = await r.text();
    if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);
    return { ok: true, status: r.status, url: r.url || url, html };
  } catch (e) {
    return { ok: false, status: 0, url, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

// One player, as stored: what the page printed plus what it means.
function shape(p) {
  const pos = String(p.position || p.pos || '').trim().slice(0, 30);
  const year = String(p.year || '').trim().slice(0, 30);
  const c = P.classOf(year);
  return {
    name: String(p.name || '').trim().slice(0, 80),
    jersey: String(p.jersey || '').trim().slice(0, 4) || null,
    pos: pos || null, group: P.groupOf(pos), year: year || null, cls: c.cls,
    leaving: P.isLeaving(year),
    hometown: String(p.hometown || '').trim().slice(0, 80) || null,
  };
}

function score(players) {
  return { count: players.length, withPos: players.filter((p) => p.group).length, withYear: players.filter((p) => p.cls).length };
}

function pageText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, header nav, footer, iframe').remove();
  const root = $('main').length ? $('main') : $('body');
  return root.text().replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// The model copies the players off the page text. Extraction only.
async function extractWithModel(html, url, ai) {
  const text = pageText(html).slice(0, 60000);
  if (text.length < 500) return [];
  const sys = 'You copy a football roster out of the text of ONE web page. Output ONLY JSON. Copy names, positions and class years exactly as printed. Never invent a player, a position or a year. Skip coaches and staff.';
  const prompt = `This is the text of the football roster page at ${url}. List EVERY player.
Respond with ONLY: {"players":[{"name":"","position":"","year":"","jersey":"","hometown":""}]}
Use "" for anything the page does not print for that player.

PAGE TEXT:
${text}`;
  const meter = require('../../scanMeter');
  const call = meter.label({ site: 'portal.roster' }, () => ai.oneShot(prompt, sys, 8000, ai.MODEL_FAST));
  const raw = ai.withDeadline ? await ai.withDeadline(call, MODEL_MS, `roster extraction for ${url}`) : await call;
  const s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return [];
  const o = JSON.parse(s.slice(a, b + 1));
  return Array.isArray(o.players) ? o.players : [];
}

// Read one school's roster. Never throws: what happened is in the result.
async function readRoster({ school, domain, staffUrl, now = new Date() }, deps = {}) {
  const get = deps.fetchPage || fetchPage;
  const parse = deps.parseRoster || require('../universityRosterImport').parseRoster;
  const tried = [];
  let best = null;
  for (const url of candidateUrls(domain, staffUrl, now)) {
    const page = await get(url);
    if (!page.ok) { tried.push({ url, status: page.status || 0, error: page.error || null }); continue; }
    let players = [];
    try { players = parse(page.html).map(shape).filter((p) => p.name); } catch (e) { tried.push({ url, status: page.status, error: 'parse: ' + e.message }); continue; }
    const sc = score(players);
    tried.push({ url: page.url, status: page.status, players: sc.count, withPos: sc.withPos });
    if (!best || sc.withPos > best.sc.withPos) best = { url: page.url, html: page.html, players, sc, via: 'parser' };
    if (sc.withPos >= MIN_OK) break;
  }
  if (!best) return { school, status: 'failed', error: 'no roster page answered', tried, players: [] };
  const ai = deps.ai === undefined ? (() => { try { return require('../../ai'); } catch (_) { return null; } })() : deps.ai;
  const budget = deps.modelBudget;
  const allowed = deps.allowModel !== false && (!budget || budget.left > 0);
  let modelTried = false;
  if (best.sc.withPos < MIN_OK && ai && modelOn() && allowed) {
    if (budget) budget.left--;
    modelTried = true;
    try {
      const got = (await extractWithModel(best.html, best.url, ai)).map(shape).filter((p) => p.name);
      const sc = score(got);
      tried.push({ url: best.url, via: 'model', players: sc.count, withPos: sc.withPos });
      if (sc.withPos > best.sc.withPos) best = { ...best, players: got, sc, via: 'model' };
    } catch (e) { tried.push({ url: best.url, via: 'model', error: e.message }); }
  }
  // Two players can share a name; the same name at the same position and
  // jersey is the same line read twice.
  const seen = new Set();
  const players = best.players.filter((p) => { const k = [p.name.toLowerCase(), p.pos || '', p.jersey || ''].join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
  const sc = score(players);
  return {
    school, status: sc.withPos >= MIN_OK ? 'ok' : 'thin', url: best.url, via: best.via, tried, modelTried,
    players, count: sc.count, withPos: sc.withPos, withYear: sc.withYear,
    error: sc.withPos >= MIN_OK ? null : `only ${sc.withPos} players with a position`,
  };
}

async function save(pool, r, now = new Date()) {
  const hash = crypto.createHash('sha1').update(JSON.stringify(r.players.map((p) => [p.name, p.pos, p.year]))).digest('hex').slice(0, 16);
  // A failed or thin read never overwrites a good roster already on file: the
  // old one stays and the attempt is recorded in tried/error.
  await pool.query(`INSERT INTO program_roster (school, sport, season, roster_url, players, player_count, with_position, with_year, parse_via, status, error, tried, hash, fetched_at, last_attempt_at, last_error, model_tried_at)
    VALUES ($1,'football',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$10,$14)
    ON CONFLICT (school, sport) DO UPDATE SET
      season = CASE WHEN EXCLUDED.status = 'ok' OR program_roster.status IS DISTINCT FROM 'ok' THEN EXCLUDED.season ELSE program_roster.season END,
      roster_url = CASE WHEN EXCLUDED.status = 'ok' OR program_roster.status IS DISTINCT FROM 'ok' THEN EXCLUDED.roster_url ELSE program_roster.roster_url END,
      players = CASE WHEN EXCLUDED.status = 'ok' OR program_roster.status IS DISTINCT FROM 'ok' THEN EXCLUDED.players ELSE program_roster.players END,
      player_count = CASE WHEN EXCLUDED.status = 'ok' OR program_roster.status IS DISTINCT FROM 'ok' THEN EXCLUDED.player_count ELSE program_roster.player_count END,
      with_position = CASE WHEN EXCLUDED.status = 'ok' OR program_roster.status IS DISTINCT FROM 'ok' THEN EXCLUDED.with_position ELSE program_roster.with_position END,
      with_year = CASE WHEN EXCLUDED.status = 'ok' OR program_roster.status IS DISTINCT FROM 'ok' THEN EXCLUDED.with_year ELSE program_roster.with_year END,
      parse_via = CASE WHEN EXCLUDED.status = 'ok' OR program_roster.status IS DISTINCT FROM 'ok' THEN EXCLUDED.parse_via ELSE program_roster.parse_via END,
      hash = CASE WHEN EXCLUDED.status = 'ok' OR program_roster.status IS DISTINCT FROM 'ok' THEN EXCLUDED.hash ELSE program_roster.hash END,
      status = CASE WHEN EXCLUDED.status = 'ok' OR program_roster.status IS DISTINCT FROM 'ok' THEN EXCLUDED.status ELSE program_roster.status END,
      fetched_at = CASE WHEN EXCLUDED.status = 'ok' OR program_roster.status IS DISTINCT FROM 'ok' THEN EXCLUDED.fetched_at ELSE program_roster.fetched_at END,
      error = EXCLUDED.error, tried = EXCLUDED.tried, last_attempt_at = EXCLUDED.last_attempt_at, last_error = EXCLUDED.last_error,
      model_tried_at = COALESCE(EXCLUDED.model_tried_at, program_roster.model_tried_at)`,
    [r.school, String(seasonOf(now)), r.url || null, JSON.stringify(r.players || []), r.count || 0, r.withPos || 0, r.withYear || 0,
      r.via || null, r.status, r.error || null, JSON.stringify(r.tried || []), hash, now, r.modelTried ? now : null]);
}

// The schools due a read, oldest first. Failed reads go to the back of the line
// for the night they failed (last_attempt_at is set either way).
async function due(pool, { now = new Date(), limit = SLICE, schools = null, force = false } = {}) {
  await ensureTables(pool);
  const all = Schools.all().filter((s) => s.domain || s.name);
  const pick = schools ? all.filter((s) => schools.includes(s.name)) : all;
  const r = await pool.query(`SELECT school, COALESCE(last_attempt_at, fetched_at) AS at FROM program_roster WHERE sport = 'football'`);
  const at = new Map(r.rows.map((x) => [x.school, x.at ? new Date(x.at).getTime() : 0]));
  const cutoff = now.getTime() - staleDays(now) * 86400000;
  return pick
    .filter((s) => force || !at.get(s.name) || at.get(s.name) < cutoff)
    .sort((a, b) => (at.get(a.name) || 0) - (at.get(b.name) || 0) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// One sweep at a time in this process: the nightly tick and the admin button
// share it, so a double click cannot start parallel scrapes.
let running = false;
function isRunning() { return running; }

async function sweep(pool, opts = {}, deps = {}) {
  if (running) { const e = new Error('A roster sweep is already running.'); e.status = 409; throw e; }
  running = true;
  try { return await _sweep(pool, opts, deps); } finally { running = false; }
}

async function _sweep(pool, opts = {}, deps = {}) {
  const now = opts.now || new Date();
  const budget = deps.modelBudget || { left: MODEL_PER_NIGHT };
  const modelAt = new Map();
  try {
    const m = await pool.query(`SELECT school, model_tried_at FROM program_roster WHERE sport = 'football' AND model_tried_at IS NOT NULL`);
    for (const x of m.rows) modelAt.set(x.school, new Date(x.model_tried_at).getTime());
  } catch (_) { /* table just made */ }
  const list = await due(pool, { ...opts, now });
  const src = new Map();
  try {
    const r = await pool.query(`SELECT school, staff_url FROM program_source WHERE sport = 'football'`);
    for (const x of r.rows) src.set(x.school, x.staff_url);
  } catch (_) { /* no program map here */ }
  const out = { started: now.toISOString(), schools: list.length, ok: 0, thin: 0, failed: 0, viaModel: 0, results: [] };
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const recentModel = modelAt.get(s.name) && now.getTime() - modelAt.get(s.name) < MODEL_RETRY_DAYS * 86400000;
    const r = await readRoster({ school: s.name, domain: s.domain, staffUrl: src.get(s.name), now }, { ...deps, modelBudget: budget, allowModel: !recentModel });
    await save(pool, r, now).catch((e) => { r.status = 'failed'; r.error = 'save: ' + e.message; });
    out[r.status] = (out[r.status] || 0) + 1;
    if (r.via === 'model') out.viaModel++;
    out.results.push({ school: s.name, status: r.status, players: r.count || 0, withPos: r.withPos || 0, via: r.via || null, url: r.url || null, error: r.error || null });
    if (i < list.length - 1) await new Promise((res) => setTimeout(res, deps.pauseMs != null ? deps.pauseMs : PAUSE_MS));
  }
  return out;
}

function centralHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(now)) % 24;
}
function centralDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);
}

// The nightly tick: 9pm to 11pm Central, once a night (claimed by date).
async function tick(pool, { now = new Date() } = {}, deps = {}) {
  if (!on()) return { skipped: 'off' };
  const h = centralHour(now);
  if (h < 21 || h >= 23) return { skipped: 'outside window' };
  await ensureTables(pool);
  if (running) return { skipped: 'sweep running' };
  const claim = await pool.query(`INSERT INTO portal_sweep_runs (run_date) VALUES ($1) ON CONFLICT DO NOTHING RETURNING run_date`, [centralDate(now)]);
  if (!claim.rowCount) return { skipped: 'already ran tonight' };
  const sum = await sweep(pool, { now }, deps);
  await pool.query(`UPDATE portal_sweep_runs SET summary = $2 WHERE run_date = $1`, [centralDate(now), JSON.stringify({ ...sum, results: sum.results.filter((x) => x.status !== 'ok') })]);
  console.log(`[portal] roster sweep: ${sum.ok} ok, ${sum.thin} thin, ${sum.failed} failed of ${sum.schools} (${sum.viaModel} via model)`);
  return sum;
}

async function coverage(pool) {
  await ensureTables(pool);
  const total = Schools.all().length;
  const r = await pool.query(`SELECT school, status, player_count, with_position, with_year, parse_via, error, roster_url, fetched_at, last_attempt_at, last_error
    FROM program_roster WHERE sport = 'football' ORDER BY school`);
  const ok = r.rows.filter((x) => x.status === 'ok');
  const newest = r.rows.reduce((m, x) => (x.fetched_at && (!m || x.fetched_at > m) ? x.fetched_at : m), null);
  return {
    total, read: ok.length, thin: r.rows.filter((x) => x.status === 'thin').length, failed: r.rows.filter((x) => x.status === 'failed').length,
    notYet: total - r.rows.length, lastRead: newest,
    // A school whose roster on file is good but whose latest read failed is
    // still on the list: the roster is getting old and nobody would know.
    attention: r.rows.filter((x) => x.status !== 'ok' || (x.last_error && x.last_attempt_at && x.fetched_at && new Date(x.last_attempt_at) > new Date(x.fetched_at)))
      .map((x) => ({ school: x.school, status: x.status, error: x.last_error || x.error, url: x.roster_url, rosterFrom: x.fetched_at, lastTry: x.last_attempt_at })),
  };
}

module.exports = { isRunning, MODEL_PER_NIGHT, MODEL_RETRY_DAYS, ensureTables, candidateUrls, readRoster, save, due, sweep, tick, coverage, shape, seasonOf, inPortalSeason, staleDays, centralHour, MIN_OK, SLICE, on };
