// server/ai.js — NILDash AI Engine v4
// v4: improved system prompt with v4 scores, AI marketing tools, improved team match context

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

const SPORT_CONFERENCE_MAP = {
  'football': {
    topConferences: ['SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12'],
    risingConferences: ['American Athletic', 'Mountain West', 'Sun Belt', 'MAC', 'C-USA'],
    note: 'NIL strongest in SEC and Big Ten. Big 12 and ACC also significant. G5 programs have smaller but growing collective budgets.'
  },
  'basketball': {
    topConferences: ['Big Ten', 'SEC', 'Big 12', 'ACC', 'Big East', 'Pac-12'],
    risingConferences: ['American Athletic', 'Mountain West', 'A-10', 'WCC', 'MVC'],
    note: 'Big East is elite for basketball NIL despite no football. Kansas, Kentucky, Duke, UNC command premium rates. Mid-major stars at Gonzaga, Saint Marys can earn well.'
  },
  'hockey': {
    topConferences: ['Big Ten', 'NCHC', 'Hockey East', 'CCHA', 'ECAC'],
    risingConferences: ['Atlantic Hockey', 'WCHA'],
    note: 'SEC has almost NO hockey programs — never recommend SEC for hockey. Top hockey NIL markets: Minnesota, Michigan, Wisconsin, Boston University, Boston College, Notre Dame, Denver.'
  },
  'baseball': {
    topConferences: ['SEC', 'ACC', 'Big 12', 'Pac-12', 'Sun Belt'],
    risingConferences: ['American Athletic', 'Mountain West', 'Big West'],
    note: 'SEC dominates college baseball NIL. LSU, Arkansas, Vanderbilt, Tennessee are premier programs. Draft status is a massive NIL multiplier for baseball.'
  },
  'soccer': {
    topConferences: ['ACC', 'Big Ten', 'Pac-12', 'SEC', 'Big East'],
    risingConferences: ['American Athletic', 'WCC', 'A-10'],
    note: 'ACC and Big Ten lead soccer NIL. International players with overseas followings can command premium rates regardless of conference.'
  },
  'softball': {
    topConferences: ['SEC', 'Pac-12', 'ACC', 'Big 12', 'Big Ten'],
    risingConferences: ['American Athletic', 'Mountain West', 'Sun Belt'],
    note: 'SEC and Oklahoma/Texas dominate softball NIL.'
  },
  'volleyball': {
    topConferences: ['Big Ten', 'Pac-12', 'SEC', 'ACC', 'Big 12'],
    risingConferences: ['American Athletic', 'Mountain West', 'WCC'],
    note: 'Nebraska, Wisconsin, Texas, Stanford lead volleyball NIL. Female athletes in volleyball often outperform expectations on social.'
  },
  'gymnastics': {
    topConferences: ['SEC', 'Pac-12', 'Big Ten', 'ACC'],
    risingConferences: ['Mountain West', 'Big 12'],
    note: 'SEC gymnastics leads NIL by far — LSU, Florida, Alabama, Georgia. Gymnasts often have the highest per-follower brand value of any college sport.'
  },
  'wrestling': {
    topConferences: ['Big Ten', 'Big 12', 'ACC', 'EIWA'],
    risingConferences: ['MAC', 'PAC', 'SoCon'],
    note: 'Big Ten dominates wrestling NIL. Penn State, Iowa, Ohio State are top programs.'
  },
  'lacrosse': {
    topConferences: ['ACC', 'Big Ten', 'Ivy League', 'Patriot League', 'CAA'],
    risingConferences: ['American Athletic', 'SoCon'],
    note: 'ACC leads lacrosse NIL. Maryland, Virginia, Notre Dame, Duke are top programs.'
  },
  'swimming': {
    topConferences: ['SEC', 'Big Ten', 'Pac-12', 'ACC', 'Big 12'],
    risingConferences: ['American Athletic', 'Mountain West'],
    note: 'Olympic years dramatically spike swimming NIL values. Cal, Texas, Stanford, Florida lead.'
  },
  'track': {
    topConferences: ['SEC', 'Big 12', 'Pac-12', 'ACC', 'Big Ten'],
    risingConferences: ['Mountain West', 'American Athletic'],
    note: 'Olympic track stars command premium NIL. SEC and Big 12 lead.'
  }
};

function getSportConferenceContext(sport) {
  const s = (sport || '').toLowerCase();
  for (const [key, val] of Object.entries(SPORT_CONFERENCE_MAP)) {
    if (s.includes(key)) return val;
  }
  return {
    topConferences: ['Big Ten', 'SEC', 'Big 12', 'ACC'],
    risingConferences: ['American Athletic', 'Mountain West'],
    note: 'Research sport-specific conference NIL landscape before making recommendations.'
  };
}

async function buildSystemPrompt(athlete, role = 'agent') {
  const totalReach = (athlete.instagram || 0) + (athlete.tiktok || 0);
  const brandAwareness = totalReach > 500000 ? 'High (500K+ reach)' :
                         totalReach > 100000 ? 'Growing (100K-500K reach)' :
                         totalReach > 25000  ? 'Emerging (25K-100K reach)' : 'Early stage (<25K reach)';

  const _reel      = nilViewVal(athlete, 'ig-reel');
  const _post      = nilViewVal(athlete, 'ig-post');
  const _tiktok    = nilViewVal(athlete, 'tiktok');
  const _bundle    = nilViewVal(athlete, 'bundle');
  const _bundleCross = nilViewVal(athlete, 'bundle-cross');
  const _retainer  = nilViewVal(athlete, 'retainer');
  const _ugcVideo  = nilViewVal(athlete, 'ugc-video');
  const _appearance = nilViewVal(athlete, 'appearance-inperson');

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

  const v4 = _reel; // has all v4 scores

  return `You are NILDash AI — a world-class NIL deal intelligence analyst powered by the NILViewVal v5.2 model. You work exclusively for sports agents. You have real market data: NCAA 2025 median deal=$60, avg=$5,594; top athletes earn $1M-$7M+; micro-athletes (10K-50K) are the fastest-growing NIL segment. You know real CPM rates (IG Reels: $15-45), real deal comps, and platform-specific strategies.

CLIENT PROFILE:
  Name: ${athlete.name} | Sport: ${athlete.sport} | Position: ${athlete.position || 'N/A'}
  Year: ${athlete.year || 'N/A'} | School: ${athlete.school || 'Unknown'} (${athlete.schoolTier || 'unknown'})
  Stats: ${athlete.stats || 'Not provided'} | Portal: ${athlete.transferReason || 'Not in portal'}
  GPA: ${athlete.gpa || 'Not provided'}

SOCIAL & BRAND:
  Instagram: ${(athlete.instagram || 0).toLocaleString()} | TikTok: ${(athlete.tiktok || 0).toLocaleString()} | Total: ${totalReach.toLocaleString()}
  Engagement: ${athlete.engagement || 0}% (college athlete avg: 4.8% per Hootsuite 2025) | Brand level: ${brandAwareness}

NILViewVal v5.2 RATES — Real-data model (NCAA 2025 + On3 + Modash CPM benchmarks):
  IG Reel: \$${_reel.low.toLocaleString()} – \$${_reel.high.toLocaleString()} | IG Post: \$${_post.low.toLocaleString()} – \$${_post.high.toLocaleString()}
  TikTok: \$${_tiktok.low.toLocaleString()} – \$${_tiktok.high.toLocaleString()} | Bundle (IG+Post+Story): \$${_bundle.low.toLocaleString()} – \$${_bundle.high.toLocaleString()}
  Cross-Platform Bundle: \$${_bundleCross.low.toLocaleString()} – \$${_bundleCross.high.toLocaleString()} | Monthly Retainer: \$${_retainer.low.toLocaleString()} – \$${_retainer.high.toLocaleString()}
  UGC Video License: \$${_ugcVideo.low.toLocaleString()} – \$${_ugcVideo.high.toLocaleString()} | In-Person Appearance: \$${_appearance.low.toLocaleString()} – \$${_appearance.high.toLocaleString()}

NILViewVal v5.2 COMPOSITE SCORES:
  Marketability: ${v4.marketabilityScore}/100 | Sponsorship Readiness: ${v4.sponsorshipReadiness}/100
  Audience Quality: ${v4.audienceQuality}/100 | Confidence: ${v4.confidenceScore}/100
  Top Categories: ${(v4.sponsorCategories || []).map(c => c.name).join(', ')}
  Best Deal Types: ${(v4.brandPartnershipTypes || []).map(t => t.type).join(', ')}

REAL CLOSED DEAL COMPS:
${compSection}

BRAND WINDOWS:
${Object.entries(BRAND_WINDOWS).slice(0,5).map(([b,n]) => `  - ${b}: ${n}`).join('\n')}

NOTES: ${athlete.notes || 'None'}

SPORT-SPECIFIC CONFERENCE INTELLIGENCE:
${(() => {
  const ctx = getSportConferenceContext(athlete.sport);
  return `  Top conferences for ${athlete.sport}: ${ctx.topConferences.join(', ')}
  Rising conferences: ${(ctx.risingConferences||[]).join(', ')}
  Key insight: ${ctx.note}`;
})()}

RULES:
- ALWAYS use the sport-specific conference intelligence above when recommending schools or conferences
- NEVER recommend conferences not listed for this sport
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

async function oneShot(prompt, system, maxTokens) {
  const ai = getClient();
  const delays = [2000, 5000, 10000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const msg = await ai.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: maxTokens || 8000,
        system: system || 'You are a precise NIL deal analyst.',
        messages: [{ role: 'user', content: prompt }],
      });
      return msg.content[0].text;
    } catch (err) {
      const isOverloaded = err?.status === 529 || err?.error?.type === 'overloaded_error' || (err?.message || '').includes('overloaded');
      if (isOverloaded && attempt < delays.length) {
        console.warn(`Anthropic overloaded — retrying in ${delays[attempt]/1000}s (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err;
    }
  }
}

async function oneShotWithSearch(prompt, systemPrompt) {
  // Skip web search attempt - use high-quality oneShot with rich context instead
  // (web_search tool was causing timeouts on Railway - oneShot with good prompts is more reliable)
  return await oneShot(prompt, systemPrompt + ' Use your training knowledge of real NIL deals, brands, collectives, and transfer portal activity from 2024-2026 to provide accurate, specific, data-backed answers.', 4000);
}

// Reserved for future live rate enhancement
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
    const raw = await oneShot(prompt, 'You are a NIL market analyst with comprehensive knowledge of 2025-2026 NIL market rates. Return only valid JSON.', 4000);
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
MARKETABILITY SCORE: ${rate.marketabilityScore}/100
TOP CATEGORIES: ${(rate.sponsorCategories||[]).map(c=>c.name).join(', ')}

Search for:
1. Real local businesses in ${city} that sponsor college athletes
2. Brands with DOCUMENTED NIL deals for ${sport} athletes at ${athlete.schoolTier||'college'} level in 2025-2026
3. Regional brands active in college ${sport} NIL

RULES:
- At least 3 of the 6 must be REAL named local businesses near ${city}
- Do NOT include Nike, Adidas, Gatorade unless confirmed they do NIL at this tier
- Each brand must have a specific reason why they fit THIS athlete

Return ONLY a JSON array of 6 deals:
[{
  "rank": 1,
  "brand": "Exact Real Business Name",
  "campaign": "Specific campaign concept for this athlete in 1-2 sentences",
  "category": "local|nutrition|apparel|tech|finance|food|beverage|gaming|auto|grooming",
  "dealType": "post|reel|ambassador|appearance|licensing",
  "rationale": "Why this brand fits — cite NIL history or specific audience/location match",
  "timingNote": "Best time to reach out and why",
  "fitScore": 85,
  "isLocal": true
}]`;

  try {
    const raw = await oneShot(prompt, 'You are a JSON-only NIL deal research API. Output ONLY a valid JSON array starting with [ and ending with ]. No explanation, no markdown, no preamble. Your entire response must be parseable JSON. Use your comprehensive knowledge of real local businesses, regional brands, and documented NIL programs to identify genuine opportunities.', 8000);
    const c = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const si = c.indexOf('[');
    const ei = c.lastIndexOf(']');
    if (si === -1 || ei <= si) throw new Error('No array');
    const parsed = JSON.parse(c.substring(si, ei + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty array');
    return parsed.map(d => ({ ...d, suggestedRate: { low: rate.low, high: rate.high } }));
  } catch (err) {
    console.error('Deal scan error:', err.message);
    // Build a sport/school-specific fallback instead of generic "Local Brand"
    const sportBrands = {
      football: ['Riddell','Athletic Greens (AG1)','BODYARMOR','Fanatics','Under Armour'],
      basketball: ['Spalding','BODYARMOR','Athletic Greens (AG1)','Fanatics','SportClips'],
    };
    const cityBrands = sportBrands[sport.toLowerCase()] || sportBrands.football;
    return cityBrands.map((b,i) => ({
      rank: i+1, brand: b, campaign: `${athlete.name} partnership with ${b}`,
      category: i===0?'equipment':i===1?'nutrition':'apparel',
      dealType: i<2?'ambassador':'reel',
      rationale: `Strong fit for ${sport} athletes — national brand with college NIL program.`,
      fitScore: 75-i*3, isLocal: false,
      suggestedRate: { low: rate.low, high: rate.high },
      timingNote: 'Open — reach out via brand NIL portal'
    }));
  }
}

// ─── NEW: AI Athlete Marketing Tools ─────────────────────────────────────────

async function generateAthleteBrandKit(athlete) {
  const rate = nilViewVal(athlete, 'ig-reel');
  const sport = athlete.sport || 'basketball';
  const school = athlete.school || 'Unknown';
  const ig = (athlete.instagram || 0).toLocaleString();
  const tt = (athlete.tiktok || 0).toLocaleString();
  const totalReach = ((athlete.instagram || 0) + (athlete.tiktok || 0)).toLocaleString();
  const topCats = (rate.sponsorCategories || []).slice(0, 5).map(c => c.name || c).join(', ');

  const targetBrand = athlete.targetBrand || null;
  const brandLine = targetBrand
    ? `TARGET BRAND: ${targetBrand}\nThis pitch deck is EXCLUSIVELY for ${targetBrand}. Every section must speak directly to ${targetBrand}'s brand identity, audience, and marketing goals. Do not mention other brands.`
    : 'TARGET BRAND: Not specified — generate a general sponsorship pitch.';

  const prompt = `You are the world's top sports NIL marketing strategist. You have closed NIL deals for elite programs and Fortune 500 brands. You write pitch decks that get replies.

Your ONLY job right now is to generate a 6-slide pitch deck that convinces ${targetBrand || 'a brand'} to sign ${athlete.name} as a NIL partner. Every word should make ${targetBrand || 'the brand'} say "this athlete belongs in our campaign."

${brandLine}

ATHLETE DATA:
Name: ${athlete.name}
Sport: ${sport} | Position: ${athlete.position || 'N/A'} | Year: ${athlete.year || 'N/A'}
School: ${school}
Stats: ${athlete.stats || 'Not provided'}
Bio/Notes: ${athlete.notes || 'None'}
Instagram: ${ig} followers | TikTok: ${tt} followers | Engagement: ${athlete.engagement || 'N/A'}%
Marketability Score: ${rate.marketabilityScore}/100 | Audience Quality: ${rate.audienceQuality}/100
Top Brand Categories: ${topCats}

CRITICAL RULES:
- Slide 1 headline must name ${targetBrand || 'the brand'} directly — e.g. "Why ${athlete.name.split(' ')[0]} and ${targetBrand || '[Brand]'} belong together"
- Slide 2 bullets must explain why THIS athlete fits ${targetBrand || 'this brand'}'s specific marketing needs (audience overlap, brand values, campaign opportunity)
- Slide 5 categories must be specific to ${targetBrand || 'the brand'}'s product lines, not generic categories
- Slide 6 activations must be ${targetBrand || 'brand'}-specific campaign ideas (product names, platforms they use, their marketing style)
- NEVER use placeholder text like "Brand name" or "Category name" — use actual ${targetBrand || 'brand'} terminology
- No dollar amounts, no financial projections, no emojis

Return ONLY this JSON — no markdown, no extra keys, no code fences:
{
  "slide1": {
    "headline": "A direct, punchy headline naming both the athlete and ${targetBrand || 'the brand'}",
    "intro": "2 sentences. Why ${athlete.name} and ${targetBrand || 'this brand'} are a natural fit right now."
  },
  "slide2": {
    "bullets": [
      "Reason 1 — specific audience or value alignment with ${targetBrand || 'this brand'}",
      "Reason 2 — athlete personality or lifestyle fit with ${targetBrand || 'this brand'}'s identity",
      "Reason 3 — reach, engagement, or platform fit for ${targetBrand || 'this brand'}'s marketing channels",
      "Reason 4 — geographic or demographic overlap with ${targetBrand || 'this brand'}'s target customer",
      "Reason 5 — credibility, accolades, or story that ${targetBrand || 'this brand'} can build content around"
    ]
  },
  "slide3": {
    "stats": ["Competitive achievement or stat 1", "Competitive achievement or stat 2", "Competitive achievement or stat 3"],
    "role": "One sentence on their competitive standing and why that credibility matters to ${targetBrand || 'a brand'} partner"
  },
  "slide4": {
    "instagram": "${ig}",
    "tiktok": "${tt}",
    "engagement": "${athlete.engagement || 'N/A'}%",
    "audienceSummary": "1-2 sentences on audience demographics and why that audience is valuable to ${targetBrand || 'this brand'}",
    "growthSignal": "One sentence on social momentum or trajectory"
  },
  "slide5": {
    "categories": [
      { "name": "${targetBrand || 'Brand'} product or campaign type", "reason": "Why this specific activation makes sense for ${targetBrand || 'this brand'}" },
      { "name": "${targetBrand || 'Brand'} product or campaign type", "reason": "Why this specific activation makes sense for ${targetBrand || 'this brand'}" },
      { "name": "${targetBrand || 'Brand'} product or campaign type", "reason": "Why this specific activation makes sense for ${targetBrand || 'this brand'}" },
      { "name": "${targetBrand || 'Brand'} product or campaign type", "reason": "Why this specific activation makes sense for ${targetBrand || 'this brand'}" }
    ]
  },
  "slide6": {
    "activations": [
      { "title": "${targetBrand || 'Brand'}-specific campaign title", "description": "Specific activation using ${targetBrand || 'brand'}'s products, platforms, or marketing channels — 2 sentences" },
      { "title": "${targetBrand || 'Brand'}-specific campaign title", "description": "Specific activation using ${targetBrand || 'brand'}'s products, platforms, or marketing channels — 2 sentences" },
      { "title": "${targetBrand || 'Brand'}-specific campaign title", "description": "Specific activation using ${targetBrand || 'brand'}'s products, platforms, or marketing channels — 2 sentences" }
    ]
  }
}`;

  try {
    const raw = await oneShot(prompt, 'You are a world-class sports marketing strategist. Return only valid JSON. No markdown. No preamble. No extra keys. Be concise and sponsor-facing.');
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');
    return JSON.parse(match[0]);
  } catch(err) {
    console.error('Brand kit error:', err.message);
    throw err;
  }
}

async function generateOutreach(athlete, targetBrand, category, outreachType, goal) {
  const rate = nilViewVal(athlete, 'ig-reel');
  const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);

  const prompt = `You are an elite sports agent writing ${outreachType} outreach for ${athlete.name} targeting ${targetBrand}.

ATHLETE:
Name: ${athlete.name} | ${athlete.sport || 'athlete'} | ${athlete.position || ''} at ${athlete.school || 'Unknown'}
Instagram: ${(athlete.instagram||0).toLocaleString()} followers | TikTok: ${(athlete.tiktok||0).toLocaleString()} followers
Engagement: ${athlete.engagement || 0}% | Stats: ${athlete.stats || 'N/A'}
Marketability Score: ${rate.marketabilityScore}/100

DEAL CONTEXT:
Target brand: ${targetBrand}
Category: ${category || 'general'}
Goal: ${goal ? '$' + parseInt(goal).toLocaleString() : 'Market rate'}
NIL Rate range: $${rate.low.toLocaleString()} – $${rate.high.toLocaleString()} per post

Generate outreach messages. Return ONLY JSON:
{
  "sponsorshipEmail": {
    "subject": "compelling email subject line",
    "body": "full professional email — 150-200 words, specific to this athlete and brand, includes stats, rates, and a clear ask"
  },
  "instagramDm": "casual but professional DM under 150 characters — attention-grabbing opener, specific to this brand",
  "partnershipProposal": "2-3 paragraph formal proposal — brand fit explanation, deliverables, rate range, next steps",
  "followUpEmail": {
    "subject": "follow-up subject line",
    "body": "brief 75-100 word follow-up email for 1 week after no response — adds new value, not desperate"
  }
}`;

  try {
    const raw = await oneShot(prompt, "You are an elite sports agent writing brand outreach with deep knowledge of NIL partnerships. Return only valid JSON.", 8000);
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON');
    return JSON.parse(match[0]);
  } catch(err) {
    console.error('Outreach error:', err.message);
    throw err;
  }
}

module.exports = {
  streamResponse,
  oneShot,
  oneShotWithSearch,
  calculateRate,
  calculateRateLive,
  getDealRecommendations,
  buildSystemPrompt,
  generateAthleteBrandKit,
  generateOutreach
};
