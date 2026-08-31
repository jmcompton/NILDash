#!/usr/bin/env node
'use strict';
// ── WHICH CONNECTED MAILBOXES CANNOT ACTUALLY SEND ──────────────────────────
//
// An agent reported "insufficient authentication scopes" on a send. The cause is
// that gmail.send is a SENSITIVE scope with its own checkbox on Google's consent
// screen: untick it and the OAuth exchange still succeeds, the account is still
// saved, Calendar still works -- and the failure surfaces at the moment someone
// presses Send on a real pitch to a real business.
//
// Until now nothing recorded what Google actually granted. exchangeCode received
// the scope list in the token response and dropped it, so a mailbox that could
// send and one that could not were the same row.
//
// WE DO NOT HAVE TO GUESS FOR THE ROWS THAT PREDATE THAT FIX. Google will say.
// For each Gmail account this mints a fresh access token from the stored refresh
// token and asks the tokeninfo endpoint what that grant covers.
//
// WHAT THIS COSTS AND WHAT IT TOUCHES: nothing, and no mail. A token refresh is
// not a send -- no message is composed, drafted, read or delivered, no mailbox
// is listed, and no model or paid API is called. Two HTTPS calls per account.
//
// READ-ONLY BY DEFAULT. --write is required before it records anything, and even
// then it writes only granted_scopes / can_send / scopes_checked_at. It never
// touches a token, never deletes an account, and never disconnects anyone.
//
// FOUR OUTCOMES PER ACCOUNT, and the third is the point of separating them:
//   CAN SEND      gmail.send is in the grant. Nothing to do.
//   NO SEND       we asked, it is absent. This agent cannot send and does not
//                 know it. --write marks can_send = false, which takes the
//                 mailbox out of the From picker with an explanation.
//   TOKEN DEAD    the refresh failed: revoked, expired, or the app's access was
//                 removed at Google. Also broken, differently -- reconnecting
//                 fixes it, but the person needs a different sentence.
//   UNKNOWN       we could not reach Google at all. NOT recorded as a failure;
//                 a network blip must never be written down as "cannot send".
//
//   node scripts/audit-gmail-scopes.js                 # read-only, every agent
//   node scripts/audit-gmail-scopes.js --agent <id>    # one agent
//   node scripts/audit-gmail-scopes.js --write         # also record what it found

const store = require('../server/store');
const emailStore = require('../server/services/emailStore');
const gmail = require('../server/services/providers/gmail');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
const WRITE = has('--write');
const ONE_AGENT = val('--agent');
// The schema has to have settled before the first read, for the same reason the
// suites wait: store.js's init runs on require and the columns arrive with it.
const INIT_WAIT_MS = parseInt(process.env.AUDIT_INIT_WAIT_MS, 10) || 2500;

const SEND = gmail.SEND_SCOPE;

function short(scopes) {
  if (!Array.isArray(scopes)) return '(none reported)';
  return scopes.map((s) => s.replace('https://www.googleapis.com/auth/', '')).join(' ');
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  if (!gmail.isAvailable()) {
    console.error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET are not set in this environment.');
    console.error('Run this where the app runs — without the app\'s own credentials the');
    console.error('refresh call cannot be made and every account would read as UNKNOWN.');
    process.exit(2);
  }

  const rows = (await P.query(
    `SELECT a.id, a.user_id, a.email_address, a.provider, a.status,
            a.granted_scopes, a.can_send, a.scopes_checked_at, a.created_at,
            a.refresh_token_enc,
            u.name AS agent_name, u.email AS agent_email
       FROM email_accounts a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.provider = 'gmail'
        ${ONE_AGENT ? 'AND a.user_id = $1' : ''}
      ORDER BY u.name NULLS LAST, a.created_at`,
    ONE_AGENT ? [ONE_AGENT] : [])).rows;

  if (!rows.length) {
    console.log('No Gmail accounts found' + (ONE_AGENT ? ` for agent ${ONE_AGENT}` : '') + '.');
    await P.end();
    return;
  }

  console.log(`\n${rows.length} Gmail account(s)${WRITE ? '' : '  — READ-ONLY, nothing will be written'}\n`);
  console.log('  ' + 'AGENT'.padEnd(22) + 'MAILBOX'.padEnd(32) + 'VERDICT');
  console.log('  ' + '-'.repeat(78));

  const { decrypt } = require('../server/services/crypto');
  const out = { canSend: [], noSend: [], dead: [], unknown: [] };

  for (const row of rows) {
    const who = String(row.agent_name || row.user_id || '?').slice(0, 20);
    const box = String(row.email_address || '?').slice(0, 30);
    let verdict, scopes = null, note = '';

    let refresh = null;
    try { refresh = decrypt(row.refresh_token_enc); } catch (_) { refresh = null; }

    if (!refresh) {
      verdict = 'TOKEN DEAD';
      note = 'no refresh token stored';
      out.dead.push({ row, note });
    } else {
      try {
        const fresh = await gmail.refreshAccessToken(refresh);
        try {
          scopes = await gmail.tokenScopes(fresh.accessToken);
          if (!Array.isArray(scopes)) {
            verdict = 'UNKNOWN'; note = 'tokeninfo reported no scope list';
            out.unknown.push({ row, note });
          } else if (scopes.includes(SEND)) {
            verdict = 'CAN SEND'; out.canSend.push({ row, scopes });
          } else {
            verdict = 'NO SEND'; note = short(scopes); out.noSend.push({ row, scopes });
          }
        } catch (e) {
          // The refresh worked, so the grant is live; only the inspection failed.
          // That is a network fact, not a scope fact, and must not be recorded.
          verdict = 'UNKNOWN'; note = 'tokeninfo: ' + e.message.slice(0, 60);
          out.unknown.push({ row, note });
        }
      } catch (e) {
        verdict = 'TOKEN DEAD'; note = e.message.slice(0, 60);
        out.dead.push({ row, note });
      }
    }

    console.log('  ' + who.padEnd(22) + box.padEnd(32) + verdict + (note ? '  ' + note : ''));

    if (WRITE) {
      // ONLY WHAT WE ACTUALLY LEARNED. A dead token tells us nothing about the
      // scopes it was granted, and an unreachable Google tells us nothing at
      // all; writing can_send = false for either would turn an outage into a
      // roster-wide "cannot send" that nobody could explain later.
      if (verdict === 'CAN SEND' || verdict === 'NO SEND') {
        await emailStore.recordGrantedScopes(row.id, scopes, scopes.includes(SEND));
      }
    }
  }

  // ── THE ANSWER, IN THE ORDER SOMEONE WOULD ACT ON IT ──────────────────────
  console.log('\n' + '='.repeat(80));
  console.log(`CAN SEND    ${out.canSend.length}`);
  console.log(`NO SEND     ${out.noSend.length}   <- these agents cannot send and do not know it`);
  console.log(`TOKEN DEAD  ${out.dead.length}   <- also broken; reconnecting fixes it`);
  console.log(`UNKNOWN     ${out.unknown.length}   <- could not check; not recorded either way`);

  if (out.noSend.length) {
    console.log('\nMISSING gmail.send — reconnect and tick "Send email on your behalf":');
    for (const { row, scopes } of out.noSend) {
      console.log(`  ${row.agent_name || row.user_id}  <${row.agent_email || '?'}>`);
      console.log(`      mailbox:   ${row.email_address}`);
      console.log(`      connected: ${row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : '?'}`);
      console.log(`      granted:   ${short(scopes)}`);
    }
  }
  if (out.dead.length) {
    console.log('\nREFRESH TOKEN NO LONGER WORKS — reconnect Google:');
    for (const { row, note } of out.dead) {
      console.log(`  ${row.agent_name || row.user_id}  <${row.agent_email || '?'}>  ${row.email_address}  (${note})`);
    }
  }
  if (out.unknown.length) {
    console.log('\nCOULD NOT CHECK — re-run; nothing was written for these:');
    for (const { row, note } of out.unknown) {
      console.log(`  ${row.agent_name || row.user_id}  ${row.email_address}  (${note})`);
    }
  }
  console.log('');
  if (!WRITE && (out.noSend.length || out.canSend.length)) {
    console.log('Read-only. Re-run with --write to record these on the accounts,');
    console.log('which keeps a non-sending mailbox out of the From picker.\n');
  }

  await P.end();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('THREW', e);
  process.exit(1);
});
