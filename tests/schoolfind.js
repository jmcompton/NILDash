'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/schoolfind.js       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── EVERY SCHOOL RESOLVES TO A TOWN, INSTANTLY, AND NOBODY SEES "COULD NOT
//    MATCH" ────────────────────────────────────────────────────────────────
//
// The lists end at the NAIA. A junior college, a high school or the next
// D3 school we missed used to come back "we could not match", and the
// athlete got no local lane. Now services/schoolFind looks it up on the
// spot (Places, then the web, the town accepted only when the source names
// the school, the city and the state), saves it, and learns it into the
// resolver so the next agent, the nightly run and the import all get it
// instantly. A shared name is offered with its towns; nothing found is one
// question, the city.

const R = require(REPO + 'server/services/schoolResolver.js');
const F = require(REPO + 'server/services/schoolFind.js');
const store = require(REPO + 'server/store.js');

let OUT = [], Fails = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { Fails++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');

// The two lookups, faked: what Places and the web would say.
const calls = { places: [], web: [] };
const fakePlaces = async (q) => {
  calls.places.push(q);
  if (/^Doane Community College/.test(q)) return { ok: true, place: { name: 'Doane Community College', address: '1014 Boswell Ave, Crete, NE 68333, USA', types: ['school', 'university'], mapsUrl: 'https://maps/x' } };
  if (/^Bentley Test University/.test(q)) return { ok: true, place: { name: 'Bentley Motors of Boston', address: '1 Auto Row, Boston, MA 02110, USA', types: ['car_dealer'] } };
  if (/^Western Test University/.test(q)) return { ok: true, place: { name: 'Western University', address: '1 Main St, Toledo, OH 43604, USA', types: ['university'] } };
  if (/^Test Outage/.test(q)) return { ok: false, place: null, reason: 'http-500' };
  return { ok: true, place: null, reason: 'not-found' };
};
const fakeWeb = async (o) => {
  calls.web.push(o.prompt);
  if (/Lincoln Test Prep High School/.test(o.prompt)) return { text: 'Here: {"school":"Lincoln Test Prep High School","city":"Kansas City","state":"MO"}', searches: 1,
    results: [{ title: 'Lincoln Test Prep High School - Kansas City, MO', url: 'https://example.org/lincoln', snippet: 'Lincoln Test Prep High School is a public school in Kansas City, Missouri.' }] };
  if (/Nowhere Test Tech/.test(o.prompt)) return { text: '{"school":"Nowhere Test Tech","city":"Springfield","state":"IL"}', searches: 2,
    results: [{ title: 'Springfield IL tourism', url: 'https://example.org/spr', snippet: 'Things to do in Springfield, Illinois.' }] };
  if (/Wrong State Test College/.test(o.prompt)) return { text: '{"school":"Wrong State Test College","city":"Austin","state":"TX"}', searches: 1,
    results: [{ title: 'Wrong State Test College, Austin TX', url: 'https://example.org/w', snippet: 'Wrong State Test College in Austin, TX' }] };
  return { text: '{"city":null}', searches: 1, results: [] };
};

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await store.pool.query(`DELETE FROM school_lookups WHERE name LIKE '%Test%' OR name IN ('Doane Community College')`).catch(() => {});
  R._resetLearnedForTests();

  // ── Pure, no database ─────────────────────────────────────────────────────
  F._setDepsForTests({ lookupPlaceResult: fakePlaces, searchLoop: fakeWeb });
  OUT.push('-- the lists first, instantly --');
  const w = await F.findSchool('Western New Mexico University');
  ok('a listed school is matched from the list with no lookup', w.ok && w.status === 'matched' && w.city === 'Silver City' && w.state === 'NM' && w.source === 'list' && calls.places.length === 0 && calls.web.length === 0, w);
  ok('  the answer has the shape the form already reads: ok, market, message, suggestions', w.market === 'Silver City, NM' && /Silver City, NM/.test(w.message) && Array.isArray(w.suggestions));
  const b = await F.findSchool('Bethel University');
  ok('a shared name is ambiguous: every town offered, none guessed, no lookup spent', b.ok === false && b.status === 'ambiguous' && b.options.length >= 3 && b.options.every((o) => /Bethel/.test(o.name) && o.city && o.state) && calls.places.length === 0, b);
  ok('  each option resolves when picked', b.options.every((o) => { const r = R.resolveSchool(o.name); return r && r.city === o.city; }));
  ok('  with the state it is no longer ambiguous', (await F.findSchool('Bethel University', { state: 'TN' })).city === 'McKenzie');
  ok('an empty name is empty, not a lookup', (await F.findSchool('')).status === 'empty' && calls.places.length === 0);
  ok('junk never reaches a paid lookup: "State", "TBD", "x"', (await F.findSchool('State')).status === 'unknown' && (await F.findSchool('TBD')).status === 'unknown' && (await F.findSchool('x')).status === 'unknown' && calls.places.length === 0);
  const inst = await F.findSchool('Doane Community College', { instantOnly: true });
  ok('the keystroke check stops at the lists: unresolved, "Finding the school", nothing spent', inst.status === 'unresolved' && /Finding the school/.test(inst.message) && calls.places.length === 0, inst);

  OUT.push('', '-- Places, by name and state, checked --');
  const d = await F.findSchool('Doane Community College', { agentId: 'agent-test' });
  ok('a junior college the lists do not carry is found by Places', d.ok && d.status === 'matched' && d.city === 'Crete' && d.state === 'NE' && d.source === 'places', d);
  ok('  Places was asked by the name (and the state when given), never the town', calls.places.length === 1 && calls.places[0] === 'Doane Community College');
  ok('  and it is learned: the resolver answers it synchronously now', (() => { const r = R.resolveSchool('Doane Community College'); return r && r.city === 'Crete' && r.state === 'NE'; })());
  ok('  the second ask is instant from what was learned', (await F.findSchool('Doane Community College')).source === 'learned' && calls.places.length === 1);
  const st = await F.findSchool('Doane Community College', { state: 'NE' });
  ok('  a state hint on a learned school still matches', st.ok && st.city === 'Crete');
  const bent = await F.findSchool('Bentley Test University');
  ok('a Places hit that is not a school (a car dealer) is refused', bent.status !== 'matched' && !R.resolveSchool('Bentley Test University'), bent);
  const west = await F.findSchool('Western Test University');
  ok('a Places hit whose name does not carry the typed name is refused ("Western University" for "Western Test University")', west.status !== 'matched' && !R.resolveSchool('Western Test University'), west);
  ok('namesAgree: every distinctive word of the shorter name is in the longer; a state\'s name counts', F.namesAgree('Western New Mexico University', 'Western New Mexico University - Main Campus') && F.namesAgree('New Mexico Junior College', 'New Mexico Junior College') && F.namesAgree('Doane Community College', 'Doane College') && !F.namesAgree('Western University', 'Western New Mexico University') && !F.namesAgree('Western Test University', 'Western University') && !F.namesAgree('Eastern New Mexico University', 'Western New Mexico University'));
  ok('  a dealer that shares the name is refused by its Places type, not its name', F.namesAgree('Bentley University', 'Bentley Motors') && !require(REPO + 'server/services/schoolGeocode.js').looksLikeSchool({ types: ['car_dealer'] }));

  OUT.push('', '-- the web, accepted only when the source says it --');
  const lin = await F.findSchool('Lincoln Test Prep High School', { agentId: 'agent-test' });
  ok('a high school Places did not have is found on the web', lin.ok && lin.city === 'Kansas City' && lin.state === 'MO' && lin.source === 'web', lin);
  ok('  the web was asked only after Places missed', calls.places.some((q) => /^Lincoln Test Prep/.test(q)) && calls.web.length >= 1);
  ok('  a learned high school is still a high school to the create path (the date of birth is still asked)', require(REPO + 'server/services/athleteCreate.js').isHighSchool('Lincoln Test Prep High School') === true && R.resolveSchool('Lincoln Test Prep High School').city === 'Kansas City');
  ok('  the web prompt asks for JSON, at most two searches, and names the school', /Lincoln Test Prep High School/.test(calls.web[calls.web.length - 1]) && /JSON/.test(calls.web[calls.web.length - 1]));
  const now = await F.findSchool('Nowhere Test Tech');
  ok('a town the model said but no result names is NOT accepted', now.ok === false && now.status === 'unknown' && now.why && now.why.web === 'unsourced', now);
  ok('  and the answer is the one question, the city, never an error', /What city is Nowhere Test Tech in/.test(now.ask) && !/could not match/i.test(now.message));
  const wrong = await F.findSchool('Wrong State Test College', { state: 'NM' });
  ok('a web answer in another state than the agent typed is refused', wrong.status === 'unknown', wrong);
  ok('resultSupports needs the school words, the city and the state in the result itself',
    F.resultSupports({ title: 'Lincoln Test Prep High School', snippet: 'in Kansas City, Missouri' }, 'Lincoln Test Prep High School', 'Kansas City', 'MO')
    && F.resultSupports({ title: 'Lincoln Test Prep', snippet: 'Kansas City, MO 64110' }, 'Lincoln Test Prep High School', 'Kansas City', 'MO')
    && !F.resultSupports({ title: 'Lincoln Test Prep', snippet: 'Kansas City' }, 'Lincoln Test Prep High School', 'Kansas City', 'MO')
    && !F.resultSupports({ title: 'Kansas City, MO', snippet: 'a school' }, 'Lincoln Test Prep High School', 'Kansas City', 'MO'));
  const before = calls.web.length;
  await F.findSchool('Nowhere Test Tech');
  ok('a miss is remembered: asking again inside ten minutes spends nothing', calls.web.length === before);
  const out = await F.findSchool('Test Outage College');
  ok('a Places outage is not "no such school": the web is still asked, and nothing is claimed', out.status === 'unknown' && out.why && out.why.places === 'http-500' && out.why.web, out);

  OUT.push('', '-- the one question, and the agent\'s answer --');
  const ans = await F.findSchool('Nowhere Test Tech', { city: 'Springfield, IL', agentId: 'agent-test' });
  ok('the agent\'s "City, ST" becomes the town, source agent', ans.ok && ans.city === 'Springfield' && ans.state === 'IL' && ans.source === 'agent', ans);
  ok('  and it is learned like any other', (() => { const r = R.resolveSchool('Nowhere Test Tech'); return r && r.city === 'Springfield'; })());
  ok('  an answer that is not a town is asked again, not saved', (await F.findSchool('Another Test School', { city: 'idk' })).status === 'unknown' && !R.resolveSchool('Another Test School'));
  ok('parseCityState reads every way an agent writes a town', JSON.stringify([F.parseCityState('Silver City, NM'), F.parseCityState('Silver City NM'), F.parseCityState('Silver City, New Mexico'), F.parseCityState('silver city, nm'), F.parseCityState('Silver City'), F.parseCityState('Silver City', 'NM')])
    === JSON.stringify([{ city: 'Silver City', state: 'NM' }, { city: 'Silver City', state: 'NM' }, { city: 'Silver City', state: 'NM' }, { city: 'silver city', state: 'NM' }, null, { city: 'Silver City', state: 'NM' }]), [F.parseCityState('Silver City NM'), F.parseCityState('Silver City, New Mexico')]);

  OUT.push('', '-- several at once (the import) --');
  const many = await F.findMany(['Doane Community College', 'Bethel University', 'Western New Mexico University', 'Doane Community College', '']);
  ok('findMany answers each distinct name once, in a map', many.size === 3 && many.get('Doane Community College').ok && many.get('Bethel University').status === 'ambiguous' && many.get('Western New Mexico University').source === 'list');

  // ── With the database ─────────────────────────────────────────────────────
  OUT.push('', '-- saved, so it never costs twice; reviewed on the admin page --');
  R._resetLearnedForTests();
  calls.places.length = 0; calls.web.length = 0;
  F._setDepsForTests({ lookupPlaceResult: fakePlaces, searchLoop: fakeWeb, store });
  const saved = await F.findSchool('Doane Community College', { agentId: 'agent-test' });
  const row = (await store.pool.query(`SELECT * FROM school_lookups WHERE name = 'Doane Community College'`)).rows[0];
  ok('a found town is written to school_lookups, status auto, with its source and evidence', saved.saved === true && row && row.city === 'Crete' && row.state === 'NE' && row.source === 'places' && row.status === 'auto' && row.evidence && row.evidence.placeName === 'Doane Community College' && row.found_by === 'agent-test', row);
  R._resetLearnedForTests();
  F._setDepsForTests({ lookupPlaceResult: fakePlaces, searchLoop: fakeWeb, store });
  const n = await F.loadLearned();
  ok('at boot the saved rows are loaded into the resolver', n >= 1 && R.resolveSchool('Doane Community College') && R.resolveSchool('Doane Community College').city === 'Crete', n);
  ok('  so the next agent gets it with no lookup', (await F.findSchool('Doane Community College')).source === 'learned' && calls.places.length === 1);
  await F.findSchool('Lincoln Test Prep High School', { agentId: 'agent-test' });
  await F.findSchool('Nowhere Test Tech', { city: 'Springfield, IL', agentId: 'agent-test' });
  const list = await F.listLookups();
  ok('the admin list carries every auto-found school with town, source, who found it and how often it was used', list.length >= 3 && list.every((x) => x.name && x.source && x.status) && list.some((x) => x.source === 'web' && x.name === 'Lincoln Test Prep High School') && list.some((x) => x.source === 'agent'), list.map((x) => [x.name, x.source, x.status]));
  ok('  filtered by status', (await F.listLookups({ status: 'auto' })).every((x) => x.status === 'auto'));
  const lincoln = list.find((x) => x.name === 'Lincoln Test Prep High School');
  const rej = await F.reviewLookup(lincoln.id, { status: 'rejected', note: 'wrong town' });
  ok('rejecting a row unlearns it everywhere at once', rej.status === 'rejected' && !R.resolveSchool('Lincoln Test Prep High School'));
  ok('  and it is not looked up again behind the admin\'s back', (await F.findSchool('Lincoln Test Prep High School')).status === 'unknown' && !R.resolveSchool('Lincoln Test Prep High School'));
  const fixed = await F.reviewLookup(row.id, { status: 'confirmed', city: 'Lincoln, NE' });
  ok('fixing the town confirms the row and the resolver answers the corrected town', fixed.status === 'confirmed' && fixed.city === 'Lincoln' && fixed.state === 'NE' && R.resolveSchool('Doane Community College').city === 'Lincoln', fixed);
  let bad = null; try { await F.reviewLookup(row.id, { city: 'nowhere' }); } catch (e) { bad = e; }
  ok('  a town without a state is refused with a 400, not written', bad && bad.status === 400 && R.resolveSchool('Doane Community College').city === 'Lincoln');
  R._resetLearnedForTests();
  F._setDepsForTests({ lookupPlaceResult: fakePlaces, searchLoop: fakeWeb, store });
  await F.loadLearned();
  ok('a rejected row is not loaded at boot; a confirmed one is', !R.resolveSchool('Lincoln Test Prep High School') && R.resolveSchool('Doane Community College').city === 'Lincoln');

  OUT.push('', '-- the chat uses the same lookup --');
  R._resetLearnedForTests();
  F._setDepsForTests({ lookupPlaceResult: fakePlaces, searchLoop: fakeWeb });
  const AA = require(REPO + 'server/services/assistantActions.js');
  const ctx = { agentId: 'agent-test', session: {} };
  const amb = await AA.ACTIONS.add_athlete.run({ name: 'Test Kid', sport: 'Soccer', athleteType: 'college', school: 'Bethel University' }, ctx);
  ok('add_athlete with a shared school name asks which, with the towns as buttons, and adds nothing', amb.data.added === false && amb.data.needs === 'school_choice' && amb.data.options.length >= 3 && amb.directive && amb.directive.kind === 'choices' && amb.directive.choices.every((c) => /Bethel/.test(c.label) && /, [A-Z]{2}\)/.test(c.label) && /Test Kid's school is/.test(c.say)), amb);
  const unk = await AA.ACTIONS.add_athlete.run({ name: 'Test Kid', sport: 'Soccer', athleteType: 'college', school: 'Nowhere Test Tech' }, ctx);
  ok('add_athlete with a school nothing can place asks the one question, the city', unk.data.added === false && unk.data.needs === 'school_city' && /What city is Nowhere Test Tech in/.test(unk.data.ask), unk);
  ok('  schoolCity is an input the model can answer with', AA.ACTIONS.add_athlete.input.properties.schoolCity && AA.ACTIONS.add_athlete.check({ name: 'A B', sport: 'x', school: 'S', schoolCity: 'Springfield, IL' }).args.schoolCity === 'Springfield, IL');
  const fs1 = await AA.ACTIONS.find_school.run({ school: 'Doane Community College' }, ctx);
  ok('find_school finds and reports the town, saying it was saved', fs1.data.found && fs1.data.city === 'Crete' && fs1.data.source === 'places' && fs1.data.saved === true, fs1);
  const fs2 = await AA.ACTIONS.find_school.run({ school: 'Bethel University' }, ctx);
  ok('  a shared name is choices to tap', fs2.data.ambiguous && fs2.directive.kind === 'choices' && fs2.directive.choices.length >= 3);
  const fs3 = await AA.ACTIONS.find_school.run({ school: 'Nowhere Test Tech' }, ctx);
  ok('  nothing found is the one question', fs3.data.found === false && /What city/.test(fs3.data.ask));
  ok('  it is in the tool list the model sees', AA.toolDefs().some((t) => (t.name || (t.function && t.function.name)) === 'find_school'));

  OUT.push('', '-- the wiring --');
  const idx = src('server/index.js');
  ok('the form\'s check route finds the school: deep runs the lookup, a keystroke stays on the lists, city keeps the answer', /app\.get\('\/api\/onboarding\/check-school', requireAuth, async/.test(idx) && /instantOnly: !q\.deep && !q\.city/.test(idx) && /city: q\.city \|\| null/.test(idx));
  ok('learned schools are loaded at boot once the tables exist', /store\.ready\.then\(\(\) => require\('\.\/services\/schoolFind'\)\.ensureLoaded\(\)\)/.test(idx) && /const ready = init\(\)/.test(src('server/store.js')) && /^\s+ready,/m.test(src('server/store.js')));
  ok('the table exists: school_lookups with name_key, source, status, evidence, found_by, uses', /CREATE TABLE IF NOT EXISTS school_lookups[\s\S]*name_key\s+TEXT UNIQUE[\s\S]*source[\s\S]*evidence[\s\S]*status[\s\S]*found_by[\s\S]*uses/.test(src('server/store.js')));
  ok('the import looks up every unknown school before placing the rows, a few at a time', /findMany\(unknownSchools, \{ agentId: user\.id, concurrency: 4 \}\)/.test(idx) && /affiliationKind === 'school'/.test(idx));
  ok('  and the row note never says "could not match": a shared name asks which, nothing found asks for a City column', /put the state in the school name/.test(src('server/services/rosterImport.js')) && /town not found for this school; add a City column/.test(src('server/services/rosterImport.js')) && !/could not match/i.test(src('server/services/rosterImport.js')));
  ok('admin: GET /api/admin/school-lookups and POST .../:id/review, admin only', /app\.get\('\/api\/admin\/school-lookups', requireAuth/.test(idx) && /app\.post\('\/api\/admin\/school-lookups\/:id\/review', requireAuth/.test(idx) && /school-lookups', requireAuth[\s\S]{0,300}user\.email !== ADMIN_EMAIL/.test(idx));
  const adm = src('public/admin.html');
  ok('  the admin page lists auto-found schools with Confirm, Fix town and Reject', /Auto-found schools/.test(adm) && /loadSchoolLookups\(\)/.test(adm) && /\/api\/admin\/school-lookups/.test(adm) && /Confirm<\/button>/.test(adm) && /Fix town<\/button>/.test(adm) && /Reject<\/button>/.test(adm) && /\/review/.test(adm));
  const html = src('public/index.html');
  ok('the form says "Finding the school…" while it looks, on both the Add Client and onboarding fields', /Finding the school\\u2026/.test(html) && /_schoolFields\['a_school'\]/.test(html) && /_schoolFields\['ob-athlete-school'\]/.test(html));
  ok('  a shared name is chips with the town on each; nothing found is one City, ST box with Save town', /status === 'ambiguous'/.test(html) && /status === 'unknown'/.test(html) && /placeholder="City, ST"/.test(html) && /Save town/.test(html) && /function schoolFieldCity/.test(html));
  ok('  the keystroke stays on the lists and the lookup follows once typing stops; blur and Next run it at once', /status === 'unresolved'/.test(html) && /schoolFieldCheck\(f, 'deep'\)/.test(html) && /onblur="aCheckSchool\(true\)"/.test(html) && /onblur="obCheckSchool\(true\)"/.test(html) && /await obCheckSchool\(true\)/.test(html));
  ok('  nothing on the form says "could not match"', !/could not match/i.test(html.slice(html.indexOf('function schoolFieldCheck'), html.indexOf('function schoolFieldCity'))));
  const cli = src('public/assistant.js');
  ok('the chat renders choices as chips that say the answer for the agent', /d\.kind === 'choices'/.test(cli) && /d\.kind === 'say'/.test(cli) && /nilAssistant\.send\(\)/.test(cli));
  const prompt = src('server/services/assistantPrompt.js');
  ok('the prompt: every school has a town, never "could not match", one question for the city, then call again with schoolCity', /EVERY SCHOOL HAS A TOWN/.test(prompt) && /Never tell an agent a school could not be matched/.test(prompt) && /needs school_city/.test(prompt) && /schoolCity/.test(prompt));
  const kb = src('server/services/assistantKnowledge.js');
  ok('the knowledge base: D1, D2, D3, NAIA, NJCAA, junior colleges and high schools, looked up, saved, reviewed', /EVERY SCHOOL RESOLVES TO A TOWN/.test(kb) && /NJCAA/.test(kb) && /high schools/.test(kb) && /Google Places first/.test(kb) && /auto-found/.test(kb));
  ok('the search loop hands back the results it saw, so a web answer can be checked against its source', /results\.push\(\{ query/.test(src('server/services/webSearchTool.js')) && /rounds, results \}/.test(src('server/services/webSearchTool.js')));
  ok('the resolver learns and unlearns, and never overwrites a curated key', (() => { const before = R.resolveSchool('Western New Mexico University').city; const t = R.learn('Western New Mexico University', { city: 'Elsewhere', state: 'TX' }); const after = R.resolveSchool('Western New Mexico University').city; return t === false && before === after && after === 'Silver City'; })());
  ok('  the ledger site is lookup.school, so the spend shows under lookups', /site: 'lookup\.school'/.test(src('server/services/schoolFind.js')));

  await store.pool.query(`DELETE FROM school_lookups WHERE name LIKE '%Test%' OR name IN ('Doane Community College')`).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + Fails);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(Fails ? 1 : 0);
})().catch(async (e) => { console.error('schoolfind: FAILED', e); try { await store.pool.end(); } catch (_) {} process.exit(1); });
