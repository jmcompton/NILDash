'use strict';
// Against the local Postgres, because the claim being tested is a claim about
// the database: one click stops every agent, not the one whose pitch the
// business happened to receive.
//
//   node tests/run.js             every suite, against the committed baseline
//   node tests/unsubscribe.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
process.env.APP_URL = 'https://mynildash.com';
process.env.BUSINESS_MAILING_ADDRESS = 'Compton Group LLC, 123 Example St, Birmingham, AL 35203';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const store = require(REPO + 'server/store');
const C = require(REPO + 'server/services/canSpam.js');
const sendRules = require(REPO + 'server/services/sendRules.js');
const suppression = require(REPO + 'server/services/suppression.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER = 'dana@ramajamas.example';

async function main() {
  await wait(TEST_INIT_WAIT_MS);
  const pool = store.pool;
  await sendRules.ensureTable(pool);

  // Two agents, both working the same business. This is the whole point: they
  // do not share a roster, a mailbox or a pipeline, and until the suppression
  // list they had no way to know the other had been told to stop.
  await pool.query(`DELETE FROM email_suppression WHERE email = $1`, [OWNER]);
  await pool.query(`DELETE FROM email_sends WHERE email = $1`, [OWNER]);
  await pool.query(`DELETE FROM outreach_logs WHERE id LIKE 'unsub_%'`);
  await pool.query(`DELETE FROM athletes WHERE id IN ('unsub_at_a','unsub_at_b')`);
  await pool.query(`DELETE FROM users WHERE id IN ('unsub_a','unsub_b')`);
  await pool.query(`INSERT INTO users (id,name,email,password,role) VALUES
    ('unsub_a','Agent A','a@example.com','x','agent'),
    ('unsub_b','Agent B','b@example.com','x','agent')`);
  await pool.query(`INSERT INTO athletes (id,agent_id,data) VALUES
    ('unsub_at_a','unsub_a','{"name":"Marcus"}'::jsonb),
    ('unsub_at_b','unsub_b','{"name":"Amari"}'::jsonb)`);
  await pool.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email)
     VALUES ('unsub_a1','unsub_a','unsub_at_a','Rama Jamas','A follow-up for Marcus','<p>hi</p>','approved',$1),
            ('unsub_b1','unsub_b','unsub_at_b','Rama Jamas','A note about Amari','<p>hi</p>','approved',$1),
            ('unsub_b2','unsub_b','unsub_at_b','Rama Jamas','Already gone','<p>hi</p>','sent',$1)`, [OWNER]);

  // ── THE CLICK ──────────────────────────────────────────────────────────
  // Exactly what the route does: read the address out of the signed token in
  // the link, then write it to the list.
  OUT.push('-- the click --');
  const token = C.tokenFor(OWNER);
  const fromLink = C.emailFromToken(token);
  ok('the address comes back out of the link the business was sent', fromLink === OWNER, fromLink);

  const before = await sendRules.check(pool, { email: OWNER, subject: 'A brand new subject', system: 'closer' });
  ok('before the click, a first pitch to this address is allowed', before.ok === true, before);

  const out = await sendRules.suppressManually(pool, fromLink, {
    reason: 'unsubscribed from an outreach email', kind: 'unsubscribe',
  });
  ok('the click writes to the suppression list', out.ok === true, out);

  // ── AND IT STOPS EVERY AGENT ───────────────────────────────────────────
  OUT.push('', '-- every agent, not just the one they heard from --');
  const sup = await suppression.isSuppressed(pool, OWNER);
  ok('the address is suppressed', sup.suppressed === true, sup);
  ok('  and the list says it was an unsubscribe, not a bounce and not a row we added',
    (await pool.query(`SELECT kind, reason FROM email_suppression WHERE email=$1`, [OWNER])).rows[0].kind === 'unsubscribe');

  for (const system of ['closer', 'follow-up', 'manual', 'compose', 'athlete', 'growth']) {
    const r = await sendRules.check(pool, { email: OWNER, subject: 'Something else entirely ' + system, system });
    ok(`  ${system} is refused now`, r.ok === false && r.kind === 'suppressed', r);
  }

  const stopped = await pool.query(
    `SELECT id, cadence_stopped_at FROM outreach_logs WHERE id LIKE 'unsub_%' ORDER BY id`);
  const byId = Object.fromEntries(stopped.rows.map((r) => [r.id, !!r.cadence_stopped_at]));
  ok('EVERY QUEUED MESSAGE TO THAT ADDRESS STOPS, ON BOTH ROSTERS',
    byId.unsub_a1 === true && byId.unsub_b1 === true, byId);
  ok('  and a message already sent is left alone, because it cannot be unsent', byId.unsub_b2 === false, byId);
  ok('  the count came back on the result, so the log can say how many', out.stopped >= 2, out.stopped);

  // A suppressed address is refused even for a subject nobody has used and on
  // a day nothing else went out: the list is a stop, not a rate limit.
  const fresh = await sendRules.check(pool, {
    email: OWNER, subject: 'Completely unrelated ' + Date.now(), system: 'closer',
    now: new Date(Date.now() + 90 * 86400000),
  });
  ok('NINETY DAYS LATER IT IS STILL REFUSED (CAN-SPAM asks for 30)', fresh.ok === false && fresh.kind === 'suppressed', fresh);

  // ── AN AGENT CANNOT UNDO SOMEBODY ELSE'S OPT-OUT BY ACCIDENT ───────────
  OUT.push('', '-- and it is not undone by the next pitch --');
  await pool.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email)
     VALUES ('unsub_c1','unsub_a','unsub_at_a','Rama Jamas','A third athlete entirely','<p>hi</p>','approved',$1)`, [OWNER]);
  const later = await sendRules.check(pool, { email: OWNER, subject: 'A third athlete entirely', system: 'closer', refId: 'unsub_c1' });
  ok('a new draft for a third athlete is still refused', later.ok === false && later.kind === 'suppressed', later);

  // ── AND IT IS NOT OURS TO UNDO ────────────────────────────────────────
  OUT.push('', '-- undoing it --');
  const undo = await sendRules.unsuppress(pool, OWNER);
  ok('AN OPT-OUT CANNOT BE LIFTED FROM THE ADMIN PAGE', undo.ok === false, undo);
  ok('  and it says why, rather than failing silently', /CAN-SPAM/.test(undo.error || ''), undo.error);
  ok('  the address is still on the list after the attempt',
    (await suppression.isSuppressed(pool, OWNER)).suppressed === true);

  // A bounce is a different thing: the mailbox may have been fixed, and
  // taking it off again is routine.
  await pool.query(`DELETE FROM email_suppression WHERE email = $1`, [OWNER]);
  await suppression.suppress(pool, OWNER, { reason: 'hard bounce', kind: 'bounce' });
  const undoBounce = await sendRules.unsuppress(pool, OWNER);
  ok('a BOUNCED address can still be taken off, because that is not an opt-out',
    undoBounce.ok === true && undoBounce.removed === 1, undoBounce);

  await pool.query(`DELETE FROM outreach_logs WHERE id LIKE 'unsub_%'`);
  await pool.query(`DELETE FROM athletes WHERE id IN ('unsub_at_a','unsub_at_b')`);
  await pool.query(`DELETE FROM users WHERE id IN ('unsub_a','unsub_b')`);
  await pool.query(`DELETE FROM email_suppression WHERE email = $1`, [OWNER]);
  await pool.query(`DELETE FROM email_sends WHERE email = $1`, [OWNER]);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('unsubscribe: FAILED', e); process.exit(1); });
