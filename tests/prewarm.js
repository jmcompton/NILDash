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
// Pre-warmed AI Outreach drafts. Three things must hold: the scan must not slow
// down, the draft must be specific enough to be worth sending, and a failure must
// land on the old click path rather than an empty box.
const aiPath = require.resolve(REPO + 'server/ai.js');
let _calls = [];
let _reply = () => JSON.stringify({ subject: 'Aurora Fitness x Fixture Alvarez', body: 'Hi,\n\nFixture Alvarez is a distance runner at State who posts her training blocks twice a week. Aurora Fitness draws the same early-morning crowd that watches those posts, which is why she came up for you specifically. She would run a six-week block filmed in your gym, three posts and two stories, with a discount code your members can use. Worth a short call this week?' });
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  oneShot: async (prompt, system, maxTokens, model) => { _calls.push({ prompt, system, maxTokens, model }); return _reply(_calls.length); },
  withTimeout: (p) => p, withDeadline: (p) => p,
  resolveBrandKey: (o) => (o && o.place_id ? 'place:' + o.place_id : (o && o.brand ? 'name:' + String(o.brand).toLowerCase().replace(/\W+/g, '') : null)),
  MODEL_FAST: 'haiku',
} };

// store.js opens a pg Pool at import; stub it so the service is testable offline.
const storePath = require.resolve(REPO + 'server/store.js');
let _sql = [];
let _rows = [];
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
  pool: { query: async (text, params) => { _sql.push({ text, params }); const r = _rows.shift(); return r || { rows: [], rowCount: 0 }; } },
} };

const pw = require(REPO + 'server/services/draftPrewarm.js');
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const ATHLETE = {
  id: 'ath_1', name: 'Fixture Alvarez', sport: 'Track', position: 'Distance',
  school: 'State', instagram: 41000, engagement: 5.2, stats: 'Two-time conference finalist',
};
const CARD = {
  brand: 'Aurora Fitness', category: 'Gym', website: 'https://aurorafitness.example',
  region: 'Springfield, IL', place_id: 'pid_aurora',
  rationale: 'Her training content reaches the same early-morning lifters who make up this gym\'s membership.',
  evidence: 'Gym posts member workout clips; athlete posts training blocks twice weekly',
  matchedTags: ['fitness', 'training'], campaign: 'Six-week training block',
  recommendedPitch: 'Content series plus discount code', recommendedWhy: 'Local gym, small budget, high foot traffic',
  fitScore: 84,
};

console.log('-- the prompt carries the card\'s FIT REASONING, which is the whole point --');
const prompt = pw.buildPrompt(ATHLETE, CARD, 'Sample Agent');
ok('the rationale is in the prompt', prompt.includes(CARD.rationale));
ok('and it is labelled as the reason, not buried', /WHY THIS BUSINESS WAS FLAGGED/.test(prompt));
ok('the evidence is there too', prompt.includes(CARD.evidence));
ok('matched tags are there', prompt.includes('fitness, training'));
ok('the recommended structure is there', prompt.includes('Content series plus discount code'));
ok('the athlete is described', prompt.includes('Fixture Alvarez') && prompt.includes('Track'));

console.log('\n-- the prompt forbids filler EXPLICITLY, by name --');
// Listed WITHOUT the leading pronoun on purpose: the check matches by substring, so
// one entry covers both "I hope this email finds you well" and "Hope this email
// finds you well". The pronoun-only version missed the second, which is the form a
// model writes more often.
for (const banned of ['would be a great fit', 'perfect partnership', 'hope this email finds you'])
  ok(`bans "${banned}"`, prompt.includes(banned));
ok('and states the test in one sentence',
  /could have been written without knowing which business it is, it is wrong/.test(prompt));
ok('asks for three or four sentences', /Three or four sentences/.test(prompt));
ok('one ask, not several', /One clear ask, and only one/.test(prompt));
ok('never a dollar amount', /Never a dollar amount/.test(prompt));

console.log('\n-- contact-agnostic: no invented name --');
ok('the greeting is a bare Hi', /exactly "Hi," on its own line/.test(prompt));
ok('and inventing a name is forbidden', /Do NOT invent a name/.test(prompt));
ok('no contact name is fed in at all', !/Dana|Decision Maker|TARGET CONTACT/.test(prompt));

console.log('\n-- the specificity check REJECTS what the prompt forbade --');
ok('filler is caught', pw.checkDraft('Hi,\n\nYour business would be a great fit for Aurora Fitness.', CARD).ok === false);
ok('and named as filler',
  /banned filler/.test(pw.checkDraft('Hi,\n\nHope this email finds you well. Aurora Fitness is great.', CARD).why || ''));
// The list stored "I hope this email finds you well", so the far more common
// pronoun-less opener sailed through. Both forms, and a curly apostrophe, now.
for (const opener of ['I hope this email finds you well', 'Hope this email finds you well',
  'Hope you\u2019re doing well', "Hope you're doing well", 'Hope   all   is   well'])
  ok(`caught: "${opener}"`, pw.checkDraft('Hi,\n\n' + opener + '. Aurora Fitness is nearby.', CARD).ok === false, opener);
ok('a draft that never names the business is caught',
  pw.checkDraft('Hi,\n\nShe is a runner and would like to work with a local company on a content series.', CARD).ok === false);
ok('an empty body is caught', pw.checkDraft('', CARD).ok === false);
ok('a ten-sentence essay is caught',
  pw.checkDraft('Hi,\n\n' + 'Aurora Fitness is a gym that many people go to often. '.repeat(10), CARD).ok === false);
const good = 'Hi,\n\nFixture Alvarez runs distance at State and posts her training blocks twice a week. Aurora Fitness draws the same early-morning lifters who watch those posts. She would film a six-week block in your gym, three posts and two stories, with a code for your members. Worth a short call this week?';
ok('a real specific draft passes', pw.checkDraft(good, CARD).ok === true, pw.checkDraft(good, CARD).why);

console.log('\n-- the model and the shape --');
(async () => {
  _calls = []; _sql = []; _rows = [{ rows: [] }, { rows: [], rowCount: 1 }];
  const r = await pw.draftOne({ agentId: 'ag_1', athleteId: 'ath_1', athlete: ATHLETE, card: CARD, agentName: 'Sample Agent', lane: 'local' });
  ok('one model call per card', _calls.length === 1, _calls.length);
  ok('SONNET, named explicitly, not Opus and not a default',
    _calls[0].model === 'claude-sonnet-4-6', _calls[0].model);
  ok('the draft was stored', r.drafted === true, r);
  const ins = _sql.find((q) => /INSERT INTO outreach_logs/.test(q.text));
  ok('written to outreach_logs', !!ins);
  ok('as a DRAFT', ins && /'draft'/.test(ins.text));
  ok('tagged source=prewarm so its origin is knowable later', ins && /'prewarm'/.test(ins.text));
  ok('keyed by brand_key', ins && /brand_key/.test(ins.text) && ins.params.includes('place:pid_aurora'));
  ok('body stored as HTML divs, the same shape the click path stores',
    ins && /^<div>/.test(ins.params[6]), ins && String(ins.params[6]).slice(0, 40));

  console.log('\n-- NO CRM DEAL on the pre-warm path --');
  const SRC = fs.readFileSync(REPO + 'server/services/draftPrewarm.js', 'utf8');
  const CODE = SRC.replace(/^\s*\/\/.*$/gm, '');
  ok('the service never writes to deals', !/INSERT INTO deals/i.test(CODE));
  ok('it never calls createCRMDeal', !/createCRMDeal/.test(CODE));
  ok('and the only table it writes is outreach_logs',
    (CODE.match(/INSERT INTO (\w+)/g) || []).every((m) => /outreach_logs/.test(m)),
    CODE.match(/INSERT INTO (\w+)/g));
  ok('no enrichment, no contact discovery, no deck on this path',
    !/companyEnrichment|contactDiscovery|deckGeneration/.test(CODE));

  console.log('\n-- cached: same athlete + same business does not redraft --');
  _calls = []; _sql = []; _rows = [{ rows: [{ id: 'out_existing' }] }];
  const again = await pw.draftOne({ agentId: 'ag_1', athleteId: 'ath_1', athlete: ATHLETE, card: CARD, agentName: 'A', lane: 'local' });
  ok('no model call', _calls.length === 0, _calls.length);
  ok('reported as cached', again.skipped === 'cached', again);
  const look = _sql[0];
  ok('the cache lookup is scoped to status=draft, so a SENT one does not block a new draft',
    /status = 'draft'/.test(look.text), look.text);

  console.log('\n-- a rejected draft is NOT stored, so the modal falls back --');
  _calls = []; _sql = []; _rows = [{ rows: [] }];
  _reply = () => JSON.stringify({ subject: 'x', body: 'Hi,\n\nYour business would be a great fit for our athlete.' });
  const bad = await pw.draftOne({ agentId: 'ag_1', athleteId: 'ath_1', athlete: ATHLETE, card: CARD, agentName: 'A', lane: 'local' });
  ok('reported as failed', !!bad.failed, bad);
  ok('and nothing was written', !_sql.some((q) => /INSERT INTO outreach_logs/.test(q.text)), _sql.map((q) => q.text.slice(0, 30)));

  console.log('\n-- concurrency is 3, and the batch is capped --');
  ok('CONCURRENCY is 3', pw.CONCURRENCY === 3, pw.CONCURRENCY);
  ok('MAX_CARDS bounds a batch', pw.MAX_CARDS >= 10 && pw.MAX_CARDS <= 12, pw.MAX_CARDS);
  ok('each draft has a wall-clock cap', pw.DRAFT_TIMEOUT_MS > 0, pw.DRAFT_TIMEOUT_MS);
  {
    // Prove it never exceeds 3 in flight.
    let live = 0, peak = 0;
    _reply = () => JSON.stringify({ subject: 's', body: good });
    require.cache[aiPath].exports.oneShot = async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--; return _reply();
    };
    _rows = []; _sql = [];
    for (let i = 0; i < 20; i++) _rows.push({ rows: [] }, { rows: [], rowCount: 1 });
    const cards = Array.from({ length: 10 }, (_, i) => ({ ...CARD, brand: 'Aurora Fitness ' + i, place_id: 'pid_' + i }));
    const out = await pw.prewarmScan({ agentId: 'ag_1', athleteId: 'ath_1', athlete: ATHLETE, cards, agentName: 'A', lane: 'local' });
    ok('never more than 3 concurrent model calls', peak <= 3, peak);
    ok('but all 10 cards were drafted, not just the top few', out.drafted === 10, out);
  }

  console.log('\n-- scan speed is untouched: pre-warm fires AFTER the response --');
  const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const scan = SRV.slice(SRV.indexOf("app.post('/api/agent/deal-scan'"), SRV.indexOf("app.post('/api/agent/deal-scan/worked'"));
  const resAt = scan.indexOf('res.json({ opportunities: recommendations');
  const pwAt = scan.indexOf('_prewarm.prewarmScan');
  ok('prewarmScan is called after res.json', resAt !== -1 && pwAt > resAt, { resAt, pwAt });
  ok('and is not awaited', !/await _prewarm\.prewarmScan/.test(scan));
  ok('its failure cannot fail the scan', /prewarmScan\([\s\S]{0,400}\}\)\.catch\(/.test(scan));

  console.log('\n-- the double-spend is closed --');
  const CD = fs.readFileSync(REPO + 'server/services/contactDiscovery.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok('discoverContacts accepts the card\'s ladder', /discoverContacts\(agentId, enrichmentRecord, knownContacts\)/.test(CD));
  // Structural, not a contiguous-substring probe: the call is formatted across
  // several lines now that it takes the shared deep ctx.
  ok('and skips the fan-out when it is usable',
    CD.indexOf('if (supplied) {') !== -1
    && CD.indexOf('} else {', CD.indexOf('if (supplied) {')) < CD.indexOf('getBrandContacts('), null);
  ok('and the lookup it skips is the DEEP one, not a cheaper variant',
    /deepContactCtx\(/.test(CD) && !/\{ enrichEmail: true \}/.test(CD), null);
  // PREMISE CHANGED, DELIBERATELY. This matched the source of the `supplied` test,
  // which used to accept `|| knownContacts.businessPhone`. That was the bug: the
  // cheap Places pass sets a phone on nearly every card, so the fan-out was skipped
  // on almost every click and the run produced a main line and no person. The
  // guarantee this assertion NAMES still holds, and is now stronger -- so it is
  // stated as a property of the code rather than a shape of its text.
  ok('a card with no named person does not suppress the real lookup',
    /suppliedNamed > 0/.test(CD) && !/\|\| knownContacts\.businessPhone/.test(CD),
    (CD.match(/const supplied[^;]*;/) || [])[0]);
  // CD has comments stripped, so this checks the RULE rather than the note that
  // explains it: a phone alone must not appear in the supplied test at all.
  ok('  and a bare business phone plays no part in the supplied test',
    !/supplied\s*=[^;]*businessPhone/.test(CD), (CD.match(/const supplied[^;]*;/) || [])[0]);
  ok('  while the phone the card knew is still carried into the result',
    /if \(!shared\.businessPhone && carriedPhone\) shared\.businessPhone = carriedPhone;/.test(CD), null);
  const WO = fs.readFileSync(REPO + 'server/services/workflowOrchestrator.js', 'utf8');
  ok('the orchestrator threads it through', /discoverContacts\(agentId, enrichment, knownContacts\)/.test(WO));
  const RT = fs.readFileSync(REPO + 'server/routes/outreach.js', 'utf8');
  ok('the route whitelists the client payload rather than trusting it', /_safeKnownContacts\(knownContacts\)/.test(RT));
  ok('and validates emails inside it', /\^\[\^\\s@\]\+@/.test(RT));
  const OE = fs.readFileSync(REPO + 'public/outreach-engine.js', 'utf8');
  ok('the client sends the card\'s contacts', /knownContacts: cardContacts\(dealResult\)/.test(OE));
  // RUN it, do not match its source. This was a regex against the body of
  // cardContacts, which asserts the code says what I already believed rather than
  // what it does -- and it broke the moment the line was refactored while the
  // guarantee it names was still intact.
  {
    const liftFn = (sig) => {
      const s = OE.indexOf(sig);
      if (s === -1) throw new Error('FIXTURE BROKEN: ' + sig);
      let d = 0, j = OE.indexOf('{', s), e = j;
      for (; j < OE.length; j++) { if (OE[j] === '{') d++; else if (OE[j] === '}') { d--; if (!d) { e = j; break; } } }
      return OE.slice(s, e + 1);
    };
    const cardContacts = new Function(
      liftFn('function cardContacts(d) {') + '\n' + liftFn('function _rankLikeLadder(contacts, ladder) {') + '\n return cardContacts;')();
    ok('and sends null when the card found nothing', cardContacts({ brand: 'X' }) === null, cardContacts({ brand: 'X' }));
    ok('  null for a card with an empty contact list and no phone',
      cardContacts({ brand: 'X', contacts: [] }) === null, cardContacts({ brand: 'X', contacts: [] }));
    ok('  but NOT null when all it has is the main line',
      !!cardContacts({ brand: 'X', businessPhone: '205-555-0100' }));
    // The ordering the server then relies on: discoverContacts assigns priority by
    // array index and the pitch is addressed to contacts[0].
    const ranked = cardContacts({
      brand: 'X',
      contacts: [{ name: 'Marcus Webb', email: null }, { name: 'Dana Kessler', email: 'dana@x.example' }],
      contactLadder: { tiers: [
        { tier: 1, rows: [{ name: 'Dana Kessler', email: 'dana@x.example', confidence: 'Confident' }] },
        { tier: 2, rows: [{ name: 'Marcus Webb', email: null, confidence: 'Confident' }] },
      ] },
    });
    ok('  and it is sent in LADDER order, not fan-out order',
      ranked.contacts[0].name === 'Dana Kessler', ranked.contacts.map((c) => c.name));
    ok('  without dropping anyone', ranked.contacts.length === 2, ranked.contacts.length);
  }

  console.log('\n-- the modal asks for the pre-warmed draft FIRST, and falls back --');
  ok('lookup happens before the /run post',
    OE.indexOf('fetchPrewarmedDraft') < OE.indexOf("outreachAPI.post('/run'"), null);
  ok('a 404 is a miss, not an error', /if \(r\.status === 404\) return null/.test(OE));
  ok('a failed lookup still falls through to /run',
    /catch \(e\) \{[\s\S]{0,160}prewarm lookup failed, generating on click/.test(OE));
  ok('the greeting is personalised only if a name was found since',
    /personalizeGreeting/.test(OE) && /resolvePersonalEmail\(contact\)/.test(OE));
  ok('and only the greeting line is touched',
    /if \(!\/\^\\s\*hi\\s\*,\?\\s\*\$\/i\.test\(lines\[0\]\)\) return;/.test(OE), null);
  ok('the pre-warmed draft id becomes the editable draft, so edits save through PATCH',
    /OutreachEngineState\.currentOutreachId = pre\.id/.test(OE));

  console.log('\n-- the draft endpoint is scoped to the signed-in agent --');
  const draftRoute = RT.slice(RT.indexOf("router.get('/draft'"), RT.indexOf("router.get('/runs/:runId'"));
  ok('agent_id is in the WHERE clause', /agent_id=\$1/.test(draftRoute));
  ok('and it only returns drafts', /status='draft'/.test(draftRoute));
  ok('404 when there is none', /status\(404\)/.test(draftRoute));

  console.log('\n-- the cache index cannot block a follow-up --');
  const ST = fs.readFileSync(REPO + 'server/store.js', 'utf8');
  ok('the unique index is PARTIAL on draft', /idx_outreach_logs_draft_key[\s\S]{0,200}WHERE status = 'draft'/.test(ST));
  ok('and ignores null brand keys', /brand_key IS NOT NULL/.test(ST));

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})();
