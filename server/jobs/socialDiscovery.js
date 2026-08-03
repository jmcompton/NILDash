'use strict';
// Nightly social brand discovery.
//
// Grows social_brands automatically WITHOUT letting AI write a row directly:
//   1. Pick a rotating set of search queries (different set each day).
//   2. One AI web-search call per query -> a JSON array of candidate brands.
//   3. Drop candidates whose proof_url is already in social_brands or already
//      failed (social_brand_rejects), so we never re-check a dead URL.
//   4. Run every remaining candidate through the EXISTING verify gate
//      (server/services/socialProof.js) — the exact same 200 + SIGNALS check the
//      admin verify-seed endpoint uses. It is never weakened or bypassed.
//   5. Passing rows -> social_brands (proof_date = today). Failing -> rejects.
//
// Runnable standalone (node server/jobs/socialDiscovery.js) for the cron child
// process, and importable (runSocialDiscovery) for the manual admin endpoint.
// It does NOT touch the scan path; the social lane stays a pure DB read.

const path = require('path');
const fs = require('fs');
const store = require('../store');
const ai = require('../ai');
const { verifySocialProof } = require('../services/socialProof');

const QUERIES_PATH = path.join(__dirname, '..', 'data', 'socialDiscoveryQueries.json');
const QUERIES_PER_RUN = 4;   // how many queries to run per night
const MAX_PER_QUERY = 6;     // cap results the model may return per query
const MAX_CANDIDATES = 24;   // hard cap on candidates verified per run (cost bound)

function _loadQueries() {
  try {
    const arr = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf8'));
    return Array.isArray(arr) ? arr.filter((q) => typeof q === 'string' && q.trim()) : [];
  } catch (e) {
    console.error('[socialDiscovery] queries load failed:', e.message);
    return [];
  }
}

// Rotate the picked set by day so consecutive nights do not repeat the same
// queries. Uses whole days since epoch (UTC) as a stable, monotonic index.
function _pickQueries(all, n) {
  if (!all.length) return [];
  const dayIndex = Math.floor(Date.now() / 86400000);
  const start = (dayIndex * n) % all.length;
  const out = [];
  for (let i = 0; i < Math.min(n, all.length); i++) out.push(all[(start + i) % all.length]);
  return out;
}

// Web-search responses often narrate before the JSON. Strip fences and extract
// the first top-level array.
function _parseCandidates(raw) {
  let s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b === -1 || b < a) return [];
  try {
    const arr = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

const SEARCH_SYSTEM = 'You are a NIL brand research assistant with live web search. Return ONLY a JSON array. No markdown, no prose, no code fences.';

function _searchPrompt(query, cap) {
  return `Use web search for: "${query}". Find real consumer brands that run a PUBLIC athlete ambassador, affiliate, or creator program open to U.S. college athletes.

Return ONLY a JSON array (no markdown) of at most ${cap} objects, each exactly:
{"brand":"","category":"","website":"https://...","proof_url":"https://...","sports":["all"],"tier_min":0,"tier_max":0,"deal_structure":"cash|cash_code|affiliate|gifting_code","est_low":null,"est_high":null,"cadence_note":""}

Rules:
- proof_url MUST be the brand's OWN ambassador, affiliate, or creator program page (its apply or program page on the brand's own site). NEVER a blog post, listicle, "best programs" roundup, news article, or aggregator/directory page.
- sports: a lowercase array; use ["all"] when the program is sport-agnostic.
- tier_min/tier_max bound combined Instagram + TikTok follower reach. If unsure, use a WIDE range (for example 1000 to 150000) rather than guessing narrow.
- est_low/est_high: per-deal dollar estimate if genuinely known, otherwise null.
- cadence_note: one short factual phrase about the program if known, else "".
- Only real, currently-operating programs. If you cannot find the brand's OWN program page, omit that brand entirely.`;
}

async function _recordReject(c, reason, statusCode) {
  try {
    await store.pool.query(
      `INSERT INTO social_brand_rejects (proof_url, brand, reason, status_code, last_tried)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (proof_url) DO UPDATE SET
         brand = EXCLUDED.brand, reason = EXCLUDED.reason,
         status_code = EXCLUDED.status_code, last_tried = NOW()`,
      [String(c.proof_url), c.brand || null, reason || null, statusCode == null ? null : statusCode]
    );
  } catch (e) { console.warn('[socialDiscovery] reject record failed:', e.message); }
}

async function _isKnownUrl(url) {
  try {
    const r = await store.pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM social_brands        WHERE lower(proof_url) = lower($1)
         UNION ALL
         SELECT 1 FROM social_brand_rejects WHERE lower(proof_url) = lower($1)
       ) AS known`,
      [url]
    );
    return !!(r.rows[0] && r.rows[0].known);
  } catch (e) {
    // If the dedupe lookup fails, do NOT skip — let the verify gate still decide.
    console.warn('[socialDiscovery] dedupe lookup failed:', e.message);
    return false;
  }
}

async function runSocialDiscovery() {
  const summary = { queriesRun: 0, proposed: 0, inserted: 0, rejected: 0, skippedDuplicate: 0, insertedBrands: [] };

  const all = _loadQueries();
  const queries = _pickQueries(all, QUERIES_PER_RUN);
  if (!queries.length) { console.log('[socialDiscovery] no queries available'); return summary; }

  // 1-2. Gather candidates via one web search per query, capped overall.
  const candidates = [];
  for (const q of queries) {
    if (candidates.length >= MAX_CANDIDATES) break;
    summary.queriesRun++;
    let raw = '';
    try {
      raw = await ai.oneShotWebSearch(_searchPrompt(q, MAX_PER_QUERY), SEARCH_SYSTEM, 2500, 4, ai.MODEL_FAST);
    } catch (e) {
      console.warn(`[socialDiscovery] search failed q="${q}": ${e.message}`);
      continue;
    }
    // DIAGNOSTIC (temporary): disambiguate "model returns ~1" from "model returns
    // several but most are filtered". Logs the raw text plus the counts at each
    // stage so a live /discover run shows exactly where candidates are lost.
    const _parsedAll = _parseCandidates(raw);
    const _withFields = _parsedAll.filter((c) => c && c.brand && c.proof_url);
    console.log(`[socialDiscovery][DIAG] q="${q}" rawLen=${(raw || '').length} parsedCount=${_parsedAll.length} withBrand+proofUrl=${_withFields.length}`);
    console.log(`[socialDiscovery][DIAG] q="${q}" raw=${JSON.stringify(String(raw || '').slice(0, 4000))}`);
    const parsed = _parseCandidates(raw).slice(0, MAX_PER_QUERY);
    for (const c of parsed) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (c && c.brand && c.proof_url) candidates.push(c);
    }
  }
  summary.proposed = candidates.length;

  // 3. Drop duplicates: within this batch, and against social_brands / rejects.
  const seen = new Set();
  const fresh = [];
  for (const c of candidates) {
    const url = String(c.proof_url || '').trim();
    if (!url || seen.has(url.toLowerCase())) { summary.skippedDuplicate++; continue; }
    seen.add(url.toLowerCase());
    if (await _isKnownUrl(url)) { summary.skippedDuplicate++; continue; }
    fresh.push(c);
  }

  // 4-5. Verify each remaining candidate through the EXISTING gate; insert or reject.
  for (const c of fresh) {
    const v = await verifySocialProof(c.proof_url);
    if (!v.ok) {
      summary.rejected++;
      await _recordReject(c, v.reason, v.status_code);
      continue;
    }
    try {
      await store.pool.query(
        `INSERT INTO social_brands
           (brand, category, website, sports, tier_min, tier_max, deal_structure, est_low, est_high, cadence_note, proof_url, proof_date, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_DATE,true)
         ON CONFLICT (brand) DO UPDATE SET proof_date = CURRENT_DATE, active = true, updated_at = NOW()`,
        [
          c.brand,
          c.category || 'unknown',
          c.website || null,
          (Array.isArray(c.sports) && c.sports.length) ? c.sports.map((s) => String(s).toLowerCase()) : ['all'],
          Number.isFinite(Number(c.tier_min)) ? Number(c.tier_min) : 0,
          Number.isFinite(Number(c.tier_max)) ? Number(c.tier_max) : 0,
          c.deal_structure || 'affiliate',
          c.est_low == null ? null : Number(c.est_low),
          c.est_high == null ? null : Number(c.est_high),
          c.cadence_note || null,
          c.proof_url,
        ]
      );
      summary.inserted++;
      summary.insertedBrands.push(c.brand);
    } catch (e) {
      // Insert failed (e.g. same brand already present under a different proof_url).
      // Record the URL as a reject so the job does not keep re-verifying it.
      summary.rejected++;
      await _recordReject(c, 'db error: ' + e.message, v.status_code);
    }
  }

  console.log(
    `[socialDiscovery] queriesRun=${summary.queriesRun} proposed=${summary.proposed} ` +
    `inserted=${summary.inserted} rejected=${summary.rejected} skippedDuplicate=${summary.skippedDuplicate} ` +
    `brands=${JSON.stringify(summary.insertedBrands)}`
  );
  return summary;
}

module.exports = { runSocialDiscovery };

// Standalone entry for the nightly cron child process.
if (require.main === module) {
  runSocialDiscovery()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[socialDiscovery] fatal:', e.message); process.exit(1); });
}
