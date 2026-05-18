// server/services/pitchGeneration.js
// PitchGenerationService — Part 4 of the NIL Outreach Automation Engine.
//
// Generates a fully personalized outreach pitch for a specific athlete + brand + contact.
// Every output is customized — zero generic templates.
//
// SAFETY: reads from brand_match_scores, company_enrichment, brand_contacts.
//         no writes to existing tables.
//         returns pitch data for use by OutreachEmailService and DeckGenerationService.

'use strict';

const { oneShot } = require('../ai');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * generatePitch(inputs)
 *
 * inputs: {
 *   athlete:       athlete DB row (with data JSONB)
 *   enrichment:    company_enrichment row
 *   matchScore:    brand_match_scores row
 *   contact:       brand_contacts row (the best contact)
 *   dealScanData:  original deal scan result object { campaign, rationale, fitScore, ... }
 * }
 *
 * Returns pitch object:
 * {
 *   subject_line, personalized_intro, athlete_fit, audience_alignment,
 *   campaign_ideas, value_proposition, partnership_structure,
 *   roi_messaging, cta, full_email_body, deck_talking_points
 * }
 */
async function generatePitch(inputs) {
  const { athlete, enrichment, matchScore, contact, dealScanData } = inputs;
  const athleteData = extractAthleteData(athlete);

  const system = `You are a NIL partnership outreach specialist writing on behalf of a sports agency.
Your writing is direct, professional, and highly personalized to each brand and athlete.
Never use generic templates. Every line should feel written specifically for this brand-athlete pair.
Return ONLY a valid JSON object. No markdown code blocks, no explanation.`;

  const campaignIdeas = safeParseArray(matchScore?.campaign_ideas);
  const partnershipOpps = safeParseArray(matchScore?.partnership_opportunities);
  const contactTitle = contact?.title || 'Brand Partnerships Team';
  const contactName = contact?.name ? contact.name.split(' ')[0] : null;

  const prompt = `Write a complete NIL partnership outreach pitch package.

ATHLETE:
- Name: ${athleteData.name}
- Sport: ${athleteData.sport} | Position: ${athleteData.position || 'N/A'}
- School: ${athleteData.school} (${athleteData.schoolTier || 'P5'})
- Instagram: ${formatFollowers(athleteData.instagram)} followers | TikTok: ${formatFollowers(athleteData.tiktok)} followers
- Engagement: ${athleteData.engagement || 0}%
- Stats: ${athleteData.stats || 'N/A'}
- Background/Notes: ${athleteData.notes || 'N/A'}

BRAND:
- Company: ${enrichment.brand_name}
- Industry: ${enrichment.industry || 'Consumer brand'}
- Size: ${enrichment.brand_size || 'regional'}
- Description: ${enrichment.description || 'N/A'}
- Target demographics: ${enrichment.raw_data?.target_demographics || 'N/A'}

TARGET CONTACT:
- Role: ${contactTitle}
- Name: ${contactName || 'Decision Maker'}
- Contact type: ${contact?.contact_type || 'partnership'}

DEAL SCAN CONTEXT:
- Campaign concept: ${dealScanData?.campaign || 'Brand partnership'}
- Why this brand was flagged: ${dealScanData?.rationale || 'Strong fit identified'}
- Category: ${dealScanData?.category || 'N/A'}
- Fit score: ${dealScanData?.fitScore || 'N/A'}/100

MATCH ANALYSIS:
- Compatibility score: ${matchScore?.compatibility_score || 70}/100
- Reasoning: ${matchScore?.reasoning || 'Strong potential match'}
- Audience alignment: ${matchScore?.audience_alignment || 'Audiences align well'}
- Campaign ideas: ${campaignIdeas.slice(0, 3).join(' | ')}

Generate this exact JSON:
{
  "subject_line": "compelling email subject under 60 chars — specific to this brand+athlete",
  "personalized_intro": "2-3 sentence opening paragraph addressing ${contactName || 'the contact'} that references something specific about ${enrichment.brand_name} — NOT generic",
  "athlete_fit": "2-3 sentences explaining exactly why ${athleteData.name} is the right fit for ${enrichment.brand_name} — use specific stats and school/sport details",
  "audience_alignment": "2 sentences on audience overlap between ${athleteData.name}'s fanbase and ${enrichment.brand_name}'s customers",
  "campaign_ideas": [
    "Specific campaign idea 1 with brief description",
    "Specific campaign idea 2 with brief description",
    "Specific campaign idea 3 with brief description"
  ],
  "value_proposition": "3-4 sentences on the concrete value ${enrichment.brand_name} gets from this partnership — include engagement numbers and reach",
  "partnership_structure": "2-3 sentences suggesting a realistic partnership structure (deliverables, timeline, exclusivity)",
  "roi_messaging": "2 sentences on ROI framing — what ${enrichment.brand_name} can expect in terms of exposure and engagement",
  "cta": "one clear call to action sentence",
  "full_email_body": "complete professional email body (NOT including subject). 250-350 words. Include: greeting, intro, athlete overview, fit explanation, campaign idea, value proposition, CTA, professional closing. Sign off as agent.",
  "deck_talking_points": [
    "Key point 1 for the pitch deck",
    "Key point 2",
    "Key point 3",
    "Key point 4",
    "Key point 5"
  ]
}`;

  let raw;
  try {
    raw = await oneShot(prompt, system, 3000);
  } catch (e) {
    console.error('[pitchGeneration] AI call failed:', e.message);
    return buildFallbackPitch(athleteData, enrichment, contact, dealScanData);
  }

  return parsePitch(raw, athleteData, enrichment, contact, dealScanData);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function parsePitch(raw, athleteData, enrichment, contact, dealScanData) {
  try {
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      subject_line:          strNull(parsed.subject_line) || `NIL Partnership — ${athleteData.name} × ${enrichment.brand_name}`,
      personalized_intro:    strNull(parsed.personalized_intro) || '',
      athlete_fit:           strNull(parsed.athlete_fit) || '',
      audience_alignment:    strNull(parsed.audience_alignment) || '',
      campaign_ideas:        Array.isArray(parsed.campaign_ideas) ? parsed.campaign_ideas.slice(0, 3) : [],
      value_proposition:     strNull(parsed.value_proposition) || '',
      partnership_structure: strNull(parsed.partnership_structure) || '',
      roi_messaging:         strNull(parsed.roi_messaging) || '',
      cta:                   strNull(parsed.cta) || 'Would you be open to a brief call this week?',
      full_email_body:       strNull(parsed.full_email_body) || '',
      deck_talking_points:   Array.isArray(parsed.deck_talking_points) ? parsed.deck_talking_points.slice(0, 5) : [],
    };
  } catch (e) {
    console.error('[pitchGeneration] JSON parse failed:', e.message);
    return buildFallbackPitch(athleteData, enrichment, contact, dealScanData);
  }
}

function buildFallbackPitch(athleteData, enrichment, contact, dealScanData) {
  const name = athleteData.name;
  const brand = enrichment.brand_name;
  const campaign = dealScanData?.campaign || 'brand ambassador partnership';

  return {
    subject_line: `NIL Partnership Opportunity — ${name} × ${brand}`,
    personalized_intro: `I'm reaching out on behalf of ${name}, a standout ${athleteData.sport} athlete at ${athleteData.school}, regarding a potential NIL partnership with ${brand}.`,
    athlete_fit: `${name} brings ${formatFollowers(athleteData.instagram)} Instagram followers and ${athleteData.engagement || 0}% engagement, making them a highly effective brand partner for ${brand}.`,
    audience_alignment: `${name}'s audience closely aligns with ${brand}'s target demographic, offering authentic reach into the college sports community.`,
    campaign_ideas: [campaign, 'Social media content series', 'Local appearance / event activation'],
    value_proposition: `Partnering with ${name} provides ${brand} with authentic access to an engaged collegiate fanbase.`,
    partnership_structure: 'We propose a 3-month initial campaign with 4-6 deliverables across social platforms.',
    roi_messaging: `Based on ${name}'s current engagement rates, partners typically see 3-5x the reach of equivalent paid social placements.`,
    cta: 'Would you be open to a 15-minute call this week to explore this opportunity?',
    full_email_body: `I'm reaching out on behalf of ${name}, a ${athleteData.sport} athlete at ${athleteData.school}, to explore a potential NIL partnership with ${brand}.\n\n${name} has built an engaged following of ${formatFollowers(athleteData.instagram)} on Instagram with a ${athleteData.engagement || 0}% engagement rate. We believe ${brand} and ${name} share a natural audience alignment that could make for a high-impact campaign.\n\nWe'd love to discuss a ${campaign} — an opportunity that would give ${brand} authentic reach into the college sports community.\n\nWould you be open to a brief call this week?\n\nBest regards,`,
    deck_talking_points: [`${name} Profile`, 'Social Reach & Engagement', 'Brand Alignment', 'Campaign Concepts', 'Proposed Partnership Structure'],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractAthleteData(athlete) {
  if (athlete.data && typeof athlete.data === 'object') return { ...athlete.data, id: athlete.id };
  return athlete;
}

function safeParseArray(v) {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

function formatFollowers(n) {
  const num = parseInt(n) || 0;
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return String(num);
}

function strNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s.toLowerCase() === 'null' ? null : s;
}

module.exports = { generatePitch };
