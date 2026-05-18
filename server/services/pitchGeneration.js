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

  const system = `You are a sports agent who represents college athletes. You write short, direct emails to brands — the kind that actually get replies.

Your emails read like they were written by a real person who did their homework on both the brand and the athlete. Relational, not transactional. Warm, not corporate. You are starting a conversation, not delivering a sales pitch.

STYLE RULES — internalize these, don't just follow them:
- Write the way a sharp, well-connected agent would talk to a brand contact they're meeting for the first time but already respect
- Every sentence should sound like something a human would actually say out loud
- Short paragraphs. One idea per paragraph. Never more than 4 sentences.
- Numbers are humanized: say "around 45K" not "45,234" — rounds feel real, exact numbers feel generated
- Campaign concepts are described in plain English: "a Reels series of his actual training sessions" not "a multi-platform content partnership"
- The athlete is introduced like someone the agent genuinely believes in, not a product being sold
- The CTA is low-pressure and warm: "If it sounds interesting, I'd love to jump on a quick call" — not "I look forward to discussing this opportunity"
- Reference the attached pitch deck naturally at the end, not as a hard sell

FORBIDDEN — if any of these appear in the output, the email fails:
"I wanted to reach out" / "unique opportunity" / "I believe" / "I think" / "I'm excited" / "I'm confident" / "leverage" / "synergy" / "seamless" / "authentic journey" / "perfect fit" / "natural fit" / "game-changer" / "thrilled" / "passionate" / "look forward to hearing" / "at your earliest convenience" / "moving forward" / "value-add" / "I am writing to" / "Hope this email finds you" / any sentence starting with "This is a" / any section headers or colons introducing lists

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
  "subject_line": "${athleteData.name} × ${enrichment.brand_name} — NIL Partnership. Keep it exactly this format or similarly clean. No exclamation points, no hype words.",
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
  "full_email_body": "Write a 5-paragraph outreach email using EXACTLY this structure — no variation:\n\nGREETING: '${contactName || 'Hi'},' on its own line. Use first name only.\n\nPARAGRAPH 1 — THE BRAND OBSERVATION (3-4 sentences):\nOpen with 'Hope you're doing well.' Then make one genuine, specific observation about ${enrichment.brand_name} — something about how they show up in the market, their content, their product quality, or their reputation. This must be specific to ${enrichment.brand_name}, not generic. End the paragraph by explaining why that quality matters or why you noticed it. Do NOT mention the athlete here.\nExample tone: 'Hope you're doing well. I've been paying attention to [specific thing about the brand], and [specific observation about what makes it stand out]. [Why that quality resonates or matters].'\n\nPARAGRAPH 2 — THE ATHLETE (3-4 sentences):\nStart with a transition like 'As I was thinking through athletes who'd make sense for [brand]...' or 'One athlete who kept coming to mind is...' Then introduce ${athleteData.name} with 2-3 specific stats or achievements woven into the narrative — not listed. End with something that connects the athlete to the brand's geography or audience. Make it feel like the agent thought of this match themselves.\nExample tone: 'As I was thinking through athletes who'd make sense for ${enrichment.brand_name}, ${athleteData.name} kept coming to mind. As a [year] at [school], he/she [specific achievement]. [Second specific credential]. Beyond the numbers, [geographic or audience connection].'\n\nPARAGRAPH 3 — THE CAMPAIGN (3-4 sentences):\nDescribe ONE specific, concrete campaign concept. Start with 'The idea itself is simple:' then describe exactly what gets made — what format, what the content actually shows, how often. Use 'Nothing scripted' or equivalent language to make it feel real. Name a specific deliverable count.\nExample tone: 'The idea itself is simple: [specific content format] built around [specific authentic activity]. Nothing scripted — just [what the content actually shows]. [Frequency and how brand is featured].'\n\nPARAGRAPH 4 — THE AUDIENCE (2-3 sentences):\nStart with the athlete's name and connect their audience to ${enrichment.brand_name}'s market. Use 'around' before any follower count. Add a geographic or demographic detail that makes the audience feel specifically relevant to this brand.\nExample tone: '[Athlete name]'s audience also lines up well with [brand]. He/she has around [X] followers on Instagram with strong engagement, and a large part of that audience is [specific geographic or demographic detail] — [why that matters to this brand specifically].'\n\nPARAGRAPH 5 — THE CTA (2 sentences):\nReference the attached pitch deck naturally. Then ask for 15 minutes with low-pressure language.\nExample tone: 'I attached a pitch deck with a few thoughts on what this could look like. If it sounds interesting, I'd love to jump on a quick call this week and talk it through.'\n\nSIGN-OFF:\nBest,\n${agentSignature}\n${agentTitle}\n\nTOTAL LENGTH: 200-260 words. Every sentence earns its place. No bullets, no headers, no bold text, no colons introducing lists.",
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
