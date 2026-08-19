#!/usr/bin/env node
'use strict';
// Zero-cost, READ-ONLY check of why reply capture is not firing. Sends nothing,
// spends nothing, writes nothing -- env reads plus SELECTs against outreach_logs.
//
// It answers, in order, the three things that can be wrong:
//
//   1. Is the OUTBOUND side even on? OUTREACH_REPLY_CAPTURE_ENABLED must be the
//      exact string "1". Anything else ("true", "yes", "on", "1 ") leaves
//      replyToAddressFor() returning null and NO Reply-To header is written --
//      the reply then goes to the sender's own mailbox and Resend never sees it.
//   2. Did the outreach actually go out through the ONE path that sets the
//      token? Only /api/outreach/logs/:id/send (sendViaEmailService) does. The
//      generic /api/email/send route sets no Reply-To, and the athlete send
//      path sets replyTo to the ATHLETE's address, overriding any token.
//   3. Has any inbound event ever been recorded for these rows?
//      last_inbound_at/last_inbound_kind are written for EVERY inbound the
//      webhook sees -- including bounces and auto-replies -- so an empty column
//      means nothing reached the webhook at all, which puts the fault upstream
//      of us (DNS/MX, or no token Reply-To on the wire in the first place).
//
//   railway run node scripts/reply-capture-diagnose.js
//   DATABASE_URL="postgres://..." node scripts/reply-capture-diagnose.js [--limit 20]

const { Pool } = require('pg');
const replyCapture = require('../server/services/replyCapture');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

async function main() {
  console.log('=== 1. Environment (as this process sees it) ===');
  const raw = process.env.OUTREACH_REPLY_CAPTURE_ENABLED;
  const on = raw === '1';
  console.log(`  OUTREACH_REPLY_CAPTURE_ENABLED = ${raw === undefined ? '(unset)' : JSON.stringify(raw)}`);
  if (!on) {
    console.log('  *** OUTBOUND CAPTURE IS OFF. The check is `=== "1"` exactly.');
    console.log('      No Reply-To token is written on ANY outreach while this is not the');
    console.log('      string "1", so replies go to the sender\'s own mailbox and Resend');
    console.log('      never receives them. This alone explains "no event on the webhook".');
  } else {
    console.log('  -> outbound capture is ON; a token Reply-To will be written.');
  }
  console.log(`  OUTREACH_REPLY_DOMAIN          = ${process.env.OUTREACH_REPLY_DOMAIN || '(unset -> reply.mynildash.com)'}`);
  console.log(`  RESEND_WEBHOOK_SECRET          = ${process.env.RESEND_WEBHOOK_SECRET ? 'set (' + process.env.RESEND_WEBHOOK_SECRET.slice(0, 6) + '…)' : '*** NOT SET -- the webhook route 503s every request ***'}`);
  console.log(`  RESEND_API_KEY                 = ${process.env.RESEND_API_KEY ? 'set' : '*** NOT SET -- body fetch would fail ***'}`);
  console.log(`  effective reply domain         = ${replyCapture.REPLY_DOMAIN}`);
  console.log(`  module-level ENABLED           = ${replyCapture.ENABLED}`);

  if (!process.env.DATABASE_URL) {
    console.log('\nDATABASE_URL is not set, so the ledger half of this report is skipped.');
    console.log('Run under `railway run` to get sections 2 and 3.');
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });

  try {
    const limit = parseInt(arg('--limit', '20'), 10) || 20;
    const rows = (await pool.query(
      `SELECT id, brand_name, status, sent_at, email_account_id, email_message_id,
              last_inbound_at, last_inbound_kind, replied_at, reply_from
         FROM outreach_logs
        WHERE status IN ('sent','replied')
        ORDER BY sent_at DESC NULLS LAST
        LIMIT $1`, [limit])).rows;

    console.log(`\n=== 2. The ${rows.length} most recent SENT outreach rows ===`);
    if (!rows.length) {
      console.log('  None. Nothing has been sent through the outreach engine at all,');
      console.log('  so there was never a token Reply-To on the wire to reply to.');
      console.log('  NOTE: the morning outreach queue sends NO email (DM or call only),');
      console.log('  and the athlete email path sets Reply-To to the ATHLETE address.');
      console.log('  Only /api/outreach/logs/:id/send carries the token.');
    }
    for (const r of rows) {
      const token = replyCapture.tokenForLogId(r.id);
      // What the Reply-To WOULD be if capture were on -- computed regardless of
      // the flag, so an off flag does not hide the address you should be looking
      // for in the sent message's headers.
      const addr = token ? `r${token}@${replyCapture.REPLY_DOMAIN}` : '(id is not the out_<16 hex> shape — no token derivable)';
      console.log(`\n  ${r.id}  ${r.brand_name || '(no brand)'}`);
      console.log(`    status=${r.status} sent_at=${r.sent_at ? new Date(r.sent_at).toISOString() : 'null'}`);
      console.log(`    expected Reply-To: ${addr}`);
      console.log(`    sent via the token path? ${r.email_account_id ? 'YES (email_account_id set -> /api/outreach/logs/:id/send)' : 'NO email_account_id — this did NOT go through the token path'}`);
      console.log(`    inbound seen: ${r.last_inbound_at ? new Date(r.last_inbound_at).toISOString() + ' kind=' + r.last_inbound_kind : 'NEVER — the webhook has never fired for this row'}`);
      if (r.replied_at) console.log(`    replied_at=${new Date(r.replied_at).toISOString()} from=${r.reply_from}`);
    }

    const any = (await pool.query(
      `SELECT COUNT(*)::int AS n, MAX(last_inbound_at) AS latest FROM outreach_logs WHERE last_inbound_at IS NOT NULL`)).rows[0];
    console.log('\n=== 3. Has the webhook EVER fired, for any row? ===');
    if (!any.n) {
      console.log('  NO. last_inbound_at is null on every outreach_logs row ever written.');
      console.log('  The webhook records this column for EVERY inbound it accepts --');
      console.log('  bounces and auto-replies included -- so an empty column means no');
      console.log('  request ever reached processEvent(). Combined with section 1 and 2:');
      console.log('    - capture off, or sent via a non-token path  -> nothing was ever');
      console.log('      addressed to reply.<domain>, so Resend had nothing to deliver.');
      console.log('    - capture on AND sent via the token path     -> the fault is');
      console.log('      upstream: DNS/MX on the reply subdomain, or the Resend webhook');
      console.log('      not actually pointed at this deployment.');
    } else {
      console.log(`  YES -- ${any.n} row(s), most recently ${new Date(any.latest).toISOString()}.`);
      console.log('  So the webhook path works; anything failing now is per-message.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
