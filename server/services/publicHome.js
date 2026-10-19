'use strict';
// ── THE PUBLIC HOMEPAGE (HOME_V2_ON) ────────────────────────────────────────
//
// Logged-out mynildash.com was public/index.html: the marketing block sitting
// on top of the whole agent portal, which a stranger's browser then booted.
// Home's first-paint loader ran with no session and wrote "Could not load
// today's outreach: Not authenticated" into the page, and the headings were
// set in Syne, which the page never loaded, so they fell back to a serif.
//
// With HOME_V2_ON=1, a visitor with no session who asks for / gets
// server/views/home.html instead: a page of its own with none of the portal in
// it, its own fonts (font-display: swap), live counts from the database, and
// the athlete waitlist. Everyone else gets index.html exactly as before:
//   - a signed-in session (the app);
//   - any query the app reads (?jwt=, ?actor=, ?next=, ?subscribed=, ...).
//     Only marketing parameters (ref, utm_*, gclid, ...) keep the homepage;
//   - an athlete whose token is in localStorage, which the server cannot see:
//     home.html sends them to /?app=1 before it paints.
// Off: nothing here runs, and / is index.html.
//
// /home-preview shows the page whatever the switch says (noindex), so it can
// be read on production before the switch goes on.

const fs = require('fs');
const path = require('path');

const ON = () => process.env.HOME_V2_ON === '1';
const TEMPLATE = path.join(__dirname, '..', 'views', 'home.html');
const STATS_TTL_MS = 10 * 60 * 1000;
const STATS_WAIT_MS = 800;
const DEMO_EMAIL = 'demo@comptongroupllc.com';

// Query parameters that do not change what the page is: ad and referral tags
// (the ?ref cookie is set before this runs), and the waitlist's own "joined".
const MARKETING_PARAM = /^(ref|utm_[a-z_]+|gclid|fbclid|msclkid|mc_cid|mc_eid|joined)$/i;

function onlyMarketingParams(query) {
  return Object.keys(query || {}).every((k) => MARKETING_PARAM.test(k));
}

// Whether this request for / gets the new homepage. req.session is read, so
// the session middleware must have run (server/index.js runs it first).
function servesHome(req) {
  if (!ON()) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.path !== '/') return false;
  if (req.session && req.session.userId) return false;
  return onlyMarketingParams(req.query);
}

// ── LIVE COUNTS ─────────────────────────────────────────────────────────────
// Each is one table, counted as it stands, and named for exactly what it
// counts. A count that is zero, or that could not be read, is left off.
const STATS = [
  { key: 'businesses', label: 'local businesses found in athletes’ markets',
    sql: `SELECT COUNT(*)::int AS n FROM market_business_seen` },
  { key: 'verified', label: 'contact emails verified as a working mailbox',
    sql: `SELECT COUNT(DISTINCT LOWER(email))::int AS n FROM email_verification WHERE result = 'valid'` },
  { key: 'sent', label: 'pitch emails sent by agents',
    sql: `SELECT COUNT(*)::int AS n FROM outreach_logs
           WHERE sent_at IS NOT NULL
             AND (agent_id IS NULL OR agent_id NOT IN (SELECT id FROM users WHERE LOWER(email) = $1))`,
    params: [DEMO_EMAIL] },
];

let _cache = null;     // { at, stats }
let _pending = null;

async function readStats(pool) {
  const out = {};
  for (const s of STATS) {
    try { out[s.key] = Number((await pool.query(s.sql, s.params || [])).rows[0].n) || 0; }
    catch (e) { out[s.key] = null; console.warn(`[home] count ${s.key} could not be read: ${e.message}`); }
  }
  return out;
}

async function stats(pool, opts = {}) {
  const now = opts.now || Date.now();
  if (_cache && now - _cache.at < STATS_TTL_MS) return _cache.stats;
  if (!_pending) {
    _pending = readStats(pool)
      .then((s) => { _cache = { at: Date.now(), stats: s }; return s; })
      .finally(() => { _pending = null; });
  }
  return _pending;
}

// The page never waits long for its numbers: past STATS_WAIT_MS it renders
// without them, and the read that is still going fills the cache for the next.
async function statsForPage(pool, opts = {}) {
  const wait = opts.waitMs != null ? opts.waitMs : STATS_WAIT_MS;
  let timer;
  const late = new Promise((r) => { timer = setTimeout(() => r(null), wait); });
  try { return await Promise.race([stats(pool, opts).catch(() => null), late]); }
  finally { clearTimeout(timer); }
}

const fmt = (n) => Number(n).toLocaleString('en-US');

// Pure. -> the stats row, or '' when there is nothing true and nonzero to show.
function renderStats(s) {
  const shown = STATS.filter((d) => s && Number(s[d.key]) > 0);
  if (!shown.length) return '';
  return '<section class="stats" aria-label="NILDash so far"><div class="wrap">'
    + '<ul class="stat-row">'
    + shown.map((d) => `<li class="stat"><span class="n">${fmt(s[d.key])}</span><span class="l">${d.label}</span></li>`).join('')
    + '</ul><p class="stat-note">Counted live from NILDash’s own records.</p></div></section>';
}

let _template = null;
function template() {
  if (_template && process.env.NODE_ENV === 'production') return _template;
  _template = fs.readFileSync(TEMPLATE, 'utf8');
  return _template;
}

async function render(pool, opts = {}) {
  const s = await statsForPage(pool, opts);
  let html = template().replace('<!--HOME_STATS-->', renderStats(s));
  if (opts.preview) html = html.replace('<head>', '<head>\n<meta name="robots" content="noindex">');
  return html;
}

async function send(pool, req, res, opts = {}) {
  const html = await render(pool, opts);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('Vary', 'Cookie');
  res.type('html').send(html);
}

// ── THE ATHLETE WAITLIST ────────────────────────────────────────────────────
async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS home_waitlist (
    email      TEXT PRIMARY KEY,
    audience   TEXT NOT NULL DEFAULT 'athlete',
    source     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

function cleanEmail(raw) {
  const e = String(Array.isArray(raw) ? raw[0] : (raw == null ? '' : raw)).trim().toLowerCase();
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

async function joinWaitlist(pool, rawEmail, opts = {}) {
  const email = cleanEmail(rawEmail);
  if (!email) return { ok: false, error: 'Enter a valid email address.' };
  await ensureTable(pool);
  const src = opts.source ? String(opts.source).slice(0, 64).replace(/[^a-z0-9_.:-]/gi, '') : null;
  const r = await pool.query(
    `INSERT INTO home_waitlist (email, audience, source) VALUES ($1, 'athlete', $2)
     ON CONFLICT (email) DO NOTHING RETURNING email`, [email, src]);
  return { ok: true, already: r.rowCount === 0 };
}

async function waitlist(pool) {
  await ensureTable(pool);
  return (await pool.query(`SELECT email, audience, source, created_at FROM home_waitlist ORDER BY created_at DESC`)).rows;
}

function _reset() { _cache = null; _pending = null; _template = null; }

module.exports = {
  ON, servesHome, onlyMarketingParams, MARKETING_PARAM,
  STATS, STATS_TTL_MS, stats, statsForPage, renderStats, render, send, TEMPLATE,
  ensureTable, cleanEmail, joinWaitlist, waitlist, DEMO_EMAIL, _reset,
};
