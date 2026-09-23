#!/usr/bin/env node
'use strict';
// ── THE RELEASE QUEUE ────────────────────────────────────────────────────────
//
//   node server/jobs/closerRelease.js --dry-run     what would go out, sends nothing
//   node server/jobs/closerRelease.js --send        drain once, for real
//
// APPROVE MEANS SEND. This used to be a tick every ten minutes that sent only
// Tuesday to Thursday, 9:30 to 11:00 in the recipient's timezone, and only when
// CLOSER_RELEASE_ENABLED=1 -- which production never set, so 41 approved emails
// sat unsent for days and nothing on screen said so. There is no switch now
// and no window.
//
// It runs whenever the server runs. It ticks every few seconds and is woken
// the moment something is approved (kick), so a single approval goes out
// within seconds. Each agent sends ONE email at a time with a random 20 to 50
// second gap after it, so a bulk approve drains from that agent's mailbox at
// a pace a person could have typed it -- 150 emails take about an hour and a
// half -- rather than in one burst. Different agents drain side by side.
//
// A missing CAN-SPAM postal address still stops every send, because the law
// requires it; but it is written onto every waiting email as its hold reason,
// so the card says why, rather than being a line in a server log.
const store = require('../store');
const Closer = require('../services/closer');
const sendGuard = require('../services/sendGuard');
const replyCapture = require('../services/replyCapture');
const canSpam = require('../services/canSpam');


// ── THE PACE ─────────────────────────────────────────────────────────────────
const TICK_MS = 5 * 1000;          // how often the queue looks, when not woken
// Between two sends from one agent's mailbox: services/closer holds the range.
const { MIN_GAP_MS, MAX_GAP_MS } = Closer;
const gapMs = (rnd) => MIN_GAP_MS + Math.floor((typeof rnd === 'function' ? rnd() : Math.random()) * (MAX_GAP_MS - MIN_GAP_MS));

// The agent's connected mailbox, and the provider that goes with it. Built per
// agent and cached for the tick: an agent with 40 messages should not cause 40
// token lookups.
async function senderFor(pool, agentId, cache) {
  if (cache.has(agentId)) return cache.get(agentId);
  let out = null;
  try {
    const emailStore = require('../services/emailStore');
    const accounts = await emailStore.getEmailAccountsByUser(agentId);
    const acct = (accounts || []).find((a) => a.status !== 'disconnected') || (accounts || [])[0];
    if (acct) {
      const full = await emailStore.getEmailAccountWithTokens(acct.id);
      if (full) {
        // reply_local_part lives on USERS, not on the mail account. Reading it
        // off the account would have quietly returned undefined, sent every
        // Closer email with no Reply-To, and routed the answers into the agent's
        // own inbox where nothing watches for them -- which would have broken
        // the stop-on-reply condition the whole cadence depends on.
        const u = await pool.query(
          `SELECT reply_local_part, name FROM users WHERE id = $1`, [agentId]);
        full.replyLocalPart = (u.rows[0] && u.rows[0].reply_local_part) || null;
        // Named in the CAN-SPAM footer's "why you got this" line. Absent is
        // fine: the line falls back to wording that names no one.
        full.senderName = (u.rows[0] && u.rows[0].name) || null;
        if (!full.replyLocalPart && replyCapture.ENABLED) {
          console.warn(`[closer] agent=${agentId} has no reply address, so replies to `
            + 'this mail will not be captured; sending anyway');
        }
        out = full;
      }
    }
  } catch (e) {
    console.error(`[closer] could not load a mailbox for agent=${agentId}: ${e.message}`);
  }
  cache.set(agentId, out);
  return out;
}

function providerFor(account) {
  if (!account) return null;
  if (account.provider === 'gmail') return require('../services/providers/gmail');
  if (account.provider === 'outlook' || account.provider === 'microsoft365') {
    return require('../services/providers/outlook');
  }
  return require('../services/providers/imap');
}

// One send. Throws on provider failure so sendGuard.sendWithRetry can classify
// it -- swallowing the error here is what would turn a 429 into a silent drop.
function buildSend(pool, cache, { dry }) {
  return async function send(log) {
    const account = await senderFor(pool, log.agent_id, cache);
    if (!account) {
      const e = new Error('no connected mailbox for this agent');
      e.code = 401;
      throw e;
    }
    const to = String(log.sent_to_email || '').trim();
    if (!to) throw new Error('no address to send to');

    const replyTo = replyCapture.ENABLED && account.replyLocalPart
      ? replyCapture.agentReplyAddress(account.replyLocalPart)
      : null;
    const messageId = replyCapture.ENABLED ? replyCapture.buildMessageId(log.id) : null;

    if (dry) {
      console.log(`[closer] DRY would send ${log.id} "${log.brand_name}" -> ${to}`);
      return { providerMessageId: null, messageId, replyTo, dryRun: true };
    }

    const provider = providerFor(account);
    // ── THE CAN-SPAM FOOTER ───────────────────────────────────────────
    // On the message that ships, not on the draft: this is the path that
    // sends in volume without a human looking at it, which is exactly the
    // path that must never put a commercial email in front of a business
    // with no postal address and no way to opt out. Throws when
    // BUSINESS_MAILING_ADDRESS is unset, and sendGuard classifies the throw
    // like any other send failure, so the tick reports it rather than
    // sending anyway.
    const args = {
      to: [to], subject: log.subject,
      bodyHtml: canSpam.appendHtml(log.body_html, to, { senderName: account.senderName || null }),
      attachments: [], replyTo, messageId,
    };
    const res = account.provider === 'imap'
      ? await provider.sendEmail(account.email_address, account.accessToken,
          account.refreshToken ? JSON.parse(account.refreshToken) : {}, args)
      : await provider.sendEmail(account.accessToken, account.refreshToken, args);
    // A provider that reports the Message-ID it actually put on the wire wins
    // over the one we minted. Graph can refuse our stamp, and storing the id we
    // wanted rather than the id that shipped would break reply matching for
    // exactly the messages that got a reply. Gmail and IMAP report no such
    // field, so for them this is the minted id, unchanged.
    return { ...(res || {}), messageId: (res && res.messageId) || messageId, replyTo };
  };
}

// ── WHEN EACH AGENT MAY SEND NEXT ──────────────────────────────────────────
// In memory, seeded from the database the first time an agent is seen, so a
// restart cannot fire two sends from one mailbox back to back.
const _nextAt = new Map();          // agentId -> epoch ms

async function agentReady(pool, agentId, now) {
  const t = now instanceof Date ? now.getTime() : Date.now();
  if (!_nextAt.has(agentId)) {
    let floor = 0;
    try {
      const r = await pool.query(
        `SELECT MAX(last_send_at) AS t FROM agent_send_budget WHERE agent_id = $1`, [agentId]);
      const last = r.rows[0] && r.rows[0].t;
      if (last) floor = new Date(last).getTime() + MIN_GAP_MS;
    } catch (_) { /* no history: ready now */ }
    _nextAt.set(agentId, floor);
  }
  return t >= _nextAt.get(agentId);
}

function afterAttempt(agentId, now, rnd) {
  const t = now instanceof Date ? now.getTime() : Date.now();
  _nextAt.set(agentId, t + gapMs(rnd));
}

// ── THE ONE THING THAT STILL STOPS EVERY SEND ──────────────────────────────
// Said on every email it is holding, so the card shows it.
async function holdAllFor(pool, why) {
  const r = await pool.query(
    `UPDATE outreach_logs
        SET send_hold_reason = $1, send_hold_at = NOW(), updated_at = NOW()
      WHERE status = 'approved' AND sent_at IS NULL AND cadence_stopped_at IS NULL
        AND send_hold_reason IS DISTINCT FROM $1`, [String(why).slice(0, 300)]).catch(() => ({ rowCount: 0 }));
  return r.rowCount || 0;
}

async function runOnce(opts = {}) {
  const pool = opts.pool || store.pool;
  if (!canSpam.configured()) {
    const n = await holdAllFor(pool, canSpam.problem());
    if (n) console.error(`[closer] ${n} approved email(s) held: ${canSpam.problem()}`);
    return { considered: 0, sent: 0, held: 0, failed: 0, waiting: 0, stoppedAgents: [], blocked: canSpam.problem() };
  }
  // The address is back: the emails it was holding are due again, not held.
  // Matched on the start of canSpam.problem()'s own sentence.
  await pool.query(
    `UPDATE outreach_logs SET send_hold_reason = NULL, send_hold_at = NULL, updated_at = NOW()
      WHERE status = 'approved' AND sent_at IS NULL AND send_hold_reason LIKE $1`,
    [canSpam.ENV_NAME + ' is not set%']).catch(() => {});
  await sendGuard.ensureTable(pool);
  const cache = new Map();
  const paced = opts.paced !== false;
  const out = await Closer.releaseDue(pool, {
    now: opts.now,
    limit: opts.limit || 200,
    send: opts.send || buildSend(pool, cache, { dry: !!opts.dryRun }),
    sleep: opts.sleep,
    // ONE PER AGENT PER TICK, AND ONLY WHEN THEIR GAP HAS PASSED.
    perAgent: paced ? 1 : undefined,
    agentReady: paced ? (agentId, now) => agentReady(pool, agentId, now) : undefined,
    onAttempt: paced ? (agentId, now) => afterAttempt(agentId, now, opts.rnd) : undefined,
  });
  if (out.sent || out.failed || out.held) {
    const parts = [`considered=${out.considered}`, `sent=${out.sent}`,
      `held=${out.held}`, `failed=${out.failed}`, `waiting=${out.waiting}`];
    if (out.stoppedAgents.length) {
      parts.push(`stopped=${out.stoppedAgents.length}`);
      for (const s of out.stoppedAgents) {
        console.log(`[closer] agent=${s.agentId} STOPPED for the day: ${s.why}`);
      }
    }
    console.log('[closer] ' + parts.join(' '));
  }
  return out;
}

// ── THE LOOP ────────────────────────────────────────────────────────────────
// One tick at a time: a send can take a minute of backoff, and two ticks
// overlapping in one process would race for the same agent's next email.
let _timer = null, _running = false, _again = false, _started = false;

async function _tick() {
  if (_running) { _again = true; return; }
  _running = true;
  try { await runOnce({}); }
  catch (e) { console.error('[closer] release tick failed:', e.message); }
  finally {
    _running = false;
    const soon = _again; _again = false;
    _schedule(soon ? 0 : TICK_MS);
  }
}

function _schedule(ms) {
  if (!_started) return;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_tick, ms);
  if (_timer.unref) _timer.unref();
}

// Start draining. Called once by the server; there is no switch to turn it off.
function start() {
  if (_started) return;
  _started = true;
  _schedule(2000);
  console.log(`[closer] release queue started: approve means send, one email per agent every ${MIN_GAP_MS / 1000}-${MAX_GAP_MS / 1000}s`);
}

// Look now. Called right after an approval so it does not wait for the tick.
function kick() {
  if (!_started) return;
  if (_running) { _again = true; return; }
  _schedule(0);
}

function stop() {
  _started = false;
  if (_timer) clearTimeout(_timer);
  _timer = null;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run') || !argv.includes('--send');
  // From the command line, drain everything due in one pass (no pacing).
  runOnce({ dryRun, paced: false })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[closer] tick failed:', e.message); process.exit(1); });
}

module.exports = { runOnce, buildSend, senderFor, providerFor, start, kick, stop, agentReady, afterAttempt,
  holdAllFor, TICK_MS, MIN_GAP_MS, MAX_GAP_MS, _nextAt };
