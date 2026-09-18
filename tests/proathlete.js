'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/proathlete.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── A PRO ATHLETE ────────────────────────────────────────────────────────────
//
// Add Client assumed a college athlete: a school, a class year, an over-18 box,
// NIL wording, the 51-state college compliance layer. A pro has none of that.
// What replaces the school is the city they play in and the team, and this
// suite pins what each downstream reader does with those:
//
//   1. resolveAthlete: the market comes from the city exactly as it comes from
//      a school town; the class year is dropped; the state comes from the city.
//   2. THE STATE IS NEVER SILENTLY ABSENT. An athlete with neither a school
//      state nor a city state carries a stateNote, and the gate BLOCKS with it.
//   3. The gate: a pro is an adult by default (a DOB still wins), state
//      category rules run on the endorsement, school restrictions are skipped.
//   4. The writer: name, position, team, known-for; no class year, no NIL.
//   5. The fact check: class-year and college wording are refused on a pro.
//   6. The lookup picks a league from the sport, and the route passes the
//      pro fields through.
//   7. The form: a College/Pro switch, city + team replace the school, the
//      college-only inputs are hidden, and both payloads carry the type.

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const AR = require(REPO + 'server/services/athleteRecord.js');
const C = require(REPO + 'server/services/compliance.js');
const Closer = require(REPO + 'server/services/closer.js');
const PW = require(REPO + 'server/services/pitchWriter.js');
const AL = require(REPO + 'server/services/athleteLookup.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'pro-agent';
const P = () => store.pool;
const src = (p) => fs.readFileSync(REPO + p, 'utf8');

function recorder() {
  const sent = [];
  return { sent, fn: async (log) => { sent.push(log.brand_name); return { providerMessageId: 'm' + sent.length }; } };
}
// One address and one subject PER DRAFT: the shared send rules
// (services/sendRules) hold a second email to one address inside four days
// and stop a repeated subject, and neither is what this suite tests.
async function draft(id, brand, athleteId) {
  await P().query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,brand_key,subject,body_html,
       status,sent_to_email,touch_no,scheduled_send_at)
     VALUES ($1,$2,$3,$4,$5,$7,'<p>x</p>','approved',$8,1, $6)`,
    [id, AG, athleteId, brand, brand.toLowerCase(), new Date(WHEN.getTime() - 60000),
      'Hi from ' + id, id + '@pro.example']);
}
async function places(brand, types) {
  await P().query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
     VALUES ($1,'places',$2,$3::jsonb,'OK',NOW())
     ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence, refreshed_at = NOW()`,
    ['pro:' + brand.toLowerCase(), brand, JSON.stringify({ found: true, types, name: brand })]);
}
const WHEN = new Date('2026-08-25T17:00:00Z');   // a Tuesday, 11am Mountain / 1pm Eastern: every window in play is open
const release = (opts = {}) => Closer.releaseDue(P(), Object.assign({ sleep: async () => {}, now: WHEN }, opts));
const holdsFor = async (brand) => (await P().query(
  `SELECT * FROM compliance_holds WHERE agent_id=$1 AND brand_name=$2 ORDER BY id`, [AG, brand])).rows;

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const G = require(REPO + 'server/services/sendGuard.js');
  await G.ensureTable(P());
  const clean = async () => {
    await P().query(`DELETE FROM compliance_holds WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM agent_send_budget WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'pro:%' OR brand_key = 'school:pro test college'`).catch(() => {});
    await P().query(`DELETE FROM email_sends WHERE email LIKE '%@pro.example'`).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role,report_tz)
                   VALUES ($1,'Pro Agent','pro@x.com','x','agent','America/Chicago')`, [AG]);
  const mk = (id, data) => P().query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`, [id, AG, JSON.stringify(data)]);
  const PRO = { name: 'Pat Surtain', sport: 'football', position: 'Cornerback', athleteType: 'pro',
    city: 'Denver, CO', team: 'Denver Broncos', stats: '2024 Defensive Player of the Year' };
  await mk('pro-a1', PRO);                                                         // a pro, complete
  await mk('pro-a2', { ...PRO, name: 'No State Pro', city: 'Denver' });             // a pro, city without a state
  await mk('pro-a3', { ...PRO, name: 'Young Pro', dob: '2010-01-01' });             // a pro whose DOB says minor
  await mk('pro-a4', { name: 'Lost College', school: 'Nowhere Tech', sport: 'football' });   // a college athlete at a school that resolves nowhere
  await mk('pro-a5', { ...PRO, name: 'Ex-College Pro', schoolRestrictions: ['alcohol'] });    // a pro with a leftover school restriction
  await mk('pro-a6', { name: 'Geocoded College', school: 'Pro Test College', sport: 'football' });

  // ── 1. THE RECORD ────────────────────────────────────────────────────────
  OUT.push('-- the market comes from the city, the year is dropped, the state comes from the city --');
  const rec = AR.resolveAthlete({ id: 'pro-a1', data: { ...PRO, year: 'Junior' } });
  ok('a pro record says so', rec.athleteType === 'pro', rec.athleteType);
  ok('  the market is the city, as given', rec.market === 'Denver, CO', rec.market);
  ok('  keyed the way a school town is', rec.marketKey === 'denver, co', rec.marketKey);
  ok('  and the local lane has a market', rec.hasLocalMarket === true && rec.localLaneNote === null, rec.localLaneNote);
  ok('  the source says it came from the city', rec.marketSource === 'pro-city', rec.marketSource);
  ok('  the team travels', rec.team === 'Denver Broncos', rec.team);
  ok('  the school is null, not a blank to fill', rec.school === null, rec.school);
  ok('  A CLASS YEAR LEFT OVER FROM COLLEGE IS DROPPED', rec.year === null, rec.year);
  ok('  the state is read from the city', rec.stateCode === 'CO' && rec.stateNote === null, [rec.stateCode, rec.stateNote]);
  ok('  school and year are not listed as missing', !rec.missing.includes('school') && !rec.missing.includes('year'), rec.missing);
  const noState = AR.resolveAthlete({ data: { ...PRO, city: 'Denver' } });
  ok('a bare city is still a market the local lane can search', noState.market === 'Denver' && noState.hasLocalMarket, noState.market);
  ok('  BUT THE MISSING STATE IS A NOTE ON THE ATHLETE', !noState.stateCode && /no state/.test(noState.stateNote || ''), noState.stateNote);
  ok('  and the note names the fix', /"City, ST"/.test(noState.stateNote), noState.stateNote);
  const noCity = AR.resolveAthlete({ data: { ...PRO, city: '' } });
  ok('a pro with no city has no market and says so', !noCity.hasLocalMarket && /No city on file/.test(noCity.localLaneNote), noCity.localLaneNote);
  const col = AR.resolveAthlete({ data: { name: 'C', school: 'Auburn University', year: 'Junior' } },
    { schoolLocation: () => ({ city: 'Auburn', state: 'AL', method: 'map' }) });
  ok('a college record is unchanged: market from the school', col.market === 'Auburn, AL' && col.athleteType === 'college', col);
  ok('  keeps its class year', col.year === 'Junior', col.year);
  ok('  and carries its state', col.stateCode === 'AL' && col.stateNote === null, [col.stateCode, col.stateNote]);
  ok('  city and team are not listed as missing on a college athlete', !col.missing.includes('city') && !col.missing.includes('team'), col.missing);
  const lost = AR.resolveAthlete({ data: { name: 'L', school: 'Nowhere Tech' } }, { schoolLocation: () => null });
  ok('A COLLEGE ATHLETE WHOSE SCHOOL RESOLVES NOWHERE CARRIES A STATE NOTE TOO',
    !lost.stateCode && /did not resolve to a state/.test(lost.stateNote || ''), lost.stateNote);

  // ── 2. THE STATE RESOLVER ────────────────────────────────────────────────
  OUT.push('', '-- one resolver, and it never returns silence --');
  const s1 = await C.stateCodeFor(P(), { athleteType: 'pro', city: 'Denver, CO' });
  ok('pro: the state comes from the city', s1.stateCode === 'CO' && s1.source === 'city', s1);
  const s2 = await C.stateCodeFor(P(), { athleteType: 'pro', city: 'Denver' });
  ok('pro: a city without a state returns null AND a note', s2.stateCode === null && /"City, ST"/.test(s2.note), s2);
  const s2b = await C.stateCodeFor(P(), { athleteType: 'pro', city: 'Denver, Colorado' });
  ok('pro: a spelled-out state is read', s2b.stateCode === 'CO', s2b);
  const s3 = await C.stateCodeFor(P(), { athleteType: 'college', school: 'Auburn University' });
  ok('college: the shipped map', s3.stateCode === 'AL' && s3.source === 'school-map', s3);
  const s4 = await C.stateCodeFor(P(), { athleteType: 'college', school: 'Nowhere Tech, TX' });
  ok('college: a state written into the school string', s4.stateCode === 'TX' && s4.source === 'school-text', s4);
  const s5 = await C.stateCodeFor(P(), { athleteType: 'college', school: 'Nowhere Tech' });
  ok('college: a school that resolves nowhere returns null AND a note', s5.stateCode === null && /did not resolve/.test(s5.note), s5);
  // The nightly run geocodes unmapped schools and writes the answer down; the
  // gate reads the same row, so a real D2 school off the map does not block.
  const SchoolGeo = require(REPO + 'server/services/schoolGeocode.js');
  await P().query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
     VALUES ($1,$2,'Pro Test College',$3::jsonb,'OK',NOW())
     ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence, outcome='OK', refreshed_at = NOW()`,
    ['school:pro test college', SchoolGeo.CACHE_LANE, JSON.stringify({ found: true, city: 'Waltham', state: 'MA' })]);
  const s6 = await C.stateCodeFor(P(), { athleteType: 'college', school: 'Pro Test College' });
  ok('college: THE NIGHTLY GEOCODE CACHE IS READ, so an unmapped-but-geocoded school has a state',
    s6.stateCode === 'MA' && s6.source === 'school-geocode', s6);
  const s7 = await C.stateCodeFor(P(), { athleteType: 'pro', city: '' });
  ok('pro: no city at all is a note, not a throw', s7.stateCode === null && /No city/.test(s7.note), s7);

  // ── 3. THE GATE ──────────────────────────────────────────────────────────
  OUT.push('', '-- the gate: adult by default, state rules on the endorsement, no school rules --');
  const proAge = C.ageFrom(null, WHEN, { pro: true });
  ok('a pro with no DOB and no checkbox is an adult', proAge.known && proAge.minor === false && proAge.source === 'pro', proAge);
  ok('  a DOB still wins over the default', C.ageFrom('2010-01-01', WHEN, { pro: true }).minor === true);
  ok('  an explicit "no" still wins over the default', C.ageFrom(null, WHEN, { pro: true, over18: false }).minor === true);
  ok('  a college athlete with neither is still UNKNOWN', C.ageFrom(null, WHEN, {}).known === false);

  const clean1 = await C.evaluate(P(), { brandName: 'Mile High Coffee', evidence: { found: true, types: ['cafe'] },
    athleteType: 'pro', athleteName: 'Pat', stateCode: 'CO' });
  ok('a clean business for a pro with a state PASSES', clean1.decision === 'pass', clean1);
  const bar = await C.evaluate(P(), { brandName: 'Blake Street Tavern', evidence: { found: true, types: ['bar'] },
    athleteType: 'pro', athleteName: 'Pat', stateCode: 'CO' });
  ok('alcohol for a pro is still a HOLD -- the category is restricted whoever fronts it',
    bar.decision === 'hold' && bar.findings[0].ruleKey === 'category-alcohol', bar.findings);
  ok('  the reason says they are a pro treated as an adult, not "is null"',
    /is a pro and is treated as an adult/.test(bar.findings[0].reason), bar.findings[0].reason);
  ok('  and does not ask about a school policy', !/under the school's policy/.test(bar.findings[0].reason) && /no school policy to check/.test(bar.findings[0].reason), bar.findings[0].reason);
  const bet = await C.evaluate(P(), { brandName: 'DraftKings Sportsbook', evidence: { found: true, types: ['casino'] },
    athleteType: 'pro', athleteName: 'Pat', stateCode: 'CO' });
  ok('gambling for a pro is still a BLOCK', bet.decision === 'block', bet.decision);
  const restricted = await C.evaluate(P(), { brandName: 'Blake Street Tavern', evidence: { found: true, types: ['bar'] },
    athleteType: 'pro', athleteName: 'Pat', stateCode: 'CO', schoolRestrictions: ['alcohol'] });
  ok('A LEFTOVER SCHOOL RESTRICTION IS SKIPPED FOR A PRO: hold on the category, not a school block',
    restricted.decision === 'hold' && !restricted.findings.some((f) => /school-restricted/.test(f.ruleKey)), restricted.findings.map((f) => f.ruleKey));
  const colRestricted = await C.evaluate(P(), { brandName: 'Blake Street Tavern', evidence: { found: true, types: ['bar'] },
    athleteName: 'C', stateCode: 'AL', schoolRestrictions: ['alcohol'], dob: '2000-01-01' });
  ok('  and still a BLOCK for a college athlete', colRestricted.decision === 'block'
    && colRestricted.findings.some((f) => f.ruleKey === 'school-restricted-alcohol'), colRestricted.findings.map((f) => f.ruleKey));
  // A state rule tightens for a pro exactly as for a college athlete.
  await P().query(`INSERT INTO state_category_rules
    (state_code,category,minor_rule,adult_rule,citation,date_checked,confidence)
    VALUES ('CO','alcohol','block','block','C.R.S. 44-3-901 (test row)',CURRENT_DATE,'confident')
    ON CONFLICT (state_code,category) DO UPDATE SET adult_rule='block'`);
  const coRule = await C.stateRuleFor(P(), 'CO', 'alcohol');
  const tightened = await C.evaluate(P(), { brandName: 'Blake Street Tavern', evidence: { found: true, types: ['bar'] },
    athleteType: 'pro', athleteName: 'Pat', stateCode: 'CO', stateRule: { alcohol: coRule } });
  ok('a state rule TIGHTENS a pro hold into a block, citing the statute',
    tightened.decision === 'block' && /C\.R\.S\. 44-3-901/.test(tightened.findings[0].reason), tightened.findings[0]);
  await P().query(`DELETE FROM state_category_rules WHERE state_code='CO' AND category='alcohol'`);

  OUT.push('', '-- NO STATE IS A BLOCK, NEVER A QUIET PASS --');
  const silent = await C.evaluate(P(), { brandName: 'Mile High Coffee', evidence: { found: true, types: ['cafe'] },
    athleteType: 'pro', athleteName: 'Pat', stateCode: null, stateNote: '"Denver" has no state. Enter the city as "City, ST".' });
  ok('a clean business with NO state is a BLOCK', silent.decision === 'block', silent.decision);
  ok('  under its own rule key', silent.findings.some((f) => f.ruleKey === 'state-unknown'), silent.findings.map((f) => f.ruleKey));
  const su = silent.findings.find((f) => f.ruleKey === 'state-unknown');
  ok('  carrying the athlete note, which names the fix', /"City, ST"/.test(su.reason), su.reason);
  ok('  and saying nothing sends until then', /Nothing sends/.test(su.reason), su.reason);
  const silentCol = await C.evaluate(P(), { brandName: 'Mile High Coffee', evidence: { found: true, types: ['cafe'] },
    athleteName: 'C', dob: '2000-01-01' });
  ok('the same for a college athlete with no state, even with a DOB', silentCol.decision === 'block'
    && silentCol.findings.some((f) => f.ruleKey === 'state-unknown'), silentCol.findings.map((f) => f.ruleKey));
  ok('  with a college fix in the reason when no note was given',
    /Correct the school/.test(silentCol.findings.find((f) => f.ruleKey === 'state-unknown').reason), silentCol.findings);

  // ── 3b. THE REAL SEND PATH ───────────────────────────────────────────────
  OUT.push('', '-- releaseDue, with real rows --');
  await places('Mile High Coffee', ['cafe']);
  await places('Blake Street Tavern', ['bar']);
  await draft('pro-1', 'Mile High Coffee', 'pro-a1');       // pro, complete, clean business -> sends
  await draft('pro-2', 'Blake Street Tavern', 'pro-a1');    // pro, alcohol -> hold
  await draft('pro-3', 'Mile High Coffee', 'pro-a2');       // pro, city without a state -> block
  await draft('pro-4', 'Blake Street Tavern', 'pro-a3');    // pro, DOB says minor -> block (DOB wins)
  await draft('pro-5', 'Mile High Coffee', 'pro-a4');       // college, school resolves nowhere -> block
  await draft('pro-6', 'Blake Street Tavern', 'pro-a5');    // pro with a leftover school restriction -> hold, not school block
  await draft('pro-7', 'Mile High Coffee', 'pro-a6');       // college, unmapped school with a geocode row -> sends
  const r = recorder();
  const out = await release({ send: r.fn });
  ok('the clean pitch for a complete pro SENT', r.sent.filter((b) => b === 'Mile High Coffee').length >= 1, r.sent);
  ok('  and so did the geocoded-school college pitch', r.sent.filter((b) => b === 'Mile High Coffee').length === 2, r.sent);
  ok('the alcohol pitch for the pro did NOT send', r.sent.indexOf('Blake Street Tavern') === -1, r.sent);
  const h2 = (await holdsFor('Blake Street Tavern')).find((h) => h.outreach_log_id === 'pro-2');
  ok('  it is a HOLD on the category', h2 && h2.severity === 'hold' && h2.rule_key === 'category-alcohol', h2 && [h2.severity, h2.rule_key]);
  ok('  THE RECORD SAYS THE AGE CAME FROM THE PRO DEFAULT', h2 && h2.facts.age && h2.facts.age.source === 'pro', h2 && h2.facts.age);
  ok('  and records the type, the city and where the state came from',
    h2 && h2.facts.athleteType === 'pro' && h2.facts.city === 'Denver, CO' && h2.facts.stateCode === 'CO' && h2.facts.stateSource === 'city', h2 && h2.facts);
  const h3 = (await holdsFor('Mile High Coffee')).find((h) => h.outreach_log_id === 'pro-3');
  ok('the pro with a city but no state was BLOCKED on state-unknown', h3 && h3.severity === 'block' && h3.rule_key === 'state-unknown', h3 && [h3.severity, h3.rule_key]);
  ok('  and the hold row names the fix', h3 && /"City, ST"/.test(h3.reason), h3 && h3.reason);
  const h4 = (await holdsFor('Blake Street Tavern')).find((h) => h.outreach_log_id === 'pro-4');
  ok('a pro whose DOB says minor is BLOCKED on alcohol: the DOB wins over the pro default',
    h4 && h4.severity === 'block' && h4.rule_key === 'category-alcohol' && h4.facts.age.source === 'dob', h4 && [h4.severity, h4.rule_key, h4.facts.age]);
  const h5 = (await holdsFor('Mile High Coffee')).find((h) => h.outreach_log_id === 'pro-5');
  ok('a college athlete at a school that resolves nowhere is BLOCKED on state-unknown too',
    h5 && h5.severity === 'block' && h5.rule_key === 'state-unknown', h5 && [h5.severity, h5.rule_key]);
  const h6 = (await holdsFor('Blake Street Tavern')).filter((h) => h.outreach_log_id === 'pro-6');
  ok('the pro with a leftover school restriction got the category hold, not a school block',
    h6.length === 1 && h6[0].rule_key === 'category-alcohol' && h6[0].severity === 'hold', h6.map((h) => [h.rule_key, h.severity]));
  ok('nothing was reported as a failure', out.failed === 0, out);
  if (process.env.DEBUG_PRO) console.log(JSON.stringify(out.detail, null, 1));

  // ── 4. THE WRITER ────────────────────────────────────────────────────────
  OUT.push('', '-- the pro variant of the writer: name, position, team, known for --');
  const d = PW.describeAthlete({ ...PRO, year: 'Junior', partnershipCount: 0 });
  ok('leads with the position and the team', /Plays: Cornerback football for the Denver Broncos/.test(d), d);
  ok('  says what they are known for', /Known for: 2024 Defensive Player of the Year/.test(d), d);
  ok('  says where they are based', /Based in: Denver, CO/.test(d), d);
  ok('  NEVER names a class year, even one left on the record', !/Junior/.test(d), d);
  ok('  never names a school', !/School:|\bat\b .*University/.test(d), d);
  ok('  tells the model it is a pro and forbids the college framing', /PROFESSIONAL/.test(d) && /never mention college, NCAA, a class year or NIL/.test(d), d);
  ok('  the partnership line says endorsement, not NIL', /endorsement partnerships/.test(d) && !/NIL partnerships/.test(d), d);
  ok('  and tells the model to use only what is listed, not what it remembers', /nothing you remember/.test(d), d);
  const dNo = PW.describeAthlete({ ...PRO, stats: '' });
  ok('with nothing on file, known-for says so and forbids recall', /Known for: nothing on file/.test(dNo) && /Do not draw on what you may remember/.test(dNo), dNo);
  const dCol = PW.describeAthlete({ name: 'C', year: 'Junior', position: 'WR', sport: 'football', school: 'Auburn', partnershipCount: 2 });
  ok('the college variant is unchanged', /Plays: Junior WR football at Auburn/.test(dCol) && /several NIL partnerships/.test(dCol), dCol);
  ok('SYSTEM_PRO exists and differs from SYSTEM', PW.SYSTEM_PRO && PW.SYSTEM_PRO !== PW.SYSTEM);
  ok('  it pitches a professional athlete', /partnership between a professional athlete and a local business/.test(PW.SYSTEM_PRO) && !/partnering with a college athlete/.test(PW.SYSTEM_PRO));
  // A FIRST APPROACH, NOT AN INTRODUCTION. The business may already follow the team.
  ok('  it is a first approach, not an introduction', /This is not an introduction; it is a first approach/.test(PW.SYSTEM_PRO));
  ok('  the open states the team and the role as a fact', /\[position\] for the \[team\], is looking at partners in \[city\] this season/.test(PW.SYSTEM_PRO));
  ok('  known-for comes from the record only, and is left out when there is none', /leave this line out\. Do not fill it\s+from anything you remember/.test(PW.SYSTEM_PRO));
  ok('  THE PROPOSAL IS ONE SHAPE, not a list', /THE PROPOSAL, IN ONE SHAPE/.test(PW.SYSTEM_PRO) && /Pick the ONE that fits\s+this business\. NEVER propose a social post, a story or a reel as the whole\s+deal/.test(PW.SYSTEM_PRO) && /Not a list, not a\s+package, no counts, no schedule, no price/.test(PW.SYSTEM_PRO));
  ok('  and reads as a first approach, not a contract, in a pro shape: an appearance day, a signing, an ambassador deal, a shoot or a hospitality event (services/proLane)', /as a first approach and not a contract\. The\s+shapes a professional offers: an appearance day at their location, an\s+autograph signing, a season-long ambassador deal, a commercial or photo\s+shoot, or a hospitality event/.test(PW.SYSTEM_PRO));
  ok('  the close is an endorsement opportunity', /endorsement opportunity with \[athlete\]/.test(PW.SYSTEM_PRO) && !/NIL opportunity/.test(PW.SYSTEM_PRO));
  ok('  and it forbids the college framing', /Never describe them as a college athlete/.test(PW.SYSTEM_PRO));
  ok('  every hard rule of the college prompt survives', /NEVER put a dollar amount/.test(PW.SYSTEM_PRO) && /No em dashes/.test(PW.SYSTEM_PRO) && /NEVER invent a fact/.test(PW.SYSTEM_PRO));
  ok('  because the rules are one shared block, not two copies',
    /const SYSTEM = SYSTEM_COLLEGE_HEAD \+ '\\n' \+ SHARED_RULES;/.test(src('server/services/pitchWriter.js'))
    && /const SYSTEM_PRO = SYSTEM_PRO_HEAD \+ '\\n' \+ SHARED_RULES;/.test(src('server/services/pitchWriter.js')));
  ok('  the college prompt is byte-for-byte what it was', /^You write short outreach messages for a sports agent pitching local businesses on partnering with a college athlete\./.test(PW.SYSTEM)
    && /5\. The athlete's Instagram link on its own line, when one is given\.\n\nDO NOT WRITE ABOUT THE BRAND\./.test(PW.SYSTEM));
  ok('systemFor picks by type', PW.systemFor({ athleteType: 'pro' }) === PW.SYSTEM_PRO && PW.systemFor({}) === PW.SYSTEM && PW.systemFor(null) === PW.SYSTEM);
  // writePitch hands the pro prompt to the model.
  let seenSystem = null;
  await PW.writePitch({ athlete: PRO, business: { name: 'Mile High Coffee', category: 'coffee' }, agentFirstName: 'Chad', channel: 'email' },
    { oneShot: async (_p, system) => { seenSystem = system; return '{"skip":true,"reason":"test"}'; } });
  ok('writePitch uses the pro system prompt for a pro', seenSystem === PW.SYSTEM_PRO);
  await PW.writePitch({ athlete: { name: 'C', school: 'Auburn' }, business: { name: 'X', category: 'coffee' }, agentFirstName: 'Chad', channel: 'email' },
    { oneShot: async (_p, system) => { seenSystem = system; return '{"skip":true,"reason":"test"}'; } });
  ok('  and the college one for a college athlete', seenSystem === PW.SYSTEM);

  // ── 5. THE FACT CHECK ────────────────────────────────────────────────────
  OUT.push('', '-- the voice checker: class year and college wording are college-only --');
  const v1 = PW.verifyAthleteFacts('I wanted to call your attention to Pat Surtain, cornerback for the Denver Broncos. He is a junior who posts training and game days.', PRO);
  ok('a class year on a pro is refused', !v1.ok && v1.problems.some((p) => /"junior" and this athlete is a pro/.test(p)), v1.problems);
  const v2 = PW.verifyAthleteFacts('Pat Surtain, a student-athlete building NIL partnerships, posts training content.', PRO);
  ok('college wording on a pro is refused', !v2.ok && v2.problems.some((p) => /college wording/.test(p)), v2.problems);
  const v3 = PW.verifyAthleteFacts("Pat Surtain, cornerback for the Denver Broncos, is building out his endorsement partnerships. Would Junior's Pizza like to learn more?", PRO);
  ok('a business called Junior\'s is not a class-year claim', v3.ok === true, v3.problems);
  const v4 = PW.verifyAthleteFacts('Pat Surtain is a junior wide receiver at Auburn.', { name: 'Pat Surtain', position: 'WR', sport: 'football', school: 'Auburn', year: 'Junior' });
  ok('a college athlete with a matching class year still passes', v4.ok === true, v4.problems);
  const v5 = PW.verifyAthleteFacts('Pat Surtain is a sophomore wide receiver at Auburn.', { name: 'Pat Surtain', position: 'WR', sport: 'football', school: 'Auburn', year: 'Junior' });
  ok('  and a wrong class year is still caught for a college athlete', !v5.ok && v5.problems.some((p) => /stored year/.test(p)), v5.problems);

  // ── 6. THE LOOKUP ────────────────────────────────────────────────────────
  OUT.push('', '-- the lookup searches league rosters for a pro --');
  ok('the league comes from the sport', AL.leagueFor('Football') === 'NFL' && AL.leagueFor('Basketball') === 'NBA or WNBA' && AL.leagueFor("Men's Basketball") === 'NBA' && AL.leagueFor('Soccer') === 'MLS or NWSL'
    && AL.leagueFor("women's basketball") === 'WNBA' && AL.leagueFor('Baseball') === 'MLB' && AL.leagueFor('womens ice hockey') === 'PWHL' && AL.leagueFor('hockey') === 'NHL or PWHL'
    && AL.leagueFor('mens soccer') === 'MLS' && AL.leagueFor('womens soccer') === 'NWSL', [AL.leagueFor('Football'), AL.leagueFor('Basketball')]);
  ok('  and an unknown sport picks none rather than guessing', AL.leagueFor('curling') === null && AL.leagueFor('') === null);
  // The lookup is one engine for college, high school and pro now
  // (tests/lookup.js covers it): a pro goes to the roster feeds first, then
  // a cited web search; the prompt asks for a roster and refuses a college
  // athlete; the pro candidate carries team, league, city and the highlight
  // as knownFor; a pro has no class year.
  const al = src('server/services/athleteLookup.js');
  ok('resolveAthlete accepts the pro fields', /if \(level === 'pro'\) \{[\s\S]*?Feeds\.searchFeeds\(\{ name, sport: proSport, team/.test(al) && /athleteType === 'pro'\) return 'pro'/.test(al));
  ok('  a pro lookup skips the ESPN college stage', /else if \(level === 'college'\) \{[\s\S]*?espnCollegeStage\(/.test(al) && al.indexOf("level === 'pro'") < al.indexOf('espnCollegeStage(normName'));
  ok('  and the prompt starts from what the model knows, searches for what changes, and never a school', /First, from what you already know, fill the team, league, sport, position, home city and jersey number/.test(al) && /A college athlete is NOT a match/.test(al));
  ok('  it asks for position, team, city and what they are known for', /"team":/.test(al) && /"city":/.test(al) && /"highlight":/.test(al) && /knownFor: isPro \? \(c\.highlight \|\| null\) : null/.test(al));
  ok('  and does not carry a class year or a school tier on a pro', /year: isPro \? null : \(c\.year \|\| null\)/.test(al) && /schoolTier: isPro \? null : inferSchoolTier\(c\.school\)/.test(al));
  ok('the route passes the pro fields through', /const \{ name, school, sport, position, year, athleteType, team, city \} = req\.body;/.test(src('server/index.js')));
  ok('the finished candidate carries the pro fields', /athleteType: isPro \? 'pro' : 'college', level,/.test(al) && /team: c\.team \|\| null, league: c\.league \|\| null, city: c\.city \|\| null/.test(al));

  // The probe that decides which leagues get a feed and which stay on search.
  const probe = src('scripts/probe-roster-sources.js');
  ok('the roster probe covers every level asked for',
    /sportId=11/.test(probe) && /sportId=12/.test(probe) && /sportId=13/.test(probe) && /sportId=14/.test(probe)
    && /football\/cfl/.test(probe) && /football\/ufl/.test(probe) && /client=ahl/.test(probe) && /client=echl/.test(probe)
    && /LeagueID=20/.test(probe) && /soccer\/usa\.usl/.test(probe));
  ok('  a 200 is never mistaken for usable: every source has a body check', !/url: [^\n]*\n[^\n]*(?!check)/.test('') && (probe.match(/check: /g) || []).length >= 20);
  ok('  and it starts with exit code 1 until it has reported', /process\.exitCode = 1;/.test(probe) && /process\.exitCode = 0;/.test(probe));

  // ── 7. THE FORM AND THE HANDLERS ─────────────────────────────────────────
  OUT.push('', '-- the form: a College/Pro switch, city + team replace the school --');
  const html = src('public/index.html');
  ok('there is an athlete-type switch', /id="a_type"/.test(html) && /<option value="pro">Pro<\/option>/.test(html));
  ok('  a city and a team field', /id="a_city"/.test(html) && /id="a_team"/.test(html));
  ok('  the city hint says to include the state and why', /Include the state: it decides which state's endorsement rules apply/.test(html));
  ok('  the school, year, tier and age blocks can be hidden', /id="a_school_wrap"/.test(html) && /id="a_year_wrap"/.test(html) && /id="a_tier_wrap"/.test(html) && /id="a_age_wrap"/.test(html));
  ok('  acTypeChanged hides the college-only inputs for a pro',
    /show\('a_school_wrap', !pro\)/.test(html) && /show\('a_year_wrap', !pro\)/.test(html) && /show\('a_age_wrap', !pro\)/.test(html) && /show\('a_pro_wrap', pro\)/.test(html));
  ok('  the create payload carries the type, city and team', /athleteType: _pro \? 'pro' : 'college',\s*school: _pro \? '' : document\.getElementById\('a_school'\)\.value,\s*city: _pro \? city : '',/.test(html));
  ok('  and so does the update payload', /athleteType: _pro \? 'pro' : 'college',\s*school: _pro \? '' : document\.getElementById\('a_school'\)\.value,\s*city: _pro \? \(document/.test(html));
  ok('  a pro is required to have a city, as a college athlete is a school', /A city is required for a pro\. Enter it as "City, ST"/.test(html));
  ok('  the over-18 box is not sent for a pro', (html.match(/over18: !_pro && document\.getElementById\('a_over18'\)/g) || []).length === 2);
  ok('  the year is not sent for a pro', (html.match(/year: !_pro && document\.getElementById\('a_year'\)/g) || []).length === 2);
  ok('  editing a pro restores the switch, city and team', /typeEl\.value = a\.athleteType === 'pro' \? 'pro' : 'college'; acTypeChanged\(\)/.test(html) && /cityEl\.value = a\.city \|\| ''/.test(html));
  ok('  the lookup sends the pro fields', /body: JSON\.stringify\(\{ name, school, sport, position, year, athleteType: _pro \? 'pro' : 'college', team, city \}\)/.test(html));
  ok('  and a pro candidate fills team, city and known-for, not the school', /if \(_proLookup\) \{[\s\S]*?teamEl\.value = data\.team[\s\S]*?cityEl\.value = data\.city[\s\S]*?st\.value = data\.knownFor/.test(html));
  ok('  the roster card shows the team for a pro', /a\.athleteType === 'pro' \? \(a\.team \|\| 'Team not set'\) : \(a\.school \|\| 'School not set'\)/.test(html));
  // The create handler is services/athleteCreate now (shared with the assistant's
  // add_athlete); the update handler is still in index.js. Read as one text.
  const idx = src('server/index.js') + '\n' + src('server/services/athleteCreate.js');
  ok('the create handler stores the type in data, never the athlete_type column',
    /athleteType: isPro \? 'pro' : 'college',/.test(idx) && !/SET athlete_type\s*=\s*'pro'/.test(idx));
  ok('  clears the school and year on a pro', /school: isPro \? '' : \(school \|\| ''\)/.test(idx) && /year: isPro \? '' : \(year \|\| ''\)/.test(idx));
  ok('  and stores the city and team', /city: isPro \? String\(city \|\| ''\)\.trim\(\)\.slice\(0, 120\) : ''/.test(idx) && /team: isPro \? String\(team/.test(idx));
  ok('the update handler clears the other type\'s fields on a switch', /if \(pro\) \{ patch\.school = ''; patch\.year = ''; \}\s*else \{ patch\.city = ''; patch\.team = ''; \}/.test(idx));
  ok('there is a missing-state worklist', /app\.get\('\/api\/agent\/compliance\/missing-state'/.test(idx) && /compliance\.stateCodeFor\(store\.pool/.test(idx));

  // ── 8. THE OTHER SCHOOL READERS ──────────────────────────────────────────
  OUT.push('', '-- everything downstream keys on the market, not the school --');
  const job = src('server/jobs/outreachQueue.js');
  ok('the widen ledger is keyed on the school OR the market', /const widenKey = profile\.school \|\| profile\.market;/.test(job)
    && /Deepen\.canDeepen\(pool, widenKey/.test(job) && /Deepen\.claimDeepen\(pool, widenKey/.test(job));
  ok('  and a geocoded school lifts the state note on the profile', /profile\.stateCode = cs\.state; profile\.stateNote = null;/.test(job));
  const cl = src('server/services/closer.js');
  ok('the send path resolves the state through stateCodeFor, not the school alone',
    /compliance\.stateCodeFor\(pool, \{ athleteType, school: log\.school, city: log\.city \}\)/.test(cl) && !/compliance\.stateCodeForSchool\(/.test(cl));
  ok('  reads the type and city off the athlete row', /a\.athlete_type, a\.data->>'athleteType' AS athlete_type_data,\s*a\.data->>'city' AS city/.test(cl));
  ok('  and hands the send window the city when there is no school', /athleteSchoolState: log\.school \|\| log\.city/.test(cl)
    && /athleteSchoolState: log\.school \|\| log\.city/.test(src('server/routes/outreach.js')));
  const aiSrc = src('server/ai.js');
  ok('Deal Scan takes the market from the city for a pro', /athlete\.athleteType !== 'pro' \|\| !athlete\.city\) return null;/.test(aiSrc)
    && /const loc = proLoc \|\| await getSchoolLocation\(/.test(aiSrc));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
