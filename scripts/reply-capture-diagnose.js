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

// pg is required LAZILY so the DNS half runs with no database, no
// DATABASE_URL, and no node_modules:
//   node scripts/reply-capture-diagnose.js --dns-only
//   node scripts/reply-capture-diagnose.js --dns-only mynildash.com
const dns = require('dns').promises;
const { Resolver } = require('dns').promises;
const replyCapture = require('../server/services/replyCapture');

// Resend Inbound is SES-backed; this is the documented MX target.
const EXPECTED_MX = 'inbound-smtp.us-east-1.amazonaws.com';

// The DNS half. An MX that resolves proves the record exists -- it does NOT
// prove the domain is registered as a RECEIVING DOMAIN in Resend, which is a
// separate step and the usual reason mail vanishes with no bounce and no log
// entry: it reaches the shared SES endpoint, matches no receipt rule for that
// recipient domain, and is dropped before Resend ever ingests it.
// Public resolvers, so "it resolves for me" is never mistaken for "it resolves
// for the internet". A record that is right at the registrar but not yet
// propagated looks identical from inside the deploy.
const PUBLIC_RESOLVERS = [
  ['Google', '8.8.8.8'], ['Cloudflare', '1.1.1.1'],
  ['Quad9', '9.9.9.9'], ['OpenDNS', '208.67.222.222'],
];

async function checkDns(domain) {
  console.log(`\n=== DNS for ${domain} ===`);
  let mx = [];
  try { mx = await dns.resolveMx(domain); } catch (e) {
    console.log(`  MX -> NONE (${e.code}). Mail to this domain cannot reach Resend at all.`);
    return;
  }

  // RFC 7505: priority 0 with target "." is an explicit "this domain accepts no
  // mail". Senders reject immediately, which reads to a human exactly like
  // "address not valid" -- worth ruling out first, because it is the one record
  // that makes a correct-looking setup undeliverable by design.
  const nullMx = mx.find((r) => r.priority === 0 && (r.exchange === '.' || r.exchange === ''));
  if (nullMx) {
    console.log('  *** NULL MX (RFC 7505) present: this domain publicly declares that it');
    console.log('      accepts NO mail. Every sender will reject. Remove it.');
  }
  for (const r of mx) console.log(`  MX -> ${r.exchange} (priority ${r.priority})`);

  const hit = mx.find((r) => r.exchange.toLowerCase() === EXPECTED_MX);
  if (!hit) {
    console.log(`  *** No MX points at ${EXPECTED_MX}. Copy the exact MX value from`);
    console.log('      the Resend dashboard for this domain.');
  } else if (mx.some((r) => r.priority < hit.priority)) {
    console.log('  *** Resend is NOT the lowest-priority MX, so mail goes elsewhere first.');
  } else {
    console.log('  -> MX is correct and lowest priority.');
  }

  // An MX naming a host with no address is an unroutable destination; senders
  // report it as undeliverable without the domain ever being "wrong".
  if (hit) {
    try {
      const ips = await dns.resolve4(hit.exchange);
      console.log(`  -> MX target resolves (${ips.length} A record(s)).`);
    } catch (e) {
      console.log(`  *** MX target ${hit.exchange} does not resolve (${e.code}) -- unroutable.`);
    }
  }

  // Cross-check from outside this network.
  console.log('  Public resolvers:');
  for (const [name, ip] of PUBLIC_RESOLVERS) {
    const r = new Resolver({ timeout: 4000, tries: 2 });
    r.setServers([ip]);
    try {
      const got = await r.resolveMx(domain);
      console.log(`    ${name.padEnd(11)} ${got.map((m) => m.priority + ' ' + m.exchange).join(' | ')}`);
    } catch (e) { console.log(`    ${name.padEnd(11)} ERROR ${e.code}`); }
  }

  let txt = [];
  try { txt = (await dns.resolveTxt(domain)).map((t) => t.join('')); } catch (_) { txt = []; }
  if (!txt.length) {
    console.log('  TXT -> none. Adding a domain in Resend normally issues TXT records for');
    console.log('      it; an MX with no TXT at all is often a hand-created MX on a host');
    console.log('      that was never added as a Resend receiving domain.');
  } else {
    console.log('  TXT ->');
    for (const t of txt) console.log('    ' + t);
  }

  // THE TRAP THIS CHECK EXISTS FOR. A domain claimed in a Microsoft 365 tenant
  // is an "Accepted Domain" there, and Exchange Online resolves recipients on
  // it against the TENANT DIRECTORY -- it never consults public MX for them. If
  // the domain is Authoritative (the default) and no such mailbox exists,
  // Outlook rejects at send time as "not a valid recipient"
  // (550 5.1.10 RESOLVER.ADR.RecipientNotFound). Public DNS is perfect and
  // irrelevant: the message never leaves Microsoft, so nothing ever reaches
  // Resend and no internet bounce is generated.
  if (txt.some((t) => /^MS=ms\d+/i.test(t))) {
    console.log('\n  *** MICROSOFT 365 CLAIM DETECTED (MS=ms######## TXT).');
    console.log('      This domain is claimed in a Microsoft 365 / Entra tenant. Mail sent');
    console.log('      to it FROM INSIDE that tenant (Outlook / Exchange Online) is routed');
    console.log('      internally against the tenant directory and NEVER uses the MX above.');
    console.log('      With no mailbox of that name, Outlook reports "not valid" and the');
    console.log('      send is undeliverable -- while senders OUTSIDE the tenant deliver');
    console.log('      fine. This is the single most likely cause of "Resend says');
    console.log('      configured, Outlook says the domain does not take mail".');
    console.log('      TEST: send the same message from Gmail. If it arrives, this is it.');
    console.log('      FIX:  in the M365 admin centre either remove this domain from the');
    console.log('            tenant, or set its Accepted Domain type to Internal Relay so');
    console.log('            unknown recipients are relayed out over public MX.');
    console.log('      NOTE: deleting the MS= TXT alone does NOT fix it -- the tenant claim');
    console.log('            is what routes the mail, the TXT is only the ownership proof.');
  }
  if (txt.some((t) => /^v=spf1/i.test(t))) {
    console.log('  (SPF present on this host. SPF governs SENDING only and never affects');
    console.log('   whether a domain can receive.)');
  }
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

async function main() {
  // DNS ONLY. No database, no DATABASE_URL, no env vars, no node_modules --
  // this half is pure DNS and is the fastest way to answer "can this domain
  // receive mail at all". Optionally takes a domain to check instead of the
  // configured one.
  if (process.argv.includes('--dns-only')) {
    const i = process.argv.indexOf('--dns-only');
    const next = process.argv[i + 1];
    const domain = (next && !next.startsWith('--')) ? next : replyCapture.REPLY_DOMAIN;
    await checkDns(domain);
    return;
  }

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
  console.log(`  OUTREACH_REPLY_DOMAIN          = ${process.env.OUTREACH_REPLY_DOMAIN || '(unset -> ' + replyCapture.REPLY_DOMAIN + ')'}`);
  console.log(`  RESEND_WEBHOOK_SECRET          = ${process.env.RESEND_WEBHOOK_SECRET ? 'set (' + process.env.RESEND_WEBHOOK_SECRET.slice(0, 6) + '…)' : '*** NOT SET -- the webhook route 503s every request ***'}`);
  console.log(`  RESEND_API_KEY                 = ${process.env.RESEND_API_KEY ? 'set' : '*** NOT SET -- body fetch would fail ***'}`);
  console.log(`  effective reply domain         = ${replyCapture.REPLY_DOMAIN}`);
  console.log(`  module-level ENABLED           = ${replyCapture.ENABLED}`);

  await checkDns(replyCapture.REPLY_DOMAIN);

  if (!process.env.DATABASE_URL) {
    console.log('\nDATABASE_URL is not set, so the ledger half of this report is skipped.');
    console.log('Run under `railway run` to get sections 2 and 3.');
    return;
  }

  const { Pool } = require('pg');   // lazy: --dns-only must not need node_modules
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
