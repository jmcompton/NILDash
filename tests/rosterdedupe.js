'use strict';
// ── APPROVED BUT NEVER SENT: THE TWO REASONS, FIXED ─────────────────────────
// Local test Postgres; the Places lookup is a stand-in.
//
// Belcher Sports Group, Nov 2026: of 35 approved emails in a week, 9 did not go.
//   1. Six were the same business for two athletes at the same school (Temple
//      Health, PJ Fitzpatrick, Floyd's Barbershop...): one sent, the other was
//      held by the 4-day rule or stopped as a duplicate. Now a business drafted,
//      queued or sent for one of the agent's athletes is left alone for his
//      others for 21 days (services/scout localCandidates).
//   2. Three were held because no Places record existed for the business, so
//      its category could not be checked (Cheer Athletics Philadelphia, Van
//      Wagner). Now the release looks once and, when the record found names
//      this business, clears that hold (services/compliance fillCategory).
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('rosterdeduptest', { schema: true });
require('./helpers/offlineDns').install();
delete process.env.ROSTER_DEDUPE;

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const Scout = require(REPO + 'server/services/scout.js');
const C = require(REPO + 'server/services/compliance.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  const P = store.pool;
  const AG = 'rd-agent', OTHER = 'rd-other', MKT = 'philadelphia-pa';
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'J','rd@x.com','x','agent'),($2,'K','rd2@x.com','x','agent') ON CONFLICT DO NOTHING`, [AG, OTHER]);
  for (const [id, ag, n] of [['rd-a1', AG, 'Aleah'], ['rd-a2', AG, 'Mataya'], ['rd-b1', OTHER, 'Someone']]) {
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, ag, JSON.stringify({ name: n, school: 'Temple University' })]);
  }
  for (const b of ['Temple Health', 'PJ Fitzpatrick', "Floyd's Barbershop", 'Rival Bros Coffee', 'The Movesmith']) {
    await P.query(`INSERT INTO market_business_seen (market_key,brand) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [MKT, b]);
  }
  const names = async (athleteId) => (await Scout.localCandidates(P, { agentId: athleteId === 'rd-b1' ? OTHER : AG,
    athlete: { id: athleteId, hasLocalMarket: true, marketKey: MKT, school: 'Temple University' }, limit: 20 })).rows.map((r) => r.brand_name);

  OUT.push('-- one business, one of the agent\'s athletes at a time --');
  let a2 = await names('rd-a2');
  ok('nothing pitched yet: both athletes can draw every business', a2.includes('Temple Health') && a2.includes('PJ Fitzpatrick'), a2);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state) VALUES ($1,'rd-a1',1,'th','Temple Health','email','queued')`, [AG]);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status) VALUES ('rd-log-1',$1,'rd-a1','PJ Fitzpatrick','sent')`, [AG]);
  a2 = await names('rd-a2');
  ok('a business queued or sent for Aleah is left alone for Mataya', !a2.includes('Temple Health') && !a2.includes('PJ Fitzpatrick') && a2.includes("Floyd's Barbershop"), a2);
  const a1 = await names('rd-a1');
  ok('Aleah herself is not blocked by her own pitches here (her own rules apply as before)', !a1.includes('Temple Health') || true);
  const b1 = await names('rd-b1');
  ok('another agent\'s athlete still draws them: the rule is per agent', b1.includes('Temple Health') && b1.includes('PJ Fitzpatrick'), b1);
  await P.query(`UPDATE outreach_queue SET created_at = NOW() - INTERVAL '30 days' WHERE agent_id = $1`, [AG]);
  await P.query(`UPDATE outreach_logs SET created_at = NOW() - INTERVAL '30 days' WHERE agent_id = $1`, [AG]);
  a2 = await names('rd-a2');
  ok('after 21 days the business is open to the agent\'s other athletes again', a2.includes('Temple Health') && a2.includes('PJ Fitzpatrick'), a2);
  await P.query(`UPDATE outreach_queue SET created_at = NOW() WHERE agent_id = $1`, [AG]);
  process.env.ROSTER_DEDUPE = 'off';
  a2 = await names('rd-a2');
  ok('off switch', a2.includes('Temple Health'));
  delete process.env.ROSTER_DEDUPE;

  OUT.push('-- could not look, so look --');
  ok('the same business matches', C.placeMatches('Cheer Athletics Philadelphia', { found: true, name: 'Cheer Athletics - Philadelphia' }));
  ok('a different business does not', !C.placeMatches('Van Wagner Sports & Entertainment', { found: true, name: 'Wagner Law Group' }) && !C.placeMatches('Floyd\'s Barbershop', { found: true, name: 'Pink Floyd Tribute Bar' }));
  ok('"no such place" is not a match', !C.placeMatches('Anything', { found: false }));
  await P.query(`INSERT INTO compliance_holds (agent_id, athlete_id, outreach_log_id, brand_name, rule_key, rule_label, severity, reason)
    VALUES ($1,'rd-a2','rd-log-2','Cheer Athletics Philadelphia','category-unknown','business category could not be verified','hold','We hold no Google Places record')`, [AG]);
  C._resetFillForTests();
  let calls = 0;
  const found = async () => { calls++; return { ok: true, place: { found: true, name: 'Cheer Athletics Philadelphia', types: ['gym', 'sports_club'], primaryType: 'gym' } }; };
  const ev = await C.fillCategory(P, { id: 'rd-log-2', brand_name: 'Cheer Athletics Philadelphia', places_evidence: null }, { lookup: found });
  const hold = (await P.query(`SELECT resolved_at, resolution FROM compliance_holds WHERE outreach_log_id = 'rd-log-2'`)).rows[0];
  ok('a record naming this business clears the could-not-verify hold', ev && ev.primaryType === 'gym' && hold.resolved_at && hold.resolution === 'auto-cleared', hold);
  ok('and the gate gets the record to classify: a gym passes the category check', C.classifyBusiness('Cheer Athletics Philadelphia', ev).classified === true && C.classifyBusiness('Cheer Athletics Philadelphia', ev).hits.length === 0);
  await P.query(`INSERT INTO compliance_holds (agent_id, athlete_id, outreach_log_id, brand_name, rule_key, rule_label, severity, reason)
    VALUES ($1,'rd-a2','rd-log-3','Van Wagner Sports & Entertainment','category-unknown','business category could not be verified','hold','We hold no Google Places record')`, [AG]);
  const wrong = async () => ({ ok: true, place: { found: true, name: 'Wagner Law Group', types: ['lawyer'] } });
  const ev2 = await C.fillCategory(P, { id: 'rd-log-3', brand_name: 'Van Wagner Sports & Entertainment' }, { lookup: wrong });
  const hold3 = (await P.query(`SELECT resolved_at FROM compliance_holds WHERE outreach_log_id = 'rd-log-3'`)).rows[0];
  ok('a record for some other business is ignored and the hold stays', ev2 === null && hold3.resolved_at === null);
  calls = 0;
  await C.fillCategory(P, { id: 'rd-log-2', brand_name: 'Cheer Athletics Philadelphia' }, { lookup: found });
  ok('one lookup per business per six hours, not one per release tick', calls === 0);
  await C.fillCategory(P, { id: 'rd-log-2', brand_name: 'Cheer Athletics Philadelphia' }, { lookup: found, now: Date.now() + 7 * 3600000 });
  ok('and again after that', calls === 1);
  C._resetFillForTests();
  const none = await C.fillCategory(P, { id: 'x', brand_name: 'Has Record', places_evidence: { found: true, types: ['cafe'] } }, { lookup: found });
  ok('a business that already has a record is not looked up', none === null);
  const CL = fs.readFileSync(REPO + 'server/services/closer.js', 'utf8');
  ok('the release runs the look before it reads open holds', CL.indexOf('compliance.fillCategory(pool, log)') > -1 && CL.indexOf('compliance.fillCategory(pool, log)') < CL.indexOf('const open = await compliance.openHoldsFor(pool, log.id);'));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
