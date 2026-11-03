'use strict';
// ── THE TARGET LIST AND THE PLAYER ONE-PAGER ────────────────────────────────
//
// The hardest job in the portal is getting a player in front of the right
// schools fast. Two pieces:
//
//   ONE-PAGER   a clean public page for the player (/portal-profile/<token>):
//               position, school, size, the numbers, film, seasons left,
//               what his position pays, and how to reach his agent. The token
//               is random and the agent can turn the page off at any time.
//               No contact details for the player himself, ever.
//   TARGETS     the schools the agent is working, each with where it stands
//               (target, contacted, replied, interested, visit, offer, passed),
//               the next step, and an email draft to that school's people with
//               the one-pager link. NILDash writes the email; the agent sends
//               it from his own mailbox. Nothing is sent from here.
//
// Agent data, scoped to the agent and his own athlete in every query.

const crypto = require('crypto');
const Schools = require('./schools');
const P = require('./positions');

const STAGES = ['target', 'contacted', 'replied', 'interested', 'visit', 'offer', 'passed'];
const STAGE_LABEL = { target: 'Target', contacted: 'Contacted', replied: 'Replied', interested: 'Interested', visit: 'Visit set', offer: 'Offer in', passed: 'Passed' };

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
const clip = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));
const httpUrl = (u) => { const s = clip(u, 500); return s && /^https?:\/\/[^\s<>"']+$/i.test(s) ? s : null; };

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS portal_targets (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, athlete_id TEXT NOT NULL, school TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'target', next_step TEXT, notes TEXT, last_touch_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, athlete_id, school))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS portal_profiles (
    agent_id TEXT NOT NULL, athlete_id TEXT NOT NULL, token TEXT UNIQUE, live BOOLEAN DEFAULT TRUE,
    data JSONB NOT NULL DEFAULT '{}'::jsonb, views INT DEFAULT 0, last_viewed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (agent_id, athlete_id))`);
}

// ── TARGETS ─────────────────────────────────────────────────────────────────
function shapeT(r) {
  return { id: r.id, school: r.school, stage: r.stage, stageLabel: STAGE_LABEL[r.stage] || r.stage, nextStep: r.next_step, notes: r.notes, lastTouchAt: r.last_touch_at, updatedAt: r.updated_at };
}

async function listTargets(pool, agentId, athleteId) {
  await ensureTables(pool);
  const r = await pool.query(`SELECT * FROM portal_targets WHERE agent_id = $1 AND athlete_id = $2`, [agentId, athleteId]);
  const order = (s) => (s === 'passed' ? 99 : STAGES.length - STAGES.indexOf(s));
  return r.rows.map(shapeT).sort((a, b) => order(a.stage) - order(b.stage) || a.school.localeCompare(b.school));
}

async function addTarget(pool, agentId, athleteId, { school } = {}) {
  await ensureTables(pool);
  const s = Schools.canonical(school);
  if (!s) throw bad('Pick an FBS school.');
  const n = await pool.query(`SELECT COUNT(*)::int n FROM portal_targets WHERE agent_id = $1 AND athlete_id = $2`, [agentId, athleteId]);
  if (n.rows[0].n >= 60) throw bad('60 schools is the most one list holds.');
  const id = 'pt_' + crypto.randomBytes(9).toString('hex');
  const r = await pool.query(`INSERT INTO portal_targets (id, agent_id, athlete_id, school) VALUES ($1,$2,$3,$4)
    ON CONFLICT (agent_id, athlete_id, school) DO UPDATE SET updated_at = portal_targets.updated_at RETURNING *`, [id, agentId, athleteId, s]);
  return shapeT(r.rows[0]);
}

async function updateTarget(pool, agentId, athleteId, id, b = {}) {
  await ensureTables(pool);
  const sets = [], vals = [String(id), agentId, athleteId];
  if (b.stage !== undefined) {
    if (!STAGES.includes(b.stage)) throw bad('Unknown stage.');
    vals.push(b.stage); sets.push(`stage = $${vals.length}`);
    // Any move past "target" is a touch.
    if (b.stage !== 'target') sets.push('last_touch_at = NOW()');
  }
  if (b.nextStep !== undefined) { vals.push(clip(b.nextStep, 200)); sets.push(`next_step = $${vals.length}`); }
  if (b.notes !== undefined) { vals.push(clip(b.notes, 1000)); sets.push(`notes = $${vals.length}`); }
  if (!sets.length) throw bad('Nothing to change.');
  const r = await pool.query(`UPDATE portal_targets SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND agent_id = $2 AND athlete_id = $3 RETURNING *`, vals);
  if (!r.rows[0]) throw bad('Target not found', 404);
  return shapeT(r.rows[0]);
}

async function removeTarget(pool, agentId, athleteId, id) {
  await ensureTables(pool);
  const r = await pool.query(`DELETE FROM portal_targets WHERE id = $1 AND agent_id = $2 AND athlete_id = $3`, [String(id), agentId, athleteId]);
  if (!r.rowCount) throw bad('Target not found', 404);
  return { ok: true };
}

// ── THE ONE-PAGER ───────────────────────────────────────────────────────────
// What an agent fills in. Everything is optional except that it is his athlete.
function cleanProfile(b = {}) {
  return {
    heightWeight: clip(b.heightWeight, 40),
    classYear: clip(b.classYear, 40),
    statsLine: clip(b.statsLine, 300),
    highlights: (Array.isArray(b.highlights) ? b.highlights : String(b.highlights || '').split('\n')).map((x) => clip(x, 160)).filter(Boolean).slice(0, 6),
    filmUrl: httpUrl(b.filmUrl),
    statsUrl: httpUrl(b.statsUrl),
    hometown: clip(b.hometown, 80),
    // Seasons left is worked out from his private dates; shown only if the
    // agent says so.
    showSeasonsLeft: !!b.showSeasonsLeft,
    agentPhone: clip(b.agentPhone, 30),
    agentEmail: /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(String(b.agentEmail || '').trim()) ? String(b.agentEmail).trim().slice(0, 120) : null,
    note: clip(b.note, 400),
  };
}

async function getProfile(pool, agentId, athleteId) {
  await ensureTables(pool);
  const r = await pool.query(`SELECT token, live, data, views, last_viewed_at FROM portal_profiles WHERE agent_id = $1 AND athlete_id = $2`, [agentId, athleteId]);
  const x = r.rows[0];
  return x ? { token: x.token, live: x.live, data: x.data, views: x.views, lastViewedAt: x.last_viewed_at } : { token: null, live: false, data: {}, views: 0 };
}

async function saveProfile(pool, agentId, athleteId, body = {}) {
  await ensureTables(pool);
  const data = cleanProfile(body);
  const token = crypto.randomBytes(12).toString('hex');
  const live = body.live === undefined ? true : !!body.live;
  const r = await pool.query(`INSERT INTO portal_profiles (agent_id, athlete_id, token, live, data) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (agent_id, athlete_id) DO UPDATE SET data = EXCLUDED.data, live = EXCLUDED.live, updated_at = NOW()
    RETURNING token, live, data, views`, [agentId, athleteId, token, live, JSON.stringify(data)]);
  return { token: r.rows[0].token, live: r.rows[0].live, data: r.rows[0].data, views: r.rows[0].views };
}

// A new link: the old one stops working at once.
async function rotateToken(pool, agentId, athleteId) {
  await ensureTables(pool);
  const token = crypto.randomBytes(12).toString('hex');
  const r = await pool.query(`UPDATE portal_profiles SET token = $3, updated_at = NOW() WHERE agent_id = $1 AND athlete_id = $2 RETURNING token`, [agentId, athleteId, token]);
  if (!r.rows[0]) throw bad('Make the one-pager first.', 404);
  return { token };
}

// The public view, by token. Only what the page shows; nothing else leaves.
async function publicProfile(pool, store, token, { countView = false } = {}) {
  if (!/^[a-f0-9]{24}$/.test(String(token || ''))) return null;
  await ensureTables(pool);
  const r = await pool.query(`SELECT agent_id, athlete_id, data, live FROM portal_profiles WHERE token = $1`, [token]);
  const x = r.rows[0];
  if (!x || !x.live) return null;
  const athlete = await store.getAthlete(x.athlete_id);
  if (!athlete || athlete.agentId !== x.agent_id) return null;
  const agent = await store.getUser(x.agent_id);
  if (countView) await pool.query(`UPDATE portal_profiles SET views = views + 1, last_viewed_at = NOW() WHERE token = $1`, [token]).catch(() => {});
  const w = await pool.query(`SELECT prefs FROM portal_wishlists WHERE agent_id = $1 AND athlete_id = $2`, [x.agent_id, x.athlete_id]).catch(() => ({ rows: [] }));
  const prefs = (w.rows[0] && w.rows[0].prefs) || {};
  const group = P.GROUPS.includes(prefs.group) ? prefs.group : P.groupOf(athlete.position);
  const d = x.data || {};
  let seasonsLeft = null;
  if (d.showSeasonsLeft && (prefs.birthDate || prefs.firstEnrollment)) {
    // No position on this call, so nothing is ranked: just the clock.
    try { seasonsLeft = (await require('./index').enterCheck(pool, { ...prefs, group: null, position: '' })).seasonsAfter; } catch (_) { /* leave it off */ }
  }
  return {
    name: athlete.name || null,
    position: athlete.position || (group ? P.LABEL[group] : null),
    group,
    school: athlete.school || null,
    hometown: d.hometown || null,
    heightWeight: d.heightWeight || null,
    classYear: d.classYear || null,
    seasonsLeft,
    statsLine: d.statsLine || null,
    highlights: d.highlights || [],
    filmUrl: d.filmUrl || null,
    statsUrl: d.statsUrl || null,
    note: d.note || null,
    agent: {
      name: (agent && agent.name) || null,
      phone: d.agentPhone || null,
      email: d.agentEmail || null,
    },
  };
}

// ── THE EMAIL TO A SCHOOL ───────────────────────────────────────────────────
// Short, specific, written for a GM or personnel director who gets fifty of
// these a day. Deterministic: the same inputs give the same email.
function emailFor({ school, book, profile, profileUrl, agentName, group }) {
  const first = String(profile.name || 'My client').split(/\s+/)[0];
  const pos = group || profile.group || '';
  const people = (book && book.contacts) || [];
  const rank = ['General manager / football ops', 'Player personnel', `Position coach (${pos})`];
  let to = people.filter((p) => p.email && rank.includes(p.label));
  let cc = people.filter((p) => p.email && !rank.includes(p.label) && p.label === 'Recruiting');
  // Nobody senior published: recruiting (or the program's recruiting inbox)
  // is the one address there is, so it goes on the To line.
  if (!to.length) {
    to = cc.length ? cc : (book && book.recruitingEmail && book.recruitingEmail.email ? [{ name: 'Recruiting', email: book.recruitingEmail.email, label: 'Recruiting office' }] : []);
    cc = [];
  }
  const greetName = (to[0] && to[0].name) ? `Coach ${String(to[0].name).split(/\s+/).slice(-1)[0]}` : 'Coach';
  const subject = `${profile.name || 'Portal player'}, ${pos}${profile.school ? ', ' + profile.school : ''}: in the portal`;
  const lines = [`${greetName},`, ''];
  lines.push(`I represent ${profile.name || 'a player'}${pos ? `, a ${pos}` : ''}${profile.school ? ` at ${profile.school}` : ''}${profile.heightWeight ? ` (${profile.heightWeight})` : ''}. He is entering the transfer portal and ${school} is a school he wants to talk to.`);
  if (profile.statsLine) lines.push('', profile.statsLine);
  if (profile.seasonsLeft != null) lines.push('', `He has ${profile.seasonsLeft} season${profile.seasonsLeft === 1 ? '' : 's'} left to play.`);
  if (profile.filmUrl) lines.push('', `Film: ${profile.filmUrl}`);
  if (profileUrl) lines.push(`One-pager: ${profileUrl}`);
  lines.push('', `If ${first} fits what you need${pos ? ` at ${pos}` : ''}, I can get you anything else and set up a call this week.`);
  lines.push('', agentName || '', [profile.agent && profile.agent.phone, profile.agent && profile.agent.email].filter(Boolean).join(' · '));
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const callList = people.filter((p) => !p.email).slice(0, 3).map((p) => ({ label: p.label, name: p.name, phone: p.phone || null }));
  return {
    school, subject, body,
    to: to.map((p) => ({ name: p.name, email: p.email, label: p.label })),
    cc: cc.map((p) => ({ name: p.name, email: p.email, label: p.label })),
    office: book && book.office ? book.office.phone : null,
    callInstead: !to.length ? callList : [],
    mailto: to.length ? `mailto:${to.map((p) => encodeURIComponent(p.email)).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}${cc.length ? '&cc=' + cc.map((p) => encodeURIComponent(p.email)).join(',') : ''}` : null,
  };
}

module.exports = { ensureTables, listTargets, addTarget, updateTarget, removeTarget, cleanProfile, getProfile, saveProfile, rotateToken, publicProfile, emailFor, STAGES, STAGE_LABEL };
