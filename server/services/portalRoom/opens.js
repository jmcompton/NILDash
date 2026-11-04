'use strict';
// ── WHO OPENED HIS ONE-PAGER ────────────────────────────────────────────────
//
// Every email the Portal Room writes to a school carries that school's own
// link to the player's one-pager: /portal-profile/<profile token>?s=<link>.
// When someone at the school opens it, the agent knows:
//   - the school's card says "Opened 3x" with when;
//   - the first open of a day goes in the school's activity, and a school
//     still at Target or Contacted moves to Interested (logged);
//   - the agent gets one email per school per day: "Baylor opened Jordan's
//     one-pager".
//
// WHAT COUNTS AS AN OPEN. The page loads the player's details first and only
// reports a view after it has been on screen for a moment (views/
// portal-profile.html), so link checkers that fetch a page without showing
// it are not counted. Also not counted: known bots and mail scanners by
// their user agent, the agent himself (signed in), and the same viewer again
// within 30 minutes. A scanner that runs the page like a person could still
// count once; the page says opens, not reads.

const crypto = require('crypto');

const BOT = /bot\b|bot\/|crawl|spider|slurp|preview|scanner|safelinks|proofpoint|mimecast|barracuda|headless|phantom|python|curl|wget|java\/|okhttp|go-http|axios|node-fetch|facebookexternalhit|linkedin|slack|discord|whatsapp|telegram|skypeuripreview|microsoft office|bingpreview|google-read-aloud|googleimageproxy/i;
const DEDUPE_MIN = 30;
const chicagoDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d || new Date());
const TOKEN = /^[a-f0-9]{16}$/;

let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS portal_profile_links (
      token TEXT PRIMARY KEY, agent_id TEXT NOT NULL, athlete_id TEXT NOT NULL, target_id TEXT NOT NULL, school TEXT NOT NULL,
      opens INTEGER NOT NULL DEFAULT 0, first_open_at TIMESTAMPTZ, last_open_at TIMESTAMPTZ, last_alert_on DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (agent_id, athlete_id, target_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS portal_profile_opens (
      id BIGSERIAL PRIMARY KEY, token TEXT NOT NULL, viewer TEXT, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_portal_profile_opens_token ON portal_profile_opens (token, at DESC)`);
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

// The school's own link token, made once per school on his list.
async function linkFor(pool, agentId, athleteId, target) {
  await ensureTables(pool);
  const token = crypto.randomBytes(8).toString('hex');
  const r = await pool.query(`INSERT INTO portal_profile_links (token, agent_id, athlete_id, target_id, school) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (agent_id, athlete_id, target_id) DO UPDATE SET school = EXCLUDED.school RETURNING token`,
  [token, agentId, athleteId, String(target.id), target.school]);
  return r.rows[0].token;
}

function viewerHash(ip, ua, now) {
  return crypto.createHash('sha256').update(`${ip || ''}|${ua || ''}|${chicagoDay(now)}`).digest('hex').slice(0, 32);
}

// A view of the page, reported by the page once it has been on screen.
// -> { counted, reason?, school?, opens? }
async function recordOpen(pool, store, { profileToken, linkToken, viewerUserId = null, ua = '', ip = '', now = new Date() }, deps = {}) {
  await ensureTables(pool);
  if (!/^[a-f0-9]{24}$/.test(String(profileToken || ''))) return { counted: false, reason: 'not found' };
  const T = require('./targets');
  await T.ensureTables(pool);
  const prof = (await pool.query(`SELECT agent_id, athlete_id, live FROM portal_profiles WHERE token = $1`, [profileToken])).rows[0];
  if (!prof || !prof.live) return { counted: false, reason: 'not found' };
  if (viewerUserId && String(viewerUserId) === String(prof.agent_id)) return { counted: false, reason: 'own view' };
  if (!ua || BOT.test(ua)) return { counted: false, reason: 'bot' };
  let link = null;
  if (linkToken && TOKEN.test(String(linkToken))) {
    link = (await pool.query(`SELECT * FROM portal_profile_links WHERE token = $1 AND agent_id = $2 AND athlete_id = $3`, [linkToken, prof.agent_id, prof.athlete_id])).rows[0] || null;
  }
  const key = link ? link.token : 'p:' + profileToken;
  const viewer = viewerHash(ip, ua, now);
  const recent = await pool.query(`SELECT 1 FROM portal_profile_opens WHERE token = $1 AND viewer = $2 AND at > $3::timestamptz - INTERVAL '${DEDUPE_MIN} minutes' LIMIT 1`, [key, viewer, now.toISOString()]);
  if (recent.rows.length) return { counted: false, reason: 'seen just now' };
  await pool.query(`INSERT INTO portal_profile_opens (token, viewer, at) VALUES ($1,$2,$3)`, [key, viewer, now.toISOString()]);
  await pool.query(`UPDATE portal_profiles SET views = views + 1, last_viewed_at = $2 WHERE token = $1`, [profileToken, now.toISOString()]).catch(() => {});
  if (!link) return { counted: true };

  const firstToday = !link.last_open_at || chicagoDay(new Date(link.last_open_at)) !== chicagoDay(now);
  const u = (await pool.query(`UPDATE portal_profile_links SET opens = opens + 1, first_open_at = COALESCE(first_open_at, $2), last_open_at = $2
    WHERE token = $1 RETURNING opens`, [link.token, now.toISOString()])).rows[0];
  // The card: logged once a day, and moved along if it was still early.
  let moved = null;
  if (firstToday) moved = await T.recordOpenActivity(pool, prof.agent_id, prof.athlete_id, link.target_id, link.school).catch(() => null);
  // The agent: one email per school per day.
  let alerted = false;
  const today = chicagoDay(now);
  const claim = await pool.query(`UPDATE portal_profile_links SET last_alert_on = $2 WHERE token = $1 AND (last_alert_on IS NULL OR last_alert_on < $2::date) RETURNING token`, [link.token, today]);
  if (claim.rows.length) {
    try {
      const agent = await store.getUser(prof.agent_id);
      const athlete = await store.getAthlete(prof.athlete_id);
      if (agent && agent.email) {
        const msg = alertEmail({ agent, athlete, school: link.school, opens: u.opens, athleteId: prof.athlete_id, moved });
        await (deps.sendAlert || sendAlert)({ to: agent.email, ...msg });
        alerted = true;
      }
    } catch (e) { console.error('[portal/opens] alert:', e.message); }
  }
  return { counted: true, school: link.school, opens: u.opens, moved: moved ? moved.stage : null, alerted };
}

function alertEmail({ agent, athlete, school, opens, athleteId, moved }) {
  const first = String((agent && agent.name) || '').trim().split(/\s+/)[0] || 'there';
  const who = (athlete && athlete.name) || 'your client';
  const base = (process.env.APP_URL || 'https://mynildash.com').replace(/\/$/, '');
  const url = `${base}/portal-room?a=${encodeURIComponent(athleteId)}`;
  const subject = `${school} opened ${who}'s one-pager`;
  const lines = [
    `Hi ${first},`, '',
    `Someone at ${school} just opened ${who}'s one-pager${opens > 1 ? ` (${opens} opens so far)` : ''}.${moved ? ' The school moved to Interested on his board.' : ''}`, '',
    'A good time to follow up while it is fresh:', url, '', 'NILDash',
  ];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<p>Hi ${esc(first)},</p><p>Someone at ${esc(school)} just opened ${esc(who)}'s one-pager${opens > 1 ? ` (${opens} opens so far)` : ''}.${moved ? ' The school moved to Interested on his board.' : ''}</p>`
    + `<p><a href="${esc(url)}">Open his board</a> and follow up while it is fresh.</p><p>NILDash</p>`;
  return { subject, text: lines.join('\n'), html };
}

async function sendAlert(msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('../resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>', to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// targetId -> { opens, firstOpenAt, lastOpenAt } for the workspace.
async function opensFor(pool, agentId, athleteId) {
  await ensureTables(pool);
  const r = await pool.query(`SELECT target_id, opens, first_open_at, last_open_at FROM portal_profile_links WHERE agent_id = $1 AND athlete_id = $2 AND opens > 0`, [agentId, athleteId]);
  const m = {};
  for (const x of r.rows) m[x.target_id] = { opens: x.opens, firstOpenAt: x.first_open_at, lastOpenAt: x.last_open_at };
  return m;
}

module.exports = { ensureTables, linkFor, recordOpen, opensFor, alertEmail, viewerHash, BOT, DEDUPE_MIN };
