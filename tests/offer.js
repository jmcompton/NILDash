'use strict';
// Runs against the local test Postgres, in its own database. No network.
//
//   node tests/run.js        every suite, against the committed baseline
//   node tests/offer.js      just this one
//
// ── THE SUGGESTED DOLLAR OFFER (OFFER_ON) ──────────────────────────────────
// Every business card on Home and in Deal Scan says "Suggested offer: $X",
// the agent can change it, and the pitch uses it as where the conversation
// starts:
//   $250  a small mom-and-pop business
//   $500  a mid-range business or a well-known local institution, read from
//         Places price level, review count and chain or not
//   a restaurant also gets a menu item named after the athlete as an add-on
//   never a percentage, never free product alone: "$500 in product"
//   the deal stores what was suggested, what was offered and what was signed
// Off (the default) nothing changes.
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..') + path.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('offertest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SEND_GATE_ON;
delete process.env.EMAIL_FIVE_ON;
process.env.OFFER_ON = '1';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
require('./helpers/offlineDns').install();

// The writers read ai.oneShot when they are loaded: stubbed first.
const ai = require(REPO + 'server/ai');
let answers = [];
const prompts = [];
ai.oneShot = async (prompt) => { prompts.push(String(prompt)); return answers.length ? answers.shift() : '{}'; };

const store = require(REPO + 'server/store.js');
const O = require(REPO + 'server/services/offerSuggest');
const W = require(REPO + 'server/services/pitchWriter');
const DP = require(REPO + 'server/services/draftPrewarm');
const PG = require(REPO + 'server/services/pitchGeneration');
const DL = require(REPO + 'server/services/dealLog');
const Home = require(REPO + 'server/services/homeQueue');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const read = (f) => fs.readFileSync(REPO + f, 'utf8');
const withOff = (fn) => { delete process.env.OFFER_ON; try { return fn(); } finally { process.env.OFFER_ON = '1'; } };
const withOffAsync = async (fn) => { delete process.env.OFFER_ON; try { return await fn(); } finally { process.env.OFFER_ON = '1'; } };

(async () => {
  console.log('\n1. THE RULE. Pure.');
  const s1 = O.suggest({ chain: false, reviews: 54, priceLevel: 'PRICE_LEVEL_INEXPENSIVE', category: 'pizza restaurant', athleteName: 'Maya Torres' });
  ok('a small mom-and-pop business: $250', s1.amount === 250 && s1.tier === 'small' && s1.label === '$250', s1);
  ok('  saying why', s1.why === 'a small local business (54 reviews, $ price level, not a chain)', s1.why);
  ok('a chain location: $500', O.suggest({ chain: true, reviews: 12 }).amount === 500 && /a chain location/.test(O.suggest({ chain: true }).why));
  ok('a well-known local institution, 250+ reviews: $500', O.suggest({ reviews: 250 }).amount === 500 && O.suggest({ reviews: 249 }).amount === 250
    && /well known locally \(812 reviews\)/.test(O.suggest({ reviews: 812 }).why));
  ok('a $$$ or $$$$ price level: $500', O.suggest({ priceLevel: 'PRICE_LEVEL_EXPENSIVE' }).amount === 500 && O.suggest({ priceLevel: 4 }).amount === 500);
  ok('mid-range: $$ with 100+ reviews is $500, $$ with fewer is $250', O.suggest({ priceLevel: 'PRICE_LEVEL_MODERATE', reviews: 100 }).amount === 500
    && O.suggest({ priceLevel: 'PRICE_LEVEL_MODERATE', reviews: 99 }).amount === 250);
  ok('nothing known: $250, never a guess upward', O.suggest({}).amount === 250 && O.suggest({}).why === 'a small local business');
  ok('price level in either API\'s shape', O.priceLevelOf('PRICE_LEVEL_VERY_EXPENSIVE') === 4 && O.priceLevelOf(2) === 2 && O.priceLevelOf('$$$') === 3 && O.priceLevelOf(null) === null && O.priceLevelOf('x') === null);
  ok('a national brand (Top NIL, social): $500, and no menu item', O.suggest({ national: true, category: 'burger restaurant', athleteName: 'Jo Doe' }).amount === 500
    && O.suggest({ national: true, category: 'burger restaurant', athleteName: 'Jo Doe' }).menuItem === null
    && O.suggest({ national: true }).why === 'a national brand');
  ok('from a Places record (the nightly shape and the scan shape)', O.forBusiness({ name: 'Joe\'s Pizza', place: { userRatingCount: 400 }, athleteName: 'Jo Doe' }).amount === 500
    && O.forBusiness({ name: 'Joe\'s Pizza', place: { user_ratings_total: 30, price_level: 1 }, category: 'pizza', athleteName: 'Jo Doe' }).amount === 250
    && O.forBusiness({ name: 'Mom Cafe', place: {}, franchise: true }).amount === 500);

  console.log('\n   a menu item for a restaurant');
  ok('a pizza place: "The Torres Pizza"', s1.menuItem === 'The Torres Pizza', s1.menuItem);
  ok('  a coffee shop, a burger joint, ice cream (from Google\'s types)', O.suggest({ category: 'coffee shop', athleteName: 'Jo Doe' }).menuItem === 'The Doe Latte'
    && O.suggest({ category: 'burger restaurant', athleteName: 'Jo Doe' }).menuItem === 'The Doe Burger'
    && O.suggest({ types: ['ice_cream_shop', 'food'], athleteName: 'Jo Doe' }).menuItem === 'The Doe Sundae');
  ok('  a restaurant with no dish word: "Special"', O.suggest({ types: ['restaurant'], athleteName: 'Amber Bretton' }).menuItem === 'The Bretton Special');
  ok('  a suffix is not the name ("Jr.")', O.menuItemFor('Marcus Hill Jr.', 'Burger') === 'The Hill Burger');
  ok('not a food business: no menu item (a veterinary hospital, a gym)', O.suggest({ category: 'veterinary hospital', athleteName: 'Jo Doe' }).menuItem === null
    && O.suggest({ category: 'gym', types: ['gym'], athleteName: 'Jo Doe' }).menuItem === null);
  ok('  no athlete name: no menu item', O.suggest({ category: 'pizza' }).menuItem === null);

  console.log('\n   the money rules');
  ok('dollars, typed any reasonable way', O.parseOffer('$1,200').amount === 1200 && O.parseOffer('300').amount === 300 && O.parseOffer(' $250 ').label === '$250');
  ok('never a percentage', !O.parseOffer('10%').ok && /never a percentage/.test(O.parseOffer('15 percent').why));
  ok('never a range', !O.parseOffer('200-300').ok && !O.parseOffer('$200 to $300').ok);
  ok('never nothing, zero or junk', !O.parseOffer('').ok && !O.parseOffer('0').ok && !O.parseOffer('free').ok);
  ok('a product deal carries its dollar value: "$500 in product"', O.parseOffer('500', 'product').label === '$500 in product' && O.labelOf(500, 'product') === '$500 in product');
  ok('a card\'s offer sent back by the browser is checked again (a percentage is dropped)', O.fromCard({ amount: '10%' }) === null
    && O.fromCard({ amount: 300, kind: 'cash', suggested: 250, label: 'free stuff' }).label === '$300'
    && O.fromCard({ amount: 300, suggested: 250 }).suggested === 250);

  console.log('\n2. DEAL SCAN: EVERY CARD');
  const cards = [
    { brand: 'Torres Pizza Co', lane: 'local', isLocal: true, category: 'pizza restaurant', user_ratings_total: 60, price_level: 1, types: ['pizza_restaurant'] },
    { brand: 'Old Main Steakhouse', lane: 'local', isLocal: true, category: 'restaurant', user_ratings_total: 900, price_level: 3 },
    { brand: 'Gatorade', lane: 'topnil', category: 'beverage' },
  ];
  O.attachToScan(cards, { athleteName: 'Maya Torres', lane: 'local' });
  ok('a small local card: $250, with its menu item', cards[0].offer.amount === 250 && cards[0].offer.menuItem === 'The Torres Pizza', cards[0].offer);
  ok('a well-known local institution: $500', cards[1].offer.amount === 500 && /well known locally/.test(cards[1].offer.why), cards[1].offer);
  ok('a Top NIL card is a national brand: $500', cards[2].offer.amount === 500 && cards[2].offer.why === 'a national brand', cards[2].offer);
  const offCards = [{ brand: 'X', lane: 'local', isLocal: true }];
  withOff(() => O.attachToScan(offCards, { athleteName: 'Maya Torres' }));
  ok('OFFER_ON off: the scan cards are untouched', !('offer' in offCards[0]));
  const ajs = read('server/ai.js');
  ok('the scan keeps the size signals from Places (review count, price level)', /user_ratings_total: it\.user_ratings_total != null \? it\.user_ratings_total : undefined/.test(ajs)
    && /\.\.\.\(meta && meta\.user_ratings_total != null \? \{ user_ratings_total: meta\.user_ratings_total \} : \{\}\)/.test(ajs)
    && /\.\.\.\(meta && meta\.price_level != null \? \{ price_level: meta\.price_level \} : \{\}\)/.test(ajs));
  const ijs = read('server/index.js');
  ok('the route attaches the offer on a fresh scan, a cached scan and the social lane',
    (ijs.match(/require\('\.\/services\/offerSuggest'\)\.attachToScan\(/g) || []).length === 3);
  ok('  and on a fresh scan before the drafts are pre-warmed', ijs.indexOf("attachToScan(recommendations") > 0
    && ijs.indexOf("attachToScan(recommendations") < ijs.indexOf('_prewarm.prewarmScan({'));
  const pl = read('server/services/placesLookup.js');
  ok('the nightly Places lookup asks for the price level (same field group, no extra cost)', /PLACE_FIELDS = '[^']*,priceLevel'/.test(pl) && /priceLevel: p\.priceLevel != null \? p\.priceLevel : null/.test(pl));

  console.log('\n   the Deal Scan card on the page');
  const html = read('public/index.html');
  const grab = (re) => { const m = html.match(re); if (!m) throw new Error('not found: ' + re); return m[0]; };
  const page = grab(/function _dsRateEntry[\s\S]*?\n}\n/) + grab(/var _DS_CAT_BUDGET[\s\S]*?function _dsCatHas[\s\S]*?\n}\n/)
    + grab(/function _dsPitchFor[\s\S]*?\n}\n/) + grab(/function _dsOfferLine[\s\S]*?\n}\n/) + grab(/function dsParseOffer[\s\S]*?\n}\n/);
  const env = new Function('window', 'esc', page + '; return { _dsPitchFor, _dsOfferLine, dsParseOffer };')({}, (v) => String(v));
  const foodOff = env._dsPitchFor({ category: 'restaurant', offer: { amount: 250, menuItem: 'The Torres Pizza' } }, {});
  const foodOld = env._dsPitchFor({ category: 'restaurant' }, {});
  ok('a food card with an offer: no free meals, no percentage, the menu item as an add-on', !/free|percent/i.test(foodOff.pitch) && /menu item named after the athlete/.test(foodOff.pitch), foodOff);
  ok('  retail and service with an offer: no percentage, nothing free', !/free|percent/i.test(env._dsPitchFor({ category: 'retail', offer: { amount: 250 } }, {}).pitch)
    && !/free|percent/i.test(env._dsPitchFor({ category: 'gym', offer: { amount: 250 } }, {}).pitch));
  ok('  with no offer (OFFER_ON off) the old pitch is unchanged', foodOld.pitch === 'Free meals plus a named menu item, athlete takes 10 percent');
  ok('the card reads "Suggested offer: $250 (why)"', /^Suggested offer: <b>\$250<\/b> <span[^>]*>\(a small local business\)<\/span>$/.test(env._dsOfferLine({ amount: 250, suggested: 250, kind: 'cash', why: 'a small local business' })));
  ok('  after a change: "Your offer: $500 in product (suggested $250)"', /^Your offer: <b>\$500 in product<\/b> <span[^>]*>\(suggested \$250\)<\/span>$/.test(env._dsOfferLine({ amount: 500, suggested: 250, kind: 'product' })));
  ok('  the page refuses a percentage and a range, the same as the server', !env.dsParseOffer('10%').ok && !env.dsParseOffer('200-300').ok && env.dsParseOffer('$1,200').amount === 1200);
  ok('  the offer block sits in the Pitch box, with Change, Save and Cancel', /_dsOfferHtml\(d, i\) \+\n    '<\/div>';/.test(html) && /onclick="dsOfferSave\(' \+ i \+ '\)"/.test(html) && /onclick="dsOfferEdit\(' \+ i \+ '\)"/.test(html));
  ok('+ Pipeline stores the suggested and offered amounts', /offeredValue: _po\.amount, suggestedValue: _po\.suggested != null \? _po\.suggested : _po\.amount, offerKind: _po\.kind \|\| 'cash'/.test(html)
    && /suggestedValue: parseInt\(suggestedValue\)/.test(ijs));

  console.log('\n3. THE NIGHTLY WRITER');
  const ctxBase = { athlete: { name: 'Maya Torres', sport: 'Softball', school: 'Auburn University' }, business: { name: 'Torres Pizza Co', category: 'pizza restaurant' }, agentFirstName: 'John' };
  const p0 = W.buildPrompt(ctxBase);
  ok('no offer on the card: no figure in the prompt (the old rule)', !/\$\d/.test(p0) && !/THE STARTING OFFER/.test(p0));
  const p1 = W.buildPrompt({ ...ctxBase, offer: { amount: 250, label: '$250', menuItem: 'The Torres Pizza' } });
  ok('with an offer: the one figure, once, and the add-on', /THE STARTING OFFER: \$250\. This one figure is the exception to the money rule: you may name exactly "\$250", once/.test(p1)
    && /no percentage, and never offer anything for free/.test(p1) && /"The Torres Pizza"/.test(p1));
  ok('  the offer replaces any product-in-exchange idea from the category note', /this offer replaces it: the deal is this dollar figure/.test(p1));
  const MSG = (offerSentence) => 'Hi Pat,\n\nMaya Torres plays softball at Auburn and her fans eat pizza after every home game. '
    + 'She would post about Torres Pizza Co on game day and stop by for a photo with the staff. ' + offerSentence + ' '
    + 'It is a simple way to reach the students who already walk past your door.\n\nWould you be open to a quick call this week?\n\nJohn';
  const lint = (m) => W.lintMessage(m, { offer: '$250', signOff: 'John' });
  const has = (m, re) => JSON.stringify(lint(m)).match(re);
  ok('the offer named once passes the money check', !has(MSG('We would start the conversation at $250.'), /names a price/), lint(MSG('We would start the conversation at $250.')));
  ok('  any other amount is still a price', !!has(MSG('We would start the conversation at $300.'), /names a price/));
  ok('  a bigger number that starts the same is still a price ("$2500")', !!has(MSG('We would start the conversation at $2500.'), /names a price/));
  ok('  named twice is refused', !!has(MSG('We would start at $250, and $250 covers it.'), /names the offer \(\$250\) more than once/));
  ok('  with no offer, $250 is a price as before', /names a price/.test(JSON.stringify(W.lintMessage(MSG('We would start the conversation at $250.'), { signOff: 'John' }))));
  ok('writePitch hands the card\'s offer to the check', /offer: \(ctx\.offer && ctx\.offer\.label\) \|\| null,/.test(read('server/services/pitchWriter.js')));
  const job = read('server/jobs/outreachQueue.js');
  ok('the night: the offer from the Places record, into the writer, onto the card and its draft',
    /const _offer = OFFER\.ON\(\) \? OFFER\.forBusiness\(\{ name: cand\.brand_name, place, athleteName/.test(job)
    && /offer: _offer/.test(job) && /if \(_offer\) card\.offer = _offer;/.test(job)
    && /await OFFER\.record\(pool, \{ queueId: ins\.rows\[0\]\.id, logId: logId \|\| null, offer: card\.offer \}\)/.test(job));

  console.log('\n4. THE DEAL SCAN WRITERS');
  const card = { brand: 'Torres Pizza Co', category: 'pizza restaurant', rationale: 'Game-day crowd', offer: { amount: 250, kind: 'cash', suggested: 250, label: '$250', menuItem: 'The Torres Pizza' } };
  const ath = { name: 'Maya Torres', sport: 'Softball', school: 'Auburn University' };
  const dp1 = DP.buildPrompt(ath, card, 'John Agent');
  ok('the pre-warmed draft is told the one figure', /the starting offer: exactly "\$250", once\. No other dollar amount, no range, no percentage, nothing offered for free\./.test(dp1)
    && /"The Torres Pizza"/.test(dp1));
  const dp0 = withOff(() => DP.buildPrompt(ath, card, 'John Agent'));
  ok('  OFFER_ON off: the old line, never a dollar amount', /Never a dollar amount, price or rate\./.test(dp0) && !/\$250/.test(dp0));
  const DRAFT = (s) => 'Hi,\n\nMaya Torres plays softball at Auburn, and Torres Pizza Co is where her teammates go after home games. '
    + 'She would post about you on game day. ' + s + '\n\nWould that work for you?';
  ok('  a draft naming the offer passes', DP.checkDraft(DRAFT('We would start at $250.'), card).ok === true, DP.checkDraft(DRAFT('We would start at $250.'), card));
  ok('  a draft naming another amount is rejected, saying the one allowed', /names a price other than the offer \("\$400"\); the only amount is "\$250"/.test(DP.checkDraft(DRAFT('We would start at $400.'), card).why || ''));
  ok('  the offer is recorded on the pre-warmed draft', /if \(o\) await require\('\.\/offerSuggest'\)\.record\(pool, \{ logId: id, offer: o \}\)/.test(read('server/services/draftPrewarm.js')));

  prompts.length = 0;
  const BODY = 'Hi Dana,\n\nMaya Torres plays softball at Auburn and her teammates eat at Trak Shak after every home game. She would post about you on game day and stop in for a photo. We would start the conversation at $250.\n\nWould you be open to a quick call this week?';
  answers = [JSON.stringify({ full_email_body: BODY, partnership_structure: 'Two posts', value_proposition: 'Local reach' })];
  const g1 = await PG.generatePitch({ athlete: { name: 'Maya Torres', sport: 'softball', school: 'Auburn', position: 'pitcher' }, enrichment: { brand_name: 'Trak Shak' },
    matchScore: null, contact: { name: 'Dana Cole', email: 'dana@trakshak.com', title: 'Owner' }, agentName: 'John', agentEmail: 'j@x.com',
    dealScanData: { category: 'restaurant', offer: { amount: 250, kind: 'cash', suggested: 250, menuItem: 'The Torres Burger' } } });
  ok('AI Outreach: told the one figure and the add-on', /THE STARTING OFFER: \$250\. Name the DELIVERABLE/.test(prompts[0] || '') && /"The Torres Burger"/.test(prompts[0] || ''));
  ok('  the email body may name it', !g1.refused && /\$250/.test(g1.full_email_body || ''), g1);
  prompts.length = 0;
  answers = [JSON.stringify({ full_email_body: BODY, partnership_structure: '$250 for two posts' }), JSON.stringify({ full_email_body: BODY, partnership_structure: '$250 for two posts' })];
  const g2 = await PG.generatePitch({ athlete: { name: 'Maya Torres', sport: 'softball', school: 'Auburn', position: 'pitcher' }, enrichment: { brand_name: 'Trak Shak' },
    matchScore: null, contact: null, agentName: 'John', agentEmail: 'j@x.com', dealScanData: { category: 'restaurant', offer: { amount: 250, suggested: 250 } } });
  ok('  but no other field (the structure line is pasted into decks)', g2.refused === true && g2.reasons.some((x) => /partnership_structure names a price/.test(x)), g2);
  prompts.length = 0;
  answers = [JSON.stringify({ full_email_body: BODY }), JSON.stringify({ full_email_body: BODY })];
  const g3 = await withOffAsync(() => PG.generatePitch({ athlete: { name: 'Maya Torres', sport: 'softball', school: 'Auburn', position: 'pitcher' }, enrichment: { brand_name: 'Trak Shak' },
    matchScore: null, contact: null, agentName: 'John', agentEmail: 'j@x.com', dealScanData: { category: 'restaurant', offer: { amount: 250, suggested: 250 } } }));
  ok('  OFFER_ON off: never a dollar amount, as before', /NEVER state a dollar amount/.test(prompts[0] || '') && g3.refused === true);
  const eng = read('public/outreach-engine.js');
  const swap = new Function(eng.match(/function offerSwap[\s\S]*?\n}\n/)[0] + '; return offerSwap;')();
  ok('a changed offer replaces the figure in a pre-warmed draft, never part of a bigger number',
    swap('start at $250. Not $2500 or $250,000.', { amount: 300, suggested: 250, kind: 'cash' }) === 'start at $300. Not $2500 or $250,000.'
    && swap('start at $250.', { amount: 500, suggested: 250, kind: 'product' }) === 'start at $500 in product.'
    && /applyCardOffer\(dealResult\);/.test(eng));
  const wo = read('server/services/workflowOrchestrator.js');
  ok('AI Outreach records the offer on its draft and its Pipeline deal', /if \(o\) await OFFER\.record\(pool, \{ logId: id, offer: o \}\)/.test(wo)
    && /return o \? \{ offeredValue: o\.amount, suggestedValue: o\.suggested, offerKind: o\.kind \} : \{\}/.test(wo));

  console.log('\n5. HOME, THE EDIT AND THE DEAL (Postgres)');
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await DL.ensureTable(P);
  const AG = 'of-agent', AG2 = 'of-other', ATH = 'of-ath';
  await P.query(`INSERT INTO users (id, name, email, role, password) VALUES ($1, 'Owen Offer', 'owen@agency.example', 'agent', 'x'), ($2, 'Other', 'o@agency.example', 'agent', 'x')`, [AG, AG2]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1, $2, $3)`, [ATH, AG, JSON.stringify({ name: 'Maya Torres', school: 'Auburn University', dob: '2004-02-02', over18: 'true' })]);
  const LOG = 'out_offer_1';
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email, created_at, updated_at)
                 VALUES ($1,$2,$3,'Torres Pizza Co','NIL opportunity for Torres Pizza Co',
                 '<div>Hi Pat,</div><div><br></div><div>Maya would post on game day. We would start at $250, not $2500.</div><div><br></div><div>Would you be open to a quick call this week?</div>',
                 'draft','pat@torrespizza.com',NOW(),NOW())`, [LOG, AG, ATH]);
  const qid = (await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, channel, outreach_log_id, dm_text, lane)
                 VALUES ($1,$2,1,'place:torres','Torres Pizza Co','queued','email',$3,'Hey! Maya would love to work with you, starting at $250.','local') RETURNING id`, [AG, ATH, LOG])).rows[0].id;
  await O.record(P, { queueId: qid, logId: LOG, offer: O.suggest({ reviews: 54, category: 'pizza', athleteName: 'Maya Torres' }) });
  const row = (await P.query(`SELECT offer_suggested, offer_amount, offer_kind, offer_menu_item, offer_why FROM outreach_logs WHERE id = $1`, [LOG])).rows[0];
  ok('the offer is stored on the draft and its card', row.offer_suggested === 250 && row.offer_amount === 250 && row.offer_kind === 'cash' && row.offer_menu_item === 'The Torres Pizza', row);

  let h = await Home.buildHome(P, AG, { athleteId: ATH });
  let c = (h.cards || []).find((x) => x.business === 'Torres Pizza Co');
  ok('Home\'s card carries "Suggested offer: $250"', c && c.offer && c.offer.label === '$250' && c.offer.edited === false && c.offer.menuItem === 'The Torres Pizza', c && c.offer);
  const hOff = await withOffAsync(() => Home.buildHome(P, AG, { athleteId: ATH }));
  const cOff = (hOff.cards || []).find((x) => x.business === 'Torres Pizza Co');
  ok('  OFFER_ON off: no offer on the card', cOff && cOff.offer === null, cOff && cOff.offer);
  ok('  the page draws it with Change, Save and Cancel', /\+ hqOfferHtml\(c, i\)/.test(html) && /'Suggested offer: <b>'/.test(html) && /fetch\(API_BASE \+ '\/api\/agent\/cards\/offer'/.test(html));

  ok('a percentage is refused, with why', (await O.setOffer(P, AG, c.id, '10%')).error === 'An offer is a dollar amount, never a percentage.');
  ok('another agent\'s card is refused', (await O.setOffer(P, AG2, c.id, '300')).status === 404);
  const e1 = await O.setOffer(P, AG, c.id, '$300');
  const after = (await P.query(`SELECT body_html, offer_suggested, offer_amount FROM outreach_logs WHERE id = $1`, [LOG])).rows[0];
  const qAfter = (await P.query(`SELECT dm_text, offer_suggested, offer_amount FROM outreach_queue WHERE id = $1`, [qid])).rows[0];
  ok('the agent changes it: $300, the suggestion kept', e1.ok && e1.offer.amount === 300 && e1.offer.suggested === 250 && e1.offer.edited === true && after.offer_suggested === 250, e1);
  ok('  the draft\'s figure is rewritten, and never part of a bigger number', e1.rewritten === true && /start at \$300, not \$2500\./.test(after.body_html), after.body_html);
  ok('  the card\'s DM too', /starting at \$300\./.test(qAfter.dm_text) && qAfter.offer_amount === 300 && qAfter.offer_suggested === 250, qAfter);
  const e2 = await O.setOffer(P, AG, 'queue:' + qid, '500', 'product');
  ok('a product deal: "$500 in product"', e2.ok && e2.offer.label === '$500 in product', e2);
  h = await Home.buildHome(P, AG, { athleteId: ATH });
  c = (h.cards || []).find((x) => x.business === 'Torres Pizza Co');
  ok('  Home reads back "Your offer: $500 in product (suggested $250)"', c && c.offer.label === '$500 in product' && c.offer.suggestedLabel === '$250' && c.offer.edited === true, c && c.offer);
  ok('the edit route is behind the switch and owner-checked', /app\.patch\('\/api\/agent\/cards\/offer', requireAuth/.test(ijs)
    && /if \(!OFFER\.ON\(\)\) return res\.status\(404\)/.test(ijs) && /OFFER\.setOffer\(store\.pool, req\.session\.userId, b\.cardId, b\.amount, b\.kind\)/.test(ijs));

  // Sent: never changed after it went out.
  await P.query(`UPDATE outreach_queue SET state = 'sent', sent_at = NOW() WHERE id = $1`, [qid]);
  await P.query(`UPDATE outreach_logs SET status = 'sent', sent_at = NOW() WHERE id = $1`, [LOG]);
  ok('a sent card\'s offer cannot be changed', (await O.setOffer(P, AG, 'queue:' + qid, '700')).status === 409);

  console.log('\n   the deal stores suggested, offered and final');
  const d1 = await DL.logDeal(P, { agentId: AG, athleteId: ATH, queueId: qid, value: 450, deliverable: 'two posts' });
  const o1 = (await P.query(`SELECT deal_value, suggested_value, offered_value, offer_kind FROM deal_outcomes WHERE id = $1`, [d1.id])).rows[0];
  ok('from the card: suggested $250, offered $500 in product, signed $450', d1.ok && Number(o1.suggested_value) === 250 && Number(o1.offered_value) === 500
    && o1.offer_kind === 'product' && Number(o1.deal_value) === 450, { d1, o1 });
  const p = (await P.query(`SELECT value, suggested_value, offered_value FROM athlete_self_deals WHERE athlete_id = $1 AND LOWER(brand_name) = 'torres pizza co'`, [ATH])).rows[0];
  ok('  and on the Pipeline row, with the signed amount', p && Number(p.value) === 450 && Number(p.suggested_value) === 250 && Number(p.offered_value) === 500, p);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, channel, sent_at, lane, offer_suggested, offer_amount, offer_kind)
                 VALUES ($1,$2,2,'place:gym','Iron Gym','sent','email',NOW(),'local',250,250,'cash')`, [AG, ATH]);
  const d2 = await DL.logDeal(P, { agentId: AG, athleteId: ATH, brandName: 'Iron Gym', value: 250 });
  ok('logged by name (My Brands, Pipeline): read from the latest sent card for that business', d2.ok && d2.suggestedValue === 250 && d2.offeredValue === 250, d2);
  const d3 = await DL.logDeal(P, { agentId: AG, athleteId: ATH, brandName: 'Walk-in Barber', value: 100 });
  const o3 = (await P.query(`SELECT suggested_value, offered_value FROM deal_outcomes WHERE id = $1`, [d3.id])).rows[0];
  ok('  a deal with no card: no offer, nothing invented', d3.ok && o3.suggested_value === null && o3.offered_value === null, o3);
  ok('the "Deal signed" form starts from the card\'s offer and sends it', /dealSignedOpen\(HQ\.selected, r\.business, r\.brandKey, id, r\.offer \|\| null\)/.test(html)
    && /'Your offer was \$' \+ Number\(_off\.amount\)\.toLocaleString\(\)/.test(html) && /offeredValue: DEALFORM\.dataset\.offered \|\| null,/.test(html)
    && /suggestedValue: b\.suggestedValue, offeredValue: b\.offeredValue, offerKind: b\.offerKind \|\| null,/.test(ijs));
  const hs = await Home.buildHome(P, AG, { athleteId: ATH });
  const sentIron = (hs.sent || []).find((x) => x.business === 'Iron Gym');
  ok('  Home\'s sent row carries the offer for that form', sentIron && sentIron.offer && sentIron.offer.amount === 250, sentIron);

  console.log('\n6. NO COPY RULE BROKEN');
  const src = read('server/services/offerSuggest.js');
  const strings = (src.match(/'[^'\n]*'|`[^`\n]*`/g) || []).join(' ');
  ok('no em dash in anything the offer says', !/—/.test(strings));
  const ui = (html.match(/function hqOfferHtml[\s\S]*?\nasync function hqOfferSave/) || [''])[0] + (html.match(/function _dsOfferLine[\s\S]*?\nfunction _dsCardHtml/) || [''])[0];
  ok('  nor on its Home and Deal Scan controls', ui.length > 500 && !/—|&mdash;/.test(ui));

  await P.end().catch(() => {});
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
