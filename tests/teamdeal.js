'use strict';
// No database needed.
//
//   node tests/teamdeal.js
//
// ── THE TEAM DEAL PITCH AND THE REVIEWER (services/teamWriter) ──────────────
// The nightly local card is a paid NIL deal for the players, never a request to
// "support the program". The school sets the price (My Teams); the pitch
// quotes it exactly, or names none. A second model reads every nightly card
// before it can reach a school, and a draft it fails is rewritten once or
// dropped. Fictional names only.
const _tp = require('path');
const fs = require('fs');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const TW = require(REPO + 'server/services/teamWriter.js');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };

const NIL_BODY = (biz, price) => `${biz} is close to campus and home games bring families past you. Players on the team would do an appearance at ${biz} and post about it on their own accounts${price ? `, for ${price} paid to the players` : ''}.${price ? '' : ' The office will send a few options with prices.'} It is set up and paid through our NIL marketplace. Could we set up a short call?`;
const team = { name: "Women's Volleyball", roster_size: 17 };
const rated = { ...team, nil_rate_cents: 150000, nil_rate_what: '8 players: a two-hour appearance and one post each' };
const ctx = (t) => ({ university: { name: 'Pinecrest State University' }, team: t, business: { brand_name: 'Harbor Lane Dental', primary_type: 'dentist' }, contactName: 'Dana Reyes' });

// A writer that returns `drafts` in turn and a reviewer that returns `verdicts` in turn.
function fake(drafts, verdicts) {
  const seen = { write: 0, review: 0, models: [], reviewPrompts: [] };
  return { seen, oneShot: async (prompt, system, max, model) => {
    if (/You are reviewing an email/.test(prompt)) {
      seen.review++; seen.models.push(model); seen.reviewPrompts.push(prompt);
      const v = verdicts[Math.min(seen.review - 1, verdicts.length - 1)];
      if (v instanceof Error) throw v;
      return v;
    }
    seen.write++;
    return drafts[Math.min(seen.write - 1, drafts.length - 1)];
  } };
}
const draft = (biz, price) => `SUBJECT: Players for ${biz}\nBODY:\n${NIL_BODY(biz, price)}`;

async function main() {
  // ── THE SCHOOL SETS THE PRICE ──────────────────────────────────────────
  ok('no rate set: rateFor is null (NILDash never sets one)', TW.rateFor(team) === null && TW.rateFor({ ...team, nil_rate_cents: 0 }) === null);
  ok('a rate set: the school\'s price and what the business gets', TW.rateFor(rated).priceCents === 150000 && /8 players/.test(TW.rateFor(rated).what));
  const p0 = TW.buildPrompt(ctx(team)), p1 = TW.buildPrompt(ctx(rated));
  ok('the prompt is a paid NIL deal for the players, never sponsorship', /paid NIL deal/.test(p0) && /NOT a sponsorship, a donation, or support for the program/.test(p0));
  ok('  no rate: it names no price and says the office sends options', /Name no price/.test(p0) && !/\$\d/.test(p0));
  ok('  a rate: the school\'s price, stated exactly once', /PRICE SET BY THE SCHOOL: \$1,500/.test(p1) && /exactly as "\$1,500", once/.test(p1));

  // ── THE LINT ───────────────────────────────────────────────────────────
  const chk = (body, t) => TW.checkAsk({ subject: 'Players for Harbor Lane Dental', body }, ctx(t));
  ok('a good NIL pitch passes, with and without a rate', chk(NIL_BODY('Harbor Lane Dental'), team).ok && chk(NIL_BODY('Harbor Lane Dental', '$1,500'), rated).ok);
  for (const w of ['Would you like to support the program this season?', 'We are looking for sponsors this season.', 'A donation would help the team.', 'Would you back us as a local partner?']) {
    ok(`  sponsorship is refused: "${w}"`, /sponsorship/.test(chk(NIL_BODY('Harbor Lane Dental') + ' ' + w, team).why || ''));
  }
  ok('  no rate: any dollar amount is refused', !chk(NIL_BODY('Harbor Lane Dental', '$900'), team).ok);
  ok('  a rate: leaving the price out is refused', /\$1,500/.test(chk(NIL_BODY('Harbor Lane Dental'), rated).why || ''));
  ok('  a rate: a second dollar amount is refused', !chk(NIL_BODY('Harbor Lane Dental', '$1,500') + ' Or $500 for one player.', rated).ok);
  ok('  a pitch that never says players are paid is refused', !chk('Harbor Lane Dental is close to campus. It is set up through our NIL marketplace. Could we talk?', team).ok);
  ok('  naming a player is still refused', !chk(NIL_BODY('Harbor Lane Dental') + ' Our setter Riley Stone is in.', team).ok);

  // ── THE REVIEWER ───────────────────────────────────────────────────────
  const PASS = '{"pass": true, "problems": []}';
  let f = fake([draft('Harbor Lane Dental')], [PASS]);
  let w = await TW.writeAsk(ctx(team), { ai: f });
  ok('a pitch the reviewer passes goes out, after exactly one review', w.ok && w.reviews === 1 && f.seen.review === 1 && f.seen.write === 1, { w, seen: f.seen });
  ok('  the reviewer is a second model (Haiku), not the writer', f.seen.models[0] === TW.REVIEW_MODEL && TW.REVIEW_MODEL !== TW.MODEL && TW.MODEL === 'claude-sonnet-4-6');
  ok('  it reads the facts, the email and the seven rules', /FACTS:/.test(f.seen.reviewPrompts[0]) && /EMAIL:/.test(f.seen.reviewPrompts[0]) && /\n7\. /.test(f.seen.reviewPrompts[0]));
  f = fake([draft('Harbor Lane Dental', '$1,500')], [PASS]);
  await TW.writeAsk(ctx(rated), { ai: f });
  ok('  with a rate, it checks the school\'s price', /PRICE SET BY THE SCHOOL: \$1,500/.test(f.seen.reviewPrompts[0]));

  f = fake([draft('Harbor Lane Dental')], ['{"pass": false, "problems": ["3. it claims a dental award not in the facts"]}', PASS]);
  w = await TW.writeAsk(ctx(team), { ai: f });
  ok('a failed review is rewritten once with the reasons, then goes out if it passes', w.ok && w.retried && w.reviews === 2 && f.seen.write === 2, { w, seen: f.seen });

  f = fake([draft('Harbor Lane Dental')], ['{"pass": false, "problems": ["5. it describes a player"]}']);
  w = await TW.writeAsk(ctx(team), { ai: f });
  ok('FAIL CLOSED: failed twice, nothing goes out', !w.ok && /reviewer failed it: 5\. it describes a player/.test(w.error) && w.reviews === 2, w);

  for (const [name, v] of [['not JSON', 'Looks good to me!'], ['a pass that lists problems', '{"pass": true, "problems": ["6. reads like a template"]}'], ['pass missing', '{"problems": []}']]) {
    f = fake([draft('Harbor Lane Dental')], [v]);
    w = await TW.writeAsk(ctx(team), { ai: f });
    ok(`  a review that is ${name} is a fail`, !w.ok && /reviewer failed it/.test(w.error), w);
  }
  f = fake([draft('Harbor Lane Dental')], [new Error('overloaded')]);
  w = await TW.writeAsk(ctx(team), { ai: f });
  ok('  a reviewer that cannot run is a model fault (ourFault), and nothing goes out', !w.ok && /^model: review: overloaded/.test(w.error) && w.reviews === 1, w);

  f = fake(['SUBJECT: Hi\nBODY:\nWould you like to support the program this season? Call us.'], [PASS]);
  w = await TW.writeAsk(ctx(team), { ai: f });
  ok('a draft the lint refuses never reaches the reviewer', !w.ok && f.seen.review === 0, { w, seen: f.seen });

  const athleteCtx = { ...ctx(team), athlete: { name: 'Riley Stone', facts: ['From Pinecrest'] } };
  f = fake(['SUBJECT: Riley Stone and Harbor Lane Dental\nBODY:\nRiley Stone plays volleyball for us and grew up near Harbor Lane Dental. Would you be open to a few posts together? A short call would be great.'], [PASS]);
  w = await TW.writeAsk(athleteCtx, { ai: f });
  ok('an athlete pitch the office asks for by hand is not reviewed (it reaches no one until staff send it)', w.ok && w.reviews === 0 && f.seen.review === 0, w);

  // ── THE CALL CARD, THE COST CAP, THE ROUTE, THE PAGE ───────────────────
  ok('the call card asks for a paid deal at the school\'s price', /\$1,500 paid to the players/.test(TW.dealAsk(rated, 'Harbor Lane Dental')) && !/back|local partner|support/i.test(TW.dealAsk(rated, 'Harbor Lane Dental')));
  ok('  and with no rate, options with prices', /send options with prices/.test(TW.dealAsk(team, 'Harbor Lane Dental')));
  const scan = fs.readFileSync(REPO + 'server/services/teamScan.js', 'utf8');
  ok('teamScan counts every review call against the night\'s cap', (scan.match(/asks \+= (w|d)\.reviews \|\| 0/g) || []).length === 2);
  ok('  and the call card is the deal, not "the program"', /subject: `a paid NIL deal with the \$\{team\.name\} team`/.test(scan) && /ask: TeamWriter\.dealAsk\(team, c\.brand_name\)/.test(scan));
  const campus = fs.readFileSync(REPO + 'server/routes/campus.js', 'utf8');
  ok('the rate route: staff guard, scoped by the session, read only for admin viewers', /app\.post\('\/api\/university\/market\/team\/rate', guard/.test(campus)
    && /WHERE id = \$3 AND university_id = \$4`,\s*\n?\s*\[cents \|\| null, cents \? what : null, String\(b\.teamId \|\| ''\), req\.staff\.university_id\]/.test(campus)
    && /team\/rate', guard, async \(req, res\) => \{\n\s*if \(req\.staff\.viewingAsAdmin\)/.test(campus));
  ok('the migration adds the two columns, safe to repeat', /ADD COLUMN IF NOT EXISTS nil_rate_cents INTEGER/.test(fs.readFileSync(REPO + 'server/migrations/020_university_team_nil_rate.sql', 'utf8')));
  const page = fs.readFileSync(REPO + 'public/university.html', 'utf8');
  ok('My Teams: the school sets each team\'s rate, and the page says NILDash never does', /NIL deal rate/.test(page) && /data-ratesave/.test(page) && /NILDash never sets the price/.test(page));
  const writer = fs.readFileSync(REPO + 'server/services/teamWriter.js', 'utf8');
  ok('no em dashes in the writer\'s prompts', !/[—]/.test(writer.replace(/\/\/[^\n]*/g, '')));

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
