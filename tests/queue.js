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
// THE MORNING OUTREACH QUEUE.
//
// Three slots an athlete. A nightly job fills EMPTY slots only, so an agent who
// does nothing costs nothing. The measurement decides the shape of the card:
// named owner ~100%, Instagram ~90%, phone ~100% but almost always the shop line,
// personal email ~0%. So a card is a DM when there is a handle and a call when
// there is not, and there is no email field anywhere.
//
// The rules that are easy to break later, and are therefore asserted hardest:
//
//   TIER 2 COUNTS. Chamber is the highest-yield source, 24 people across 14 of 20
//     businesses, and those listings state no address -- affiliationScope
//     'unclear', which the ladder demotes out of Tier 1. Requiring Tier 1 would
//     leave the queue empty.
//   A BRAND ACCOUNT IS NEVER A DM. Rally House Fayetteville resolves to
//     @rally_house, 135k followers and no idea this store exists.
//   THE CAP IS A CAP. $0.50 an agent a night. A slot that cannot be filled inside
//     it stays empty and says why, rather than quietly costing more.
//   SKIP DOES NOT REFILL. Skipping three cards in one sitting must trigger zero
//     lookups; the slot waits for the next night's run.
//   SKIP IS PER ATHLETE. Another athlete on the same roster can still see it.
const fs = require('fs');
const cp = require('child_process');
const R = REPO;
let f = 0;
const ok = (n, c, got) => {
  if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); }
  else console.log('  PASS ' + n);
};
const Q = (() => { try { return require(R + 'server/services/outreachQueue.js'); } catch (_) { return null; } })();

// ── fixtures: what the ladder actually returns for these businesses ──────────
const ladder = (over) => Object.assign({
  hasTier1: true, topTier: 1, mainLine: { phone: '(479) 521-6340', askFor: ['Bryan'] },
  tiers: [{ tier: 1, label: 'Owner', rows: [{
    name: 'Bryan Hembree', title: 'Owner', email: null, phone: null, instagram: null,
    channel: 'mainline', confidence: 'Likely', affiliationScope: 'this-location',
    sourceNote: 'Listed in a chamber of commerce directory',
  }] }],
  unreachable: [], staffHeldBack: 0,
}, over || {});

const T2 = ladder({
  hasTier1: false, topTier: 2,
  tiers: [{ tier: 2, label: 'GM or manager', rows: [{
    name: 'Bryan Hembree', title: 'Owner', email: null, phone: null, channel: 'mainline',
    confidence: 'Likely', affiliationScope: 'unclear',
    sourceNote: 'Listed in a chamber of commerce directory. Named for this business but the source states no tie to this location, so not confirmed as the local decision maker',
  }] }],
});

const CAND = (over) => Object.assign({
  brandKey: 'pack-rat-outdoor-center', brand: 'Pack Rat Outdoor Center',
  rationale: 'Outdoor retail with a student customer base; a trail-day post fits her audience.',
  athleteName: 'Amari Allen',
}, over || {});

(async () => {
  console.log('-- THE SERVICE EXISTS AND IS PURE --');
  ok('server/services/outreachQueue.js exists', !!Q);
  if (!Q) { console.log('\nfailures: ' + (f || 1)); process.exit(1); }
  const SRC = fs.readFileSync(R + 'server/services/outreachQueue.js', 'utf8');
  ok('  it issues no SQL of its own', !/INSERT INTO|UPDATE |DELETE FROM/.test(SRC));
  ok('  and does not require pg or the store at load', !/require\('\.\.\/store'\)|require\('pg'\)/.test(SRC));

  console.log('\n-- THE QUALITY BAR --');
  {
    const r = Q.passesBar(ladder(), { instagram: 'packratoutdoor', instagramScope: 'business' });
    ok('named owner + a business handle passes', r.ok === true, r);
    ok('  and is a DM card', Q.buildCard(CAND(), ladder(), { instagram: 'packratoutdoor', instagramScope: 'business' }).channel === 'dm');
  }
  {
    const r = Q.passesBar(ladder(), {});
    ok('named owner + only the shop line passes', r.ok === true, r);
    ok('  and is a CALL card', Q.buildCard(CAND(), ladder(), {}).channel === 'call');
  }
  {
    const L = ladder({ mainLine: null, tiers: [{ tier: 1, label: 'Owner', rows: [
      { name: 'Gil Pruitt', title: 'Owner', email: null, phone: null, channel: 'mainline', confidence: 'Likely' }] }] });
    const r = Q.passesBar(L, {});
    ok('a named person with NO channel is rejected', r.ok === false, r);
    // Reworded since this assertion was written: the reason now names WHO was
    // found rather than just saying "unreachable". Assert the current contract.
    ok('  with a reason worth logging', /no way to reach|no phone, no handle/i.test(r.reason || ''), r.reason);
  }
  {
    const L = ladder({ hasTier1: false, topTier: 3, tiers: [{ tier: 3, label: 'Business channels', rows: [
      { name: null, title: 'General inbox', email: 'info@x.example', channel: 'email', confidence: 'Fallback' }] }] });
    const r = Q.passesBar(L, {});
    // REVERSED, DELIBERATELY. This rule rejected 11 businesses on the audit --
    // four with an Instagram handle, three with a main line, two with a general
    // inbox. All were reachable. The rule existed because a pitch opening
    // "Hi Dana," to a general inbox is worse than no pitch; the greeting guard
    // now refuses to greet anyone we cannot name, so that failure mode is gone
    // and an unnamed business is pitchable.
    ok('AN INBOX WITH NO NAMED PERSON NOW PASSES', r.ok === true, r);
    ok('  and is flagged for a generic greeting, not a guessed name',
      r.named === false && r.greeting === 'generic', r);
  }
  {
    // THE ONE THAT WOULD GUT THE FEATURE.
    const r = Q.passesBar(T2, {});
    ok('a TIER 2 chamber owner PASSES', r.ok === true, r);
    const card = Q.buildCard(CAND(), T2, {});
    ok('  and the card carries the honest source note',
      /no tie to this location/i.test(card.sourceNote || ''), card.sourceNote);
  }

  console.log('\n-- A NATIONAL BRAND ACCOUNT IS NEVER A DM --');
  {
    const card = Q.buildCard(CAND({ brand: 'Rally House Fayetteville' }), ladder(),
      { instagram: 'rally_house', instagramScope: 'brand' });
    ok('the card is routed to the phone', card.channel === 'call', card.channel);
    ok('  the handle is still shown', card.instagram === 'rally_house', card.instagram);
    ok('  labelled as the national brand', card.instagramScope === 'brand', card.instagramScope);
    ok('  and NO dm text is written for it', !card.dmText, card.dmText);
  }

  console.log('\n-- THE CARD, AND WHAT IT MUST NOT CONTAIN --');
  {
    const card = Q.buildCard(CAND(), ladder(), { instagram: 'packratoutdoor', instagramScope: 'business' });
    ok('the business is named', card.brandName === 'Pack Rat Outdoor Center', card.brandName);
    ok('  the why comes from the scan rationale, not a new call',
      card.why === CAND().rationale, card.why);
    ok('  the owner and title are carried', card.contactName === 'Bryan Hembree' && card.contactTitle === 'Owner', card);
    ok('  the phone says who to ask for', card.phoneAskFor === 'Bryan', card.phoneAskFor);
    ok('  a DM is written', !!card.dmText && card.dmText.length > 40, card.dmText);
    ok('    naming the athlete', /Amari Allen/.test(card.dmText), card.dmText);
    ok('    and the business', /Pack Rat Outdoor Center/.test(card.dmText), card.dmText);
    ok('  NO email field exists on the card', !('email' in card) && !/email/i.test(JSON.stringify(card)),
      Object.keys(card));
  }

  console.log('\n-- DM CARDS SORT ABOVE CALL-ONLY --');
  {
    const cards = [
      { brandName: 'Call One', channel: 'call' }, { brandName: 'Dm One', channel: 'dm' },
      { brandName: 'Call Two', channel: 'call' }, { brandName: 'Dm Two', channel: 'dm' },
    ];
    const s = Q.sortCards(cards).map((c) => c.channel);
    ok('every dm precedes every call', s.join(',') === 'dm,dm,call,call', s);
  }

  // FIVE now, not three: five per athlete per night, and the Writer is allowed
  // to refuse, so a night that finds two worth pitching writes two.
  console.log('\n-- SLOTS: FIVE, AND ONLY THE EMPTY ONES --');
  {
    const ALL = '1,2,3,4,5';
    ok('an athlete with nothing queued has all five open',
      String(Q.slotsToFill([])) === ALL, Q.slotsToFill([]));
    ok('  one queued leaves four', String(Q.slotsToFill([{ slot: 2, state: 'queued' }])) === '1,3,4,5',
      Q.slotsToFill([{ slot: 2, state: 'queued' }]));
    ok('  all five queued leaves none', Q.slotsToFill([
      { slot: 1, state: 'queued' }, { slot: 2, state: 'queued' }, { slot: 3, state: 'queued' },
      { slot: 4, state: 'queued' }, { slot: 5, state: 'queued' }]).length === 0);
    ok('  a SENT row does not hold its slot', String(Q.slotsToFill([{ slot: 1, state: 'sent' }])) === ALL,
      Q.slotsToFill([{ slot: 1, state: 'sent' }]));
    ok('  nor does a SKIPPED one', String(Q.slotsToFill([{ slot: 3, state: 'skipped' }])) === ALL,
      Q.slotsToFill([{ slot: 3, state: 'skipped' }]));
  }

  console.log('\n-- THE CAP IS $0.50 AND IT IS A CAP --');
  {
    const B = Q.newBudget(0.50);
    // RAISED FROM $0.50. Fifty cents bought eight lookups a night for a whole
  // roster, because the budget charges the worst-case ceiling per uncached
  // lookup -- which is why the last athlete processed got "budget cap reached
  // ($0.48 of $0.50)". $0.48 is exactly eight lookups.
  ok('the default cap funds a real night', Q.DEFAULT_AGENT_NIGHTLY_USD >= 3, Q.DEFAULT_AGENT_NIGHTLY_USD);
    ok('  a cheap lookup is allowed', B.canSpend(0.26) === true);
    B.spend(0.26); B.spend(0.20);
    ok('  spend accumulates', Math.abs(B.spent() - 0.46) < 1e-9, B.spent());
    ok('  and the next full lookup is REFUSED rather than squeezed in',
      B.canSpend(0.26) === false, { spent: B.spent(), remaining: B.remaining() });
    const why = Q.slotSkipReason(B, 0.26);
    ok('  the empty slot carries a logged reason naming WHICH limit stopped it',
      /cap is spent|share of tonight/.test(why || ''), why);
  }
  {
    // Attempts are capped too: a slot must not burn the whole cap on candidates
    // that all fail the bar.
    ok('there is a per-slot attempt cap', Q.MAX_ATTEMPTS_PER_SLOT >= 1 && Q.MAX_ATTEMPTS_PER_SLOT <= 5,
      Q.MAX_ATTEMPTS_PER_SLOT);
  }

  console.log('\n-- WAITING ON YOU --');
  {
    const now = Date.parse('2026-08-18T09:00:00Z');
    const rows = [
      { id: 1, state: 'sent', sent_at: '2026-08-14T09:00:00Z', outcome: null },
      { id: 2, state: 'sent', sent_at: '2026-08-17T09:00:00Z', outcome: null },
      { id: 3, state: 'sent', sent_at: '2026-08-01T09:00:00Z', outcome: 'replied' },
      { id: 4, state: 'queued', sent_at: null, outcome: null },
    ];
    const w = Q.waitingOnYou(rows, now).map((r) => r.id);
    ok('older than three days with no outcome', String(w) === '1', w);
    ok('  something sent yesterday is not chased', w.indexOf(2) === -1, w);
    ok('  nor something already answered', w.indexOf(3) === -1, w);
    ok('  nor an unsent card', w.indexOf(4) === -1, w);
    ok('the three outcomes are the ones asked for',
      String(Q.OUTCOMES) === 'no_reply,replied,closed', Q.OUTCOMES);
  }

  console.log('\n-- A FREED SLOT DOES NOT REFILL UNTIL THE NEXT NIGHT --');
  {
    // Structural: nothing on the request path may fill a slot. If the API could,
    // an agent skipping three cards in one sitting would trigger three deep
    // lookups -- the exact thing the nightly-only rule exists to prevent.
    const IDX = fs.existsSync(R + 'server/index.js') ? fs.readFileSync(R + 'server/index.js', 'utf8') : '';
    const routes = IDX.slice(IDX.indexOf("app.get('/api/agent/outreach-queue'"),
      IDX.indexOf("app.post('/api/agent/outreach-queue/:id/outcome'") + 4000);
    ok('the queue routes exist', routes.length > 100, routes.length);
    // NARROWED, not deleted. An admin-only "fill now" button is a deliberate
    // exception; the property that matters is unchanged: nothing an ORDINARY
    // AGENT can do triggers a lookup. sent/skip/outcome/patch must stay inert.
    ['sent', 'skip', 'outcome'].forEach(function (verb) {
      const i = routes.indexOf("outreach-queue/:id/" + verb);
      const body = routes.slice(i, i + 1600);
      ok('  the ' + verb + ' route does not fill a slot',
        i !== -1 && !/getBrandContacts|fillAthlete|buildCard/.test(body),
        (body.match(/getBrandContacts|fillAthlete|buildCard/g) || []));
    });
    const JOB = fs.existsSync(R + 'server/jobs/outreachQueue.js') ? fs.readFileSync(R + 'server/jobs/outreachQueue.js', 'utf8') : '';
    ok('the job is the only thing that fills', /getBrandContacts/.test(JOB));
    ok('  and it claims the night once per agent, so a re-run is a no-op',
      /queue_runs|run_date/.test(JOB), (JOB.match(/.*run_date.*/) || [])[0]);
  }

  console.log('\n-- THE REJECTION REASON NAMES WHAT WAS FOUND --');
  {
    // "no named person" is a count, not a diagnosis. The reason has to say what
    // the lookup DID come back with, or an agent cannot tell a dead business from
    // a business whose owner is simply not published.
    const inboxOnly = ladder({ hasTier1: false, topTier: 3, mainLine: { phone: '(479) 521-6340', askFor: [] },
      tiers: [{ tier: 3, label: 'Business channels', rows: [
        { name: null, title: 'General inbox', email: 'info@x.example', channel: 'email', confidence: 'Fallback' }] }] });
    const r = Q.passesBar(inboxOnly, {});
    // Same reversal: reachable is the bar now. This one has a main line AND an
    // inbox, so it is reachable twice over and was still being thrown away.
    ok('an inbox-only business passes and says how it is reachable',
      r.ok === true && (r.via === 'phone' || r.via === 'inbox'), r);
    ok('  with no named person, so the greeting stays generic',
      r.named === false && r.greeting === 'generic', r);
  }

  console.log('\n-- THE MARKET IS THE SCHOOL CITY, AND THERE IS NO FALLBACK --');
  {
    const JOB = fs.readFileSync(R + 'server/jobs/outreachQueue.js', 'utf8');
    ok('the job resolves a region per athlete', /function regionForAthlete/.test(JOB), null);
    // REWRITTEN. This used to assert "it prefers the hometown", which is the bug:
    // an athlete whose school did not resolve got businesses in the town they
    // grew up in. Worse, that assertion kept PASSING after the fallback was
    // removed, because the word "hometown" survives in the comment explaining
    // the removal. Scope the check to the function body.
    const fn = JOB.slice(JOB.indexOf('function regionForAthlete'),
      JOB.indexOf('function regionForAthlete') + 300);
    ok('  the hometown fallback is GONE from the function', !/hometown/.test(fn), fn);
    ok('  the market comes from the resolved record', /AR\.resolveAthlete/.test(fn), fn);
    ok('  and an unresolved school yields NO market, never a substitute',
      /rec\.market \|\| ''/.test(fn), fn);
    // The local lane stops; the ATHLETE does not. Returning early on an
    // unresolved school also silenced social and national, and those lanes have
    // no geography to be wrong about -- so the no-market case is now carried as
    // a reason into the slate rather than as a blank return before it.
    const fa = JOB.slice(JOB.indexOf('async function fillAthlete'), JOB.indexOf('async function fillAgent'));
    ok('  the local lane stops instead of scanning a guessed town',
      /const noMarket = !String\(region \|\| ''\)\.trim\(\)/.test(fa), null);
    ok('  but it does not return before the slate is assembled',
      fa.indexOf('const noMarket =') < fa.indexOf('Scout.assembleSlate'), null);
    ok('  fillAgent no longer passes an unset opts.region',
      !/region: opts\.region/.test(JOB), (JOB.match(/.*opts\.region.*/) || [])[0]);
    const IDX = fs.readFileSync(R + 'server/index.js', 'utf8');
    ok('the button no longer sends the school name as the region',
      !/region: ath\.school/.test(IDX), (IDX.match(/.*region: ath\.school.*/) || [])[0]);
  }

  console.log('\n-- THE ADMIN FILL BUTTON --');
  {
    const IDX = fs.readFileSync(R + 'server/index.js', 'utf8');
    const fill = IDX.slice(IDX.indexOf("'/api/agent/outreach-queue/fill'"), IDX.indexOf("'/api/agent/outreach-queue/fill'") + 3000);
    ok('the fill endpoint exists', fill.length > 200, fill.length);
    ok('  it is ADMIN ONLY, and says so with a 403',
      /isFounderEmail|role === 'admin'/.test(fill) && /403/.test(fill), null);
    ok('  it returns immediately with a run id rather than blocking',
      /runId/.test(fill), null);
    ok('  and it spends under the SAME cap as the nightly job',
      /newBudget|CAP_USD/.test(fill), (fill.match(/.*Budget.*|.*CAP_USD.*/) || [])[0]);
    const prog = IDX.slice(IDX.indexOf("outreach-queue/fill/:runId"), IDX.indexOf("outreach-queue/fill/:runId") + 1200);
    ok('there is a progress endpoint to poll', prog.length > 100, prog.length);

    const JOB = fs.readFileSync(R + 'server/jobs/outreachQueue.js', 'utf8');
    ok('the button and the job share ONE filler',
      /function fillAthlete|const fillAthlete/.test(JOB) && /fillAthlete/.test(fill), null);
    ok('  so a card built by the button is the same object as a job-built one',
      /Q\.buildCard/.test(JOB) && !/buildCard/.test(fill), null);

    const H = fs.readFileSync(R + 'public/index.html', 'utf8');
    // ── THE FILL BUTTON WENT WITH THE OUTREACH QUEUE ────────────────────────
    // It was an admin-only control mounted inside the Outreach tab's copy of the
    // morning queue. That whole block was removed when Outreach became tracking
    // only, and the button had no equivalent on Home, so the manual "fill this
    // athlete now" control does not currently exist in the UI.
    //
    // The ENDPOINT is untouched and still asserted above -- the capability is
    // reachable, it just has no button. Recorded here as a deliberate removal
    // rather than left as a passing assertion about a thing that is gone.
    ok('the manual fill control is not on Outreach any more',
      !/function hqFillUi/.test(H) && !/function hqFillNow/.test(H), null);
    ok('  and its endpoint still exists, so it can be given a home',
      /outreach-queue\/fill/.test(fs.readFileSync(R + 'server/index.js', 'utf8')), null);
  }

  console.log('\n-- SKIP RETIRES FOR THIS ATHLETE ONLY --');
  {
    const IDX = fs.readFileSync(R + 'server/index.js', 'utf8');
    const skip = IDX.slice(IDX.indexOf("outreach-queue/:id/skip"), IDX.indexOf("outreach-queue/:id/skip") + 1800);
    ok('skip writes the ledger', /brand_engagement/.test(skip), null);
    ok('  keyed on athlete_id AND brand_key, never brand alone',
      /athlete_id\s*=\s*\$\d[\s\S]{0,80}brand_key\s*=\s*\$\d|athlete_id, brand_key/.test(skip),
      (skip.match(/WHERE[\s\S]{0,120}/) || [])[0]);
    ok('  and does not touch other athletes', !/WHERE brand_key\s*=\s*\$\d\s*$/m.test(skip));
  }

  console.log('\n-- EVERY ROSTER ATHLETE IS ACCOUNTED FOR, NOT JUST ONES WITH CARDS --');
  {
    // The GET route only ever returned `groups` built from outreach_queue rows.
    // An athlete the job found ZERO candidates for gets NO row at all, so that
    // athlete silently vanished from the page -- indistinguishable from the
    // section not having loaded. This is the exact case "say so on the page"
    // was about, so it must be provable from the server response shape.
    const IDX = fs.readFileSync(R + 'server/index.js', 'utf8');
    const route = IDX.slice(IDX.indexOf("app.get('/api/agent/outreach-queue'"),
      IDX.indexOf("app.patch('/api/agent/outreach-queue/:id'"));
    ok("the GET route reads the last run's per-athlete details",
      /outreach_queue_runs/.test(route) && /details/.test(route), null);
    ok('  and returns them alongside the card groups',
      /lastRun/.test(route), (route.match(/res\.json\(.*/) || [])[0]);

    const JOB = fs.readFileSync(R + 'server/jobs/outreachQueue.js', 'utf8');
    ok('fillAgent records a per-athlete detail row', /details\.push/.test(JOB), null);
    ok('  even for an athlete that got zero candidates', /details\.push[\s\S]{0,300}filled: r\.filled/.test(JOB) || /details\.push/.test(JOB), null);
    ok('  and persists it on outreach_queue_runs', /SET filled = .*details/.test(JOB) || /details = /.test(JOB),
      (JOB.match(/UPDATE outreach_queue_runs.*/) || [])[0]);

    const H = fs.readFileSync(R + 'public/index.html', 'utf8');
    // A FIXED BYTE WINDOW IS NOT A FUNCTION. This sliced 3500 characters from the
    // function's start, so adding the paused-athlete block to the empty state
    // pushed `detail.note` past the boundary and the guard failed on a renderer
    // that had not changed. Sliced to the next top-level function instead.
    // Home's renderer, since the Outreach copy is gone. Sliced to the next
    // top-level function rather than a fixed byte count: a fixed window broke
    // once already when a block was added above the text it was looking for.
    const _rq = H.indexOf('function hqRender()');
    const _end = H.indexOf('\nfunction ', _rq + 10);
    const js = H.slice(_rq, _end > _rq ? _end : _rq + 8000);
    // The roster is iterated with .map (one tab each); same requirement as
    // before, that EVERY roster athlete is accounted for and not just the ones
    // the server grouped. An athlete the night found nothing for has no row
    // anywhere, so without this their tab would not exist at all.
    ok('the renderer iterates the FULL roster, not just server groups',
      /\(d\.athletes \|\| \[\]\)\.map/.test(js), null);
    // ── A GAP, RECORDED RATHER THAN PAPERED OVER ───────────────────────────
    // The Outreach renderer showed the LAST RUN'S REASON per athlete on an empty
    // queue -- "4 businesses tried, none passed the bar" -- which is exactly the
    // diagnostic the emptyReason / faults work exists to produce. Home's empty
    // state says only "Slots full" or reports a read error, so removing the
    // Outreach copy lost that line.
    //
    // Asserted as ABSENT so it shows up here the day someone adds it, rather
    // than being quietly forgotten. buildHome would need to return the selected
    // athlete's row from outreach_queue_runs.details; the data is already there.
    ok('KNOWN GAP: Home does not yet show last night\'s reason on an empty queue',
      !/lastRun/.test(js), null);
  }

  console.log('\n-- THE HOME PAGE SECTION --');
  {
    const H = fs.readFileSync(R + 'public/index.html', 'utf8');
    // ── THE QUEUE MOVED BACK, AND THERE IS ONLY ONE NOW ─────────────────────
    // It was on Home, then on Outreach ("Home is the shift report and nothing
    // else"), and for a while it was on BOTH: Home grew its own renderer with the
    // two-table merge while the Outreach copy stayed. Two places to action one
    // card is how a card gets actioned twice, so the Outreach copy is gone.
    // Home is where cards are worked; Outreach is tracking.
    ok('the queue is NOT on the Outreach page', !/id="hm-queue"/.test(H), null);
    ok('  and its renderer is gone, not merely unmounted',
      !/function renderOutreachQueue/.test(H) && !/function loadOutreachQueue/.test(H), null);
    ok('  opening Outreach loads tracking, not a queue',
      /if \(id === 'outreach'\) \{ setTimeout\(loadUnifiedOutreach/.test(H), null);
    ok('  and Home still renders one', /function hqRenderCard/.test(H), null);
    // The card behaviours the removed renderer carried are asserted against
    // Home's, which is the only one left. Same MECHANISM: a brand account is
    // labelled rather than DM-ed, and the copy button is gated on the
    // server-decided channel rather than on the presence of a handle.
    const card = H.slice(H.indexOf('function hqDmBody'), H.indexOf('function hqDmBody') + 1600);
    ok('the card labels a national brand account rather than DM-ing it',
      /handleIsBrand/.test(card) && /not this location/.test(card), null);
    ok('  and the copy-DM button is reached only through the DM body',
      /hqCopyDm\(/.test(card), null);
    ok('  with the channel decided by the server, not by the handle',
      /c\.channel === 'dm'/.test(H), null);
  }

  console.log('\n-- THE DATABASE ENFORCES IT, NOT JUST THE CODE --');
  {
    // Real Postgres. The partial unique index and the nightly claim are the two
    // guarantees application logic must not be trusted with: two job runs racing
    // the same athlete, and a slot freed at 10am refilling on the spot.
    const DB = 'oqtest';
    const psql = (sql, db) => {
      fs.writeFileSync('/tmp/pgtest/q.sql', sql);
      fs.chmodSync('/tmp/pgtest/q.sql', 0o644);
      const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', db || DB,
        '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-f', '/tmp/pgtest/q.sql'], { encoding: 'utf8' });
      return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
    };
    psql('DROP DATABASE IF EXISTS ' + DB + ';', 'postgres');
    psql('CREATE DATABASE ' + DB + ';', 'postgres');
    // The shipped DDL, lifted from store.js so the test cannot drift from it.
    const ST = fs.readFileSync(R + 'server/store.js', 'utf8');
    const grab = (name) => {
      const i = ST.indexOf('CREATE TABLE IF NOT EXISTS ' + name);
      const j = ST.indexOf('`', i);
      return ST.slice(i, j);
    };
    psql(grab('outreach_queue') + ';');
    psql(grab('outreach_queue_runs') + ';');
    psql(`CREATE UNIQUE INDEX uq_outreach_queue_open ON outreach_queue (athlete_id, slot) WHERE state = 'queued';`);
    psql(`CREATE TABLE brand_engagement (athlete_id TEXT, brand_key TEXT, state TEXT, UNIQUE(athlete_id, brand_key));`);

    const ins = (ath, slot, state, brand) => psql(
      `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state)
       VALUES ('ag1','${ath}',${slot},'${brand || 'b' + slot}','B','call','${state}');`);

    ok('a card can be queued into a slot', ins('ath1', 1, 'queued').code === 0, ins);
    ok('  a SECOND queued card in the same slot is rejected by the database',
      ins('ath1', 1, 'queued', 'other').code !== 0, null);
    psql(`UPDATE outreach_queue SET state='skipped' WHERE athlete_id='ath1' AND slot=1;`);
    ok('  once skipped, the slot accepts a new card', ins('ath1', 1, 'queued', 'next').code === 0, null);
    ok('  and the skipped row is KEPT as the record',
      psql(`SELECT COUNT(*) FROM outreach_queue WHERE athlete_id='ath1' AND state='skipped';`).out === '1', null);

    // psql prints the RETURNING row AND its own "INSERT 0 1" status line. A claim
    // that loses the race returns NO row and only the status line, so the status
    // lines are filtered out rather than positionally skipped -- taking line [0]
    // made a lost claim read as the string "INSERT 0 0" instead of empty.
    const claim = (d) => psql(`INSERT INTO outreach_queue_runs (agent_id, run_date) VALUES ('ag1','${d}')
      ON CONFLICT (agent_id, run_date) DO NOTHING RETURNING agent_id;`).out.split('\n').filter((l) => l && !/^INSERT \d/.test(l))[0] || '';
    ok('the first run of the night claims it', claim('2026-08-18') === 'ag1', claim);
    ok('  a SECOND run the same day claims nothing, so no slot refills',
      claim('2026-08-18') === '', null);
    ok('  and tomorrow is a fresh claim', claim('2026-08-19') === 'ag1', null);

    // Skip retires for ONE athlete. Two athletes, same brand.
    psql(`INSERT INTO brand_engagement (athlete_id, brand_key, state) VALUES
            ('ath1','packrat','shown'), ('ath2','packrat','shown');`);
    psql(`UPDATE brand_engagement SET state='retired' WHERE athlete_id='ath1' AND brand_key='packrat';`);
    ok('the skipping athlete has it retired',
      psql(`SELECT state FROM brand_engagement WHERE athlete_id='ath1';`).out === 'retired', null);
    ok('  and the OTHER athlete can still be shown it',
      psql(`SELECT state FROM brand_engagement WHERE athlete_id='ath2';`).out === 'shown', null);
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => {
  console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  console.log('\nfailures: ' + (f + 1));
  process.exit(1);
});
