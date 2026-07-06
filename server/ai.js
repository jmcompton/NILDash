// server/ai.js — NILDash AI Engine v4
// v4: improved system prompt with v4 scores, AI marketing tools, improved team match context

const Anthropic = require('@anthropic-ai/sdk');
const { MARKET_RATES, DEAL_COMPS, BRAND_WINDOWS, nilViewVal } = require('./benchmarks');
const store = require('./store');
const { getSeeds } = require('./dealScanSeeds');

// Strip em/en dashes from AI-generated natural-language text. The model leans on
// em dashes heavily; replace them (and surrounding spaces) with a comma so output
// reads like a person wrote it. Non-strings pass through untouched.
function stripEmDashes(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ', ').replace(/―/g, ', ');
}

let client = null;

function getClient() {
  if (!client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key.includes('YOUR_KEY')) throw new Error('ANTHROPIC_API_KEY not set');
    client = new Anthropic({ apiKey: key });
  }
  return client;
}

function withTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallbackValue),
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms)),
  ]);
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
- Max 400 words unless asked for more
- Format all responses as clean natural text. Never use hashtags (#) for headers. Never use dashes (-) or arrows (→) as bullet points. Never use markdown formatting of any kind. Write in short clear paragraphs like a knowledgeable advisor. Use numbered lists only when absolutely necessary.
- Never use em dashes or en dashes. Use commas, periods, or separate sentences instead.
- Never state or assume the athlete's gender. Refer to the sport plainly (say 'basketball', never 'men's basketball' or 'women's basketball'). Do not use he/she/his/her for the athlete — use the athlete's name or they/them. No gendered descriptors of any kind.`;
}

async function streamResponse(athlete, message, role, res) {
  const ai = getClient();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const stream = ai.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    system: await buildSystemPrompt(athlete, role),
    messages: [{ role: 'user', content: message }],
  });

  stream.on('text', text => res.write(`data: ${JSON.stringify({ text: stripEmDashes(text) })}\n\n`));
  stream.on('error', err => {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  });
  await stream.finalMessage();
  res.write('data: [DONE]\n\n');
  res.end();
}

// Fast model for quick structured tasks (deal scan, enrichment, contact discovery)
const MODEL_FAST  = 'claude-haiku-4-5-20251001';
// Standard model for quality writing (pitch emails, brand kit)
const MODEL_STANDARD = 'claude-opus-4-8';

// ── Feature flags ─────────────────────────────────────────────────────────────
// Set to false to revert to legacy email generation prompts
const FEATURE_EMAIL_V2 = true;

async function oneShot(prompt, system, maxTokens, model) {
  const ai = getClient();
  const delays = [2000, 5000, 10000];
  const useModel = model || MODEL_STANDARD;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const msg = await ai.messages.create({
        model: useModel,
        max_tokens: maxTokens || 2000,
        system: system || 'You are a precise NIL deal analyst.',
        messages: [{ role: 'user', content: prompt }],
      });
      return stripEmDashes(msg.content[0].text);
    } catch (err) {
      // If fast model fails, fall back to standard automatically
      if (model === MODEL_FAST && attempt === 0 && err?.status === 404) {
        console.warn('[oneShot] Fast model unavailable, falling back to standard');
        return oneShot(prompt, system, maxTokens, MODEL_STANDARD);
      }
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

// Web-search-enabled one-shot. Uses Anthropic's server-side web_search tool so
// brand discovery returns REAL, verifiable local businesses. Falls back to the
// caller's error handling on timeout/failure.
async function oneShotWebSearch(prompt, system, maxTokens, maxSearches, model) {
  const ai = getClient();
  const msg = await ai.messages.create({
    model: model || MODEL_STANDARD,
    max_tokens: maxTokens || 3000,
    system: system || 'You are a precise research assistant.',
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches || 5 }],
    messages: [{ role: 'user', content: prompt }],
  });
  // Collect all text blocks from the final assistant turn
  const text = (msg.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  return stripEmDashes(text);
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
    const raw = await oneShot(prompt, 'You are a NIL market analyst with comprehensive knowledge of 2025-2026 NIL market rates. Return only valid JSON.', 1000, MODEL_FAST);
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

// School → {city, state} lookup for accurate geographic deal targeting
const SCHOOL_LOCATIONS = {
  'University of Connecticut': { city: 'Storrs', state: 'Connecticut' },
  'UConn': { city: 'Storrs', state: 'Connecticut' },
  'Yale University': { city: 'New Haven', state: 'Connecticut' },
  'University of Alabama': { city: 'Tuscaloosa', state: 'Alabama' },
  'Samford University': { city: 'Homewood', state: 'Alabama' },
  'Samford': { city: 'Homewood', state: 'Alabama' },
  'UAB': { city: 'Birmingham', state: 'Alabama' },
  'University of Alabama at Birmingham': { city: 'Birmingham', state: 'Alabama' },
  'Auburn University': { city: 'Auburn', state: 'Alabama' },
  'University of Georgia': { city: 'Athens', state: 'Georgia' },
  'Georgia Tech': { city: 'Atlanta', state: 'Georgia' },
  'University of Florida': { city: 'Gainesville', state: 'Florida' },
  'Florida State University': { city: 'Tallahassee', state: 'Florida' },
  'University of Miami': { city: 'Coral Gables', state: 'Florida' },
  'University of Tennessee': { city: 'Knoxville', state: 'Tennessee' },
  'Vanderbilt University': { city: 'Nashville', state: 'Tennessee' },
  'University of Kentucky': { city: 'Lexington', state: 'Kentucky' },
  'University of South Carolina': { city: 'Columbia', state: 'South Carolina' },
  'Clemson University': { city: 'Clemson', state: 'South Carolina' },
  'University of North Carolina': { city: 'Chapel Hill', state: 'North Carolina' },
  'North Carolina State University': { city: 'Raleigh', state: 'North Carolina' },
  'Duke University': { city: 'Durham', state: 'North Carolina' },
  'Wake Forest University': { city: 'Winston-Salem', state: 'North Carolina' },
  'University of Virginia': { city: 'Charlottesville', state: 'Virginia' },
  'Virginia Tech': { city: 'Blacksburg', state: 'Virginia' },
  'Penn State University': { city: 'State College', state: 'Pennsylvania' },
  'University of Pittsburgh': { city: 'Pittsburgh', state: 'Pennsylvania' },
  'Temple University': { city: 'Philadelphia', state: 'Pennsylvania' },
  'Ohio State University': { city: 'Columbus', state: 'Ohio' },
  'University of Cincinnati': { city: 'Cincinnati', state: 'Ohio' },
  'Michigan State University': { city: 'East Lansing', state: 'Michigan' },
  'University of Michigan': { city: 'Ann Arbor', state: 'Michigan' },
  'University of Notre Dame': { city: 'Notre Dame', state: 'Indiana' },
  'Purdue University': { city: 'West Lafayette', state: 'Indiana' },
  'Indiana University': { city: 'Bloomington', state: 'Indiana' },
  'University of Wisconsin': { city: 'Madison', state: 'Wisconsin' },
  'Northwestern University': { city: 'Evanston', state: 'Illinois' },
  'University of Illinois': { city: 'Champaign', state: 'Illinois' },
  'University of Iowa': { city: 'Iowa City', state: 'Iowa' },
  'University of Minnesota': { city: 'Minneapolis', state: 'Minnesota' },
  'University of Nebraska': { city: 'Lincoln', state: 'Nebraska' },
  'University of Kansas': { city: 'Lawrence', state: 'Kansas' },
  'Kansas State University': { city: 'Manhattan', state: 'Kansas' },
  'University of Missouri': { city: 'Columbia', state: 'Missouri' },
  'University of Arkansas': { city: 'Fayetteville', state: 'Arkansas' },
  'Louisiana State University': { city: 'Baton Rouge', state: 'Louisiana' },
  'University of Mississippi': { city: 'Oxford', state: 'Mississippi' },
  'Mississippi State University': { city: 'Starkville', state: 'Mississippi' },
  'Texas A&M University': { city: 'College Station', state: 'Texas' },
  'University of Texas': { city: 'Austin', state: 'Texas' },
  'Texas Christian University': { city: 'Fort Worth', state: 'Texas' },
  'Baylor University': { city: 'Waco', state: 'Texas' },
  'University of Oklahoma': { city: 'Norman', state: 'Oklahoma' },
  'Oklahoma State University': { city: 'Stillwater', state: 'Oklahoma' },
  'University of Colorado': { city: 'Boulder', state: 'Colorado' },
  'Colorado State University': { city: 'Fort Collins', state: 'Colorado' },
  'University of Utah': { city: 'Salt Lake City', state: 'Utah' },
  'University of Arizona': { city: 'Tucson', state: 'Arizona' },
  'Arizona State University': { city: 'Tempe', state: 'Arizona' },
  'University of Oregon': { city: 'Eugene', state: 'Oregon' },
  'Oregon State University': { city: 'Corvallis', state: 'Oregon' },
  'University of Washington': { city: 'Seattle', state: 'Washington' },
  'Washington State University': { city: 'Pullman', state: 'Washington' },
  'University of California': { city: 'Berkeley', state: 'California' },
  'UCLA': { city: 'Los Angeles', state: 'California' },
  'University of Southern California': { city: 'Los Angeles', state: 'California' },
  'Stanford University': { city: 'Stanford', state: 'California' },
  'University of California, Los Angeles': { city: 'Los Angeles', state: 'California' },
  'San Diego State University': { city: 'San Diego', state: 'California' },
  'Brigham Young University': { city: 'Provo', state: 'Utah' },
  'University of Nevada, Las Vegas': { city: 'Las Vegas', state: 'Nevada' },
  'University of New Mexico': { city: 'Albuquerque', state: 'New Mexico' },
  'Boston College': { city: 'Chestnut Hill', state: 'Massachusetts' },
  'Boston University': { city: 'Boston', state: 'Massachusetts' },
  'University of Massachusetts': { city: 'Amherst', state: 'Massachusetts' },
  'University of Rhode Island': { city: 'Kingston', state: 'Rhode Island' },
  'University of Vermont': { city: 'Burlington', state: 'Vermont' },
  'University of New Hampshire': { city: 'Durham', state: 'New Hampshire' },
  'University of Maine': { city: 'Orono', state: 'Maine' },
};

// Runtime cache for web-geocoded schools so we only pay the search once per
// school per process.
const _schoolLocationCache = new Map();

// Synchronous map-only lookup. Returns null when the school isn't known.
function lookupSchoolLocation(school) {
  if (!school) return null;
  if (SCHOOL_LOCATIONS[school]) return SCHOOL_LOCATIONS[school];
  for (const key of Object.keys(SCHOOL_LOCATIONS)) {
    if (school.includes(key) || key.includes(school)) return SCHOOL_LOCATIONS[key];
  }
  return null;
}

// Resolve a school to a real {city, state}. Tries the hardcoded map first
// (instant), then a one-shot web search to geocode unknown schools. NEVER
// synthesizes a state from the school name — a bad location poisons every Deal
// Scan query. Falls back to a clearly-flagged unknown location if all else fails.
async function getSchoolLocation(school) {
  if (!school) return { city: 'Unknown City', state: 'Unknown State', known: false };

  const mapped = lookupSchoolLocation(school);
  if (mapped) return { ...mapped, known: true };

  const cacheKey = school.trim().toLowerCase();
  if (_schoolLocationCache.has(cacheKey)) return _schoolLocationCache.get(cacheKey);

  // Web-search geocode for schools not in the map. Hard-capped at 6s: this runs
  // serially BEFORE the Deal Scan search phase, and an uncapped geocode was a
  // silent double-digit-seconds tax on every scan for an unmapped school.
  try {
    const _tGeo = Date.now();
    const raw = await withTimeout(oneShotWebSearch(
      `What U.S. city and state is "${school}" located in? Use web search to confirm. Return ONLY JSON: {"city":"","state":""}`,
      'You are a geocoding API. Return ONLY a single JSON object with the school\'s real city and full state name. No prose.',
      300,
      1,
      MODEL_FAST
    ), 6000, '');
    console.log(`[getSchoolLocation] web geocode for "${school}" took ${Date.now() - _tGeo}ms`);
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed.city && parsed.state) {
        const result = { city: String(parsed.city).trim(), state: String(parsed.state).trim(), known: true };
        _schoolLocationCache.set(cacheKey, result);
        return result;
      }
    }
  } catch (e) {
    console.warn('[getSchoolLocation] web geocode failed for', school, '-', e.message);
  }

  // Last resort: flag as unknown rather than fabricating a state.
  const result = { city: 'Unknown City', state: 'Unknown State', known: false };
  _schoolLocationCache.set(cacheKey, result);
  return result;
}

// Free/consumer mail providers are never a legitimate business contact domain
// for a verified local business — and are the classic shape of a hallucinated
// email. Reject them outright.
const _FREE_EMAIL_DOMAINS = new Set([
  'gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com',
  'live.com','msn.com','protonmail.com','gmx.com','mail.com','ymail.com',
]);

function _domainFromUrl(url) {
  if (!url) return null;
  try {
    const u = String(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    return u.split(/[\/?#]/)[0].toLowerCase().trim() || null;
  } catch { return null; }
}

// Validate a contactEmail against the business's real website domain. Returns
// the email if it's plausibly real, otherwise null (never fabricate). When a
// website domain is known, the email domain must match it. Free-mail is always
// rejected.
function validateContactEmail(email, websiteUrl) {
  if (!email || typeof email !== 'string') return null;
  const m = email.trim().toLowerCase().match(/^[^\s@]+@([^\s@]+\.[^\s@]+)$/);
  if (!m) return null;
  const emailDomain = m[1];
  if (_FREE_EMAIL_DOMAINS.has(emailDomain)) return null;
  const siteDomain = _domainFromUrl(websiteUrl);
  if (siteDomain) {
    // Require the email domain to match (or be a subdomain of) the site domain.
    if (emailDomain !== siteDomain && !emailDomain.endsWith('.' + siteDomain) && !siteDomain.endsWith('.' + emailDomain)) {
      return null;
    }
  }
  return email.trim();
}

// ─── Deal Scan: SOCIAL + TOP NIL SPENDER lanes ───────────────────────────────
// Shared two-phase (parallel web search → fast scoring) brand-discovery helper
// for the two non-local lanes. Unlike the LOCAL lane, these are NOT tied to the
// athlete's city — they surface DTC/online brands (SOCIAL) and currently
// NIL-active brands (TOP NIL) that realistically do deals at THIS athlete's
// follower tier. A 2,000-follower athlete should see micro/nano-friendly brands,
// never Nike.
async function _scanBrandLane(athlete, lane, excludeBrands) {
  const MODEL_DEALSCAN = 'claude-sonnet-4-6';
  const _laneT0 = Date.now();
  const rate = calculateRate(athlete, 'ig-reel');
  const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);
  const tier = reach > 500000 ? 'macro' : reach > 100000 ? 'mid' : reach > 25000 ? 'micro' : 'nano';
  const sport = athlete.sport || 'football';
  const school = athlete.school || 'their school';
  const valLow  = tier === 'macro' ? 2500 : tier === 'mid' ? 800 : tier === 'micro' ? 250 : 100;
  const valHigh = tier === 'macro' ? 15000 : tier === 'mid' ? 4000 : tier === 'micro' ? 1000 : 500;

  const exclusionLine = excludeBrands && excludeBrands.length > 0
    ? `\nEXCLUDE THESE BRANDS COMPLETELY — do not suggest them: ${excludeBrands.join(', ')}`
    : '';

  const tierGuidance = tier === 'macro'
    ? 'This is a large creator — national brands and bigger budgets are realistic.'
    : tier === 'mid'
    ? 'This is a mid-tier creator — established DTC brands and mid-size NIL programs, not the largest national giants.'
    : 'This is a SMALL (micro/nano) creator. ONLY suggest brands that genuinely run programs for small creators at this follower tier. Do NOT suggest Nike, Adidas, Gatorade, or other mega-brands that only sign stars.';

  const laneCfg = lane === 'social'
    ? {
        label: 'Social',
        resultType: 'social',
        categoryEnum: 'supplements|apparel|energydrink|app|accessories|beauty|nutrition|fitness|dtc',
        queries: [
          `DTC and online brands with creator/influencer ambassador programs that partner with ${tier}-tier college athletes (~${reach.toLocaleString()} followers) — supplements, apparel, energy drinks, apps, accessories 2025`,
          `direct-to-consumer brands actively recruiting nano and micro college athlete creators on Instagram and TikTok ${new Date().getFullYear()}`,
          `${sport} micro-influencer brand ambassador programs supplements apparel accessories open to small creators`,
        ],
        retryQuery: `online DTC brands running affiliate or ambassador programs for small Instagram and TikTok creators`,
        scoreIntro: `These REAL DTC / social-media brands were just found via web search. They run creator/ambassador programs.`,
        favor: 'DTC supplements, apparel, energy drinks, fitness apps, accessories that work with small creators',
      }
    : {
        label: 'Top NIL',
        resultType: 'topnil',
        categoryEnum: 'nutrition|apparel|tech|finance|food|energydrink|auto|retail|nil',
        queries: [
          `brands most active in college NIL deals in ${new Date().getFullYear()} that ALSO sign smaller and mid-tier college athletes in ${sport} — not just the biggest stars`,
          `top NIL-spending companies with athlete ambassador programs open to ${tier}-tier ${sport} college athletes`,
          `NIL-active brands partnering with everyday college athletes ${sport} ambassador roster programs ${new Date().getFullYear()}`,
        ],
        retryQuery: `companies with the most active college athlete NIL ambassador programs that accept smaller athletes`,
        scoreIntro: `These REAL NIL-active brands were just found via web search. They currently run college athlete NIL/ambassador programs.`,
        favor: 'currently NIL-active brands that sign college and smaller athletes in this sport',
      };

  const searchSys = 'You find real brands via web search. Output ONLY a JSON array, no commentary, no markdown.';
  const mk = (q) => `Use web search: ${q}. Return up to 8 REAL brands you actually find, each as {"name","website","category","email"} (email only if shown on their site, else null). Favor: ${laneCfg.favor}. ONLY a JSON array.`;

  try {
    console.log(`[dealScan:${lane}] web search brand discovery — model=${MODEL_DEALSCAN} sport=${sport} tier=${tier}`);
    const settled = await Promise.allSettled(
      laneCfg.queries.map((q) => withTimeout(oneShotWebSearch(mk(q), searchSys, 700, 3, MODEL_DEALSCAN), 8000, ''))
    );

    const found = [];
    const seen = new Set();
    const collect = (raw) => {
      try {
        const t = (raw || '').replace(/```json/g, '').replace(/```/g, '').trim();
        const a = t.indexOf('['), b = t.lastIndexOf(']');
        if (a === -1 || b <= a) return;
        const arr = JSON.parse(t.substring(a, b + 1));
        for (const it of (Array.isArray(arr) ? arr : [])) {
          const nm = ((it && it.name) || '').trim();
          if (!nm) continue;
          const key = nm.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({ name: nm, website: it.website || null, category: it.category || null, email: it.email || null });
        }
      } catch (_) { /* skip unparseable */ }
    };
    for (const s of settled) if (s.status === 'fulfilled') collect(s.value);
    console.log(`[dealScan:${lane}] phase 1 found ${found.length} candidates`);

    if (found.length < 6) {
      try {
        const retry = await withTimeout(oneShotWebSearch(mk(laneCfg.retryQuery), searchSys, 800, 4, MODEL_DEALSCAN), 8000, '');
        collect(retry);
      } catch (_) {}
      console.log(`[dealScan:${lane}] after retry: ${found.length} candidates`);
    }
    if (found.length < 6) {
      const seeds = getSeeds(lane, tier) || [];
      const excl = (excludeBrands || []).map((b) => (b || '').toLowerCase());
      for (const s of seeds) {
        if (found.length >= 14) break;
        const nm = (s.name || '').trim();
        if (!nm) continue;
        const key = nm.toLowerCase();
        if (seen.has(key) || excl.includes(key)) continue;
        seen.add(key);
        found.push({ name: nm, website: s.website || null, category: s.category || null, email: s.email || null, _seed: true });
      }
      console.log(`[dealScan:${lane}] seed top-up → ${found.length} candidates`);
    }
    if (found.length === 0) return [];
    const seedNames = new Set(found.filter((f) => f._seed).map((f) => f.name.toLowerCase().trim()));

    try {
      const candidatesJson = JSON.stringify(found.slice(0, 16));
      const scorePrompt = `Athlete: ${athlete.name}, ${sport}${athlete.position ? ` (${athlete.position})` : ''} at ${school}. ${(athlete.instagram||0).toLocaleString()} IG + ${(athlete.tiktok||0).toLocaleString()} TikTok (${tier} tier). ${tierGuidance} Realistic deal value ~$${valLow}-$${valHigh}.${exclusionLine}

${laneCfg.scoreIntro}
${candidatesJson}

Pick the 3 or 4 best for THIS athlete and score each 1-100 (vary the scores meaningfully). Return AT MOST 4. Each rationale is 1-2 sentences referencing this athlete's sport/tier and WHY this brand actually does deals at this follower level. For contactEmail: use the email given if present, otherwise info@/partnerships@ at the REAL website domain provided — never invent a fake domain; use null if no domain is known. Output ONLY this JSON array sorted by fitScore descending:
[{"rank":1,"brand":"","tier":"${laneCfg.resultType}","category":"${laneCfg.categoryEnum}","dealType":"post|reel|ambassador|affiliate","campaign":"","rationale":"","estimatedValueLow":${valLow},"estimatedValueHigh":${valHigh},"contactApproach":"","timingNote":"","fitScore":88,"isLocal":false,"contactName":null,"contactTitle":"","contactEmail":"","contactLinkedIn":null}]`;

      const raw = await oneShot(scorePrompt, 'You are a JSON-only NIL deal API. Output ONLY a valid JSON array. Never fabricate a brand or an email domain — only use the brands and domains provided.', 1800, MODEL_DEALSCAN);
      const c = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const si = c.indexOf('['), ei = c.lastIndexOf(']');
      if (si === -1 || ei <= si) throw new Error('No array in scoring response');
      let parsed = JSON.parse(c.substring(si, ei + 1));
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty array');
      parsed.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
      parsed = parsed.slice(0, 4); // lane rebalance: Social / Top NIL show 3-4, Local is primary
      console.log(`[dealScan:${lane}] returning ${parsed.length} in ${Date.now() - _laneT0}ms`);
      const siteByName = new Map();
      for (const f of found) if (f.name) siteByName.set(f.name.toLowerCase().trim(), f.website);
      return parsed.map((d, i) => {
        const nameKey = (d.brand || '').toLowerCase().trim();
        const site = (d.brand && siteByName.get(nameKey)) || d.website || null;
        return {
          ...d,
          rank: i + 1,
          resultType: laneCfg.resultType,
          lane,
          isLocal: false,
          source: seedNames.has(nameKey) ? 'seed' : 'web',
          contactEmail: validateContactEmail(d.contactEmail, site),
          estimatedValueLow: d.estimatedValueLow || valLow,
          estimatedValueHigh: d.estimatedValueHigh || valHigh,
          suggestedRate: { low: rate.low, high: rate.high },
        };
      });
    } catch (scoreErr) {
      console.warn(`[dealScan:${lane}] scoring failed, returning candidates directly: ${scoreErr.message}`);
      return found.slice(0, 4).map((f, i) => ({
        rank: i + 1,
        brand: f.name,
        tier: laneCfg.resultType,
        category: f.category || laneCfg.resultType,
        dealType: 'ambassador',
        campaign: '',
        rationale: `${f.name} runs creator/ambassador programs that fit ${tier}-tier ${sport} athletes at this follower level.`,
        contactApproach: 'Apply through their ambassador or affiliate page, or email their partnerships team.',
        timingNote: '',
        fitScore: 82 - i * 4,
        isLocal: false,
        resultType: laneCfg.resultType,
        lane,
        source: f._seed ? 'seed' : 'web',
        contactEmail: validateContactEmail(f.email, f.website),
        estimatedValueLow: valLow,
        estimatedValueHigh: valHigh,
        suggestedRate: { low: rate.low, high: rate.high },
      }));
    }
  } catch (err) {
    console.warn(`[dealScan:${lane}] failed: ${err.message}`);
    return [];
  }
}

async function getDealRecommendations(athlete, role, excludeBrands, lane) {
  // Deal Scan now has THREE lanes. The original LOCAL lane lives below; the
  // SOCIAL (DTC/online brands) and TOP NIL SPENDERS lanes are handled by the
  // shared brand-lane helper. Each lane runs independently so the frontend can
  // fire all three in parallel and render each column progressively.
  lane = lane || 'local';
  if (lane === 'social' || lane === 'topnil') {
    return _scanBrandLane(athlete, lane, excludeBrands);
  }

  // Deal Scan uses Sonnet (scoped to this function only) — faster than Opus,
  // strong enough for structured local-brand research.
  const MODEL_DEALSCAN = 'claude-sonnet-4-6';
  const _t0 = Date.now();
  const rate = calculateRate(athlete, 'ig-reel');
  const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);
  const tier = reach > 500000 ? 'macro' : reach > 100000 ? 'mid' : reach > 25000 ? 'micro' : 'nano';
  const school = athlete.school || 'Unknown';
  const loc = await getSchoolLocation(school);
  const city = loc.city;
  const state = loc.state;
  const locationKnown = loc.known !== false;
  const sport = athlete.sport || 'football';

  // ── Hometown second market ─────────────────────────────────────────────────
  // When the profile has a hometown that differs from the school market, the
  // local lane searches BOTH markets and labels each result with its market.
  // When hometown is absent, everything below degrades to the single-market
  // behavior and no market labels are attached.
  const hometown = String(athlete.hometown || '').trim();
  const schoolMarket = `${city}, ${state}`;
  const hasHometown = !!hometown && hometown.toLowerCase() !== schoolMarket.toLowerCase()
    && hometown.split(',')[0].trim().toLowerCase() !== String(city).toLowerCase();
  const hometownCity = hasHometown ? hometown.split(',')[0].trim() : '';
  // Short school name for the market chip, e.g. "Samford University" -> "Samford"
  const schoolShort = school
    .replace(/^the\s+/i, '')
    .replace(/^university\s+of\s+/i, '')
    .replace(/\s+(university|college)$/i, '')
    .trim() || school;
  const marketLabelFor = (m) => (m === 'hometown' ? `Hometown - ${hometownCity}` : `Near ${schoolShort}`);

  const exclusionLine = excludeBrands && excludeBrands.length > 0
    ? `\nEXCLUDE THESE BRANDS COMPLETELY — do not suggest them under any circumstances: ${excludeBrands.join(', ')}\nEvery business you return must be different from that list.`
    : '';

  // Deal-value range for this athlete's tier (nano/micro get small local deals)
  const valLow  = tier === 'macro' ? 2500 : tier === 'mid' ? 800 : tier === 'micro' ? 250 : 100;
  const valHigh = tier === 'macro' ? 15000 : tier === 'mid' ? 4000 : tier === 'micro' ? 1000 : 500;

  // Local business taxonomy with a proven track record of NIL / local
  // sponsorship deals. Every local search works across this list, weighted
  // toward the athlete's sport.
  const LOCAL_TAXONOMY = 'car dealerships; restaurants and food spots; gyms and training facilities; chiropractors and physical therapy; smoothie and supplement shops; boutiques and local retail; real estate agents; banks and credit unions; med spas and salons';

  // Sport-specific local category hints (which taxonomy categories to weight)
  const sportCats = {
    baseball: 'batting cages, baseball/softball academies, sporting goods stores',
    softball: 'batting cages, softball academies, sporting goods stores',
    basketball: 'basketball training facilities, sneaker/shoe stores, sports apparel shops',
    football: 'sports bars, BBQ/wing restaurants, sporting goods, training facilities',
    soccer: 'soccer clubs, sports medicine clinics, athletic apparel shops',
  };
  const catHint = sportCats[sport.toLowerCase()] || 'sports training facilities, sporting goods stores';
  const interestLine = (athlete.notes || '').trim()
    ? `\nATHLETE INTERESTS/NOTES (weight matching categories higher): ${String(athlete.notes).trim().slice(0, 200)}`
    : '';

  // Shared rules for both local paths: franchises count as LOCAL, and the
  // rationale must carry a "why they'd say yes" angle.
  const FRANCHISE_RULE = `LOCALLY-OWNED FRANCHISES COUNT AS LOCAL: the local Wingstop, a Chick-fil-A franchisee, an area State Farm agent, a dealership carrying a national marque. These are LOCAL results (mark "isFranchise": true) ONLY when they point at a specific local location or operator (e.g. "Wingstop on Lakeshore Pkwy", "Chick-fil-A Johns Creek franchisee"), never the corporate brand in general. Their angle: the owner or GM controls a local marketing budget and can say yes without corporate. The ban on big national brands with no confirmed NIL activity still applies to this lane.`;
  const WHY_YES_RULE = `Every rationale must include a concrete "why they'd say yes" angle for THIS business and THIS athlete (foot traffic near campus, customer overlap with the sport's fans, owner's community ties, they already market locally). Rank by likelihood this specific business responds to this specific athlete, NOT by brand size.`;

  const marketsLine = hasHometown
    ? `MARKETS (search BOTH):\n1. School market: ${city}, ${state} (near ${school})\n2. Hometown market: ${hometown} — this athlete GREW UP here. Hometown picks get the hometown-hero angle: local recognition, community ties, "local kid makes good".`
    : `MARKET: ${city}, ${state}`;
  const marketFieldRule = hasHometown
    ? `"market" is "school" for ${city} businesses and "hometown" for ${hometown} businesses. Aim for roughly 6 school-market and 3-4 hometown picks.`
    : `"market" is always "school".`;

  const prompt = `Name 8 to 10 REAL, well-known, established LOCAL businesses that would realistically do an NIL deal with this college athlete. Use your own knowledge of these markets — you do NOT have web search, so rely on what you actually know. If you are only confident about fewer businesses, return fewer. NEVER pad with invented ones.

MARKET RESOLUTION: If the school market below shows "Unknown City" or "Unknown State", infer the real city and state from the school name "${school}" (you know where major colleges are located) and use THAT market.

ATHLETE: ${athlete.name} | ${sport} | ${athlete.position||'N/A'} | ${school}
${marketsLine}
SOCIAL: ${(athlete.instagram||0).toLocaleString()} IG + ${(athlete.tiktok||0).toLocaleString()} TikTok | Tier: ${tier}${interestLine}
${exclusionLine}

THIS IS LOCAL-FIRST. A ${tier}-tier athlete will NOT land Nike or other national giants. They land deals with the local car dealership, the gym down the street, the area franchise owner, the supplement store. Realistic local deal value: $${valLow}-$${valHigh} per post/campaign. Tune every pick to this athlete's sport (${sport}), position (${athlete.position||'N/A'}), and ${tier} follower tier.

Work deliberately across this taxonomy of local business types with a proven NIL / local sponsorship track record, covering several categories rather than clustering in one:
${LOCAL_TAXONOMY}
Weight toward categories matching the athlete's sport: ${catHint}

${FRANCHISE_RULE}

${WHY_YES_RULE}

RULES:
- Name only real, well-known businesses you are confident actually exist in that specific market. NEVER invent a business. Fewer real results beat padded fake ones.
- Do NOT claim specific sponsorship history (little league, billboards, past NIL deals) unless you are genuinely confident it is true. Without that, ground the "why they'd say yes" angle in category norms and market fit instead.
- contactEmail: only use the real business domain in info@/owner@/contact@ form if you are confident of the real domain; otherwise null. Never fabricate a domain.
- contactName: null unless you genuinely know the owner/manager's real name.
- ${marketFieldRule}

Output ONLY a JSON array (no markdown, no preamble) of 8-10 objects sorted by fitScore descending. Score each 1-100 on likelihood to respond to THIS athlete — vary the scores meaningfully:
[{
  "rank": 1,
  "brand": "Exact Real Business Name",
  "tier": "local",
  "category": "auto|gym|food|restaurant|nutrition|apparel|finance|insurance|realestate|training|chiro|medspa|local",
  "dealType": "post|reel|ambassador|appearance",
  "campaign": "Specific 1-sentence campaign concept for this athlete",
  "rationale": "2-3 sentences: why this business fits THIS athlete AND the why-they-would-say-yes angle",
  "estimatedValueLow": ${valLow},
  "estimatedValueHigh": ${valHigh},
  "contactApproach": "Best way to reach out (e.g. DM the owner, email the marketing manager, visit in person)",
  "timingNote": "Best time to reach out and why",
  "fitScore": 88,
  "isLocal": true,
  "market": "school|hometown",
  "isFranchise": false,
  "contactName": null,
  "contactTitle": "Owner | Marketing Director | Franchise Owner | etc",
  "contactEmail": null,
  "contactLinkedIn": null
}]`;

  // Shared post-processing for both local paths: normalize the new fields,
  // attach the market chip label (only in two-market mode so single-market
  // behavior is unchanged), and never let a bad market value through.
  const finalizeLocal = (d, i, source, site) => {
    let market = d.market === 'hometown' ? 'hometown' : 'school';
    if (!hasHometown) market = 'school';
    return {
      ...d,
      rank: i + 1,
      resultType: 'local',
      lane: 'local',
      isLocal: true,
      source,
      market,
      marketLabel: hasHometown ? marketLabelFor(market) : null,
      isFranchise: d.isFranchise === true,
      contactEmail: validateContactEmail(d.contactEmail, site || d.website || null),
      estimatedValueLow: d.estimatedValueLow || valLow,
      estimatedValueHigh: d.estimatedValueHigh || valHigh,
      suggestedRate: { low: rate.low, high: rate.high },
    };
  };

  // Model-knowledge path (no web search). Reliable at naming real, well-known
  // local businesses and can infer the market from the school name even when
  // getSchoolLocation fails. Used as the fallback when web search is thin.
  const runKnowledgePath = async () => {
    console.log(`[dealScan] model-knowledge path — model=${MODEL_DEALSCAN} market=${schoolMarket}${hasHometown ? ` + hometown ${hometown}` : ''} sport=${sport} locationKnown=${locationKnown}`);
    const raw = await oneShot(prompt, 'You are a JSON-only NIL deal research API. Output ONLY a valid JSON array starting with [ and ending with ]. No explanation, no markdown. Every brand must be a real, well-known business that genuinely operates in the athlete\'s market. Never fabricate a business name or an email domain.', 4000, MODEL_DEALSCAN);
    const c = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const si = c.indexOf('[');
    const ei = c.lastIndexOf(']');
    if (si === -1 || ei <= si) throw new Error('No array');
    const parsed = JSON.parse(c.substring(si, ei + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty array');
    parsed.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
    console.log(`[dealScan] model-knowledge produced ${parsed.length} local brand(s) in ${Date.now() - _t0}ms`);
    return parsed.map((d, i) => finalizeLocal(d, i, 'knowledge', d.website || null));
  };

  // ── PRIMARY PATH: category-driven parallel web search + one scoring call ────
  // Deliberate searches across the local-NIL taxonomy (weighted by sport) in the
  // school market, plus the hometown market when set. Searches run IN PARALLEL
  // with hard per-search timeouts so wall-clock stays bounded, then ONE fast
  // no-search Sonnet call scores, ranks by likelihood-to-respond, and writes the
  // why-they-would-say-yes rationales citing any local-marketing evidence found.
  try {
    console.log(`[dealScan] category web search primary — model=${MODEL_DEALSCAN} market=${schoolMarket}${hasHometown ? ` + hometown ${hometown}` : ''} sport=${sport}`);

    const searchSys = 'You find real local businesses via web search. Output ONLY a JSON array, no commentary, no markdown.';
    const mk = (q, cats) => `Use web search: ${q}. Return up to 8 REAL businesses you actually find, each as {"name","website","category","email","evidence","franchise"}. "evidence": one short line ONLY when the search shows the business already spends on local marketing (sponsors a high school or little league team, billboards, local ads, prior NIL activity), else null — never invent evidence. "franchise": true only when it is a locally owned or operated franchise location of a national brand and you can point at the specific location or operator, else false. "email" only if shown on their site, else null. Favor: ${cats}. ONLY a JSON array.`;

    // Two category bundles per the taxonomy for the school market, one combined
    // sweep for the hometown market. All parallel; each hard-capped at 8s.
    // max_uses is 2 per call so each search call reliably finishes inside the
    // cap (3 internal searches often blew past 8s and timed out to '', which is
    // how live hometown results went missing).
    const schoolQ1 = mk(
      `car dealerships, gyms and training facilities, restaurants, smoothie and supplement shops in ${city}, ${state} that sponsor local sports teams, run local ads, or have done NIL deals with ${school} athletes`,
      `${catHint}, car dealerships, restaurants and food spots, smoothie and supplement shops`
    );
    const schoolQ2 = mk(
      `chiropractors, physical therapy clinics, boutiques and local retail, real estate agents, banks and credit unions, med spas and salons in ${city}, ${state} that advertise locally or sponsor high school and youth sports`,
      'chiropractors and physical therapy, boutiques and local retail, real estate agents, banks and credit unions, med spas and salons'
    );
    const searchDefs = [
      { market: 'school', p: withTimeout(oneShotWebSearch(schoolQ1, searchSys, 800, 2, MODEL_DEALSCAN), 8000, '') },
      { market: 'school', p: withTimeout(oneShotWebSearch(schoolQ2, searchSys, 800, 2, MODEL_DEALSCAN), 8000, '') },
    ];
    if (hasHometown) {
      searchDefs.push({
        market: 'hometown',
        p: withTimeout(oneShotWebSearch(mk(
          `local businesses in ${hometown} across car dealerships, restaurants, gyms and training facilities, supplement shops, chiropractors, boutiques, real estate agents, banks, med spas that sponsor local youth sports or spend on local marketing`,
          `${catHint}, plus the full local taxonomy in ${hometown}`
        ), searchSys, 800, 2, MODEL_DEALSCAN), 8000, ''),
      });
    }
    const _tSearch = Date.now();
    const settled = await Promise.allSettled(searchDefs.map((s) => s.p));

    const found = [];
    const seen = new Set();
    const collectLocal = (raw, market) => {
      try {
        const t = (raw || '').replace(/```json/g, '').replace(/```/g, '').trim();
        const a = t.indexOf('['), b = t.lastIndexOf(']');
        if (a === -1 || b <= a) return;
        const arr = JSON.parse(t.substring(a, b + 1));
        for (const it of (Array.isArray(arr) ? arr : [])) {
          const nm = ((it && it.name) || '').trim();
          if (!nm) continue;
          const key = nm.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({
            name: nm, website: it.website || null, category: it.category || null,
            email: it.email || null, evidence: it.evidence || null,
            franchise: it.franchise === true, market,
          });
        }
      } catch (_) { /* skip unparseable search result */ }
    };
    settled.forEach((s, idx) => { if (s.status === 'fulfilled') collectLocal(s.value, searchDefs[idx].market); });
    console.log(`[dealScan] phase 1 category search found ${found.length} candidates (${found.filter(f => f.market === 'hometown').length} hometown) in ${Date.now() - _tSearch}ms (elapsed ${Date.now() - _t0}ms)`);

    // One broadened retry before falling back.
    if (found.length < 3) {
      console.warn(`[dealScan] only ${found.length} candidates — running one broadened retry search`);
      try {
        const retryRaw = await withTimeout(oneShotWebSearch(
          mk(`popular local businesses, restaurants, gyms, car dealerships and shops in ${city}, ${state}`, 'any local business that advertises locally'),
          searchSys, 800, 4, MODEL_DEALSCAN
        ), 8000, '');
        collectLocal(retryRaw, 'school');
      } catch (_) { /* retry failed — fall through to the count check */ }
      console.log(`[dealScan] after retry: ${found.length} candidate businesses`);
    }
    // Too thin to be a credible local scan — let the knowledge path try instead.
    if (found.length < 3) throw new Error(`only ${found.length} web candidates`);

    // Phase 2 — score + enrich the real businesses (no web search, fast).
    // Target 8 results (latency: shorter output than the old "8 to 10" +
    // 2-3 sentence rationales); capped by how many real candidates exist.
    const hometownFound = found.filter((f) => f.market === 'hometown');
    if (hasHometown && hometownFound.length === 0) {
      console.warn(`[dealScan] hometown search found 0 viable candidates for "${hometown}" — local lane will be school-market only`);
    }
    // Reserve 2-3 slots for hometown whenever its search found anything viable,
    // so school results cannot crowd them out.
    const reserveHometown = hasHometown ? Math.min(3, hometownFound.length) : 0;
    const wantCount = Math.min(8, found.length);
    const marketScoringLine = hasHometown
      ? `Each candidate carries a "market" field: "school" (${city}, near ${school}) or "hometown" (${hometown} — the athlete GREW UP there; use the hometown-hero angle: local recognition, community ties, "local kid makes good"). Keep the market value from the input.${reserveHometown ? ` HARD REQUIREMENT: include AT LEAST ${reserveHometown} hometown-market pick(s). Those slots are reserved for hometown even if school candidates score higher.` : ''}`
      : `Every candidate is in the school market ("market":"school").`;
    // Compact candidate payload (drop null/false fields) to cut scoring latency.
    const compactFound = found.slice(0, 16).map((f) => {
      const o = { name: f.name, market: f.market };
      if (f.website) o.website = f.website;
      if (f.category) o.category = f.category;
      if (f.email) o.email = f.email;
      if (f.evidence) o.evidence = f.evidence;
      if (f.franchise) o.franchise = true;
      return o;
    });
    const candidatesJson = JSON.stringify(compactFound);
    const scorePrompt = `Athlete: ${athlete.name}, ${sport}${athlete.position ? ` (${athlete.position})` : ''} at ${school}, ${city}, ${state}${hasHometown ? `, hometown ${hometown}` : ''}. ${(athlete.instagram||0).toLocaleString()} IG + ${(athlete.tiktok||0).toLocaleString()} TikTok (${tier} tier, realistic local deal ~$${valLow}-$${valHigh}).${exclusionLine}

These REAL local businesses were just found via web search (with any local-marketing evidence the search surfaced):
${candidatesJson}

${marketScoringLine}

${FRANCHISE_RULE}

Pick the best ${wantCount} for this athlete (fewer only if fewer are genuinely good — never pad) and score each 1-100. ${WHY_YES_RULE} Rationale is 1-2 tight sentences. When a candidate has "evidence", CITE it in the rationale (e.g. "already sponsors a local little league team, so athlete deals are a natural next step"). Never invent evidence that is not in the input. For contactEmail: use the email given if present, otherwise info@/owner@/contact@ at the REAL website domain provided — never invent a fake domain; use null if no domain is known. Output ONLY this JSON array sorted by fitScore descending:
[{"rank":1,"brand":"","tier":"local","category":"auto|gym|food|restaurant|nutrition|apparel|finance|insurance|realestate|training|chiro|medspa|local","dealType":"post|reel|ambassador|appearance","campaign":"","rationale":"","estimatedValueLow":${valLow},"estimatedValueHigh":${valHigh},"contactApproach":"","timingNote":"","fitScore":88,"isLocal":true,"market":"school|hometown","isFranchise":false,"contactName":null,"contactTitle":"","contactEmail":"","contactLinkedIn":null}]`;

    const _tScore = Date.now();
    const raw = await oneShot(scorePrompt, 'You are a JSON-only NIL deal API. Output ONLY a valid JSON array. Never fabricate a business, evidence, or an email domain — only use the businesses, evidence, and domains provided.', 1900, MODEL_DEALSCAN);
    const c = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const si = c.indexOf('[');
    const ei = c.lastIndexOf(']');
    if (si === -1 || ei <= si) throw new Error('No array in scoring response');
    let parsed = JSON.parse(c.substring(si, ei + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty array');
    // Map business name -> full candidate so finalize can validate emails and
    // repair any market/franchise value the scorer dropped.
    const metaByName = new Map();
    for (const f of found) if (f.name) metaByName.set(f.name.toLowerCase().trim(), f);
    for (const d of parsed) {
      const meta = metaByName.get((d.brand || '').toLowerCase().trim());
      if (meta && d.market !== 'school' && d.market !== 'hometown') d.market = meta.market;
      if (meta && d.isFranchise !== true && meta.franchise === true) d.isFranchise = true;
    }

    // ── Guaranteed hometown slots (deterministic backstop) ────────────────────
    // If the scorer still under-delivered on hometown picks, splice in the top
    // unused hometown candidates with a template hometown-hero rationale (citing
    // real evidence when the search found some, never inventing any), trimming
    // the lowest-scored school picks to keep the lane at 8-10.
    if (reserveHometown > 0) {
      const inParsed = new Set(parsed.map((d) => (d.brand || '').toLowerCase().trim()));
      let haveHometown = parsed.filter((d) => d.market === 'hometown').length;
      if (haveHometown < Math.min(2, reserveHometown)) {
        console.warn(`[dealScan] scorer returned ${haveHometown} hometown pick(s) — enforcing ${reserveHometown} reserved slot(s)`);
      }
      const spares = hometownFound.filter((f) => !inParsed.has(f.name.toLowerCase().trim()));
      while (haveHometown < reserveHometown && spares.length) {
        const f = spares.shift();
        parsed.push({
          brand: f.name, tier: 'local', category: f.category || 'local', dealType: 'post',
          campaign: `Hometown feature with ${f.name} for ${athlete.name}`,
          rationale: (f.evidence ? `${f.evidence}. ` : '') +
            `${athlete.name} grew up in ${hometownCity}, and a hometown athlete is an easy yes for a local business marketing to the community that knows them.`,
          estimatedValueLow: valLow, estimatedValueHigh: valHigh,
          contactApproach: 'Reach out to the owner or manager directly and lead with the hometown connection.',
          timingNote: '', fitScore: 74 - (reserveHometown - spares.length),
          isLocal: true, market: 'hometown', isFranchise: f.franchise === true,
          contactName: null, contactTitle: 'Owner', contactEmail: f.email || null, contactLinkedIn: null,
          website: f.website || null,
        });
        haveHometown++;
      }
      // Trim lowest-scored school picks to stay within 10 results.
      if (parsed.length > 10) {
        const school = parsed.filter((d) => d.market !== 'hometown').sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
        const home = parsed.filter((d) => d.market === 'hometown');
        parsed = school.slice(0, 10 - home.length).concat(home);
      }
    }

    parsed.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
    console.log(`[dealScan] phase 2 scored ${parsed.length} brand(s) (${parsed.filter((d) => d.market === 'hometown').length} hometown) in ${Date.now() - _tScore}ms — local lane total ${Date.now() - _t0}ms`);
    return parsed.map((d, i) => {
      const meta = metaByName.get((d.brand || '').toLowerCase().trim());
      return finalizeLocal(d, i, 'web', meta ? meta.website : (d.website || null));
    });
  } catch (webErr) {
    console.warn('[dealScan] category web-search path failed, trying model knowledge:', webErr.message);
  }

  // ── FALLBACK: model knowledge (no web search) ───────────────────────────────
  try {
    return await runKnowledgePath();
  } catch (knowledgeErr) {
    console.warn('[dealScan] model-knowledge path failed, using national fallback:', knowledgeErr.message);
  }

  // ── LAST RESORT: national / sport brands (honestly labeled, NOT local) ─────
  {
    console.error('[dealScan] all local paths failed — returning national fallback');
    const sportBrands = {
      softball: ['Dick\'s Sporting Goods','BSN Sports','Rawlings','Mizuno','Wilson Sporting Goods'],
      football: ['Riddell','Athletic Greens (AG1)','BODYARMOR','Fanatics','Under Armour'],
      basketball: ['Spalding','BODYARMOR','Athletic Greens (AG1)','Fanatics','SportClips'],
    };
    const fallbackBrands = sportBrands[sport.toLowerCase()] || sportBrands.football;
    return fallbackBrands.map((b,i) => ({
      rank: i+1, brand: b, tier: i < 2 ? 'regional' : 'national',
      lane: 'local',
      // Honest labeling: these are national brands shown because local search
      // could not be completed — the UI must NOT present them as local matches.
      resultType: 'national',
      fallbackNote: 'National brands — we couldn\'t complete a local search for your market.',
      campaign: `${athlete.name} partnership with ${b}`,
      category: i===0?'equipment':i===1?'nutrition':'apparel',
      dealType: i<2?'ambassador':'reel',
      rationale: `Strong fit for ${sport} athletes — established brand with college NIL programs.`,
      fitScore: 75-i*3, isLocal: false,
      estimatedValueLow: valLow, estimatedValueHigh: valHigh,
      suggestedRate: { low: rate.low, high: rate.high },
      timingNote: 'Open — reach out via brand NIL portal',
      contactApproach: 'Apply through the brand NIL/ambassador portal',
      contactName: null, contactTitle: 'NIL Partnerships Team', contactEmail: null, contactLinkedIn: null
    }));
  }
}

// ─── Deal-Scan Pitch Generation ──────────────────────────────────────────────
// Generates a personalized, authentic outreach pitch in the athlete's real voice.
async function generateDealPitch(athlete, brand) {
  const sport = athlete.sport || 'athlete';
  const school = athlete.school || 'my school';
  const loc = await getSchoolLocation(school);
  const ig = (athlete.instagram || 0).toLocaleString();
  const tt = (athlete.tiktok || 0).toLocaleString();
  const reach = ((athlete.instagram || 0) + (athlete.tiktok || 0)).toLocaleString();

  const prompt = `Write a short, authentic NIL partnership outreach email from a college athlete to a local business.

ATHLETE: ${athlete.name}, ${athlete.position || ''} ${sport} player at ${school} (${loc.city}, ${loc.state})
AUDIENCE: ${ig} Instagram + ${tt} TikTok followers (${reach} total), mostly local to ${loc.city}
BRAND: ${brand.brand || brand.brand_name} (${brand.category || 'local business'})
WHY THIS BRAND: ${brand.rationale || brand.whyFit || ''}
CAMPAIGN IDEA: ${brand.campaign || 'a social media partnership'}

VOICE RULES — this must sound like a real college athlete wrote it, not a marketer:
- No formal openers like "I hope this email finds you well" or "I am writing to"
- No markdown, no bullet points, no headers
- 3-4 short paragraphs max
- Lead with the LOCAL connection (same town, fan of the business, etc.)
- Make a specific, simple ask
- Reference the brand specifically — what they do, why it fits
- Warm, direct, confident but not arrogant
- Sign off with just the athlete's first name

Return ONLY valid JSON: {"subject":"...","body":"..."}`;

  try {
    const raw = await oneShot(prompt, 'You write authentic, casual-but-professional outreach emails in a real college athlete\'s voice. Output ONLY valid JSON {"subject","body"} — no markdown, no preamble. Never use em dashes or en dashes. Use commas, periods, or separate sentences instead. Never state or assume the athlete\'s gender. Refer to the sport plainly (say \'basketball\', never \'men\'s basketball\' or \'women\'s basketball\'). Do not use he/she/his/her for the athlete — use the athlete\'s name or they/them. No gendered descriptors of any kind.', 1200, MODEL_STANDARD);
    const c = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const m = c.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON');
    const out = JSON.parse(m[0]);
    if (!out.subject || !out.body) throw new Error('Missing fields');
    return out;
  } catch (err) {
    console.error('[generateDealPitch]', err.message);
    const bn = brand.brand || brand.brand_name || 'your business';
    return {
      subject: `${athlete.name} x ${bn} — local partnership idea`,
      body: `Hi,\n\nI'm ${athlete.name}, a ${sport} player at ${school} here in ${loc.city}. I follow ${bn} and love what you do in the community.\n\nI've built an audience of about ${reach} followers, most of them local, and I'd love to partner with you on some content that puts ${bn} in front of them. I think a simple social campaign could be a great fit.\n\nWould you be open to a quick chat about it?\n\nThanks,\n${(athlete.name||'').split(' ')[0] || athlete.name}`,
    };
  }
}

// Generates a brief 2-sentence follow-up message for a brand that hasn't responded.
async function generateFollowUp(athlete, brand) {
  const bn = brand.brand_name || brand.brand || 'your business';
  const prompt = `Write a very short, friendly follow-up email (2 sentences max) from college athlete ${athlete.name} to ${bn}. They reached out before about an NIL partnership and haven't heard back. Casual, no pressure, no markdown. Return ONLY JSON {"subject":"...","body":"..."}.`;
  try {
    const raw = await oneShot(prompt, 'You write short friendly follow-up emails in a real athlete\'s voice. Output ONLY JSON {"subject","body"}. Never use em dashes or en dashes. Use commas, periods, or separate sentences instead. Never state or assume the athlete\'s gender. Refer to the sport plainly (say \'basketball\', never \'men\'s basketball\' or \'women\'s basketball\'). Do not use he/she/his/her for the athlete — use the athlete\'s name or they/them. No gendered descriptors of any kind.', 500, MODEL_FAST);
    const c = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const m = c.match(/\{[\s\S]*\}/);
    if (m) { const out = JSON.parse(m[0]); if (out.subject && out.body) return out; }
    throw new Error('parse');
  } catch (err) {
    const first = (athlete.name||'').split(' ')[0] || athlete.name;
    return {
      subject: `Following up — ${athlete.name} x ${bn}`,
      body: `Hi, just wanted to follow up on my note about a partnership with ${bn} — no pressure at all, but I'd still love to connect if you're open to it.\n\nThanks,\n${first}`,
    };
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

  const prompt = `You are a senior NIL strategist who has worked athlete sponsorship deals at a top agency. You write pitch decks that actually land meetings — not decks that read like they came from a content generator.

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

CONTENT RULES — follow every one:
- Write like a human strategist, not a content generator. No buzzwords.
- FORBIDDEN words and phrases: "unique opportunity", "perfect fit", "natural fit", "synergy", "leverage", "passionate", "authentic journey", "exciting", "thrilled", "game-changer", "seamlessly", "cutting-edge", "innovative", "dynamic", "resonate", "impactful", "showcase", "elevate", "take it to the next level", "in today's landscape", "it goes without saying"
- Headlines must be specific and direct. No puns. No exclamation points. Name the athlete and brand plainly.
- Slide 2 bullets: each one must be a real, specific reason based on the athlete's actual data — audience size, school location, sport credibility, engagement rate. Not vague "lifestyle alignment" statements.
- Slide 3 stats: use actual numbers from the athlete data above. Format as short number + label (e.g. "504 — Rushing Yards", "5.7 — Yards Per Carry"). If stats aren't provided, use follower counts or engagement.
- Slide 4 audienceSummary: be specific about WHO the audience is (age range, geography, interests) and why that's valuable to ${targetBrand || 'this brand'} in particular.
- Slide 5 categories: name ${targetBrand || 'the brand'}'s actual product lines or marketing channels, not generic "social media" or "brand ambassador" labels.
- Slide 6 activations: describe real, specific campaign executions — what gets filmed, where, what the deliverable is. No vague "content series" descriptions.
- No dollar amounts, no financial projections, no emojis.
- Never state or assume the athlete's gender. Refer to the sport plainly (say 'basketball', never 'men's basketball' or 'women's basketball'). Do not use he/she/his/her for the athlete — use the athlete's name or they/them. No gendered descriptors of any kind.
- NEVER invent or assume facts not in the athlete data above. Do not claim the athlete has existing sponsors, brand deals, endorsements, awards, rankings, or compliance/FTC clearance unless that exact information is provided. If the data is thin, build the pitch only from what IS given — followers, engagement, sport, position, school, and location. Inventing a partnership or status is a serious error.
- Use the TARGET BRAND name exactly as provided. Do not substitute a parent company, subsidiary, dealership, or alternate brand name.

Return ONLY this JSON — no markdown, no extra keys, no code fences:
{
  "slide1": {
    "headline": "Direct headline, max 10 words, names both ${athlete.name} and ${targetBrand || 'the brand'}",
    "intro": "2 sentences, plain English. What the partnership is and why the timing makes sense right now. No hype."
  },
  "slide2": {
    "bullets": [
      "Specific fact — why this athlete's audience overlaps with ${targetBrand || 'this brand'}'s customer base",
      "Specific fact — athlete's geographic or demographic reach relevant to ${targetBrand || 'this brand'}",
      "Specific fact — platform strength (Instagram/TikTok numbers and engagement rate)",
      "Specific fact — on-field credibility or achievement that gives ${targetBrand || 'this brand'} a story to tell",
      "Specific fact — a content or campaign angle unique to this athlete's story or position"
    ]
  },
  "slide3": {
    "stats": [
      "Number — Label (e.g. '504 — Rushing Yards' or '53K — Combined Followers')",
      "Number — Label",
      "Number — Label"
    ],
    "role": "One plain sentence on the athlete's competitive standing. Why a brand partner would care about this specifically."
  },
  "slide4": {
    "instagram": "${ig}",
    "tiktok": "${tt}",
    "engagement": "${athlete.engagement || 'N/A'}%",
    "audienceSummary": "Who specifically follows this athlete and why that demographic matters to ${targetBrand || 'this brand'}. Be concrete — age range, geography, interests.",
    "growthSignal": "One sentence on trajectory or timing. Why now."
  },
  "slide5": {
    "categories": [
      { "name": "Name of a real ${targetBrand || 'brand'} product line or marketing channel", "reason": "One sentence on why this specific activation makes sense — what the athlete brings to it" },
      { "name": "Name of a real ${targetBrand || 'brand'} product line or marketing channel", "reason": "One sentence" },
      { "name": "Name of a real ${targetBrand || 'brand'} product line or marketing channel", "reason": "One sentence" },
      { "name": "Name of a real ${targetBrand || 'brand'} product line or marketing channel", "reason": "One sentence" }
    ]
  },
  "slide6": {
    "activations": [
      { "title": "Short campaign title — specific to ${targetBrand || 'brand'}", "description": "Exactly what gets created: what's filmed, where, what the deliverable is, which platform. 2 sentences, no vague language." },
      { "title": "Short campaign title", "description": "Exactly what gets created. 2 sentences." },
      { "title": "Short campaign title", "description": "Exactly what gets created. 2 sentences." }
    ]
  }
}`;

  try {
    const raw = await oneShot(prompt, 'You are a senior NIL agency strategist. Return only valid JSON. No markdown, no code fences, no preamble. Every field must be specific to this athlete and brand — no placeholder text, no generic statements. Never use em dashes or en dashes. Use commas, periods, or separate sentences instead. Never state or assume the athlete\'s gender. Refer to the sport plainly (say \'basketball\', never \'men\'s basketball\' or \'women\'s basketball\'). Do not use he/she/his/her for the athlete — use the athlete\'s name or they/them. No gendered descriptors of any kind.', 2000, MODEL_STANDARD);
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

  // ── Legacy prompt (feature_email_v2 = false) ──────────────────
  if (!FEATURE_EMAIL_V2) {
    const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);
    const legacyPrompt = `You are an elite sports agent writing ${outreachType} outreach for ${athlete.name} targeting ${targetBrand}.
ATHLETE: ${athlete.name} | ${athlete.sport || 'athlete'} | ${athlete.position || ''} at ${athlete.school || 'Unknown'}
Instagram: ${(athlete.instagram||0).toLocaleString()} followers | TikTok: ${(athlete.tiktok||0).toLocaleString()} followers
Engagement: ${athlete.engagement || 0}% | Stats: ${athlete.stats || 'N/A'}
DEAL CONTEXT: Target brand: ${targetBrand} | Category: ${category || 'general'} | Goal: ${goal ? '$' + parseInt(goal).toLocaleString() : 'Market rate'}
Generate outreach messages. Return ONLY JSON: {"sponsorshipEmail":{"subject":"subject","body":"full email 150-200 words"},"instagramDm":"DM under 150 chars","partnershipProposal":"2-3 paragraph proposal","followUpEmail":{"subject":"follow-up subject","body":"75-100 word follow-up"}}`;
    const raw = await oneShot(legacyPrompt, 'You are an elite sports agent writing brand outreach. Return only valid JSON. Never use em dashes or en dashes. Use commas, periods, or separate sentences instead. Never state or assume the athlete\'s gender. Refer to the sport plainly (say \'basketball\', never \'men\'s basketball\' or \'women\'s basketball\'). Do not use he/she/his/her for the athlete — use the athlete\'s name or they/them. No gendered descriptors of any kind.', 8000);
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON');
    return JSON.parse(match[0]);
  }

  // ── v2: human operator voice ──────────────────────────────────
  const ig   = athlete.instagram || 0;
  const tt   = athlete.tiktok    || 0;
  const er   = athlete.engagement || 0;
  const igFmt = ig >= 1000 ? 'around ' + Math.round(ig / 1000) + 'K' : String(ig);
  const ttFmt = tt >= 1000 ? 'around ' + Math.round(tt / 1000) + 'K' : (tt > 0 ? String(tt) : null);

  // Only pass the 1-2 most useful stats — not a full stat line
  const statsLine = athlete.stats ? athlete.stats.split('|')[0].trim() : null;

  const system = `You are a NIL agent or operator writing cold outreach to brand contacts. You write the way real operators text and email — short, direct, observational. Not a marketer. Not a PR agency. Not a pitch deck.

Your emails:
- Feel handwritten, not generated
- Are 150–175 words maximum for the main email
- Use conversational language a human would actually say
- Reference the brand subtly — never over-explain their strategy back to them
- Introduce the athlete briefly with only 1–2 relevant facts
- Describe ONE simple content idea in plain English
- Close with "Happy to share more if helpful." or similar — never pushy

FORBIDDEN — using any of these causes immediate failure:
"The idea itself is simple" / "As I was thinking through" / "stands out because" / "Hope you're doing well" as standalone opener / "I wanted to reach out" / "unique opportunity" / "perfect fit" / "natural fit" / "synergy" / "leverage" / "seamless" / "authentic journey" / "game-changer" / "thrilled" / "passionate" / "I'm excited" / "I'm confident" / "look forward to hearing" / "at your earliest convenience" / "if it sounds interesting, I'd love to jump on a call" / "moving forward" / "value-add" / "I am writing to" / any section headers / any bullet points in the email body

Return only valid JSON. No markdown. Never use em dashes or en dashes. Use commas, periods, or separate sentences instead. Never state or assume the athlete's gender. Refer to the sport plainly (say 'basketball', never 'men's basketball' or 'women's basketball'). Do not use he/she/his/her for the athlete — use the athlete's name or they/them. No gendered descriptors of any kind.`;

  const prompt = `Write NIL outreach for ${athlete.name} to ${targetBrand}.

ATHLETE:
- ${athlete.name}, ${athlete.sport || 'athlete'}${athlete.position ? ' (' + athlete.position + ')' : ''}, ${athlete.school || 'college'}
- Instagram: ${igFmt}${ttFmt ? ' | TikTok: ' + ttFmt : ''}
- Engagement: ${er}%${statsLine ? '\n- Key stat: ' + statsLine : ''}
${athlete.notes ? '- Context: ' + athlete.notes.substring(0, 120) : ''}

BRAND: ${targetBrand}
Category: ${category || 'consumer brand'}

TARGET EMAIL STYLE:
- Open by referencing something observable about ${targetBrand} (their market presence, product, footprint)
- Introduce ${athlete.name} in 1–2 sentences — only the most relevant credential
- Describe one simple content idea without over-explaining it
- 1–2 lines on audience alignment
- Close with "Happy to share more if helpful." or equivalent
- Sign off: Name, Role — nothing else

Return ONLY this JSON:
{
  "sponsorshipEmail": {
    "subject": "${athlete.name} × ${targetBrand} — NIL",
    "body": "Full email — 150-175 words, no bullets, no headers, reads like a real human email"
  },
  "instagramDm": "Under 140 chars — casual opener that sounds like a real DM, not a pitch. Reference one specific thing about the brand.",
  "partnershipProposal": "2 short paragraphs — what the partnership is and why this athlete, written plainly without pitch language. No bullet lists. No headers.",
  "followUpEmail": {
    "subject": "Re: ${athlete.name} × ${targetBrand}",
    "body": "60–80 word follow-up for 7 days after no response. Adds one new angle or observation. Ends with soft out — 'no worries if timing isn't right'."
  }
}`;

  try {
    const raw = await oneShot(prompt, system, 4000, MODEL_STANDARD);
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON');
    return JSON.parse(match[0]);
  } catch(err) {
    console.error('[generateOutreach v2] error:', err.message);
    throw err;
  }
}

module.exports = {
  MODEL_FAST,
  MODEL_STANDARD,
  FEATURE_EMAIL_V2,
  streamResponse,
  oneShot,
  oneShotWithSearch,
  oneShotWebSearch,
  calculateRate,
  calculateRateLive,
  getDealRecommendations,
  generateDealPitch,
  generateFollowUp,
  buildSystemPrompt,
  generateAthleteBrandKit,
  generateOutreach
};
