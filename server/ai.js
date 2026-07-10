// server/ai.js — NILDash AI Engine v4
// v4: improved system prompt with v4 scores, AI marketing tools, improved team match context

const Anthropic = require('@anthropic-ai/sdk');
const { MARKET_RATES, DEAL_COMPS, BRAND_WINDOWS, nilViewVal } = require('./benchmarks');
const store = require('./store');
const { getSeeds } = require('./dealScanSeeds');
const { normalizeState, areaCodeState, stateName } = require('./areaCodes');

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

// ── Athlete interest tags: fixed taxonomy (kept in sync with the frontend
// picker in index.html). Tags are stored on the athlete as "industry:sub"
// strings, e.g. "fitness:supplements". They weight Deal Scan search emphasis
// and scoring boosts.
const TAG_TAXONOMY = {
  fitness:   { label: 'Fitness',                  subs: ['supplements', 'creatine', 'protein', 'apparel', 'gyms'] },
  foodbev:   { label: 'Food and Beverage',        subs: ['coffee', 'pizza', 'smoothies', 'energy drinks', 'snacks', 'restaurants'] },
  beauty:    { label: 'Beauty and Personal Care', subs: ['skincare', 'haircare', 'makeup', 'fragrance'] },
  fashion:   { label: 'Fashion',                  subs: ['streetwear', 'sneakers', 'accessories'] },
  auto:      { label: 'Auto',                     subs: ['dealerships', 'detailing', 'tires'] },
  wellness:  { label: 'Health and Wellness',      subs: ['chiropractic', 'physical therapy', 'mental health', 'recovery'] },
  tech:      { label: 'Tech and Gaming',          subs: ['gaming', 'apps', 'accessories'] },
  outdoors:  { label: 'Outdoors',                 subs: ['hunting', 'fishing', 'camping'] },
  finance:   { label: 'Finance',                  subs: ['banks', 'credit unions', 'insurance'] },
  community: { label: 'Community',                subs: ['local events', 'nonprofits', 'youth sports'] },
};

// Resolve one raw tag string to a taxonomy {industry, sub} pair, or null.
// Accepts BOTH formats: the qualified "fitness:supplements" the picker saves
// AND bare sub-tags like "supplements" (production athletes exist with bare
// tags, and the old strict parser silently dropped every one of them, which
// zeroed out validTagSubs and made all downstream derivation a no-op).
// Unknown tags are still dropped, never trusted.
function resolveTag(t) {
  const s = String(t || '').trim();
  if (!s) return null;
  const idx = s.indexOf(':');
  if (idx > 0) {
    const ind = s.slice(0, idx), sub = s.slice(idx + 1);
    if (TAG_TAXONOMY[ind] && TAG_TAXONOMY[ind].subs.includes(sub)) return { ind, sub };
    return null;
  }
  const bare = s.toLowerCase();
  for (const ind of Object.keys(TAG_TAXONOMY)) {
    if (TAG_TAXONOMY[ind].subs.includes(bare)) return { ind, sub: bare };
  }
  return null;
}

// Display descriptors like "supplements (Fitness)" for prompts.
function describeTags(tags) {
  const out = [];
  for (const t of (Array.isArray(tags) ? tags : [])) {
    const r = resolveTag(t);
    if (r) out.push(`${r.sub} (${TAG_TAXONOMY[r.ind].label})`);
  }
  return out;
}
function validTagSubs(tags) {
  const out = [];
  for (const t of (Array.isArray(tags) ? tags : [])) {
    const r = resolveTag(t);
    if (r) out.push(r.sub);
  }
  return [...new Set(out)];
}

// Robust matched-tag derivation. Two grounded sources, both mapped back to the
// athlete's EXACT tag strings so a tag they do not have can never appear:
// 1. The model's matchedTags output, matched case-insensitively (Haiku likes
//    to capitalize, which a strict === filter silently dropped in production).
// 2. Word-boundary containment of the tag (singular or plural) in the
//    candidate's own real strings (name, category, evidence, rationale), so an
//    obvious match like Smoothie King vs "smoothies" always lands even when
//    the model forgets to emit it.
function deriveMatchedTags(d, meta, athleteTagSubs) {
  if (!athleteTagSubs || !athleteTagSubs.length) return [];
  const out = new Set();
  const canon = new Map(athleteTagSubs.map((s) => [s.toLowerCase(), s]));
  for (const t of (Array.isArray(d.matchedTags) ? d.matchedTags : [])) {
    const hit = canon.get(String(t).toLowerCase().trim());
    if (hit) out.add(hit);
  }
  const hay = [d.brand, d.category, d.rationale, meta && meta.name, meta && meta.category, meta && meta.evidence]
    .filter(Boolean).join(' ').toLowerCase();
  for (const sub of athleteTagSubs) {
    const stem = sub.toLowerCase().replace(/s$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('\\b' + stem + '(s|es)?\\b').test(hay)) out.add(sub);
  }
  return [...out];
}

// Tolerant JSON-array extraction. Salvages every complete object from
// truncated model output (max_tokens cutoffs leave the array unterminated,
// which used to make the whole search look "parsed-but-empty") instead of
// discarding the response. Candidate objects are flat, so brace matching is
// safe.
function extractJsonArrayItems(raw) {
  const t = String(raw || '').replace(/```json/g, '').replace(/```/g, '').trim();
  const a = t.indexOf('[');
  if (a === -1) return { items: [], salvaged: false };
  const body = t.slice(a);
  const b = body.lastIndexOf(']');
  if (b > 0) {
    try {
      const arr = JSON.parse(body.slice(0, b + 1));
      if (Array.isArray(arr)) return { items: arr, salvaged: false };
    } catch (_) { /* fall through to per-object salvage */ }
  }
  const items = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(body))) {
    try { items.push(JSON.parse(m[0])); } catch (_) { /* skip incomplete object */ }
  }
  return { items, salvaged: true };
}

// Instrumented, capped search call. Resolves with {status, raw, ms} so the
// caller can log EXACTLY why a search produced nothing (timeout vs error vs
// parsed-but-empty) — reasons are never swallowed.
function timedSearch(p, capMs) {
  const t0 = Date.now();
  const tagged = Promise.resolve(p).then(
    (r) => ({ status: 'ok', raw: r || '', ms: Date.now() - t0 }),
    (e) => ({ status: 'error', err: (e && e.message) || String(e), raw: '', ms: Date.now() - t0 })
  );
  return Promise.race([
    tagged,
    new Promise((res) => setTimeout(() => res({ status: 'timeout', raw: '', ms: capMs }), capMs)),
  ]);
}

// ─── Deal Scan evidence helpers (SOCIAL + TOP NIL lanes) ─────────────────────
// These make the two non-local lanes evidence-backed: every claim on a card
// traces to a real source (a brand program page, a disclosed-deal record, or a
// labeled web result), and a brand with no verifiable evidence never renders a
// hollow card. Structured evidence is cached per brand for ~7 days; the
// qualification verdict is derived per-athlete at scan time (never cached).

// Max concurrent per-brand evidence searches on a COLD cache. Keeps a scan from
// firing 16 web_search calls at once (rate-limit safe) while still finishing the
// pool in a couple of batches. Warm-cache lookups are instant and unaffected.
const EVIDENCE_CONCURRENCY = 8;

// One-time flag so a production scan logs the exact social search query once
// (for diagnosis) without repeating the full prompt on every brand.
let _loggedSocialQuery = false;

// Run fn over items with bounded concurrency, preserving index order. A throwing
// item resolves to null (never rejects the whole batch).
async function _mapLimit(items, limit, fn) {
  const results = new Array(items.length).fill(null);
  let idx = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); } catch (_) { results[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// Follower count as an agent reads it: 18400 -> "18.4K", 5000 -> "5K".
function _fmtFollowers(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

// Trim a model string and reject "empty" sentinels so a null never renders as
// the literal text "null" / "N/A" on a card.
function _cleanStr(s) {
  if (s === null || s === undefined) return null;
  const t = stripEmDashes(String(s)).trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (low === 'null' || low === 'n/a' || low === 'none' || low === 'unknown') return null;
  return t;
}

// Accept a URL only when it is a well-formed http(s) link (bare domains get an
// https:// prefix). Guards against a hallucinated "apply page" that is really a
// sentence. Returns the normalized URL or null.
function _safeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u || u.toLowerCase() === 'null') return null;
  if (!/^https?:\/\//i.test(u)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[\/?#].*)?$/i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    else return null;
  }
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || parsed.hostname.indexOf('.') === -1) return null;
    return parsed.toString();
  } catch { return null; }
}

// The athlete's strongest single-platform following. Ambassador minimums and
// disclosed-deal follower tiers are almost always per platform, so comparing
// against the larger platform is the honest, most favorable reading: below it
// means below everywhere.
function _primaryFollowers(athlete) {
  const ig = athlete.instagram || 0;
  const tt = athlete.tiktok || 0;
  const count = Math.max(ig, tt);
  return { count, platform: count === 0 ? null : (ig >= tt ? 'Instagram' : 'TikTok') };
}

function _firstName(athlete) {
  const n = String((athlete && athlete.name) || '').trim();
  return n ? n.split(/\s+/)[0] : 'This athlete';
}

// Honest qualify/not-qualify verdict for SOCIAL. Derived per-athlete at scan
// time (never cached) so a stale follower count cannot leak a bad verdict.
function _socialVerdict(followerMinimum, athlete) {
  const { count } = _primaryFollowers(athlete);
  if (!followerMinimum || followerMinimum <= 0) {
    return { qualifies: null, status: 'no-minimum', text: 'No stated minimum' };
  }
  if (!count) {
    return { qualifies: null, status: 'unknown', text: `Minimum ${_fmtFollowers(followerMinimum)}, add follower counts to check` };
  }
  if (count >= followerMinimum) {
    return { qualifies: true, status: 'qualifies', text: `${_firstName(athlete)} qualifies (${_fmtFollowers(count)}, minimum ${_fmtFollowers(followerMinimum)})` };
  }
  return { qualifies: false, status: 'below', text: `Below their stated minimum (needs ${_fmtFollowers(followerMinimum)})` };
}

// Honest TOP NIL verdict against the OBSERVED follower range of the brand's
// disclosed signings. Null range -> honest "cannot compare", never a guess.
function _topnilVerdict(min, max, athlete) {
  const { count } = _primaryFollowers(athlete);
  if (!min || !max || !count) {
    return { qualifies: null, status: 'unknown', text: 'Not enough follower data to compare' };
  }
  if (count < min) {
    return { qualifies: false, status: 'below', text: `Below their typical range (they sign ${_fmtFollowers(min)}+)` };
  }
  if (count > max) {
    return { qualifies: true, status: 'above', text: `Above their typical range (${_fmtFollowers(min)} to ${_fmtFollowers(max)}), a strong target` };
  }
  return { qualifies: true, status: 'in-range', text: `In their typical range (${_fmtFollowers(min)} to ${_fmtFollowers(max)})` };
}

// Derive an HONEST "typical athlete profile" from real disclosed deals. A
// follower range is only produced when at least two deals carry real numbers;
// with fewer, the range is omitted rather than invented.
function _deriveTypicalProfile(deals) {
  const nums = deals.map(d => d.followers).filter(n => typeof n === 'number' && n > 0);
  const sportCounts = {};
  for (const d of deals) {
    const s = _cleanStr(d.sport);
    if (s) sportCounts[s.toLowerCase()] = (sportCounts[s.toLowerCase()] || 0) + 1;
  }
  const topSports = Object.keys(sportCounts).sort((a, b) => sportCounts[b] - sportCounts[a]).slice(0, 2);

  let rangePart = null, min = null, max = null;
  if (nums.length >= 2) {
    min = Math.min(...nums); max = Math.max(...nums);
    rangePart = min === max ? `${_fmtFollowers(min)} followers` : `${_fmtFollowers(min)} to ${_fmtFollowers(max)} followers`;
  } else if (nums.length === 1) {
    rangePart = `around ${_fmtFollowers(nums[0])} followers`; // one point is not a range
  }

  const bits = [];
  if (rangePart) bits.push(rangePart);
  if (topSports.length) bits.push('mostly ' + topSports.join(' and '));
  const typicalProfile = bits.length ? ('Recent signings: ' + bits.join(', ')) : null;
  return { typicalProfile, min, max };
}

// Gather (and cache ~7 days) a SOCIAL brand's ambassador/creator program
// evidence. Returns { evidence, outcome, cached }. outcome is one of
// OK | SALVAGED | NO_EVIDENCE | TIMEOUT | ERROR. A card is only worth showing
// with a real apply URL, so brands without one resolve to NO_EVIDENCE.
async function _fetchSocialProgramEvidence(brand, website, force = false) {
  if (!force) {
    const cached = await store.getBrandEvidence(brand, 'social');
    if (cached) return { evidence: cached.evidence || {}, outcome: cached.outcome || 'NO_EVIDENCE', cached: true };
  }

  const domain = _domainFromUrl(website);
  const sys = 'You research brand ambassador programs using web search. Report ONLY facts stated on the brand\'s own website. Never invent a program, a URL, or a follower minimum. Output ONLY one JSON object.';
  const prompt = `Find the official athlete, ambassador, creator, or affiliate program run by the brand "${brand}"${domain ? ` (website ${domain})` : ''}. Use web search. Use ONLY what is actually stated on ${brand}'s own pages.
Return ONLY this JSON object:
{"hasProgram":true|false,"programName":string|null,"status":"open"|"closed"|"unclear","applyUrl":string|null,"followerMinimum":number|null,"requirements":string|null,"offer":string|null,"responseTime":string|null,"sourceUrl":string|null}
Rules:
- hasProgram=false when you cannot find a real, brand-run program page. Do not force one.
- applyUrl must be the actual application or signup page for the program, not the homepage or a blog post. null if you cannot find the real apply page.
- status "open" only if the page shows applications are currently accepted, "closed" if it says closed or waitlisted, otherwise "unclear".
- followerMinimum: a single number ONLY if the brand explicitly states a minimum follower or subscriber count, else null. Never guess.
- requirements: a short line of stated eligibility (for example "public account, US based, 18+"), null if none stated.
- offer: what the program gives (free product, commission percentage, paid posts, affiliate code), null if not stated.
- responseTime: only if stated, else null.
- sourceUrl: the brand page where you found this, null if none.`;

  if (!_loggedSocialQuery) {
    _loggedSocialQuery = true;
    console.log(`[dealScan] social SEARCH QUERY sample brand=${brand} sys=${JSON.stringify(sys)} prompt=${JSON.stringify(prompt)}`);
  }

  let raw = '';
  const _wt0 = Date.now();
  try {
    raw = await withTimeout(oneShotWebSearch(prompt, sys, 700, 3, 'claude-sonnet-4-6'), 9000, '');
  } catch (e) {
    console.log(`[dealScan] social search brand=${brand} searchMs=${Date.now() - _wt0} result=ERROR ${e.message}`);
    return { evidence: {}, outcome: 'ERROR', cached: false, skipCache: true };
  }
  // Raw head + length + search time, so a failing brand's actual model output is
  // visible in the logs (rawLen=0 means the 9s cap fired = TIMEOUT).
  console.log(`[dealScan] social search brand=${brand} searchMs=${Date.now() - _wt0} rawLen=${(raw || '').length} rawHead=${JSON.stringify((raw || '').slice(0, 300))}`);
  if (!raw) return { evidence: {}, outcome: 'TIMEOUT', cached: false, skipCache: true };

  let parsed = null;
  try {
    const t = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b > a) parsed = JSON.parse(t.substring(a, b + 1));
  } catch (_) { parsed = null; }

  const applyUrl = parsed ? _safeUrl(parsed.applyUrl) : null;
  if (!parsed || parsed.hasProgram !== true || !applyUrl) {
    await store.saveBrandEvidence(brand, 'social', brand, website, {}, 'NO_EVIDENCE');
    return { evidence: {}, outcome: 'NO_EVIDENCE', cached: false };
  }

  const status = ['open', 'closed', 'unclear'].includes(parsed.status) ? parsed.status : 'unclear';
  const followerMinimum = (typeof parsed.followerMinimum === 'number' && parsed.followerMinimum > 0)
    ? Math.round(parsed.followerMinimum) : null;
  const evidence = {
    kind: 'program',
    programName: _cleanStr(parsed.programName),
    status,
    applyUrl,
    followerMinimum,
    requirements: _cleanStr(parsed.requirements),
    offer: _cleanStr(parsed.offer),
    responseTime: _cleanStr(parsed.responseTime),
    sourceUrl: _safeUrl(parsed.sourceUrl) || applyUrl,
  };
  const outcome = status === 'open' ? 'OK' : 'SALVAGED';
  await store.saveBrandEvidence(brand, 'social', brand, website, evidence, outcome);
  return { evidence, outcome, cached: false };
}

// Gather (and cache ~7 days) a TOP NIL brand's disclosed-deal precedent. Prefers
// our own disclosed-deal table (fast, no web); falls back to a labeled web
// search only when the table has nothing for the brand.
async function _fetchTopNilEvidence(brand, website, sport, force = false) {
  if (!force) {
    const cached = await store.getBrandEvidence(brand, 'topnil');
    if (cached) return { evidence: cached.evidence || {}, outcome: cached.outcome || 'NO_EVIDENCE', cached: true };
  }

  let deals = [];
  let source = null;

  try {
    const rows = await store.getCompsByBrand(brand, 3);
    if (rows && rows.length) {
      source = 'comp';
      deals = rows.map(r => ({
        athlete: _cleanStr(r.athlete_name),
        sport: _cleanStr(r.sport),
        followers: (typeof r.followers === 'number' ? r.followers : parseInt(r.followers, 10)) || null,
        dealType: _cleanStr(r.deal_type),
        date: r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : null,
        sourceUrl: _safeUrl(r.source),
        source: 'comp',
      })).filter(d => d.athlete);
    }
  } catch (_) { /* comp table unavailable -> web fallback */ }

  if (!deals.length) {
    const sys = 'You research disclosed NIL and brand deals using web search. Report ONLY deals you can actually find with a real reporting source. Never invent an athlete, a deal, or a follower number. Output ONLY a JSON array.';
    const prompt = `Find up to 3 recent (last ~2 years) publicly disclosed NIL or brand-ambassador deals that the brand "${brand}" has done with college athletes${sport ? `, favoring ${sport} when available` : ''}. Use web search.
Return ONLY a JSON array: [{"athlete":string,"sport":string|null,"followerTier":string|null,"dealType":string|null,"date":string|null,"sourceUrl":string}]
Rules: include a deal ONLY if you can point to a real reporting source (sourceUrl is required). followerTier is an approximate description like "~25K" ONLY if it was reported, else null. Return [] if you cannot find real disclosed deals. Never fabricate.`;
    let raw = '';
    try {
      raw = await withTimeout(oneShotWebSearch(prompt, sys, 700, 3, 'claude-sonnet-4-6'), 9000, '');
    } catch (e) {
      return { evidence: {}, outcome: 'ERROR', cached: false, skipCache: true };
    }
    if (!raw) return { evidence: {}, outcome: 'TIMEOUT', cached: false, skipCache: true };
    try {
      const t = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const a = t.indexOf('['), b = t.lastIndexOf(']');
      if (a !== -1 && b > a) {
        const arr = JSON.parse(t.substring(a, b + 1));
        for (const it of (Array.isArray(arr) ? arr : [])) {
          const src = _safeUrl(it && it.sourceUrl);
          const ath = _cleanStr(it && it.athlete);
          if (!src || !ath) continue; // unverifiable without a source and an athlete
          deals.push({
            athlete: ath,
            sport: _cleanStr(it.sport),
            followers: null,
            followerTier: _cleanStr(it.followerTier),
            dealType: _cleanStr(it.dealType),
            date: _cleanStr(it.date),
            sourceUrl: src,
            source: 'web',
          });
          if (deals.length >= 3) break;
        }
      }
    } catch (_) { /* unparseable -> treated as no deals below */ }
    if (deals.length) source = 'web';
  }

  if (!deals.length) {
    const evidence = { kind: 'deals', deals: [], typicalProfile: null, profileSource: null, min: null, max: null };
    await store.saveBrandEvidence(brand, 'topnil', brand, website, evidence, 'NO_EVIDENCE');
    return { evidence, outcome: 'NO_EVIDENCE', cached: false };
  }

  const { typicalProfile, min, max } = _deriveTypicalProfile(deals);
  const evidence = { kind: 'deals', deals, typicalProfile, profileSource: source, min, max };
  const outcome = source === 'comp' ? 'OK' : 'SALVAGED';
  await store.saveBrandEvidence(brand, 'topnil', brand, website, evidence, outcome);
  return { evidence, outcome, cached: false };
}

// Build a SOCIAL card from a brand's program evidence + this athlete's verdict.
// Every social card already has a real program; fitScore rewards an OPEN program
// the athlete actually qualifies for over an unclear one they cannot. Structured
// fields are also surfaced at top level (programStatus, applyUrl, followerMinimum,
// verdict) so any consumer can read them without reaching into `evidence`.
function _buildSocialCard(f, evidence, verdict, ctx) {
  const { rate, valLow, valHigh } = ctx;
  let score = 55;
  if (evidence.status === 'open') score += 25;
  else if (evidence.status === 'closed') score -= 12;
  else score += 8; // unclear
  if (verdict.status === 'qualifies') score += 15;
  else if (verdict.status === 'no-minimum') score += 8;
  else if (verdict.status === 'below') score -= 14;
  else score += 3; // unknown (missing follower counts)
  if (evidence.offer) score += 4;
  if (evidence.responseTime) score += 3;
  if (evidence.requirements) score += 2;
  score = Math.max(20, Math.min(99, Math.round(score)));

  const parts = [evidence.programName ? `Runs the ${evidence.programName}` : 'Runs a creator ambassador program'];
  if (evidence.offer) parts.push(evidence.offer);
  const rationale = stripEmDashes(parts.join('. ').replace(/\.+$/, '') + '.');

  return {
    brand: f.name,
    tier: 'social',
    category: f.category || 'dtc',
    dealType: /affiliate/i.test(evidence.offer || '') ? 'affiliate' : 'ambassador',
    campaign: '',
    rationale,
    contactApproach: `Apply through their ${evidence.programName || 'ambassador'} page.`,
    timingNote: evidence.responseTime ? `Typical response: ${evidence.responseTime}` : '',
    fitScore: score,
    isLocal: false,
    resultType: 'social',
    lane: 'social',
    source: f._seed ? 'seed' : 'web',
    evidence: { ...evidence, verdict },
    // Flat, greppable fields for any consumer / the production verification:
    programStatus: evidence.status,
    applyUrl: evidence.applyUrl,
    followerMinimum: evidence.followerMinimum,
    sourceUrl: evidence.sourceUrl,
    verdict,
    activelyMarketing: true,
    website: f.website || null,
    contactEmail: validateContactEmail(f.email, f.website || null),
    contactName: null,
    contactTitle: 'Partnerships / Creator Team',
    contactLinkedIn: null,
    estimatedValueLow: valLow,
    estimatedValueHigh: valHigh,
    suggestedRate: { low: rate.low, high: rate.high },
  };
}

// Build a TOP NIL card from disclosed-deal precedent + this athlete's verdict.
// Comp-table precedent outranks web-found deals, which outrank no verifiable
// deals at all.
function _buildTopNilCard(f, evidence, verdict, outcome, ctx) {
  const { rate, valLow, valHigh } = ctx;
  const deals = (evidence && evidence.deals) || [];
  const hasDeals = deals.length > 0;
  let score;
  if (!hasDeals) {
    score = 30; // kept but ranked last: no verifiable precedent
  } else {
    score = 45;
    score += evidence.profileSource === 'comp' ? 30 : 16;
    score += Math.min(deals.length, 3) * 3;
    if (verdict.status === 'in-range' || verdict.status === 'above') score += 12;
    else if (verdict.status === 'below') score -= 8;
    else score += 2;
  }
  score = Math.max(20, Math.min(99, Math.round(score)));

  const rationale = hasDeals
    ? stripEmDashes((evidence.typicalProfile || `${deals.length} recent disclosed deal${deals.length > 1 ? 's' : ''} on record`).replace(/\.+$/, '') + '.')
    : 'No recent disclosed deals found for this brand.';

  return {
    brand: f.name,
    tier: 'topnil',
    category: f.category || 'nil',
    dealType: 'ambassador',
    campaign: '',
    rationale,
    contactApproach: 'Reach their NIL or partnerships team.',
    timingNote: '',
    fitScore: score,
    isLocal: false,
    resultType: 'topnil',
    lane: 'topnil',
    source: f._seed ? 'seed' : (evidence && evidence.profileSource) || 'web',
    evidence: { ...(evidence || {}), verdict },
    // Flat, greppable fields:
    disclosedDeals: deals,
    typicalProfile: (evidence && evidence.typicalProfile) || null,
    verdict,
    activelyMarketing: hasDeals,
    website: f.website || null,
    contactEmail: validateContactEmail(f.email, f.website || null),
    contactName: null,
    contactTitle: 'NIL / Partnerships Team',
    contactLinkedIn: null,
    estimatedValueLow: valLow,
    estimatedValueHigh: valHigh,
    suggestedRate: { low: rate.low, high: rate.high },
  };
}

// ─── Deal Scan: real named contacts per brand ───────────────────────────────
// Replaces the old info@brand.com dead end. We web-search for the actual humans
// an agent should reach, and NEVER fabricate a contact, email, phone, or title.
// A made-up email is far worse than no email.

// Generic mailbox local-parts that are never a named person. These may appear at
// the bottom of a card, clearly labeled, but never as a primary contact.
const _GENERIC_LOCALPARTS = new Set([
  'info', 'contact', 'hello', 'hi', 'sales', 'support', 'admin', 'team',
  'marketing', 'press', 'media', 'partnerships', 'partner', 'pr', 'careers',
  'jobs', 'help', 'office', 'general', 'inquiries', 'enquiries', 'service',
  'customerservice', 'ambassador', 'ambassadors', 'affiliate', 'affiliates',
  'noreply', 'no-reply', 'orders', 'booking', 'reservations', 'wholesale',
]);

function _validEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const e = email.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
function _isGenericInbox(email) {
  const e = _validEmail(email);
  if (!e) return false;
  return _GENERIC_LOCALPARTS.has(e.split('@')[0].toLowerCase());
}
// Keep the published phone formatting; reject anything that is not a plausible
// phone number (10 to 15 digits).
function _normalizePhone(p) {
  if (!p || typeof p !== 'string') return null;
  const digits = p.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return _cleanStr(p);
}
// Rank a title by decision-making authority (lower = more senior). Owner and
// franchisee lead for local businesses; marketing/partnerships leadership leads
// for larger brands.
function _contactAuthorityRank(title) {
  const t = String(title || '').toLowerCase();
  // Registered agent is often a lawyer or filing service, not a decision maker:
  // keep it but rank it LAST. Check first so "registered agent" is never caught
  // by a looser rule below.
  if (/registered agent/.test(t)) return 9;
  if (/\bowner\b|founder|proprietor|principal|\bceo\b|president/.test(t)) return 0;
  if (/franchis/.test(t)) return 1;
  // Officers and LLC members named in a state filing rank just under owner.
  if (/\bofficer\b|\bmember\b|managing member|\bpartner\b|\bdirector\b(?!.*marketing)|\btreasurer\b|\bsecretary\b|incorporator/.test(t)) return 2;
  if (/general manager|\bgm\b|managing director|\bmanaging\b/.test(t)) return 3;
  if (/(marketing|brand|partnership|sponsorship)[^.]*(director|vp|vice president|head|chief|lead)|\bcmo\b|director of marketing/.test(t)) return 4;
  if (/marketing manager|partnerships? (manager|lead|coordinator)|brand manager/.test(t)) return 5;
  if (/manager|coordinator|specialist/.test(t)) return 6;
  return 7;
}

// Resolve a contact's email. TODAY: return ONLY an email literally published for
// this person (and never a generic inbox). The name/domain arguments exist so a
// verification provider (e.g. Hunter.io) can be dropped in here LATER, returning
// { email, emailSource: 'verified' } — without a rewrite. NEVER guess an email
// from a pattern like firstname@domain, not even labeled as a guess.
async function resolveEmail(name, domain, publishedEmail) {
  const em = _validEmail(publishedEmail);
  if (em && !_isGenericInbox(em)) return { email: em, emailSource: 'published' };
  // Future hook (intentionally inert now — no paid API is integrated):
  //   if (!em && process.env.HUNTER_API_KEY) {
  //     const v = await hunterFindEmail(name, domain);
  //     if (v && v.verified) return { email: v.email, emailSource: 'verified' };
  //   }
  return { email: null, emailSource: null };
}

// Gather (and cache ~30 days — people change jobs slowly) the real named people
// to contact at a brand. Returns { contacts, genericInbox, businessPhone,
// outcome, cached }. Every contact carries name + title + sourceUrl (a contact
// without a name is not a contact) and an email ONLY if it was literally
// published. Never fabricates to fill the list.
// Confirm a phone plausibly belongs to the card's market. A wrong-location number
// is worse than no number, so we only KEEP a phone we can positively tie to the
// region: the model-reported state matches, OR the area code is in the region's
// state. A cross-state area code (e.g. 307 Wyoming for a Georgia card) or a
// toll-free / unknown code with no confirming state is rejected. When there is no
// region to check against (national brands), the phone is allowed.
function _phoneLocalityOk(phone, reportedState, regionState) {
  if (!regionState) return { ok: true, reason: 'no-region' };
  const rs = reportedState ? normalizeState(reportedState) : null;
  const acs = areaCodeState(phone); // state abbr, 'TF' (toll-free), or null
  if (rs && rs !== regionState) return { ok: false, reason: `reported ${rs}` };
  if (acs && acs !== 'TF' && acs !== regionState) return { ok: false, reason: `area code ${acs}` };
  if (rs === regionState) return { ok: true, reason: 'state match' };
  if (acs === regionState) return { ok: true, reason: 'area code match' };
  return { ok: false, reason: 'unconfirmed' }; // cannot confirm -> do not show
}

// The public sources we mine for a named contact, in rough priority order. A
// small local business rarely has a "Meet the Team" page, but its owner's name
// is published across several of these. Each is searched in PARALLEL so total
// per-brand wall time stays close to a single search.
const _CONTACT_SOURCES = ['registry', 'facebook', 'maps', 'news', 'chamber', 'site'];

// Test seam (see _searchContactSource). Production leaves this null.
let _contactSearchImpl = null;

// Shared JSON contract + rules appended to every source prompt.
const _CONTACT_JSON_TAIL = `Return ONLY this JSON object:
{"contacts":[{"name":"","title":"","email":null,"phone":null,"sourceUrl":"","confidence":"high|medium"}],"businessEmail":null,"businessPhone":null,"city":null,"state":null}
Rules:
- name and title are REQUIRED for every contact. Skip anyone whose real name you cannot find on a real page.
- title MUST match what the source literally says. NEVER upgrade a title. A registered agent is not an owner. A manager is not an owner.
- email ONLY if it is literally published on the page FOR THAT person. NEVER guess or infer an email from a pattern like firstname@domain. Use null otherwise.
- businessEmail: a published email for the BUSINESS itself (not tied to a named person), else null.
- phone / businessPhone: only a real published number, else null.
- sourceUrl is REQUIRED for every contact: the exact page where the name appears.
- confidence "high" from an official government or business-owned page, "medium" from a directory, social page, or news article.
Return {"contacts":[]} if you find no real named person on a real page. NEVER fabricate anyone to fill the list.`;

function _sourceLead(source, brand, loc, domain, regionState) {
  const stateFull = stateName(regionState);
  const where = loc ? ` in ${loc}` : '';
  switch (source) {
    case 'registry':
      return `Search the ${stateFull || 'relevant state'} Secretary of State / business entity registry for the LLC or corporation record of "${brand}"${where}. Try queries like "${brand} ${stateFull || ''} Secretary of State business search" or the state's official business entity search. Extract the officers, members, managers, and the registered agent NAMED in the filing. Label each title EXACTLY as the filing does and add the provenance, e.g. "Registered Agent (state filing)", "Member (state filing)", "Officer (state filing)". Do NOT call a registered agent the owner.`;
    case 'facebook':
      return `Search Facebook for the official page of "${brand}"${where} (query "${brand} ${loc || ''} facebook"). From the page's About / contact section, extract any published email as businessEmail (unless the page names the specific person it belongs to), and any person the page names as owner, manager, or contact, with the title exactly as stated.`;
    case 'maps':
      return `Find the Google Business Profile, Google Maps, or Yelp listing for "${brand}"${where}. Extract the published phone as businessPhone, the city and state of the listing, and any published email or named contact shown. Confirm this is the ${loc || 'correct'} location, not a same-name business elsewhere.`;
    case 'news':
      return `Search local news and press for the owner or founder of "${brand}"${where} (queries "${brand} ${loc || ''} owner", "${brand} founder"). Local articles often write a sentence like "owner Gary Lewis said". Extract the person's name, the title exactly as the article states it plus provenance e.g. "Owner (local news)", and the article URL as sourceUrl.`;
    case 'chamber':
      return `Search the local Chamber of Commerce and reputable local business directories for "${brand}"${where}. Extract any principal contact the listing names, with the stated title, and the directory URL as sourceUrl.`;
    case 'site':
    default:
      return `Search the business's OWN website for "${brand}"${where}${domain ? ` (${domain})` : ''}: its team, about, staff, and contact pages. Extract named people with the titles the site states, and any published email or phone.`;
  }
}

// Ensure an honest provenance label is present for filings and news, matching the
// spec examples ("Registered Agent (state filing)", "Owner (local news)"). Never
// changes the role itself, only appends where the source is known.
function _labelTitle(source, title) {
  const t = _cleanStr(title);
  if (!t) return t;
  if (source === 'registry' && !/filing|registry|secretary of state/i.test(t)) return `${t} (state filing)`;
  if (source === 'news' && !/\(/.test(t)) return `${t} (local news)`;
  return t;
}

// One targeted, single-source web search. Tags every contact with its source and
// resolves emails (published-only). Returns { source, contacts, inbox,
// businessPhone, state, status, ms }.
async function _searchContactSource(source, brand, loc, domain, regionState) {
  const t0 = Date.now();
  const sys = 'You find real, named people and published contact details for a specific local business using web search. Report ONLY facts actually published on a real page. Never invent a name, title, email, or phone. Never guess an email from a pattern. Output ONLY one JSON object.';
  const prompt = `${_sourceLead(source, brand, loc, domain, regionState)}\n${_CONTACT_JSON_TAIL}`;
  let raw = '', status = 'ran';
  // Test seam: _contactSearchImpl lets offline tests feed a per-source raw string
  // without hitting the network. Null in production (uses oneShotWebSearch).
  const searchFn = _contactSearchImpl || oneShotWebSearch;
  try { raw = await withTimeout(searchFn(prompt, sys, 700, 2, 'claude-sonnet-4-6', source), 12000, ''); }
  catch (e) { status = 'error'; }
  if (status === 'ran' && !raw) status = 'timeout';
  const contacts = []; let inbox = null, businessPhone = null, state = null;
  if (raw) {
    let parsed = null;
    try { const tx = raw.replace(/```json/g, '').replace(/```/g, '').trim(); const a = tx.indexOf('{'), b = tx.lastIndexOf('}'); if (a !== -1 && b > a) parsed = JSON.parse(tx.substring(a, b + 1)); } catch (_) {}
    if (parsed) {
      if (Array.isArray(parsed.contacts)) {
        for (const c of parsed.contacts) {
          const name = _cleanStr(c && c.name);
          const title = _labelTitle(source, c && c.title);
          const sourceUrl = _safeUrl(c && c.sourceUrl);
          if (!name || !title || !sourceUrl) continue; // a contact requires name + title + source
          const rawEmail = c && c.email;
          const { email, emailSource } = await resolveEmail(name, domain, rawEmail);
          // A generic email the model attached to a person is not personal; keep it
          // as the business inbox instead of dropping it.
          if (!email && _isGenericInbox(rawEmail) && !inbox) inbox = _validEmail(rawEmail);
          contacts.push({ name, title, email, emailSource, phone: _normalizePhone(c && c.phone), sourceUrl, confidence: (c && c.confidence) === 'high' ? 'high' : 'medium', source });
        }
      }
      // Business-level email: a published address not tied to a named person.
      const be = _validEmail(parsed.businessEmail);
      if (!inbox && be) inbox = be;
      businessPhone = _normalizePhone(parsed.businessPhone);
      state = _cleanStr(parsed.state) || null;
    }
  }
  return { source, contacts, inbox, businessPhone, state, status, ms: Date.now() - t0 };
}

// Merge contacts found across sources. Dedupe by person; when the same person
// appears from several sources keep the STRONGEST honestly-stated title (never an
// upgrade, just the most senior real one) with its own sourceUrl, and fill in a
// missing email or phone from another source that published one for them.
function _mergeNameKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}
function _mergeContacts(all) {
  const byKey = new Map();
  for (const c of all) {
    const key = _mergeNameKey(c.name);
    if (!key) continue;
    const ex = byKey.get(key);
    if (!ex) { byKey.set(key, { ...c }); continue; }
    if (_contactAuthorityRank(c.title) < _contactAuthorityRank(ex.title)) {
      const merged = { ...c };
      merged.email = c.email || ex.email;
      merged.emailSource = merged.email === (c.email) ? c.emailSource : ex.emailSource;
      merged.phone = c.phone || ex.phone;
      byKey.set(key, merged);
    } else {
      ex.email = ex.email || c.email;
      if (!ex.emailSource && c.email) ex.emailSource = c.emailSource;
      ex.phone = ex.phone || c.phone;
    }
  }
  return [...byKey.values()];
}

async function _fetchBrandContacts(brand, website, force = false, locationHint = '') {
  const loc = _cleanStr(locationHint) || '';
  // Franchise contacts are location-specific (Planet Smoothie Marietta is not
  // Planet Smoothie Atlanta), so the cache key includes the region when known.
  const cacheKey = loc ? `${brand} | ${loc}` : brand;
  if (!force) {
    const cached = await store.getBrandEvidence(cacheKey, 'contacts', 30);
    if (cached) {
      const ev = cached.evidence || {};
      return { contacts: ev.contacts || [], genericInbox: ev.genericInbox || null, businessPhone: ev.businessPhone || null, phoneUnconfirmed: !!ev.phoneUnconfirmed, outcome: cached.outcome || 'NONE', cached: true };
    }
  }
  const domain = _domainFromUrl(website);
  const regionState = normalizeState((loc.split(',').pop() || '').trim());

  // Mine every public source in PARALLEL. Each source is capped and timed
  // independently, so total per-brand wall time stays close to one search even
  // though we now consult six places instead of one.
  const results = await Promise.all(
    _CONTACT_SOURCES.map((src) => _searchContactSource(src, brand, loc, domain, regionState))
  );
  for (const r of results) {
    console.log(`[dealScan] contacts brand=${brand} source=${r.source} found=${r.contacts.length} ms=${r.ms}`);
  }
  const bySource = {};
  for (const r of results) bySource[r.source] = r;

  // Merge named contacts across sources, then locality-check every phone.
  let named = _mergeContacts(results.flatMap((r) => r.contacts));
  for (const c of named) {
    if (c.phone && !_phoneLocalityOk(c.phone, null, regionState).ok) c.phone = null;
  }
  // Rank: owner/founder, then officer/member, GM, marketing, registered agent
  // last. Prefer a high-confidence source on ties.
  named.sort((a, b) =>
    (_contactAuthorityRank(a.title) - _contactAuthorityRank(b.title)) ||
    ((a.confidence === 'high' ? 0 : 1) - (b.confidence === 'high' ? 0 : 1))
  );
  named = named.slice(0, 4);

  // Business inbox: first published business-level email from any source.
  let genericInbox = null;
  for (const src of _CONTACT_SOURCES) { if (bySource[src] && bySource[src].inbox) { genericInbox = bySource[src].inbox; break; } }

  // Business phone: gather every published number (maps first, it carries a
  // confirmed city/state), then take the first that passes the locality check.
  const phoneCandidates = [];
  if (bySource.maps && bySource.maps.businessPhone) phoneCandidates.push({ phone: bySource.maps.businessPhone, state: bySource.maps.state });
  for (const r of results) { if (r.businessPhone) phoneCandidates.push({ phone: r.businessPhone, state: r.state || null }); }
  let businessPhone = null, phoneUnconfirmed = false;
  for (const pc of phoneCandidates) {
    const chk = _phoneLocalityOk(pc.phone, pc.state, regionState);
    if (chk.ok) { businessPhone = pc.phone; break; }
  }
  if (!businessPhone && phoneCandidates.length) {
    phoneUnconfirmed = true;
    console.log(`[dealScan] contacts brand=${brand} phone rejected region=${regionState || 'n/a'}`);
  }

  const anyTimeout = results.some((r) => r.status === 'timeout');
  const anyError = results.some((r) => r.status === 'error');

  const evidence = { kind: 'contacts', contacts: named, genericInbox, businessPhone, phoneUnconfirmed };
  // Cache whenever we have a usable affordance OR a definitive empty (all sources
  // ran and found nothing). Never cache a pure transient failure.
  let outcome;
  if (named.length) outcome = 'OK';
  else if (businessPhone || genericInbox) outcome = 'FALLBACK';
  else if (anyTimeout) outcome = 'TIMEOUT';
  else if (anyError) outcome = 'ERROR';
  else outcome = 'NONE';
  const hasAffordance = named.length || businessPhone || genericInbox;
  if (hasAffordance || outcome === 'NONE') {
    await store.saveBrandEvidence(cacheKey, 'contacts', brand, website, evidence, outcome);
  }
  return { contacts: named, genericInbox, businessPhone, phoneUnconfirmed, outcome, cached: false };
}

// Public wrapper used by the lazy per-brand contacts endpoint. Fetches (cache
// first), logs the specced per-brand line, and returns the contacts plus a ready
// "Approach" line and — when there is no person or phone — a Google Maps search
// URL, so a card is NEVER left with zero contact affordance.
async function getBrandContacts(brand, website, locationHint, ctx) {
  if (!brand || !String(brand).trim()) {
    console.log('[dealScan] contacts brand= found=0 named=0 withEmail=0 withPhone=0 source=SKIPPED');
    return { contacts: [], genericInbox: null, businessPhone: null, approach: null, mapsUrl: null };
  }
  const res = await _fetchBrandContacts(brand, website, false, locationHint);
  const withEmail = res.contacts.filter((c) => c.email).length;
  const withPhone = res.contacts.filter((c) => c.phone).length + (res.businessPhone ? 1 : 0);
  const found = res.contacts.length + (res.businessPhone ? 1 : 0) + (res.genericInbox ? 1 : 0);
  const source = res.cached ? 'cache' : res.outcome === 'TIMEOUT' ? 'TIMEOUT' : res.outcome === 'ERROR' ? 'ERROR' : 'web';
  console.log(`[dealScan] contacts brand=${brand} found=${found} named=${res.contacts.length} withEmail=${withEmail} withPhone=${withPhone} source=${source}`);
  const loc = _cleanStr(locationHint) || '';
  const mapsUrl = (!res.contacts.length && !res.businessPhone)
    ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(brand + (loc ? ' ' + loc : ''))
    : null;
  const approach = _contactApproach(ctx || {}, res.contacts[0] || null, res);
  return { contacts: res.contacts, genericInbox: res.genericInbox, businessPhone: res.businessPhone, approach, mapsUrl };
}

// Build the "Approach" line. References the real person, else the honest phone
// fallback, else a guaranteed last-resort maps affordance — so it is never null.
function _contactApproach(card, top, res) {
  if (top) {
    const first = String(top.name).trim().split(/\s+/)[0];
    let base;
    if (top.email) base = `Email ${first} directly`;
    else if (top.phone) base = `Call ${first} at ${top.phone}`;
    else base = `Ask for ${first} by name`;
    if (card.market === 'hometown') base += ', mention the hometown angle';
    else if (card.isFranchise) base += ', ask about the local franchise budget';
    return stripEmDashes(base + '.');
  }
  if (res && res.businessPhone) {
    return `No named contact found. Call ${res.businessPhone} and ask for the owner or marketing manager.`;
  }
  // No person and no confirmed phone: always give a next action.
  if (res && res.phoneUnconfirmed) {
    return 'A phone was found but could not be confirmed as this location, so it is not shown. Search for this business on Google Maps.';
  }
  return 'No contact found. Search for this location on Google Maps.';
}


// Pre-warm the brand-evidence cache for every seed brand so common brands are
// always a cache hit at scan time (the dominant cold-scan cost). Meant to run on
// a schedule, the same pattern as nilCompJob. force=true refreshes even fresh
// rows so a weekly run keeps the cache from ever expiring. Also warms per-brand
// contacts. Rate-limited with a small delay between brands. Returns a tally.
async function prewarmDealEvidence(opts = {}) {
  const { SOCIAL_SEEDS, TOPNIL_SEEDS } = require('./dealScanSeeds');
  const force = opts.force !== false; // default true for scheduled refresh
  const delayMs = opts.delayMs || 800;
  const uniqBrands = (table) => {
    const seen = new Set(); const out = [];
    for (const tier of Object.keys(table)) {
      for (const b of (table[tier] || [])) {
        const k = (b.name || '').toLowerCase().trim();
        if (k && !seen.has(k)) { seen.add(k); out.push(b); }
      }
    }
    return out;
  };
  const tally = { social: { OK: 0, SALVAGED: 0, NO_EVIDENCE: 0, TIMEOUT: 0, ERROR: 0 },
                  topnil: { OK: 0, SALVAGED: 0, NO_EVIDENCE: 0, TIMEOUT: 0, ERROR: 0 } };
  const bump = (lane, outcome) => { if (tally[lane][outcome] !== undefined) tally[lane][outcome]++; };

  const social = uniqBrands(SOCIAL_SEEDS);
  console.log(`[prewarm] social: ${social.length} seed brands (force=${force})`);
  for (const b of social) {
    try {
      const r = await _fetchSocialProgramEvidence(b.name, b.website, force);
      bump('social', r.outcome);
      console.log(`[prewarm] social brand=${b.name} evidence=${r.outcome}`);
    } catch (e) { bump('social', 'ERROR'); console.warn(`[prewarm] social brand=${b.name} error=${e.message}`); }
    await new Promise((res) => setTimeout(res, delayMs));
  }

  const topnil = uniqBrands(TOPNIL_SEEDS);
  console.log(`[prewarm] topnil: ${topnil.length} seed brands (force=${force})`);
  for (const b of topnil) {
    try {
      const r = await _fetchTopNilEvidence(b.name, b.website, null, force);
      bump('topnil', r.outcome);
      console.log(`[prewarm] topnil brand=${b.name} evidence=${r.outcome}`);
    } catch (e) { bump('topnil', 'ERROR'); console.warn(`[prewarm] topnil brand=${b.name} error=${e.message}`); }
    await new Promise((res) => setTimeout(res, delayMs));
  }

  // Warm per-brand contacts too (30-day cache), so a scan does not pay a contact
  // web search for common brands. Dedupe across both seed tables.
  tally.contacts = { OK: 0, FALLBACK: 0, NONE: 0, TIMEOUT: 0, ERROR: 0 };
  const seenC = new Set();
  const allBrands = [...social, ...topnil].filter((b) => {
    const k = (b.name || '').toLowerCase().trim();
    if (!k || seenC.has(k)) return false; seenC.add(k); return true;
  });
  console.log(`[prewarm] contacts: ${allBrands.length} seed brands (force=${force})`);
  for (const b of allBrands) {
    try {
      const r = await _fetchBrandContacts(b.name, b.website, force);
      if (tally.contacts[r.outcome] !== undefined) tally.contacts[r.outcome]++;
      console.log(`[prewarm] contacts brand=${b.name} named=${(r.contacts || []).length} outcome=${r.outcome}`);
    } catch (e) { tally.contacts.ERROR++; console.warn(`[prewarm] contacts brand=${b.name} error=${e.message}`); }
    await new Promise((res) => setTimeout(res, delayMs));
  }

  console.log('[prewarm] done', JSON.stringify(tally));
  return tally;
}

// ─── Deal Scan: SOCIAL + TOP NIL SPENDER lanes ───────────────────────────────
// Two phases: (1) discover real candidate brands via web search (with salvage +
// tag-weighted seed floor), then (2) gather STRUCTURED, sourced evidence per
// brand (an ambassador program for SOCIAL, disclosed-deal precedent for TOP NIL),
// drop hollow brands, and rank evidence-first. Not tied to the athlete's city.
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
  // Interest tags weight the search queries and scoring; region grounds the
  // "did deals with athletes near here" evidence search. Mapped schools resolve
  // instantly; unmapped ones are capped at 6s inside getSchoolLocation.
  const athleteTagSubs = validTagSubs(athlete.tags);
  const _loc = await getSchoolLocation(athlete.school || '');
  const stateCtx = _loc && _loc.known !== false ? _loc.state : '';

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
        // Reworked for what converts for agents of smaller athletes: open or
        // application-based ambassador and micro-influencer programs, plus
        // brands with evidence of NIL deals at mid-major or regional schools.
        // A tagged industry always gets its own search (third query).
        queries: [
          `brands with OPEN or application-based ambassador and micro-influencer programs in ${new Date().getFullYear()} that accept small creators and college athletes around ${reach.toLocaleString()} followers - supplements, apparel, energy drinks, snacks, apps, accessories`,
          `brands with reported NIL deals with college athletes at mid-major${stateCtx ? ` or ${stateCtx}` : ''} schools - everyday athletes, not the biggest stars ${new Date().getFullYear()}`,
          athleteTagSubs.length
            ? `${athleteTagSubs.join(', ')} brands with ambassador, affiliate, or micro-influencer programs open to small creators and student athletes`
            : `${sport} micro-influencer brand ambassador programs supplements apparel accessories open to small creators`,
        ],
        retryQuery: `brands running open application ambassador or affiliate programs for small Instagram and TikTok creators and student athletes`,
        scoreIntro: `These REAL brands were just found via web search. Each carries "evidence" of how they work with small creators or athletes when the search found it.`,
        favor: 'brands with open or application-based ambassador and micro-influencer programs, or reported NIL deals with mid-major and regional athletes',
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
  const mk = (q) => `Use web search: ${q}. Return up to 8 REAL brands you actually find, each as {"name","website","category","email","evidence"}. "evidence": one short line ONLY when the search shows how the brand works with small creators or athletes (an open ambassador or micro-influencer program by name, application link, reported NIL deals with mid-major or regional athletes), else null - never invent evidence. "email" only if shown on their site, else null. Favor: ${laneCfg.favor}. ONLY a JSON array.`;

  // 15s per-search cap: production web-search calls regularly exceeded the old
  // 8s cap and timed out to empty. Searches run in parallel so wall-clock stays
  // ~one search.
  const BRAND_SEARCH_CAP_MS = 15000;
  try {
    console.log(`[dealScan:${lane}] web search brand discovery — model=${MODEL_DEALSCAN} sport=${sport} tier=${tier}${stateCtx ? ` state=${stateCtx}` : ''}${athleteTagSubs.length ? ` tags=${athleteTagSubs.join('/')}` : ''}`);
    const settled = await Promise.allSettled(
      laneCfg.queries.map((q) => withTimeout(oneShotWebSearch(mk(q), searchSys, 700, 2, MODEL_DEALSCAN), BRAND_SEARCH_CAP_MS, ''))
    );

    const found = [];
    const seen = new Set();
    const collect = (raw) => {
      // Salvage-tolerant: truncated arrays still yield their complete objects.
      const { items } = extractJsonArrayItems(raw);
      for (const it of items) {
        const nm = ((it && it.name) || '').trim();
        if (!nm) continue;
        const key = nm.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ name: nm, website: it.website || null, category: it.category || null, email: it.email || null, evidence: it.evidence || null });
      }
    };
    for (const s of settled) if (s.status === 'fulfilled') collect(s.value);
    console.log(`[dealScan:${lane}] phase 1 found ${found.length} candidates in ${Date.now() - _laneT0}ms`);

    if (found.length < 6) {
      try {
        const retry = await withTimeout(oneShotWebSearch(mk(laneCfg.retryQuery), searchSys, 800, 3, MODEL_DEALSCAN), BRAND_SEARCH_CAP_MS, '');
        collect(retry);
      } catch (_) {}
      console.log(`[dealScan:${lane}] after retry: ${found.length} candidates`);
    }
    // Build the investigation POOL: web-discovered brands PLUS the full seed
    // floor for this tier (tag-weighted). Seeds are a FLOOR, not the universe —
    // including them every scan (deduped, exclusions honored) guarantees enough
    // brands that can pass evidence to fill the lane, while discovery adds
    // tag-relevant brands on top. Pre-warmed seeds are cache hits, so this stays
    // fast even though the pool is larger.
    const _excl = (excludeBrands || []).map((b) => (b || '').toLowerCase());
    const pool = [];
    const poolSeen = new Set();
    const addPool = (b, isSeed) => {
      const key = ((b && b.name) || '').toLowerCase().trim();
      if (!key || poolSeen.has(key) || _excl.includes(key)) return;
      poolSeen.add(key);
      pool.push({ name: b.name, website: b.website || null, category: b.category || null, email: b.email || null, evidence: b.evidence || null, _seed: !!isSeed });
    };
    for (const f of found) addPool(f, false);                                   // web-discovered first
    for (const s of (getSeeds(lane, tier, athleteTagSubs) || [])) addPool(s, true); // seed floor
    if (pool.length === 0) return [];

    // Investigate more than we keep, because SOCIAL drops brands without a real
    // program. Return up to 6 for social (the agent wants a usable shortlist),
    // 4 for top NIL.
    const INVESTIGATE = lane === 'social' ? 16 : 12;
    const KEEP = lane === 'social' ? 6 : 4;
    const investigate = pool.slice(0, INVESTIGATE);
    console.log(`[dealScan:${lane}] investigating ${investigate.length} candidates (${investigate.filter((x) => !x._seed).length} web, ${investigate.filter((x) => x._seed).length} seed)`);

    // ── Phase 2: STRUCTURED EVIDENCE ──────────────────────────────────────────
    // Gather real, sourced evidence per candidate (an ambassador program page for
    // SOCIAL, a disclosed-deal record for TOP NIL). Cache-first, so a warm scan
    // does zero web calls; cold scans are concurrency-capped (rate-limit safe).
    // SOCIAL drops any brand with no findable program; TOP NIL keeps no-deal
    // brands but ranks them last and labels them honestly.
    const ctx2 = { rate, valLow, valHigh, sport };
    // Discovery (phase 1) is a web search that is NOT cached; time it separately
    // from the evidence phase so a repeat scan's cost is attributable.
    const _discoveryMs = Date.now() - _laneT0;
    const _effConcurrency = Math.max(1, Math.min(EVIDENCE_CONCURRENCY, investigate.length));
    const _evT0 = Date.now();
    const evResults = await _mapLimit(investigate, EVIDENCE_CONCURRENCY, async (f) => {
      const _bt0 = Date.now();
      const res = lane === 'social'
        ? await _fetchSocialProgramEvidence(f.name, f.website)
        : await _fetchTopNilEvidence(f.name, f.website, sport);
      return { f, ...res, ms: Date.now() - _bt0 };
    });
    const _evidenceMs = Date.now() - _evT0;
    console.log(`[dealScan:${lane}] phases discovery=${_discoveryMs}ms evidence=${_evidenceMs}ms concurrency=${_effConcurrency} candidates=${investigate.length}`);

    const finishCard = (f, card) => {
      // Preserve main's consumers: interest-tag chips + source labeling.
      card.matchedTags = deriveMatchedTags(
        { brand: card.brand, category: card.category, rationale: card.rationale }, f, athleteTagSubs
      );
      card.source = f._seed ? 'seed' : 'web';
      return card;
    };

    const cards = [];
    const _tally = { OK: 0, SALVAGED: 0, NO_EVIDENCE: 0, TIMEOUT: 0, ERROR: 0, cache: 0 };
    for (const r of evResults) {
      if (!r) continue;
      const { f, evidence, outcome, cached, ms } = r;
      if (_tally[outcome] !== undefined) _tally[outcome]++;
      if (cached) _tally.cache++;
      // Per-brand outcome + wall time at the REAL call site, so one production
      // scan tells the truth about whether this code path ran and how slow it is.
      console.log(`[dealScan] ${lane} brand=${f.name} evidence=${outcome} ${ms || 0}ms${cached ? ' cache' : ''}`);
      if (lane === 'social') {
        if (!evidence || evidence.kind !== 'program') continue; // no program -> no hollow card
        const verdict = _socialVerdict(evidence.followerMinimum, athlete);
        cards.push(finishCard(f, _buildSocialCard(f, evidence, verdict, ctx2)));
      } else {
        const verdict = _topnilVerdict(evidence && evidence.min, evidence && evidence.max, athlete);
        cards.push(finishCard(f, _buildTopNilCard(f, evidence || { kind: 'deals', deals: [] }, verdict, outcome, ctx2)));
      }
    }
    console.log(`[dealScan:${lane}] evidence tally ${JSON.stringify(_tally)}`);

    // Evidence-first ranking: fitScore already encodes evidence strength +
    // qualification, so an open program with a matching minimum (or real
    // comp-data precedent) outranks a famous brand with nothing verifiable.
    cards.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
    const out = cards.slice(0, KEEP).map((c, i) => ({ ...c, rank: i + 1 }));
    console.log(`[dealScan:${lane}] returning ${out.length}/${cards.length} evidence-backed in ${Date.now() - _laneT0}ms`);
    return out; // contacts load lazily via /api/agent/brand-contacts (non-blocking)
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

  // Athlete interest tags + product wants (validated against the taxonomy).
  // Computed BEFORE the knowledge prompt so BOTH local paths carry them — the
  // fallback path shipping without tags is exactly how production scans lost
  // matchedTags whenever web search was thin.
  const athleteTagSubs = validTagSubs(athlete.tags);
  const productWants = String(athlete.productWants || '').trim().slice(0, 300);
  const tagContextLine = athleteTagSubs.length
    ? `\nATHLETE INTEREST TAGS: ${describeTags(athlete.tags).join(', ')}. BOOST businesses matching these tags. For each result set "matchedTags" to the matching tag names, chosen ONLY from this exact list: ${athleteTagSubs.join(', ')}. Use [] when none match.`
    : '';
  const wantsContextLine = productWants
    ? `\nProducts they already use and would take as compensation: ${productWants}. Treat businesses fitting these products as strong matches.`
    : '';

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
SOCIAL: ${(athlete.instagram||0).toLocaleString()} IG + ${(athlete.tiktok||0).toLocaleString()} TikTok | Tier: ${tier}${interestLine}${tagContextLine}${wantsContextLine}
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
  "matchedTags": [],
  "contactName": null,
  "contactTitle": "Owner | Marketing Director | Franchise Owner | etc",
  "contactEmail": null,
  "contactLinkedIn": null
}]`;

  // Shared post-processing for both local paths: normalize the new fields,
  // attach the market chip label (only in two-market mode so single-market
  // behavior is unchanged), and never let a bad market value through.
  // matchedTags is derived case-insensitively and grounded in the candidate's
  // own strings; evidence comes ONLY from what the search actually found (the
  // candidate meta), never from model prose, so the knowledge path can never
  // invent marketing-activity claims.
  const finalizeLocal = (d, i, source, site, meta) => {
    let market = d.market === 'hometown' ? 'hometown' : 'school';
    if (!hasHometown) market = 'school';
    const evidence = meta && meta.evidence ? String(meta.evidence).slice(0, 180) : null;
    return {
      ...d,
      rank: i + 1,
      resultType: 'local',
      lane: 'local',
      isLocal: true,
      source,
      market,
      marketLabel: hasHometown ? marketLabelFor(market) : null,
      // Region for the lazy contacts lookup (franchise phone disambiguation).
      region: market === 'hometown' && hometown ? hometown : `${city}, ${state}`,
      isFranchise: d.isFranchise === true,
      matchedTags: deriveMatchedTags(d, meta, athleteTagSubs),
      evidence,
      activelyMarketing: !!evidence,
      website: site || d.website || null,
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
    return parsed.map((d, i) => finalizeLocal(d, i, 'knowledge', d.website || null, null));
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
    const mk = (q, cats) => `Use web search: ${q}. Return up to 6 REAL businesses you actually find, each as {"name","website","category","email","evidence","franchise"}. For EVERY business, actively look for marketing-activity signals: sponsors a high school, youth, or college team; runs local ads or billboards; has done NIL or athlete partnerships before; runs an active promotional social media presence. "evidence": under 12 words describing ONLY what the search actually shows (e.g. "Sponsors Homewood High athletics"), null when nothing found — never invent evidence. "franchise": true only when it is a locally owned or operated franchise location of a national brand and you can point at the specific location or operator, else false. "email" only if shown on their site, else null. Favor: ${cats}. Output ONLY the JSON array, no commentary before it.`;

    // Athlete interest tags: tagged categories lead the search emphasis on a
    // cache miss, at SUB-TAG specificity ("smoothies, supplements, gyms"), and
    // get a scoring boost below. The two school bundles always sweep the FULL
    // taxonomy, so every tagged industry is searched whether the pool is fresh
    // or cached.
    const tagEmphasisQ = athleteTagSubs.length
      ? ` PRIORITIZE businesses in these categories the athlete is tagged for: ${athleteTagSubs.join(', ')}.`
      : '';

    // ── Market-level candidate cache ─────────────────────────────────────────
    // Phase-1 pools are per-market and stable for days, so they are cached in
    // Postgres (TTL 5 days). Live searches run ONLY for cache misses and write
    // through. Phase-2 scoring below always runs fresh per athlete.
    const normMarket = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const schoolCacheKey = `${normMarket(schoolMarket)}:local`;
    const hometownCacheKey = hasHometown ? `${normMarket(hometown)}:local` : null;
    const [schoolCached, hometownCached] = await Promise.all([
      store.getMarketCache(schoolCacheKey),
      hometownCacheKey ? store.getMarketCache(hometownCacheKey) : Promise.resolve(null),
    ]);
    // A thin cached pool (from a partially successful search day) is used AND
    // topped up with a live search, then rewritten, so partial pools speed up
    // the next scan without freezing a bad day for the whole TTL.
    const schoolThin = !!(schoolCached && schoolCached.candidates.length < 5);
    const hometownThin = !!(hometownCached && hometownCached.candidates.length < 2);
    const _ageH = (cc) => Math.round((Date.now() - new Date(cc.fetchedAt).getTime()) / 3600000);
    console.log(
      `[dealScan] market cache ${schoolCached ? `HIT ${schoolCacheKey} (${schoolCached.candidates.length} candidates, age ${_ageH(schoolCached)}h${schoolThin ? ', thin - topping up' : ''})` : `MISS ${schoolCacheKey}`}` +
      (hometownCacheKey ? ` | ${hometownCached ? `HIT ${hometownCacheKey} (${hometownCached.candidates.length} candidates, age ${_ageH(hometownCached)}h${hometownThin ? ', thin - topping up' : ''})` : `MISS ${hometownCacheKey}`}` : '')
    );

    const found = [];
    const seen = new Set();
    const addCandidate = (it, market) => {
      const nm = ((it && it.name) || '').trim();
      if (!nm) return;
      const key = nm.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      found.push({
        name: nm, website: it.website || null, category: it.category || null,
        email: it.email || null, evidence: it.evidence || null,
        franchise: it.franchise === true, market,
      });
    };
    // Serve cached markets straight into the pool (market re-tagged from the
    // cache bucket, never trusted from the stored blob).
    if (schoolCached) for (const cnd of schoolCached.candidates) addCandidate(cnd, 'school');
    if (hometownCached) for (const cnd of hometownCached.candidates) addCandidate(cnd, 'hometown');

    // Live searches for cache misses (and thin cached pools, topped up).
    // The old two big category bundles asked one call for 8 businesses x 6
    // fields; the JSON regularly blew past max_tokens and truncated, which
    // parsed as empty — so EVERY production scan "found 0" and fell to the
    // knowledge path. Now: smaller single-purpose searches that finish
    // reliably, a 30s cap (parallel, so wall-clock stays about one search),
    // per-call outcome logging, and truncation salvage in the parser.
    const LOCAL_SEARCH_CAP_MS = 30000;
    const searchDefs = [];
    if (!schoolCached || schoolThin) {
      searchDefs.push(
        { label: 'school-auto-gym', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `car dealerships, gyms and training facilities in ${city}, ${state} that sponsor local sports teams or run local ads${tagEmphasisQ}`,
          `${catHint}, car dealerships, gyms and training facilities`), searchSys, 900, 2, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'school-food-nutrition', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `restaurants, food spots, smoothie and supplement shops in ${city}, ${state} that sponsor school sports or advertise locally${tagEmphasisQ}`,
          'restaurants and food spots, smoothie and supplement shops'), searchSys, 900, 2, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'school-services', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `chiropractors, physical therapy, boutiques, real estate agents, banks, credit unions, med spas in ${city}, ${state} that advertise locally or sponsor high school and youth sports`,
          'chiropractors and physical therapy, boutiques and local retail, real estate agents, banks and credit unions, med spas and salons'), searchSys, 900, 2, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
      );
    }
    if (hasHometown && (!hometownCached || hometownThin)) {
      searchDefs.push(
        { label: 'hometown-core', market: 'hometown', p: timedSearch(oneShotWebSearch(mk(
          `car dealerships, gyms, restaurants, smoothie and supplement shops in ${hometown} that sponsor local youth sports or spend on local marketing${tagEmphasisQ}`,
          `${catHint}, car dealerships, restaurants, smoothie and supplement shops in ${hometown}`), searchSys, 900, 2, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'hometown-services', market: 'hometown', p: timedSearch(oneShotWebSearch(mk(
          `chiropractors, boutiques, real estate agents, banks, med spas in ${hometown} that advertise locally or sponsor youth sports`,
          'chiropractors, boutiques and local retail, real estate agents, banks, med spas'), searchSys, 900, 2, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
      );
    }

    if (searchDefs.length) {
      const _tSearch = Date.now();
      const outcomes = await Promise.all(searchDefs.map((s) => s.p));
      outcomes.forEach((o, idx) => {
        const def = searchDefs[idx];
        let detail = '';
        if (o.status === 'ok') {
          const before = found.length;
          const { items, salvaged } = extractJsonArrayItems(o.raw);
          for (const it of items) addCandidate(it, def.market);
          detail = items.length
            ? ` — ${items.length} parsed${salvaged ? ' (SALVAGED from truncated output)' : ''}, ${found.length - before} new`
            : ` — parsed-but-empty (raw ${o.raw.length} chars)`;
        } else if (o.status === 'error') {
          detail = ` — ${o.err}`;
        }
        console.log(`[dealScan] search ${def.label}: ${o.status.toUpperCase()} in ${o.ms}ms${detail}`);
      });
      console.log(`[dealScan] phase 1 live search found ${found.length} candidates total (${found.filter(f => f.market === 'hometown').length} hometown) in ${Date.now() - _tSearch}ms (elapsed ${Date.now() - _t0}ms)`);

      // One broadened retry before falling back.
      if (found.length < 3) {
        console.warn(`[dealScan] only ${found.length} candidates — running one broadened retry search`);
        const retryOut = await timedSearch(oneShotWebSearch(
          mk(`popular local businesses, restaurants, gyms, car dealerships and shops in ${city}, ${state}`, 'any local business that advertises locally'),
          searchSys, 900, 3, MODEL_DEALSCAN
        ), LOCAL_SEARCH_CAP_MS);
        if (retryOut.status === 'ok') {
          const { items } = extractJsonArrayItems(retryOut.raw);
          for (const it of items) addCandidate(it, 'school');
        }
        console.log(`[dealScan] retry: ${retryOut.status.toUpperCase()} in ${retryOut.ms}ms — now ${found.length} candidate businesses`);
      }

      // Write through to the market cache whenever ANY candidates exist for a
      // searched market. Partial pools are fine (a partially successful day
      // still speeds up the next scan); empty pools are never cached. Thin
      // cached pools that were topped up get rewritten with the merged pool.
      // setMarketCache logs WRITE ok / WRITE FAILED loudly.
      if (!schoolCached || schoolThin) {
        const poolSchool = found.filter((f) => f.market === 'school');
        if (poolSchool.length >= 1) store.setMarketCache(schoolCacheKey, poolSchool);
        else console.warn(`[dealScan] market cache write SKIPPED ${schoolCacheKey}: 0 school candidates`);
      }
      if (hometownCacheKey && (!hometownCached || hometownThin)) {
        const poolHome = found.filter((f) => f.market === 'hometown');
        if (poolHome.length >= 1) store.setMarketCache(hometownCacheKey, poolHome);
        else console.warn(`[dealScan] market cache write SKIPPED ${hometownCacheKey}: 0 hometown candidates`);
      }
    } else {
      console.log(`[dealScan] phase 1 served entirely from market cache: ${found.length} candidates (${found.filter(f => f.market === 'hometown').length} hometown) in ${Date.now() - _t0}ms`);
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
    // Map business name -> full candidate (email validation, market/franchise
    // repair, and evidence pass-through in finalize).
    const metaByName = new Map();
    for (const f of found) if (f.name) metaByName.set(f.name.toLowerCase().trim(), f);

    // Cap the candidates SENT to scoring at 14 (thin-cache top-ups can merge
    // pools past 20, and scoring 24 candidates blew the output token budget:
    // the truncated JSON crashed phase 2 and used to discard phase 1 entirely).
    // Priority keeps the guarantees intact: tag matches first, then marketing
    // evidence, then hometown reserve, then the rest.
    const _candPriority = (f) => {
      const tagHits = deriveMatchedTags({ brand: f.name, category: f.category }, f, athleteTagSubs).length;
      return (tagHits ? 4 + tagHits : 0) + (f.evidence ? 2 : 0) + (f.market === 'hometown' ? 3 : 0);
    };
    const scoreCandidates = [...found].sort((a, b) => _candPriority(b) - _candPriority(a)).slice(0, 14);
    const compactOf = (list) => JSON.stringify(list.map((f) => {
      const o = { name: f.name, market: f.market };
      if (f.website) o.website = f.website;
      if (f.category) o.category = f.category;
      if (f.email) o.email = f.email;
      if (f.evidence) o.evidence = f.evidence;
      if (f.franchise) o.franchise = true;
      return o;
    }));
    const tagScoringLine = athleteTagSubs.length
      ? `\nATHLETE INTEREST TAGS: ${describeTags(athlete.tags).join(', ')}. BOOST candidates matching these tags. For each result set "matchedTags" to the matching tag names, chosen ONLY from this exact list: ${athleteTagSubs.join(', ')}. Use [] when none match.`
      : '';
    const wantsLine = productWants
      ? `\nProducts they already use and would take as compensation: ${productWants}. Treat businesses fitting these products as strong matches.`
      : '';
    const buildScorePrompt = (candList) => `Athlete: ${athlete.name}, ${sport}${athlete.position ? ` (${athlete.position})` : ''} at ${school}, ${city}, ${state}${hasHometown ? `, hometown ${hometown}` : ''}. ${(athlete.instagram||0).toLocaleString()} IG + ${(athlete.tiktok||0).toLocaleString()} TikTok (${tier} tier, realistic local deal ~$${valLow}-$${valHigh}).${exclusionLine}${tagScoringLine}${wantsLine}

These REAL local businesses were just found via web search (with any local-marketing evidence the search surfaced):
${compactOf(candList)}

${marketScoringLine}

${FRANCHISE_RULE}

Pick the best ${wantCount} for this athlete (fewer only if fewer are genuinely good — never pad) and score each 1-100. ${WHY_YES_RULE} Candidates with real marketing-activity "evidence" (team sponsorships, local ads, prior NIL or athlete partnerships, active promo social) get a STRONG ranking boost: they are proven local marketers, so the outreach makes sense. Rationale is 1-2 tight sentences MAXIMUM. Compact JSON only: no prose fields beyond the template, no commentary before or after the array. When a candidate has "evidence", CITE it in the rationale (e.g. "already sponsors a local little league team, so athlete deals are a natural next step"). Never invent evidence that is not in the input. For contactEmail: use the email given if present, otherwise info@/owner@/contact@ at the REAL website domain provided — never invent a fake domain; use null if no domain is known. Output ONLY this JSON array sorted by fitScore descending:
[{"rank":1,"brand":"","tier":"local","category":"auto|gym|food|restaurant|nutrition|apparel|finance|insurance|realestate|training|chiro|medspa|local","dealType":"post|reel|ambassador|appearance","campaign":"","rationale":"","estimatedValueLow":${valLow},"estimatedValueHigh":${valHigh},"contactApproach":"","timingNote":"","fitScore":88,"isLocal":true,"market":"school|hometown","isFranchise":false,"matchedTags":[],"contactName":null,"contactTitle":"","contactEmail":"","contactLinkedIn":null}]`;

    // ── Phase 2 scoring: NARROW error boundary with layered recovery ──────────
    // A scoring failure must never discard phase 1's good candidates. Recovery
    // ladder: tolerant salvage of truncated output -> one retry with a reduced
    // candidate set -> deterministic assembly straight from the candidates.
    // The knowledge path is reserved for phase 1 itself producing nothing.
    const scoreSys = 'You are a JSON-only NIL deal API. Output ONLY a valid JSON array. Never fabricate a business, evidence, or an email domain — only use the businesses, evidence, and domains provided.';
    const runScore = async (candList) => {
      const raw = await oneShot(buildScorePrompt(candList), scoreSys, 3500, MODEL_FAST);
      const { items, salvaged } = extractJsonArrayItems(raw);
      return { items: items.filter((x) => x && x.brand), salvaged, rawLen: String(raw || '').length };
    };
    const _tScore = Date.now();
    let parsed = [];
    let scoringOutcome = '';
    try {
      const r1 = await runScore(scoreCandidates);
      if (r1.items.length >= Math.min(4, wantCount)) {
        parsed = r1.items;
        scoringOutcome = r1.salvaged ? `SALVAGED (raw ${r1.rawLen} chars)` : 'OK';
      } else {
        console.warn(`[dealScan] scoring thin: ${r1.items.length} item(s) from raw ${r1.rawLen} chars — retrying once with reduced candidate set`);
        const r2 = await runScore(scoreCandidates.slice(0, 8));
        const best = r2.items.length >= r1.items.length ? r2 : r1;
        if (best.items.length) {
          parsed = best.items;
          scoringOutcome = `RETRIED (${best.items.length} items, raw ${best.rawLen} chars)`;
        }
      }
    } catch (scoreErr) {
      console.warn(`[dealScan] scoring call failed: ${scoreErr.message}`);
    }
    if (!parsed.length) {
      // FINAL FALLBACK: deterministic assembly from the real phase-1 candidates.
      // Ranked by tag matches, then evidence, then category-sport fit; template
      // rationales use only the candidate's own fields. No model, no invention.
      scoringOutcome = 'FELL-BACK to deterministic assembly';
      const _sportFit = (f) => (f.category && catHint.toLowerCase().includes(String(f.category).toLowerCase()) ? 1 : 0);
      const ranked = [...found].sort((a, b) => (_candPriority(b) + _sportFit(b)) - (_candPriority(a) + _sportFit(a)));
      const homePicks = ranked.filter((f) => f.market === 'hometown').slice(0, Math.max(reserveHometown, hasHometown ? 2 : 0));
      const schoolPicks = ranked.filter((f) => f.market !== 'hometown').slice(0, Math.max(3, wantCount - homePicks.length));
      parsed = schoolPicks.concat(homePicks).map((f, i) => ({
        brand: f.name, tier: 'local', category: f.category || 'local', dealType: 'post',
        campaign: `Local partnership with ${f.name} for ${athlete.name}`,
        rationale: (f.evidence ? `${f.evidence}. ` : '') + (f.market === 'hometown'
          ? `${athlete.name} grew up in ${hometownCity}, and a hometown athlete is an easy yes for a business marketing to the community that knows them.`
          : `Local ${f.category || 'business'} in the ${city} market with natural customer overlap for a ${sport} athlete at ${school}.`),
        estimatedValueLow: valLow, estimatedValueHigh: valHigh,
        contactApproach: 'Reach out to the owner or manager directly.',
        timingNote: '', fitScore: 84 - i * 3, isLocal: true, market: f.market,
        isFranchise: f.franchise === true, matchedTags: [],
        contactName: null, contactTitle: 'Owner', contactEmail: f.email || null, contactLinkedIn: null,
        website: f.website || null,
      }));
    }
    console.log(`[dealScan] scoring ${scoringOutcome} in ${Date.now() - _tScore}ms (${parsed.length} results from ${scoreCandidates.length} candidates sent)`);
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
    const localCards = parsed.map((d, i) => {
      const meta = metaByName.get((d.brand || '').toLowerCase().trim()) || null;
      return finalizeLocal(d, i, 'web', meta ? meta.website : (d.website || null), meta);
    });
    return localCards; // contacts load lazily via /api/agent/brand-contacts (non-blocking)
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
      matchedTags: deriveMatchedTags({ brand: b, category: i===0?'equipment':i===1?'nutrition':'apparel' }, null, athleteTagSubs),
      evidence: null, activelyMarketing: false,
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
  generateOutreach,
  deriveMatchedTags,
  validTagSubs,
  prewarmDealEvidence,
  getBrandContacts,
  // Internal evidence helpers exposed for unit tests only.
  _test: {
    _fmtFollowers, _cleanStr, _safeUrl, _primaryFollowers,
    _socialVerdict, _topnilVerdict, _deriveTypicalProfile,
    _buildSocialCard, _buildTopNilCard,
    _isGenericInbox, _validEmail, _normalizePhone, _contactAuthorityRank,
    resolveEmail, _fetchBrandContacts, _contactApproach, getBrandContacts, _phoneLocalityOk,
    _labelTitle, _mergeContacts, _mergeNameKey, _sourceLead, _CONTACT_SOURCES,
    _searchContactSource,
    _setContactSearchImpl: (fn) => { _contactSearchImpl = fn; },
  },
};
