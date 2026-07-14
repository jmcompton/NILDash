// server/services/athleteBrandMatch.js
// AthleteBrandMatchService — Part 3 of the NIL Outreach Automation Engine.
//
// Analyzes athlete profile against enriched company data to produce:
//   - compatibility score (0-100)
//   - reasoning narrative
//   - campaign ideas
//   - partnership opportunity types
//   - audience alignment analysis
//
// SAFETY: reads athletes and company_enrichment tables only.
//         writes only to brand_match_scores (new table).
//         zero modifications to any existing service or route.

'use strict';

const crypto = require('crypto');
const { pool } = require('../store');
const { oneShot, MODEL_FAST } = require('../ai');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * matchAthleteToBrand(agentId, athlete, enrichmentRecord)
 *
 * athlete: full athlete DB row (data JSONB parsed or raw)
 * enrichmentRecord: row from company_enrichment
 *
 * Returns brand_match_scores record.
 */
async function matchAthleteToBrand(agentId, athlete, enrichmentRecord) {
  // Check for existing match score
  const existing = await getExistingMatch(agentId, getAthleteId(athlete), enrichmentRecord.brand_name);
  if (existing) {
    logEvent(null, agentId, 'match_cache_hit', { athleteId: getAthleteId(athlete), brand: enrichmentRecord.brand_name });
    return existing;
  }

  const athleteData = getAthleteData(athlete);
  const matchResult = await runMatch(athleteData, enrichmentRecord);

  const id = 'match_' + crypto.randomBytes(8).toString('hex');
  const athleteId = getAthleteId(athlete);

  const r = await pool.query(
    `INSERT INTO brand_match_scores (
       id, agent_id, athlete_id, brand_name, enrichment_id,
       compatibility_score, reasoning, campaign_ideas,
       partnership_opportunities, audience_alignment, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     RETURNING *`,
    [
      id, agentId, athleteId, enrichmentRecord.brand_name, enrichmentRecord.id,
      matchResult.compatibility_score,
      matchResult.reasoning,
      JSON.stringify(matchResult.campaign_ideas || []),
      JSON.stringify(matchResult.partnership_opportunities || []),
      matchResult.audience_alignment,
    ]
  );

  logEvent(null, agentId, 'match_complete', {
    athleteId, brand: enrichmentRecord.brand_name,
    score: matchResult.compatibility_score,
  });

  return r.rows[0];
}

/**
 * getMatchById(id)
 */
async function getMatchById(id) {
  const r = await pool.query('SELECT * FROM brand_match_scores WHERE id=$1', [id]);
  return r.rows[0] || null;
}

/**
 * getMatchesForAthlete(agentId, athleteId)
 */
async function getMatchesForAthlete(agentId, athleteId) {
  const r = await pool.query(
    'SELECT * FROM brand_match_scores WHERE agent_id=$1 AND athlete_id=$2 ORDER BY compatibility_score DESC',
    [agentId, athleteId]
  );
  return r.rows;
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function runMatch(athleteData, enrichmentRecord) {
  const system = `You are a NIL brand-athlete matching engine for a sports agency platform.
Return ONLY a valid JSON object. No markdown, no explanation, no code blocks.`;

  const prompt = `Analyze the compatibility between this athlete and brand for a NIL partnership.

ATHLETE PROFILE:
- Name: ${athleteData.name}
- Sport: ${athleteData.sport}
- Position: ${athleteData.position || 'N/A'}
- School: ${athleteData.school} (${athleteData.schoolTier || 'P5'})
- Year: ${athleteData.year || 'N/A'}
- Instagram followers: ${athleteData.instagram || 0}
- TikTok followers: ${athleteData.tiktok || 0}
- Engagement rate: ${athleteData.engagement || 0}%
- Stats: ${athleteData.stats || 'N/A'}
- Notes/Marketability: ${athleteData.notes || 'N/A'}

BRAND PROFILE:
- Brand: ${enrichmentRecord.brand_name}
- Industry: ${enrichmentRecord.industry || 'Unknown'}
- Size: ${enrichmentRecord.brand_size || 'regional'}
- Location: ${enrichmentRecord.location || 'Unknown'}
- Description: ${enrichmentRecord.description || 'N/A'}
- Target demographics: ${safeJson(enrichmentRecord.raw_data, 'target_demographics') || 'N/A'}
- Sponsorship history: ${safeJson(enrichmentRecord.raw_data, 'sponsorship_history') || 'None known'}
- NIL history: ${safeJson(enrichmentRecord.raw_data, 'nil_history') || 'None known'}

Return this exact JSON:
{
  "compatibility_score": number 0-100,
  "reasoning": "3-4 sentence explanation of why this is or isn't a strong match — be specific to the athlete and brand",
  "audience_alignment": "2-3 sentences on how the athlete's fanbase aligns with the brand's customers",
  "campaign_ideas": [
    "Campaign idea 1 — specific and actionable",
    "Campaign idea 2",
    "Campaign idea 3"
  ],
  "partnership_opportunities": [
    {
      "type": "social_campaign | local_appearance | product_ambassador | event_activation | content_series | ambassador",
      "description": "specific opportunity description",
      "estimated_value_range": "$X - $Y"
    }
  ],
  "strengths": ["strength 1", "strength 2"],
  "risks": ["potential challenge 1"]
}`;

  let raw;
  try {
    // Structured scoring JSON (a number plus strengths/risks the UI renders as
    // chips), not agent-read prose, so it runs on the cheap Haiku tier, the same
    // pattern Deal Scan uses for extraction.
    raw = await oneShot(prompt, system, 2000, MODEL_FAST);
  } catch (e) {
    console.error('[athleteBrandMatch] AI call failed:', e.message);
    return buildFallbackMatch(enrichmentRecord.brand_name);
  }

  return parseMatch(raw, enrichmentRecord.brand_name);
}

function parseMatch(raw, brandName) {
  try {
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      compatibility_score:      clampScore(parsed.compatibility_score),
      reasoning:                strNull(parsed.reasoning) || 'Match analysis pending.',
      audience_alignment:       strNull(parsed.audience_alignment),
      campaign_ideas:           Array.isArray(parsed.campaign_ideas) ? parsed.campaign_ideas.slice(0, 5) : [],
      partnership_opportunities: Array.isArray(parsed.partnership_opportunities) ? parsed.partnership_opportunities.slice(0, 4) : [],
      strengths:                Array.isArray(parsed.strengths) ? parsed.strengths : [],
      risks:                    Array.isArray(parsed.risks) ? parsed.risks : [],
    };
  } catch (e) {
    console.error('[athleteBrandMatch] JSON parse failed:', e.message);
    return buildFallbackMatch(brandName);
  }
}

function buildFallbackMatch(brandName) {
  return {
    compatibility_score: 65,
    reasoning: `${brandName} has potential for an NIL partnership. Manual analysis recommended.`,
    audience_alignment: 'Audience alignment analysis pending.',
    campaign_ideas: ['Social media content series', 'Local appearance / event activation', 'Product ambassador campaign'],
    partnership_opportunities: [
      { type: 'social_campaign', description: 'Social media content partnership', estimated_value_range: '$500 - $2,500' }
    ],
    strengths: ['Brand-athlete alignment possible'],
    risks: ['Requires further research'],
  };
}

async function getExistingMatch(agentId, athleteId, brandName) {
  const r = await pool.query(
    `SELECT * FROM brand_match_scores
     WHERE agent_id=$1 AND athlete_id=$2 AND LOWER(brand_name)=LOWER($3)
     ORDER BY created_at DESC LIMIT 1`,
    [agentId, athleteId, brandName]
  );
  return r.rows[0] || null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAthleteId(athlete) {
  return athlete.id || athlete.athlete_id;
}

function getAthleteData(athlete) {
  // Handles both { id, data: {...} } (DB row) and flat object
  if (athlete.data && typeof athlete.data === 'object') return { ...athlete.data, id: athlete.id };
  return athlete;
}

function safeJson(jsonbField, key) {
  try {
    const obj = typeof jsonbField === 'string' ? JSON.parse(jsonbField) : jsonbField;
    return obj?.[key] || null;
  } catch { return null; }
}

function strNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s.toLowerCase() === 'null' ? null : s;
}

function clampScore(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 65;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function logEvent(runId, agentId, eventType, payload) {
  pool.query(
    `INSERT INTO workflow_events (run_id, agent_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [runId, agentId, eventType, JSON.stringify(payload)]
  ).catch(() => {});
}

module.exports = { matchAthleteToBrand, getMatchById, getMatchesForAthlete };
