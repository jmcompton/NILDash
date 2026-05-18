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

const { oneShot, FEATURE_EMAIL_V2 } = require('../ai');

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

  // ── System prompt: v2 vs legacy ──────────────────────────────
  const system = FEATURE_EMAIL_V2
    ? `You are a NIL agent or operator who books deals for college athletes. You write emails the way a real person would — short, direct, and easy to reply to. Not a pitch deck. Not marketing copy. An email.

The goal of every email is to start a conversation — not close the deal. One idea, clearly stated, low pressure.

VOICE:
- Read like an email from someone who actually knows what they're talking about
- Slightly understated — the athlete's record should speak, not your enthusiasm
- Conversational but not casual to the point of being sloppy
- One idea per paragraph, never more than 3 sentences per paragraph

LENGTH: 150–175 words for full_email_body. Every sentence earns its place.

STRUCTURE (follow this order, no extras):
1. One observational opener about the brand — something specific, not flattery. Attach to a brief intro line.
2. Who the athlete is — 1 short paragraph, 1–2 facts that matter
3. One content idea — plain English. What it actually is. No over-explaining.
4. Audience connection — 1–2 lines, grounded, not effusive
5. Soft close — "Happy to share more if helpful." or similar. Mention pitch deck naturally.
6. Sign off: Name, Role

FORBIDDEN — any of these in full_email_body causes the output to fail:
"The idea itself is simple" / "As I was thinking through" / "One athlete who kept coming to mind" / "stands out because" / "Hope you're doing well" as a standalone sentence / "I wanted to reach out" / "unique opportunity" / "perfect fit" / "natural fit" / "game-changer" / "thrilled" / "passionate" / "I'm excited" / "I'm confident" / "synergy" / "leverage" / "seamless" / "authentic journey" / "look forward to hearing" / "at your earliest convenience" / "if it sounds interesting, I'd love to jump on a call" / "moving forward" / "value-add" / "I am writing to" / "Hope this email finds you" / any sentence starting with "This is a" / any section headers or colons introducing bullet lists

Return ONLY valid JSON. No markdown code blocks.`
    : `You are a sports agent who represents college athletes. You write short, direct emails to brands — the kind that actually get replies.

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

  // ── Email body instruction — v2 vs legacy ─────────────────────
  const emailBodyInstruction = FEATURE_EMAIL_V2
    ? `Write a short, direct outreach email from ${agentSignature} to ${contactName || 'the contact'}.

Greeting: "${contactName || 'Hi'}," on its own line.

Paragraph 1 (2-3 sentences): Open with one specific, observational remark about ${enrichment.brand_name} — something you'd notice if you actually follow the brand. Attach a brief line on why you're writing. Do NOT start with "Hope you're doing well." Do not flatter.

Paragraph 2 (2-3 sentences): Introduce ${athleteData.name} — who they are and one or two facts that actually matter. Keep it grounded.

Paragraph 3 (2-3 sentences): Describe one content idea in plain English. What it is. How it naturally involves ${enrichment.brand_name}. Do not over-explain or use any campaign jargon.

Paragraph 4 (1-2 sentences): How ${athleteData.name}'s audience lines up with ${enrichment.brand_name}. Specific, not effusive.

Paragraph 5 (2 sentences): "I've attached a quick overview if helpful." Then a soft close — "Happy to share more if it's worth a conversation." or similar.

Sign off:
Best,
${agentSignature}
${agentTitle}

Total: 150-175 words. No headers. No bullets. No bold text. Reads like a real email from a real person.`
    : `Write a 5-paragraph outreach email.
Greeting: "${contactName || 'Hi'}," on its own line.
P1 (2-3 sentences): Observation about ${enrichment.brand_name}.
P2 (2-3 sentences): Introduce ${athleteData.name} with 1-2 key credentials.
P3 (2-3 sentences): One specific campaign idea in plain English.
P4 (1-2 sentences): Audience alignment — grounded, use "around" before numbers.
P5 (2 sentences): Soft close referencing the attached pitch deck.
Sign off: Best, ${agentSignature} / ${agentTitle}
Total: 160-200 words. No bullets. No headers.`;

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
  "subject_line": "${athleteData.name} × ${enrichment.brand_name} — NIL. Clean format. No exclamation points.",
  "personalized_intro": "1-2 sentences — one specific, observational opening about ${enrichment.brand_name}. Not flattery. Not generic.",
  "athlete_fit": "2 sentences — why ${athleteData.name} fits ${enrichment.brand_name}, grounded in stats or geography",
  "audience_alignment": "1-2 sentences on audience overlap, specific and grounded",
  "campaign_ideas": [
    "One plain-English content idea — what it actually is, nothing over-explained",
    "Second concrete idea",
    "Third concrete idea"
  ],
  "value_proposition": "2-3 sentences on what ${enrichment.brand_name} actually gets — concrete, not vague",
  "partnership_structure": "2 sentences — realistic deliverables and timeline",
  "roi_messaging": "1-2 sentences on reach and engagement — use 'around' before any follower number",
  "cta": "Happy to share more if helpful.",
  "full_email_body": "${emailBodyInstruction}",
  "deck_talking_points": [
    "Specific point 1 — grounded in athlete data",
    "Specific point 2",
    "Specific point 3",
    "Specific point 4",
    "Specific point 5"
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
