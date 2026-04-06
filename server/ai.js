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

async function oneShotWithSearch(prompt, systemPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const textBlocks = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; });
  return textBlocks.join('\n');
}

async function calculateRateLive(athlete, deliverableType) {
  const sport = athlete.sport || 'basketball';
  const tier = athlete.schoolTier || 'p4-mid';
  const ig = athlete.instagram || 0;
  const tt = athlete.tiktok || 0;
  const eng = athlete.engagement || 3.0;
  const prompt = 'Search for current 2026 NIL market rates for college athletes. Find: '
    + '1) Current average NIL deal rates for ' + sport + ' athletes at ' + tier + ' schools '
    + '2) Current CPM rates for college athlete Instagram posts '
    + '3) Recent reported NIL deal amounts for athletes with ' + ig.toLocaleString() + ' Instagram and ' + tt.toLocaleString() + ' TikTok followers '
    + '4) On3 NIL valuation benchmarks for ' + tier + ' ' + sport + ' athletes in 2026 '
    + '\n\nBased on this live data, calculate the rate for a ' + deliverableType + ' deal for:\n'
    + 'Sport: ' + sport + '\nSchool tier: ' + tier + '\nInstagram: ' + ig.toLocaleString() + ' followers\n'
    + 'TikTok: ' + tt.toLocaleString() + ' followers\nEngagement: ' + eng + '%\n'
    + 'Stats: ' + (athlete.stats || 'not provided') + '\n\n'
    + 'Return ONLY this JSON (no markdown):\n'
    + '{"low":0,"mid":0,"high":0,"marketContext":"2 sentences on live data found","breakdown":{"reach":0,"sportMult":0,"schoolMult":0,"engMult":0,"delivMult":0,"cpm":"0.00"}}';
  try {
    const raw = await oneShotWithSearch(prompt, 'You are a NIL market analyst. Use web search for real 2026 NIL market rates. Return only valid JSON.');
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found');
    return JSON.parse(match[0]);
  } catch (err) {
    console.error('Live rate error, falling back:', err.message);
    return null;
  }
}

function calculateRate(athlete, deliverableType) {
  const flatFees = MARKET_RATES.appearanceFees;
  if (flatFees && flatFees[deliverableType]) {
    const fees = flatFees[deliverableType];
    const tier = athlete.schoolTier || 'mid-lower';
    let range;
    if (tier === 'p4-top10') range = fees.p4top;
    else if (tier === 'p4-mid') range = fees.p4mid;
    else if (tier === 'p4-lower') range = fees.p4low;
    else range = fees.mid;
    const sportPremium = (athlete.sport === 'basketball' || athlete.sport === 'football') ? 1.25 : 1.0;
    const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);
    const reachBonus = reach > 500000 ? 1.20 : reach > 100000 ? 1.12 : reach > 25000 ? 1.06 : 1.0;
    return {
      low:  Math.round(range[0] * sportPremium * reachBonus / 100) * 100,
      mid:  Math.round(((range[0] + range[1]) / 2) * sportPremium * reachBonus / 100) * 100,
      high: Math.round(range[1] * sportPremium * reachBonus / 100) * 100,
      breakdown: { reach: Math.round(reach), pricingModel: 'flat-fee', tier: tier, sportPremium: sportPremium, reachBonus: reachBonus },
      pricingNote: 'Flat-fee rate based on school tier, sport, and social reach.',
    };
  }
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
    breakdown: { reach: Math.round(reach), pricingModel: 'reach-based', sportMult: sport, schoolMult: school, engMult: eng, delivMult: deliv, cpm: ((raw / reach) * 1000).toFixed(2) },
  };
}

async function getDealRecommendations(athlete, role) {
  const rate = calculateRate(athlete, 'ig-reel');
  const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);
  const tier = reach > 500000 ? 'macro' : reach > 100000 ? 'mid' : reach > 25000 ? 'micro' : 'nano';
  const market = (athlete.school || 'college').replace('University','').replace('College','').trim();
  const prompt = `You are researching NIL brand deals. Search the web for these specific queries:
1. "${athlete.sport} NIL deal brand partnership 2025 2026" — find brands with proven track records
2. "NIL sponsorship ${athlete.schoolTier} ${athlete.sport} 2026" — find tier-appropriate sponsors  
3. "college ${athlete.sport} athlete brand ambassador 2026" — find active programs
4. "${market} local business NIL college athlete" — find regional/local angle

ATHLETE PROFILE:
Name: ${athlete.name} | Sport: ${athlete.sport} | Position: ${athlete.position || 'N/A'} | Year: ${athlete.year || 'N/A'}
School: ${athlete.school || 'Unknown'} (${athlete.schoolTier || 'college'})
Reach: ${(athlete.instagram||0).toLocaleString()} IG + ${(athlete.tiktok||0).toLocaleString()} TikTok | Engagement: ${athlete.engagement||0}% | Tier: ${tier}
Stats: ${athlete.stats || 'N/A'} | Notes: ${athlete.notes || 'N/A'}

Using your search results, recommend 6 brands ranked by realistic fit:
- Prioritize brands with DOCUMENTED NIL activity found in your search
- Include 1+ local/regional brand near ${market}
- Include 1+ sport-specific brand for ${athlete.sport}
- Include 1+ non-obvious emerging brand matching this athlete's audience
- Rate ranges by tier: nano $50-500/post, micro $200-2000, mid $1000-8000, macro $5000+
- Only recommend Nike/Adidas/Gatorade if search confirms active NIL programs for ${athlete.schoolTier} level

Return ONLY a JSON array of 6 deals:
[{
  "rank": 1,
  "brand": "Exact Brand Name",
  "campaign": "Specific realistic campaign concept for THIS athlete",
  "category": "nutrition|apparel|tech|finance|food|beverage|gaming|auto|grooming|local",
  "rationale": "Why this brand — cite known NIL activity or specific audience match",
  "suggestedRate": { "low": 0, "high": 0 },
  "timingNote": "Why now — seasonal, budget cycle, or confirmed recent NIL activity",
  "fitScore": 90,
  "dealType": "post|reel|ambassador|appearance|licensing"
}]`
  try {
    const raw = await oneShotWithSearch(prompt, 'You are a NIL deal scout who finds real brand partnerships. Search for brands actively doing NIL deals. Prioritize accuracy and variety over big names. Never just list Nike/Adidas/Gatorade unless they truly fit. Return only valid JSON.');
    const c = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const si = c.indexOf('['), ei = c.lastIndexOf(']');
    if (si === -1 || ei <= si) throw new Error('No array');
    return JSON.parse(c.substring(si, ei + 1));
  } catch {
    return [{ rank:1, brand:'Local Brand', campaign:'Brand Ambassador', category:'apparel',
      rationale:'Strong fit for this athlete profile.', fitScore:75,
      suggestedRate:{ low: rate.low, high: rate.high }, timingNote:'Open', dealType:'post' }];
  }
}

module.exports = { streamResponse, oneShot, oneShotWithSearch, calculateRate, calculateRateLive, getDealRecommendations, buildSystemPrompt };
