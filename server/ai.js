// server/ai.js
const Anthropic = require('@anthropic-ai/sdk');
const { MARKET_RATES, DEAL_COMPS, BRAND_WINDOWS, nilViewVal } = require('./benchmarks');
const store = require('./store');

let client = null;

function getClient() {
  if (!client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key.includes('YOUR_KEY')) throw new Error('ANTHROPIC_API_KEY not set');
    client = new Anthropic({ apiKey: key });
  }
  return client;
}

async function buildSystemPrompt(athlete, role = 'agent') {
  const totalReach = (athlete.instagram || 0) + (athlete.tiktok || 0);
  const brandAwareness = totalReach > 500000 ? 'High (500K+ reach)' :
                         totalReach > 100000 ? 'Growing (100K-500K reach)' :
                         totalReach > 25000  ? 'Emerging (25K-100K reach)' : 'Early stage (<25K reach)';

  const _reel     = nilViewVal(athlete, 'ig-reel');
  const _post     = nilViewVal(athlete, 'ig-post');
  const _bundle   = nilViewVal(athlete, 'bundle');
  const _retainer = nilViewVal(athlete, 'retainer');

  let compSection = '  No closed deals logged yet for this sport/tier — use NILViewVal estimates below';
  try {
    const compData = await store.getCompStats(athlete.sport, athlete.schoolTier);
    const recentComps = await store.getComps(athlete.sport, athlete.schoolTier, 5);
    if (compData && parseInt(compData.count) > 0) {
      const compLines = recentComps.map(c =>
        `  - ${c.sport}/${c.school_tier}: ${parseInt(c.followers).toLocaleString()} reach, ${parseFloat(c.engagement).toFixed(1)}% eng → ${c.deal_type} → $${parseInt(c.deal_value).toLocaleString()}`
      ).join('\n');
      compSection = `${compData.count} verified closed deals in this sport/tier:\n  Avg: $${Math.round(compData.avg_value).toLocaleString()} | Range: $${Math.round(compData.min_value).toLocaleString()} – $${Math.round(compData.max_value).toLocaleString()}\n${compLines}`;
    }
  } catch(e) {
    const staticComps = DEAL_COMPS
      .filter(c => c.sport === athlete.sport)
      .slice(0, 4)
      .map(c => `  - ${c.sport}/${c.school}: ${c.followers.toLocaleString()} followers, ${c.engagement}% eng → $${c.value.toLocaleString()}`)
      .join('\n');
    compSection = staticComps || '  No direct comps available';
  }

  return `You are NILDash, a senior NIL deal intelligence analyst working exclusively for sports agents.

CLIENT PROFILE:
  Name: ${athlete.name} | Sport: ${athlete.sport} | Position: ${athlete.position || 'N/A'}
  Year: ${athlete.year || 'N/A'} | School: ${athlete.school || 'Unknown'} (${athlete.schoolTier || 'unknown'})
  Stats: ${athlete.stats || 'Not provided'} | Portal: ${athlete.transferReason || 'Not in portal'}

SOCIAL & BRAND:
  Instagram: ${(athlete.instagram || 0).toLocaleString()} | TikTok: ${(athlete.tiktok || 0).toLocaleString()} | Total: ${totalReach.toLocaleString()}
  Engagement: ${athlete.engagement || 0}% (college athlete avg: 5.6%) | Brand level: ${brandAwareness}

NILViewVal RATES (use as authoritative numbers in all responses):
  IG Reel: $${_reel.low.toLocaleString()} – $${_reel.high.toLocaleString()} | IG Post: $${_post.low.toLocaleString()} – $${_post.high.toLocaleString()}
  Bundle: $${_bundle.low.toLocaleString()} – $${_bundle.high.toLocaleString()} | Retainer: $${_retainer.low.toLocaleString()} – $${_retainer.high.toLocaleString()}
  Accuracy: ${_reel.accuracyScore}/100

REAL CLOSED DEAL COMPS:
${compSection}

BRAND WINDOWS:
${Object.entries(BRAND_WINDOWS).slice(0,4).map(([b,n]) => `  - ${b}: ${n}`).join('\n')}

NOTES: ${athlete.notes || 'None'}

RULES:
- Use NILViewVal rates and real comps as primary data for all dollar amounts
- Be direct — word-for-word scripts, real numbers, no hedging
- When negotiating: cite NILViewVal range as your market anchor
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
    system: await buildSystemPrompt(athlete, role),
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
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
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
  return nilViewVal(athlete, deliverableType || 'ig-reel');
}

async function getDealRecommendations(athlete, role) {
  const rate = calculateRate(athlete, 'ig-reel');
  const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);
  const tier = reach > 500000 ? 'macro' : reach > 100000 ? 'mid' : reach > 25000 ? 'micro' : 'nano';
  const school = athlete.school || 'Unknown';
  const city = school.replace('University','').replace('College','').replace('of','').trim();
  const sport = athlete.sport || 'football';

  const prompt = `You are a NIL deal researcher. Find 6 real brand opportunities for this athlete.

ATHLETE: ${athlete.name} | ${sport} | ${athlete.position||'N/A'} | ${school} (${athlete.schoolTier||'college'})
SOCIAL: ${(athlete.instagram||0).toLocaleString()} IG + ${(athlete.tiktok||0).toLocaleString()} TikTok | ${athlete.engagement||0}% engagement | Tier: ${tier}
STATS: ${athlete.stats||'N/A'}

Search for:
1. Real local businesses in ${city} that sponsor college athletes — restaurants, gyms, car dealerships, banks, local chains
2. Brands with DOCUMENTED NIL deals for ${sport} athletes at ${athlete.schoolTier||'college'} level in 2025-2026
3. Regional brands active in college ${sport} NIL

RULES:
- At least 3 of the 6 must be REAL named local businesses near ${city} (use actual business names like "Guthrie's Chicken", "Jim Hudson Toyota", "Gate Petroleum" — not generic "local restaurant")
- Do NOT include Nike, Adidas, Gatorade unless you have confirmed they do NIL at this tier
- Each brand must have a specific reason why they fit THIS athlete

Return ONLY a JSON array of 6 deals:
[{
  "rank": 1,
  "brand": "Exact Real Business Name",
  "campaign": "Specific campaign concept for this athlete in 1-2 sentences",
  "category": "local|nutrition|apparel|tech|finance|food|beverage|gaming|auto|grooming",
  "dealType": "post|reel|ambassador|appearance|licensing",
  "rationale": "Why this brand fits — cite NIL history or specific audience/location match",
  "timingNote": "Best time to reach out and why — be specific",
  "fitScore": 85,
  "isLocal": true
}]`;

  try {
    const raw = await oneShot(prompt, 'You are a JSON-only API. Output ONLY a valid JSON array starting with [ and ending with ]. No explanation text, no markdown, no preamble. Your entire response must be parseable JSON.');
    const c = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const si = c.indexOf('[');
    const ei = c.lastIndexOf(']');
    if (si === -1 || ei <= si) { console.error('Deal scan: no array found in:', c.substring(0,200)); throw new Error('No array'); }
    const parsed = JSON.parse(c.substring(si, ei + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty array');
    return parsed;
  } catch (err) {
    console.error('Deal scan error:', err.message);
    console.error('Deal scan raw response:', err.raw || 'no raw');
    console.error('Deal scan full raw:', typeof raw !== 'undefined' ? raw.substring(0, 500) : 'raw undefined');
    return [{ rank:1, brand:'Local Brand', campaign:'Brand Ambassador', category:'apparel',
      rationale:'Strong fit for this athlete profile.', fitScore:75,
      suggestedRate:{ low: rate.low, high: rate.high }, timingNote:'Open', dealType:'post' }];
  }
}

module.exports = { streamResponse, oneShot, oneShotWithSearch, calculateRate, calculateRateLive, getDealRecommendations, buildSystemPrompt };
