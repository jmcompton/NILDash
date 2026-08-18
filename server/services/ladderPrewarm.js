'use strict';
// Run the deep contact ladder for the top few cards at SCAN time, so the agent
// never waits on it.
//
// WHY. The ladder is the only step that produces a decision maker, and it is the
// slowest thing on the AI Outreach path: Places, then up to three waves of web
// search. Running it when the modal opens means the agent waits ~30s
// for the one thing they actually came for -- and an agent can find a local owner
// on Google in thirty seconds, so a slower wait for a worse answer is worth less
// than nothing.
//
// HOW. This does not introduce new storage or a new client contract. It calls the
// SAME resolver the click path calls, with the SAME arguments, so the result lands
// in brand_evidence_cache under the SAME key. The click then reads it as a cache
// hit and returns in about a second. Nothing downstream knows this ran.
//
// The arguments matter more than they look: the cache key is built from the brand,
// the location hint and whether stopAtTier1 was set. Warm it with a different
// locationHint or without stopAtTier1 and the click misses the row entirely, so
// the whole thing is a silent waste. That equivalence is what ladderwarm.js
// asserts.
//
// WHY ONLY THE TOP FEW. The cost gate on the deep path exists for a reason: all
// ten cards was roughly $0.75 and ~40s of model time per scan. Three is the top of
// the list the agent actually opens, and it runs after the response has been sent,
// so it costs the scan nothing.

const ai = require('../ai');

// The agent opens from the top. Three is where the click-through actually is, and
// it keeps the added cost per scan to roughly a third of a full sweep.
const TOP_N = parseInt(process.env.LADDER_PREWARM_TOP_N, 10) || 3;
// Two at a time: this is a background job behind a response the agent is already
// reading, and each member is itself a multi-source fan-out.
const CONCURRENCY = 2;

// The shared deep ctx from ai.js. This used to be a local copy that happened to
// match the route; it is now the same builder every caller uses, so it cannot drift
// out of alignment. A drift here does not fail -- it quietly warms a key nothing
// reads.
function deepCtx(card) {
  return ai.deepContactCtx({
    market: card.market || null,
    isFranchise: card.isFranchise === true,
    contactApproach: card.contactApproach || card.approach || null,
  });
}

// One card. Never throws: a scan that has already been sent must not be able to
// fail afterwards, and one dead business must not stop the other two.
async function warmOne(card) {
  const brand = String((card && (card.brand || card.brand_name)) || '').trim();
  if (!brand) return { skipped: 'no brand' };
  try {
    const res = await ai.getBrandContacts(brand, card.website || null, card.region || '', deepCtx(card));
    const named = (res && Array.isArray(res.contacts)) ? res.contacts.filter((c) => c && c.name).length : 0;
    return { warmed: true, brand, named, cached: !!(res && res.cached) };
  } catch (e) {
    return { failed: e.message, brand };
  }
}

// Called after the scan response has been sent, never awaited by the request.
async function prewarmLadders({ cards, topN }) {
  const n = Math.max(0, topN === undefined ? TOP_N : topN);
  const list = (Array.isArray(cards) ? cards : []).filter(Boolean).slice(0, n);
  if (!list.length) return { warmed: 0, failed: 0, skipped: 0, alreadyCached: 0 };
  const t0 = Date.now();

  const results = new Array(list.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      results[i] = await warmOne(list[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));

  const warmed = results.filter((r) => r && r.warmed).length;
  const failed = results.filter((r) => r && r.failed).length;
  const skipped = results.filter((r) => r && r.skipped).length;
  const alreadyCached = results.filter((r) => r && r.cached).length;
  const withNames = results.filter((r) => r && r.named > 0).length;
  // One line per scan. A warm that quietly finds nobody looks exactly like a fast
  // one, so the named count is on the line rather than inferred from the absence of
  // complaints.
  console.log(`[ladder-prewarm] cards=${list.length} warmed=${warmed} withNamedPerson=${withNames} `
    + `alreadyCached=${alreadyCached} failed=${failed} skipped=${skipped} ms=${Date.now() - t0}`);
  for (const r of results) if (r && r.failed) console.warn(`[ladder-prewarm]   failed ${r.brand}: ${r.failed}`);
  return { warmed, failed, skipped, alreadyCached, withNames };
}

module.exports = { prewarmLadders, warmOne, deepCtx, TOP_N, CONCURRENCY };
