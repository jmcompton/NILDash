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
//               (target, contacted, replied, interested, visit, offer,
//               committed, passed), the next step and the day it is due, and
//               an email draft to that school's people with the one-pager
//               link. NILDash writes the email; the agent sends it from his
//               own mailbox. Nothing is sent from here.
//   ACTIVITY    what happened with each school, newest first: added, moved,
//               an email, a call, a reply, a note. Moves log themselves; the
//               agent logs the rest. Logging an email or call to a school still
//               at "target" moves it to contacted; logging a reply moves it to
//               replied. Each entry can name who it was with (the contact
//               book's label), so the page shows when each person was last
//               reached.
//
// Agent data, scoped to the agent and his own athlete in every query.

const crypto = require('crypto');
const Schools = require('./schools');
const P = require('./positions');

const STAGES = ['target', 'contacted', 'replied', 'interested', 'visit', 'offer', 'committed', 'passed'];
const STAGE_LABEL = { target: 'Target', contacted: 'Contacted', replied: 'Replied', interested: 'Interested', visit: 'Visit set', offer: 'Offer in', committed: 'Committed', passed: 'Passed' };
const KINDS = ['note', 'email', 'call', 'reply', 'visit', 'stage', 'added', 'opened'];
const KIND_LABEL = { note: 'Note', email: 'Email', call: 'Call', reply: 'Reply', visit: 'Visit', stage: 'Moved', added: 'Added', opened: 'Opened' };
// A real calendar date (the pattern alone lets Feb 30 through to Postgres).
const realDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const ymd = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
const clip = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));
const httpUrl = (u) => { const s = clip(u, 500); return s && /^https?:\/\/[^\s<>"']+$/i.test(s) ? s : null; };

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS portal_targets (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, athlete_id TEXT NOT NULL, school TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'target', next_step TEXT, notes TEXT, last_touch_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_id, athlete_id, school))`);
  await pool.query(`ALTER TABLE portal_targets ADD COLUMN IF NOT EXISTS due_on DATE`);
  await pool.query(`CREATE TABLE IF NOT EXISTS portal_activity (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, athlete_id TEXT NOT NULL, target_id TEXT, school TEXT,
    kind TEXT NOT NULL, contact TEXT, text TEXT, at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_portal_activity_owner ON portal_activity (agent_id, athlete_id, at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS portal_profiles (
    agent_id TEXT NOT NULL, athlete_id TEXT NOT NULL, token TEXT UNIQUE, live BOOLEAN DEFAULT TRUE,
    data JSONB NOT NULL DEFAULT '{}'::jsonb, views INT DEFAULT 0, last_viewed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (agent_id, athlete_id))`);
}

// ── TARGETS ─────────────────────────────────────────────────────────────────
function shapeT(r) {
  return { id: r.id, school: r.school, stage: r.stage, stageLabel: STAGE_LABEL[r.stage] || r.stage, nextStep: r.next_step, dueOn: ymd(r.due_on), notes: r.notes, lastTouchAt: r.last_touch_at, updatedAt: r.updated_at };
}

// ── ACTIVITY ────────────────────────────────────────────────────────────────
function shapeA(r) {
  return { id: r.id, targetId: r.target_id, school: r.school, kind: r.kind, kindLabel: KIND_LABEL[r.kind] || r.kind, contact: r.contact, text: r.text, at: r.at };
}
async function _log(pool, agentId, athleteId, { targetId = null, school = null, kind, contact = null, text = null }) {
  const id = 'pa_' + crypto.randomBytes(9).toString('hex');
  const r = await pool.query(`INSERT INTO portal_activity (id, agent_id, athlete_id, target_id, school, kind, contact, text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, agentId, athleteId, targetId, school, kind, contact, text]);
  return shapeA(r.rows[0]);
}
// What the agent logs. Contact is the contact book's label ("Player
// personnel") or a name; text is his note. An email or call to a school still
// at target moves it to contacted; a reply moves target/contacted to replied.
async function logActivity(pool, agentId, athleteId, b = {}) {
  await ensureTables(pool);
  const kind = ['note', 'email', 'call', 'reply', 'visit'].includes(b.kind) ? b.kind : null;
  if (!kind) throw bad('Pick what happened: email, call, reply, visit or note.');
  const t = (await pool.query(`SELECT * FROM portal_targets WHERE id = $1 AND agent_id = $2 AND athlete_id = $3`, [String(b.targetId || ''), agentId, athleteId])).rows[0];
  if (!t) throw bad('Target not found', 404);
  const text = clip(b.text, 500), contact = clip(b.contact, 120);
  if (kind === 'note' && !text) throw bad('Write the note.');
  const entry = await _log(pool, agentId, athleteId, { targetId: t.id, school: t.school, kind, contact, text });
  let stage = t.stage;
  if ((kind === 'email' || kind === 'call') && t.stage === 'target') stage = 'contacted';
  if (kind === 'reply' && ['target', 'contacted'].includes(t.stage)) stage = 'replied';
  const touch = kind !== 'note';
  if (stage !== t.stage || touch) {
    await pool.query(`UPDATE portal_targets SET stage = $4${touch ? ', last_touch_at = NOW()' : ''}, updated_at = NOW() WHERE id = $1 AND agent_id = $2 AND athlete_id = $3`, [t.id, agentId, athleteId, stage]);
    if (stage !== t.stage) await _log(pool, agentId, athleteId, { targetId: t.id, school: t.school, kind: 'stage', text: `Moved to ${STAGE_LABEL[stage]}` });
  }
  return { entry, stage, stageLabel: STAGE_LABEL[stage] };
}
async function listActivity(pool, agentId, athleteId, { targetId = null, limit = 200 } = {}) {
  await ensureTables(pool);
  const vals = [agentId, athleteId];
  let where = 'agent_id = $1 AND athlete_id = $2';
  if (targetId) { vals.push(String(targetId)); where += ` AND target_id = $${vals.length}`; }
  vals.push(Math.max(1, Math.min(500, limit)));
  const r = await pool.query(`SELECT * FROM portal_activity WHERE ${where} ORDER BY at DESC, id DESC LIMIT $${vals.length}`, vals);
  return r.rows.map(shapeA);
}
// Someone at the school opened his one-pager (services/portalRoom/opens):
// logged, and a school still at Target or Contacted moves to Interested.
async function recordOpenActivity(pool, agentId, athleteId, targetId, school) {
  await ensureTables(pool);
  const t = (await pool.query(`SELECT * FROM portal_targets WHERE id = $1 AND agent_id = $2 AND athlete_id = $3`, [String(targetId), agentId, athleteId])).rows[0];
  if (!t) return null;
  await _log(pool, agentId, athleteId, { targetId: t.id, school: t.school, kind: 'opened', text: `Someone at ${t.school} opened his one-pager` });
  if (['target', 'contacted'].includes(t.stage)) {
    await pool.query(`UPDATE portal_targets SET stage = 'interested', updated_at = NOW() WHERE id = $1`, [t.id]);
    await _log(pool, agentId, athleteId, { targetId: t.id, school: t.school, kind: 'stage', text: 'Opened his one-pager. Moved to Interested' });
    return { stage: 'interested' };
  }
  return { stage: t.stage };
}

// He committed (services/portalRoom/offers): that school's card goes to
// Committed, added to the list if it was not on it.
async function markCommitted(pool, agentId, athleteId, school) {
  await ensureTables(pool);
  const s = Schools.canonical(school) || clip(school, 80);
  if (!s) return null;
  const cur = (await pool.query(`SELECT * FROM portal_targets WHERE agent_id = $1 AND athlete_id = $2 AND school = $3`, [agentId, athleteId, s])).rows[0];
  if (cur && cur.stage === 'committed') return shapeT(cur);
  let row;
  if (cur) row = (await pool.query(`UPDATE portal_targets SET stage = 'committed', last_touch_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`, [cur.id])).rows[0];
  else row = (await pool.query(`INSERT INTO portal_targets (id, agent_id, athlete_id, school, stage, last_touch_at) VALUES ($1,$2,$3,$4,'committed',NOW()) RETURNING *`,
    ['pt_' + crypto.randomBytes(9).toString('hex'), agentId, athleteId, s])).rows[0];
  await _log(pool, agentId, athleteId, { targetId: row.id, school: s, kind: 'stage', text: 'He committed. Moved to Committed' });
  return shapeT(row);
}

async function listTargets(pool, agentId, athleteId) {
  await ensureTables(pool);
  const r = await pool.query(`SELECT * FROM portal_targets WHERE agent_id = $1 AND athlete_id = $2`, [agentId, athleteId]);
  const order = (s) => (s === 'passed' ? 99 : STAGES.length - STAGES.indexOf(s));
  // (committed sorts first: it is furthest along)
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
    ON CONFLICT (agent_id, athlete_id, school) DO UPDATE SET updated_at = portal_targets.updated_at RETURNING *, (xmax = 0) AS inserted`, [id, agentId, athleteId, s]);
  if (r.rows[0].inserted) await _log(pool, agentId, athleteId, { targetId: r.rows[0].id, school: s, kind: 'added', text: 'Added to his list' });
  return shapeT(r.rows[0]);
}

async function updateTarget(pool, agentId, athleteId, id, b = {}) {
  await ensureTables(pool);
  const sets = [], vals = [String(id), agentId, athleteId];
  const before = (await pool.query(`SELECT stage FROM portal_targets WHERE id = $1 AND agent_id = $2 AND athlete_id = $3`, vals)).rows[0];
  if (!before) throw bad('Target not found', 404);
  if (b.stage !== undefined) {
    if (!STAGES.includes(b.stage)) throw bad('Unknown stage.');
    vals.push(b.stage); sets.push(`stage = $${vals.length}`);
    // Any move past "target" is a touch.
    if (b.stage !== 'target') sets.push('last_touch_at = NOW()');
  }
  if (b.nextStep !== undefined) { vals.push(clip(b.nextStep, 200)); sets.push(`next_step = $${vals.length}`); }
  if (b.notes !== undefined) { vals.push(clip(b.notes, 1000)); sets.push(`notes = $${vals.length}`); }
  if (b.dueOn !== undefined) {
    if (b.dueOn !== null && b.dueOn !== '' && !realDate(b.dueOn)) throw bad('Pick a real date.');
    vals.push(b.dueOn || null); sets.push(`due_on = $${vals.length}`);
  }
  if (!sets.length) throw bad('Nothing to change.');
  const r = await pool.query(`UPDATE portal_targets SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND agent_id = $2 AND athlete_id = $3 RETURNING *`, vals);
  if (!r.rows[0]) throw bad('Target not found', 404);
  if (b.stage !== undefined && b.stage !== before.stage) await _log(pool, agentId, athleteId, { targetId: r.rows[0].id, school: r.rows[0].school, kind: 'stage', text: `Moved to ${STAGE_LABEL[b.stage]}` });
  return shapeT(r.rows[0]);
}

async function removeTarget(pool, agentId, athleteId, id) {
  await ensureTables(pool);
  const r = await pool.query(`DELETE FROM portal_targets WHERE id = $1 AND agent_id = $2 AND athlete_id = $3`, [String(id), agentId, athleteId]);
  if (!r.rowCount) throw bad('Target not found', 404);
  await pool.query(`DELETE FROM portal_activity WHERE target_id = $1 AND agent_id = $2 AND athlete_id = $3`, [String(id), agentId, athleteId]);
  await pool.query(`DELETE FROM portal_profile_links WHERE target_id = $1 AND agent_id = $2 AND athlete_id = $3`, [String(id), agentId, athleteId]).catch(() => {});
  return { ok: true };
}

// ── THE ONE-PAGER ───────────────────────────────────────────────────────────
// What an agent fills in. Everything is optional except that it is his athlete.
function cleanProfile(b = {}) {
  return {
    heightWeight: clip(b.heightWeight, 40),
    classYear: clip(b.classYear, 40),
    statsLine: clip(b.statsLine, 300),
    // Agent-entered, shown as written: "40: 4.48 · Vert: 36 · Wingspan: 77"
    measurables: clip(b.measurables, 160),
    // What he wants in a school, in the agent's words (never from his
    // private wish list on its own).
    lookingFor: clip(b.lookingFor, 240),
    academics: clip(b.academics, 160),
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
    measurables: d.measurables || null,
    lookingFor: d.lookingFor || null,
    academics: d.academics || null,
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

// The commit was undone (the offer moved off committed): the card goes back
// to Offer in, unless another offer from that school is still committed.
async function unmarkCommitted(pool, agentId, athleteId, school) {
  await ensureTables(pool);
  const s = Schools.canonical(school) || clip(school, 80);
  if (!s) return null;
  const still = await pool.query(`SELECT 1 FROM portal_offers WHERE agent_id = $1 AND athlete_id = $2 AND school = $3 AND status = 'committed' LIMIT 1`, [agentId, athleteId, s]).catch(() => ({ rows: [] }));
  if (still.rows.length) return null;
  const r = await pool.query(`UPDATE portal_targets SET stage = 'offer', updated_at = NOW() WHERE agent_id = $1 AND athlete_id = $2 AND school = $3 AND stage = 'committed' RETURNING *`, [agentId, athleteId, s]);
  if (!r.rows[0]) return null;
  await _log(pool, agentId, athleteId, { targetId: r.rows[0].id, school: s, kind: 'stage', text: 'Commit undone. Moved back to Offer in' });
  return shapeT(r.rows[0]);
}

module.exports = { recordOpenActivity, unmarkCommitted, logActivity, listActivity, markCommitted, KINDS, KIND_LABEL, realDate, ensureTables, listTargets, addTarget, updateTarget, removeTarget, cleanProfile, getProfile, saveProfile, rotateToken, publicProfile, emailFor, STAGES, STAGE_LABEL };
