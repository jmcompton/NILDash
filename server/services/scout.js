'use strict';
// ── THE SCOUT ────────────────────────────────────────────────────────────────
//
// Last night: three pitches across eight athletes, three athletes with nothing.
// An agent with 45 clients going to 80 cannot contact everyone every day, which
// is the entire reason this exists. A Scout that reports "nothing new to work"
// is a product that gets cancelled.
//
// TWO CAUSES, BOTH FIXED HERE.
//
// 1. IT ONLY EVER LOOKED AT ONE LANE. The nightly fill read candidates from
//    brand_engagement WHERE state='shown' -- brands a Deal Scan had already
//    surfaced, local only. If nobody had run a scan lately there were no
//    candidates at all, and social and national sat in separate tabs holding
//    things it could have used. The slate is now assembled across all three
//    lanes at once and the lane is a PROPERTY of a result, not a separate run.
//
// 2. IT RE-READ AN EXHAUSTED LIST. Nothing ever pulled from the pool of
//    businesses the market scan had already discovered but passed over
//    (market_business_seen), so a market went quiet and stayed quiet.
//
// THE QUALITY BAR STILL BINDS. Five is a ceiling, not a quota. Three strong
// beats five with two pieces of filler, and the caller is told which it got.

// Up to five per athlete per night, drawn from wherever the fit is best.
const SLATE_MAX = 5;
// How long a business stays off THIS athlete's slate after a card for it expired
// unworked. Mirrors services/outreachQueue.EXPIRE_COOLDOWN_DAYS; read from the
// environment here too so the two cannot be set apart by a deploy that only
// updates one of them.
const EXPIRE_COOLDOWN_DAYS = parseInt(process.env.OUTREACH_QUEUE_COOLDOWN_DAYS, 10) || 30;

// A lane never takes the whole slate on its own unless the others are empty.
// Without this a market with 200 unworked businesses would crowd out the social
// and national results that are often the better pitch.
//
// STILL HERE, BUT NO LONGER THE ONLY SHAPE RULE. It was the whole of the
// diversity story and it is a weak one: three restaurants, a coffee shop and a
// bar is five local cards inside the cap and is not five different pitches. The
// selection below treats this as a ceiling to respect while it fills for
// CATEGORY spread and the social guarantee.
const LANE_SOFT_CAP = 3;

// ── HOW MANY DIFFERENT KINDS OF BUSINESS THE FIVE SHOULD COVER ─────────────
// A morning of five near-identical pitches is one pitch with five names on it:
// the agent writes the same message five times and learns nothing about which
// angle works. Three distinct categories out of five is the bar -- high enough
// to break up a monoculture, low enough that a market genuinely dominated by
// one kind of business is not forced to reach for a bad fifth candidate.
//
// A TARGET, NOT A QUOTA. When the candidate pool cannot offer three kinds, the
// slate takes what there is and reports the shortfall rather than padding. That
// is the same rule the quality bar has always had here: five is a ceiling.
const MIN_CATEGORIES = parseInt(process.env.SLATE_MIN_CATEGORIES, 10) || 3;

// ── ONE SOCIAL BRAND, WHEN THE FOLLOWING JUSTIFIES IT ──────────────────────
// A social brand is pitched on audience; a local business is pitched on
// proximity. For an athlete with a real following the social lane is often the
// better card, and the fit-ranking alone does not guarantee one gets a slot --
// a deep local market outranks it five times over.
//
// THE THRESHOLD IS THE INDEX'S, NOT A NUMBER INVENTED HERE. store's
// _socialBaseMatch already bands an athlete's reach (instagram + tiktok)
// against each brand's stated tier_min/tier_max, so a non-empty social pool
// already means "some real brand's own stated minimum accepts this athlete".
// This adds a floor under that, because an index row with tier_min = 0 accepts
// anybody: below it, a DM to a national programme competes against athletes
// with ten times the audience for the same slot, and one of five mornings is
// better spent on a business down the road.
const SOCIAL_MIN_REACH = parseInt(process.env.SLATE_SOCIAL_MIN_REACH, 10) || 5000;

// ── A SKIP IS THE ONLY NEGATIVE SIGNAL THE AGENT GIVES FOR FREE ────────────
//
// Nothing read skips. An agent could skip nine coffee shops and be handed a
// tenth, because the slate's only memory was "has this athlete been offered
// this exact business", and every rule in it was additive: fit, proximity,
// sponsorship, NIL-active. There was no way to go down.
//
// THREE EFFECTS, AND THEY ARE DELIBERATELY DIFFERENT SIZES. Read against the
// scale already in this file -- base fit 50, local +6, shown +4, a school
// signal 6/12/18, NIL-active +30:
//
//   the exact business, for that athlete   NEVER AGAIN. Not a penalty: an
//     exclusion, alongside queued and contacted. Re-offering a business the
//     agent has personally turned down is the one outcome no weight should be
//     able to buy back.
//
//   that category, for that athlete        -8 a skip, floor -16.
//     One skip is noise: timing, mood, a bad morning. Two is a preference, and
//     -16 is where that preference lands.
//
//     THE FLOOR IS SET BY WHAT MUST BE ABLE TO CLEAR IT, not by how strongly
//     the preference feels. Our two strongest facts about a specific business
//     are that this agent closed a deal with them at this school (+18) and that
//     the business has an NIL deal logged on the platform (+30). Both have to
//     outrank a disliked category, because they are evidence about THE
//     BUSINESS and the penalty is only evidence about its KIND -- the agent is
//     saying "not this sort, usually", not "never show me a gym again". So the
//     floor sits just under the smaller of the two. At -24, which is where this
//     started, a business the agent had closed with themselves stayed buried,
//     and that is the wrong answer.
//
//     Not decayed: a judgement about what suits one athlete's brand is a
//     durable fact about that athlete, and the cap already stops it
//     compounding.
//
//   that category, for that agent's roster  -3 a skip, floor -9, half-life 21d.
//     Smaller, because a roster-wide pattern is weaker evidence about any one
//     athlete than that athlete's own skips. -9 is about the size of the local
//     bonus plus the shown bonus, so it reorders within a lane and never
//     outranks a real signal. Decayed so one bad week cannot kill a category:
//     five skips in a week is the -9 floor, but three weeks later that same
//     week counts -4.5, and six weeks later -2.2. The half-life lives in
//     store.SKIP_HALF_LIFE_DAYS, applied per row by its own age in SQL.
const SKIP_ATHLETE_PER = parseFloat(process.env.SKIP_ATHLETE_PENALTY) || 8;
const SKIP_ATHLETE_MAX = parseFloat(process.env.SKIP_ATHLETE_PENALTY_MAX) || 16;
const SKIP_AGENT_PER = parseFloat(process.env.SKIP_AGENT_PENALTY) || 3;
const SKIP_AGENT_MAX = parseFloat(process.env.SKIP_AGENT_PENALTY_MAX) || 9;

// ── EVIDENCE OF MARKETING ACTIVITY IS NEARLY A REQUIREMENT NOW ─────────────
// "Sponsors the high school team", "runs local ads", "has done an athlete
// partnership before" -- the scan looks for these and they were worth a ranking
// nudge. A business that has never spent a dollar on marketing is not a
// prospect in the same sense as one that has, and treating the two as the same
// candidate with different scores is how five slots fill with businesses that
// were never going to answer.
//
// So it is a SORT KEY ABOVE FIT, not a bonus: every candidate with evidence is
// considered before any candidate without it, whatever their scores. A thin
// candidate fills a slot only when the evidenced ones have run out -- which is
// exactly "only when nothing better is available" -- and the card it becomes
// says so, rather than presenting it as the same kind of find.
//
// UNKNOWN IS NOT THIN. A candidate whose source never looked for evidence
// (every market-pool row written before has_evidence existed) is ranked with
// the evidenced ones rather than punished for a column that did not exist when
// it was written. Only a candidate we LOOKED at and found nothing for is thin.
const THIN_NOTE = 'No marketing activity found for this business, so this is a '
  + 'thin candidate: it filled a slot because nothing stronger was left tonight.';

// Why an athlete got nothing. A SILENT ZERO IS THE BUG WE SPENT A DAY ON, so
// every empty result carries one of these and the shift report prints it.
const EMPTY = {
  NO_MARKET: 'no-market',
  MARKET_EXHAUSTED: 'market-exhausted',
  BELOW_BAR: 'below-bar',
  SLOTS_FULL: 'slots-full',
  PAUSED: 'paused',
  CAPPED: 'capped-out',
  // NOT EXHAUSTED -- MISSING. The athlete has a market key and the pool has no
  // row under it at all. "Every business has already been worked" is the wrong
  // sentence for that: nothing was worked, the pool is filed under another key
  // (a school slug from before market keys were town-based, usually). Fixable
  // by data, so it is named separately from a market that really is spent.
  NO_POOL_FOR_KEY: 'no-pool-for-key',
  // OURS, NOT THEIRS. A night whose failures were all lookups that threw says
  // nothing about the market, and must never read as one that was worked out.
  FAULT: 'our-fault',
};
const EMPTY_TEXT = {
  [EMPTY.NO_MARKET]: 'no school we could match, so the local lane has no town to work in — and no social or national fit either',
  [EMPTY.MARKET_EXHAUSTED]: 'every business we have found in this market has already been worked, and no social or national brand fit tonight',
  [EMPTY.BELOW_BAR]: 'candidates were found but none cleared the bar, so nothing was queued rather than filling slots with filler',
  [EMPTY.SLOTS_FULL]: 'all slots already hold work you have not actioned yet',
  [EMPTY.PAUSED]: 'paused after repeated nights with nothing to show',
  [EMPTY.CAPPED]: 'the nightly spend cap was reached before this athlete',
  [EMPTY.NO_POOL_FOR_KEY]: 'no businesses are recorded under this athlete\'s market key, so the local lane had nothing to draw from — the pool is probably filed under a different key (run scripts/migrate-market-pool-key.js)',
  [EMPTY.FAULT]: 'every attempt failed on our side, so nothing was learned about this market',
};

function normBrand(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── THE SPONSORSHIP SIGNAL ───────────────────────────────────────────────────
//
// Businesses do not sponsor athletes for ROI, they sponsor because they love the
// university. A dealership that has already done a deal with an athlete at this
// school is a far better target than one that merely has a marketing budget.
//
// THREE SOURCES, AND THEY ARE NOT THE SAME KIND OF EVIDENCE. Labelling them
// identically was the thing to avoid: a card that says "they already sponsor
// Auburn athletes" on the strength of a news article is a claim the agent will
// repeat to a business owner, and it needs to be true.
//
//   deals (agent-closed-at-school)  WE CLOSED IT. We watched it happen, and it
//                                   is almost always a local business. Strongest.
//   brand_engagement (replied)      A business that ANSWERED us for another
//                                   athlete at this school. Real, local, and it
//                                   is what the sponsorship insight is actually
//                                   about -- someone with a tie to the program
//                                   who picked up the phone.
//   deal_comps (reported)           nilCompJob.js is a weekly web search for
//                                   DISCLOSED NIL deals over $1,000. Its
//                                   extraction prompt asks for "collective name
//                                   or brand name", so the table is mostly NIL
//                                   collectives and national brands from
//                                   conference news. That is useful for the
//                                   national lane and it is NOT evidence that a
//                                   business loves the university. Lowest
//                                   weight, worded as a report, and it does not
//                                   boost the local lane at all.
//
// WHAT IS NOT REACHABLE, and is therefore NOT approximated:
//
//   athletic department sponsors   Nothing stores them. program_source holds an
//                                  athletics URL we could scrape a partners page
//                                  from, but no such scrape exists and inferring
//                                  a sponsor from a name would be a guess about
//                                  a real business relationship. PARKED, on
//                                  purpose -- it is the real path to this data.
//   advertisers around the program Signage, radio reads and program ads are not
//                                  on the web in any form we ingest.
const SIGNAL_WEIGHT = {
  'agent-closed-at-school': 18,
  'replied-at-school': 12,
  'reported-deal-at-school': 6,
};
// A reported deal is national-press evidence. It says nothing about whether a
// business is tied to the town, so it must not outrank proximity in the lane
// that is built on proximity.
const LOCAL_LANE_SIGNALS = new Set(['agent-closed-at-school', 'replied-at-school']);

// ── A SIGNAL BELONGS TO THE AGENT WHOSE BOOK IT CAME OUT OF ────────────────
//
// This took (pool, school) and filtered on the school alone. Two agents with
// athletes at the same school share every row these queries read, so the second
// agent inherited the first agent's closes and the first agent's replies -- as
// a ranking boost AND as a sentence written onto the card (sponsor_note).
//
// Two things were wrong with that, and they are different wrongs:
//
//   IT SAID SOMETHING FALSE. 'agent-closed-at-school' renders as "you have
//   already closed a deal with them at Auburn University". Handed to an agent
//   who closed nothing, that is a false claim in the second person, on a card
//   whose whole purpose is to be repeated to a business owner.
//
//   IT DISCLOSED A MAILBOX. 'replied-at-school' reads brand_engagement
//   'responded', which followUpAutomation.markReplied writes from reply capture
//   over an agent's connected Gmail or Outlook. services/brandFlags.js refuses
//   to cross agents with exactly this data, for exactly this reason: "showing a
//   second agent a badge derived from the first agent's inbox is a disclosure of
//   the first agent's mail, however small the badge." The same rule applies
//   here, and it did not hold.
//
// Both agent-derived queries are scoped to the requesting agent now, and the
// function FAILS CLOSED without one: no agentId, no signals. A caller that
// forgets loses a ranking boost, which is a bad night. The alternative default
// leaks a customer's book, which is not a bad night.
//
// deal_comps is the exception and cannot be scoped, because the table has no
// agent column: it is nilCompJob's weekly scrape of publicly disclosed deals
// plus our own closes, and the only agent-derived rows are the ones saveComp
// writes with source='agent-close', which this has always excluded and still
// does. Nothing left in it identifies an agent -- store.saveComp's own note is
// "no athlete name, no agent, no deal id" -- so there is nothing to scope. Said
// out loud here rather than left as a silent asymmetry.
async function schoolSponsorSignals(pool, school, opts = {}) {
  const out = new Map();
  const s = String(school || '').trim();
  if (!s) return out;
  const agentId = opts.agentId == null ? '' : String(opts.agentId).trim();
  if (!agentId) {
    console.error('[scout/signals] no agentId — returning NO signals rather than every agent\'s. '
      + `school=${JSON.stringify(s.slice(0, 60))}`);
    return out;
  }
  const add = (brand, kind, detail) => {
    const k = normBrand(brand);
    if (!k) return;
    const prev = out.get(k);
    const w = SIGNAL_WEIGHT[kind] || 0;
    if (!prev || w > prev.weight) out.set(k, { brand, kind, detail, weight: w });
  };
  const q = async (label, sql, params) => {
    try { return (await pool.query(sql, params)).rows; }
    catch (e) { console.error('[scout/signals] ' + label, e.message); return []; }
  };

  // 1. THIS AGENT'S OWN closed deals for THEIR athletes at this school. Both
  //    sides are checked -- the deal's agent_id and the athlete's -- because the
  //    note says "you", and "you" has to be true of the person reading it. Both
  //    columns are NOT NULL (store.js), so neither check can be satisfied by a
  //    missing value.
  for (const r of await q('deals',
    `SELECT DISTINCT d.data->>'brand' AS brand
       FROM deals d JOIN athletes a ON a.id = d.athlete_id
      WHERE d.data->>'stage' = 'Closed' AND d.data->>'brand' IS NOT NULL
        AND LOWER(a.data->>'school') = LOWER($1)
        AND d.agent_id = $2 AND a.agent_id = $2
      LIMIT 200`, [s, agentId])) {
    add(r.brand, 'agent-closed-at-school', `you have already closed a deal with them at ${s}`);
  }

  // 2. A business that answered THIS AGENT for another of THEIR athletes at this
  //    school. This is the mailbox-derived one, so it is the one that must never
  //    cross: 'responded' is written by followUpAutomation.markReplied out of a
  //    connected Gmail or Outlook.
  //
  //    The athlete's owner is the authority (athletes.agent_id is NOT NULL);
  //    brand_engagement.agent_id is NULLABLE, so it is checked as "not somebody
  //    else's" rather than trusted as "is mine". A row whose recorded agent
  //    disagrees with the athlete's owner is an anomaly and is excluded rather
  //    than resolved in this agent's favour.
  for (const r of await q('engaged',
    `SELECT DISTINCT be.brand_name AS brand, be.state
       FROM brand_engagement be JOIN athletes a ON a.id = be.athlete_id
      WHERE be.state IN ('responded','closed') AND be.brand_name IS NOT NULL
        AND LOWER(a.data->>'school') = LOWER($1)
        AND a.agent_id = $2
        AND (be.agent_id IS NULL OR be.agent_id = $2)
      LIMIT 200`, [s, agentId])) {
    add(r.brand, 'replied-at-school', r.state === 'closed'
      ? `has closed a deal with another ${s} athlete`
      : `replied to outreach for another ${s} athlete`);
  }

  // 3. A DISCLOSED deal reported publicly. Matched on school loosely, because
  //    deal_comps carries whatever the source called it. Worded as what it is: a
  //    report, not a relationship we can vouch for.
  //
  //    NOT SCOPED, AND IT IS THE ONE THAT DOES NOT NEED TO BE. deal_comps has no
  //    agent column; it holds nilCompJob's weekly scrape of deals disclosed in
  //    the press. The only rows that ever came out of an agent's own book are
  //    the ones store.saveComp writes with source='agent-close', excluded here
  //    since before this change -- they are already source 1, at a much higher
  //    weight, and counting them twice would launder our own close into "the
  //    market says so". Trimmed and lower-cased now so the exclusion cannot be
  //    walked past by whitespace or casing.
  for (const r of await q('comps',
    `SELECT DISTINCT brand FROM deal_comps
      WHERE brand IS NOT NULL AND brand <> ''
        AND LOWER(TRIM(COALESCE(source,''))) <> 'agent-close'
        AND (LOWER(school) = LOWER($1) OR LOWER(school) LIKE '%' || LOWER($2) || '%')
      LIMIT 400`, [s, s.replace(/\s*(university|college)\s*/ig, ' ').trim()])) {
    add(r.brand, 'reported-deal-at-school',
      `publicly reported an NIL deal with an athlete at ${s}`);
  }
  return out;
}

// ── Candidate pools, per lane ────────────────────────────────────────────────
// LOCAL BINDS TO THE SCHOOL CITY. Social and national do not: a brand that ships
// product does not care where the athlete lives. That rule is enforced here by
// which pools are consulted at all, not by filtering afterwards.
async function localCandidates(pool, { agentId, athlete, limit }) {
  if (!athlete.hasLocalMarket) return { rows: [], exhausted: false, reason: EMPTY.NO_MARKET };
  const q = async (label, sql, params) => {
    try { return (await pool.query(sql, params)).rows; }
    catch (e) { console.error('[scout/local] ' + label, e.message); return []; }
  };

  // a. Brands a scan already surfaced for this athlete and nobody has queued.
  // AN UNKNOWN LANE IS NOT A LOCAL LANE. This read
  //   COALESCE(be.lane,'local') = 'local'
  // so every brand_engagement row whose lane was never recorded was claimed by
  // the local pool. brand_engagement.lane is nullable with no default
  // (store.js), and a Deal Scan that does not stamp one leaves it NULL -- so
  // Liquid I.V., a national DTC brand, entered the local lane for Kaden House,
  // Amber Bretton and Marcus Johnson at once, one NULL row each. From there the
  // local path runs a Places lookup on the brand name, resolves the corporate
  // HQ, and the card reads "Local · Sunnyvale" for an athlete in Maryland.
  //
  // The honest state for a brand whose lane was never determined is UNKNOWN, and
  // unknown is excluded rather than assumed in. This SHRINKS the local pool and
  // pushes some athletes into the empty-slate skip. That is the intended trade:
  // an honest gap beats a wrong pitch sent under the agent's own name.
  const shown = await q('shown',
    `SELECT be.brand_key, be.brand_name, be.lane, 'shown' AS pool
       FROM brand_engagement be
      WHERE be.athlete_id = $1 AND be.state = 'shown'
        AND be.lane = 'local'
        AND NOT EXISTS (SELECT 1 FROM outreach_queue q
                         WHERE q.athlete_id = be.athlete_id AND q.brand_key = be.brand_key)
      ORDER BY be.last_shown_at DESC NULLS LAST
      LIMIT $2`, [athlete.id, limit * 3]);

  // b. THE POOL THAT WAS NEVER READ. Businesses the market scan discovered and
  //    passed over, plus any discovered since. This is what stops a market going
  //    quiet: the scan found them, we simply never came back to them.
  // brand_key IS NULL, DELIBERATELY. This read `m.brand AS brand_key`, which is
  // a lie about what a brand_key is: market_business_seen is PRIMARY KEY
  // (market_key, brand) and holds no stable identifier at all. Every consumer
  // that later compared brand_key inherited a display name pretending to be an
  // identity -- including draftPrewarm's one-draft-per-brand index, which is why
  // the same business could be drafted twice. The market_key travels instead, so
  // brandIdentity can build an honest name-plus-market key from it.
  const seen = athlete.marketKey ? await q('seen',
    `SELECT m.brand AS brand_name, NULL::text AS brand_key, $1::text AS market_key,
            'market-pool' AS pool,
            -- The scan knew both of these and the table used to drop them. NULL
            -- on rows written before, and NULL means UNKNOWN: an uncategorised
            -- business is not a category, and unknown evidence is not thin.
            m.category, m.has_evidence
       FROM market_business_seen m
      WHERE m.market_key = $1
        -- ── A BRAND FELL THROUGH BOTH POOLS AND VANISHED ───────────────────
        -- This excluded a brand with ANY brand_engagement row, at any state.
        -- The shown pool above requires lane = 'local' and deliberately drops
        -- a NULL lane as unknown. So a brand carrying a lane-NULL 'shown' row --
        -- which is what a Deal Scan that did not stamp a lane leaves behind --
        -- was excluded HERE for having a ledger row and excluded THERE for not
        -- having a lane. It was invisible to the local lane permanently.
        --
        -- That is why widening changed nothing: the businesses a widen finds are
        -- the ones a scan already showed, so every one of the ten recorded in
        -- the pool was cancelled out by its own ledger row and the slate came
        -- back 0 local.
        --
        -- "Shown" is precisely the case this pool exists to recover: a scan
        -- found it and nobody came back to it. Only a brand this athlete has
        -- actually been WORKED on is excluded now -- the same states the slate's
        -- own prior-exclusion uses, so the two agree. Anything queued is still
        -- caught by the outreach_queue clause below and by that prior-exclusion.
        AND NOT EXISTS (SELECT 1 FROM brand_engagement be
                         WHERE be.athlete_id = $2 AND LOWER(be.brand_name) = LOWER(m.brand)
                           AND be.state IN ('contacted','replied','closed','retired'))
        AND NOT EXISTS (SELECT 1 FROM outreach_queue q
                         WHERE q.athlete_id = $2 AND LOWER(q.brand_name) = LOWER(m.brand))
        -- ── A NATIONAL BRAND IS NOT IN A TOWN ──────────────────────────────
        -- The Deal Scan route wrote this pool for WHATEVER lane it had just
        -- run, so a social or Top NIL scan filed its national brands under the
        -- athlete's town key. This lane then labelled them local "by
        -- construction", and Nike, Liquid I.V. and Barstool Sports appeared in
        -- Messiah Mickens's LOCAL lane for Blacksburg -- where the local path
        -- runs a Places lookup on the name and resolves a corporate HQ.
        --
        -- The writer is fixed, but rows written before that are still in the
        -- table. social_brands is the index that says what a national brand IS,
        -- so it is asked here rather than the contamination being migrated out:
        -- self-healing, and it holds if the writer ever regresses.
        AND NOT EXISTS (SELECT 1 FROM social_brands sb
                         WHERE LOWER(sb.brand) = LOWER(m.brand))
      ORDER BY m.last_seen_at DESC NULLS LAST
      LIMIT $3`, [athlete.marketKey, athlete.id, limit * 4]) : [];

  // EACH POOL EARNS ITS LANE, rather than everything being stamped local on the
  // way out. The blanket `lane: 'local'` here was the second of four places that
  // turned "we do not know" into "it is local".
  //
  //   shown        carries be.lane, and the WHERE above already restricts that
  //                to 'local'. Read from the row rather than reasserted, so if
  //                that filter is ever loosened this does not silently relabel.
  //   market-pool  local BY CONSTRUCTION: the row exists because a market scan
  //                for THIS market_key found it, and the query is scoped to
  //                athlete.marketKey (canonicalRegion of the athlete's market),
  //                so a business found scanning one market cannot surface as a
  //                candidate in another.
  //
  // Anything that somehow arrives with no lane is dropped, not defaulted.
  const rows = [];
  const seenKeys = new Set();
  const laneless = [];
  const placeholders = [];
  // The ledger and the pool are gated at their writers now, but rows written
  // before that are still in both tables; the slate refuses them by name so a
  // description of a business ("Local Auburn Gym (independent)") cannot be
  // handed a slot whatever table it came from.
  let placeholderReason = null;
  try { placeholderReason = require('../store').placeholderReason; } catch (_) { placeholderReason = null; }
  for (const r of shown.concat(seen)) {
    const k = normBrand(r.brand_name);
    if (!k || seenKeys.has(k)) continue;
    if (placeholderReason && placeholderReason(r.brand_name)) { placeholders.push(r.brand_name); continue; }
    const lane = r.pool === 'market-pool' ? 'local' : (r.lane || null);
    if (lane !== 'local') { laneless.push(r.brand_name); continue; }
    seenKeys.add(k);
    rows.push({ ...r, lane });
  }
  if (laneless.length) {
    console.log(`[scout/local] athlete=${athlete.id} dropped ${laneless.length} candidate(s) with no `
      + `recorded lane: ${laneless.slice(0, 5).join(', ')}`);
  }
  if (placeholders.length) {
    console.log(`[scout/local] athlete=${athlete.id} refused ${placeholders.length} placeholder name(s), not real businesses: `
      + placeholders.slice(0, 5).map((s) => JSON.stringify(String(s).slice(0, 48))).join(', '));
  }
  // Exhausted means BOTH pools are dry, which is the signal to widen the radius
  // on the next market build rather than to give up.
  return { rows, exhausted: rows.length === 0, reason: rows.length ? null : EMPTY.MARKET_EXHAUSTED };
}

// A social or national result is reached through the brand's own athlete-program
// page, NEVER through a Places lookup -- that is the local lane, and pointing it
// at a national brand resolves it to whatever storefront happens to be nearby.
// So both lanes carry their program page with them, and a candidate without one
// is rejected by name later rather than queued as something un-actionable.
function programFacts(b) {
  return {
    programUrl: b.proof_url || b.programUrl || b.website || null,
    website: b.website || null,
    category: b.category || null,
    offerSummary: b.offer_summary || b.offerSummary || null,
    dealStructure: b.deal_structure || b.dealStructure || null,
  };
}

async function socialCandidates(pool, { athlete, limit, store }) {
  if (!store || typeof store.getSocialBrandPool !== 'function') return [];
  try {
    const rows = await store.getSocialBrandPool(athlete);
    return (rows || []).slice(0, limit * 3).map((b) => ({
      brand_key: b.brandKey || normBrand(b.brand), brand_name: b.brand,
      lane: 'social', pool: 'social-index', fitHint: b.fitScore || null, why: b.whyFits || null,
      ...programFacts(b),
    }));
  } catch (e) { console.error('[scout/social]', e.message); return []; }
}

async function nationalCandidates(pool, { limit, store }) {
  if (!store || typeof store.getTopNilComps !== 'function') return [];
  let rows = [];
  try { rows = (await store.getTopNilComps(limit * 2, 2)) || []; }
  catch (e) { console.error('[scout/national]', e.message); return []; }
  if (!rows.length) return [];

  // Deal comps prove a brand SPENDS on NIL. They do not tell us where to apply.
  // The verified index does, so attach the program page in one pass; anything
  // with no page still comes through, carrying programUrl: null, so the reason
  // it cannot be pitched is recorded rather than silently dropped here.
  const byBrand = new Map();
  try {
    const r = await pool.query(
      `SELECT brand, website, proof_url, category, offer_summary, deal_structure
         FROM social_brands WHERE active = true AND LOWER(brand) = ANY($1::text[])`,
      [rows.map((b) => String(b.brand || '').toLowerCase())]);
    for (const row of r.rows) byBrand.set(normBrand(row.brand), row);
  } catch (e) { console.error('[scout/national-index]', e.message); }

  return rows.map((b) => {
    const idx = byBrand.get(normBrand(b.brand));
    return {
      brand_key: b.brandKey || normBrand(b.brand), brand_name: b.brand,
      lane: 'national', pool: 'deal-comps',
      why: b.why || (b.count ? `${b.count} logged NIL deal${b.count === 1 ? '' : 's'}` : null),
      ...programFacts(idx || {}),
    };
  });
}

// ── The slate ────────────────────────────────────────────────────────────────
// One mixed list, ranked across lanes. Lane is a property of a result.
const BI = require('./brandIdentity');

async function assembleSlate(pool, ctx) {
  const { agentId, athlete, store } = ctx;
  const limit = ctx.limit || SLATE_MAX;

  // The agent is passed, not implied: these signals are that agent's own deal
  // and reply history, and without an agentId the function returns none.
  const signals = await schoolSponsorSignals(pool, athlete.school, { agentId });
  const local = await localCandidates(pool, { agentId, athlete, limit });
  let social = await socialCandidates(pool, { athlete, limit, store });
  let national = await nationalCandidates(pool, { limit, store });

  // ── A CANDIDATE THAT CANNOT SUCCEED DOES NOT GET A SLOT ──────────────────
  // Jeremiah Wilkinson: twelve attempts, all social or national, nine rejected
  // as "already holding 1 program application, which is the cap". The cap was
  // checked per attempt, AFTER the slate had already handed those brands the
  // athlete's twelve chances -- so the local lane, with 241 businesses behind
  // it, never got a turn. The cap is known before the slate is built (the job
  // counts held cards first), so it is applied here, where it costs nothing.
  //
  // Two kinds of un-winnable candidate:
  //   program-only  it carries a program page and the athlete's program slot is
  //                 already held. It can only become a program card. Dropped.
  //   no handle     it has no page AND a handle search already ran and found
  //                 nothing (cached). Its only route is a DM, and asking again
  //                 re-spends for the same answer. Dropped.
  // A social/national brand with no page and NO cached answer still enters:
  // that one search is how a DM candidate is discovered at all.
  const dropped = { programCapped: 0, noHandleCached: 0 };
  const held = Number(ctx.heldPrograms) || 0;
  const cap = Number(ctx.programCap) || 0;
  const programSlotHeld = cap > 0 && held >= cap;
  if (programSlotHeld || (store && typeof store.getBrandEvidence === 'function')) {
    const IG = require('./instagramLookup');
    const keep = async (c) => {
      if (programSlotHeld && c.programUrl) { dropped.programCapped++; return false; }
      if (!c.programUrl && typeof IG.cachedVerdict === 'function') {
        const v = await IG.cachedVerdict(store, { website: c.website, brand: c.brand_name, loc: athlete.market || null });
        if (v === 'none') { dropped.noHandleCached++; return false; }
      }
      return true;
    };
    const filt = async (rows) => { const out = []; for (const c of rows) if (await keep(c)) out.push(c); return out; };
    social = await filt(social);
    national = await filt(national);
    if (dropped.programCapped || dropped.noHandleCached) {
      console.log(`[slate] athlete=${athlete.id} dropped before ranking: `
        + `${dropped.programCapped} program-only (slot held ${held}/${cap}), `
        + `${dropped.noHandleCached} with a cached no-handle answer`);
    }
  }

  // ── WHAT EACH LANE ACTUALLY RETURNED ─────────────────────────────────────
  // Recorded on the slate so the run row can carry it. "all twelve were social"
  // used to be a fact recoverable only from the process log; now the question
  // "did the local lane return zero rows, and why" is answerable from the
  // database the morning after.
  const lanes = {
    local: { rows: local.rows.length, reason: local.reason || null, marketKey: athlete.marketKey || null,
      hasLocalMarket: !!athlete.hasLocalMarket },
    social: social.length, national: national.length,
  };

  const all = local.rows.concat(social, national);
  if (!all.length) {
    // Say WHICH kind of empty. "no market" and "market exhausted" are different
    // problems with different fixes, and a bare zero told us neither.
    let reason = !athlete.hasLocalMarket ? EMPTY.NO_MARKET : EMPTY.MARKET_EXHAUSTED;
    // And "exhausted" must not be said of a pool that was never there. One
    // cheap count, only on this path: if the athlete's key has NO rows at all,
    // the pool is filed under another key -- a data problem with a script for
    // it, not a market that has been worked out.
    if (reason === EMPTY.MARKET_EXHAUSTED && athlete.marketKey) {
      try {
        const n = await pool.query(`SELECT COUNT(*)::int AS n FROM market_business_seen WHERE market_key = $1`, [athlete.marketKey]);
        if (n.rows[0] && n.rows[0].n === 0) reason = EMPTY.NO_POOL_FOR_KEY;
        lanes.local.poolRowsUnderKey = n.rows[0] ? n.rows[0].n : null;
      } catch (_) { /* the count is diagnostic; its failure must not empty the slate twice */ }
    }
    return { picks: [], laneCounts: {}, emptyReason: reason, emptyText: EMPTY_TEXT[reason],
      signalCount: signals.size, localExhausted: local.exhausted, lanes, dropped };
  }

  // ── A BUSINESS THAT HAS DONE THIS BEFORE IS THE BETTER TARGET ────────────
  // Across every agent: one that has signed a deal logged on NILDash outranks
  // one that has answered a pitch, which outranks one that has done neither
  // (services/brandFlags). Matched on Place ID or root domain only, so a
  // same-named business in another state earns nothing from it.
  //
  // IT IS A NUDGE, NOT AN OVERRIDE. The bonus sits on top of fit, so a
  // NIL-active business that does not suit this athlete's market still loses
  // to one that does -- which is the whole point of ranking on fit first.
  // Nothing about whose deal it was travels with it: the slate sees two
  // booleans.
  const BF = require('./brandFlags');
  let flagIndex = new Map();
  try {
    const keys = [];
    for (const c of all) keys.push(...BF.crossAgentKeys(c));
    flagIndex = await BF.loadFlagIndex(pool, keys);
  } catch (e) { console.error('[slate] brand flags:', e.message); }

  // Rank. The sponsorship boost applies across ALL lanes: a brand that has done
  // a deal at this school is the better target whether it is the coffee shop
  // down the road or a national program.
  // ── WHAT THE AGENT HAS ALREADY TURNED DOWN ───────────────────────────────
  // One read, three uses: the exact businesses this athlete's agent skipped for
  // them, this athlete's category counts, and the agent's decayed counts across
  // the whole roster. Absent (or unreadable) means no penalty, never a crash.
  let skips = { identities: new Set(), athleteCats: new Map(), agentCats: new Map() };
  if (store && typeof store.loadSkipSignals === 'function') {
    try { skips = await store.loadSkipSignals(agentId, athlete.id); }
    catch (e) { console.error('[slate] skip signals:', e.message); }
  }

  const BC = require('./businessCategory');
  const ranked = all.map((c) => {
    let sig = signals.get(normBrand(c.brand_name)) || null;
    // A publicly reported deal does not boost the LOCAL lane. It is national
    // press evidence about a collective or a national brand, and letting it
    // outrank a business that is actually down the road would be the same
    // category error as pitching a national brand a storefront appearance.
    if (sig && c.lane === 'local' && !LOCAL_LANE_SIGNALS.has(sig.kind)) sig = null;
    let fit = Number(c.fitHint) || 50;
    if (c.lane === 'local') fit += 6;          // proximity is real, and modest
    if (c.pool === 'shown') fit += 4;          // a scan already thought so
    if (sig) fit += sig.weight;
    const nilFlags = BF.flagsFrom(flagIndex, c);
    fit += BF.rankBonus(nilFlags);

    // The kind of business, from whatever the candidate carries -- a stored
    // category, a Places type, or last of all the name. null when we cannot
    // tell, and null is never treated as a category.
    const cat = BC.categoryOf(c);

    // ── AND THEN IT CAN GO DOWN ────────────────────────────────────────────
    const pen = { athlete: 0, agent: 0, category: cat.category };
    if (cat.category) {
      const mine = skips.athleteCats.get(cat.category) || 0;
      if (mine > 0) pen.athlete = Math.min(mine * SKIP_ATHLETE_PER, SKIP_ATHLETE_MAX);
      const across = skips.agentCats.get(cat.category) || 0;
      if (across > 0) pen.agent = Math.min(across * SKIP_AGENT_PER, SKIP_AGENT_MAX);
      fit -= pen.athlete + pen.agent;
    }

    // Evidence of marketing activity: TRUE, FALSE or unknown. A sponsorship
    // signal or a logged NIL deal IS evidence of marketing activity -- stronger
    // evidence than a scan note, since we watched it happen -- so either one
    // answers the question on its own.
    let evidenced = null;
    if (c.has_evidence === true || c.hasEvidence === true) evidenced = true;
    else if (c.has_evidence === false || c.hasEvidence === false) evidenced = false;
    if (evidenced !== true && (sig || (nilFlags && nilFlags.nilActive))) evidenced = true;
    // A social or national candidate reached us through its own athlete
    // programme page. Running a programme IS marketing activity.
    if (evidenced !== true && c.lane !== 'local' && c.programUrl) evidenced = true;

    return { ...c, fit, sponsorSignal: sig, nilFlags,
      businessCategory: cat.category, categoryFromName: cat.nameOnly,
      evidenced, thin: evidenced === false, skipPenalty: pen };
  }).sort((a, b) => {
    // EVIDENCE FIRST, THEN FIT. Not a weight -- a sort key above fit, which is
    // what makes a thin candidate "only when nothing better is available"
    // rather than "when its score happens to fall below".
    if (a.thin !== b.thin) return a.thin ? 1 : -1;
    return b.fit - a.fit;
  });

  // ONE BUSINESS, ONE SLOT. A brand can legitimately reach us down two lanes at
  // once -- the same company can sit in the local market pool AND in the
  // national deal-comp index, which is exactly what a school-sponsor boost
  // makes more likely, not less. Without this the athlete gets two pitches to
  // the same owner on the same night. Deduped after ranking so the surviving
  // copy is the one with the better score and its lane label.
  // IDENTITY, NOT THE DISPLAY NAME. This compared
  //   normBrand(c.brand_name) || normBrand(c.brand_key)
  // which preferred the one field that varies and used brand_key only as a
  // fallback -- so two rows carrying the SAME place_id under "Cahaba Brewing
  // Company" and "Cahaba Brewing Co." were two businesses as far as this loop
  // was concerned. normBrand collapsed 0 of 9 realistic variant pairs.
  //
  // brandIdentity.dedupe matches on ANY shared identity -- place_id, root
  // domain, or normalised name plus market -- which is what makes the two-pool
  // case work: brand_engagement supplies a place_id and the market pool supplies
  // only a name, and comparing strongest-to-strongest they never touch.
  const deduped = BI.dedupe(ranked, { market: athlete.marketKey || null });
  const scored = deduped.kept.filter((c) => c.brand_name || c.brand_key);
  const collapsed = deduped.collapses.length;
  // EVERY collapse, named. Both names, both keys, both pools and which basis
  // decided it, so the name fallback can be judged on evidence rather than
  // trusted -- if it is quietly merging businesses that are not the same, these
  // lines are where that shows up first.
  for (const x of deduped.collapses) console.log(BI.describeCollapse(x, 'slate'));
  if (collapsed) {
    const byBasis = {};
    for (const x of deduped.collapses) byBasis[x.basis] = (byBasis[x.basis] || 0) + 1;
    console.log(`[slate] athlete=${athlete.id} collapsed ${collapsed} duplicate(s): `
      + Object.entries(byBasis).map(([b, n]) => `${n} on ${b}`).join(', '));
  }

  // ── AND NOT ONE THIS ATHLETE HAS ALREADY HAD ─────────────────────────────
  // The pool queries exclude on exact lowercase strings, which is the same
  // weakness as the slate dedupe and fails on exactly the same variants: a
  // business queued last night as "Cahaba Brewing Co." does not match a market
  // pool row reading "Cahaba Brewing Company", so it comes back tonight.
  //
  // Compared on identity, so a name variant cannot walk past it. Scoped to the
  // athlete, because a business one athlete has been pitched is still a fair
  // target for another.
  let priorKeys = new Set();
  try {
    const prior = (await pool.query(
      `SELECT brand_name, brand_key, identity_key, 'queued' AS why
         FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued'
       UNION ALL
       -- ── THE COOLDOWN ON A RETIRED CARD ────────────────────────────────
       -- An expired card frees its slot, which is the point. Without this line
       -- it would also become immediately re-offerable: the same business back
       -- on the slate the very next run, paid for again, expiring again seven
       -- days later. A treadmill that costs money and never produces a deal.
       SELECT brand_name, brand_key, identity_key, 'expired' AS why
         FROM outreach_queue
        WHERE athlete_id = $1 AND state = 'expired'
          AND COALESCE(expired_at, updated_at, created_at) > NOW() - ($2 || ' days')::interval
       UNION ALL
       SELECT brand_name, brand_key, NULL AS identity_key, 'contacted' AS why
         FROM brand_engagement
        WHERE athlete_id = $1 AND state IN ('contacted','replied','closed','retired')`,
      [athlete.id, String(ctx.expireCooldownDays || EXPIRE_COOLDOWN_DAYS)])).rows;
    for (const r of (prior || [])) {
      if (r.identity_key) { priorKeys.add(r.identity_key); continue; }
      for (const id of BI.identitiesOf(r, { market: athlete.marketKey || null })) priorKeys.add(id.key);
    }
  } catch (e) { console.error('[slate] prior lookup:', e.message); }
  // ── AND NOT ONE THEY SKIPPED ───────────────────────────────────────────
  // Joined to the same exclusion set rather than given a penalty of its own,
  // because it is the same kind of fact: this athlete has had this business and
  // the answer was no. A skip is a firmer no than an expiry -- the agent looked
  // at it and declined -- so it has no cooldown and does not come back.
  const skipKeysKnown = skips.identities.size;
  for (const k of skips.identities) priorKeys.add(k);

  const beforePrior = scored.length;
  const fresh = [];
  for (const c of scored) {
    const ids = BI.identitiesOf(c, { market: athlete.marketKey || null });
    const clash = ids.find((id) => priorKeys.has(id.key));
    if (clash) {
      console.log(`[slate] athlete=${athlete.id} skipping "${c.brand_name}" — already queued or `
        + `contacted for this athlete (matched ${clash.key}, basis=${clash.basis}, pool=${c.pool || c.lane})`);
      continue;
    }
    fresh.push(c);
  }
  const repeats = beforePrior - fresh.length;
  if (repeats) console.log(`[slate] athlete=${athlete.id} dropped ${repeats} business(es) already seen by this athlete`);

  // ── THE FIVE, CHOSEN FOR SHAPE AS WELL AS SCORE ──────────────────────────
  // `fresh` is already ordered evidenced-before-thin, then by fit. Taking the
  // top five off it gives the best five candidates and frequently the same five
  // kinds of business, which is one pitch with five names on it.
  //
  // Four rules, in the order they bind:
  //
  //   1. THE SOCIAL SEAT, when the athlete's reach justifies one. Taken first
  //      because a deep local market outranks every social brand five times
  //      over, so a seat reserved after the fact is never available.
  //   2. THE BEST CANDIDATE, always. Whatever else is true, the top-ranked
  //      candidate gets a slot: a diversity rule that can bump the single best
  //      business of the night is worse than the monoculture it fixes.
  //   3. CATEGORY SPREAD to MIN_CATEGORIES, by preferring the best candidate in
  //      a kind not yet represented. A candidate whose category is UNKNOWN can
  //      never satisfy this -- two businesses we know nothing about are not
  //      demonstrably two kinds -- but it is still eligible for a seat.
  //   4. THE LANE CEILING still applies while filling, and is dropped in the
  //      final top-up rather than leaving the slate short.
  //
  // EVERY RULE YIELDS TO THE EVIDENCE ORDER. Filling for spread never reaches
  // past an evidenced candidate to a thin one, because each pass walks `fresh`
  // in order and thin candidates sit at the end of it.
  const picks = [];
  const chosen = new Set();
  const perLane = {};
  const cats = new Set();
  const shape = { socialSeat: null, spreadPicks: 0, categories: 0, laneCapHit: 0 };

  const laneOk = (c) => (perLane[c.lane] || 0) < LANE_SOFT_CAP;
  const take = (c, why) => {
    if (!c || chosen.has(c) || picks.length >= limit) return false;
    chosen.add(c); picks.push(c);
    perLane[c.lane] = (perLane[c.lane] || 0) + 1;
    if (c.businessCategory) cats.add(c.businessCategory);
    if (why === 'spread') shape.spreadPicks++;
    return true;
  };

  // 1. The social seat. `reach` is the same figure store._socialBaseMatch bands
  //    against each brand's stated tier, so "enough following" means the same
  //    thing here as it does where the pool is built.
  const reach = (Number(athlete.instagram) || 0) + (Number(athlete.tiktok) || 0);
  const socialEligible = reach >= SOCIAL_MIN_REACH;
  if (socialEligible && limit > 0) {
    const best = fresh.find((c) => c.lane === 'social');
    if (best) { take(best, 'social'); shape.socialSeat = best.brand_name; }
  }
  shape.socialEligible = socialEligible;
  shape.reach = reach;

  // 2. The best candidate overall.
  take(fresh[0], 'top');

  // 3. Spread: fill the remaining seats preferring an unrepresented category,
  //    then fall back to rank order.
  while (picks.length < limit) {
    let next = null;
    if (cats.size < MIN_CATEGORIES) {
      next = fresh.find((c) => !chosen.has(c) && c.businessCategory
        && !cats.has(c.businessCategory) && laneOk(c));
    }
    if (!next) next = fresh.find((c) => !chosen.has(c) && laneOk(c));
    if (!next) break;
    take(next, cats.has(next.businessCategory) ? 'rank' : 'spread');
  }

  // 4. Short only because of the lane ceiling: fill from what is left rather
  //    than hand back four when five were available.
  if (picks.length < limit) {
    for (const c of fresh) {
      if (picks.length >= limit) break;
      if (chosen.has(c)) continue;
      shape.laneCapHit++;
      take(c, 'over-cap');
    }
  }

  shape.categories = cats.size;
  shape.categoryList = [...cats];
  shape.thin = picks.filter((p) => p.thin).length;
  shape.unknownCategory = picks.filter((p) => !p.businessCategory).length;
  // SAY WHEN THE SHAPE COULD NOT BE MET, rather than quietly returning five of
  // one kind. Both of these are facts about the market, not failures, and the
  // morning report can repeat them.
  if (picks.length && cats.size < MIN_CATEGORIES) {
    shape.spreadShortfall = `only ${cats.size} distinct categor${cats.size === 1 ? 'y' : 'ies'} `
      + `available across ${fresh.length} candidate(s)`;
    console.log(`[slate] athlete=${athlete.id} category spread short: ${shape.spreadShortfall}`);
  }
  if (socialEligible && !shape.socialSeat) {
    shape.socialShortfall = `reach ${reach} clears ${SOCIAL_MIN_REACH} but no social candidate was available`;
    console.log(`[slate] athlete=${athlete.id} ${shape.socialShortfall}`);
  }
  if (shape.thin) {
    console.log(`[slate] athlete=${athlete.id} ${shape.thin} of ${picks.length} pick(s) are THIN `
      + '(no marketing activity found); they filled slots nothing stronger was left for');
  }
  if (skipKeysKnown || skips.athleteCats.size || skips.agentCats.size) {
    const penalised = picks.filter((p) => p.skipPenalty && (p.skipPenalty.athlete || p.skipPenalty.agent));
    // COUNTED, NOT ASSUMED. This printed the size of the skip set, which is how
    // many businesses the agent has ever skipped -- not how many were on
    // tonight's slate to exclude. The two are rarely the same number and the
    // difference is the whole question "did the skip actually bite".
    const reallyExcluded = ranked.filter((c) => BI.identitiesOf(c, { market: athlete.marketKey || null })
      .some((id) => skips.identities.has(id.key))).length;
    console.log(`[slate] athlete=${athlete.id} skip history: ${skipKeysKnown} business(es) skipped before, `
      + `${reallyExcluded} of them on tonight's slate and excluded, `
      + `${skips.athleteCats.size} categor(ies) penalised for this athlete, `
      + `${skips.agentCats.size} across the roster`
      + (penalised.length ? `; still picked: ${penalised.map((p) => `${p.brand_name} (-${(p.skipPenalty.athlete + p.skipPenalty.agent).toFixed(1)})`).join(', ')}` : ''));
  }

  const laneCounts = picks.reduce((m, p) => { m[p.lane] = (m[p.lane] || 0) + 1; return m; }, {});
  const out = {
    picks, laneCounts, emptyReason: null, emptyText: null, lanes, dropped, shape,
    signalCount: signals.size,
    boosted: picks.filter((p) => p.sponsorSignal).length,
    collapsed,
    localExhausted: local.exhausted,
  };
  // ── SHOW YOUR WORKING, ON REQUEST ────────────────────────────────────────
  // Off by default and read-only: the selection above is untouched by it. What
  // it adds is everything the ranking SAW, not just what it picked -- which is
  // the only way to answer "why did that business not make the cut" or to
  // compare this ranking against the one it replaced. scripts/
  // slate-before-after.js is the caller.
  if (ctx && ctx.explain) {
    const slim = (c, extra) => Object.assign({
      brand: c.brand_name, lane: c.lane, pool: c.pool, fit: Math.round(c.fit * 100) / 100,
      category: c.businessCategory, categoryFromName: !!c.categoryFromName,
      evidenced: c.evidenced, thin: !!c.thin,
      signal: c.sponsorSignal ? c.sponsorSignal.kind : null,
      nilActive: !!(c.nilFlags && c.nilFlags.nilActive),
      skipPenalty: c.skipPenalty || { athlete: 0, agent: 0 },
    }, extra || {});
    out.considered = fresh.map((c) => slim(c, { picked: chosen.has(c) }));
    // The ones the skip history removed outright, which never reach `fresh` and
    // would otherwise be invisible in a comparison.
    out.excludedBySkip = ranked
      .filter((c) => BI.identitiesOf(c, { market: athlete.marketKey || null })
        .some((id) => skips.identities.has(id.key)))
      .map((c) => slim(c, { picked: false, excluded: 'skipped by this agent for this athlete' }));
    out.weights = {
      base: 50, local: 6, shown: 4, signal: SIGNAL_WEIGHT, nilActive: 30,
      skipAthletePer: SKIP_ATHLETE_PER, skipAthleteMax: SKIP_ATHLETE_MAX,
      skipAgentPer: SKIP_AGENT_PER, skipAgentMax: SKIP_AGENT_MAX,
      minCategories: MIN_CATEGORIES, socialMinReach: SOCIAL_MIN_REACH, laneSoftCap: LANE_SOFT_CAP,
    };
  }
  return out;
}

module.exports = {
  assembleSlate, schoolSponsorSignals, localCandidates, socialCandidates, nationalCandidates,
  normBrand, SLATE_MAX, LANE_SOFT_CAP, EMPTY, EMPTY_TEXT, SIGNAL_WEIGHT,
  EXPIRE_COOLDOWN_DAYS,
  MIN_CATEGORIES, SOCIAL_MIN_REACH, THIN_NOTE,
  SKIP_ATHLETE_PER, SKIP_ATHLETE_MAX, SKIP_AGENT_PER, SKIP_AGENT_MAX,
};
