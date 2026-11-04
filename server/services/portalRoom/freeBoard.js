'use strict';
// ── THE FREE PORTAL BOARD (/portal-board) ───────────────────────────────────
//
// The front door. Any agent, no account: pick the player's position (and,
// if he likes, his school, the level he wants and his home state) and get
// the 10 FBS schools that need that position most, from the same board the
// Portal Room uses (board.rank on the rosters read). What it does NOT give:
// the people to call at each school, their emails, the one-pager and the
// pipeline. Those come with the 14-day trial (/try).
//
// "Email me this board" saves the agent as a lead (portal_board_leads),
// sends him the board he asked for, and tells JohnMark a lead came in. The
// weekly Portal Report goes to these leads later; nothing else is sent to
// them from here.

const P = require('./positions');
const Schools = require('./schools');

const TOP = 10;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;
const clip = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; };

let _ready = null;
function ensureTable(pool) {
  if (_ready) return _ready;
  _ready = pool.query(`CREATE TABLE IF NOT EXISTS portal_board_leads (
    id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL, name TEXT, agency TEXT, grp TEXT, current_school TEXT,
    boards INTEGER NOT NULL DEFAULT 1, unsubscribed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_board_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (email))`).catch((e) => { _ready = null; throw e; });
  return _ready;
}

// body: { group|position, currentSchool?, level?, homeState? } -> the top 10.
async function freeBoard(pool, body = {}, { now = new Date() } = {}) {
  const PR = require('./index');
  const group = P.GROUPS.includes(String(body.group || '').toUpperCase()) ? String(body.group).toUpperCase() : P.groupOf(body.position || body.group || '');
  if (!group) { const e = new Error('Pick his position.'); e.status = 400; throw e; }
  const currentSchool = Schools.canonical(body.currentSchool) || null;
  const level = ['P4', 'G5'].includes(body.level) ? body.level : 'any';
  const homeState = /^[A-Za-z]{2}$/.test(String(body.homeState || '').trim()) ? String(body.homeState).trim().toUpperCase() : null;
  // Every school scored (the agent board stops at 60), so a read room is
  // never cut for an unread one.
  const { prefs } = PR.cleanPrefs({ group, currentSchool, level, homeState, closeToHome: !!homeState });
  const [rosterRows, coaching] = await Promise.all([PR.rosters(pool), PR.Coaching.load(pool, { now })]);
  const b = { ...require('./board').rank({ group, prefs, rosters: rosterRows, coaching, limit: 500 }), valueLine: require('./value').line(group) };
  // Schools whose roster is read first: a "thinnest" list is no place for a
  // school we could not count. Unread ones fill in only if there are not 10.
  const all = [...b.dream, ...b.options];
  const ranked = all.filter((r) => r.need.rating !== 'unknown').concat(all.filter((r) => r.need.rating === 'unknown'));
  const rows = ranked.slice(0, TOP).map((r) => ({
    school: r.school, level: r.level, conference: r.conference || null, state: r.state || null, score: r.score,
    need: { rating: r.need.rating, on: r.need.on, leaving: r.need.leaving, back: r.need.back, median: r.need.median, noYears: !!r.need.noYears, line: r.need.line },
    coachingChange: !!r.coachingChange,
  }));
  return {
    group, groupLabel: P.LABEL[group], currentSchool, level, homeState, rows,
    rostersRead: b.rostersRead, totalSchools: b.totalSchools, medianFrom: b.medianFrom, valueLine: b.valueLine || null,
  };
}

function boardEmail({ name, board }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const base = (process.env.APP_URL || 'https://mynildash.com').replace(/\/$/, '');
  const lines = [`Hi ${first},`, '', `Here is your Portal Board: the FBS schools thinnest at ${board.group} right now, from ${board.rostersRead} of ${board.totalSchools} rosters read.`, ''];
  board.rows.forEach((r, i) => {
    const room = r.need.rating === 'unknown' ? 'roster not read yet' : `${r.need.leaving} of ${r.need.on} seniors or older`;
    lines.push(`${i + 1}. ${r.school} (${r.level}): fit ${r.score}, ${room}${r.coachingChange ? ', new head coach coming' : ''}`);
  });
  lines.push('', 'The people to call at each school, their published emails, a one-pager that shows you which schools open it, and the offers side by side come with the Portal Room.',
    `Try it free for 14 days: ${base}/try`, '', 'JohnMark Compton', 'Founder, NILDash', '',
    'You got this because you asked for this board at mynildash.com/portal-board. Reply "stop" and you will not hear from us again.',
    'Compton Group LLC, 3796 Turnberry Court, Duluth, GA 30096');
  return { subject: `Your Portal Board: ${board.group}`, text: lines.join('\n') };
}

async function _send(msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('../resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: process.env.PORTAL_BOARD_FROM || 'JohnMark at NILDash <noreply@mynildash.com>', reply_to: process.env.PORTAL_BOARD_REPLY_TO || 'john@comptongroupllc.com', to: msg.to, subject: msg.subject, text: msg.text });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// body: { email, name?, agency?, group|position, currentSchool?, level?, homeState? }
async function emailBoard(pool, body = {}, deps = {}) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 160) { const e = new Error('Enter a real email address.'); e.status = 400; throw e; }
  if (body.website) return { ok: true };            // the form's hidden field: a bot filled it
  await ensureTable(pool);
  const board = await freeBoard(pool, body, deps);
  const name = clip(body.name, 80), agency = clip(body.agency, 120);
  const r = await pool.query(`INSERT INTO portal_board_leads (email, name, agency, grp, current_school) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, portal_board_leads.name), agency = COALESCE(EXCLUDED.agency, portal_board_leads.agency),
      grp = EXCLUDED.grp, current_school = EXCLUDED.current_school, boards = portal_board_leads.boards + 1, last_board_at = NOW()
    RETURNING id, boards, unsubscribed`, [email, name, agency, board.group, board.currentSchool]);
  const lead = r.rows[0];
  const send = deps.send || _send;
  if (!lead.unsubscribed) {
    try { await send({ to: email, ...boardEmail({ name, board }) }); } catch (e) { console.error('[portal/free-board] email:', e.message); const x = new Error('The board could not be emailed right now. It is on the page above.'); x.status = 502; throw x; }
  }
  // Tell JohnMark a lead came in.
  try {
    await send({ to: process.env.PORTAL_LEAD_ALERT_TO || 'john@comptongroupllc.com', subject: `Portal Board lead: ${name || email}${agency ? ', ' + agency : ''}`,
      text: `${name || '(no name)'}${agency ? ' at ' + agency : ''} <${email}> asked for a ${board.group} board${board.currentSchool ? ' (player at ' + board.currentSchool + ')' : ''}. Board number ${lead.boards} from this address.` });
  } catch (_) { /* the lead is saved either way */ }
  return { ok: true, emailed: !lead.unsubscribed };
}

module.exports = { freeBoard, emailBoard, boardEmail, ensureTable, TOP };
