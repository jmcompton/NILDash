'use strict';
// ── THE PUBLIC DEMO PAGE, COUNTED ───────────────────────────────────────────
//
// /demo is public, so this is too: POST /api/demo/event takes
// { session_id, event, screen, ref? } from the page and writes one row to
// demo_events. The route answers 204 BEFORE the write and whatever happens --
// a bad body, a full rate limit, a database error -- so the page is never
// slowed or broken by it and learns nothing from the reply.
//
// NOTHING THAT IDENTIFIES A PERSON IS STORED:
//   session_id  a random id the page makes per visit (not a cookie, not a user)
//   referrer    a source bucket ('linkedin', 'google', 'direct') or a bare host
//               name -- never a full URL, which can carry names and tokens
//   device      mobile | tablet | desktop | bot, from the User-Agent
//   country     a two-letter code from a CDN header when one is present
// No IP address is written anywhere. The rate limiter keys on the IP in
// memory only, for the minute it counts.
//
// WHY THE PAGE SENDS `ref`. The request's own Referer header is the demo page
// itself (the page is what makes the call), so the source a visitor arrived
// from is only known to the page, as document.referrer and any utm_source on
// its URL. The page passes those through; this reduces them to a bucket here.

// What the page may report. Anything else is dropped, so the table cannot fill
// with arbitrary strings.
const EVENTS = new Set([
  'view',           // the page loaded (one per visit)
  'screen',         // a screen was opened (screen = its id)
  'deal_scan',      // Run Deal Scan
  'pitch_open',     // a pitch opened, or drafted in Deal Scan
  'pitch_approve',  // a pitch approved or sent (one card, Approve all, or Send)
  'book_call',      // Book a call clicked
  'heartbeat',      // still here, every 30s while the tab is visible
  'leave',          // the tab was closed or hidden
]);

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SCREEN_RE = /^[a-z0-9_-]{1,40}$/;

// ── DEVICE ───────────────────────────────────────────────────────────────────
function deviceOf(ua) {
  const u = String(ua || '');
  if (!u) return 'unknown';
  if (/bot|crawl|spider|slurp|preview|headless|facebookexternalhit|embedly|curl|wget|python-requests|node-fetch/i.test(u)) return 'bot';
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(u)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(u)) return 'mobile';
  return 'desktop';
}

// ── WHERE THE VISIT CAME FROM ────────────────────────────────────────────────
// A named bucket for the sources worth telling apart, the bare host for the
// rest, 'direct' for none. utm_source, when the link carried one, wins: it is
// what the person who shared the link said it was.
const SOURCES = [
  ['linkedin', /(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/],
  ['google', /(^|\.)google\.[a-z.]+$/],
  ['bing', /(^|\.)bing\.com$/],
  ['duckduckgo', /(^|\.)duckduckgo\.com$/],
  ['facebook', /(^|\.)facebook\.com$|(^|\.)fb\.me$/],
  ['instagram', /(^|\.)instagram\.com$/],
  ['x', /(^|\.)twitter\.com$|(^|\.)x\.com$|^t\.co$/],
  ['slack', /(^|\.)slack\.com$/],
  ['email', /(^|\.)mail\.google\.com$|(^|\.)outlook\.(live|office)\.com$|(^|\.)mail\.yahoo\.com$/],
  ['nildash', /(^|\.)mynildash\.com$/],
];
function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return null; }
}
function sourceOf(ref, utm) {
  const u = String(utm || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
  if (u) {
    const named = SOURCES.find(([name]) => name === u || (u === 'li' && name === 'linkedin'));
    return named ? named[0] : 'utm:' + u;
  }
  const h = hostOf(ref);
  if (!h) return 'direct';
  const hit = SOURCES.find(([, re]) => re.test(h));
  return hit ? hit[0] : h.slice(0, 80);
}

// ── COUNTRY, FROM A HEADER OR NOT AT ALL ─────────────────────────────────────
// A CDN in front of the app (Cloudflare, CloudFront, Vercel, Fastly) adds the
// visitor's country as a header; that is read and the IP never is. With no such
// header -- Railway alone adds none -- country is null rather than a lookup of
// the IP against a third-party service.
const COUNTRY_HEADERS = ['cf-ipcountry', 'cloudfront-viewer-country', 'x-vercel-ip-country',
  'fastly-client-country', 'x-country-code', 'x-appengine-country'];
function countryOf(headers) {
  const h = headers || {};
  for (const k of COUNTRY_HEADERS) {
    const v = String(h[k] || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(v) && v !== 'XX' && v !== 'T1') return v;
  }
  return null;
}

// ── ONE ROW FROM ONE REQUEST, OR NOTHING ─────────────────────────────────────
// Returns the row to write, or null when the body is not something the page
// would send.
function rowFrom(body, headers) {
  const b = body && typeof body === 'object' ? body : {};
  const session = String(b.session_id || '');
  const event = String(b.event || '');
  if (!SESSION_RE.test(session) || !EVENTS.has(event)) return null;
  const screen = b.screen == null ? null : String(b.screen).toLowerCase();
  const h = headers || {};
  return {
    session_id: session,
    event,
    screen: screen && SCREEN_RE.test(screen) ? screen : null,
    // The source only matters on the visit's first row; later rows carry none.
    referrer: event === 'view' ? sourceOf(b.ref, b.utm) : null,
    device: deviceOf(h['user-agent']),
    country: countryOf(h),
  };
}

// ── SPAM LIMITS, IN MEMORY ───────────────────────────────────────────────────
// Per session: a visit sends one view, a screen per click and a heartbeat
// every 30 seconds for at most 30 minutes, so 400 is far above any real visit.
// Overall: a ceiling on rows per minute across everyone, so a flood from many
// addresses (which the per-IP limiter in the route cannot see) still cannot
// fill the table. Both reset on their own; neither is stored.
const PER_SESSION_MAX = 400;
const GLOBAL_PER_MINUTE = parseInt(process.env.DEMO_EVENTS_PER_MINUTE, 10) || 3000;
const _sessions = new Map();     // session_id -> count, cleared hourly
let _minute = { at: 0, n: 0 };
let _sessionsAt = Date.now();

function allow(row, nowMs) {
  const now = nowMs || Date.now();
  if (now - _sessionsAt > 3600000) { _sessions.clear(); _sessionsAt = now; }
  if (now - _minute.at >= 60000) _minute = { at: now, n: 0 };
  if (_minute.n >= GLOBAL_PER_MINUTE) return false;
  const n = (_sessions.get(row.session_id) || 0) + 1;
  if (n > PER_SESSION_MAX) return false;
  _sessions.set(row.session_id, n);
  _minute.n++;
  return true;
}

// Never throws. Returns true when a row was written.
async function record(pool, body, headers, nowMs) {
  try {
    const row = rowFrom(body, headers);
    if (!row || row.device === 'bot' || !allow(row, nowMs)) return false;
    await pool.query(
      `INSERT INTO demo_events (session_id, event, screen, referrer, device, country)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.session_id, row.event, row.screen, row.referrer, row.device, row.country]);
    return true;
  } catch (e) {
    console.warn('[demo] event not recorded: ' + e.message);
    return false;
  }
}

function _reset() { _sessions.clear(); _minute = { at: 0, n: 0 }; _sessionsAt = Date.now(); }

module.exports = {
  EVENTS, deviceOf, sourceOf, countryOf, rowFrom, allow, record,
  PER_SESSION_MAX, GLOBAL_PER_MINUTE, COUNTRY_HEADERS, _reset,
};
