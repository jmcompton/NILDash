// server/services/companyEnrichment.js
// CompanyEnrichmentService — Part 1 of the NIL Outreach Automation Engine.
//
// Responsibilities:
//   - enrich company profile from AI knowledge + public data signals
//   - normalize and validate returned data
//   - deduplicate against existing enrichment records
//   - cache results per agent+brand (re-enriches after 7 days)
//
// SAFETY: reads-only from existing tables (athletes, deals).
//         writes only to company_enrichment (new table).
//         zero modifications to any existing service or route.

'use strict';

const crypto = require('crypto');
const { pool } = require('../store');
const { oneShot, oneShotWebSearch } = require('../ai');

const CACHE_TTL_DAYS = 7;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * enrich(agentId, brandName, hintData)
 *
 * hintData: optional object from Deal Scan result:
 *   { category, dealType, rationale, isLocal, athleteLocation }
 *
 * Returns the enrichment record (from cache or freshly generated).
 */
async function enrich(agentId, brandName, hintData = {}) {
  // 1. Check cache
  // Only trust a cached record that actually resolved a location. Older records
  // that failed (location null) are stale low-quality results, so re-research.
  const cached = await getCached(agentId, brandName);
  if (cached && cached.location) {
    logEvent(null, agentId, 'enrichment_cache_hit', { brandName });
    return cached;
  }

  // 2. Generate enrichment via AI
  const enrichmentData = await runEnrichment(brandName, hintData);

  // 3. Persist
  const id = 'enr_' + crypto.randomBytes(8).toString('hex');
  const record = await save(id, agentId, brandName, enrichmentData);

  logEvent(null, agentId, 'enrichment_complete', { brandName, id });
  return record;
}

/**
 * getByBrandName(agentId, brandName)
 * Returns the most recent enrichment record or null.
 */
async function getByBrandName(agentId, brandName) {
  return getCached(agentId, brandName);
}

/**
 * getById(id)
 * Returns a single enrichment record by id.
 */
async function getById(id) {
  const r = await pool.query('SELECT * FROM company_enrichment WHERE id=$1', [id]);
  return r.rows[0] || null;
}

/**
 * listForAgent(agentId)
 * Returns all enrichment records for an agent, newest first.
 */
async function listForAgent(agentId) {
  const r = await pool.query(
    'SELECT * FROM company_enrichment WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 100',
    [agentId]
  );
  return r.rows;
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function getCached(agentId, brandName) {
  const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const r = await pool.query(
    `SELECT * FROM company_enrichment
     WHERE agent_id=$1
       AND LOWER(brand_name)=LOWER($2)
       AND enriched_at > $3
     ORDER BY enriched_at DESC LIMIT 1`,
    [agentId, brandName, cutoff]
  );
  return r.rows[0] || null;
}

async function runEnrichment(brandName, hintData) {
  const hint = hintData.category
    ? `Category: ${hintData.category}. Deal type: ${hintData.dealType || 'unknown'}. ${hintData.isLocal ? 'This is a local/regional brand.' : 'This may be a national brand.'} ${hintData.rationale || ''}`
    : '';

  const system = `You are a brand intelligence API for a NIL sports agency platform.
Return ONLY a valid JSON object with no markdown, no explanation, no code blocks.
If you don't know a value with confidence, use null.
Never fabricate contact emails or phone numbers — use null for those.`;

  const prompt = `Enrich this brand for NIL partnership outreach:

Brand: "${brandName}"
${hint}

Return this exact JSON structure:
{
  "website": "string or null",
  "industry": "string",
  "location": "City, State or null",
  "phone": "string or null",
  "general_email": "string or null — only if publicly known",
  "description": "2-3 sentence company overview focused on marketing and sponsorship",
  "brand_size": "local | regional | national | global",
  "employee_count": "string estimate e.g. '50-200' or null",
  "annual_revenue": "string estimate e.g. '$10M-$50M' or null",
  "social_links": {
    "instagram": "url or null",
    "twitter": "url or null",
    "linkedin": "url or null",
    "tiktok": "url or null",
    "facebook": "url or null"
  },
  "sponsorship_history": "brief note on known sports sponsorships, or null",
  "nil_history": "any known NIL deal history or null",
  "target_demographics": "who their customers are",
  "marketing_budget_tier": "small | medium | large | enterprise or null",
  "partnership_fit_notes": "why this brand might be a good NIL partner"
}`;

  const researchSystem = `You are a brand research assistant with live web search for a NIL sports agency platform.
Search the web for the specific business or brand named below and return ONLY a valid JSON object (no markdown, no code blocks). Base every field on what you actually find.
- If the name refers to a single-location business (a specific car dealership, gym, restaurant, studio, salon, or one franchise location, e.g. "Tuscaloosa Toyota"), set brand_size to "local" and set location to that business's real city and state.
- If it refers to a national chain, CPG, or major brand (e.g. Celsius, Crocs, Gatorade), set brand_size to "national" (or "global" if worldwide).
For general_email, return only a REAL contact email found on the business's official website or a reliable public listing. NEVER guess or fabricate one; use null if you cannot find a real one.`;

  const researchPrompt = `Use web search to research this business or brand for NIL partnership outreach. Find their real website, what they actually do, their real city and state, any community or sports sponsorships, and the best real contact email on their site.

${prompt}

CRITICAL:
- "location" must be the real "City, State", resolved from the web. For a single-location business this is the city it operates in. Use null only if you truly cannot find it.
- "brand_size": "local" for a single-location business or one franchise location, even if it carries a national brand name like Toyota or Hyundai; "national" or "global" for a chain or major brand.
- "description" must be specific to THIS business, not the generic category.
- "general_email": the best REAL contact email found on their official website (general/info/sales inbox, or owner/manager). Only a real one you actually find; otherwise null.`;

  let raw;
  try {
    raw = await oneShotWebSearch(researchPrompt, researchSystem, 2500, 3, 'claude-sonnet-4-6');
  } catch (e) {
    console.error('[companyEnrichment] web search failed, falling back to model knowledge:', e.message);
    try {
      // Pin the fallback to Sonnet 4.6 so a failed web search does not silently
      // upgrade this call to the Opus default.
      raw = await oneShot(prompt, system, 2000, 'claude-sonnet-4-6');
    } catch (e2) {
      console.error('[companyEnrichment] AI call failed:', e2.message);
      return buildFallback(brandName);
    }
  }

  return parseEnrichment(raw, brandName, hintData.isLocal);
}

function parseEnrichment(raw, brandName, isLocal) {
  try {
    // Strip markdown fences, then extract the JSON object. Web search responses
    // often narrate before the JSON.
    let clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) clean = clean.slice(start, end + 1);
    const parsed = JSON.parse(clean);
    return normalize(parsed, brandName, isLocal);
  } catch (e) {
    console.error('[companyEnrichment] JSON parse failed:', e.message);
    return buildFallback(brandName);
  }
}

function normalize(data, brandName, isLocal) {
  return {
    website:               sanitizeUrl(data.website),
    industry:              str(data.industry),
    location:              str(data.location),
    phone:                 str(data.phone),
    general_email:         sanitizeEmail(data.general_email),
    description:           str(data.description),
    brand_size:            isLocal ? 'local' : validateEnum(data.brand_size, ['local','regional','national','global'], 'regional'),
    employee_count:        str(data.employee_count),
    annual_revenue:        str(data.annual_revenue),
    social_links:          sanitizeSocial(data.social_links),
    sponsorship_history:   str(data.sponsorship_history),
    nil_history:           str(data.nil_history),
    target_demographics:   str(data.target_demographics),
    marketing_budget_tier: validateEnum(data.marketing_budget_tier, ['small','medium','large','enterprise'], null),
    partnership_fit_notes: str(data.partnership_fit_notes),
  };
}

function buildFallback(brandName) {
  return {
    website: null, industry: 'Unknown', location: null, phone: null,
    general_email: null, description: `${brandName} — enrichment pending.`,
    brand_size: 'regional', employee_count: null, annual_revenue: null,
    social_links: {}, sponsorship_history: null, nil_history: null,
    target_demographics: null, marketing_budget_tier: null, partnership_fit_notes: null,
  };
}

async function save(id, agentId, brandName, data) {
  const r = await pool.query(
    `INSERT INTO company_enrichment (
       id, agent_id, brand_name, website, industry, location, phone,
       general_email, description, social_links, brand_size, employee_count,
       annual_revenue, raw_data, enriched_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       website=$4, industry=$5, location=$6, phone=$7, general_email=$8,
       description=$9, social_links=$10, brand_size=$11, employee_count=$12,
       annual_revenue=$13, raw_data=$14, enriched_at=NOW(), updated_at=NOW()
     RETURNING *`,
    [
      id, agentId, brandName,
      data.website, data.industry, data.location, data.phone,
      data.general_email, data.description,
      JSON.stringify(data.social_links || {}),
      data.brand_size, data.employee_count, data.annual_revenue,
      JSON.stringify(data),
    ]
  );
  return r.rows[0];
}

// ── Sanitizers ───────────────────────────────────────────────────────────────

function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' || s === 'undefined' ? null : s;
}

function sanitizeUrl(v) {
  const s = str(v);
  if (!s) return null;
  try { new URL(s.startsWith('http') ? s : 'https://' + s); return s; } catch { return null; }
}

function sanitizeEmail(v) {
  const s = str(v);
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : null;
}

function sanitizeSocial(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const url = sanitizeUrl(v);
    if (url) out[k] = url;
  }
  return out;
}

function validateEnum(v, allowed, fallback) {
  const s = str(v);
  return allowed.includes(s) ? s : fallback;
}

// ── Event logging (fire-and-forget) ─────────────────────────────────────────

function logEvent(runId, agentId, eventType, payload) {
  pool.query(
    `INSERT INTO workflow_events (run_id, agent_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [runId, agentId, eventType, JSON.stringify(payload)]
  ).catch(() => {});
}

module.exports = { enrich, getByBrandName, getById, listForAgent };
