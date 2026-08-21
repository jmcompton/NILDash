#!/usr/bin/env node
'use strict';
// ── THE RELEASE TICK ─────────────────────────────────────────────────────────
//
//   node server/jobs/closerRelease.js --dry-run     what would go out, sends nothing
//   node server/jobs/closerRelease.js --send        the real tick
//
// Off unless CLOSER_RELEASE_ENABLED=1, same as the nightly queue job and for the
// same reason: a deploy must not be able to start sending mail by surprise.
//
// This is the piece that did not exist. outreach_logs.scheduled_send_at has been
// written since the send-window work shipped and NOTHING ever read it, so an
// approved message sat at 'approved' forever. Every send in the product went out
// because a human clicked send on one message.
//
// It ticks often and sends little. The window is 9:30-11:00 in the RECIPIENT's
// timezone, so across a roster spanning Oregon to New Jersey there is almost
// always somebody's window open and almost never everybody's.

const store = require('../store');
const Closer = require('../services/closer');
const sendGuard = require('../services/sendGuard');
const replyCapture = require('../services/replyCapture');

const ENABLED = process.env.CLOSER_RELEASE_ENABLED === '1';

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
          `SELECT reply_local_part FROM users WHERE id = $1`, [agentId]);
        full.replyLocalPart = (u.rows[0] && u.rows[0].reply_local_part) || null;
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
    const args = {
      to: [to], subject: log.subject, bodyHtml: log.body_html,
      attachments: [], replyTo, messageId,
    };
    const res = account.provider === 'imap'
      ? await provider.sendEmail(account.email_address, account.accessToken,
          account.refreshToken ? JSON.parse(account.refreshToken) : {}, args)
      : await provider.sendEmail(account.accessToken, account.refreshToken, args);
    return { ...(res || {}), messageId, replyTo };
  };
}

async function runOnce(opts = {}) {
  const pool = store.pool;
  await sendGuard.ensureTable(pool);
  const cache = new Map();
  const out = await Closer.releaseDue(pool, {
    now: opts.now,
    limit: opts.limit || 200,
    send: buildSend(pool, cache, { dry: !!opts.dryRun }),
  });
  const parts = [`considered=${out.considered}`, `sent=${out.sent}`,
    `held=${out.held}`, `failed=${out.failed}`];
  if (out.stoppedAgents.length) {
    parts.push(`stopped=${out.stoppedAgents.length}`);
    for (const s of out.stoppedAgents) {
      console.log(`[closer] agent=${s.agentId} STOPPED for the day: ${s.why}`);
    }
  }
  console.log('[closer] ' + parts.join(' '));
  return out;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run') || !argv.includes('--send');
  if (!ENABLED && !dryRun) {
    console.log('[closer] CLOSER_RELEASE_ENABLED is not 1 — refusing to send. Use --dry-run to preview.');
    process.exit(0);
  }
  runOnce({ dryRun })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[closer] tick failed:', e.message); process.exit(1); });
}

module.exports = { runOnce, buildSend, senderFor, providerFor, ENABLED };
