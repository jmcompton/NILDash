'use strict';
// Runs against the local test Postgres. No network: Places is a stub.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/marketsanity.js   just this one
//
// ── THE RIGHT TOWN, AND THE RIGHT PERSON'S ADDRESS ────────────────────────
// Two bugs from the first cold-agent run, both underneath every nightly card:
//   "Columbia University" (New York) resolved to Columbia, Missouri, and the
//   demo was five mid-Missouri businesses with 573 numbers.
//   A Domino's card named Greg Neichter, owner, with austin.mitchell@dominos.com:
//   a name from one source and someone else's mailbox from another.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const SMC = require(REPO + 'server/services/schoolMarketCheck.js');
const R = require(REPO + 'server/services/schoolResolver.js');
const Q = require(REPO + 'server/services/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };

// Where things really are.
const PLACES = {
  'columbia university': { lat: 40.8075, lng: -73.9626, address: '116th St & Broadway, New York, NY 10027, USA' },
  'columbia, mo': { lat: 38.9517, lng: -92.3341, address: 'Columbia, MO, USA' },
  'university of dayton': { lat: 39.7400, lng: -84.1793, address: '300 College Park, Dayton, OH 45469, USA' },
  'dayton, oh': { lat: 39.7589, lng: -84.1916, address: 'Dayton, OH, USA' },
};
const calls = [];
const geocodePlace = async (q) => { calls.push(q); return PLACES[String(q).toLowerCase()] || null; };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await SMC.ensureTable(P);
  await P.query(`DELETE FROM school_market_overrides WHERE school_key IN ('columbia university', 'university of dayton')`);
  SMC._resetForTests();

  // ── 1. THE NAME RULES NO LONGER CONFUSE THE KIND OF SCHOOL ───────────────
  OUT.push('-- the name rules --');
  ok('"Columbia University" no longer resolves to Columbia, Missouri', (R.resolveSchool('Columbia University') || {}).state !== 'MO', R.resolveSchool('Columbia University'));
  ok('"College of Charleston" no longer resolves to West Virginia', (R.resolveSchool('College of Charleston') || {}).state !== 'WV', R.resolveSchool('College of Charleston'));

  // ── 2. EVERY MARKET CHECKED AGAINST WHERE THE SCHOOL IS ─────────────────
  OUT.push('', '-- located, not named --');
  const v = await SMC.verify('Columbia University', 'Columbia, MO', { geocodePlace });
  ok('a market 1,500 km from the school is caught', v.checked && !v.ok && v.km > 1400, v);
  ok('  and the school\'s own address gives the right town', v.market === 'New York, NY', v);
  const good = await SMC.verify('University of Dayton', 'Dayton, OH', { geocodePlace });
  ok('a market within 60 km of the school is left alone', good.checked && good.ok && good.km < 60, good);
  calls.length = 0;
  const bare = await SMC.verify('Columbia', 'Columbia, MO', { geocodePlace });
  ok('a bare ambiguous name is not "corrected" to whichever Columbia ranks first', !bare.checked && calls.length === 0, bare);
  const lost = await SMC.verify('Columbia University', 'Nowhere, ZZ', { geocodePlace });
  ok('a market that cannot be located is reported, not guessed', !lost.checked && /could not locate/.test(lost.why), lost);

  // Corrected once, it is the answer on every path.
  const c = await SMC.checkAndCorrect(P, 'Columbia University', 'Columbia, MO', { geocodePlace });
  ok('a wrong market is corrected and saved', c.corrected && (await P.query(`SELECT market, was_market FROM school_market_overrides WHERE school_key = 'columbia university'`)).rows[0].market === 'New York, NY');
  const r = R.resolveSchool('Columbia University');
  ok('  the resolver answers with where the school is, for every caller', r && r.city === 'New York' && r.state === 'NY' && r.method === 'located', r);
  const job = require(REPO + 'server/jobs/outreachQueue.js');
  const prof = job.athleteProfile({ id: 'x', name: 'T', data: { name: 'T', school: 'Columbia University' } });
  ok('  the athlete\'s profile and market follow it', /new york/i.test(prof.market || '') && prof.hasLocalMarket, prof.market);
  SMC._resetForTests();
  ok('  and it survives a restart (loaded from the table)', (await SMC.load(P)) >= 1 && (R.resolveSchool('Columbia University') || {}).state === 'NY');
  const src = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the nightly checks every name-rule market before using it, and loads the corrections first',
    /schoolMarketCheck'\)\.checkAndCorrect\(store\.pool, _school, profile\.market\)/.test(src) && /schoolMarketCheck'\)\.load\(pool\)/.test(src));
  await P.query(`DELETE FROM school_market_overrides WHERE school_key IN ('columbia university', 'university of dayton')`);
  SMC._resetForTests();

  // ── 3. THE ADDRESS HAS TO BE THE PERSON'S ───────────────────────────────
  OUT.push('', '-- the right person\'s address --');
  const ladder = (rows) => ({ tiers: [{ tier: 1, rows: [{ name: 'Greg Neichter', title: 'Owner', sourceNote: 'state filing' }] }, { tier: 3, rows }] });
  const stitched = Q.buildCard({ brand: "Domino's" }, ladder([{ email: 'austin.mitchell@dominos.com', emailKind: 'published', title: 'named mailbox' }]), { instagram: 'dominos5512', instagramScope: 'location' });
  ok('Greg Neichter is never given austin.mitchell@: the card carries no email', stitched.contactName === 'Greg Neichter' && stitched.email === null, stitched);
  ok('  and goes out as a DM (or a call), not an email to Austin opening "Hi Greg"', stitched.channel !== 'email' && Q.channelFor(ladder([{ email: 'austin.mitchell@dominos.com', emailKind: 'published' }]), null) === 'call');
  const his = Q.buildCard({ brand: "Domino's" }, ladder([{ email: 'gneichter@dominos.com', emailKind: 'pattern' }]), null);
  ok('his own address (it carries his name) is his', his.email === 'gneichter@dominos.com' && his.channel === 'email', his);
  const same = Q.buildCard({ brand: "Domino's" }, { tiers: [{ tier: 1, rows: [{ name: 'Greg Neichter', title: 'Owner', email: 'franchise5512@dominos.com', emailKind: 'published' }] }] }, null);
  ok('an address published ON his own row is his, whatever it says', same.email === 'franchise5512@dominos.com', same);
  const other = Q.buildCard({ brand: "Domino's" }, { tiers: [{ tier: 1, rows: [{ name: 'Greg Neichter', title: 'Owner' }, { name: 'Austin Mitchell', title: 'Manager', email: 'austin.mitchell@dominos.com', emailKind: 'published' }] }] }, null);
  ok('another named person\'s address is not borrowed for the owner', other.contactName !== 'Greg Neichter' || other.email !== 'austin.mitchell@dominos.com', other);

  // ── 4. A NAME THAT IS MORE THAN ONE SCHOOL STOPS, IT DOES NOT PICK ──────
  OUT.push('', '-- which school is this? --');
  for (const [name, n] of [['Miami', 2], ['Columbia', 3], ['Washington', 5], ['Charleston', 3], ['Jackson', 2], ['Michigan', 2], ['Alabama', 2]]) {
    const a = R.ambiguity(name);
    ok(`"${name}" is not guessed: no market, and the candidates are named`, R.resolveSchool(name) === null && a && a.candidates.length >= n, a);
  }
  ok('  "Alabama" no longer goes to Birmingham, "Michigan" no longer to East Lansing', R.resolveSchool('Alabama') === null && R.resolveSchool('Michigan') === null);
  ok('a state narrows it to one: "Miami (Ohio)" is Oxford, "Miami (FL)" is Coral Gables',
    (R.resolveSchool('Miami (Ohio)') || {}).city === 'Oxford' && (R.resolveSchool('Miami (FL)') || {}).city === 'Coral Gables');
  ok('  and so does the athlete\'s own state on file', (R.ambiguity('Miami', { state: 'OH' }) || {}).narrowed && R.ambiguity('Miami', { state: 'OH' }).narrowed.city === 'Oxford');
  ok('a full name is not asked: University of Miami, Michigan State, Georgia Tech, Bama',
    ['University of Miami', 'Michigan State', 'Georgia Tech', 'Bama'].every((x) => !R.ambiguity(x) && R.resolveSchool(x)));

  const LLC = require(REPO + 'server/services/localLaneCheck.js');
  const pr = LLC.problemFor({ data: { name: 'Tess Court', school: 'Miami' } });
  ok('HOME asks "which school is this?" in the Clint Frazier block, with each candidate as a choice',
    pr && pr.code === 'ambiguous-school' && /Which school is this\?/.test(pr.text) && /no cards until you pick/.test(pr.text)
    && pr.choices.map((c) => c.school).join('|') === 'University of Miami|Miami University' && /Coral Gables, FL/.test(pr.choices[0].label), pr);
  await P.query(`DELETE FROM athletes WHERE id = 'ms-ath'`); await P.query(`DELETE FROM users WHERE id = 'ms-agent'`);
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ('ms-agent','Ms Agent','ms@ms.test','x','agent')`);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ms-ath','ms-agent','{"name":"Tess Court","school":"Miami"}')`);
  const listed = await LLC.forAgent(P, 'ms-agent');
  ok('  it is on the agent\'s list', listed.some((x) => x.athleteId === 'ms-ath' && x.code === 'ambiguous-school'), listed);
  const badPick = await LLC.applyFix(P, 'ms-agent', 'ms-ath', { choice: 'University of Florida' });
  ok('  only one of the schools offered can be picked', !badPick.ok && badPick.status === 400, badPick);
  const pick = await LLC.applyFix(P, 'ms-agent', 'ms-ath', { choice: 'Miami University' });
  const after = (await P.query(`SELECT data->>'school' AS school FROM athletes WHERE id = 'ms-ath'`)).rows[0];
  ok('  the pick is saved as the full name, which resolves, and the question goes away',
    pick.ok && after.school === 'Miami University' && (R.resolveSchool(after.school) || {}).city === 'Oxford' && !(await LLC.forAgent(P, 'ms-agent')).some((x) => x.athleteId === 'ms-ath'), { pick, after });
  await P.query(`DELETE FROM athletes WHERE id = 'ms-ath'`); await P.query(`DELETE FROM users WHERE id = 'ms-agent'`);

  const fill = await job.fillAthlete(P, { agentId: 'ms-agent', athleteId: 'ms-x', athleteName: 'Tess Court', agentFirstName: 'Sam', athleteRow: { name: 'Tess Court', school: 'Columbia' },
    budget: null, region: null, dryRun: true });
  ok('THE NIGHT writes no cards and spends nothing for an ambiguous school, and says why', fill.filled === 0 && fill.ambiguousSchool && /more than one school/.test(fill.note) && fill.tried.length === 0, fill);
  const r2 = await job.localContextFor({ id: 'x', name: 'T', data: { name: 'T', school: 'Columbia' } });
  ok('  and no market is built (Places is not asked to pick one)', !r2.region && !r2.profile.hasLocalMarket, r2);
  const SF = require(REPO + 'server/services/schoolFind.js');
  const form = await SF.findSchool('Miami', { instantOnly: true });
  ok('the add-athlete form asks too, at the keyboard', form.status === 'ambiguous' && form.options.length === 2, form);

  // ── 5. NEVER BLOCK AN ATHLETE WHO IS ALREADY PRODUCING ──────────────────
  OUT.push('', '-- already producing: keep running, ask passively --');
  const SK = require(REPO + 'server/services/schoolKeep.js');
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = 'ms-agent2'`); await P.query(`DELETE FROM athletes WHERE agent_id = 'ms-agent2'`);
  await P.query(`DELETE FROM school_question_dismissed WHERE agent_id = 'ms-agent2'`).catch(() => {}); await P.query(`DELETE FROM users WHERE id = 'ms-agent2'`);
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ('ms-agent2','Ms Two','ms2@ms.test','x','agent')`);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ms-jasper','ms-agent2','{"name":"Jasper Johnson","school":"Kentucky"}'),
                 ('ms-marcus','ms-agent2','{"name":"Marcus Johnson","school":"Kentucky"}')`);
  for (let i = 0; i < 5; i++) await P.query(`INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,market_key) VALUES ('ms-agent2','ms-jasper',$1,$2,$2,'call','queued','lexington, ky')`, [i + 1, 'Lex Biz ' + i]);
  ok('the keep list loads: Jasper (5 cards in Lexington) is kept, Marcus (none) is not', (await SK.load(P)) >= 1 && SK.keepFor('ms-jasper') && SK.keepFor('ms-jasper').market === 'Lexington, KY' && !SK.keepFor('ms-marcus'), SK.keepFor('ms-jasper'));
  const AR = require(REPO + 'server/services/athleteRecord.js');
  const jas = AR.resolveAthlete({ id: 'ms-jasper', data: { name: 'Jasper Johnson', school: 'Kentucky' } }, { schoolLocation: R.resolveSchool });
  ok('"Kentucky", already producing in Lexington: keeps that market, keeps running', jas.hasLocalMarket && /lexington/i.test(jas.market) && jas.schoolAskPassive && !jas.localLaneNote, jas);
  const jf = await job.fillAthlete(P, { agentId: 'ms-agent2', athleteId: 'ms-jasper', athleteName: 'Jasper Johnson', agentFirstName: '', athleteRow: { name: 'Jasper Johnson', school: 'Kentucky' }, dryRun: true });
  ok('  the night is not stopped for him (it gets past the school check)', !jf.ambiguousSchool, jf);
  const mf = await job.fillAthlete(P, { agentId: 'ms-agent2', athleteId: 'ms-marcus', athleteName: 'Marcus Johnson', agentFirstName: 'Sam', athleteRow: { name: 'Marcus Johnson', school: 'Kentucky' }, dryRun: true });
  ok('"Kentucky" with no working market: hard stop, no cards', mf.ambiguousSchool && mf.filled === 0, mf);
  const probs = await LLC.forAgent(P, 'ms-agent2');
  const pj = probs.find((x) => x.athleteId === 'ms-jasper'), pm = probs.find((x) => x.athleteId === 'ms-marcus');
  ok('Home: Jasper gets a passive, dismissible note naming the market he is getting', pj && pj.code === 'ambiguous-school-passive' && pj.dismissible && /Lexington, KY/.test(pj.text) && pj.choices.length >= 2, pj);
  ok('  Marcus gets the hard question', pm && pm.code === 'ambiguous-school' && !pm.dismissible, pm);
  ok('  dismissing it hides it for good', (await SK.dismiss(P, 'ms-agent2', 'ms-jasper')).ok && !(await LLC.forAgent(P, 'ms-agent2')).some((x) => x.athleteId === 'ms-jasper')
    && (await SK.load(P)) >= 1 && !(await LLC.forAgent(P, 'ms-agent2')).some((x) => x.athleteId === 'ms-jasper'));
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = 'ms-agent2'`); await P.query(`DELETE FROM athletes WHERE agent_id = 'ms-agent2'`);
  await P.query(`DELETE FROM school_question_dismissed WHERE agent_id = 'ms-agent2'`); await P.query(`DELETE FROM users WHERE id = 'ms-agent2'`);
  SK._reset();

  // ── 6. WHOSE ADDRESS IS IT, AND IS THIS PERSON THE LOCATION'S? ─────────
  OUT.push('', '-- what an address that is not theirs is --');
  ok('austin.mitchell@ on Greg Neichter\'s card is ANOTHER PERSON', Q.addressKind('austin.mitchell@dominos.com', 'Greg Neichter', "Domino's") === 'other-person');
  ok('  carvanatempe@, store5512@, info@, owner@ are GENERIC', ['carvanatempe@carvana.com', 'store5512@dominos.com', 'info@x.com', 'owner@x.com'].every((e) => Q.addressKind(e, 'Ernest Garcia', 'Carvana Tempe') === 'generic'));
  ok('  gneichter@ is his', Q.addressKind('gneichter@dominos.com', 'Greg Neichter', "Domino's") === 'theirs');

  OUT.push('', '-- the parent company\'s leadership is not the location\'s --');
  const ONS = require(REPO + 'server/services/ownerNameSearch.js');
  const refused = [
    ['Founder & CEO', { brand: 'HealthSource of Tempe', city: 'Tempe' }, 'Chris Tomshack, HealthSource'],
    ['Co-founder and CEO', { brand: 'La Colombe Coffee Roasters', city: 'Philadelphia' }, 'Todd Carmichael, La Colombe'],
    ['CEO', { brand: 'Carvana Tempe', city: 'Tempe' }, 'Ernest Garcia III, Carvana Tempe'],
    ['Founder & CEO, HealthSource Franchising', { brand: 'HealthSource Chiropractic', city: 'Tempe' }, 'a title naming the franchisor'],
  ];
  for (const [t, o, who] of refused) ok(`refused: ${who}`, /parent company's leadership/.test(ONS.titleProblem(t, o) || ''), ONS.titleProblem(t, o));
  const kept = [
    ['Franchise Owner', { brand: 'HealthSource of Tempe', city: 'Tempe' }], ['Owner', { brand: 'HealthSource of Tempe', city: 'Tempe' }],
    ['General Manager', { brand: 'Carvana Tempe', city: 'Tempe' }], ['Founder', { brand: 'Tempe Tattoo', city: 'Tempe' }],
    ['Owner and Founder', { brand: 'Tempe Tattoo', city: 'Tempe' }], ['Founder', { brand: "Joe's Pizza", city: 'Tempe' }],
    // The owners the first version withdrew: a one-location studio and a local gym.
    ['Owner of Bee Yoga Fusion, Health & Life coach, Pilates & Yoga Instructor, Personal Trainer', { brand: 'Bee Yoga Fusion', city: 'Tempe' }],
    ['Founder & Coach', { brand: 'Jaguar Martial Arts', city: 'Tempe' }],
    // Not chains just because a list entry resembles them, or the town is in the name.
    ['Founder', { brand: 'Ross Family Dentistry', city: 'Tempe' }], ['Founder', { brand: 'CrossFit Tempe', city: 'Tempe' }],
    ['Founder & CEO', { brand: 'Tempe Bikes', city: 'Tempe' }], ['President, Smith Holdings', { brand: 'Smith Plumbing', city: 'Tempe' }],
  ];
  ok('kept: the franchise owner, the owner, the location\'s manager, and every real local founder, however long the title', kept.every(([t, o]) => !ONS.titleProblem(t, o)), kept.map(([t, o]) => ONS.titleProblem(t, o)));
  ok('  a school\'s head coach and an emeritus chairman are still refused', !!ONS.titleProblem('Head Coach', { brand: 'Texas Tech' }) && !!ONS.titleProblem('Chairman Emeritus and co-founder', { brand: 'Nike' }));
  const NAS = require(REPO + 'server/services/notASponsor.js');
  ok('A UNIVERSITY DEPARTMENT is not a sponsor: UNH PAWS with colsa.dean@unh.edu', (NAS.detect('UNH PAWS Veterinary Clinic', { email: 'colsa.dean@unh.edu' }) || {}).kind === 'university-department');
  ok('  a business with its own address is not', NAS.detect('Bee Yoga Fusion', { email: 'gretchen@beeyogafusion.com' }) === null);

  // ── 7. THE CARDS ALREADY MADE ───────────────────────────────────────────
  OUT.push('', '-- the cards already on screens --');
  const { spawnSync } = require('child_process');
  const clean7 = async () => { await P.query(`DELETE FROM outreach_queue WHERE agent_id = 'ms-cm'`); await P.query(`DELETE FROM outreach_logs WHERE agent_id = 'ms-cm'`); await P.query(`DELETE FROM athletes WHERE agent_id = 'ms-cm'`); await P.query(`DELETE FROM users WHERE id = 'ms-cm'`); };
  await clean7();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ('ms-cm','Asante Owusu','asante@ms.test','x','agent')`);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ms-cm-a','ms-cm','{"name":"Tess Court","school":"Arizona State University"}')`);
  await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,sent_at) VALUES
    ('ms-l1','ms-cm','ms-cm-a','Dominos','s','<p>Hi Greg,</p><p>Tess plays near you.</p>','draft','austin.mitchell@dominos.com',NULL),
    ('ms-l2','ms-cm','ms-cm-a','Tempe Bikes','s','<p>Hi Ernest,</p><p>x</p>','draft','tempebikes@tb.com',NULL),
    ('ms-l3','ms-cm','ms-cm-a','HealthSource','s','<p>Hi Chris,</p><p>x</p>','sent','sarah.jones@hs.com',NOW() - INTERVAL '2 days'),
    ('ms-l4','ms-cm','ms-cm-a','Carvana Tempe','s','<p>Hi Ernest,</p><p>x</p>','draft','ernest@carvana.com',NULL),
    ('ms-l5','ms-cm','ms-cm-a','Bee Yoga Fusion','s','<p>Hi Gretchen,</p><p>x</p>','draft','gretchen@beeyogafusion.com',NULL),
    ('ms-l6','ms-cm','ms-cm-a','UNH PAWS Veterinary Clinic','s','<p>Hi Sarah,</p><p>x</p>','draft','colsa.dean@unh.edu',NULL)`);
  await P.query(`INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,outreach_log_id,contact_name,contact_title,phone,email,market_key) VALUES
    ('ms-cm','ms-cm-a',1,'m1','Dominos','email','queued','ms-l1','Greg Neichter','Owner','(480) 555-0100','austin.mitchell@dominos.com','tempe, az'),
    ('ms-cm','ms-cm-a',2,'m2','Tempe Bikes','email','queued','ms-l2','Ernest Lane','Owner',NULL,'tempebikes@tb.com','tempe, az'),
    ('ms-cm','ms-cm-a',3,'m3','HealthSource','email','sent','ms-l3','Chris Tomshack','Founder',NULL,'sarah.jones@hs.com','tempe, az'),
    ('ms-cm','ms-cm-a',4,'m4','Carvana Tempe','email','queued','ms-l4','Ernest Garcia III','CEO',NULL,'ernest@carvana.com','tempe, az'),
    ('ms-cm','ms-cm-a',5,'m5','Bee Yoga Fusion','email','queued','ms-l5','Gretchen Schock','Owner of Bee Yoga Fusion, Health & Life coach, Pilates & Yoga Instructor, Personal Trainer',NULL,'gretchen@beeyogafusion.com','tempe, az'),
    ('ms-cm','ms-cm-a',6,'m6','UNH PAWS Veterinary Clinic','email','queued','ms-l6','Sarah Proctor','Director',NULL,'colsa.dean@unh.edu','durham, nh')`);
  const run = spawnSync(process.execPath, [REPO + 'scripts/contact-mismatch-audit.js', '--apply'], { env: { ...process.env, INIT_WAIT_MS: '3000' }, encoding: 'utf8', timeout: 120000 });
  const outTxt = run.stdout || '';
  const card = async (slot) => (await P.query(`SELECT q.channel, q.state, q.outreach_log_id, q.phone_ask_for, l.status, l.body_html FROM outreach_queue q LEFT JOIN outreach_logs l ON l.id = $2 WHERE q.agent_id = 'ms-cm' AND q.slot = $1`, [slot, 'ms-l' + slot])).rows[0];
  const c1 = await card(1), c2 = await card(2), c4 = await card(4), c5 = await card(5), c6 = await card(6);
  ok('"Hi Greg" to austin.mitchell@ becomes a CALL to Greg, and the email draft is withdrawn', c1.channel === 'call' && !c1.outreach_log_id && c1.status === 'expired' && c1.phone_ask_for === 'Greg', c1);
  ok('a generic shop inbox keeps the email with the first name dropped ("Hi,")', c2.channel === 'email' && /^<p>Hi,<\/p>/.test(c2.body_html), c2);
  ok('Ernest Garcia III (CEO) for Carvana Tempe is withdrawn from the screen', c4.state === 'expired' && c4.status === 'expired', c4);
  ok('Gretchen Schock, owner of a one-location yoga studio, is NOT withdrawn', c5.state === 'queued' && c5.status === 'draft' && c5.channel === 'email', c5);
  ok('UNH PAWS (colsa.dean@unh.edu) is withdrawn as a university department', c6.state === 'expired' && /\[UNIVERSITY DEPARTMENT\] UNH PAWS/.test(outTxt), c6);
  ok('the withdraw list says which rule each one met', /\[CHAIN \/ CORPORATE PARENT\] Carvana Tempe/.test(outTxt) && !/Bee Yoga Fusion.*WITHDRAW/.test(outTxt), outTxt.slice(0, 1500));
  ok('the already-sent one is listed under the agent, marked DIFFERENT PERSON', /Asante Owusu <asante@ms\.test>: 1 \(1 to a different person\)/.test(outTxt) && /\[DIFFERENT PERSON\] .*HealthSource: greeted "Chris Tomshack", sent to <sarah\.jones@hs\.com>/.test(outTxt), outTxt.slice(-900));
  await clean7();

  OUT.push('', 'failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { OUT.push('FAIL threw: ' + (e && e.stack)); console.log(OUT.join('\n')); process.exit(1); });
