'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// "WE DO NOT HOLD THIS" IS NOT "WE CANNOT READ THIS".
//
// Collapsing the two is how an empty roster table survived: every pitch held on
// unknown age, which is exactly what a correctly-working gate over a roster with
// no birthdays looks like. Indistinguishable, so nobody looked.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const co = require(ROOT + 'server/services/compliance.js');
const Closer = require(ROOT + 'server/services/closer.js');
const shiftReport = require(ROOT + 'server/services/shiftReport.js');

let F = 0;
const ok = (n, c, g) => { if (c) console.log('  PASS ' + n); else { F++; console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'unread-agent';
const NOW = new Date('2026-08-24T00:00:00Z');

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. ageFrom TELLS THE THREE APART ─────────────────────────────────────
  console.log('\n-- 1. three outcomes, not two --');
  const known = co.ageFrom('2005-03-01', NOW);
  ok('a real date gives an age', known.known === true && known.years === 21, known);
  ok('  with no reason attached', known.reason === null, known.reason);

  const absent = co.ageFrom(null, NOW);
  ok('NO DATE ON FILE reads as absent', absent.known === false && absent.reason === 'absent', absent);

  const unread = co.ageFrom(null, NOW, { sourceUnreadable: true, sourceDetail: 'no athlete row' });
  ok('AN UNREADABLE SOURCE reads as unreadable', unread.reason === 'unreadable', unread);
  ok('  and carries what went wrong', /no athlete row/.test(unread.detail), unread.detail);
  ok('  the two are DIFFERENT, which is the whole point', absent.reason !== unread.reason);

  for (const [label, bad] of [['a corrupt date', 'not-a-date'],
    ['a future date', '2099-01-01'], ['an impossible age', '1700-01-01']]) {
    const r = co.ageFrom(bad, NOW);
    ok(`  ${label} is a FAULT, not a blank`, r.reason === 'unreadable', r);
  }

  // ── 2. THE GATE ERRORS RATHER THAN HOLDING ───────────────────────────────
  console.log('\n-- 2. the gate reports a fault, and still stops the send --');
  const base = { brandName: 'Kessler Liquor', evidence: { types: ['liquor_store'], found: true },
    athleteName: 'Marcus Hall', now: NOW };

  const holdRes = await co.evaluate(P, { ...base, dob: null });
  ok('no birthday on file is a HOLD', holdRes.decision === 'hold', holdRes.decision);
  ok('  and not flagged as a source error', !holdRes.sourceError);

  const errRes = await co.evaluate(P, { ...base, dob: null,
    athleteUnreadable: true, athleteUnreadableDetail: 'athlete_id a-1 has no row in athletes' });
  ok('AN UNREADABLE ATHLETE IS A BLOCK, not a hold', errRes.decision === 'block', errRes.decision);
  ok('  flagged as a source error', errRes.sourceError === true, errRes.sourceError);
  ok('  under its own rule key', errRes.findings[0].ruleKey === 'source-unreadable', errRes.findings[0].ruleKey);
  ok('  naming the broken read, not a missing birthday',
    /has no row in athletes/.test(errRes.findings[0].reason), errRes.findings[0].reason);
  ok('  and saying it is not a missing birthday in words',
    /not a\s*\n?\s*missing birthday/.test(errRes.findings[0].reason), errRes.findings[0].reason);
  ok('  nothing was sent either way', errRes.decision !== 'pass');

  // A source error must not be overridable: there is nothing to decide.
  ok('  it is a block, so overrideHold will refuse it',
    errRes.findings[0].severity === 'block', errRes.findings[0].severity);

  // ── 3. AN ORPHANED DRAFT REACHES THE SEND LOOP AT ALL ────────────────────
  // The inner join used to make it VANISH -- not held, not failed, not counted.
  console.log('\n-- 3. a draft whose athlete is missing does not disappear --');
  const clean = async () => {
    await P.query(`DELETE FROM compliance_holds WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'U','u@x.com','x','agent','America/Chicago')`, [AG]);
  // NO athletes row is inserted. This is the empty-roster shape.
  await P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,
                                sent_to_email,scheduled_send_at,approved_at,touch_no)
     VALUES ('ur-1',$1,'ghost-athlete','Kessler Liquor','Hi','<p>x</p>','approved',
             'a@b.example', NOW() - INTERVAL '1 hour', NOW(), 1)`, [AG]);

  let sent = 0;
  const out = await Closer.releaseDue(P, {
    now: new Date(), send: async () => { sent++; return { providerMessageId: 'x' }; },
  });
  ok('the orphaned draft was CONSIDERED', out.considered >= 1, out.considered);
  ok('  nothing was sent', sent === 0, sent);
  ok('  it was held, not silently skipped', out.held >= 1, out);
  const detail = (out.detail || []).find((d) => d.id === 'ur-1');
  ok('  and it appears in the detail with a reason', !!detail && /athlete record/.test(detail.why || ''), detail);

  const rec = (await P.query(
    `SELECT rule_key, severity, reason FROM compliance_holds WHERE outreach_log_id='ur-1'`)).rows[0];
  ok('  the fault is ON THE RECORD', !!rec, rec);
  ok('    as source-unreadable', rec && rec.rule_key === 'source-unreadable', rec && rec.rule_key);
  ok('    at block severity', rec && rec.severity === 'block', rec && rec.severity);

  // ── 4. IT READS AS A FAULT ON THE PAGE, NOT AS A BACKLOG ─────────────────
  console.log('\n-- 4. the morning report does not disguise it as a decision --');
  const rep = await shiftReport.buildShiftReport(P, AG);
  const item = (rep.needsYou.items || []).find((i) => i.kind === 'compliance');
  ok('it reaches Needs you', !!item, rep.needsYou.items.map((i) => i.kind));
  ok('  marked as a fault', item && item.isFault === true, item && item.isFault);
  ok('  worded as a broken read, not a hold',
    item && /could not be checked — the athlete record is missing/.test(item.line), item && item.line);
  ok('  and does not invite a decision nobody can make',
    item && /fault, not a decision/.test(item.actionLabel), item && item.actionLabel);

  // A fault outranks an ordinary hold even when the hold is older.
  await P.query(
    `INSERT INTO compliance_holds (agent_id, athlete_id, outreach_log_id, brand_name,
                                   rule_key, rule_label, severity, reason, created_at)
     VALUES ($1,'x','ur-old','Old Bar','category-alcohol','alcohol','hold','older',
             NOW() - INTERVAL '2 days')`, [AG]);
  const rep2 = await shiftReport.buildShiftReport(P, AG);
  const first = (rep2.needsYou.items || []).filter((i) => i.kind === 'compliance')[0];
  ok('  and sorts above an older ordinary hold', first && first.isFault === true,
    (rep2.needsYou.items || []).filter((i) => i.kind === 'compliance').map((i) => i.detail));

  await clean();
  console.log('\nfailures: ' + F);
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
