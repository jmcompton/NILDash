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
  const { athlete, enrichment, matchScore, contact, dealScanData, agentName, agentEmail } = inputs;
  const athleteData = extractAthleteData(athlete);
  const agentSignature = agentName || 'Your Agent';
  const agentTitle = 'NIL Partnerships';

  const system = `You are a seasoned sports agent with 15 years in athlete representation. You write real emails — not marketing copy.

Your emails sound like they came from a real person who actually knows both the athlete and the brand. They are:
- Conversational but professional. Not stiff. Not corporate.
- Specific and credible. You cite real numbers and real context.
- Short paragraphs (2-4 sentences). No walls of text.
- Zero AI tell-tale phrases: no "I wanted to reach out," no "Here's why this matters," no "This is a unique opportunity," no "I believe this could be," no "I'm excited to share," no bullet points converted to prose.
- No section headers, no colons introducing lists, no "straightforward" or "simply put."
- The tone is confident but not salesy. You're not pitching — you're starting a conversation between two people who should probably work together.
- Sign off with the agent's real name and title. Never use [Agent Name] literally.

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

AGENT SIGNING THIS EMAIL:
- Name: ${agentSignature}
- Title: ${agentTitle}

Generate this exact JSON:
{
  "subject_line": "compelling subject under 60 chars — no hype words, reads like a real person wrote it",
  "personalized_intro": "2-3 sentence opening that feels personal, not canned — references something real about ${enrichment.brand_name} or the contact's role",
  "athlete_fit": "2-3 sentences on why ${athleteData.name} fits ${enrichment.brand_name} — specific, stats-grounded",
  "audience_alignment": "2 sentences on audience overlap, grounded in real numbers",
  "campaign_ideas": [
    "Specific campaign idea 1",
    "Specific campaign idea 2",
    "Specific campaign idea 3"
  ],
  "value_proposition": "3-4 sentences on what ${enrichment.brand_name} gets — concrete, not vague",
  "partnership_structure": "2-3 sentences on realistic structure (deliverables, timeline, exclusivity)",
  "roi_messaging": "2 sentences on ROI framing — engagement numbers, reach",
  "cta": "one natural, low-pressure call-to-action sentence",
  "full_email_body": "Write a complete outreach email exactly as it would appear — from greeting through sign-off. Follow ALL of these rules:\n\n1. GREETING: Use the contact's first name if known (${contactName || 'Hi there'}), followed by a comma and a line break.\n2. OPENING: Start with ONE sentence that is not about the athlete. Reference something real about ${enrichment.brand_name} — a product line, a market position, something you'd actually know if you followed their business. Do not start with 'I' as the first word.\n3. SECOND PARAGRAPH: Introduce the athlete naturally. Lead with a specific achievement or number — not their name. Let the context land before the name.\n4. THIRD PARAGRAPH: The partnership angle. What would this actually look like? Be specific about one campaign concept. No vague 'content partnership' language — describe the actual thing.\n5. FOURTH PARAGRAPH: One sentence on reach/engagement numbers. One sentence on why that audience is relevant to ${enrichment.brand_name}. That's it — don't oversell.\n6. CLOSING: Ask for 15 minutes. One sentence. Then sign off.\n7. SIGN-OFF FORMAT:\n   Best,\n   ${agentSignature}\n   ${agentTitle}\n\n8. FORBIDDEN PHRASES (do not use any of these): 'I wanted to reach out', 'unique opportunity', 'I believe', 'I think', 'exciting', 'leverage', 'synergy', 'seamless', 'Here's why', 'straightforward', 'simply put', 'I'm excited', 'I'm confident', 'thrilled', 'passion', 'game-changer', 'perfect fit', 'natural fit', 'no-brainer', any sentence starting with 'This is'.\n9. LENGTH: 180-240 words in the body. Tight. Every sentence must earn its place.\n10. NO bullet points, numbered lists, section headers, or bold text inside the email body.",
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
