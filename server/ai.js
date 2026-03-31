// server/ai.js
const Anthropic = require('@anthropic-ai/sdk');
const { MARKET_RATES, DEAL_COMPS, BRAND_WINDOWS } = require('./benchmarks');

let client = null;

function getClient() {
  if (!client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key.includes('YOUR_KEY')) throw new Error('ANTHROPIC_API_KEY not set');
    client = new Anthropic({ apiKey: key });
  }
  return client;
}

function buildSystemPrompt(athlete, role = 'agent') {
  const sportMult  = MARKET_RATES.sportMultiplier[athlete.sport] || 1.0;
  const schoolMult = MARKET_RATES.schoolMultiplier[athlete.schoolTier] || 1.0;
  const engMult    = MARKET_RATES.engagementMultiplier(athlete.engagement);
  const comps = DEAL_COMPS
    .filter(c => c.sport === athlete.sport || c.school === athlete.schoolTier)
    .slice(0, 4)
    .map(c => `  - ${c.sport}/${c.school}: ${c.followers.toLocaleString()} followers, ${c.engagement}% eng → ${c.dealType} → $${c.value.toLocaleString()} (${c.year})`)
    .join('\n');

  const persona = role === 'athlete'
    ? 'You are NILDash, an AI advisor helping a college athlete understand their NIL value and opportunities.'
    : 'You are NILDash, a senior NIL deal intelligence analyst working exclusively for sports agents.';

  const totalReach = (athlete.instagram || 0) + (athlete.tiktok || 0);
  const brandAwareness = totalReach > 500000 ? 'High (500K+ reach)' :
                         totalReach > 100000 ? 'Growing (100K-500K reach)' :
                         totalReach > 25000  ? 'Emerging (25K-100K reach)' : 'Early stage (<25K reach)';

  return `${persona}

CLIENT PROFILE:
  Name: ${athlete.name}
  Sport: ${athlete.sport}
  Position: ${athlete.position || 'Not specified'}
  Year: ${athlete.year || 'Not specified'}
  School: ${athlete.school || 'Unknown'} (Tier: ${athlete.schoolTier || 'Unknown'})
  Key Stats: ${athlete.stats || 'Not provided'}
  Portal Status: ${athlete.transferReason || 'Not in portal'}

SOCIAL & BRAND PROFILE:
  Instagram: ${(athlete.instagram || 0).toLocaleString()} followers
  TikTok: ${(athlete.tiktok || 0).toLocaleString()} followers
  Combined reach: ${totalReach.toLocaleString()}
  Engagement rate: ${athlete.engagement || 0}% (industry avg: ${MARKET_RATES.industryAvgEngagement.combined}%)
  Brand awareness level: ${brandAwareness}
  Engagement multiplier: ${engMult}× vs market

NIL MARKET DATA:
  Base rate: $${MARKET_RATES.basePer1kReach}/1K reach at 3% engagement
  Sport multiplier: ${sportMult}× (${athlete.sport})
  School multiplier: ${schoolMult}× (${athlete.schoolTier || 'unknown'})
  Estimated rate range: $${Math.round((totalReach/1000) * MARKET_RATES.basePer1kReach * sportMult * schoolMult * engMult * 0.85 / 100) * 100} - $${Math.round((totalReach/1000) * MARKET_RATES.basePer1kReach * sportMult * schoolMult * engMult * 1.25 / 100) * 100} per post

COMPARABLE DEALS:
${comps || '  No direct comps — use general market rates'}

BRAND BUDGET WINDOWS:
${Object.entries(BRAND_WINDOWS).slice(0,4).map(([b,n]) => `  - ${b}: ${n}`).join('\n')}

ADDITIONAL CONTEXT:
  ${athlete.notes || 'None'}

RULES:
- Use ALL profile data above — stats, year, school tier, social reach, engagement
- Be direct and specific. Use real dollar amounts based on their actual reach and engagement
- Factor in brand awareness level when recommending deals
- When recommending deals: explain why THIS athlete specifically based on their stats and profile
- When giving pricing: show the math using their actual numbers
- When giving negotiation scripts: word-for-word language only
- Max 400 words unless asked for more`;
}

async function streamResponse(athlete, message, role, res) {
  const ai = getClient();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const stream = ai.messages.stream({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: buildSystemPrompt(athlete, role),
    messages: [{ role: 'user', content: message }],
  });

  stream.on('text', text => res.write(`data: ${JSON.stringify({ text })}\n\n`));
  stream.on('error', err => {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  });
  await stream.finalMessage();
  res.write('data: [DONE]\n\n');
  res.end();
}

async function oneShot(prompt, system) {
  const ai = getClient();
  const msg = await ai.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 8000,
    system: system || 'You are a precise NIL deal analyst.',
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text;
}

function calculateRate(athlete, deliverableType) {
  const reach    = athlete.instagram + athlete.tiktok * 0.75;
  const sport    = MARKET_RATES.sportMultiplier[athlete.sport] || 1.0;
  const school   = MARKET_RATES.schoolMultiplier[athlete.schoolTier] || 1.0;
  const eng      = MARKET_RATES.engagementMultiplier(athlete.engagement);
  const deliv    = MARKET_RATES.deliverableMultiplier[deliverableType] || 1.0;
  const raw      = (reach / 1000) * MARKET_RATES.basePer1kReach * sport * school * eng * deliv;
  return {
    low:  Math.round(raw * 0.85 / 100) * 100,
    mid:  Math.round(raw / 100) * 100,
    high: Math.round(raw * 1.25 / 100) * 100,
    breakdown: {
      reach: Math.round(reach),
      sportMult: sport, schoolMult: school,
      engMult: eng, delivMult: deliv,
      cpm: ((raw / reach) * 1000).toFixed(2),
    },
  };
}

async function getDealRecommendations(athlete, role) {
  const rate = calculateRate(athlete, 'ig-reel');
  const prompt = `Rank the top 6 NIL brand deals for this athlete right now.
Return ONLY a JSON array, no markdown:
[{
  "rank": 1,
  "brand": "Brand Name",
  "campaign": "Specific concept",
  "category": "footwear|beverage|tech|apparel|finance|gaming",
  "rationale": "Why this brand fits THIS athlete (2 sentences)",
  "suggestedRate": { "low": 0, "high": 0 },
  "timingNote": "Urgent/seasonal/open",
  "fitScore": 90
}]`;
  try {
    const raw = await oneShot(prompt, buildSystemPrompt(athlete, role));
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return [{ rank:1, brand:'Nike', campaign:'Brand Ambassador', category:'footwear',
      rationale:'Strong fit for this athlete profile.', fitScore:85,
      suggestedRate:{ low: rate.low, high: rate.high }, timingNote:'Open' }];
  }
}

module.exports = { streamResponse, oneShot, calculateRate, getDealRecommendations, buildSystemPrompt };
