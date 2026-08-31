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
// The Writer. The model is stubbed, so this tests the parts that must hold
// whatever the model returns: the voice rules are ENFORCED not merely requested,
// a refusal is honoured, the category changes the ask, both sides actually reach
// the prompt, and the learning loop stays quiet until it has evidence.
const ROOT = REPO;
const W = require(ROOT + 'server/services/pitchWriter.js');
const Q = require(ROOT + 'server/services/outreachQueue.js');
const store = require(ROOT + 'server/store.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

// DATED. A follower count with no recorded date is no longer handed to the model
// at all -- it cannot be quoted honestly, and offering it while forbidding its use
// is how a good pitch gets refused to save a number. This athlete has been through
// onboarding, which is the state the roster reaches once athletes enter their own
// numbers; the undated case is asserted separately below.
const ATHLETE = {
  name: 'Jeremiah Wilkinson', sport: 'Football', position: 'Linebacker', year: 'Junior',
  school: 'Auburn', hometown: 'Opelika, AL', instagram: 32000, tiktok: 3000,
  reachSource: 'athlete', reachAsOf: '2026-08-14',
  stats: '78 tackles, 6 sacks last season', tags: ['training', 'local food'],
};
const BIZ = {
  name: 'Iron Tribe Fitness', category: 'gym', address: '412 University Dr, Auburn, AL',
  rating: 4.8, userRatingCount: 312, ownerName: 'Dana Kessler', ownerTitle: 'Owner',
};
const GOOD = 'Saw you have been on University Drive for nine years and still hold 4.8 stars. '
  + 'I work with Jeremiah Wilkinson, a junior linebacker at Auburn who grew up in Opelika and has '
  + '35,000 followers as of 14 Aug 2026, nearly all of them local. Two feed posts of a training session at your gym '
  + 'with a signup code, so you can count what it brings in. '
  + 'If that is not a fit just say so.\n\nJohnMark';

// A stub that returns whatever the test hands it, and records the prompts.
function stub(seq) {
  const calls = [];
  let i = 0;
  const fn = async (prompt, system, maxTokens, model) => {
    calls.push({ prompt, system, maxTokens, model });
    const v = seq[Math.min(i++, seq.length - 1)];
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  await new Promise((r) => setTimeout(r, 2000));

  // ── THE VOICE RULES ARE ENFORCED, NOT REQUESTED ─────────────────────────
  const L = (m) => W.lintMessage(m, { signOff: 'JohnMark' });
  ok('the shipped template FAILS its own rules', !L(
    'Hi! I work on the NIL side with Jeremiah Wilkinson, a college athlete here in your area. '
    + 'I had an idea for a partnership with Wellness Professionals, Inc. '
    + "Would love to send over a short overview if you're open to it!").ok);
  ok('a good message passes', L(GOOD).ok, L(GOOD).problems);

  const cases = [
    ['em dash', 'One. Two words here — and more. Three 5 words.\n\nJohnMark', /em or en dash/],
    ['exclamation', 'One thing here. Two things here! Three 5 things.\n\nJohnMark', /exclamation/],
    ['hope this finds you', 'I hope this finds you well. Second one here. Third 5 here.\n\nJohnMark', /banned phrase/],
    ['greeting THEN banned opener', 'Hi Dana, I hope this finds you well. Second here. Third 5 here.\n\nJohnMark', /banned phrase/],
    ['wanted to reach out', 'I wanted to reach out today. Second here. Third 5 here.\n\nJohnMark', /banned phrase/],
    ['leverage', 'We can leverage this. Second here. Third 5 here.\n\nJohnMark', /corporate filler/],
    ['seamless', 'It is seamless work. Second here. Third 5 here.\n\nJohnMark', /corporate filler/],
    ['circle back', 'Let me circle back. Second here. Third 5 here.\n\nJohnMark', /corporate filler/],
    ['six sentences', 'One here. Two here. Three here. Four here. Five 5 here. Six here.\n\nJohnMark', /maximum is five/],
    ['two sentences', 'One thing here. Two 5 things here.\n\nJohnMark', /minimum is three/],
    // The rule loosened: naming what the athlete would DO is enough, in any
    // shape, so the fixture has to be genuinely vague rather than merely
    // unquantified. This one names no action at all, which is the case the
    // check exists for.
    ['never says what the athlete would do',
      'One thing here. Two things here. Three things here.\n\nJohnMark',
      /never says what the athlete would actually do/],
    ['a dollar amount', 'One here. Two posts for $500. Third here.\n\nJohnMark', /names a price/],
    ['a spelled-out amount', 'One here. Two posts for 500 dollars. Third here.\n\nJohnMark', /names a price/],
    ['a rate', 'One here. Our rate covers two posts. Third here.\n\nJohnMark', /names a price/],
    ['a budget question', 'One here. What is your budget for two posts. Third here.\n\nJohnMark', /names a price/],
    ['a k-suffixed amount', 'One here. Two posts at 2k. Third here.\n\nJohnMark', /names a price/],
    ['wrong sign off', 'One here. Two here. Three 5 here.\n\nSteve', /sign off as JohnMark/],
  ];
  for (const [name, msg, re] of cases) {
    const r = L(msg);
    ok(`rejects: ${name}`, !r.ok && r.problems.some((p) => re.test(p)), r.problems);
  }
  ok('contractions are allowed', L("It's a fit. You'd get two posts and an appearance. He's local.\n\nJohnMark").ok);

  // ── MONEY NEVER APPEARS, COUNTS STILL DO ────────────────────────────────
  ok('a follower count is NOT a price', W.containsPrice('35,000 followers') === null);
  ok('  nor is a deliverable count', W.containsPrice('two feed posts') === null);
  ok('  nor a star rating', W.containsPrice('a 4.8 star rating') === null);
  ok('  nor a review count', W.containsPrice('312 reviews') === null);
  ok('a dollar figure IS a price', W.containsPrice('$500') !== null);
  ok('  as is "500 dollars"', W.containsPrice('500 dollars') !== null);
  ok('  and "2k"', W.containsPrice('two posts at 2k') !== null);
  ok('the clean message names a deliverable without a price',
    L(GOOD).ok && W.containsPrice(GOOD) === null, L(GOOD).problems);
  ok('  and it does name what gets made', /Two feed posts/.test(GOOD));

  // autoRepair only touches what cannot change meaning.
  ok('autoRepair turns an em dash into a comma', /,/.test(W.autoRepair('a — b')) && !/—/.test(W.autoRepair('a — b')));
  ok('  and strips exclamation marks', !/!/.test(W.autoRepair('Great!')));
  ok('  but does NOT rewrite sentences', W.autoRepair('One. Two. Three.') === 'One. Two. Three.');

  // ── THE CATEGORY CHANGES THE ASK ────────────────────────────────────────
  ok('a restaurant wants foot traffic', W.playbookFor('italian_restaurant').key === 'foot-traffic');
  ok('a dealership wants a face for 18-24', W.playbookFor('car_dealer').key === 'face-of-brand');
  ok('  and says so in the prompt', /18-24/.test(W.buildPrompt({ business: { category: 'car_dealer' } })));
  ok('a gym wants signups', W.playbookFor('gym').key === 'signups');
  ok('  asking for something trackable', /trackable code/.test(W.buildPrompt({ business: { category: 'gym' } })));
  ok('a retailer wants the product worn', W.playbookFor('clothing_store').key === 'product-worn');
  ok('an unknown category still gets an ask', W.DEFAULT_PLAY.ask.length > 10);
  const gymP = W.buildPrompt({ business: { category: 'gym' } });
  const carP = W.buildPrompt({ business: { category: 'car_dealer' } });
  ok('the same athlete gets a DIFFERENT ask by category', gymP !== carP);

  // ── BOTH SIDES REACH THE PROMPT ─────────────────────────────────────────
  const p = W.buildPrompt({ business: BIZ, athlete: ATHLETE, agentFirstName: 'JohnMark',
    deal: { valueLow: 400, valueHigh: 800, reasoning: 'Local gym, athlete trains nearby',
      campaignIdeas: ['Training session takeover'] } });
  for (const [what, needle] of [
    ['the business name', 'Iron Tribe Fitness'], ['the rating and review count', '4.8 stars from 312 reviews'],
    ['the owner by name and title', 'Dana Kessler, Owner'], ['the address', 'University Dr'],
    ['the sport and position', 'Junior Linebacker Football'], ['the school', 'Auburn'],
    ['the hometown', 'Opelika'], ['the real follower count', '32,000 on Instagram'],
    ['the combined reach', '35,000 combined'], ['what they post about', 'training, local food'],
    ['the campaign idea already generated', 'Training session takeover'],
    ['the sign-off name', 'JohnMark'],
  ]) ok(`the prompt carries ${what}`, p.indexOf(needle) !== -1, needle);
  ok('THE VALUATION NEVER REACHES THE PROMPT', p.indexOf('400') === -1 && p.indexOf('800') === -1
    && !/Value already estimated/.test(p), (p.match(/.{0,60}(400|800).{0,40}/) || [])[0]);
  ok('  because a number in the context window ends up in the copy', !/\$\d/.test(p),
    (p.match(/\$\d[^\n]{0,40}/) || [])[0]);
  ok('the system prompt forbids naming a price', /NEVER put a dollar amount/.test(W.SYSTEM));
  ok('  and asks for the deliverable instead', /Name the DELIVERABLE, never the price/.test(W.SYSTEM));
  ok('  a 312-review business is called established', /well established locally/.test(p));
  ok('  and a 9-review one is flagged as new or small',
    /may be new or small/.test(W.buildPrompt({ business: { name: 'X', rating: 5, userRatingCount: 9 } })));
  ok('the angle comes BEFORE the message in the schema',
    p.indexOf('"angle"') < p.indexOf('"message"'), [p.indexOf('"angle"'), p.indexOf('"message"')]);
  ok('  and the ask comes before it too', p.indexOf('"ask"') < p.indexOf('"message"'));
  ok('the system prompt bans what the brief bans',
    /No em dashes/.test(W.SYSTEM) && /No exclamation marks/.test(W.SYSTEM)
    && /hope this finds you well/.test(W.SYSTEM) && /Use contractions/.test(W.SYSTEM));

  // ── IT WRITES ───────────────────────────────────────────────────────────
  let one = stub([{ angle: 'He trains two blocks away and his audience is local',
    angleKey: 'Local-Athlete-Trains-Here', ask: 'two feed posts and a signup code',
    confidence: 'strong', message: GOOD }]);
  let r = await W.writePitch({ business: BIZ, athlete: ATHLETE, agentFirstName: 'JohnMark' }, { oneShot: one });
  ok('it writes a pitch', r.skipped === false && r.message === GOOD, r);
  ok('  storing the angle beside it', /trains two blocks away/.test(r.angle), r.angle);
  ok('  slugified for grouping', r.angleKey === 'local-athlete-trains-here', r.angleKey);
  ok('  with the ask kept as a DELIVERABLE, not a price',
    /two feed posts/.test(r.ask) && W.containsPrice(r.ask) === null, r.ask);
  ok('  and the category playbook recorded', r.categoryKey === 'signups', r.categoryKey);
  ok('  in ONE model call', one.calls.length === 1, one.calls.length);

  // ── IT MAY REFUSE ───────────────────────────────────────────────────────
  const no = stub([{ skip: true, reason: 'A tyre shop has no route to a college linebacker audience' }]);
  r = await W.writePitch({ business: { name: 'Bob Tyres', category: 'car_repair' }, athlete: ATHLETE }, { oneShot: no });
  ok('it refuses when there is no real connection', r.skipped === true, r);
  ok('  giving the reason', /tyre shop/.test(r.reason), r.reason);
  ok('  and writes NO message', !r.message, r);

  // ── A MESSAGE THAT BREAKS VOICE IS RETRIED, THEN REFUSED ────────────────
  const bad = 'Hi! I wanted to reach out about leveraging a partnership for $500.';
  let two = stub([{ angle: 'a', angleKey: 'a', ask: 'a', message: bad },
    { angle: 'a', angleKey: 'a', ask: 'a', message: GOOD }]);
  r = await W.writePitch({ business: BIZ, athlete: ATHLETE, agentFirstName: 'JohnMark' }, { oneShot: two });
  ok('a voice violation is retried once', two.calls.length === 2, two.calls.length);
  ok('  the retry is TOLD what was wrong', /rejected for:/.test(two.calls[1].prompt), two.calls[1].prompt.slice(-200));
  ok('  naming the actual problems', /banned phrase|corporate filler/.test(two.calls[1].prompt));
  ok('  including the price violation', /names a price/.test(two.calls[1].prompt), two.calls[1].prompt.slice(-260));
  ok('  and the fixed version is used', r.skipped === false && r.message === GOOD, r);

  const never = stub([{ angle: 'a', angleKey: 'a', ask: 'a', message: bad }]);
  r = await W.writePitch({ business: BIZ, athlete: ATHLETE, agentFirstName: 'JohnMark' }, { oneShot: never });
  ok('twice out of voice is REFUSED, not shipped', r.skipped === true && r.lintFailed === true, r);
  ok('  saying why', /could not write it in voice/.test(r.reason), r.reason);
  ok('  and never returns the bad copy', !r.message, r);

  const junk = stub(['not json at all']);
  r = await W.writePitch({ business: BIZ, athlete: ATHLETE }, { oneShot: junk });
  ok('unparseable output is a skip, not a crash', r.skipped === true && r.error === true, r);

  // ── THE CARD CARRIES IT ─────────────────────────────────────────────────
  const ladder = { tiers: [{ tier: 1, rows: [{ name: 'Dana Kessler', title: 'Owner' }] }] };
  const ig = { instagram: 'irontribeauburn', instagramScope: 'location' };
  const card = Q.buildCard({ brandKey: 'k', brand: 'Iron Tribe', athleteName: 'Jeremiah Wilkinson',
    pitch: { message: GOOD, angle: 'trains nearby', angleKey: 'trains-nearby', ask: 'two posts and a code', categoryKey: 'signups' } },
    ladder, ig);
  ok('the card uses the WRITTEN pitch, not the template', card.dmText === GOOD, card.dmText);
  ok('  and carries the angle', card.angle === 'trains nearby' && card.angleKey === 'trains-nearby', card);
  ok('  the category', card.categoryKey === 'signups', card.categoryKey);
  ok('  and the ask', card.ask === 'two posts and a code', card.ask);
  ok('  with no price anywhere on the card', W.containsPrice(card.dmText) === null
    && W.containsPrice(card.ask) === null, [card.dmText, card.ask]);

  const fb = Q.buildCard({ brandKey: 'k', brand: 'Iron Tribe', athleteName: 'Jeremiah Wilkinson' }, ladder, ig);
  ok('with no pitch it falls back rather than shipping nothing', !!fb.dmText, fb.dmText);
  ok('  and the fallback has NO angle, so nothing mistakes it for reasoning',
    fb.angle === null && fb.angleKey === null, fb);
  ok('  the fallback no longer uses an exclamation mark', !/!/.test(fb.dmText), fb.dmText);
  ok('  nor "here in your area"', !/here in your area/.test(fb.dmText), fb.dmText);

  // ── FIVE PER ATHLETE, AND FIVE MEANS FIVE WORTH SENDING ─────────────────
  ok('the cap is five per athlete per night', Q.SLOTS_PER_ATHLETE === 5, Q.SLOTS_PER_ATHLETE);
  ok('  and fewer is allowed: slotsToFill returns only what is open',
    Q.slotsToFill([{ slot: 1, state: 'queued' }, { slot: 2, state: 'queued' }]).length === 3);

  // ── LEARNING FROM REPLIES ───────────────────────────────────────────────
  const P = store.pool;
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = 'w-agent'`).catch(() => {});
  const add = (angle, cat, sent, replied) => P.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state,
       angle_key, category_key, sent_at, replied_at)
     VALUES ('w-agent','w-ath',1,'k','B','dm','sent',$1,$2,$3,$4)`,
    [angle, cat, sent ? new Date() : null, replied ? new Date() : null]);

  for (let i = 0; i < 4; i++) await add('trains-nearby', 'signups', true, i < 2);
  let learned = await W.learnedAngles(P, 'signups');
  ok('BELOW the sample floor it returns nothing', learned.length === 0, learned);
  ok('  because weighting on four sends is superstition', W.MIN_SAMPLE >= 12, W.MIN_SAMPLE);

  for (let i = 0; i < 10; i++) await add('trains-nearby', 'signups', true, i < 5);
  for (let i = 0; i < 6; i++) await add('hometown-kid', 'signups', true, i < 1);
  learned = await W.learnedAngles(P, 'signups');
  ok('above the floor it reports what got replies', learned.length > 0, learned);
  ok('  best-replying angle first', learned[0].angle === 'trains-nearby', learned);
  ok('  carrying the real counts', learned[0].replied === 7 && learned[0].sent === 14, learned[0]);
  ok('  and an angle with zero replies is excluded',
    !learned.some((x) => x.replied === 0), learned);
  const other = await W.learnedAngles(P, 'foot-traffic');
  ok('  a different category learns separately', other.length === 0, other);

  const withLearned = W.buildPrompt({ business: BIZ, athlete: ATHLETE, learnedAngles: learned });
  ok('learned angles reach the prompt', /trains-nearby \(7\/14 replied\)/.test(withLearned), withLearned.slice(-400));
  ok('  labelled EVIDENCE, not instruction', /evidence, not instruction/.test(withLearned));

  await P.query(`DELETE FROM outreach_queue WHERE agent_id = 'w-agent'`).catch(() => {});

  // ══ NO INVENTED ATHLETE FACTS ═══════════════════════════════════════════
  // Enforced, not asked. Each class of claim is FOUND in the text and checked
  // against the stored record; a missing field makes any mention a violation.
  const AR = require(ROOT + 'server/services/athleteRecord.js');
  const look = (x) => (x === 'Arkansas' ? { city: 'Fayetteville', state: 'AR' } : null);
  const FULL = AR.resolveAthlete({ id: 'f', data: { name: 'Jeremiah Wilkinson', sport: 'Football',
    position: 'Linebacker', year: 'Junior', school: 'Arkansas', hometown: 'Opelika, AL',
    instagram: 32000, tiktok: 3000, reachSource: 'athlete', reachAsOf: '2026-08-14',
    stats: '78 tackles, 6 sacks last season' } }, { schoolLocation: look });
  const SPARSE = AR.resolveAthlete({ id: 's', data: { name: 'Jeremiah Wilkinson', school: 'Arkansas' } },
    { schoolLocation: look });
  const V = (m, a, o) => W.verifyAthleteFacts(m, a, o || {});

  ok('a record keeps present fields', FULL.position === 'Linebacker' && FULL.market === 'Fayetteville, AR', FULL.market);
  ok('  and marks absent ones null, never a default', SPARSE.position === null && SPARSE.hometown === null, SPARSE);
  ok('  listing what is missing', SPARSE.missing.includes('position') && SPARSE.missing.includes('hometown'), SPARSE.missing);
  ok('  an unresolvable school means NO market, not a guess',
    AR.resolveAthlete({ data: { name: 'X', school: 'Nowhere Tech' } }, { schoolLocation: look }).hasLocalMarket === false);
  ok('  a follower COUNT never becomes a handle',
    AR.resolveAthlete({ data: { instagram: 32000 } }, {}).instagramHandle === null);
  ok('  and a count of zero is null, not "no audience"',
    AR.resolveAthlete({ data: { instagram: 0 } }, {}).instagram === null);

  // Against a FULL record: true facts pass, altered ones are caught.
  const TRUE_FACTS = 'Jeremiah Wilkinson is a junior linebacker who plays football, grew up in '
    + 'Opelika, and had 35,000 followers as of 14 Aug 2026.';
  ok('true facts pass', V(TRUE_FACTS, FULL).ok, V(TRUE_FACTS, FULL).problems);
  // A DATED COUNT IS REQUIRED, not optional. The same sentence without the date
  // states a hand-entered figure to a business as if it were current.
  const UNDATED = 'Jeremiah Wilkinson is a junior linebacker and has 35,000 followers.';
  ok('  the same sentence WITHOUT the date is refused',
    !V(UNDATED, FULL).ok && V(UNDATED, FULL).problems.some((x) => /as if it were live/.test(x)),
    V(UNDATED, FULL).problems);
  // And when we hold no date at all, the number cannot be rescued by wording.
  const NO_DATE_ATHLETE = { ...FULL, reachSource: undefined, reachAsOf: undefined };
  ok('  an athlete with no recorded date cannot have their reach quoted at all',
    !V(UNDATED, NO_DATE_ATHLETE).ok, V(UNDATED, NO_DATE_ATHLETE).problems);
  // A connected account lifts it: the number is current by construction.
  ok('  a connected Instagram lifts the rule',
    V(UNDATED, { ...FULL, reachSource: 'instagram' }).ok,
    V(UNDATED, { ...FULL, reachSource: 'instagram' }).problems);
  const catches = [
    ['a wrong position', 'Jeremiah Wilkinson is a junior quarterback.', /stored position/],
    ['a wrong sport', 'Jeremiah Wilkinson plays basketball.', /stored sport/],
    ['a wrong class year', 'Jeremiah Wilkinson is a senior.', /stored year/],
    ['a wrong hometown', 'Jeremiah Wilkinson grew up in Montgomery and posts a lot.', /stored hometown/],
    ['inflated reach', 'Jeremiah Wilkinson has 120,000 followers.', /matches no stored follower count/],
    ['an invented stat', 'Jeremiah Wilkinson had 140 tackles.', /not in the stored stats/],
  ];
  for (const [what, msg, re] of catches) {
    const r2 = V(msg, FULL);
    ok(`catches ${what}`, !r2.ok && r2.problems.some((x) => re.test(x)), r2.problems);
  }
  ok('a real stat passes', V('Jeremiah Wilkinson had 78 tackles.', FULL).ok);
  ok('a business number is not an athlete claim',
    V('Jeremiah Wilkinson is a linebacker. You have 312 reviews.', FULL, { businessNumbers: [312] }).ok);

  // Against a SPARSE record: ANY mention of an absent field is invention.
  const absent = [
    ['a position we do not hold', 'Jeremiah Wilkinson is a linebacker.', /we hold none/],
    ['a sport we do not hold', 'Jeremiah Wilkinson plays football.', /we hold none/],
    ['a class year we do not hold', 'Jeremiah Wilkinson is a junior.', /no class year/],
    ['a hometown we do not hold', 'Jeremiah Wilkinson grew up in Opelika.', /no hometown/],
    ['a follower count we do not hold', 'Jeremiah Wilkinson has 35,000 followers.', /no follower counts/],
    ['a stat we do not hold', 'Jeremiah Wilkinson had 78 tackles.', /we hold no stats/],
  ];
  for (const [what, msg, re] of absent) {
    const r2 = V(msg, SPARSE);
    ok(`with a sparse record, refuses ${what}`, !r2.ok && r2.problems.some((x) => re.test(x)), r2.problems);
  }
  ok('  but copy that claims nothing extra passes',
    V('Jeremiah Wilkinson is an athlete at Arkansas and his audience is local.', SPARSE).ok,
    V('Jeremiah Wilkinson is an athlete at Arkansas and his audience is local.', SPARSE).problems);
  ok('  and never naming the athlete is itself a failure',
    !V('The athlete is well known locally.', FULL).ok);

  // END TO END: a fabricated fact takes the SAME retry-then-refuse path as a price.
  const CLEAN = 'Saw the gym on Dickson Street. Jeremiah Wilkinson is a junior linebacker at Arkansas '
    + 'with 35,000 followers as of 14 Aug 2026, nearly all local. Two feed posts of a training session with a signup code. '
    + 'Say no if it is off.\n\nJohnMark';
  const LIES = 'Saw the gym. Jeremiah Wilkinson is a senior quarterback from Montgomery with 200,000 followers. '
    + 'Two feed posts and a visit. Say no if it is off.\n\nJohnMark';
  let fab = stub([{ angle: 'a', angleKey: 'a', ask: 'two posts', message: LIES },
    { angle: 'a', angleKey: 'a', ask: 'two posts', message: CLEAN }]);
  let rr = await W.writePitch({ business: BIZ, athlete: FULL, agentFirstName: 'JohnMark' }, { oneShot: fab });
  ok('a fabricated fact is retried once', fab.calls.length === 2, fab.calls.length);
  ok('  the retry names the invented facts', /stored position|stored hometown|follower count/.test(fab.calls[1].prompt),
    fab.calls[1].prompt.slice(-300));
  ok('  and forbids filling gaps', /If a detail is not listed there, leave it out entirely/.test(fab.calls[1].prompt));
  ok('  the corrected version is used', rr.skipped === false && rr.message === CLEAN, rr);

  const liar = stub([{ angle: 'a', angleKey: 'a', ask: 'two posts', message: LIES }]);
  rr = await W.writePitch({ business: BIZ, athlete: FULL, agentFirstName: 'JohnMark' }, { oneShot: liar });
  ok('twice fabricating is REFUSED, not shipped', rr.skipped === true, rr);
  ok('  and the bad copy never comes back', !rr.message, rr);
  ok('the system prompt also states the rule', /NEVER invent a fact about the athlete/.test(W.SYSTEM));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
