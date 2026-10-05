'use strict';
// ── TALKED TO, NO DEAL: PROSPECTS FROM THE ADMIN'S OWN OUTLOOK ──────────────
//
// The real pipeline is in one mailbox: ten sales conversations in two weeks,
// none of them in NILDash. This reads that mailbox and its calendar and turns
// each conversation into a prospect on /admin/prospects, then follows up the
// silent ones the way the agents' follow-ups do.
//
// ONE MAILBOX, NEVER A CUSTOMER'S. The source is exactly PROSPECT_MAILBOX
// (john@comptongroupllc.com), and only while that Outlook connection belongs
// to the admin login (ADMIN_EMAIL). Any other account -- a customer's, or this
// address connected under someone else's login -- is refused, by address and
// by owner, before a single Graph call is made. Nothing reads emailSync's
// copies of anyone's mail: the reads are Graph calls on this one token.
//
// WHAT BECOMES A PROSPECT (last LOOKBACK_DAYS):
//   a MEETING that is clearly a NILDash sales call: a Calendly booking or a
//     Teams meeting whose title or invite says NILDash / NIL (or a Calendly
//     demo), already held, not cancelled; its outside attendees are the
//     contacts
//   an EMAIL conversation: someone the admin wrote to (sent, to or cc)
//   ...and in both cases only people who are not NILDash users, not internal
//   (the mailbox's own domain, our domains, the cold agent's internal list,
//   the exclude lists) and not machines (no-reply, notifications, Calendly,
//   Microsoft). One prospect per company domain; a personal address (gmail
//   and the like) is its own prospect. Stored: the company (from the domain),
//   the people (name, address), the date we last spoke and how, the subject.
//   No message bodies are stored.
//
// FOLLOW-UPS, the agents' machinery (services/followUps) applied here:
//   the conversation is touch 1; no reply 4 days after the admin's last email
//   or the meeting -> follow-up 1 as a draft on the page (Approve, the cold
//   agent's send path, from this mailbox); no reply 7 days later -> follow-up
//   2, the last, the easiest to say no to. Three touches, then nothing.
//   STOPS DEAD when they write back in this mailbox: checked at every sync,
//   and again live against Graph at Approve and at the moment of sending.
//   Also never: suppressed (bounce, unsubscribe, no), excluded, marked no or
//   customer, or now a NILDash user.

const crypto = require('crypto');

const LOOKBACK_DAYS = parseInt(process.env.PROSPECT_LOOKBACK_DAYS, 10) || 60;
const GAP_DAYS = { 2: 4, 3: 7 };
const MAX_TOUCHES = 3;
const SYSTEM = 'mailbox-followup';
const DAY = 86400000;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_PAGES = 20;

const lc = (s) => String(s || '').trim().toLowerCase();
const mailboxAddress = () => lc(process.env.PROSPECT_MAILBOX || 'john@comptongroupllc.com');
const domainOf = (a) => lc(a).split('@')[1] || '';

const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'bellsouth.net']);
// Machines, not people.
const MACHINE_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|calendar|calendly|invitations?|automated|system|receipts?|billing|invoices?|newsletter|news|digest|updates?|security|account|accounts|verify|verification)([+._-].*)?@/i;
const MACHINE_DOMAINS = ['calendly.com', 'microsoft.com', 'microsoftonline.com', 'office365.com', 'teams.microsoft.com', 'google.com', 'zoom.us',
  'stripe.com', 'railway.app', 'github.com', 'linkedin.com', 'docusign.net', 'hubspot.com', 'mailchimp.com', 'sendgrid.net', 'resend.dev', 'intuit.com', 'apple.com', 'amazonses.com'];

function isMachine(addr) {
  const a = lc(addr), d = domainOf(a);
  if (!a || !d) return true;
  if (MACHINE_LOCAL.test(a)) return true;
  return MACHINE_DOMAINS.some((m) => d === m || d.endsWith('.' + m));
}

// ── THE MAILBOX, AND ONLY THIS ONE ──────────────────────────────────────────
// Returns { ok, account, admin, canRead, canCalendar } or { ok:false, why }.
async function mailbox(pool) {
  const addr = mailboxAddress();
  const CA = require('./coldAgent');
  const admin = await adminRow(pool);
  if (!admin) return { ok: false, why: 'there is no admin account (ADMIN_EMAIL) to own the mailbox' };
  const rows = (await pool.query(
    `SELECT * FROM email_accounts WHERE LOWER(email_address) = $1 AND provider IN ('outlook', 'microsoft365')`, [addr])).rows;
  // Connected under the admin's own login, or not used at all. A copy of this
  // address under any other login is never read.
  const acct = rows.find((r) => String(r.user_id) === String(admin.id));
  if (!acct) {
    return { ok: false, why: rows.length
      ? `${addr} is connected, but not under the admin login (${CA.adminEmail()}); connect it from this page while signed in as the admin`
      : `${addr} is not connected yet: connect it from this page (mail and calendar)` };
  }
  const scopes = Array.isArray(acct.granted_scopes) ? acct.granted_scopes : String(acct.granted_scopes || '').split(/[\s,]+/);
  return {
    ok: true, account: acct, admin, address: addr,
    canRead: scopes.some((s) => /Mail\.Read(Write)?$/i.test(String(s))),
    canCalendar: scopes.some((s) => /Calendars\.Read(Write)?$/i.test(String(s))),
    status: acct.status || null,
  };
}
async function adminRow(pool) {
  const email = require('./coldAgent').adminEmail();
  return (await pool.query(`SELECT id, name, email, signature_text, scheduling_url FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email])).rows[0] || null;
}

// A Graph GET on THIS mailbox's token, following @odata.nextLink.
async function graphAll(mb, path, { headers, deps } = {}) {
  if (deps && deps.graph) return deps.graph(path, { address: mb.address, accountId: mb.account.id });
  const emailStore = require('./emailStore');
  const full = await emailStore.getEmailAccountWithTokens(mb.account.id);
  if (!full || !full.accessToken) throw new Error('could not read the mailbox token; reconnect it');
  const out = [];
  let url = GRAPH + path, pages = 0;
  while (url && pages < MAX_PAGES) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + full.accessToken, ...(headers || {}) } });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (_) { j = null; }
    if (!r.ok) {
      const e = new Error(`Graph ${r.status}: ${(j && j.error && (j.error.code + ': ' + j.error.message)) || text.slice(0, 200)}`);
      e.status = r.status;
      throw e;
    }
    out.push(...((j && j.value) || []));
    url = j && j['@odata.nextLink'];
    pages++;
  }
  return out;
}

async function readMail(mb, since, deps) {
  const iso = new Date(since).toISOString();
  return graphAll(mb, `/me/messages?$filter=receivedDateTime ge ${iso}&$orderby=receivedDateTime desc&$top=100`
    + '&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isDraft', { deps });
}
async function readCalendar(mb, since, until, deps) {
  return graphAll(mb, `/me/calendarView?startDateTime=${new Date(since).toISOString()}&endDateTime=${new Date(until).toISOString()}&$top=100`
    + '&$select=id,subject,start,end,attendees,organizer,isOnlineMeeting,onlineMeetingProvider,bodyPreview,isCancelled,responseStatus',
  { headers: { Prefer: 'outlook.timezone="UTC"' }, deps });
}

// ── IS THIS MEETING A NILDASH SALES CALL? ───────────────────────────────────
// Clearly, or not at all: a Calendly booking or a Teams meeting, AND the
// title or invite names NILDash or NIL (a Calendly booking may say "demo").
function salesCall(ev) {
  const text = `${ev.subject || ''}\n${ev.bodyPreview || ''}`;
  const calendly = /calendly/i.test(text) || (ev.organizer && /calendly/i.test(JSON.stringify(ev.organizer)));
  const teams = String(ev.onlineMeetingProvider || '') === 'teamsForBusiness' || /teams\.microsoft\.com\/l\/meetup-join|Microsoft Teams meeting/i.test(text);
  if (!calendly && !teams) return { ok: false, why: 'not a Calendly or Teams meeting' };
  const nil = /nil\s?dash|\bNIL\b/i.test(text);
  if (!nil && !(calendly && /\bdemo\b/i.test(text))) return { ok: false, why: 'does not say NILDash' };
  return { ok: true, via: calendly ? 'Calendly' : 'Teams' };
}

function companyOf(domain) {
  if (!domain || FREEMAIL.has(domain)) return null;
  const label = domain.split('.').slice(0, -1).join('.') || domain;
  return label.split(/[.-]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── TABLES ──────────────────────────────────────────────────────────────────
let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS mailbox_prospects (
      id SERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, company TEXT, domain TEXT,
      via TEXT, last_spoke_at TIMESTAMPTZ, last_spoke_how TEXT, last_subject TEXT,
      last_in_at TIMESTAMPTZ, last_out_at TIMESTAMPTZ, last_meeting_at TIMESTAMPTZ, anchor_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'open', stop_reason TEXT, next_due_at TIMESTAMPTZ, state_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS mailbox_prospect_people (
      id SERIAL PRIMARY KEY, prospect_id INTEGER NOT NULL, email TEXT UNIQUE NOT NULL, name TEXT,
      last_spoke_at TIMESTAMPTZ, last_in_at TIMESTAMPTZ, last_out_at TIMESTAMPTZ, via TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS mailbox_prospect_drafts (
      id TEXT PRIMARY KEY, prospect_id INTEGER NOT NULL, email TEXT NOT NULL, name TEXT,
      subject TEXT, body_text TEXT, touch_no INTEGER NOT NULL, anchor_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending', status_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ, sent_at TIMESTAMPTZ,
      send_claimed_at TIMESTAMPTZ, send_error TEXT)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS mailbox_prospect_drafts_p ON mailbox_prospect_drafts (prospect_id, created_at DESC)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS mailbox_prospect_runs (
      id SERIAL PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
      messages INTEGER, meetings INTEGER, prospects INTEGER, drafted INTEGER, stopped INTEGER, note TEXT)`);
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

// ── WHO COUNTS ──────────────────────────────────────────────────────────────
async function filters(pool, mb) {
  const CA = require('./coldAgent');
  const settings = await CA.getSettings(pool).catch(() => ({ excludeEmails: [], excludeNames: [] }));
  const users = new Set((await pool.query(`SELECT LOWER(TRIM(email)) AS e FROM users WHERE email IS NOT NULL`)).rows.map((r) => r.e));
  const own = domainOf(mb.address);
  const internal = (addr, name) => {
    const a = lc(addr), d = domainOf(a);
    if (a === mb.address || d === own || d.endsWith('.' + own)) return 'internal (the mailbox\'s own domain)';
    return CA.isInternal({ email: a, name: name || '' }, settings);
  };
  return { users, internal };
}

// ── READ AND RECORD ─────────────────────────────────────────────────────────
// Builds the people and prospects from the mailbox. Returns counts.
async function collect(pool, mb, { now, deps } = {}) {
  const t = now ? new Date(now) : new Date();
  const since = new Date(t.getTime() - LOOKBACK_DAYS * DAY);
  const { users, internal } = await filters(pool, mb);
  const people = new Map();     // email -> { name, lastIn, lastOut, lastMeeting, firstAt, subject, outCount }
  const touch = (addr, name) => {
    const a = lc(addr);
    if (!people.has(a)) people.set(a, { email: a, name: null, lastIn: null, lastOut: null, lastMeeting: null, outCount: 0, subject: null, subjectAt: null, via: new Set() });
    const p = people.get(a);
    if (name && !p.name && !/@/.test(name)) p.name = String(name).trim().slice(0, 120);
    return p;
  };
  const later = (a, b) => (!a ? b : !b ? a : (new Date(b) > new Date(a) ? b : a));
  // OUR sends, matched by address, subject AND time: the admin's own reply
  // in the same thread carries the same "Re:" subject and must still count.
  const oursRows = (await pool.query(
    `SELECT LOWER(email) AS e, LOWER(COALESCE(subject, '')) AS s, sent_at FROM mailbox_prospect_drafts WHERE status = 'sent'`)).rows;
  const isOurs = (a, subject, at) => oursRows.some((r) => r.e === a && r.s === lc(subject) && Math.abs(new Date(r.sent_at) - new Date(at)) < 15 * 60000);

  let messages = [];
  if (mb.canRead) messages = await readMail(mb, since, deps);
  for (const m of messages) {
    if (m.isDraft) continue;
    const from = lc(m.from && m.from.emailAddress && m.from.emailAddress.address);
    const at = m.sentDateTime || m.receivedDateTime;
    const subject = m.subject || '';
    if (from === mb.address) {
      for (const r of [...(m.toRecipients || []), ...(m.ccRecipients || [])]) {
        const a = lc(r.emailAddress && r.emailAddress.address);
        if (!a || a === mb.address) continue;
        const p = touch(a, r.emailAddress.name);
        // One of OUR follow-ups is not the admin speaking: it never resets
        // the silence it was sent into.
        if (isOurs(a, subject, at)) continue;
        p.lastOut = later(p.lastOut, at); p.outCount++; p.via.add('email');
        if (!p.subjectAt || new Date(at) > new Date(p.subjectAt)) { p.subject = subject; p.subjectAt = at; }
      }
    } else if (from) {
      const p = touch(from, m.from.emailAddress.name);
      p.lastIn = later(p.lastIn, at); p.via.add('email');
      if (!p.subjectAt || new Date(at) > new Date(p.subjectAt)) { p.subject = subject; p.subjectAt = at; }
    }
  }

  let meetings = 0;
  if (mb.canCalendar) {
    const events = await readCalendar(mb, since, t, deps);
    for (const ev of events) {
      if (ev.isCancelled) continue;
      const end = ev.end && ev.end.dateTime ? new Date(ev.end.dateTime + (/Z$|[+-]\d\d:?\d\d$/.test(ev.end.dateTime) ? '' : 'Z')) : null;
      if (!end || end > t) continue;                     // held, not upcoming
      if (ev.responseStatus && ev.responseStatus.response === 'declined') continue;
      const sc = salesCall(ev);
      if (!sc.ok) continue;
      let any = false;
      for (const at of ev.attendees || []) {
        if (at.type === 'resource') continue;
        if (at.status && at.status.response === 'declined') continue;
        const a = lc(at.emailAddress && at.emailAddress.address);
        if (!a || a === mb.address) continue;
        const p = touch(a, at.emailAddress.name);
        p.lastMeeting = later(p.lastMeeting, end.toISOString()); p.via.add(sc.via);
        if (!p.subjectAt || end > new Date(p.subjectAt)) { p.subject = ev.subject || 'NILDash call'; p.subjectAt = end.toISOString(); }
        any = true;
      }
      if (any) meetings++;
    }
  }

  // Keep: a person, not a machine, not internal, not a user, and someone the
  // admin actually spoke with (wrote to, or met on a sales call).
  const kept = [];
  for (const p of people.values()) {
    if (isMachine(p.email)) continue;
    if (internal(p.email, p.name)) continue;
    if (users.has(p.email)) continue;
    if (!p.outCount && !p.lastMeeting) continue;
    kept.push(p);
  }

  // One prospect per company domain; a personal address is its own.
  const groups = new Map();
  for (const p of kept) {
    const d = domainOf(p.email);
    const key = FREEMAIL.has(d) ? p.email : d;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [key, list] of groups) {
    const maxOf = (f) => list.map((p) => p[f]).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
    const lastIn = maxOf('lastIn'), lastOut = maxOf('lastOut'), lastMeeting = maxOf('lastMeeting');
    const cands = [[lastIn, 'they emailed'], [lastOut, 'you emailed'], [lastMeeting, 'meeting']].filter((x) => x[0]).sort((a, b) => new Date(b[0]) - new Date(a[0]));
    const lastSpoke = cands[0];
    const subj = list.slice().sort((a, b) => new Date(b.subjectAt || 0) - new Date(a.subjectAt || 0))[0].subject || null;
    const via = [...new Set(list.flatMap((p) => [...p.via]))].join(', ');
    const d = domainOf(list[0].email);
    const row = (await pool.query(
      `INSERT INTO mailbox_prospects (key, company, domain, via, last_spoke_at, last_spoke_how, last_subject, last_in_at, last_out_at, last_meeting_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (key) DO UPDATE SET company = COALESCE(mailbox_prospects.company, EXCLUDED.company), via = EXCLUDED.via,
         last_spoke_at = GREATEST(mailbox_prospects.last_spoke_at, EXCLUDED.last_spoke_at),
         last_spoke_how = CASE WHEN EXCLUDED.last_spoke_at >= COALESCE(mailbox_prospects.last_spoke_at, EXCLUDED.last_spoke_at) THEN EXCLUDED.last_spoke_how ELSE mailbox_prospects.last_spoke_how END,
         last_subject = COALESCE(EXCLUDED.last_subject, mailbox_prospects.last_subject),
         last_in_at = GREATEST(mailbox_prospects.last_in_at, EXCLUDED.last_in_at),
         last_out_at = GREATEST(mailbox_prospects.last_out_at, EXCLUDED.last_out_at),
         last_meeting_at = GREATEST(mailbox_prospects.last_meeting_at, EXCLUDED.last_meeting_at),
         updated_at = NOW()
       RETURNING id`,
      [key, companyOf(d), FREEMAIL.has(d) ? null : d, via, lastSpoke[0], lastSpoke[1], subj, lastIn, lastOut, lastMeeting])).rows[0];
    for (const p of list) {
      await pool.query(
        `INSERT INTO mailbox_prospect_people (prospect_id, email, name, last_spoke_at, last_in_at, last_out_at, via, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, mailbox_prospect_people.name),
           last_spoke_at = GREATEST(mailbox_prospect_people.last_spoke_at, EXCLUDED.last_spoke_at),
           last_in_at = GREATEST(mailbox_prospect_people.last_in_at, EXCLUDED.last_in_at),
           last_out_at = GREATEST(mailbox_prospect_people.last_out_at, EXCLUDED.last_out_at), via = EXCLUDED.via, updated_at = NOW()`,
        [row.id, p.email, p.name, [p.lastIn, p.lastOut, p.lastMeeting].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0], p.lastIn, p.lastOut, [...p.via].join(', ')]);
    }
  }
  return { messages: messages.length, meetings, prospects: groups.size };
}

// ── THE SEQUENCE ────────────────────────────────────────────────────────────
// The anchor is the admin's own last word: their last email or the meeting.
// Our follow-ups never move it. Touches are our sent follow-ups since it.
async function stateOf(pool, p, { now } = {}) {
  const t = now ? new Date(now) : new Date();
  const anchor = [p.last_out_at, p.last_meeting_at].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
  const sent = anchor ? (await pool.query(
    `SELECT touch_no, sent_at FROM mailbox_prospect_drafts WHERE prospect_id = $1 AND status = 'sent' AND sent_at > $2 ORDER BY sent_at`,
    [p.id, anchor])).rows : [];
  const lastOurs = sent.length ? sent[sent.length - 1].sent_at : null;
  const lastWord = [anchor, lastOurs].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
  if (p.status !== 'open') return { stop: p.stop_reason || p.status, anchor, sent };
  if (!anchor) return { stop: 'no email or meeting from you to follow', anchor, sent };
  // THEY WROTE LAST: their move is done, it is yours. Nothing is sent.
  if (p.last_in_at && new Date(p.last_in_at) > new Date(lastWord)) return { yourMove: true, stop: 'they replied ' + new Date(p.last_in_at).toISOString().slice(0, 10), anchor, sent };
  const touches = 1 + sent.length;
  if (touches >= MAX_TOUCHES) return { done: true, stop: 'three touches sent, no reply', anchor, sent };
  const next = touches + 1;
  const dueAt = new Date(new Date(lastWord).getTime() + GAP_DAYS[next] * DAY);
  return { next, dueAt, due: dueAt <= t, anchor, sent, lastWord };
}

// Live, against Graph: has anyone at this prospect written since `since`?
async function repliedLive(pool, mb, p, since, deps) {
  if (!mb.canRead) return null;
  const people = (await pool.query(`SELECT email FROM mailbox_prospect_people WHERE prospect_id = $1`, [p.id])).rows.map((r) => r.email);
  if (!people.length) return null;
  const iso = new Date(since).toISOString();
  const or = people.slice(0, 15).map((e) => `from/emailAddress/address eq '${e.replace(/'/g, "''")}'`).join(' or ');
  const hits = await graphAll(mb, `/me/messages?$filter=receivedDateTime ge ${iso} and (${or})&$top=5&$select=id,from,receivedDateTime,subject`, { deps });
  return hits.length ? hits[0] : null;
}

// ── THE WRITING (services/followUps' rules) ─────────────────────────────────
function firstOf(name) {
  const f = String(name || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'.-]{1,}$/.test(f) ? f.charAt(0).toUpperCase() + f.slice(1) : null;
}
function compose({ person, company, touch, senderFull, earlier }) {
  const FUP = require('./followUps');
  const who = company || 'you';
  const lines = touch === 2
    ? [
      [`One concrete next step for ${who}: send me your roster and I will load every athlete myself, so the first morning of local businesses, each with a named owner and a way to reach them, is waiting when you log in.`,
        `Here is the simplest way to see it on your own athletes: send me the roster and I will set every one up myself this week.`],
      ['Want me to set that up?', 'Shall I do that this week?'],
    ]
    : [
      [`A smaller way to start: one athlete for one week, and you judge it on what shows up each morning.`,
        `If the full roster is too much right now, one athlete for a week is enough to judge it.`],
      [`If this is not for ${who}, tell me and I will stop.`, 'If this is not a fit, tell me and I will stop.'],
    ];
  const chosen = lines.map((opts) => opts.find((l) => !FUP.reuses(l, earlier)) || null).filter(Boolean);
  const first = firstOf(person && person.name);
  const body = [first ? `Hi ${first},` : 'Hi,', chosen.join(' '), `${senderFull}\nNILDash`].join('\n\n');
  return body;
}
function subjectFor(p, touch) {
  const s = String(p.last_subject || '').trim();
  const base = s ? (/^re:/i.test(s) ? s : 'Re: ' + s) : `NILDash for ${p.company || 'you'}`;
  return touch >= 3 ? base.replace(/\s*\(last note\)$/i, '') + ' (last note)' : base;
}
function check({ subject, body, earlier, touch }) {
  const FUP = require('./followUps');
  const html = '<p>' + String(body).replace(/\n/g, '<br>') + '</p>';
  const problems = FUP.checkFollowUp({ subject, body: html, earlier, touch });
  if (/\[[^\]]+\]|\{\{|\}\}/.test(`${subject}\n${body}`)) problems.push('has a placeholder');
  return problems;
}

// ── ONE PASS: READ, RECORD, STOP, DRAFT ─────────────────────────────────────
async function run(pool, { now, deps = {} } = {}) {
  await ensureTables(pool);
  const mb = await mailbox(pool);
  if (!mb.ok) return { ok: false, why: mb.why };
  if (!mb.canRead && !mb.canCalendar) return { ok: false, why: `${mb.address} is connected without permission to read mail or the calendar; reconnect it from this page` };
  const runId = (await pool.query(`INSERT INTO mailbox_prospect_runs DEFAULT VALUES RETURNING id`)).rows[0].id;
  const out = { ok: true, runId, messages: 0, meetings: 0, prospects: 0, drafted: [], stopped: [], refused: [] };
  try {
    Object.assign(out, await collect(pool, mb, { now, deps }));
    const CA = require('./coldAgent');
    const settings = await CA.getSettings(pool).catch(() => ({}));
    const admin = mb.admin;
    const senderFull = settings.signName || String((admin && admin.name) || '').trim() || 'John Compton';
    const SUP = require('./suppression');
    const users = new Set((await pool.query(`SELECT LOWER(TRIM(email)) AS e FROM users WHERE email IS NOT NULL`)).rows.map((r) => r.e));
    const prospects = (await pool.query(`SELECT * FROM mailbox_prospects WHERE status = 'open'`)).rows;
    for (const p of prospects) {
      const people = (await pool.query(`SELECT * FROM mailbox_prospect_people WHERE prospect_id = $1 ORDER BY last_spoke_at DESC NULLS LAST`, [p.id])).rows;
      // Signed up since: a user now, not this group.
      if (people.some((x) => users.has(x.email))) { await setStatus(pool, p.id, 'user', 'signed up for NILDash'); out.stopped.push({ id: p.id, why: 'signed up' }); continue; }
      const st = await stateOf(pool, p, { now });
      const stopPending = async (why) => {
        const r = await pool.query(`UPDATE mailbox_prospect_drafts SET status = 'skipped', status_note = $2, decided_at = NOW() WHERE prospect_id = $1 AND status = 'pending' RETURNING id`, [p.id, 'not sent: ' + why]);
        if (r.rowCount) out.stopped.push({ id: p.id, why });
      };
      await pool.query(`UPDATE mailbox_prospects SET anchor_at = $2, next_due_at = $3, state_note = $4, updated_at = NOW() WHERE id = $1`,
        [p.id, st.anchor || null, st.dueAt || null, st.stop || (st.next ? `follow-up ${st.next - 1} due ${st.dueAt.toISOString().slice(0, 10)}` : null)]);
      if (st.stop) { await stopPending(st.stop); continue; }
      // The person to write to: the one the admin spoke with last, who is not suppressed.
      let to = null;
      for (const x of people) {
        const s = await SUP.isSuppressed(pool, x.email).catch(() => ({ suppressed: false }));
        if (!s.suppressed) { to = x; break; }
      }
      if (!to) { await setStatus(pool, p.id, 'stopped', 'every address bounced, unsubscribed or said no'); await stopPending('suppressed'); continue; }
      if (!st.due) continue;
      const pending = (await pool.query(`SELECT 1 FROM mailbox_prospect_drafts WHERE prospect_id = $1 AND status IN ('pending', 'sending')`, [p.id])).rowCount;
      if (pending) continue;
      const already = (await pool.query(`SELECT 1 FROM mailbox_prospect_drafts WHERE prospect_id = $1 AND touch_no = $2 AND anchor_at = $3 AND status IN ('sent', 'skipped')`, [p.id, st.next, st.anchor])).rowCount;
      if (already) continue;              // skipped by the admin: that touch is not offered again
      const earlier = (await pool.query(`SELECT body_text FROM mailbox_prospect_drafts WHERE prospect_id = $1 AND status = 'sent'`, [p.id])).rows
        .map((r) => '<p>' + String(r.body_text || '').replace(/\n/g, '<br>') + '</p>');
      const subject = subjectFor(p, st.next);
      const body = compose({ person: to, company: p.company, touch: st.next, senderFull, earlier });
      const problems = check({ subject, body, earlier, touch: st.next });
      if (problems.length) { out.refused.push({ id: p.id, why: problems.join('; ') }); continue; }
      const id = 'mbp_' + crypto.randomBytes(8).toString('hex');
      await pool.query(
        `INSERT INTO mailbox_prospect_drafts (id, prospect_id, email, name, subject, body_text, touch_no, anchor_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, p.id, to.email, to.name || null, subject, body, st.next, st.anchor]);
      out.drafted.push({ id, prospect: p.id, touch: st.next, to: to.email });
    }
    await pool.query(`UPDATE mailbox_prospect_runs SET finished_at = NOW(), messages = $2, meetings = $3, prospects = $4, drafted = $5, stopped = $6, note = $7 WHERE id = $1`,
      [runId, out.messages, out.meetings, out.prospects, out.drafted.length, out.stopped.length,
        `${out.prospects} conversations, ${out.drafted.length} follow-up(s) drafted` + (mb.canCalendar ? '' : '; calendar not connected')]);
  } catch (e) {
    await pool.query(`UPDATE mailbox_prospect_runs SET finished_at = NOW(), note = $2 WHERE id = $1`, [runId, 'failed: ' + String(e.message).slice(0, 300)]).catch(() => {});
    return { ok: false, why: e.message, runId };
  }
  return out;
}

async function setStatus(pool, id, status, why) {
  await pool.query(`UPDATE mailbox_prospects SET status = $2, stop_reason = $3, updated_at = NOW() WHERE id = $1`, [id, status, why]);
  await pool.query(`UPDATE mailbox_prospect_drafts SET status = 'skipped', status_note = $2, decided_at = NOW() WHERE prospect_id = $1 AND status = 'pending'`, [id, 'not sent: ' + why]);
}

// ── APPROVE, SEND, MARK ─────────────────────────────────────────────────────
// Approve answers at once and sends behind it (the cold agent's pattern).
// Every stop is checked again, including a live look at the mailbox.
async function approve(pool, draftId, { subject, body } = {}, deps = {}) {
  await ensureTables(pool);
  const d = (await pool.query(`SELECT * FROM mailbox_prospect_drafts WHERE id = $1`, [draftId])).rows[0];
  if (!d) return { ok: false, status: 404, error: 'no such draft' };
  if (d.status !== 'pending') return { ok: true, already: true, state: d.status };
  const subj = (typeof subject === 'string' && subject.trim()) ? subject.trim() : d.subject;
  const text = (typeof body === 'string' && body.trim()) ? body.trim() : d.body_text;
  const earlier = (await pool.query(`SELECT body_text FROM mailbox_prospect_drafts WHERE prospect_id = $1 AND status = 'sent'`, [d.prospect_id])).rows
    .map((r) => '<p>' + String(r.body_text || '').replace(/\n/g, '<br>') + '</p>');
  const problems = check({ subject: subj, body: text, earlier, touch: d.touch_no });
  if (problems.length) return { ok: false, status: 400, error: 'The email fails its checks: ' + problems.join('; ') };
  const why = await stopForSend(pool, d, deps);
  if (why) {
    await pool.query(`UPDATE mailbox_prospect_drafts SET status = 'skipped', status_note = $2, decided_at = NOW() WHERE id = $1`, [d.id, 'not sent: ' + why]);
    return { ok: false, status: 409, error: 'Not sent: ' + why + '.', state: 'skipped' };
  }
  const claim = await pool.query(
    `UPDATE mailbox_prospect_drafts SET status = 'sending', send_claimed_at = NOW(), decided_at = NOW(), subject = $2, body_text = $3
      WHERE id = $1 AND status = 'pending' RETURNING *`, [draftId, subj, text]);
  if (!claim.rowCount) return { ok: true, already: true, state: 'sending' };
  const job = sendOne(pool, claim.rows[0], deps).catch((e) => console.error('[mailbox-prospects] send crashed', draftId, e.message));
  if (deps.awaitSend) await job;
  return { ok: true, state: 'sending' };
}

// Every reason not to send, read fresh. Null when clear.
async function stopForSend(pool, d, deps = {}) {
  const p = (await pool.query(`SELECT * FROM mailbox_prospects WHERE id = $1`, [d.prospect_id])).rows[0];
  if (!p) return 'the prospect is gone';
  if (p.status !== 'open') return p.stop_reason || p.status;
  const sup = await require('./suppression').isSuppressed(pool, d.email).catch(() => ({ suppressed: false }));
  if (sup.suppressed) return sup.reason || 'the address is suppressed';
  if ((await pool.query(`SELECT 1 FROM users WHERE LOWER(TRIM(email)) = $1`, [lc(d.email)])).rowCount) return 'they are a NILDash user now';
  const st = await stateOf(pool, p);
  if (st.stop) return st.stop;
  const mb = await mailbox(pool);
  if (!mb.ok) return mb.why;
  // STOPS DEAD: a reply that has not been synced yet still stops it.
  const since = st.lastWord || st.anchor;
  let hit = null;
  try { hit = await repliedLive(pool, mb, p, since, deps); }
  catch (e) { return 'could not check the mailbox for a reply (' + e.message + '), so not sending'; }
  if (hit) {
    await pool.query(`UPDATE mailbox_prospects SET last_in_at = GREATEST(last_in_at, $2), last_spoke_at = GREATEST(last_spoke_at, $2), last_spoke_how = 'they emailed', updated_at = NOW() WHERE id = $1`,
      [p.id, hit.receivedDateTime]);
    return 'they replied ' + String(hit.receivedDateTime).slice(0, 10);
  }
  return null;
}

async function sendOne(pool, d, deps = {}) {
  const sendRules = require('./sendRules');
  const canSpam = require('./canSpam');
  const fail = async (msg) => {
    await pool.query(`UPDATE mailbox_prospect_drafts SET status = 'failed', send_error = $2, send_claimed_at = NULL WHERE id = $1`, [d.id, String(msg).slice(0, 300)]);
    return { ok: false, error: msg };
  };
  try {
    // At the moment of sending, once more: a reply in the last seconds stops it.
    const why = await stopForSend(pool, d, deps);
    if (why) {
      await pool.query(`UPDATE mailbox_prospect_drafts SET status = 'skipped', status_note = $2, send_claimed_at = NULL WHERE id = $1`, [d.id, 'not sent: ' + why]);
      return { ok: false, error: why };
    }
    const rule = await sendRules.check(pool, { email: d.email, subject: d.subject, system: SYSTEM, refId: d.id });
    if (!rule.ok) return fail('Not sent: ' + rule.reason);
    const CA = require('./coldAgent');
    const html = canSpam.appendHtml(CA.textToHtml(d.body_text), d.email,
      { why: 'You received this because we spoke about NILDash.' });
    if (deps.send) await deps.send({ to: d.email, subject: d.subject, html, text: d.body_text });
    else {
      // FROM THIS MAILBOX, the one the conversation happened in.
      const mb = await mailbox(pool);
      if (!mb.ok) return fail(mb.why);
      const full = await require('./emailStore').getEmailAccountWithTokens(mb.account.id);
      await require('./providers/outlook').sendEmail(full.accessToken, full.refreshToken, { to: [d.email], subject: d.subject, bodyHtml: html });
    }
    await pool.query(`UPDATE mailbox_prospect_drafts SET status = 'sent', sent_at = NOW(), send_claimed_at = NULL, send_error = NULL WHERE id = $1`, [d.id]);
    await sendRules.record(pool, { email: d.email, subject: d.subject, system: SYSTEM, agentId: 'nildash-mailbox-prospects', refId: d.id });
    return { ok: true };
  } catch (e) {
    return fail('Send failed: ' + (e.message || 'unknown'));
  }
}

async function skip(pool, draftId, note) {
  await ensureTables(pool);
  const r = await pool.query(`UPDATE mailbox_prospect_drafts SET status = 'skipped', status_note = $2, decided_at = NOW()
                               WHERE id = $1 AND status IN ('pending', 'failed') RETURNING id`, [draftId, note || 'skipped by the admin']);
  return { ok: !!r.rowCount };
}

// no: suppressed for every sender. customer: won, out of this group.
// exclude: never a prospect again (a person, or the whole company).
async function mark(pool, prospectId, as) {
  await ensureTables(pool);
  const p = (await pool.query(`SELECT * FROM mailbox_prospects WHERE id = $1`, [prospectId])).rows[0];
  if (!p) return { ok: false, error: 'no such prospect' };
  const reasons = { no: 'they said no', customer: 'became a customer', exclude: 'excluded by the admin', replied: 'they replied' };
  if (!reasons[as]) return { ok: false, error: 'as must be no, customer, exclude or replied' };
  if (as === 'no') {
    const people = (await pool.query(`SELECT email FROM mailbox_prospect_people WHERE prospect_id = $1`, [p.id])).rows;
    for (const x of people) await require('./sendRules').suppressManually(pool, x.email, { reason: 'mailbox prospect: they said no', kind: 'unsubscribe', by: null }).catch(() => {});
  }
  await setStatus(pool, p.id, as === 'customer' ? 'won' : as === 'exclude' ? 'excluded' : as === 'replied' ? 'replied' : 'stopped', reasons[as]);
  return { ok: true };
}

// ── THE PAGE: "Talked to, no deal", newest silence first ────────────────────
async function list(pool) {
  await ensureTables(pool);
  const ps = (await pool.query(
    `SELECT * FROM mailbox_prospects WHERE status IN ('open', 'replied', 'stopped') ORDER BY last_spoke_at DESC NULLS LAST LIMIT 200`)).rows;
  const ids = ps.map((p) => p.id);
  const people = ids.length ? (await pool.query(`SELECT * FROM mailbox_prospect_people WHERE prospect_id = ANY($1) ORDER BY last_spoke_at DESC NULLS LAST`, [ids])).rows : [];
  const drafts = ids.length ? (await pool.query(`SELECT * FROM mailbox_prospect_drafts WHERE prospect_id = ANY($1) ORDER BY created_at DESC`, [ids])).rows : [];
  return ps.map((p) => ({
    ...p,
    people: people.filter((x) => x.prospect_id === p.id).map((x) => ({ email: x.email, name: x.name, lastSpokeAt: x.last_spoke_at, via: x.via })),
    drafts: drafts.filter((x) => x.prospect_id === p.id),
    pending: drafts.find((x) => x.prospect_id === p.id && (x.status === 'pending' || x.status === 'sending' || x.status === 'failed')) || null,
  }));
}
async function status(pool) {
  await ensureTables(pool);
  const mb = await mailbox(pool);
  const last = (await pool.query(`SELECT * FROM mailbox_prospect_runs ORDER BY id DESC LIMIT 1`)).rows[0] || null;
  return { address: mailboxAddress(), connected: !!mb.ok, why: mb.ok ? null : mb.why, canRead: !!mb.canRead, canCalendar: !!mb.canCalendar,
    available: require('./providers/outlook').isAvailable(), lastRun: last };
}

module.exports = {
  LOOKBACK_DAYS, GAP_DAYS, MAX_TOUCHES, SYSTEM, FREEMAIL,
  mailboxAddress, mailbox, isMachine, salesCall, companyOf, ensureTables, collect, stateOf, repliedLive,
  compose, subjectFor, check, run, approve, stopForSend, sendOne, skip, mark, list, status,
};
