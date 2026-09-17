'use strict';
// Runs from a checkout on any machine, offline.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/prolane.js          just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const fs = require('fs');

// ── THE PRO LANE: A PRO ATHLETE GETS PRO DISCOVERY, PRO CONTACTS AND A PRO
//    PITCH; A COLLEGE ATHLETE IS UNCHANGED ──────────────────────────────────

const PL = require(REPO + 'server/services/proLane.js');
const PW = require(REPO + 'server/services/pitchWriter.js');
const ONS = require(REPO + 'server/services/ownerNameSearch.js');
const CR = require(REPO + 'server/services/contactRank.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');

const PRO = { name: 'Marcus Hall', sport: 'Football', position: 'Linebacker', athleteType: 'pro', team: 'Denver Broncos', city: 'Denver, CO', hometown: 'Opelika, AL', school: 'Auburn University', year: 'Senior' };
const COL = { name: 'Jeremiah Wilkinson', sport: 'Football', position: 'Linebacker', athleteType: 'college', school: 'Auburn University', hometown: 'Opelika, AL', year: 'Junior' };

OUT.push('-- who is a pro --');
ok('isPro reads athleteType, either spelling', PL.isPro(PRO) && PL.isPro({ athlete_type: 'pro' }) && !PL.isPro(COL) && !PL.isPro({}) && !PL.isPro(null));

OUT.push('', '-- 1. discovery: budget businesses across the team\'s metro --');
ok('the pro taxonomy names the businesses with real budget', ['multi-location', 'dealer group', 'banks and credit unions', 'health systems', 'home services', 'wealth management', 'restaurant groups', 'retail chains', 'franchisees of national brands'].every((w) => PL.PRO_TAXONOMY.toLowerCase().includes(w)), PL.PRO_TAXONOMY);
ok('  and says to skip the single-location small business', /barber shops/.test(PL.PRO_SKIP) && /nail and hair salons/.test(PL.PRO_SKIP) && /independent cafes/.test(PL.PRO_SKIP) && /college athlete/.test(PL.PRO_SKIP));
ok('the market is the metro, not a campus radius', /Denver, CO metro area/.test(PL.proGeo('Denver', 'CO')) && /suburbs/.test(PL.proGeo('Denver', 'CO')) && !/campus/.test(PL.proGeo('Denver', 'CO')));
ok('  the first rule says so in the prompt', /PROFESSIONAL ATHLETE WITH A TEAM FOLLOWING/.test(PL.proFirstRule('Football', 'Linebacker')) && /Do not look for the gym down the street/.test(PL.proFirstRule('Football', 'Linebacker')));
ok('  the header asks for endorsement or appearance deals, not NIL', /endorsement or appearance deal with this professional athlete/.test(PL.proHeader()) && !/NIL/.test(PL.proHeader()));
const defs = PL.proSearchDefs(PL.proGeo('Denver', 'CO'));
ok('four web-search passes, every one a budget category, all across the metro', defs.length === 4 && defs.every((d) => /Denver, CO metro area/.test(d.q)) && /dealer groups/.test(defs[0].q) && /health systems/.test(defs[1].q) && /restaurant groups/.test(defs[2].q) && /insurance agencies/.test(defs[3].q));
ok('  none of them asks for a barber, a salon or a cafe', defs.every((d) => !/barber|salon|cafe|coffee|smoothie|tattoo|yoga/.test(d.q)));
ok('a single-location small business is dropped from a pro pool, by name, category or Places type',
  /barber/.test(PL.proSkipReason({ name: 'Mile High Barber Co' }) || '') && /nail/.test(PL.proSkipReason({ name: 'Polished', category: 'nail salon' }) || '') && /cafe/.test(PL.proSkipReason({ name: 'The Corner', types: ['cafe', 'food'] }) || '') && /coffee/.test(PL.proSkipReason({ name: 'Bean There', primaryType: 'coffee_shop' }) || ''),
  [PL.proSkipReason({ name: 'Mile High Barber Co' }), PL.proSkipReason({ name: 'The Corner', types: ['cafe', 'food'] })]);
ok('  a dealer group, a bank, a health system, a home services company and a franchisee are kept', ['Schomp Automotive Group', 'Bellco Credit Union', 'UCHealth', 'Applewood Plumbing Heating', 'Chick-fil-A Franchise Group', 'Mile High Roofing', 'Elway Dealerships'].every((n) => PL.proSkipReason({ name: n }) === null));
ok('  a chain word in the name keeps a business the small-type words would drop', PL.proSkipReason({ name: 'Floyd\'s Barbershop Holdings', types: ['barber_shop'] }) === null && PL.proSkipReason({ name: 'Great Clips Franchise Group' }) === null);
ok('the deal types a pro is scored on are appearance, signing, ambassador, commercial, hospitality', PL.PRO_DEAL_TYPES === 'appearance|signing|ambassador|commercial|hospitality');
ok('  and the first-deal range is a budget line', PL.PRO_VALUE.low >= 1000 && PL.PRO_VALUE.high >= 10000);
const ai = src('server/ai.js');
ok('getDealRecommendations reads the lane from the athlete and never from a flag', /const isProAth = PL\.isPro\(athlete\);/.test(ai));
ok('  the pro prompt: pro header, pro first rule, pro taxonomy and skip, team instead of school, metro market', /isProAth \? PL\.proHeader\(\)/.test(ai) && /isProAth \? PL\.proFirstRule\(sport, athlete\.position\)/.test(ai) && /PL\.PRO_TAXONOMY\}\\n\$\{PL\.PRO_SKIP\}/.test(ai) && /isProAth \? \(proTeam \|\| 'professional'\) : school/.test(ai) && /isProAth \? `MARKET: \$\{PL\.proGeo\(city, state\)\}/.test(ai));
ok('  the pro web-search passes replace the college category passes', /else if \(schoolWillSearch && isProAth\) \{[\s\S]*?PL\.proSearchDefs\(/.test(ai));
ok('  the Places small-business pool is not built for a pro', /_placesEligible = _placesEnabled && schoolWillSearch && !deepen && locationKnown && !_isManual && !isProAth;/.test(ai));
ok('  a pro pool has its own cache key, never the college pool for the same city', /schoolCacheKey = `\$\{normMarket\(schoolMarket\)\}:\$\{isProAth \? 'pro' : 'local'\}`/.test(ai));
ok('  every candidate is filtered at ingest for a pro', /if \(isProAth\) \{ const why = PL\.proSkipReason\(it\); if \(why\)/.test(ai));
ok('  the scoring prompt says with the team, and the pro deal shapes, and the pro dealType enum', /with the \$\{proTeam \|\| 'team'\} \(a professional athlete; propose appearance days, signings, season-long ambassador deals/.test(ai) && (ai.match(/isProAth \? PL\.PRO_DEAL_TYPES : 'post\|reel\|ambassador\|appearance'/g) || []).length === 2);
ok('  the college prompt is still there, word for word', /Name 8 to 10 REAL, well-known, established LOCAL businesses that would realistically do an NIL deal with this college athlete/.test(ai) && /THIS IS LOCAL-FIRST\. A \$\{tier\}-tier athlete will NOT land Nike/.test(ai) && /LOCAL_TAXONOMY = 'car dealerships; restaurants and food spots; gyms/.test(ai));

OUT.push('', '-- 2. contact: marketing director first, the owner as the fallback --');
const R = CR.RANK;
const base = (t) => CR.authorityOf(t).rank;
const pro = PL.proRankOf(base);
ok('for a pro, marketing leadership outranks the owner', pro('Director of Marketing') < pro('Owner') && pro('VP of Marketing') < pro('Owner') && pro('Head of Partnerships') < pro('Owner'), [pro('Director of Marketing'), pro('VP of Marketing'), pro('Owner')]);
ok('  a marketing manager outranks the owner too', pro('Marketing Manager') < pro('Owner'));
ok('  the owner is still tier 1 (rank <= MARKETING_LEAD) where the owner is all we have', pro('Owner') <= R.MARKETING_LEAD && pro('Founder') <= R.MARKETING_LEAD);
ok('  a title outside the leadership set passes through unchanged (a placeholder stays a placeholder, untitled stays untitled)', ['', 'Front Desk', 'Team', 'Registered Agent', 'Cashier'].every((t) => pro(t) === base(t)), ['', 'Front Desk', 'Team', 'Cashier'].map((t) => [pro(t), base(t)]));
ok('for a college athlete the ranking is untouched: the owner first', base('Owner') === R.OWNER && base('Director of Marketing') === R.MARKETING_LEAD && base('Owner') < base('Director of Marketing'));
(async () => {
  const asked = [];
  const search = async (prompt) => { asked.push(prompt); return { text: JSON.stringify({ name: 'Dana Roberts', title: /marketing director/.test(prompt) ? 'Director of Marketing' : 'Owner', confidence: 'high' }), citations: ['https://x'] }; };
  const p = await ONS.findOwnerName({ brand: 'Schomp Automotive Group', city: 'Denver', search, order: PL.PRO_QUERY_ORDER });
  ok('the pro last-door search asks for the marketing director FIRST and stops there', asked.length === 1 && /marketing director/.test(asked[0]) && p && p.query === 'marketing' && p.title === 'Director of Marketing', { asked, p });
  asked.length = 0;
  const miss = async (prompt) => { asked.push(prompt); return /marketing director/.test(prompt) ? { text: '{"name":null}' } : { text: JSON.stringify({ name: 'Lee Park', title: 'Owner', confidence: 'high' }), citations: ['https://y'] }; };
  const p2 = await ONS.findOwnerName({ brand: 'Mile High Roofing', city: 'Denver', search: miss, order: PL.PRO_QUERY_ORDER });
  ok('  the owner is the fallback, run only when marketing found nobody', asked.length === 2 && /marketing director/.test(asked[0]) && /owner/.test(asked[1]) && p2 && p2.query === 'owner', { asked, p2 });
  asked.length = 0;
  const c = await ONS.findOwnerName({ brand: 'Trak Shak', city: 'Auburn', search });
  ok('  with no order (a college athlete) the owner search still runs first, unchanged', asked.length === 1 && /owner/.test(asked[0]) && c.query === 'owner', asked);
  const job = src('server/jobs/outreachQueue.js');
  ok('the job reads the lane from the record and passes it to the ladder and both last-door searches', /const proLane = PL\.isPro\(profile\) \|\| PL\.isPro\(ctx\.athleteRow \|\| \{\}\);/.test(job) && /rankOf: proLane \? PL\.proRankOf\(ai\.contactAuthorityRank\) : ai\.contactAuthorityRank/.test(job) && (job.match(/order: proLane \? PL\.PRO_QUERY_ORDER : null/g) || []).length === 2);
  ok('  finalNameFor keys its cache by the order too, so a pro and a college athlete in one town do not share an answer', /\|\$\{Array\.isArray\(order\) \? order\.join\(','\) : ''\}`;/.test(job));

  OUT.push('', '-- 3. the pitch: appearances, signings, ambassador deals, shoots, hospitality; team and market first; never NIL --');
  const sysPro = PW.systemFor(PRO), sysCol = PW.systemFor(COL);
  ok('the pro system prompt proposes the pro shapes', /appearance day at their location/.test(sysPro) && /autograph signing/.test(sysPro) && /season-long ambassador deal/.test(sysPro) && /commercial or photo\s+shoot/.test(sysPro) && /hospitality event/.test(sysPro));
  ok('  and never a post as the whole deal, never NIL, team and market first', /NEVER propose a social post, a story or a reel as the whole\s+deal/.test(sysPro) && /Never use the word NIL/.test(sysPro) && /Lead with the team and the market, never with a hometown or a school/.test(sysPro) && /OPEN WITH THE TEAM AND THE ROLE/.test(sysPro));
  ok('the college system prompt is unchanged: none of the pro wording', sysCol !== sysPro && !/season-long ambassador/.test(sysCol) && !/Never use the word NIL/.test(sysCol) && !/PROFESSIONAL/.test(sysCol));
  const blockPro = PW.describeAthlete ? PW.describeAthlete(PRO) : PW.buildPrompt({ business: { name: 'X' }, athlete: PRO });
  const blockCol = PW.describeAthlete ? PW.describeAthlete(COL) : PW.buildPrompt({ business: { name: 'X' }, athlete: COL });
  ok('the pro athlete block withholds the hometown and says to lead with the team and the market', !/Opelika/.test(blockPro) && /Lead with the team and the market/.test(blockPro) && /Denver Broncos/.test(blockPro) && !/Auburn/.test(blockPro) && !/Senior/.test(blockPro), blockPro);
  ok('  the college block still carries the hometown and the school', /Opelika/.test(blockCol) && /Auburn/.test(blockCol) && /Junior/.test(blockCol));
  const proLint = (m) => PW.lintMessage(m, { signOff: 'John', pro: true, athlete: PRO });
  const colLint = (m) => PW.lintMessage(m, { signOff: 'John', pro: false, athlete: COL });
  const POST_ONLY = 'Hi Dana,\n\nMarcus Hall, linebacker for the Denver Broncos, is looking at partners in Denver this season. Your dealership sells to the same fans who fill the stadium. He would do two Instagram posts from the lot. Would you like to learn more about this endorsement opportunity with Marcus?\n\nJohn';
  const APPEARANCE = POST_ONLY.replace('He would do two Instagram posts from the lot.', 'He would do an appearance day at the dealership, with a post to bring the fans in.');
  ok('a pro pitch that is only a post is rejected', proLint(POST_ONLY).problems.some((p) => /proposes only a social post/.test(p)), proLint(POST_ONLY).problems);
  ok('  an appearance day passes, even with a post alongside it', !proLint(APPEARANCE).problems.some((p) => /only a social post/.test(p)), proLint(APPEARANCE).problems);
  ok('  a signing, an ambassador deal, a shoot and a hospitality night pass', ['an autograph signing on a Saturday', 'a season-long ambassador deal', 'a commercial shoot at the store', 'a hospitality night for your best customers'].every((d) => !proLint(POST_ONLY.replace('two Instagram posts from the lot', d)).problems.some((p) => /only a social post/.test(p))));
  const HOME_LEAD = 'Hi Dana,\n\nMarcus Hall grew up in Opelika and now plays linebacker for the Denver Broncos. Your dealership sells to the same fans who fill the stadium. He would do an appearance day at the dealership. Would you like to learn more about this endorsement opportunity with Marcus?\n\nJohn';
  ok('  a pitch that leads with the hometown is rejected', proLint(HOME_LEAD).problems.some((p) => /leads with (the hometown|where they are from)/.test(p)), proLint(HOME_LEAD).problems);
  const SCHOOL_LEAD = HOME_LEAD.replace('grew up in Opelika and now plays', 'played at Auburn University and now plays');
  ok('  a pitch that leads with the school is rejected', proLint(SCHOOL_LEAD).problems.some((p) => /leads with a school/.test(p)), proLint(SCHOOL_LEAD).problems);
  ok('  the word NIL is rejected', proLint(APPEARANCE.replace('endorsement opportunity', 'NIL opportunity')).problems.some((p) => /NIL/.test(p)));
  ok('the college lint is unchanged: a post-only pitch and a hometown line pass it', !colLint(POST_ONLY.replace('endorsement opportunity', 'NIL opportunity')).problems.some((p) => /only a social post|leads with|NIL/.test(p)));
  const pw = src('server/services/pitchWriter.js');
  ok('the writer reads the lane from ctx.athlete.athleteType into the lint, and the model is unchanged', /pro: !!\(ctx\.athlete && ctx\.athlete\.athleteType === 'pro'\), athlete: ctx\.athlete \|\| null/.test(pw) && /if \(opts\.pro\) for \(const p of require\('\.\/proLane'\)\.proProblems\(t, opts\.athlete \|\| \{\}\)\)/.test(pw) && /sonnet/i.test(pw) && !/deepseek/i.test(pw));

  OUT.push('', '-- 4. compliance is untouched --');
  ok('the compliance service does not read the pro lane', !/proLane/.test(src('server/services/compliance.js')) && !fs.readdirSync(REPO + 'server/services').filter((f) => /compliance|age|state/i.test(f)).some((f) => /proLane/.test(src('server/services/' + f))));
  ok('  and the pro lane never touches compliance, the age gate or state rules', !/require\('\.\/(compliance|ageGate|stateRules|over18)|over18|\bdob\b/i.test(src('server/services/proLane.js').replace(/^\s*\/\/.*$/gm, '')));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('prolane: FAILED', e); process.exit(1); });
