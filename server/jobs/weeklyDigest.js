'use strict';
// Weekly digest runner: recipient selection, claim, render, send, log.
//
// Usable three ways, all through the same code path so the dry run tells the truth
// about what a real send would do:
//
//   node server/jobs/weeklyDigest.js --dry-run              build every email, print, send nothing
//   node server/jobs/weeklyDigest.js --dry-run --full       also print the rendered HTML
//   node server/jobs/weeklyDigest.js --send                 the real weekly run
//   node server/jobs/weeklyDigest.js --test --to me@x.com   one test digest to one address
//   node server/jobs/weeklyDigest.js --status               who has been sent this week
//
// THE DOUBLE-SEND GUARD. claimSend() inserts into digest_sends with ON CONFLICT DO
// NOTHING and checks whether a row was actually written. Two processes racing the
// same agent: one gets the row, the other gets zero and stops. The claim happens
// BEFORE the send, so a crash between claim and send means that agent misses a week
// rather than being emailed twice. That is the right way round for a re-engagement
// email nobody asked for.

const store = require('../store');
const digest = require('../services/weeklyDigest');

const APP_URL = process.env.APP_URL || 'https://mynildash.com';
// A bulk weekly email should not share a from-address with password resets: a
// complaint against this must not damage the deliverability of those.
const DIGEST_FROM = process.env.DIGEST_FROM || 'NILDash <hello@mynildash.com>';

function crypto() { return require('crypto'); }

// Every agent who could receive a digest. Comped agents are INCLUDED on purpose:
// they are the ones who never log in, which is the entire reason this exists.
// Archived accounts and unsubscribes are excluded.
async function recipients(pool, onlyEmail) {
  const params = [];
  let where = `role IN ('agent','admin') AND archived IS NOT TRUE AND digest_unsubscribed IS NOT TRUE`;
  if (onlyEmail) { params.push(String(onlyEmail).toLowerCase()); where += ` AND LOWER(email) = $1`; }
  const r = await pool.query(`
    SELECT id, name, email, comped, plan, subscription_status, last_login,
           digest_unsubscribed, digest_unsub_token
    FROM users WHERE ${where} ORDER BY created_at ASC
  `, params);
  return r.rows;
}

// Lazily mint the unsubscribe token. Doing it here rather than at signup means
// existing accounts get one without a backfill.
async function unsubToken(pool, user) {
  if (user.digest_unsub_token) return user.digest_unsub_token;
  const token = crypto().randomBytes(24).toString('hex');
  await pool.query('UPDATE users SET digest_unsub_token = $1 WHERE id = $2 AND digest_unsub_token IS NULL', [token, user.id]);
  const r = await pool.query('SELECT digest_unsub_token FROM users WHERE id = $1', [user.id]);
  return (r.rows[0] && r.rows[0].digest_unsub_token) || token;
}

// Returns true if THIS process now owns this agent's send for this week.
async function claimSend(pool, agentId, weekStart, meta) {
  const r = await pool.query(`
    INSERT INTO digest_sends (agent_id, week_start, email, subject, status, new_matches, awaiting_reply, going_cold)
    VALUES ($1,$2,$3,$4,'claimed',$5,$6,$7)
    ON CONFLICT (agent_id, week_start) DO NOTHING
    RETURNING id
  `, [agentId, weekStart, meta.email || null, meta.subject || null,
      meta.newMatches || 0, meta.awaitingReply || 0, meta.goingCold || 0]);
  return r.rows[0] ? r.rows[0].id : null;
}

async function markSent(pool, id, providerId) {
  await pool.query(`UPDATE digest_sends SET status='sent', provider_id=$1, sent_at=NOW() WHERE id=$2`, [providerId || null, id]);
}
async function markFailed(pool, id, err) {
  await pool.query(`UPDATE digest_sends SET status='failed', error=$1 WHERE id=$2`, [String(err || '').slice(0, 500), id]);
}

// Build one agent's digest, including the drafted follow-up. Shared by the dry run
// and the real send so what you preview is what goes out.
async function buildFor(pool, user, ai, nowMs) {
  const d = await digest.gatherAgentDigest(pool, user, nowMs);
  if (d.action) {
    const draft = await digest.draftFollowUp(d.action, ai);
    d.action.followUpSubject = draft.subject;
    d.action.followUpBody = draft.body;
  }
  return d;
}

async function run(opts = {}) {
  const pool = store.pool;
  const ai = opts.noAi ? null : require('../ai');
  const now = opts.nowMs || Date.now();
  const weekStart = digest.weekStartCentral(now);
  const dryRun = !!opts.dryRun;

  if (!dryRun && !opts.force && !digest.sendWindowOpen(now)) {
    console.log(`[digest] send window for week ${weekStart} has not opened yet (Monday ${digest.SEND_HOUR_CENTRAL}am Central). Nothing to do.`);
    return { weekStart, sent: 0, skipped: 0, considered: 0 };
  }

  const users = await recipients(pool, opts.onlyEmail);
  console.log(`[digest] week=${weekStart} candidates=${users.length}${dryRun ? ' DRY RUN, nothing will be sent' : ''}`);

  let sent = 0, skipped = 0, failed = 0, claimedElsewhere = 0;
  const skips = [];

  for (const user of users) {
    let d;
    try { d = await buildFor(pool, user, ai, now); }
    catch (e) { console.error(`[digest] build failed for ${user.email}: ${e.message}`); failed++; continue; }

    if (!digest.shouldSend(d)) {
      skipped++;
      skips.push({ email: user.email, reason: digest.skipReason(d) });
      continue;
    }

    const subject = digest.buildSubject(d);
    const token = dryRun ? 'DRYRUN' : await unsubToken(pool, user);
    const html = digest.renderHtml(d, { appUrl: APP_URL, unsubToken: token });
    const text = digest.renderText(d);

    if (dryRun) {
      console.log('\n' + '='.repeat(70));
      console.log(`TO      ${user.name || '(no name)'} <${user.email}>${user.comped ? '  [comped]' : ''}`);
      console.log(`SUBJECT ${subject}`);
      console.log(`COUNTS  ${d.counts.newMatches} new / ${d.counts.awaitingReply} awaiting / ${d.counts.goingCold} cold`);
      if (d.action) {
        console.log(`ACTION  ${d.action.brand_name} via ${d.action.contact_name || 'no contact'} (${d.action.days_since}d)`);
        console.log(`DRAFT   ${String(d.action.followUpBody || '').replace(/\n/g, '\n        ')}`);
      } else console.log('ACTION  (none)');
      for (const o of d.newOpps) {
        console.log(`OPP     ${o.brand_name} for ${o.athlete_name || '?'}${o.compatibility_score != null ? ' fit ' + Math.round(Number(o.compatibility_score)) : ''}`
          + `${o.contact_name ? ' | ' + o.contact_name : ' | no contact'}`);
      }
      if (opts.full) console.log('\n--- HTML ---\n' + html);
      console.log(`TEXT BYTES ${text.length}, HTML BYTES ${html.length}`);
      sent++;
      continue;
    }

    // Claim first. Losing the race means another process already has this agent.
    const claimId = await claimSend(pool, user.id, weekStart, {
      email: user.email, subject,
      newMatches: d.counts.newMatches, awaitingReply: d.counts.awaitingReply, goingCold: d.counts.goingCold,
    });
    if (!claimId) {
      claimedElsewhere++;
      console.log(`[digest] ${user.email} already claimed for week ${weekStart}, skipping`);
      continue;
    }

    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const unsubUrl = `${APP_URL}/api/digest/unsubscribe?token=${encodeURIComponent(token)}`;
      const result = await resend.emails.send({
        from: DIGEST_FROM,
        to: user.email,
        subject,
        html,
        text,
        // One-click unsubscribe. Gmail and Outlook surface this in their own UI, and
        // a reader who can leave in one tap marks spam instead when they cannot.
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      await markSent(pool, claimId, result && result.data && result.data.id);
      sent++;
      console.log(`[digest] SENT ${user.email} "${subject}"`);
    } catch (e) {
      await markFailed(pool, claimId, e.message);
      failed++;
      console.error(`[digest] send FAILED ${user.email}: ${e.message}`);
    }
  }

  console.log(`\n[digest] week=${weekStart} ${dryRun ? 'would send' : 'sent'}=${sent} skipped=${skipped} failed=${failed} alreadyClaimed=${claimedElsewhere}`);
  if (skips.length) {
    console.log(`\nSKIPPED (${skips.length}), and why:`);
    for (const s of skips) console.log(`  ${s.email}: ${s.reason}`);
  }
  return { weekStart, sent, skipped, failed, claimedElsewhere, considered: users.length };
}

// A single test digest to one address, ignoring the week claim entirely so it can be
// run repeatedly. Never writes to digest_sends: a test must not consume the real send.
async function sendTest(toEmail, opts = {}) {
  const pool = store.pool;
  const ai = opts.noAi ? null : require('../ai');
  const now = opts.nowMs || Date.now();
  const r = await pool.query(
    `SELECT id, name, email, comped, digest_unsubscribed, digest_unsub_token
     FROM users WHERE LOWER(email) = $1 LIMIT 1`, [String(toEmail).toLowerCase()]);
  const user = r.rows[0];
  if (!user) throw new Error(`no user with email ${toEmail}`);

  const d = await buildFor(pool, user, ai, now);
  const real = digest.shouldSend(d);
  // A test on an empty account would send nothing, which tells you nothing about
  // whether the email renders or lands. Fill in a clearly-labelled sample instead.
  if (!real) {
    d.counts = { newMatches: 3, awaitingReply: 2, goingCold: 1 };
    d.action = {
      brand_name: 'SAMPLE: Riverside Coffee Co', contact_name: 'Sample Contact',
      contact_title: 'Owner', contact_email: user.email, athlete_name: 'Sample Athlete',
      days_since: 6, subject: 'Partnership with Sample Athlete',
      followUpSubject: 'Re: Partnership with Sample Athlete',
      followUpBody: 'This is a SAMPLE follow-up. Your account had no real pending outreach, so the digest filled in example content to show you the layout.',
    };
    d.newOpps = [{
      brand_name: 'SAMPLE: Northside Auto', athlete_name: 'Sample Athlete',
      compatibility_score: 82, contact_name: 'Sample Manager', contact_title: 'GM',
      contact_email: 'sample@example.com',
    }];
  }

  const token = await unsubToken(pool, user);
  const subject = (real ? '' : '[TEST] ') + digest.buildSubject(d);
  const html = digest.renderHtml(d, { appUrl: APP_URL, unsubToken: token });
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const unsubUrl = `${APP_URL}/api/digest/unsubscribe?token=${encodeURIComponent(token)}`;
  const result = await resend.emails.send({
    from: DIGEST_FROM, to: user.email, subject, html, text: digest.renderText(d),
    headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
  console.log(`[digest] TEST sent to ${user.email} "${subject}" real=${real}`);
  return { ok: true, to: user.email, subject, usedRealData: real, providerId: result && result.data && result.data.id };
}

async function status(nowMs) {
  const weekStart = digest.weekStartCentral(nowMs || Date.now());
  const r = await store.pool.query(
    `SELECT agent_id, email, subject, status, provider_id, error, new_matches, awaiting_reply, going_cold, created_at, sent_at
     FROM digest_sends WHERE week_start = $1 ORDER BY created_at ASC`, [weekStart]);
  console.log(`week ${weekStart}: ${r.rows.length} row(s)`);
  for (const s of r.rows) {
    console.log(`  ${String(s.status).padEnd(8)} ${String(s.email || '').padEnd(32)} ${s.subject || ''}${s.error ? '  ERROR: ' + s.error : ''}`);
  }
  return r.rows;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const idx = (f) => args.indexOf(f);
  const val = (f) => (idx(f) !== -1 ? args[idx(f) + 1] : null);
  (async () => {
    try {
      if (args.includes('--status')) { await status(); return; }
      if (args.includes('--test')) {
        const to = val('--to');
        if (!to) { console.log('Usage: --test --to you@example.com'); return; }
        await sendTest(to, { noAi: args.includes('--no-ai') });
        return;
      }
      if (!args.includes('--send') && !args.includes('--dry-run')) {
        console.log('Usage:\n  --dry-run [--full] [--agent email]   build everything, send nothing'
          + '\n  --send [--force]                     the real run (--force ignores the Monday window)'
          + '\n  --test --to you@example.com          one test email, never consumes the weekly send'
          + '\n  --status                             this week\'s send log');
        return;
      }
      await run({
        dryRun: args.includes('--dry-run'),
        full: args.includes('--full'),
        force: args.includes('--force'),
        onlyEmail: val('--agent'),
        noAi: args.includes('--no-ai'),
      });
    } catch (e) {
      console.error('[digest] fatal:', e.message);
      process.exitCode = 1;
    } finally {
      if (store.pool && store.pool.end) await store.pool.end().catch(() => {});
    }
  })();
}

module.exports = { run, sendTest, status, recipients, claimSend, buildFor, unsubToken, DIGEST_FROM };
