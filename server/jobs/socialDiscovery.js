'use strict';
// Nightly social brand discovery.
//
// Grows social_brands automatically WITHOUT letting AI write a row directly. Brand
// discovery and URL discovery are split: the model only names brands, the SERVER
// finds each program page.
//   1. Pick a rotating set of search queries (a different set each day).
//   2. One AI web-search call per query names candidate BRANDS + homepages only.
//      The model never guesses a program URL.
//   3. Drop brands already in social_brands, and homepages already recorded in
//      social_brand_rejects, so known-dead sites are not re-checked.
//   4. For each remaining brand the SERVER finds its program page from the
//      homepage (findProgramUrl), then runs it through the EXISTING verify gate
//      (server/services/socialProof.js): the same 200 + SIGNALS check the admin
//      verify-seed endpoint uses. It is never weakened or bypassed.
//   5. Passing rows insert into social_brands (proof_date = today). Brands with no
//      verifiable program page are recorded in social_brand_rejects.
//
// Runnable standalone (node server/jobs/socialDiscovery.js) for the cron child
// process, and importable (runSocialDiscovery) for the manual admin endpoint.
// It does NOT touch the scan path; the social lane stays a pure DB read.

const path = require('path');
const fs = require('fs');
const store = require('../store');
const ai = require('../ai');
const { verifySocialProof, findProgramUrl, summarizeProgram } = require('../services/socialProof');

const QUERIES_PATH = path.join(__dirname, '..', 'data', 'socialDiscoveryQueries.json');
const QUERIES_PER_RUN = 20;  // queries to run per run (job fires twice daily: 3am + 3pm)
const MAX_PER_QUERY = 10;    // brands the model may return per query
const MAX_CANDIDATES = 60;   // hard cap on candidates verified per run (cost bound)

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

Return ONLY a JSON array (no markdown) of up to ${cap} objects, each exactly:
{"brand":"","category":"","website":"https://...","sports":["all"],"tier_min":0,"tier_max":0,"deal_structure":"cash|cash_code|affiliate|gifting_code","est_low":null,"est_high":null,"cadence_note":""}

Rules:
- website: the brand's HOMEPAGE URL (its main site). A homepage is sufficient; you do NOT need to find the specific program page.
- sports: a lowercase array; use ["all"] when the program is sport-agnostic.
- tier_min/tier_max bound combined Instagram + TikTok follower reach. If unsure, use a WIDE range (for example 1000 to 150000) rather than guessing narrow.
- est_low/est_high: per-deal dollar estimate if genuinely known, otherwise null.
- cadence_note: one short factual phrase about the program if known, else "".
- List real, currently-operating brands. Return up to ${cap}.`;
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

// Canonical form of a URL for stable dedupe / reject keys: https scheme, no www,
// no trailing slash, lowercased.
function _normUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const x = new URL(s);
    return (x.protocol + '//' + x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/+$/, '').toLowerCase();
  } catch { return s.toLowerCase(); }
}

// A brand is already handled if it is in social_brands (by brand name) OR its
// homepage already failed to yield a program page (recorded in rejects). Avoids
// re-running the multi-fetch findProgramUrl on known brands and known-dead sites.
async function _alreadyKnown(brand, normSite) {
  try {
    const r = await store.pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM social_brands        WHERE lower(brand) = lower($1)
         UNION ALL
         SELECT 1 FROM social_brand_rejects WHERE lower(proof_url) = lower($2)
       ) AS known`,
      [String(brand || ''), normSite || '']
    );
    return !!(r.rows[0] && r.rows[0].known);
  } catch (e) {
    // If the dedupe lookup fails, do NOT skip; let findProgramUrl / the gate decide.
    console.warn('[socialDiscovery] dedupe lookup failed:', e.message);
    return false;
  }
}

async function runSocialDiscovery() {
  const summary = { queriesRun: 0, proposed: 0, inserted: 0, summarizeAttempts: 0, summarized: 0, foundByLink: 0, foundByFallback: 0, notFound: 0, skippedDuplicate: 0, insertedBrands: [] };

  const all = _loadQueries();
  const queries = _pickQueries(all, QUERIES_PER_RUN);
  if (!queries.length) { console.log('[socialDiscovery] no queries available'); return summary; }

  // 1-2. Gather candidate BRANDS via one web search per query. The model only
  // names brands + homepages now; the SERVER finds each program page. Capped overall.
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
    const parsed = _parseCandidates(raw).slice(0, MAX_PER_QUERY);
    for (const c of parsed) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (c && c.brand && c.website) candidates.push(c);
    }
  }
  summary.proposed = candidates.length;

  // 3. Dedupe within this batch and against social_brands / rejects.
  const seenBrand = new Set();
  const seenSite = new Set();
  const fresh = [];
  for (const c of candidates) {
    const brandKey = String(c.brand || '').trim().toLowerCase();
    const normSite = _normUrl(c.website);
    if (!brandKey || seenBrand.has(brandKey) || (normSite && seenSite.has(normSite))) { summary.skippedDuplicate++; continue; }
    seenBrand.add(brandKey);
    if (normSite) seenSite.add(normSite);
    if (await _alreadyKnown(c.brand, normSite)) { summary.skippedDuplicate++; continue; }
    fresh.push(c);
  }

  // 4-6. The SERVER finds each brand's program page and runs it through the EXISTING
  // verify gate (findProgramUrl -> verifySocialProof). Passing rows insert with the
  // discovered proof_url; brands with no verifiable program page are recorded as
  // rejects keyed on the homepage so they are never retried.
  for (const c of fresh) {
    const normSite = _normUrl(c.website);
    const found = await findProgramUrl(c.website);
    if (!found) {
      summary.notFound++;
      await _recordReject({ proof_url: normSite || String(c.website), brand: c.brand }, 'no program page found', null);
      continue;
    }
    if (found.via === 'link') summary.foundByLink++; else summary.foundByFallback++;
    // One Haiku call on the verified program page (never on the scan path).
    const offerSummary = await summarizeProgram(found.pageText);
    summary.summarizeAttempts++; if (offerSummary) summary.summarized++;
    try {
      await store.pool.query(
        `INSERT INTO social_brands
           (brand, category, website, sports, tier_min, tier_max, deal_structure, est_low, est_high, cadence_note, proof_url, proof_snippet, tier_stated, offer_summary, proof_date, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CURRENT_DATE,true)
         ON CONFLICT (brand) DO UPDATE SET proof_date = CURRENT_DATE, proof_snippet = EXCLUDED.proof_snippet, tier_stated = EXCLUDED.tier_stated, offer_summary = EXCLUDED.offer_summary, active = true, updated_at = NOW()`,
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
          found.url,
          found.snippet || null,
          !!found.tierStated,
          offerSummary,
        ]
      );
      summary.inserted++;
      summary.insertedBrands.push(c.brand);
    } catch (e) {
      console.warn(`[socialDiscovery] insert failed brand="${c.brand}": ${e.message}`);
    }
  }

  console.log(
    `[socialDiscovery] queriesRun=${summary.queriesRun} proposed=${summary.proposed} ` +
    `inserted=${summary.inserted} attempts=${summary.summarizeAttempts} summarized=${summary.summarized} foundByLink=${summary.foundByLink} foundByFallback=${summary.foundByFallback} ` +
    `notFound=${summary.notFound} skippedDuplicate=${summary.skippedDuplicate} brands=${JSON.stringify(summary.insertedBrands)}`
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
