'use strict';
// ── THE BRAND MARKETPLACE (/brands) ─────────────────────────────────────────
//
// The other side of NILDash. NILDash finds local businesses for an agent's
// athletes; here a local business comes to us. It says what it wants from a
// local athlete (which schools nearby, which sports, what the athlete would
// do, a budget), and every agent with an athlete who fits gets it by email
// that day, with a reply-to straight to the business. No account for the
// business; an emailed link confirms it is real before anything goes out.
//
// THE FLOW
//   submit()   the form at /brands. Saved as 'pending'; the business gets a
//              confirm link; JohnMark is told a request came in.
//   confirm()  the link. The request goes 'live' for 60 days and is matched
//              at once (match + notify). The business is told how many agents
//              got it.
//   tick()     once a day: live requests are matched again, so an athlete
//              added since reaches the business too. Expired ones close.
//   close()    the business's own link in its emails ends the request.
//
// WHO GETS IT. An athlete fits when his school is one the business picked
// (the Department of Education directory, services/usColleges) or within
// RADIUS_MI of one, and his sport is one it picked (any, if none). Each agent
// gets one email per request, naming his athletes who fit. Never the hidden
// samples account; never an agent who turned these off.
//
// Off with BRAND_MARKET=off (the page still shows; nothing is saved or sent).

const crypto = require('crypto');
const U = require('./usColleges');

const RADIUS_MI = 30;
const LIVE_DAYS = 60;
const MAX_SCHOOLS = 3;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;
const on = () => String(process.env.BRAND_MARKET || '').toLowerCase() !== 'off';
const BASE = () => (process.env.APP_URL || 'https://mynildash.com').replace(/\/$/, '');
const clip = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; };
const tok = () => crypto.randomBytes(18).toString('base64url');
const centralHour = (now) => parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(now), 10);

const SPORTS = ['football', 'basketball', 'baseball', 'softball', 'soccer', 'volleyball', 'track', 'golf', 'tennis', 'swimming', 'wrestling', 'lacrosse', 'hockey', 'cheer', 'gymnastics', 'cross country', 'other'];
const DOES = ['social post', 'appearance', 'event', 'autograph signing', 'ad or commercial', 'ongoing ambassador', 'camp or lesson', 'other'];
const BUDGETS = ['under $250', '$250 to $1,000', '$1,000 to $5,000', '$5,000 and up', 'products or services, not cash', 'not sure yet'];
const secret = () => process.env.SESSION_SECRET || process.env.PORTAL_ALERT_SECRET || 'nildash-brand-market';
const optSig = (agentId) => crypto.createHmac('sha256', secret()).update('brand-market-off:' + agentId).digest('hex').slice(0, 32);
const optOutUrl = (agentId) => `${BASE()}/brands/off?a=${encodeURIComponent(agentId)}&s=${optSig(agentId)}`;

let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS brand_requests (
      id BIGSERIAL PRIMARY KEY, token TEXT NOT NULL UNIQUE, business TEXT NOT NULL, contact_name TEXT, email TEXT NOT NULL,
      phone TEXT, website TEXT, category TEXT, schools JSONB NOT NULL DEFAULT '[]', sports JSONB NOT NULL DEFAULT '[]',
      does JSONB NOT NULL DEFAULT '[]', budget TEXT, details TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), confirmed_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
      agents_sent INTEGER NOT NULL DEFAULT 0, last_matched_at TIMESTAMPTZ)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS brand_requests_status ON brand_requests (status)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS brand_request_sends (
      request_id BIGINT NOT NULL, agent_id TEXT NOT NULL, athlete_ids JSONB NOT NULL DEFAULT '[]', sent_at TIMESTAMPTZ, error TEXT,
      PRIMARY KEY (request_id, agent_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS brand_market_optout (agent_id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

// ── SCHOOLS ─────────────────────────────────────────────────────────────────
// The type-ahead on the form: colleges in the directory whose name holds every
// word typed, four-year first. -> [{ name, city, state }]
let _raw = null;
function raw() { if (!_raw) _raw = require('../data/usColleges'); return _raw; }
function schoolSearch(q, limit = 10) {
  const words = U.key(q).split(' ').filter((w) => w.length > 1);
  if (!words.length) return [];
  const out = [];
  for (const r of raw()) {
    const k = U.key(r[0]) + ' ' + U.key(r[1]);
    if (words.every((w) => k.includes(w))) out.push({ name: r[0], city: r[1], state: r[2], level: r[7] });
  }
  out.sort((a, b) => (a.level - b.level) || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return out.slice(0, limit).map(({ name, city, state }) => ({ name, city, state }));
}
// An exact directory row by name (and state): the form sends what the
// type-ahead showed.
function schoolRow(name, state) {
  const n = String(name || '').trim().toLowerCase();
  const st = String(state || '').trim().toUpperCase();
  const r = raw().find((x) => x[0].toLowerCase() === n && (!st || x[2] === st));
  return r ? { name: r[0], city: r[1], state: r[2], lat: r[4], lon: r[5] } : null;
}

const toRad = (d) => (d * Math.PI) / 180;
function miles(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const R = 3958.8, dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Where an athlete's school is, from the directory: the full name, or the
// resolver's answer (city, state) matched to a directory school there.
const _athLoc = new Map();
function athleteSchool(school) {
  const s = String(school || '').replace(/\(.*?\)/g, '').trim();
  if (!s) return null;
  if (_athLoc.has(s)) return _athLoc.get(s);
  let out = null;
  const d = U.find(s);
  if (d) out = { name: d.name, city: d.city, state: d.state, lat: d.lat, lon: d.lon };
  else {
    try {
      const r = require('./schoolResolver').resolveSchool(s);
      const st = r && r.state && r.state.length === 2 ? r.state.toUpperCase() : null;
      if (r && st) {
        const row = raw().find((x) => x[2] === st && U.key(x[1]) === U.key(r.city));
        out = { name: s, city: r.city, state: st, lat: row ? row[4] : null, lon: row ? row[5] : null };
      }
    } catch (_) { /* no resolver: no location */ }
  }
  _athLoc.set(s, out);
  return out;
}
function sportFits(want, sport) {
  if (!want || !want.length) return true;
  const s = String(sport || '').toLowerCase();
  return want.some((w) => w === 'other' ? true : (w === 'track' ? /track|cross country/.test(s) : w === 'hockey' ? /hockey/.test(s) : s.includes(w)));
}

// ── SUBMIT AND CONFIRM ──────────────────────────────────────────────────────
function fail(msg) { const e = new Error(msg); e.status = 400; return e; }
function pick(list, allowed) { return [...new Set((Array.isArray(list) ? list : [list]).map((x) => String(x || '').toLowerCase().trim()).filter((x) => allowed.includes(x)))]; }

async function submit(pool, body = {}, deps = {}) {
  if (body.website_url) return { ok: true };                        // the hidden field: a bot filled it
  if (!on()) throw Object.assign(new Error('The marketplace is closed for a moment. Try again later.'), { status: 503 });
  const email = String(body.email || '').trim().toLowerCase();
  const business = clip(body.business, 120);
  if (!business) throw fail('Add your business name.');
  if (!EMAIL.test(email) || email.length > 160) throw fail('Enter a real email address.');
  const schools = (Array.isArray(body.schools) ? body.schools : []).slice(0, MAX_SCHOOLS)
    .map((s) => schoolRow(s && s.name, s && s.state)).filter(Boolean);
  if (!schools.length) throw fail('Pick at least one school near you.');
  const sports = pick(body.sports, SPORTS);
  const does = pick(body.does, DOES);
  const budget = BUDGETS.includes(String(body.budget || '')) ? String(body.budget) : 'not sure yet';
  const details = clip(body.details, 800);
  if (!details || details.length < 15) throw fail('Tell agents in a sentence or two what you want the athlete to do.');
  await ensureTables(pool);
  const recent = (await pool.query(`SELECT COUNT(*)::int AS n FROM brand_requests WHERE email = $1 AND created_at > NOW() - INTERVAL '1 day'`, [email])).rows[0].n;
  if (recent >= 3) throw fail('You have posted three requests today. Reply to one of our emails if you need more.');
  const token = tok();
  const r = await pool.query(
    `INSERT INTO brand_requests (token, business, contact_name, email, phone, website, category, schools, sports, does, budget, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [token, business, clip(body.name, 80), email, clip(body.phone, 30), clip(body.site, 160), clip(body.category, 60),
      JSON.stringify(schools.map(({ name, city, state }) => ({ name, city, state }))), JSON.stringify(sports), JSON.stringify(does), budget, details]);
  const send = deps.send || _send;
  const first = String(body.name || '').trim().split(/\s+/)[0] || 'there';
  await send({ to: email, subject: 'Confirm your request on NILDash', text: [
    `Hi ${first},`, '',
    `Confirm your request and it goes to the sports agents who represent athletes at ${schools.map((s) => s.name).join(', ')}:`,
    `${BASE()}/brands/confirm/${token}`, '',
    'Agents reply to you directly. You decide who to work with. NILDash takes no cut.', '',
    'JohnMark Compton', 'Founder, NILDash', '',
    'You got this because this address was entered at mynildash.com/brands. If that was not you, ignore it and nothing is sent.',
    'Compton Group LLC, 3796 Turnberry Court, Duluth, GA 30096'].join('\n') });
  try {
    await send({ to: process.env.PORTAL_LEAD_ALERT_TO || 'john@comptongroupllc.com', subject: `Brand request: ${business}`,
      text: `${business}${body.name ? ' (' + clip(body.name, 80) + ')' : ''} <${email}> wants: ${details}\nSchools: ${schools.map((s) => s.name).join(', ')}\nSports: ${sports.join(', ') || 'any'}\nBudget: ${budget}\nIt goes out once they confirm.` });
  } catch (_) { /* saved either way */ }
  return { ok: true, id: r.rows[0].id };
}

async function confirm(pool, token, deps = {}) {
  await ensureTables(pool);
  const r = await pool.query(
    `UPDATE brand_requests SET status = 'live', confirmed_at = NOW(), expires_at = NOW() + ($2 || ' days')::interval
      WHERE token = $1 AND status = 'pending' RETURNING *`, [String(token || ''), String(LIVE_DAYS)]);
  let req = r.rows[0];
  if (!req) {
    req = (await pool.query(`SELECT * FROM brand_requests WHERE token = $1`, [String(token || '')])).rows[0];
    return req ? { ok: true, already: true, status: req.status, agents: req.agents_sent, business: req.business } : { ok: false };
  }
  const m = await matchAndNotify(pool, req, deps);
  const send = deps.send || _send;
  const first = String(req.contact_name || '').trim().split(/\s+/)[0] || 'there';
  const where = (req.schools || []).map((s) => s.name).join(', ');
  try {
    await send({ to: req.email, subject: m.agents ? `Your request went to ${m.agents} agent${m.agents === 1 ? '' : 's'}` : 'Your request is live on NILDash', text: [
      `Hi ${first},`, '',
      m.agents
        ? `It went to ${m.agents} agent${m.agents === 1 ? '' : 's'} representing ${m.athletes} athlete${m.athletes === 1 ? '' : 's'} at or near ${where}. They will reply to this address.`
        : `No agent on NILDash represents an athlete near ${where} yet. Your request stays live for ${LIVE_DAYS} days, and it goes out the day one does.`,
      '', `Done looking? End it here: ${BASE()}/brands/close/${req.token}`, '',
      'JohnMark Compton', 'Founder, NILDash', '', 'Compton Group LLC, 3796 Turnberry Court, Duluth, GA 30096'].join('\n') });
  } catch (e) { console.error('[brands] confirm email:', e.message); }
  return { ok: true, status: 'live', agents: m.agents, athletes: m.athletes, business: req.business };
}

async function close(pool, token) {
  await ensureTables(pool);
  const r = await pool.query(`UPDATE brand_requests SET status = 'closed', closed_at = NOW() WHERE token = $1 AND status IN ('pending','live') RETURNING business`, [String(token || '')]);
  return r.rows[0] ? { ok: true, business: r.rows[0].business } : { ok: false };
}

// ── MATCH AND NOTIFY ────────────────────────────────────────────────────────
// -> { agents, athletes }: the agents newly emailed for this request.
async function matchAndNotify(pool, req, deps = {}) {
  if (!on()) return { agents: 0, athletes: 0 };
  await ensureTables(pool);
  const want = (req.schools || []).map((s) => schoolRow(s.name, s.state) || s);
  const sports = req.sports || [];
  const rows = (await pool.query(
    `SELECT a.id, a.agent_id, a.data->>'name' AS name, a.data->>'school' AS school, a.data->>'sport' AS sport,
            u.email AS agent_email, u.name AS agent_name
       FROM athletes a JOIN users u ON u.id = a.agent_id
      WHERE COALESCE(u.email,'') NOT LIKE '%@mynildash.invalid'
        AND COALESCE(a.data->>'archived','false') <> 'true'
        AND NOT EXISTS (SELECT 1 FROM brand_market_optout o WHERE o.agent_id = a.agent_id)
        AND NOT EXISTS (SELECT 1 FROM brand_request_sends s WHERE s.request_id = $1 AND s.agent_id = a.agent_id)`, [req.id])).rows;
  const byAgent = new Map();
  for (const a of rows) {
    if (!a.agent_email || !sportFits(sports, a.sport)) continue;
    const loc = athleteSchool(a.school);
    if (!loc) continue;
    const near = want.some((w) => (w.name && loc.name && U.key(w.name) === U.key(loc.name))
      || miles(w, loc) <= RADIUS_MI
      || (w.lat == null && U.key(w.city) === U.key(loc.city) && w.state === loc.state));
    if (!near) continue;
    if (!byAgent.has(a.agent_id)) byAgent.set(a.agent_id, { agentId: a.agent_id, email: a.agent_email, name: a.agent_name, athletes: [] });
    byAgent.get(a.agent_id).athletes.push({ id: a.id, name: a.name || 'Your athlete', school: a.school, sport: a.sport });
  }
  const send = deps.send || _send;
  let agents = 0, athletes = 0;
  for (const g of byAgent.values()) {
    const claim = await pool.query(`INSERT INTO brand_request_sends (request_id, agent_id, athlete_ids) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING agent_id`,
      [req.id, g.agentId, JSON.stringify(g.athletes.map((x) => x.id))]);
    if (!claim.rows.length) continue;
    try {
      await send({ ...agentEmail(req, g), to: g.email, replyTo: req.email });
      await pool.query(`UPDATE brand_request_sends SET sent_at = NOW() WHERE request_id = $1 AND agent_id = $2`, [req.id, g.agentId]);
      agents++; athletes += g.athletes.length;
    } catch (e) {
      await pool.query(`UPDATE brand_request_sends SET error = $3 WHERE request_id = $1 AND agent_id = $2`, [req.id, g.agentId, String(e.message).slice(0, 300)]);
    }
  }
  await pool.query(`UPDATE brand_requests SET agents_sent = agents_sent + $2, last_matched_at = NOW() WHERE id = $1`, [req.id, agents]);
  return { agents, athletes };
}

function agentEmail(req, g) {
  const first = String(g.name || '').trim().split(/\s+/)[0] || 'there';
  const where = (req.schools || []).map((s) => s.name).join(', ');
  const who = g.athletes.slice(0, 6).map((a) => `- ${a.name}${a.sport ? ', ' + a.sport : ''}${a.school ? ', ' + a.school : ''}`);
  const lines = [`Hi ${first},`, '',
    `${req.business}${req.category ? ' (' + req.category + ')' : ''} is looking for ${req.sports && req.sports.length ? req.sports.join(' or ') + ' ' : ''}athletes at or near ${where}.`, '',
    `What they want: ${req.details}`];
  if (req.does && req.does.length) lines.push(`The athlete would do: ${req.does.join(', ')}`);
  lines.push(`Budget: ${req.budget || 'not sure yet'}`, '', `Your athlete${g.athletes.length === 1 ? '' : 's'} who fit:`, ...who, '',
    `Reply to this email and it goes straight to ${req.contact_name || req.business}${req.phone ? ', or call ' + req.phone : ''}.`, '',
    'NILDash', '', `You get these because you have athletes on NILDash near this business. Turn them off: ${optOutUrl(g.agentId)}`);
  return { subject: `A local business wants your athlete: ${req.business}`, text: lines.join('\n') };
}

async function optOut(pool, agentId, sig) {
  const a = String(agentId || '');
  if (!a || !sig || String(sig).length !== 32 || !crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(optSig(a)))) return false;
  await ensureTables(pool);
  await pool.query(`INSERT INTO brand_market_optout (agent_id) VALUES ($1) ON CONFLICT DO NOTHING`, [a]);
  return true;
}

// Once a day (10am Central): live requests reach athletes added since; old
// ones close.
async function tick(pool, { now = new Date(), deps = {} } = {}) {
  if (!on()) return { skipped: 'off' };
  if (centralHour(now) !== 10 && !deps.force) return { skipped: 'not the hour' };
  await ensureTables(pool);
  await pool.query(`UPDATE brand_requests SET status = 'closed', closed_at = NOW() WHERE status = 'live' AND expires_at < NOW()`);
  const live = (await pool.query(`SELECT * FROM brand_requests WHERE status = 'live' AND (last_matched_at IS NULL OR last_matched_at < NOW() - INTERVAL '20 hours')`)).rows;
  let agents = 0;
  for (const req of live) agents += (await matchAndNotify(pool, req, deps)).agents;
  return { live: live.length, agents };
}

async function list(pool) {
  await ensureTables(pool);
  return (await pool.query(`SELECT id, business, contact_name, email, schools, sports, budget, details, status, created_at, confirmed_at, expires_at, agents_sent
                              FROM brand_requests ORDER BY id DESC LIMIT 200`)).rows;
}

async function _send(msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: process.env.PORTAL_BOARD_FROM || 'JohnMark at NILDash <noreply@mynildash.com>',
    reply_to: msg.replyTo || process.env.PORTAL_BOARD_REPLY_TO || 'john@comptongroupllc.com', to: msg.to, subject: msg.subject, text: msg.text });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

const meta = () => ({ sports: SPORTS, does: DOES, budgets: BUDGETS, maxSchools: MAX_SCHOOLS, radiusMi: RADIUS_MI, liveDays: LIVE_DAYS });

module.exports = { submit, confirm, close, matchAndNotify, tick, list, optOut, optOutUrl, schoolSearch, schoolRow, athleteSchool, miles, sportFits, agentEmail, meta, ensureTables, on, RADIUS_MI };
