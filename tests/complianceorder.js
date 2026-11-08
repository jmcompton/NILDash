'use strict';
//   node tests/complianceorder.js   (local test Postgres)
//
// ── ONLY COMPLIANT BUSINESSES REACH AN AGENT; AN APPROVED CARD SENDS ────────
// Nov 2026: Children's Hospital of Philadelphia Sports Medicine was sourced,
// verified with Hunter, drafted and approved, then held at send as "a
// university's own address" (chop.edu). One agent had 31 approvals that never
// sent. Now:
//   - the .edu rule counts only a college in the Department of Education
//     directory, and never a hospital or health business (notASponsor);
//   - the send gate's own check runs at selection, before any Hunter credit,
//     and at insertCard on the card's own address (compliance.screenCandidate);
//   - at send, approval wins on soft rules; only hard ones (state law, school
//     rules, an athlete the law cannot be checked for, a trade blocked for a
//     minor) stop an approved email, and those refuse the approval itself.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const C = require(REPO + 'server/services/compliance.js');
const N = require(REPO + 'server/services/notASponsor.js');
const Closer = require(REPO + 'server/services/closer.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };
const AG = 'co-agent';
const P = () => store.pool;
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const WHEN = new Date('2026-11-05T15:00:00Z');
let _clock = WHEN.getTime();
const release = (opts = {}) => { _clock += 15 * 60 * 1000; return Closer.releaseDue(P(), Object.assign({ sleep: async () => {}, now: new Date(_clock) }, opts)); };
function recorder() { const sent = []; return { sent, fn: async (log) => { sent.push(log.brand_name); return { providerMessageId: 'm' + sent.length }; } }; }
async function places(brand, types, extra) {
  await P().query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
     VALUES ($1,'places',$2,$3::jsonb,'OK',NOW())
     ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence, refreshed_at = NOW()`,
    ['co:' + brand.toLowerCase(), brand, JSON.stringify({ found: true, types, name: brand, ...(extra || {}) })]);
}
async function approved(id, brand, email, athleteId) {
  await P().query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,brand_key,subject,body_html,status,sent_to_email,touch_no,scheduled_send_at,approved_at,approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,'<p>x</p>','approved',$7,1,$8,$8,$2)`,
    [id, AG, athleteId, brand, brand.toLowerCase(), 'Quick idea for ' + brand, email, new Date(WHEN.getTime() - 60000)]);
}
async function draftRow(id, brand, email, athleteId) {
  await P().query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,brand_key,subject,body_html,status,sent_to_email,touch_no)
     VALUES ($1,$2,$3,$4,$5,$6,'<p>x</p>','draft',$7,1)`,
    [id, AG, athleteId, brand, brand.toLowerCase(), 'Quick idea for ' + brand, email]);
}
const holds = async (logId) => (await P().query(`SELECT rule_key, severity, resolved_at, resolution FROM compliance_holds WHERE outreach_log_id = $1 ORDER BY id`, [logId])).rows;

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await require(REPO + 'server/services/sendGuard.js').ensureTable(P());
  const clean = async () => {
    for (const q of [`DELETE FROM compliance_holds WHERE agent_id=$1`, `DELETE FROM outreach_logs WHERE agent_id=$1`, `DELETE FROM athletes WHERE agent_id=$1`,
      `DELETE FROM agent_send_budget WHERE agent_id=$1`, `DELETE FROM users WHERE id=$1`]) await P().query(q, [AG]).catch(() => {});
    await P().query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'co:%'`).catch(() => {});
    await P().query(`DELETE FROM email_sends WHERE email LIKE '%@chop.edu' OR email LIKE '%@sas.upenn.edu' OR email LIKE '%@co.example'`).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES ($1,'Order Agent','co@x.com','x','agent','America/Chicago')`, [AG]);
  await P().query(`UPDATE users SET business_street='1 Test St', business_city='Testville', business_state='AL', business_zip='35201' WHERE id=$1`, [AG]);
  await store.saveAthlete('co-a1', { id: 'co-a1', agentId: AG, name: 'Jordan Hale', sport: 'track', school: 'Temple University', over18: true });
  const athlete = { id: 'co-a1', name: 'Jordan Hale', school: 'Temple University', over18: true };

  OUT.push('-- the .edu rule --');
  ok('a hospital on a .edu that is not a college (chop.edu) is a sponsor',
    N.detect("Children's Hospital of Philadelphia Sports Medicine", { email: 'sportsmed@chop.edu' }) === null);
  ok('sports medicine at a university\'s own domain is a sponsor too', N.detect('Penn Medicine Sports Medicine', { email: 'j.doe@pennmedicine.upenn.edu' }) === null);
  ok('a real university department is not', (N.detect('Penn Department of History', { email: 'history@sas.upenn.edu' }) || {}).kind === 'university-department');
  ok('  nor a dean\'s office under a clinic\'s name (colsa.dean@unh.edu)', (N.detect('UNH PAWS Veterinary Clinic', { email: 'colsa.dean@unh.edu' }) || {}).kind === 'university-department');

  OUT.push('', '-- at selection, before any Hunter credit --');
  const CHOP = "Children's Hospital of Philadelphia Sports Medicine";
  const chopPlace = { types: ['hospital', 'health'], primaryType: 'hospital', primaryTypeDisplayName: 'Hospital' };
  ok('the CHOP-style business PASSES selection', (await C.screenCandidate(P(), { brandName: CHOP, place: chopPlace, athlete })) === null);
  ok('  and passes again on its own address (sportsmed@chop.edu)', (await C.screenCandidate(P(), { brandName: CHOP, place: chopPlace, email: 'sportsmed@chop.edu', athlete })) === null);
  const dept = await C.screenCandidate(P(), { brandName: 'Penn Department of History', place: { types: ['university'], primaryType: 'university' }, email: 'history@sas.upenn.edu', athlete });
  ok('a real university department is REJECTED at selection', dept && dept.ruleKey === 'category-not-a-sponsor', dept);
  const noState = await C.screenCandidate(P(), { brandName: 'Joe Coffee', place: { types: ['cafe'] }, athlete: { id: 'x', name: 'No School', over18: true } });
  ok('an athlete whose state cannot be read: rejected at selection as a HARD rule (the law cannot be checked)', noState && noState.ruleKey === 'state-unknown' && noState.hard === true, noState);
  ok('a clean business passes', (await C.screenCandidate(P(), { brandName: 'Joe Coffee', place: { types: ['cafe'] }, athlete })) === null);
  ok('no Places record is not a rejection (approving decides it)', (await C.screenCandidate(P(), { brandName: 'Mystery Co', place: null, athlete })) === null);

  const oq = src('server/jobs/outreachQueue.js');
  const iScreen = oq.indexOf("require('../services/compliance').screenCandidate(pool, {\n            brandName: cand.brand_name, place");
  const iClaim = oq.indexOf('Claims.claimResearch(pool, athleteId, cand.brand_name', iScreen);
  ok('the nightly fill screens AFTER the Places lookup and BEFORE claiming research (any Hunter call)', iScreen > 0 && iClaim > iScreen && oq.indexOf('lookupPlaceResult(cand.brand_name') < iScreen, [iScreen, iClaim]);
  const iProg = oq.indexOf("brandName: cand.brand_name, place: null, website: cand.website || null");
  const iProgClaim = oq.indexOf('Claims.claimResearch(pool, athleteId, cand.brand_name', iProg);
  ok('  the program lane screens before its name search too', iProg > 0 && iProgClaim > iProg && iProgClaim < iScreen, [iProg, iProgClaim]);
  ok('  and a rejection goes on the night\'s row with its reason', /tried\.push\(\{ brand: cand\.brand_name, result: 'rejected', compliance: sc\.ruleKey, reason: 'compliance: ' \+ sc\.why/.test(oq));
  ok('insertCard runs the same screen on the card\'s own address, for every path', /THE SEND GATE'S CHECK, ON THE ADDRESS IT WILL SEND TO[\s\S]{0,1600}screenCandidate\(pool, \{\s*brandName: card\.brandName, place, email: card\.email/.test(oq));

  // insertCard itself: the department is not written; CHOP is.
  const Job = require(REPO + 'server/jobs/outreachQueue.js');
  if (typeof Job.insertCard === 'function') {
    await places('Penn Department of History', ['university']);
    const deptCard = { brandName: 'Penn Department of History', brandKey: 'penn department of history', channel: 'email', email: 'history@sas.upenn.edu', contactName: 'Ann Smith', emailBody: 'Hi Ann,\n\nx', subject: 'Quick idea' };
    const w = await Job.insertCard(P(), { agentId: AG, athleteId: 'co-a1', slot: 1, card: deptCard });
    ok('insertCard does not write a university department card', w === false, w);
  } else OUT.push('SKIP insertCard is not exported; covered by the source check above');

  OUT.push('', '-- at send: an approved CHOP card SENDS --');
  await places(CHOP, ['hospital', 'health'], { primaryType: 'hospital' });
  await approved('co-1', CHOP, 'sportsmed@chop.edu', 'co-a1');
  // the hold that stopped it in production, already open on the row
  await P().query(`INSERT INTO compliance_holds (agent_id, athlete_id, outreach_log_id, brand_name, brand_key, rule_key, rule_label, severity, reason, facts, rules_version, unchecked)
    VALUES ($1,'co-a1','co-1',$2,$3,'category-not-a-sponsor','not a sponsor','block','chop.edu is a university''s own address','{"source":"rule"}'::jsonb,'t','[]'::jsonb)`, [AG, CHOP, CHOP.toLowerCase()]);
  const r1 = recorder();
  await release({ send: r1.fn });
  ok('the approved CHOP email is SENT', r1.sent.includes(CHOP), r1.sent);
  const h1 = await holds('co-1');
  ok('  the old soft hold is resolved on the record as approved by the agent', h1.length && h1.every((h) => h.resolved_at && h.resolution === 'approved-by-agent'), h1);

  OUT.push('', '-- at send: approval wins on soft rules, hard rules still stop --');
  await places('Bayside Supplements', ['store']);
  await approved('co-2', 'Bayside Supplements', 'owner@co.example', 'co-a1');
  const r2 = recorder();
  await release({ send: r2.fn });
  ok('a soft finding (supplements, a judgment) does not stop an approved email', r2.sent.includes('Bayside Supplements'), r2.sent);
  ok('  and is written to the record as approved by the agent', (await holds('co-2')).some((h) => h.rule_key === 'category-supplements' && h.resolution === 'approved-by-agent'), await holds('co-2'));
  await store.saveAthlete('co-a2', { id: 'co-a2', agentId: AG, name: 'Minor Athlete', sport: 'soccer', school: 'Temple University', over18: false });
  await places('Kessler Liquor', ['liquor_store']);
  await approved('co-3', 'Kessler Liquor', 'kessler@co.example', 'co-a2');
  const r3 = recorder();
  await release({ send: r3.fn });
  ok('a HARD rule (alcohol to a minor) still stops an approved email', !r3.sent.includes('Kessler Liquor'), r3.sent);
  ok('  isHard: school rule, state rule, state unknown, a minor\'s restricted trade are hard; not-a-sponsor is soft',
    C.isHard({ ruleKey: 'school-restricted-alcohol' }) && C.isHard({ ruleKey: 'category-alcohol', severity: 'hold', source: 'state-rule' })
      && C.isHard({ ruleKey: 'state-unknown' }) && C.isHard({ ruleKey: 'category-alcohol', severity: 'block' })
      && !C.isHard({ ruleKey: 'category-not-a-sponsor', severity: 'block' }) && !C.isHard({ ruleKey: 'category-unknown', severity: 'hold' }));

  OUT.push('', '-- at approval: a hard rule refuses the approval, with the reason --');
  await draftRow('co-4', 'Kessler Liquor', 'kessler2@co.example', 'co-a2');
  await draftRow('co-5', 'Joe Coffee Shop', 'joe@co.example', 'co-a1');
  await places('Joe Coffee Shop', ['cafe']);
  const ap = await Closer.approveBatch(P(), AG, { ids: ['co-4', 'co-5'] });
  const st4 = (await P().query(`SELECT status FROM outreach_logs WHERE id='co-4'`)).rows[0].status;
  const st5 = (await P().query(`SELECT status FROM outreach_logs WHERE id='co-5'`)).rows[0].status;
  ok('the minor\'s liquor draft is NOT approved and stays a draft', st4 === 'draft', st4);
  ok('  the reason is returned to the card', ap && /cannot be sent/.test(ap.note || '') && (ap.dropped || []).some((d) => d.id === 'co-4' && d.hard), ap && { note: ap.note, dropped: ap.dropped });
  ok('  the coffee draft beside it is approved', st5 === 'approved', st5);

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  console.log(OUT.join('\n'));
  console.log(`\n${OUT.filter((l) => l.startsWith('PASS')).length} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
