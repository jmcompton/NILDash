'use strict';
// ── SENDING A CUSTOMER'S LEADS FROM THEIR OWN MAILBOX ───────────────────────
//
// Territory and Done For You: every weekly batch (services/prospector/
// delivery) is queued here and sent from the customer's connected Microsoft
// 365 mailbox (services/prospector/mailboxes), in their name, with two
// follow-ups (day 3, day 7) in the same thread. A reply of any kind stops that
// business's emails; replies land in the customer's own inbox.
//
// Limits, per customer mailbox: weekdays 9:00 to 16:00 Central, 4 minutes
// apart, 10 a day on the first sending day and 3 more each day after, to 30
// (Territory) or 50 (Done For You). Follow-ups count.
//
// Every email carries the customer's business mailing address and an
// unsubscribe link that feeds the shared suppression list (CAN-SPAM); with no
// address on file, nothing is sent and their page asks for it.
//
// Bounces over 5% (20 sends or more) pause that customer and tell JohnMark.
// The guarantee (3 replies in the first 30 days of sending) is checked once a
// day; a miss tells JohnMark so the next month can be credited.
//
// Idle unless PROSPECTOR_CUSTOMER_SEND_ON.

const MB = require('../salesMailbox');
const SR = require('../salesReplies');
const canSpam = require('../canSpam');
const suppression = require('../suppression');
const Billing = require('./billing');
const Mailboxes = require('./mailboxes');

const lc = (s) => String(s || '').trim().toLowerCase();
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const yes = (k) => /^(1|true|yes|on)$/i.test(String(process.env[k] || '').trim());
const ON = () => yes('PROSPECTOR_CUSTOMER_SEND_ON');
const CENTRAL = 'America/Chicago';
const WINDOW_FROM = 9 * 60, WINDOW_TO = 16 * 60;
const GAP_MS = 4 * 60000;
const WARMUP_START = 10, WARMUP_STEP = 3;
const CAPS = { territory: 30, dfy: 50 };
const FOLLOW_UP_DAYS = [3, 7];
const BOUNCE_LIMIT = 0.05, BOUNCE_MIN = 20;
const GUARANTEE_REPLIES = 3, GUARANTEE_DAYS = 30;
const LIVE = ['active', 'trialing'];
const firstWord = (n) => clip(n, 60).split(/\s+/)[0] || '';

let _ensured = false;
async function ensureTables(pool) {
  if (_ensured) return;
  await Mailboxes.ensureTables(pool);
  await pool.query(`ALTER TABLE prospector_customers ADD COLUMN IF NOT EXISTS mailing_address TEXT`);
  await pool.query(`ALTER TABLE prospector_customers ADD COLUMN IF NOT EXISTS sending_paused TEXT`);
  await pool.query(`ALTER TABLE prospector_customers ADD COLUMN IF NOT EXISTS guarantee_checked_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE prospector_mailboxes ADD COLUMN IF NOT EXISTS inbox_cursor TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE prospector_mailboxes ADD COLUMN IF NOT EXISTS limited_on TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_sends (
    id SERIAL PRIMARY KEY, customer_id INT NOT NULL REFERENCES prospector_customers(id) ON DELETE CASCADE,
    lead_id INT, batch_id INT, email TEXT NOT NULL, first_name TEXT, business TEXT, subject TEXT NOT NULL, body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', step INT NOT NULL DEFAULT 0, next_at TIMESTAMPTZ, sending_at TIMESTAMPTZ,
    message_id TEXT, conversation_id TEXT, first_sent_at TIMESTAMPTZ, last_sent_at TIMESTAMPTZ,
    replied_at TIMESTAMPTZ, reply_tag TEXT, reply_text TEXT, stop_reason TEXT, errors INT NOT NULL DEFAULT 0, last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (customer_id, email))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS prospector_sends_due ON prospector_sends (customer_id, state, next_at)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_send_events (
    id SERIAL PRIMARY KEY, customer_id INT, send_id INT, kind TEXT NOT NULL, step INT, detail TEXT, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS prospector_send_events_c ON prospector_send_events (customer_id, kind, at)`);
  _ensured = true;
}
async function event(pool, customerId, sendId, kind, extra = {}) {
  await pool.query(`INSERT INTO prospector_send_events (customer_id, send_id, kind, step, detail, at) VALUES ($1,$2,$3,$4,$5,COALESCE($6, NOW()))`,
    [customerId, sendId || null, kind, extra.step == null ? null : extra.step, extra.detail == null ? null : clip(extra.detail, 1000),
      extra.at ? new Date(extra.at) : null]).catch(() => {});
}
function central(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}
const sends = (c) => { const p = Billing.plan(c && c.plan); return !!(p && p.sends); };

// ── THE WORDS ───────────────────────────────────────────────────────────────
function followUp(c, s, n) {
  const greet = firstWord(s.first_name) ? `Hi ${firstWord(s.first_name)},` : 'Hi,';
  const me = firstWord(c.sender_name) || clip(c.company, 80);
  if (n === 1) return `${greet}\n\nFollowing up on my note about ${clip(s.business, 120) || 'your'} email setup. Happy to take a quick look at no charge if it's useful.\n\n${me}`;
  return `${greet}\n\nLast note from me on this. If email security isn't a priority right now, no problem. If it becomes one, I'm a reply away.\n\n${me}`;
}
function withFooter(c, s, text) {
  return canSpam.appendText(text, s.email, { address: c.mailing_address,
    why: `You received this because ${clip(c.company, 120) || 'we'} works with businesses in ${clip(c.area, 120) || 'your area'}.` });
}
// Why this customer cannot send right now, in their words, or null.
function blocker(c, mb) {
  if (!sends(c)) return 'This plan does not include sending.';
  if (!LIVE.includes(c.status)) return `The subscription is ${c.status}.`;
  if (c.sending_paused) return 'Paused: ' + c.sending_paused;
  if (!clip(c.mailing_address, 300)) return 'Add your business mailing address. The law requires it at the bottom of every email we send for you.';
  if (!mb || !mb.ok) return 'Connect your mailbox so we can send from it.';
  if (!mb.canSend) return 'Your mailbox was connected without permission to send. Connect it again and accept every permission.';
  return null;
}

// ── QUEUEING A BATCH ────────────────────────────────────────────────────────
// The leads of one batch that have a person to write to and a written email.
async function queueBatch(pool, customer, batchId) {
  await ensureTables(pool);
  if (!sends(customer)) return { queued: 0 };
  const rows = (await pool.query(`SELECT l.* FROM prospector_delivered d JOIN prospector_leads l ON l.id = d.lead_id
    WHERE d.customer_id = $1 AND d.batch_id = $2`, [customer.id, batchId])).rows;
  let n = 0;
  for (const l of rows) {
    const to = lc(l.person && l.person.email);
    const e = l.email || {};
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(to) || !e.subject || !e.body) continue;
    if ((await suppression.isSuppressed(pool, to)).suppressed) continue;
    const r = await pool.query(`INSERT INTO prospector_sends (customer_id, lead_id, batch_id, email, first_name, business, subject, body)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (customer_id, email) DO NOTHING`,
    [customer.id, l.id, batchId, to, (l.person && l.person.first) || null, l.business, clip(e.subject, 200), String(e.body).slice(0, 6000)]);
    n += r.rowCount;
  }
  return { queued: n };
}

// ── SENDING ─────────────────────────────────────────────────────────────────
async function capFor(pool, c, today) {
  const r = (await pool.query(`SELECT
      COUNT(DISTINCT (at AT TIME ZONE '${CENTRAL}')::date) FILTER (WHERE (at AT TIME ZONE '${CENTRAL}')::date < $2::date)::int AS before,
      COUNT(*) FILTER (WHERE (at AT TIME ZONE '${CENTRAL}')::date = $2::date)::int AS today, MAX(at) AS last
    FROM prospector_send_events WHERE kind = 'sent' AND customer_id = $1`, [c.id, today])).rows[0] || {};
  return { day: (r.before || 0) + 1, cap: Math.min(CAPS[c.plan] || 30, WARMUP_START + WARMUP_STEP * (r.before || 0)), sentToday: r.today || 0, last: r.last || null };
}

// One tick: at most one email per customer mailbox. Follow-ups first.
async function sendTick(pool, { now = new Date(), deps = {} } = {}) {
  await ensureTables(pool);
  if (!ON() && !deps.force) return { skipped: 'PROSPECTOR_CUSTOMER_SEND_ON is off' };
  const t = central(now);
  if (t.weekday === 'Sat' || t.weekday === 'Sun') return { skipped: 'weekend' };
  if (t.minutes < WINDOW_FROM || t.minutes >= WINDOW_TO) return { skipped: 'outside 9:00 to 16:00 Central' };
  const list = (await pool.query(`SELECT c.*, m.limited_on FROM prospector_customers c JOIN prospector_mailboxes m ON m.customer_id = c.id
    WHERE c.status = ANY($1::text[]) AND m.status = 'active' AND EXISTS (SELECT 1 FROM prospector_sends s WHERE s.customer_id = c.id
      AND (s.state = 'queued' OR s.state = 'active' AND s.next_at <= $2))`, [LIVE, now])).rows;
  const out = [];
  for (const c of list) {
    if (c.limited_on === t.date) continue;
    const mb = deps.account ? await deps.account(c.id) : await Mailboxes.account(pool, c.id);
    const why = blocker(c, mb);
    if (why) { out.push({ customer: c.id, skipped: why }); continue; }
    const cap = await capFor(pool, c, t.date);
    if (cap.sentToday >= cap.cap) { out.push({ customer: c.id, skipped: 'daily cap' }); continue; }
    if (cap.last && new Date(now) - new Date(cap.last) < GAP_MS) continue;
    const s = (await pool.query(`SELECT * FROM prospector_sends WHERE customer_id = $1 AND (state = 'active' AND next_at <= $2 OR state = 'queued')
        AND (sending_at IS NULL OR sending_at < $2::timestamptz - INTERVAL '10 minutes')
      ORDER BY (state = 'active') DESC, next_at NULLS LAST, id LIMIT 1`, [c.id, now])).rows[0];
    if (!s) continue;
    out.push(await sendOne(pool, c, mb, s, { now, deps, today: t.date }));
  }
  return { sent: out };
}

async function sendOne(pool, c, mb, s, { now, deps = {}, today }) {
  const claim = await pool.query(`UPDATE prospector_sends SET sending_at = $2 WHERE id = $1 AND state = $3 AND step = $4
    AND (sending_at IS NULL OR sending_at < $2::timestamptz - INTERVAL '10 minutes') RETURNING id`, [s.id, now, s.state, s.step]);
  if (!claim.rowCount) return { id: s.id, skipped: 'taken' };
  if ((await suppression.isSuppressed(pool, s.email)).suppressed) {
    await stop(pool, s, 'on the suppression list', now);
    return { id: s.id, skipped: 'suppressed' };
  }
  const M = deps.mail || MB;
  const g = deps.graphDeps || {};
  const step = s.step + 1;
  try {
    if (step === 1) {
      const r = await M.sendNew(mb, { to: s.email, subject: s.subject, text: withFooter(c, s, s.body) }, g);
      await pool.query(`UPDATE prospector_sends SET state = 'active', step = 1, message_id = $2, conversation_id = $3, first_sent_at = $4,
          last_sent_at = $4, next_at = $5, sending_at = NULL, errors = 0, last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [s.id, r.messageId || null, r.conversationId || null, now, new Date(new Date(now).getTime() + FOLLOW_UP_DAYS[0] * 86400000)]);
    } else {
      let messageId = s.message_id;
      if (!messageId) {
        const f = await M.findSent(mb, { to: s.email, subject: s.subject, since: new Date(new Date(s.first_sent_at || now).getTime() - 3600000) }, g).catch(() => null);
        if (f) { messageId = f.messageId; await pool.query(`UPDATE prospector_sends SET message_id = $2, conversation_id = COALESCE(conversation_id, $3) WHERE id = $1`, [s.id, f.messageId, f.conversationId]); }
      }
      const text = withFooter(c, s, followUp(c, s, step - 1));
      if (messageId) await M.reply(mb, { messageId, to: s.email, text }, g);
      else await M.sendNew(mb, { to: s.email, subject: 'Re: ' + s.subject, text }, g);
      const last = step === 1 + FOLLOW_UP_DAYS.length;
      await pool.query(`UPDATE prospector_sends SET step = $2, state = $3, last_sent_at = $4, next_at = $5, sending_at = NULL, errors = 0,
          last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [s.id, step, last ? 'done' : 'active', now, last ? null : new Date(new Date(s.first_sent_at || now).getTime() + FOLLOW_UP_DAYS[step - 1] * 86400000)]);
    }
    await event(pool, c.id, s.id, 'sent', { step, at: now });
    return { id: s.id, customer: c.id, step };
  } catch (e) {
    await pool.query(`UPDATE prospector_sends SET sending_at = NULL WHERE id = $1`, [s.id]);
    if (MB.isSendLimit(e)) {
      await pool.query(`UPDATE prospector_mailboxes SET limited_on = $2 WHERE customer_id = $1`, [c.id, today]);
      await event(pool, c.id, s.id, 'limited', { detail: e.message, at: now });
      await tell({ subject: `Prospector: ${c.company || c.email}'s mailbox was limited by Microsoft`, text: `${mb.address} stopped for today: ${e.message}\nIt resumes tomorrow.` }, deps);
      return { id: s.id, error: 'mailbox limited' };
    }
    const errors = (s.errors || 0) + 1;
    await pool.query(`UPDATE prospector_sends SET errors = $2, last_error = $3, next_at = CASE WHEN state = 'active' THEN $4::timestamptz ELSE next_at END,
      updated_at = NOW() WHERE id = $1`, [s.id, errors, clip(e.message, 300), new Date(new Date(now).getTime() + 3600000)]);
    await event(pool, c.id, s.id, 'error', { step, detail: e.message, at: now });
    if (errors >= 3) await stop(pool, s, '3 send errors in a row: ' + clip(e.message, 200), now);
    return { id: s.id, error: e.message };
  }
}
async function stop(pool, s, reason, at) {
  await pool.query(`UPDATE prospector_sends SET state = 'stopped', stop_reason = $2, next_at = NULL, sending_at = NULL, updated_at = NOW()
    WHERE id = $1`, [s.id, clip(reason, 300)]);
  await event(pool, s.customer_id, s.id, 'stopped', { detail: reason, at });
}
async function tell(msg, deps = {}) {
  try { return deps.alert ? await deps.alert(msg) : await require('../salesAutopilot').alert(msg); }
  catch (e) { console.error('[prospector-send] alert failed:', e.message); return null; }
}

// ── REPLIES AND BOUNCES ─────────────────────────────────────────────────────
async function scanReplies(pool, { now = new Date(), deps = {} } = {}) {
  await ensureTables(pool);
  if (!ON() && !deps.force) return { skipped: 'PROSPECTOR_CUSTOMER_SEND_ON is off' };
  const list = (await pool.query(`SELECT c.*, m.inbox_cursor FROM prospector_customers c JOIN prospector_mailboxes m ON m.customer_id = c.id
    WHERE m.status = 'active' AND EXISTS (SELECT 1 FROM prospector_sends s WHERE s.customer_id = c.id AND s.step > 0)`)).rows;
  const M = deps.mail || MB;
  const report = { customers: 0, replies: 0, bounces: 0 };
  for (const c of list) {
    const mb = deps.account ? await deps.account(c.id) : await Mailboxes.account(pool, c.id);
    if (!mb || !mb.ok || !mb.canRead) continue;
    const since = c.inbox_cursor ? new Date(c.inbox_cursor) : new Date(new Date(now).getTime() - 2 * 86400000);
    let msgs;
    try { msgs = await M.inboxSince(mb, since, deps.graphDeps || {}); } catch (e) { console.error('[prospector-send] inbox:', e.message); continue; }
    report.customers++;
    let latest = since;
    for (const m of msgs) {
      const at = new Date(m.receivedDateTime || now);
      if (at > latest) latest = at;
      const r = await onMessage(pool, c, mb, m, { now, deps }).catch((e) => { console.error('[prospector-send] message:', e.message); return null; });
      if (r === 'reply') report.replies++;
      if (r === 'bounce') report.bounces++;
    }
    await pool.query(`UPDATE prospector_mailboxes SET inbox_cursor = $2 WHERE customer_id = $1`, [c.id, new Date(latest.getTime() + 1000)]);
    await bounceCheck(pool, c, { now, deps });
  }
  return report;
}

async function onMessage(pool, c, mb, m, { now, deps }) {
  const M = deps.mail || MB;
  const text = (M.textOf || MB.textOf)(m);
  const from = (M.fromOf || MB.fromOf)(m);
  if (SR.isBounce(m)) {
    if (SR.NDR_LIMIT.test(text)) {
      await pool.query(`UPDATE prospector_mailboxes SET limited_on = $2 WHERE customer_id = $1`, [c.id, central(now).date]);
      return 'limited';
    }
    const emails = [...new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(lc))].filter((e) => e !== lc(mb.address));
    if (!emails.length) return 'ignored';
    const s = (await pool.query(`SELECT * FROM prospector_sends WHERE customer_id = $1 AND email = ANY($2::text[]) AND step > 0 LIMIT 1`, [c.id, emails])).rows[0];
    if (!s) return 'ignored';
    await suppression.suppress(pool, s.email, { reason: 'Prospector customer send bounced', kind: 'bounce' });
    await stop(pool, s, 'bounced', now);
    await event(pool, c.id, s.id, 'bounce', { at: now });
    return 'bounce';
  }
  let s = (await pool.query(`SELECT * FROM prospector_sends WHERE customer_id = $1 AND email = $2 AND step > 0`, [c.id, from])).rows[0];
  if (!s && m.conversationId) s = (await pool.query(`SELECT * FROM prospector_sends WHERE customer_id = $1 AND conversation_id = $2`, [c.id, m.conversationId])).rows[0];
  if (!s || s.replied_at) return 'ignored';
  if (SR.isAutoReply(m)) return 'auto';
  const own = SR.ownWords(text) || text;
  const tag = SR.classifyRule(text);
  await pool.query(`UPDATE prospector_sends SET state = CASE WHEN state = 'stopped' THEN state ELSE 'replied' END, replied_at = $2, reply_tag = $3,
      reply_text = $4, next_at = NULL, updated_at = NOW() WHERE id = $1`, [s.id, m.receivedDateTime || now, tag.tag, clip(own, 2000)]);
  await event(pool, c.id, s.id, 'reply', { detail: tag.tag, at: now });
  if (tag.tag === 'unsubscribe') {
    await suppression.suppress(pool, s.email, { reason: 'asked a Prospector customer to stop', kind: tag.complaint ? 'complaint' : 'unsubscribe' });
  }
  // Done For You: we answer the replies, so JohnMark is told about each one.
  if (c.plan === 'dfy' && tag.tag !== 'unsubscribe') {
    await tell({ subject: `Prospector DFY reply for ${c.company}: ${s.business || s.email}`,
      text: `${s.business || ''} <${s.email}> replied to ${c.company} (${mb.address}):\n\n${clip(own, 1500)}\n\nTag: ${tag.tag}. Answer it from their mailbox and book the meeting.` }, deps);
  }
  return 'reply';
}

async function bounceCheck(pool, c, { now = new Date(), deps = {} } = {}) {
  const r = (await pool.query(`SELECT COUNT(*) FILTER (WHERE kind = 'sent' AND step = 1)::int AS sent, COUNT(*) FILTER (WHERE kind = 'bounce')::int AS bounces
    FROM prospector_send_events WHERE customer_id = $1 AND at > $2::timestamptz - INTERVAL '14 days'`, [c.id, now])).rows[0];
  if (c.sending_paused || r.sent < BOUNCE_MIN || r.bounces / r.sent <= BOUNCE_LIMIT) return { paused: false, ...r };
  const reason = `${r.bounces} of ${r.sent} emails bounced in 14 days`;
  await pool.query(`UPDATE prospector_customers SET sending_paused = $2 WHERE id = $1`, [c.id, reason]);
  await tell({ subject: `Prospector: sending paused for ${c.company || c.email}`, text: `${reason}. Their sending is paused to protect their mailbox. Check the leads, then clear sending_paused to resume.` }, deps);
  return { paused: true, reason, ...r };
}

// ── THE GUARANTEE ───────────────────────────────────────────────────────────
// 30 days after a customer's first email went out: fewer than 3 human
// replies (not counting "stop") and JohnMark is told to credit next month.
async function guaranteeCheck(pool, { now = new Date(), deps = {} } = {}) {
  await ensureTables(pool);
  const rows = (await pool.query(`SELECT c.*, MIN(e.at) AS first_sent FROM prospector_customers c JOIN prospector_send_events e ON e.customer_id = c.id AND e.kind = 'sent'
    WHERE c.guarantee_checked_at IS NULL AND c.plan IN ('territory', 'dfy') GROUP BY c.id
    HAVING MIN(e.at) < $1::timestamptz - INTERVAL '${GUARANTEE_DAYS} days'`, [now])).rows;
  const out = [];
  for (const c of rows) {
    const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM prospector_sends WHERE customer_id = $1 AND replied_at IS NOT NULL
      AND reply_tag <> 'unsubscribe' AND replied_at < $2::timestamptz + INTERVAL '${GUARANTEE_DAYS} days'`, [c.id, c.first_sent])).rows[0].n;
    await pool.query(`UPDATE prospector_customers SET guarantee_checked_at = $2 WHERE id = $1`, [c.id, now]);
    if (n < GUARANTEE_REPLIES) {
      await tell({ subject: `Prospector guarantee missed: ${c.company || c.email} (${n} replies)`,
        text: `${c.company || c.email} got ${n} replies in their first ${GUARANTEE_DAYS} days of sending (promised ${GUARANTEE_REPLIES}).\nCredit their next month in Stripe (customer ${c.stripe_customer_id || '?'}).` }, deps);
    }
    out.push({ customer: c.id, replies: n, met: n >= GUARANTEE_REPLIES });
  }
  return out;
}

// ── WHAT THE CUSTOMER'S PAGE SHOWS ──────────────────────────────────────────
async function summary(pool, c, deps = {}) {
  await ensureTables(pool);
  const fresh = (await pool.query(`SELECT * FROM prospector_customers WHERE id = $1`, [c.id])).rows[0] || c;
  const mbRow = await Mailboxes.get(pool, c.id);
  const mb = mbRow && mbRow.status === 'active' ? { ok: true, canSend: mbRow.can_send !== false, address: mbRow.address } : null;
  const counts = {};
  for (const r of (await pool.query(`SELECT state, COUNT(*)::int AS n FROM prospector_sends WHERE customer_id = $1 GROUP BY state`, [c.id])).rows) counts[r.state] = r.n;
  const sent = (await pool.query(`SELECT COUNT(*)::int AS n FROM prospector_send_events WHERE customer_id = $1 AND kind = 'sent'`, [c.id])).rows[0].n;
  return { sends: sends(fresh), mailbox: mbRow ? { address: mbRow.address, status: mbRow.status, canSend: mbRow.can_send !== false } : null,
    hasAddress: !!clip(fresh.mailing_address, 300), blocker: sends(fresh) ? blocker(fresh, mb) : null,
    queued: counts.queued || 0, inSequence: counts.active || 0, replied: counts.replied || 0, emailsSent: sent };
}

let _timer = null, _busy = false, _ticks = 0;
function start(pool) {
  if (_timer) return;
  _timer = setInterval(async () => {
    if (_busy || !ON()) return;
    _busy = true;
    try {
      const n = _ticks++;
      if (n % 5 === 0) await scanReplies(pool).catch((e) => console.error('[prospector-send] scan:', e.message));
      if (n % 60 === 0) await guaranteeCheck(pool).catch((e) => console.error('[prospector-send] guarantee:', e.message));
      await sendTick(pool).catch((e) => console.error('[prospector-send] send:', e.message));
    } finally { _busy = false; }
  }, 60 * 1000);
  if (_timer.unref) _timer.unref();
}
function stopClock() { if (_timer) clearInterval(_timer); _timer = null; }

module.exports = { ON, ensureTables, queueBatch, sendTick, sendOne, scanReplies, onMessage, bounceCheck, guaranteeCheck, summary, blocker,
  followUp, capFor, start, stopClock, CAPS, _reset() { _ensured = false; } };
