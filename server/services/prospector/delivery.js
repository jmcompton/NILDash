'use strict';
// ── PROSPECTOR DELIVERY: WHAT A PAYING IT COMPANY GETS EVERY WEEK ───────────
//
// Once a week per active, onboarded customer: a Prospector run in their area,
// signed with their company and their name, skipping every business they were
// already given. The batch lands on their own page (/p/<customer token>, with
// a CSV) and in an email to them.
//
//   Starter      25 a month  -> 6 a week. They send.
//   Territory   100 a month  -> 24 a week. We send from their mailbox (once it
//                is connected; until then they get the list like Starter).
//   Done For You 300 a month -> 70 a week. Same, and we answer the replies.
//
// The first batch goes out the day they finish onboarding; the next one 7
// days after the last. Weekdays only, from 7:00 Central, one customer at a
// time (each run takes a few minutes and spends Hunter credits).
//
// Idle unless PROSPECTOR_DELIVERY_ON. JohnMark gets an email for every batch
// and every failure.

const R = require('./run');
const Billing = require('./billing');

const yes = (k) => /^(1|true|yes|on)$/i.test(String(process.env[k] || '').trim());
const ON = () => yes('PROSPECTOR_DELIVERY_ON');
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const CENTRAL = 'America/Chicago';
const LIVE = ['active', 'trialing'];
const WEEK_MS = 7 * 86400000;
const START_MINUTE = 7 * 60;

function appUrl() { return String(process.env.PROSPECTOR_BASE_URL || process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, ''); }
function weekly(planKey) {
  const p = Billing.plan(planKey);
  return p ? Math.ceil(p.perMonth * 12 / 52) : 0;
}

let _ensured = false;
async function ensureTables(pool) {
  if (_ensured) return;
  await Billing.ensureTables(pool);
  await R.ensureTables(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_batches (
    id SERIAL PRIMARY KEY, customer_id INT NOT NULL REFERENCES prospector_customers(id) ON DELETE CASCADE,
    run_id INT, wanted INT, delivered INT NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'running', error TEXT,
    emailed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS prospector_batches_customer ON prospector_batches (customer_id, created_at)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_delivered (
    customer_id INT NOT NULL REFERENCES prospector_customers(id) ON DELETE CASCADE, domain TEXT NOT NULL,
    lead_id INT, batch_id INT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (customer_id, domain))`);
  _ensured = true;
}

function central(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}

// Customers whose batch is due: live, onboarded, a plan with leads, no batch
// running, and none started in the last 7 days (a failed one does not count).
async function due(pool, now = new Date()) {
  await ensureTables(pool);
  const r = await pool.query(`SELECT c.* FROM prospector_customers c
     WHERE c.status = ANY($1::text[]) AND c.onboarded_at IS NOT NULL AND c.area IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM prospector_batches b WHERE b.customer_id = c.id
             AND (b.status = 'running' AND b.created_at > $2::timestamptz - INTERVAL '2 hours'
               OR b.status = 'done' AND b.created_at > $2::timestamptz - INTERVAL '7 days' + INTERVAL '6 hours'))
     ORDER BY c.onboarded_at`, [LIVE, now]);
  return r.rows.filter((c) => weekly(c.plan) > 0);
}

// One batch for one customer. -> { batchId, runId, delivered }.
async function deliver(pool, customer, { now = new Date(), deps = {} } = {}) {
  await ensureTables(pool);
  const c = customer;
  const wanted = deps.limit || weekly(c.plan);
  const b = (await pool.query(`INSERT INTO prospector_batches (customer_id, wanted, created_at) VALUES ($1,$2,$3) RETURNING id`, [c.id, wanted, now])).rows[0];
  try {
    const had = (await pool.query(`SELECT domain FROM prospector_delivered WHERE customer_id = $1`, [c.id])).rows.map((x) => x.domain);
    const run = deps.run || R.run;
    const out = await run(pool, { playbook: 'it-msp', area: c.area, limit: wanted, delivery: true, exclude: had,
      sender: { name: c.sender_name || '', company: c.company || '', about: c.about || '' },
      onStart: (runId) => { pool.query(`UPDATE prospector_batches SET run_id = $2 WHERE id = $1`, [b.id, runId]).catch(() => {}); } }, deps.runDeps || {});
    const leads = (await pool.query(`SELECT id, domain FROM prospector_leads WHERE run_id = $1`, [out.runId])).rows;
    let n = 0;
    for (const l of leads) {
      const ins = await pool.query(`INSERT INTO prospector_delivered (customer_id, domain, lead_id, batch_id) VALUES ($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`, [c.id, String(l.domain || '').toLowerCase() || 'lead-' + l.id, l.id, b.id]);
      n += ins.rowCount;
    }
    await pool.query(`UPDATE prospector_batches SET status = 'done', run_id = $2, delivered = $3, finished_at = NOW() WHERE id = $1`, [b.id, out.runId, n]);
    const summary = out.summary || {};
    // Territory and Done For You: queued to go out from their own mailbox.
    let queued = 0;
    const p = Billing.plan(c.plan);
    if (p && p.sends) {
      const CS = require('./customerSend');
      queued = (await CS.queueBatch(pool, c, b.id)).queued;
      const mb = await require('./mailboxes').get(pool, c.id);
      c.mailbox_connected = !!(mb && mb.status === 'active' && mb.can_send !== false);
    }
    await notifyCustomer(pool, c, { batchId: b.id, delivered: n, wanted, summary, queued }, deps);
    await tell({ subject: `Prospector: ${n} leads delivered to ${c.company || c.email}`,
      text: `${c.company || c.email} (${Billing.plan(c.plan) ? Billing.plan(c.plan).name : c.plan}, ${c.area}): ${n} of ${wanted} new leads this week.\n`
        + `${summary.checked || 0} businesses checked, ${summary.withGap || 0} new ones with a gap, ${summary.alreadyDelivered || 0} already delivered before.\n`
        + (n < wanted ? `\nShort of the plan: the area is running low on new businesses. Widen the search for this customer.\n` : '')
        + `\nTheir page: ${appUrl()}/p/${c.token}` }, deps);
    return { batchId: b.id, runId: out.runId, delivered: n, wanted, queued };
  } catch (e) {
    await pool.query(`UPDATE prospector_batches SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`, [b.id, clip(e.message, 300)]);
    await tell({ subject: `Prospector: a delivery failed for ${c.company || c.email}`, text: `The weekly batch for ${c.company || c.email} (${c.area}) failed:\n\n${e.message}\n\nIt will try again on the next check.` }, deps);
    return { batchId: b.id, error: e.message };
  }
}

// ── TELLING THEM ────────────────────────────────────────────────────────────
function customerEmail(c, info) {
  const first = clip(c.sender_name, 60).split(/\s+/)[0];
  const link = `${appUrl()}/p/${c.token}`;
  const p = Billing.plan(c.plan) || {};
  const sending = p.sends
    ? (c.mailbox_connected && String(c.mailing_address || '').trim()
      ? `We're sending these from your mailbox over the coming week, with follow-ups. Replies land in your inbox.`
      : `On that page, ${c.mailbox_connected ? 'add your business mailing address' : 'connect your mailbox'} and we'll send these for you, with follow-ups. Until then, they're yours to send.`)
    : `Each one has the owner's email and a first email written for you. Send them from your own inbox.`;
  const text = `${first ? `Hi ${first},` : 'Hi,'}

This week's leads for ${c.area} are ready: ${info.delivered} businesses with an email security gap.

${link}

${sending}

The page also has a CSV if you'd rather load them into your own tools.

${Billing.BRAND()}`;
  return { subject: `${info.delivered} new leads in ${c.area}`, text, link };
}
async function notifyCustomer(pool, c, info, deps = {}) {
  if (!c.email || !info.delivered) return null;
  const msg = customerEmail(c, info);
  try {
    if (deps.sendCustomer) await deps.sendCustomer(c.email, msg);
    else {
      if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
      const from = process.env.PROSPECTOR_FROM_NOTICE || `${Billing.BRAND()} <noreply@mynildash.com>`;
      const replyTo = String(process.env.PROSPECTOR_REPLY_TO || process.env.SALES_ALERT_TO || '').trim() || undefined;
      const resend = require('../resendChecked').makeResend(process.env.RESEND_API_KEY);
      const r = await resend.emails.send({ from, to: c.email, subject: msg.subject, text: msg.text, ...(replyTo ? { reply_to: replyTo } : {}) });
      if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
    }
    await pool.query(`UPDATE prospector_batches SET emailed_at = NOW() WHERE id = $1`, [info.batchId]);
    return msg;
  } catch (e) {
    console.error('[prospector-delivery] customer email:', e.message);
    return null;
  }
}
async function tell(msg, deps = {}) {
  try { return deps.alert ? await deps.alert(msg) : await require('../salesAutopilot').alert(msg); }
  catch (e) { console.error('[prospector-delivery] alert failed:', e.message); return null; }
}

// ── THEIR PAGE ──────────────────────────────────────────────────────────────
// Everything delivered, newest batch first. Never the run's internals.
async function portal(pool, token) {
  await ensureTables(pool);
  const c = await Billing.byToken(pool, token);
  if (!c) return null;
  const rows = (await pool.query(`SELECT d.batch_id, b.created_at AS batch_at, l.* FROM prospector_delivered d
      JOIN prospector_leads l ON l.id = d.lead_id JOIN prospector_batches b ON b.id = d.batch_id
     WHERE d.customer_id = $1 ORDER BY b.created_at DESC, (l.level = 'high') DESC, l.verified DESC, l.id LIMIT 2000`, [c.id])).rows;
  const leads = rows.map((l) => ({
    batch: l.batch_id, batchAt: l.batch_at, business: l.business, category: l.category, domain: l.domain, address: l.address, phone: l.phone,
    level: l.level, problem: l.finding && l.finding.problems ? l.finding.problems[0] : null,
    person: l.person ? { first: l.person.first || '', last: l.person.last || '', title: l.person.title || '', email: l.person.email } : null,
    verified: !!l.verified, email: l.email ? { subject: l.email.subject, body: l.email.body } : null,
  }));
  const p = Billing.plan(c.plan);
  const sending = p && p.sends ? await require('./customerSend').summary(pool, c) : null;
  return { company: c.company, area: c.area, plan: p ? { key: p.key, name: p.name, perMonth: p.perMonth, sends: !!p.sends } : null,
    status: c.status, onboarded: !!c.onboarded_at, perWeek: weekly(c.plan), leads, sending, brand: Billing.BRAND() };
}
const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
function csv(view) {
  const head = ['Business', 'Category', 'Website', 'Address', 'Phone', 'Risk', 'Problem', 'First name', 'Last name', 'Title', 'Email', 'Verified', 'Subject', 'Email body', 'Delivered'];
  const lines = [head.join(',')];
  for (const l of view.leads) {
    const p = l.person || {};
    lines.push([l.business, l.category, l.domain, l.address, l.phone, l.level, l.problem, p.first, p.last, p.title, p.email, l.verified ? 'yes' : 'no',
      l.email && l.email.subject, l.email && l.email.body, l.batchAt ? new Date(l.batchAt).toISOString().slice(0, 10) : ''].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ── ADMIN ───────────────────────────────────────────────────────────────────
async function customers(pool) {
  await ensureTables(pool);
  return (await pool.query(`SELECT c.id, c.company, c.email, c.sender_name, c.area, c.plan, c.period, c.status, c.onboarded_at, c.created_at, c.token,
      (SELECT COUNT(*)::int FROM prospector_delivered d WHERE d.customer_id = c.id) AS delivered,
      (SELECT MAX(b.created_at) FROM prospector_batches b WHERE b.customer_id = c.id AND b.status = 'done') AS last_batch,
      (SELECT b.error FROM prospector_batches b WHERE b.customer_id = c.id ORDER BY b.id DESC LIMIT 1) AS last_error
    FROM prospector_customers c ORDER BY c.created_at DESC LIMIT 500`)).rows;
}

// ── THE CLOCK ───────────────────────────────────────────────────────────────
// Every 10 minutes on weekdays from 7:00 Central: the next customer due, one
// at a time.
async function tick(pool, { now = new Date(), deps = {} } = {}) {
  if (!ON() && !deps.force) return { skipped: 'PROSPECTOR_DELIVERY_ON is off' };
  const t = central(now);
  if (t.weekday === 'Sat' || t.weekday === 'Sun') return { skipped: 'weekend' };
  if (t.minutes < START_MINUTE) return { skipped: 'before 7:00 Central' };
  const list = await due(pool, now);
  if (!list.length) return { skipped: 'nobody due' };
  return deliver(pool, list[0], { now, deps });
}
let _timer = null, _busy = false;
function start(pool) {
  if (_timer) return;
  _timer = setInterval(async () => {
    if (_busy || !ON()) return;
    _busy = true;
    try { await tick(pool); } catch (e) { console.error('[prospector-delivery]', e.message); } finally { _busy = false; }
  }, 10 * 60 * 1000);
  if (_timer.unref) _timer.unref();
}
function stopClock() { if (_timer) clearInterval(_timer); _timer = null; }

module.exports = { ON, weekly, ensureTables, due, deliver, customerEmail, portal, csv, customers, tick, start, stopClock,
  _reset() { _ensured = false; } };
