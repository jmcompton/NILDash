'use strict';
// ── THE FOUNDER'S OWN CRM: WHO HE IS SELLING TO, AND WHO TO CALL TODAY ──────
//
// The founder sells NILDash face to face: calls, texts, LinkedIn, meetings.
// His pipeline lived on a page outside the product that could not remind him
// of anything and was not on his phone. It lives here now, for the admin
// account only (/admin/crm, everything under /api/admin/crm).
//
// WHAT IT IS FOR, in the order he uses it:
//   1. "Who do I follow up with today?"  Every contact has ONE next step and a
//      day it is due (and a time, if he set one). Today's page is the overdue
//      ones and today's, most important first.
//   2. "I called and he did not answer."  One tap logs it: no answer,
//      voicemail, talked, texted, emailed, met. Each stamps the time, goes on
//      the contact's history, and moves the follow-up to a sensible day (no
//      answer: tomorrow; voicemail: two days; talked: a week) that he can
//      change before saving.
//   3. "Tell me when."  alertsDue() is what the reminder job reads: one
//      morning email of the day's follow-ups, and one email at the minute a
//      timed follow-up comes due. Each is sent once (crm_alerts).
//
// TABLES. crm_contacts (one row per person or company), crm_activity (every
// call, text, email, meeting and note, newest first on the contact), crm_alerts
// (what has been sent, so nothing is sent twice).
//
// These are the founder's own sales contacts. Nothing here is visible to an
// agent, and none of it is used by the outreach engine.

const GROUPS = ['customer', 'prospect', 'partner', 'investor', 'university', 'advisor', 'other'];
const STAGES = ['new', 'reached', 'talking', 'meeting', 'trial', 'active', 'parked'];
const CHANNELS = ['call', 'text', 'email', 'linkedin', 'meeting', 'other'];
const STATES = ['open', 'waiting', 'done'];
// A logged touch: what it is called, the activity type it is filed under, and
// how many days until the default follow-up (null: no follow-up suggested).
const OUTCOMES = {
  no_answer: { label: 'No answer', type: 'call', text: 'Called. No answer.', followDays: 1 },
  voicemail: { label: 'Left voicemail', type: 'call', text: 'Called. Left a voicemail.', followDays: 2 },
  talked: { label: 'Talked', type: 'call', text: 'Talked on the phone.', followDays: 7 },
  texted: { label: 'Texted', type: 'text', text: 'Sent a text.', followDays: 3 },
  emailed: { label: 'Emailed', type: 'email', text: 'Sent an email.', followDays: 4 },
  linkedin: { label: 'LinkedIn message', type: 'linkedin', text: 'Sent a LinkedIn message.', followDays: 4 },
  met: { label: 'Met', type: 'meeting', text: 'Met.', followDays: 7 },
  they_replied: { label: 'They replied', type: 'inbound', text: 'They replied.', followDays: 1 },
  note: { label: 'Note', type: 'note', text: '', followDays: null },
};
const TZ = 'America/New_York';

let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS crm_contacts (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      title         TEXT,
      org           TEXT,
      grp           TEXT NOT NULL DEFAULT 'prospect',
      stage         TEXT NOT NULL DEFAULT 'new',
      channel       TEXT,
      email         TEXT,
      phone         TEXT,
      linkedin      TEXT,
      link          TEXT,
      value         NUMERIC,
      source        TEXT,
      next_step     TEXT,
      due_on        DATE,
      due_time      TEXT,
      state         TEXT NOT NULL DEFAULT 'open',
      say           TEXT,
      notes         TEXT,
      prio          INTEGER NOT NULL DEFAULT 2,
      last_touch_at TIMESTAMPTZ,
      archived      BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS crm_activity (
      id          BIGSERIAL PRIMARY KEY,
      contact_id  TEXT NOT NULL,
      at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      type        TEXT NOT NULL DEFAULT 'note',
      outcome     TEXT,
      body        TEXT
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS crm_activity_contact ON crm_activity (contact_id, at DESC)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS crm_alerts (
      key      TEXT PRIMARY KEY,
      sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

const clean = (v, n) => { const s = String(v == null ? '' : v).replace(/\u0000/g, '').trim(); return s ? s.slice(0, n) : null; };
const oneOf = (v, list, d) => (list.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : d);
const dateOf = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); if (!m) return null; const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`); return isNaN(d) ? null : `${m[1]}-${m[2]}-${m[3]}`; };
const timeOf = (v) => { const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v || '').trim()); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// Today's date and the minute of the day, where the founder is.
function nowLocal(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  // A follow-up never lands on a weekend: Saturday and Sunday move to Monday.
  const wd = d.getUTCDay(); if (wd === 6) d.setUTCDate(d.getUTCDate() + 2); else if (wd === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function fieldsFrom(b, { partial = false } = {}) {
  const f = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b || {}, k);
  const set = (col, k, fn) => { if (!partial || has(k)) f[col] = fn(b[k]); };
  set('name', 'name', (v) => clean(v, 120));
  set('title', 'title', (v) => clean(v, 160));
  set('org', 'org', (v) => clean(v, 160));
  set('grp', 'group', (v) => oneOf(v, GROUPS, 'prospect'));
  set('stage', 'stage', (v) => oneOf(v, STAGES, 'new'));
  set('channel', 'channel', (v) => oneOf(v, CHANNELS, null));
  set('email', 'email', (v) => clean(v, 200));
  set('phone', 'phone', (v) => clean(v, 40));
  set('linkedin', 'linkedin', (v) => clean(v, 300));
  set('link', 'link', (v) => clean(v, 300));
  set('value', 'value', (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return Number.isFinite(n) && n >= 0 && String(v || '').trim() !== '' ? n : null; });
  set('source', 'source', (v) => clean(v, 200));
  set('next_step', 'next', (v) => clean(v, 600));
  set('due_on', 'due', dateOf);
  set('due_time', 'dueTime', timeOf);
  set('state', 'state', (v) => oneOf(v, STATES, 'open'));
  set('say', 'say', (v) => clean(v, 4000));
  set('notes', 'notes', (v) => clean(v, 20000));
  set('prio', 'prio', (v) => { const n = parseInt(v, 10); return n >= 1 && n <= 3 ? n : 2; });
  return f;
}

const shape = (r) => r && ({
  id: r.id, name: r.name, title: r.title, org: r.org, group: r.grp, stage: r.stage, channel: r.channel, email: r.email, phone: r.phone,
  linkedin: r.linkedin, link: r.link, value: r.value == null ? null : Number(r.value), source: r.source, next: r.next_step,
  due: r.due_on ? (r.due_on instanceof Date ? r.due_on.toISOString().slice(0, 10) : String(r.due_on).slice(0, 10)) : null,
  dueTime: r.due_time, state: r.state, say: r.say, notes: r.notes, prio: r.prio, lastTouchAt: r.last_touch_at, archived: r.archived,
  createdAt: r.created_at, updatedAt: r.updated_at,
  lastTouch: r.last_body ? { at: r.last_at, type: r.last_type, text: r.last_body } : undefined,
});

const LIST_SQL = `SELECT c.*, to_char(c.due_on, 'YYYY-MM-DD') AS due_on,
    la.at AS last_at, la.type AS last_type, la.body AS last_body
  FROM crm_contacts c
  LEFT JOIN LATERAL (SELECT at, type, body FROM crm_activity a WHERE a.contact_id = c.id ORDER BY at DESC, id DESC LIMIT 1) la ON TRUE`;

async function list(pool) {
  await ensureTables(pool);
  const rows = (await pool.query(`${LIST_SQL} WHERE c.archived = FALSE ORDER BY c.name`)).rows;
  return rows.map(shape);
}

async function get(pool, id) {
  await ensureTables(pool);
  const r = (await pool.query(`${LIST_SQL} WHERE c.id = $1`, [String(id || '')])).rows[0];
  if (!r) return null;
  const act = (await pool.query(`SELECT id, at, type, outcome, body FROM crm_activity WHERE contact_id = $1 ORDER BY at DESC, id DESC LIMIT 300`, [r.id])).rows;
  return { ...shape(r), activity: act.map((a) => ({ id: Number(a.id), at: a.at, type: a.type, outcome: a.outcome, text: a.body })) };
}

async function create(pool, b) {
  await ensureTables(pool);
  const f = fieldsFrom(b);
  if (!f.name) return { ok: false, status: 400, error: 'A contact needs a name.' };
  let id = clean(b.id, 60) ? slug(b.id) : slug(f.name);
  if (!id) id = 'c';
  for (let i = 0; i < 50; i++) {
    const tryId = i ? `${id}-${i + 1}` : id;
    const cols = ['id', ...Object.keys(f)];
    const r = await pool.query(`INSERT INTO crm_contacts (${cols.join(', ')}) VALUES (${cols.map((_, k) => '$' + (k + 1)).join(', ')}) ON CONFLICT (id) DO NOTHING`, [tryId, ...Object.values(f)]);
    if (r.rowCount) return { ok: true, contact: await get(pool, tryId) };
  }
  return { ok: false, status: 409, error: 'Could not save that contact. Try a different name.' };
}

async function update(pool, id, b) {
  await ensureTables(pool);
  const f = fieldsFrom(b, { partial: true });
  if ('name' in f && !f.name) return { ok: false, status: 400, error: 'A contact needs a name.' };
  if (Object.prototype.hasOwnProperty.call(b || {}, 'archived')) f.archived = b.archived === true;
  const keys = Object.keys(f);
  if (!keys.length) return { ok: true, contact: await get(pool, id) };
  const r = await pool.query(`UPDATE crm_contacts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`, [String(id || ''), ...keys.map((k) => f[k])]);
  if (!r.rowCount) return { ok: false, status: 404, error: 'That contact was not found.' };
  return { ok: true, contact: await get(pool, id) };
}

// What the Log sheet shows before he saves: the follow-up it would set.
function suggestFollowUp(outcome, now = new Date()) {
  const o = OUTCOMES[outcome];
  if (!o || o.followDays == null) return null;
  return addDays(nowLocal(now).date, o.followDays);
}

// ONE TAP: log a touch and move the follow-up.
// b: { outcome, note?, due? (YYYY-MM-DD | null to clear), dueTime?, next?, stage?, done? }
async function log(pool, id, b, { now = new Date() } = {}) {
  await ensureTables(pool);
  const o = OUTCOMES[String(b.outcome || '')];
  if (!o) return { ok: false, status: 400, error: 'Pick what happened.' };
  const c = (await pool.query(`SELECT id, next_step FROM crm_contacts WHERE id = $1`, [String(id || '')])).rows[0];
  if (!c) return { ok: false, status: 404, error: 'That contact was not found.' };
  const note = clean(b.note, 4000);
  const body = [o.text, note].filter(Boolean).join(' ').trim();
  if (!body) return { ok: false, status: 400, error: 'Write the note.' };
  await pool.query(`INSERT INTO crm_activity (contact_id, at, type, outcome, body) VALUES ($1, $2, $3, $4, $5)`, [c.id, now, o.type, String(b.outcome), body]);
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const sets = ['updated_at = NOW()'], args = [c.id];
  const put = (col, v) => { args.push(v); sets.push(`${col} = $${args.length}`); };
  // A note is not contact with them: it does not move "last touched".
  if (o.type !== 'note') put('last_touch_at', now);
  if (b.done === true) { put('state', 'done'); put('due_on', null); put('due_time', null); }
  else {
    const due = has('due') ? dateOf(b.due) : suggestFollowUp(String(b.outcome), now);
    if (has('due') || due) { put('due_on', due); put('due_time', has('dueTime') ? timeOf(b.dueTime) : null); if (due) put('state', 'open'); }
  }
  if (has('next') && clean(b.next, 600)) put('next_step', clean(b.next, 600));
  if (has('stage') && STAGES.includes(String(b.stage))) put('stage', String(b.stage));
  await pool.query(`UPDATE crm_contacts SET ${sets.join(', ')} WHERE id = $1`, args);
  return { ok: true, contact: await get(pool, c.id) };
}

async function removeActivity(pool, contactId, activityId) {
  await ensureTables(pool);
  const r = await pool.query(`DELETE FROM crm_activity WHERE id = $1 AND contact_id = $2`, [parseInt(activityId, 10) || 0, String(contactId || '')]);
  return { ok: true, removed: r.rowCount };
}

// What Today shows. -> { date, overdue: [...], today: [...], upcoming: [...] }
async function today(pool, { now = new Date() } = {}) {
  const all = await list(pool);
  const { date } = nowLocal(now);
  const open = all.filter((c) => c.state !== 'done' && c.due);
  const byPrio = (a, b) => (a.prio - b.prio) || String(a.dueTime || '99').localeCompare(String(b.dueTime || '99')) || a.name.localeCompare(b.name);
  const week = addDaysRaw(date, 7);
  return {
    date,
    overdue: open.filter((c) => c.due < date).sort((a, b) => a.due.localeCompare(b.due) || byPrio(a, b)),
    today: open.filter((c) => c.due === date).sort(byPrio),
    upcoming: open.filter((c) => c.due > date && c.due <= week).sort((a, b) => a.due.localeCompare(b.due) || byPrio(a, b)),
    counts: { contacts: all.length, noNextStep: all.filter((c) => c.state !== 'done' && !c.due && !['parked'].includes(c.stage)).length },
  };
}
function addDaysRaw(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ── BRINGING THE OLD PIPELINE OVER ──────────────────────────────────────────
// The export of the old page: [{ id, data: { name, ..., activity: [{at,type,text}] } }]
// or the bare objects. Existing ids are left as they are, so importing twice
// adds nothing twice. -> { added, skipped, activity }
async function importAll(pool, docs) {
  await ensureTables(pool);
  const out = { added: 0, skipped: 0, activity: 0 };
  for (const doc of Array.isArray(docs) ? docs : []) {
    const d = (doc && doc.data) || doc || {};
    const id = slug((doc && doc.id) || d.id || d.name);
    if (!id || !clean(d.name, 120)) { out.skipped++; continue; }
    const f = fieldsFrom(d);
    const cols = ['id', ...Object.keys(f)];
    const r = await pool.query(`INSERT INTO crm_contacts (${cols.join(', ')}) VALUES (${cols.map((_, k) => '$' + (k + 1)).join(', ')}) ON CONFLICT (id) DO NOTHING`, [id, ...Object.values(f)]);
    if (!r.rowCount) { out.skipped++; continue; }
    out.added++;
    let last = null;
    for (const a of Array.isArray(d.activity) ? d.activity : []) {
      const at = new Date(String(a.at || '').length === 10 ? a.at + 'T17:00:00Z' : a.at);
      const body = clean(a.text, 4000);
      if (isNaN(at) || !body) continue;
      const type = ['call', 'text', 'email', 'linkedin', 'meeting', 'inbound', 'note'].includes(String(a.type)) ? String(a.type) : 'note';
      await pool.query(`INSERT INTO crm_activity (contact_id, at, type, body) VALUES ($1, $2, $3, $4)`, [id, at, type, body]);
      out.activity++;
      if (type !== 'note' && (!last || at > last)) last = at;
    }
    if (last) await pool.query(`UPDATE crm_contacts SET last_touch_at = $2 WHERE id = $1`, [id, last]);
  }
  return out;
}

// ── TELL ME WHEN ────────────────────────────────────────────────────────────
// The morning email: once a day, from MORNING_AT (7:30 where he is), when
// anything is overdue or due today. The timed reminder: one email for each
// follow-up with a time, at that minute (and up to two hours late, so a
// restart does not lose it). Each key is claimed in crm_alerts before the
// send: sent once, even with two instances running.
const MORNING_AT = 7 * 60 + 30;
const LATE_MIN = 120;
const APP_URL = () => (process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const t12 = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };

async function claim(pool, key) {
  const r = await pool.query(`INSERT INTO crm_alerts (key) VALUES ($1) ON CONFLICT DO NOTHING`, [key]);
  return r.rowCount > 0;
}
const line = (c) => `${c.name}${c.org ? ' (' + c.org + ')' : ''}: ${c.next || 'Follow up.'}${c.dueTime ? ' At ' + t12(c.dueTime) + '.' : ''}`;

function morningEmail(t) {
  const n = t.overdue.length + t.today.length;
  const subject = `${n} follow-up${n === 1 ? '' : 's'} today` + (t.overdue.length ? ` (${t.overdue.length} overdue)` : '');
  const sec = (title, rows) => (rows.length ? [title, ...rows.map((c) => '- ' + line(c)), ''] : []);
  const text = [...sec('OVERDUE', t.overdue), ...sec('TODAY', t.today), `Open your CRM: ${APP_URL()}/admin/crm`].join('\n');
  const hsec = (title, rows) => (rows.length ? `<p style="margin:16px 0 6px"><b>${title}</b></p><ul style="margin:0;padding-left:18px">`
    + rows.map((c) => `<li style="margin:4px 0"><b>${esc(c.name)}</b>${c.org ? ' (' + esc(c.org) + ')' : ''}: ${esc(c.next || 'Follow up.')}${c.dueTime ? ' At ' + t12(c.dueTime) + '.' : ''}</li>`).join('') + '</ul>' : '');
  const html = hsec('Overdue', t.overdue) + hsec('Today', t.today) + `<p style="margin-top:18px"><a href="${esc(APP_URL())}/admin/crm">Open your CRM</a></p>`;
  return { subject, text, html };
}
function timedEmail(c) {
  const subject = `Now: ${c.name}${c.org ? ' (' + c.org + ')' : ''}`;
  const text = [`${c.next || 'Follow up.'}`, c.phone ? `Phone: ${c.phone}` : '', '', `Open: ${APP_URL()}/admin/crm#c=${c.id}`].filter((x) => x !== '').join('\n');
  const html = `<p><b>${esc(c.name)}</b>${c.org ? ' (' + esc(c.org) + ')' : ''}</p><p>${esc(c.next || 'Follow up.')}</p>`
    + (c.phone ? `<p><a href="tel:${esc(String(c.phone).replace(/[^\d+]/g, ''))}">Call ${esc(c.phone)}</a></p>` : '')
    + `<p><a href="${esc(APP_URL())}/admin/crm#c=${esc(c.id)}">Open in your CRM</a></p>`;
  return { subject, text, html };
}

// What should be sent right now. Claims as it goes. -> [{ kind, to, msg }]
async function alertsDue(pool, { now = new Date(), to } = {}) {
  await ensureTables(pool);
  const t = await today(pool, { now });
  const { date, minutes } = nowLocal(now);
  const out = [];
  if (minutes >= MORNING_AT && (t.overdue.length || t.today.length) && await claim(pool, `morning:${date}`)) {
    out.push({ kind: 'morning', to, msg: morningEmail(t) });
  }
  for (const c of t.today) {
    if (!c.dueTime) continue;
    const [h, m] = c.dueTime.split(':').map(Number);
    const at = h * 60 + m;
    if (minutes < at || minutes > at + LATE_MIN) continue;
    if (await claim(pool, `timed:${c.id}:${date}:${c.dueTime}`)) out.push({ kind: 'timed', to, msg: timedEmail(c) });
  }
  return out;
}

async function sendOne(to, msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: 'NILDash CRM <noreply@mynildash.com>', to, subject: msg.subject, text: msg.text, html: msg.html });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
}

// The reminder job's tick. Never throws.
async function tick(pool, { now = new Date(), to, send = sendOne } = {}) {
  const sent = [];
  try {
    const due = await alertsDue(pool, { now, to });
    for (const a of due) {
      try { await send(a.to, a.msg); sent.push(a.kind); }
      catch (e) { console.error('[crm] reminder not sent:', e.message); }
    }
  } catch (e) { console.error('[crm] reminder tick:', e.message); }
  return sent;
}

let _timer = null;
function start(pool, { to }) {
  if (_timer || !to) return;
  const go = () => { tick(pool, { to }).catch(() => {}); };
  _timer = setInterval(go, 60 * 1000);
  if (_timer.unref) _timer.unref();
}

// A follow-up as a calendar file: his phone's own calendar reminds him.
function ics(c, { now = new Date() } = {}) {
  if (!c || !c.due) return null;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const d = c.due.replace(/-/g, '');
  const fold = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\;');
  const when = c.dueTime
    ? [`DTSTART;TZID=${TZ}:${d}T${c.dueTime.replace(':', '')}00`, 'DURATION:PT15M']
    : [`DTSTART;VALUE=DATE:${d}`];
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NILDash//CRM//EN', 'BEGIN:VEVENT',
    `UID:crm-${c.id}-${d}@mynildash.com`, `DTSTAMP:${stamp}`, ...when,
    `SUMMARY:${fold('Follow up: ' + c.name)}`, `DESCRIPTION:${fold((c.next || 'Follow up.') + (c.phone ? '\nPhone: ' + c.phone : ''))}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Follow up', 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

module.exports = { ensureTables, list, get, create, update, log, removeActivity, today, importAll, alertsDue, tick, start, ics,
  suggestFollowUp, nowLocal, addDays, morningEmail, timedEmail, GROUPS, STAGES, CHANNELS, STATES, OUTCOMES, MORNING_AT, TZ };
