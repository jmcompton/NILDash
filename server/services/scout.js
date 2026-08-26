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

// A lane never takes the whole slate on its own unless the others are empty.
// Without this a market with 200 unworked businesses would crowd out the social
// and national results that are often the better pitch.
const LANE_SOFT_CAP = 3;

// Why an athlete got nothing. A SILENT ZERO IS THE BUG WE SPENT A DAY ON, so
// every empty result carries one of these and the shift report prints it.
const EMPTY = {
  NO_MARKET: 'no-market',
  MARKET_EXHAUSTED: 'market-exhausted',
  BELOW_BAR: 'below-bar',
  SLOTS_FULL: 'slots-full',
  PAUSED: 'paused',
  CAPPED: 'capped-out',
};
const EMPTY_TEXT = {
  [EMPTY.NO_MARKET]: 'no school we could match, so the local lane has no town to work in — and no social or national fit either',
  [EMPTY.MARKET_EXHAUSTED]: 'every business we have found in this market has already been worked, and no social or national brand fit tonight',
  [EMPTY.BELOW_BAR]: 'candidates were found but none cleared the bar, so nothing was queued rather than filling slots with filler',
  [EMPTY.SLOTS_FULL]: 'all slots already hold work you have not actioned yet',
  [EMPTY.PAUSED]: 'paused after repeated nights with nothing to show',
  [EMPTY.CAPPED]: 'the nightly spend cap was reached before this athlete',
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

async function schoolSponsorSignals(pool, school, opts = {}) {
  const out = new Map();
  const s = String(school || '').trim();
  if (!s) return out;
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

  // 1. Our own closed deals for athletes at this school.
  for (const r of await q('deals',
    `SELECT DISTINCT d.data->>'brand' AS brand
       FROM deals d JOIN athletes a ON a.id = d.athlete_id
      WHERE d.data->>'stage' = 'Closed' AND d.data->>'brand' IS NOT NULL
        AND LOWER(a.data->>'school') = LOWER($1)
      LIMIT 200`, [s])) {
    add(r.brand, 'agent-closed-at-school', `you have already closed a deal with them at ${s}`);
  }

  // 2. A business that answered us for another athlete at this school. This read
  //    returned nothing for the life of the product: 'responded' and 'closed'
  //    were never written by anything. See store.advanceBrandEngagement.
  for (const r of await q('engaged',
    `SELECT DISTINCT be.brand_name AS brand, be.state
       FROM brand_engagement be JOIN athletes a ON a.id = be.athlete_id
      WHERE be.state IN ('responded','closed') AND be.brand_name IS NOT NULL
        AND LOWER(a.data->>'school') = LOWER($1)
      LIMIT 200`, [s])) {
    add(r.brand, 'replied-at-school', r.state === 'closed'
      ? `has closed a deal with another ${s} athlete`
      : `replied to outreach for another ${s} athlete`);
  }

  // 3. A DISCLOSED deal reported publicly. Matched on school loosely, because
  //    deal_comps carries whatever the source called it. Worded as what it is: a
  //    report, not a relationship we can vouch for. Rows we wrote ourselves
  //    (source='agent-close') are excluded -- they are already source 1, at a
  //    much higher weight, and counting them twice would launder our own close
  //    into "the market says so".
  for (const r of await q('comps',
    `SELECT DISTINCT brand FROM deal_comps
      WHERE brand IS NOT NULL AND brand <> ''
        AND COALESCE(source,'') <> 'agent-close'
        AND (LOWER(school) = LOWER($1) OR LOWER(school) LIKE '%' || LOWER($2) || '%')
      LIMIT 400`, [s, s.replace(/\s*(university|college)\s*/ig, ' ').trim()])) {
    add(r.brand, 'reported-deal-at-school',
      `publicly reported an NIL deal with an athlete at ${s}`);
  }
  void opts;
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
            'market-pool' AS pool
       FROM market_business_seen m
      WHERE m.market_key = $1
        AND NOT EXISTS (SELECT 1 FROM brand_engagement be
                         WHERE be.athlete_id = $2 AND LOWER(be.brand_name) = LOWER(m.brand))
        AND NOT EXISTS (SELECT 1 FROM outreach_queue q
                         WHERE q.athlete_id = $2 AND LOWER(q.brand_name) = LOWER(m.brand))
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
  for (const r of shown.concat(seen)) {
    const k = normBrand(r.brand_name);
    if (!k || seenKeys.has(k)) continue;
    const lane = r.pool === 'market-pool' ? 'local' : (r.lane || null);
    if (lane !== 'local') { laneless.push(r.brand_name); continue; }
    seenKeys.add(k);
    rows.push({ ...r, lane });
  }
  if (laneless.length) {
    console.log(`[scout/local] athlete=${athlete.id} dropped ${laneless.length} candidate(s) with no `
      + `recorded lane: ${laneless.slice(0, 5).join(', ')}`);
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

  const signals = await schoolSponsorSignals(pool, athlete.school);
  const local = await localCandidates(pool, { agentId, athlete, limit });
  const social = await socialCandidates(pool, { athlete, limit, store });
  const national = await nationalCandidates(pool, { limit, store });

  const all = local.rows.concat(social, national);
  if (!all.length) {
    // Say WHICH kind of empty. "no market" and "market exhausted" are different
    // problems with different fixes, and a bare zero told us neither.
    const reason = !athlete.hasLocalMarket ? EMPTY.NO_MARKET : EMPTY.MARKET_EXHAUSTED;
    return { picks: [], laneCounts: {}, emptyReason: reason, emptyText: EMPTY_TEXT[reason],
      signalCount: signals.size, localExhausted: local.exhausted };
  }

  // Rank. The sponsorship boost applies across ALL lanes: a brand that has done
  // a deal at this school is the better target whether it is the coffee shop
  // down the road or a national program.
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
    return { ...c, fit, sponsorSignal: sig };
  }).sort((a, b) => b.fit - a.fit);

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
       SELECT brand_name, brand_key, NULL AS identity_key, 'contacted' AS why
         FROM brand_engagement
        WHERE athlete_id = $1 AND state IN ('contacted','replied','closed','retired')`,
      [athlete.id])).rows;
    for (const r of (prior || [])) {
      if (r.identity_key) { priorKeys.add(r.identity_key); continue; }
      for (const id of BI.identitiesOf(r, { market: athlete.marketKey || null })) priorKeys.add(id.key);
    }
  } catch (e) { console.error('[slate] prior lookup:', e.message); }

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

  // Interleave under a soft lane cap so one lane cannot take the whole slate
  // while another has something better waiting.
  const picks = [];
  const chosen = new Set();
  const perLane = {};
  for (const c of fresh) {
    if (picks.length >= limit) break;
    perLane[c.lane] = perLane[c.lane] || 0;
    if (perLane[c.lane] >= LANE_SOFT_CAP) continue;
    perLane[c.lane]++; picks.push(c); chosen.add(c);
  }
  // Soft cap: if the slate is short only because of it, fill from what is left.
  if (picks.length < limit) {
    for (const c of fresh) {
      if (picks.length >= limit) break;
      if (chosen.has(c)) continue;
      chosen.add(c); picks.push(c);
    }
  }

  const laneCounts = picks.reduce((m, p) => { m[p.lane] = (m[p.lane] || 0) + 1; return m; }, {});
  return {
    picks, laneCounts, emptyReason: null, emptyText: null,
    signalCount: signals.size,
    boosted: picks.filter((p) => p.sponsorSignal).length,
    collapsed,
    localExhausted: local.exhausted,
  };
}

module.exports = {
  assembleSlate, schoolSponsorSignals, localCandidates, socialCandidates, nationalCandidates,
  normBrand, SLATE_MAX, LANE_SOFT_CAP, EMPTY, EMPTY_TEXT, SIGNAL_WEIGHT,
};
