// server/ai.js — NILDash AI Engine v4
// v4: improved system prompt with v4 scores, AI marketing tools, improved team match context

const Anthropic = require('@anthropic-ai/sdk');
const { MARKET_RATES, DEAL_COMPS, BRAND_WINDOWS, nilViewVal } = require('./benchmarks');
const store = require('./store');
const { getSeeds } = require('./dealScanSeeds');
const { normalizeState, areaCodeState, stateName } = require('./areaCodes');
const { canonicalRegion } = require('./services/regionKey');
const scanMeter = require('./scanMeter');
const { lookupPlace } = require('./services/placesLookup');
const { buildMarketPoolFromPlaces } = require('./services/placesMarket');
const { isNoLocalAuthority, businessTier } = require('./services/dealScanRanking');

// Cost guard: build a given market from Places at most once per 24h (a full build
// is ~30 types x up to 3 pages of paid calls). In-memory; resets on restart, which
// is acceptable since the market cache persists the built pool for days.
const _placesBuildHits = new Map(); // marketKey -> last build ts (ms)
function _placesBuildAllowed(marketKey) {
  return (Date.now() - (_placesBuildHits.get(marketKey) || 0)) > 86400e3;
}
function _placesBuildRecord(marketKey) { _placesBuildHits.set(marketKey, Date.now()); }

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
    // The SDK default request timeout is TEN MINUTES, and with retries a single
    // hung call can block a caller for far longer. That is what stalled the
    // 135-school program map run: a search fallback with no cap of its own
    // inherited the default and never returned.
    //
    // Left at the SDK default here so long generations (contracts, legal analysis)
    // keep working exactly as they do today, but exposed as an env var so it can be
    // lowered globally without a deploy. Callers that must stay responsive should
    // use withTimeout below rather than relying on this.
    client = new Anthropic({
      apiKey: key,
      timeout: Number(process.env.ANTHROPIC_TIMEOUT_MS) || 600000,
    });
  }
  return client;
}

// TWO CAPS, TWO NAMES, AND THE REASON THEY ARE NOT ONE NAME.
//
// These were both called withTimeout. Function declarations hoist and the LAST one
// wins, so the soft version below silently shadowed the hard one for every caller,
// including the ones written specifically to rely on the rejection. A call written
// as withTimeout(p, ms, 'fetch for Alabama') was not being given a LABEL; it was
// being given a FALLBACK VALUE, so on any error or timeout it resolved to the
// string "fetch for Alabama" instead of throwing. Callers then read .url off a
// string, got undefined, and reported the wrong reason. The bug is invisible at the
// call site, which is exactly why the two behaviours now have different names.
//
// withDeadline  REJECTS. Use it when a stall must be reported and the item skipped.
// withTimeout   RESOLVES to a fallback. Use it when a miss is fine and has a default.

// Hard wall-clock cap. The rejection is what lets a caller log the stall, mark the
// item, and move on: a job that processes 135 things must never be stoppable by one
// of them.
//
// NOTE what this does NOT do: the underlying request keeps running and its result
// is discarded. That is the right trade for a batch job (bounded wall clock beats
// a tidy cancellation) but it means a capped call still costs money.
function withDeadline(promise, ms, label) {
  let timer = null;
  const capped = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label || 'operation'}`)), ms);
  });
  return Promise.race([promise, capped]).finally(() => { if (timer) clearTimeout(timer); });
}

// Soft cap. Swallows the error and resolves to fallbackValue, so a caller with a
// sensible default does not need a try/catch. Two callers in this file pass '' and
// depend on exactly this, which is why it stays.
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

// Model split by task type, cheapest tier that fits the job:
//  - EXTRACTION + web-search discovery (deal scan business/brand search, contact
//    and evidence extraction, geocoding, quick enrichment): Haiku 4.5, the cheapest
//    tier ($1/$5 per MTok). Haiku 4.5 supports the web_search_20250305 tool used here.
//  - FIT SCORING (the reasoning step that ranks the extracted pool by fit and writes
//    rationales): the stronger Sonnet tier, where scoring quality matters.
//  - QUALITY WRITING (pitch emails, brand kit, outreach, AI command): Opus.
const MODEL_FAST  = 'claude-haiku-4-5-20251001';
// Default tier for any call that does not name a model. This used to be
// MODEL_STANDARD (Opus), which meant roughly 25 call sites were silently running
// on the most expensive model available, including several that never needed it.
// Sonnet was already in explicit use elsewhere in this codebase, so it is a
// proven quality level here. Opus is now opt-in: pass MODEL_STANDARD to get it.
const MODEL_BALANCED = 'claude-sonnet-4-6';
const MODEL_SCORE = 'claude-haiku-4-5-20251001'; // scoring moved to Haiku for speed; was sonnet-4-6
const MODEL_STANDARD = 'claude-opus-4-8';
// Copy generation tier. Standing policy: Opus is reserved for contract generation
// and legal analysis. Nothing in Deal Scan qualifies, so outreach emails, deal
// pitches and brand kits run on Sonnet, which is far faster and much cheaper for
// short structured copy. Each call logs its model and elapsed ms.
const MODEL_GEN = MODEL_BALANCED;

// ── Feature flags ─────────────────────────────────────────────────────────────
// Set to false to revert to legacy email generation prompts
const FEATURE_EMAIL_V2 = true;

async function oneShot(prompt, system, maxTokens, model) {
  const ai = getClient();
  scanMeter.bumpAi(); // count this billable AI call against the current scan
  const delays = [2000, 5000, 10000];
  const useModel = model || MODEL_BALANCED;
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
      // If fast model fails, step up one tier — not straight to the most
      // expensive one. A missing Haiku should not silently bill at Opus rates.
      if (model === MODEL_FAST && attempt === 0 && err?.status === 404) {
        console.warn('[oneShot] Fast model unavailable, falling back to balanced');
        return oneShot(prompt, system, maxTokens, MODEL_BALANCED);
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

// ── Bounded tool loop ────────────────────────────────────────────────────────
// One conversational turn that may call CLIENT-SIDE tools (ours, not Anthropic's).
// Used by the assistant; nothing else calls this yet.
//
// BOUNDED THREE WAYS, because a tool loop is the one shape here that can run away:
//   maxRounds   how many times the model may call tools before it must answer
//   timeoutMs   wall clock over the whole turn, not per request
//   the caller's resolver decides what a tool call MEANS. This function never
//   executes anything: it hands the call out and puts the answer back.
//
// runTool(name, input) -> { result, stop }. `stop` ends the loop immediately, which
// is how a refusal or a confirmation prompt returns without a second round trip.
async function toolLoop({ system, messages, tools, model, maxTokens, maxRounds, timeoutMs, runTool }) {
  const client = getClient();
  const useModel = model || MODEL_BALANCED;
  const rounds = Number.isFinite(maxRounds) ? maxRounds : 4;
  const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 45000);
  const convo = messages.slice();
  const calls = [];
  let text = '';

  for (let i = 0; i < rounds; i++) {
    if (Date.now() > deadline) {
      console.warn('[toolLoop] out of time after', i, 'round(s)');
      break;
    }
    scanMeter.bumpAi();
    const msg = await withDeadline(
      client.messages.create({
        model: useModel,
        max_tokens: maxTokens || 1200,
        system,
        messages: convo,
        ...(tools && tools.length ? { tools } : {}),
      }),
      Math.max(5000, deadline - Date.now()), 'assistant turn');

    const blocks = Array.isArray(msg.content) ? msg.content : [];
    text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
    const toolUses = blocks.filter((b) => b && b.type === 'tool_use');
    if (!toolUses.length) return { text: stripEmDashes(text), calls, stopped: false };

    convo.push({ role: 'assistant', content: blocks });
    const results = [];
    let stopNow = false;
    for (const u of toolUses) {
      const out = await runTool(u.name, u.input || {});
      calls.push({ name: u.name, input: u.input || {}, out });
      results.push({
        type: 'tool_result',
        tool_use_id: u.id,
        content: typeof out.result === 'string' ? out.result : JSON.stringify(out.result || {}),
        ...(out.isError ? { is_error: true } : {}),
      });
      if (out.stop) stopNow = true;
    }
    convo.push({ role: 'user', content: results });
    // A confirmation or a refusal is the end of the turn: there is nothing useful
    // for the model to add, and letting it keep going invites it to try again by
    // another route.
    if (stopNow) return { text: stripEmDashes(text), calls, stopped: true };
  }
  return { text: stripEmDashes(text), calls, stopped: false, exhausted: true };
}

// Web-search-enabled one-shot. Uses Anthropic's server-side web_search tool so
// brand discovery returns REAL, verifiable local businesses. Falls back to the
// caller's error handling on timeout/failure.
async function oneShotWebSearch(prompt, system, maxTokens, maxSearches, model) {
  const ai = getClient();
  scanMeter.bumpWeb(); // count this billable web-search call against the current scan
  const msg = await ai.messages.create({
    model: model || MODEL_BALANCED,
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
  'Kennesaw State University': { city: 'Kennesaw', state: 'Georgia' },
  'Georgia State University': { city: 'Atlanta', state: 'Georgia' },
  'Mercer University': { city: 'Macon', state: 'Georgia' },
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

// Market-key slug (lowercase, non-alnum -> '-'). Single source of truth so the
// scan and any tooling (e.g. admin rebuild) derive identical cache keys.
function _normMarket(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Resolve a SCHOOL NAME to the exact local market cache key the scan uses:
// getSchoolLocation(school) -> "City, State" -> _normMarket -> "<slug>:local".
// This is the same path getDealRecommendations takes, so keys never diverge.
async function resolveLocalMarketKey(school) {
  const loc = await getSchoolLocation(school);
  return `${_normMarket(`${loc.city}, ${loc.state}`)}:local`;
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
      raw = await withTimeout(oneShotWebSearch(prompt, sys, 700, 3, MODEL_FAST), 9000, '');
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
    : _nationalContext(f.category);

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

// Honest one-line context for a national brand, by category. Never claims a
// disclosed deal we do not have; describes what the brand is and that it works
// with athletes at scale, so the card is useful context, not an apology.
function _nationalContext(category) {
  const map = {
    supplements: 'National supplement brand that runs athlete ambassador and affiliate programs.',
    nutrition: 'National nutrition brand that partners with college athletes.',
    apparel: 'National apparel brand that works with college athletes at scale.',
    energydrink: 'National energy drink brand active in college athlete marketing.',
    accessories: 'National consumer brand with athlete ambassador programs.',
    beauty: 'National beauty brand that partners with creators and athletes.',
    tech: 'National tech brand that runs creator and athlete campaigns.',
    app: 'National app that partners with student athletes and creators.',
    finance: 'National brand that runs college athlete NIL programs.',
    food: 'National food brand that works with college athletes.',
    retail: 'National retail brand with athlete partnership programs.',
  };
  return map[String(category || '').toLowerCase()] || 'National brand that works with college athletes at scale.';
}

// A "National Brands to Know" card: general context plus any disclosed-deal data
// we actually have. NEVER carries "no disclosed deals found" text. Contacts load
// lazily like every other lane, so the card surfaces the named people we do find.
function _buildNationalBrandCard(f, ctx, athlete, tagSubs, deals) {
  const { rate, valLow, valHigh } = ctx;
  const has = Array.isArray(deals) && deals.length > 0;
  const tp = has ? _deriveTypicalProfile(deals) : null;
  const matchedTags = deriveMatchedTags({ brand: f.name, category: f.category }, f, tagSubs || []);
  let score = 62 + Math.min(matchedTags.length, 3) * 6; // 62..80 by tag alignment
  if (has) score = Math.max(score, 78);                  // real disclosed deals rank stronger
  score = Math.max(55, Math.min(88, Math.round(score)));
  const rationale = has
    ? stripEmDashes(((tp && tp.typicalProfile) || `${deals.length} disclosed deal${deals.length > 1 ? 's' : ''} with athletes on record`).replace(/\.+$/, '') + '.')
    : _nationalContext(f.category);
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
    source: f._seed ? 'seed' : 'comp',
    evidence: has ? { kind: 'deals', deals, typicalProfile: tp && tp.typicalProfile, profileSource: 'comp' } : null,
    disclosedDeals: has ? deals : [],
    typicalProfile: has ? (tp && tp.typicalProfile) : null,
    activelyMarketing: true,
    website: f.website || null,
    contactEmail: validateContactEmail(f.email, f.website || null),
    contactName: null,
    contactTitle: 'NIL / Partnerships Team',
    contactLinkedIn: null,
    region: null,
    market: null,
    matchedTags,
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
// A mailbox is GENERIC only if its local part is on this list. Anything else is a
// possible person: "mccall@..." is a surname, not an inbox, and was being buried as
// "general inbox, not a named person". Keep this list tight. Every entry is a role
// or system mailbox, and none is a plausible surname, so a real person's mailbox can
// never be swallowed by it.
const _GENERIC_LOCALPARTS = new Set([
  // The core set: plain role mailboxes.
  'info', 'hello', 'contact', 'admin', 'sales', 'support', 'orders', 'booking',
  'events', 'team', 'office', 'mail', 'hi', 'ask',
  // Other unambiguous role/system mailboxes. Retained deliberately: dropping these
  // would classify noreply@ or customerservice@ as "a possible person".
  'marketing', 'press', 'media', 'partnerships', 'partner', 'pr', 'careers',
  'jobs', 'help', 'general', 'inquiries', 'enquiries', 'service',
  'customerservice', 'ambassador', 'ambassadors', 'affiliate', 'affiliates',
  'noreply', 'no-reply', 'donotreply', 'reservations', 'wholesale', 'billing',
  'accounts', 'accounting', 'hr', 'webmaster', 'postmaster', 'newsletter',
]);

// Does an email local part look like it belongs to this person? Handles the common
// mailbox shapes: last, first, first.last, firstlast, flast, firstl.
function _localPartMatchesName(localPart, fullName) {
  const lp = String(localPart || '').toLowerCase().replace(/[^a-z]/g, '');
  const parts = String(fullName || '').toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, '')).filter(Boolean);
  if (!lp || lp.length < 3 || parts.length === 0) return false;
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const cands = [first];
  if (last) {
    cands.push(last, first + last, last + first, first[0] + last, first + last[0]);
  }
  return cands.some((c) => c && c.length >= 3 && c === lp);
}

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

// Detect a school named in generated prose that is NOT the athlete's school. Uses
// the SCHOOL_LOCATIONS keys (the schools the model actually knows) plus their common
// short forms, so "UConn campus" on a Samford athlete's card is caught. Returns the
// offending name, or null when the prose is clean. Deliberately conservative: a
// mention of the athlete's OWN school, or of no school at all, returns null.
function _foreignSchoolIn(text, athleteSchool) {
  const t = String(text || '');
  if (!t) return null;
  const own = String(athleteSchool || '').toLowerCase();
  // Short form of the athlete's school ("Samford University" -> "samford") so the
  // model's shorthand for the CORRECT school is never flagged.
  const ownShort = own.replace(/\b(university|college|state|of|the|at)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  // Alias guard: the map holds several names for one school ("Georgia Institute of
  // Technology" and "Georgia Tech"). Any key resolving to the SAME city/state is the
  // athlete's own school under another name, so it must never be flagged.
  const ownLoc = lookupSchoolLocation(String(athleteSchool || ''));
  for (const key of Object.keys(SCHOOL_LOCATIONS)) {
    const k = key.toLowerCase();
    if (own && (own.includes(k) || k.includes(own))) continue; // this IS the athlete's school
    if (ownLoc) {
      const kl = SCHOOL_LOCATIONS[key];
      if (kl && kl.city === ownLoc.city && kl.state === ownLoc.state) continue; // same school, alias
    }
    // Conservative token overlap: "Georgia Tech" and "Georgia Institute of
    // Technology" share "georgia", so treat them as possibly the same school and do
    // NOT flag. A false negative here just leaves a rationale alone; a false positive
    // would rewrite a correct one. Bias to leaving correct output untouched.
    const _tok = (x) => new Set(String(x).toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !['university', 'college', 'state', 'institute', 'technology', 'school'].includes(w)));
    const ownTok = _tok(athleteSchool);
    let shares = false;
    for (const w of _tok(key)) if (ownTok.has(w)) { shares = true; break; }
    if (shares) continue;
    const kShort = k.replace(/\b(university|college|state|of|the|at)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!kShort || kShort.length < 4) continue;
    if (ownShort && (kShort.includes(ownShort) || ownShort.includes(kShort))) continue;
    const re = new RegExp('\\b' + kShort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\b', 'i');
    if (re.test(t)) return key;
  }
  return null;
}

// Tier 1 of the contact ladder: an owner or a marketing decision maker, i.e. someone
// who can actually approve a local NIL deal. Ranks 0 (owner/founder/CEO), 1 (franchise
// owner), 2 (officer/LLC member/partner/director), 4 (marketing leadership/CMO) and
// 5 (marketing or partnerships manager). Rank 3 (GM) and 6 (manager) are Tier 2: they
// run the store but rarely control the marketing spend. Shared by the manual-add early
// exit here and by services/contactLadder.js, so the tiering is defined exactly once.
const _TIER1_RANKS = [0, 1, 2, 4, 5];

// Resolve a contact's email. TODAY: return ONLY an email literally published for
// this person (and never a generic inbox). A paid domain-lookup provider was wired
// in here once and has been removed: what it returned was an address for the
// COMPANY, and pinning that to a person made an unverified name read as verified.
// Anything dropped in here later must verify the address belongs to THAT person.
// NEVER guess an email from a pattern like firstname@domain, not even as a guess.
async function resolveEmail(name, domain, publishedEmail) {
  const em = _validEmail(publishedEmail);
  if (em && !_isGenericInbox(em)) return { email: em, emailSource: 'published' };
  // No fallback, deliberately. A paid lookup lived here and was removed: what it
  // returned was an address for the DOMAIN, and attaching it to a person made an
  // unverified name look verified. Published for that person, or nothing.
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
const _CONTACT_SOURCES = ['registry', 'facebook', 'maps', 'news', 'chamber', 'site', 'linkedin'];

// Source order for the DEEP contact ladder, tuned from production hit rates. Wave 1
// is the first 3, wave 2 the next 3, and so on (CONTACT_WAVE_SIZE).
//   wave 1: site, facebook, chamber   - the three that actually produce Tier 1 hits
//   wave 2: linkedin, maps, news      - person-specific and owner-naming fallbacks
//   wave 3: registry                  - 5 runs, 1 contact, 0 Tier 1: last resort only
// Single source of truth: every deep caller uses this instead of its own literal.
const MANUAL_SOURCE_ORDER = ['site', 'facebook', 'chamber', 'linkedin', 'maps', 'news', 'registry'];

// THE DEEP CONTACT LOOKUP, STATED ONCE.
//
// Four callers run the contact fan-out and each built this object itself. Three set
// stopAtTier1; contactDiscovery -- the one on the AI Outreach workflow path -- did
// not, and that single omission changed three things at once:
//
//   - the exit rule became `bestRank < 9`, which is satisfied by ANY named person
//     with an unrecognised title (rank 7). One receptionist in wave 1 ended the
//     search: "[waves] satisfied after wave 1 (3 source(s))" with every source
//     reporting tier1=no.
//   - the source order fell back to registry-first, so site and linkedin -- the two
//     that actually find an owner at a small practice -- sat in wave 2 and never ran.
//   - the cache key lost its "| manual" suffix, so it read a different row from the
//     card path and from the scan-time warm.
//
// One builder, so a caller cannot get three of the four settings right.
function deepContactCtx(opts) {
  const o = opts || {};
  return {
    market: o.market === undefined ? null : o.market,
    isFranchise: o.isFranchise === true,
    contactApproach: o.contactApproach || null,
    enrichEmail: true,
    sourceOrder: MANUAL_SOURCE_ORDER,
    // The ladder keeps searching until it finds someone who can actually approve a
    // deal. Anything less is what produced "no named contact" for businesses whose
    // owner is on their own about page.
    stopAtTier1: true,
  };
}

// Bump when the contacts pipeline changes shape (widened sources, locality fix,
// ...). A cached row stamped with an older version is treated as a miss so the
// current search runs once per brand instead of serving stale pre-change data.
// v4: the evidence shape gained personalInbox, and the generic-inbox test changed,
// so v3 rows would keep serving a real person's mailbox labeled as a general inbox.
// The version gate treats them as a miss and re-runs once per brand.
// v5: contacts carry affiliationScope, and a parent-or-brand person is no longer
// a contact at all. A v4 row was written before any of that existed, so serving
// one would keep handing back the parent's executives for another seven days.
const _CONTACTS_CACHE_VERSION = 5;

// Test seam (see _searchContactSource). Production leaves this null.
let _contactSearchImpl = null;

// Shared JSON contract + rules appended to every source prompt.
const _CONTACT_JSON_TAIL = `After you finish searching, respond with ONLY a single JSON object and NOTHING else: no prose, no explanation, no citation text, no markdown code fences. If your web search surfaced any named people, you MUST extract EVERY one of them into the contacts array. Do not answer in sentences.
{"contacts":[{"name":"Full Name","title":"their role","email":null,"phone":null,"linkedinUrl":null,"sourceUrl":null,"confidence":"high|medium","affiliationScope":"this-location|parent-or-brand|unclear","affiliationEvidence":"the exact phrase from the source that ties them to the business"}],"businessEmail":null,"businessPhone":null,"city":null,"state":null}
Rules:
- name is REQUIRED for every contact and must be a real person's name your search actually found. title is their role as the source states it (or a short honest descriptor); a registered agent is not an owner, a manager is not an owner, never upgrade a title.
- email ONLY if literally published for THAT person; never guess from a pattern; else null. phone ONLY if a real published number; else null.
- linkedinUrl: that person's FULL public LinkedIn profile URL if the search actually surfaced one, else null. Never guess or construct one.
- sourceUrl: the page you found them on if you have it, else null. A missing URL is fine; still include the person.
- businessEmail: a published business inbox (not a person), else null. businessPhone: the business main published line, else null.
- confidence "high" from an official government or business-owned page, "medium" from a directory, social page, or news article.
- NEVER invent a name, title, email, phone, or URL. Return {"contacts":[]} only if your search genuinely found no named person.
- affiliationScope says WHO this person works for, and it is required for every contact. Use "this-location" only when the source ties them to THIS business at THIS address or city. Use "parent-or-brand" when they belong to a parent company, franchisor, operator, national brand, clinic network, or corporate head office rather than this location -- a Chief Executive, Chief Marketing Officer, VP, regional or corporate director almost always belongs here. Use "unclear" when the source names them for this business but states no tie to the location, which is normal for a chamber or directory listing.
- affiliationEvidence is the EXACT phrase from the source that supports the scope you chose, copied verbatim, not paraphrased. Never write a phrase the source does not contain. A person you cannot evidence is "unclear", never "this-location".`;

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
    case 'linkedin':
      return `Search LinkedIn for the owner, founder, or general manager of "${brand}"${where} (queries "${brand} ${loc || ''} owner linkedin", "${brand} founder linkedin"). Extract the person's name, their title exactly as the profile states it, and the FULL public profile URL as linkedinUrl (e.g. https://www.linkedin.com/in/...). Only report a profile that genuinely names this business as their company. Do not guess a profile URL.`;
    case 'site':
    default:
      return `Search the business's OWN website for "${brand}"${where}${domain ? ` (${domain})` : ''}: its team, about, staff, and contact pages. Extract named people with the titles the site states, and any published email or phone.`;
  }
}

// Ensure an honest provenance label is present for filings and news, matching the
// spec examples ("Registered Agent (state filing)", "Owner (local news)"). Never
// changes the role itself, only appends where the source is known.
// WHO DOES THIS PERSON ACTUALLY WORK FOR, decided in code and able to overrule the
// model. Hog Heaven Team Store is run by Follett, so the site source searched
// follett.com and returned Follett's CEO; Rally House Fayetteville is one of 135
// stores, so its own domain returned the national CMO. Phones were locality-
// checked and people were not checked at all, so both went straight to Tier 1.
//
// Three scopes, and the two that are not "this-location" are treated very
// differently on purpose:
//   parent-or-brand  REJECTED. Not a contact, surfaced separately so the research
//                    is visible rather than silently binned.
//   unclear          KEPT, demoted out of Tier 1 by the ladder. Chamber and
//                    directory listings name a real owner without ever stating a
//                    street address; that is the highest-yield source there is and
//                    failing closed on it would delete what works to fix a problem
//                    that only occurs on chains.
//   this-location    unchanged.
//
// A model that ignores the new fields entirely degrades to "unclear" -- kept and
// demoted -- never to "rejected". Losing a real owner is worse than ranking one low.
const _CORPORATE_TITLE = /\b(chief\s+\w+|c[emofit]o|president|vice[- ]president|vp|regional|national|corporate|global|head\s+of|group\s+\w+|division)\b/i;
const _LOCATION_WORD = /\b(of|at|in|the)\b/gi;

function _nameTokens(s) {
  return String(s || '').toLowerCase().replace(_LOCATION_WORD, ' ')
    .replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((t) => t.length > 2);
}

// Does the business name carry a place that the brand itself does not? "Rally
// House Fayetteville" does; "Pack Rat Outdoor Center" does not. A store of a
// larger brand cannot have a C-suite officer as its local contact.
function _hasLocationQualifier(brand, loc) {
  const place = _nameTokens(String(loc || '').split(',')[0]);
  if (!place.length) return false;
  const b = _nameTokens(brand);
  return place.some((p) => b.indexOf(p) !== -1);
}

function _scopeOf(rawScope, title, brand, sourceUrl, loc) {
  const claimed = String(rawScope || '').trim().toLowerCase();
  const scope = (claimed === 'this-location' || claimed === 'parent-or-brand' || claimed === 'unclear')
    ? claimed : 'unclear';
  if (scope === 'parent-or-brand') return scope;
  if (!_CORPORATE_TITLE.test(String(title || ''))) return scope;
  // A corporate title is only overruled when something else says the entity is
  // bigger than this location: the evidence page belongs to a differently-named
  // company, or the business name is a branch of a brand. A sole trader who calls
  // herself President of her own salon keeps her scope.
  const host = _nameTokens(String(sourceUrl || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').split('.')[0]);
  const b = _nameTokens(brand);
  const hostMismatch = host.length > 0 && b.length > 0 && !host.some((h) => b.indexOf(h) !== -1);
  if (hostMismatch || _hasLocationQualifier(brand, loc)) return 'parent-or-brand';
  return scope;
}

function _labelTitle(source, title) {
  const t = _cleanStr(title);
  if (!t) return t;
  // Collapse to a single clean qualifier. The model sometimes hands back a title
  // that already carries one or more parentheticals ("Owner (operator, per news
  // report)"), and appending a source tag stacked them ("... (state filing)").
  // Strip ALL parentheticals down to the core role, then add exactly ONE
  // provenance qualifier. Honest source hints already in the title win (so a
  // legacy stacked title collapses deterministically to what the text actually
  // says, e.g. "per news"), otherwise fall back to the source that surfaced it.
  const core = t.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim() || t;
  const newsHint = /news|press/i.test(t);
  const filingHint = /filing|registered agent|secretary of state|registry/i.test(t);
  let qual = '';
  if (newsHint) qual = '(per news)';
  else if (filingHint) qual = '(state filing)';
  else if (source === 'news') qual = '(per news)';
  else if (source === 'registry') qual = '(state filing)';
  return qual ? `${core} ${qual}` : core; // facebook / maps / chamber / site: plain role
}

// One targeted, single-source web search. Tags every contact with its source and
// resolves emails (published-only). Returns { source, contacts, inbox,
// businessPhone, state, status, ms, rawLen, parsed, kept, dropReason }.

// Collect real citation URLs from a web-search response's blocks, so an extracted
// person gets a valid source link even when the model does not hand-write one.
function _extractCitationUrls(blocks) {
  const urls = [];
  const push = (u) => { const s = _safeUrl(u); if (s && !urls.includes(s)) urls.push(s); };
  for (const b of (blocks || [])) {
    if (!b) continue;
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const it of b.content) if (it && it.url) push(it.url);
    }
    if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c && c.url) push(c.url);
    }
  }
  return urls;
}

// One contact web-search call that returns BOTH the text and the citation URLs.
// (oneShotWebSearch throws away everything but the text, so it cannot give us the
// real source links.) Throws on API error so the caller can surface it.
// Latency knobs for one contact source. A source's wall time is dominated by two
// things inside this single call: the web searches Anthropic runs server-side
// (SEQUENTIAL within the turn, so max_uses=2 means two round trips before any text
// is generated), and the output tokens Haiku then generates. Both are env-tunable so
// they can be A/B'd without a code change. Defaults are unchanged from before.
// How long we will still wait for the Instagram lookup once the source fan-out is
// done. It starts upfront and overlaps the fan-out, so this is only the tail.
// NOTE: this used to be the tail for a paid email lookup as well, and that lookup
// was raced FIRST -- so Instagram inherited its wait on top of this grace. With it
// gone Instagram gets this window and nothing more, which is a real, small
// reduction in the handle hit rate. Raise this if that matters more than latency.
const SIDE_LOOKUP_GRACE_MS = parseInt(process.env.SIDE_LOOKUP_GRACE_MS, 10) || 2500;
const CONTACT_SEARCH_MAX_USES = parseInt(process.env.CONTACT_SEARCH_MAX_USES, 10) || 2;
const CONTACT_SEARCH_MAX_TOKENS = parseInt(process.env.CONTACT_SEARCH_MAX_TOKENS, 10) || 900;

// ── Shared parallel wave engine ──────────────────────────────────────────────
// Runs independent lookups in parallel waves instead of one at a time: a wave costs
// its SLOWEST member, not the sum. Used by the brand contact ladder and by the
// program contact map, so there is exactly one implementation of this behavior.
//   sources    list of opaque source ids
//   runOne     (source) => Promise<result>   (must resolve; failures are tolerated)
//   opts.waveSize      members per wave (default CONTACT_WAVE_SIZE env or 3)
//   opts.wallBudgetMs  give up starting new waves past this
//   opts.hasWin(r)     result counts as a win, which permits the straggler cut
//   opts.isSatisfied(all)  stop between waves
//   opts.onResult(r)   per-result callback, used for logging
// Returns { results, ms, waveSize, wavesRun }.
async function runSourceWaves(sources, runOne, opts = {}) {
  const waveSize = Math.max(1, opts.waveSize || parseInt(process.env.CONTACT_WAVE_SIZE, 10) || 3);
  const wallBudgetMs = opts.wallBudgetMs || 22000;
  const hasWin = typeof opts.hasWin === 'function' ? opts.hasWin : () => false;
  const isSatisfied = typeof opts.isSatisfied === 'function' ? opts.isSatisfied : () => false;
  const onResult = typeof opts.onResult === 'function' ? opts.onResult : () => {};
  const label = opts.label || '';
  const t0 = Date.now();
  const all = [];
  let wavesRun = 0;
  for (let w = 0; w < sources.length; w += waveSize) {
    if (all.length && Date.now() - t0 > wallBudgetMs) {
      console.log(`[waves] ${label} stop: wall budget after ${all.length} source(s)`);
      break;
    }
    const wave = sources.slice(w, w + waveSize);
    wavesRun++;
    // STRAGGLER CUT: one dead source must not hold the whole wave. Once every other
    // member has settled AND we already have a win, stop waiting. The abandoned call
    // is left to its own timeout and its result is discarded.
    const waveOut = [];
    let settled = 0;
    let win = false;
    let cut = null;
    const cutP = new Promise((resolve) => { cut = resolve; });
    const maybeCut = () => { if (win && settled >= wave.length - 1 && cut) cut('cut'); };
    const tracked = wave.map((src) => Promise.resolve()
      .then(() => runOne(src))
      .then((r) => { if (r) { waveOut.push(r); if (hasWin(r)) win = true; } settled++; maybeCut(); })
      .catch(() => { settled++; maybeCut(); }));
    const outcome = await Promise.race([Promise.all(tracked).then(() => 'all'), cutP]);
    if (outcome === 'cut' && waveOut.length < wave.length) {
      console.log(`[waves] ${label} wave cut: ${wave.length - waveOut.length} straggler(s) abandoned after a win (wave=${wave.join(',')})`);
    }
    for (const r of waveOut) { all.push(r); onResult(r); }
    if (isSatisfied(all)) {
      console.log(`[waves] ${label} satisfied after wave ${wavesRun} (${all.length} source(s))`);
      break;
    }
  }
  return { results: all, ms: Date.now() - t0, waveSize, wavesRun };
}

async function _contactWebSearchRaw(prompt, sys) {
  const client = getClient();
  scanMeter.bumpWeb();
  const _apiT0 = Date.now();
  const msg = await client.messages.create({
    model: MODEL_FAST,
    max_tokens: CONTACT_SEARCH_MAX_TOKENS,
    system: sys,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: CONTACT_SEARCH_MAX_USES }],
    messages: [{ role: 'user', content: prompt }],
  });
  const apiMs = Date.now() - _apiT0;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const text = stripEmDashes(blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n'));
  // How many web searches the model ACTUALLY ran, and how many tokens it generated.
  // Together these say whether a slow source is slow because of searching or because
  // of writing, which is the difference between tuning max_uses and max_tokens.
  const searches = blocks.filter((b) => b && b.type === 'web_search_tool_result').length;
  const outTokens = (msg.usage && msg.usage.output_tokens) || 0;
  return { text, citations: _extractCitationUrls(blocks), searches, outTokens, apiMs };
}

// Pull the contacts payload out of a model response. Accepts a JSON object
// ({contacts:[...], businessPhone, ...}) OR a bare JSON array of contacts, and
// tolerates markdown fences / surrounding prose. Returns null when no JSON found.
function _parseContactsPayload(text) {
  if (!text) return null;
  const t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
  const oa = t.indexOf('{'), ob = t.lastIndexOf('}');
  if (oa !== -1 && ob > oa) {
    const obj = tryParse(t.substring(oa, ob + 1));
    if (obj && Array.isArray(obj.contacts)) return { contacts: obj.contacts, businessEmail: obj.businessEmail || null, businessPhone: obj.businessPhone || null, state: obj.state || null };
    if (obj && !Array.isArray(obj.contacts) && !Array.isArray(obj)) {
      // Object without a contacts array: still salvage any business fields.
      const aa2 = t.indexOf('['), ab2 = t.lastIndexOf(']');
      if (aa2 !== -1 && ab2 > aa2) { const arr = tryParse(t.substring(aa2, ab2 + 1)); if (Array.isArray(arr)) return { contacts: arr, businessEmail: obj.businessEmail || null, businessPhone: obj.businessPhone || null, state: obj.state || null }; }
      return { contacts: [], businessEmail: obj.businessEmail || null, businessPhone: obj.businessPhone || null, state: obj.state || null };
    }
  }
  const aa = t.indexOf('['), ab = t.lastIndexOf(']');
  if (aa !== -1 && ab > aa) { const arr = tryParse(t.substring(aa, ab + 1)); if (Array.isArray(arr)) return { contacts: arr, businessEmail: null, businessPhone: null, state: null }; }
  return null;
}

// Split a name span that may join people with "and"/"&", handling a shared
// surname: "Jonathan and Justin Fox" -> ["Jonathan Fox", "Justin Fox"].
function _splitNames(span) {
  const parts = String(span || '').split(/\s+(?:and|&)\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return parts;
  const lastToks = parts[parts.length - 1].split(/\s+/);
  const surname = lastToks.length >= 2 ? lastToks[lastToks.length - 1] : null;
  return parts.map((p) => {
    const toks = p.split(/\s+/);
    return (toks.length === 1 && surname) ? `${toks[0]} ${surname}` : p;
  });
}
function _titleFromRole(role) {
  const r = String(role || '').toLowerCase();
  if (/co-?own/.test(r)) return 'Co-owner';
  if (/found/.test(r)) return 'Founder';
  if (/own|proprietor/.test(r)) return 'Owner'; // owner / owned by / owns
  if (/president/.test(r)) return 'President';
  if (/\bceo\b/.test(r)) return 'CEO';
  if (/general manager/.test(r)) return 'General Manager';
  if (/manager/.test(r)) return 'Manager';
  return _cleanStr(role);
}
// Last-resort extraction when the model answered in prose despite the JSON
// instruction. Pulls named people tied to an ownership/leadership role from the
// real (web-searched) text. Conservative: requires a plausible full name.
function _extractContactsFromProse(text) {
  const out = []; const seen = new Set();
  const plausible = (n) => /^[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3}$/.test(n);
  const add = (rawName, title) => {
    let n = _cleanStr(rawName);
    if (n) n = n.replace(/[.,;:]+$/, '').trim(); // strip a trailing sentence period, etc.
    if (!n || !plausible(n)) return;
    const k = n.toLowerCase();
    if (seen.has(k)) return; seen.add(k);
    out.push({ name: n, title: title || null, email: null, phone: null, sourceUrl: null });
  };
  // Role BEFORE the name (includes passive "owned by"): the people are what follows.
  const ROLE_BEFORE = 'owner|owners|owned by|co-?owner|founder|founders|founded by|president|ceo|proprietor|general manager|manager';
  // Role AFTER the name (active nouns only). Excludes passive "owned by" so
  // "Fox Bros. Bar-B-Q is owned by ..." does not grab the BUSINESS as a person.
  const ROLE_AFTER = 'owner|co-?owner|founder|co-?founder|president|ceo|proprietor|general manager|manager';
  const roleThenName = new RegExp(`\\b(${ROLE_BEFORE})\\b[:,\\s]+([A-Z][a-zA-Z.'-]+(?:\\s+[A-Z][a-zA-Z.'-]+)*(?:\\s+(?:and|&)\\s+[A-Z][a-zA-Z.'-]+(?:\\s+[A-Z][a-zA-Z.'-]+)*)?)`, 'g');
  let m;
  while ((m = roleThenName.exec(text))) _splitNames(m[2]).forEach((nm) => add(nm, _titleFromRole(m[1])));
  const nameThenRole = new RegExp(`\\b([A-Z][a-zA-Z.'-]+(?:\\s+[A-Z][a-zA-Z.'-]+){1,2}),?\\s+(?:is\\s+)?(?:the\\s+)?(${ROLE_AFTER})\\b`, 'g');
  while ((m = nameThenRole.exec(text))) add(m[1], _titleFromRole(m[2]));
  return out;
}

async function _searchContactSource(source, brand, loc, domain, regionState) {
  const t0 = Date.now();
  const sys = 'You research a specific local business with web search, then return ONLY structured JSON about the real people you found. Report ONLY facts published on a real page. Never invent a name, title, email, phone, or URL.';
  const prompt = `${_sourceLead(source, brand, loc, domain, regionState)}\n${_CONTACT_JSON_TAIL}`;

  // Get the raw text AND the web-search citation URLs. Do NOT swallow the error:
  // if the call throws (auth, tool, rate limit), record it so the per-source log
  // shows the real reason instead of a silent empty.
  let text = '', citations = [], status = 'ran', errMsg = '';
  let searches = 0, outTokens = 0, apiMs = 0;
  try {
    if (_contactSearchImpl) {
      // Test seam: may return a raw string, or { text, citations }.
      const out = await _contactSearchImpl(prompt, sys, 900, 2, MODEL_FAST, source);
      if (out && typeof out === 'object') { text = out.text || ''; citations = out.citations || []; }
      else { text = out || ''; }
    } else {
      const r = await Promise.race([
        _contactWebSearchRaw(prompt, sys),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout-15s')), 15000)),
      ]);
      text = r.text || ''; citations = r.citations || [];
      searches = r.searches || 0; outTokens = r.outTokens || 0; apiMs = r.apiMs || 0;
    }
  } catch (e) { status = 'error'; errMsg = (e && e.message) || 'error'; }
  if (status === 'ran' && !text) status = 'empty';

  // Extract: JSON first (object or bare array), then a prose fallback so a
  // natural-language answer ("owned by Jonathan and Justin Fox") is not lost.
  const payload = _parseContactsPayload(text);
  let rawContacts = payload && Array.isArray(payload.contacts) ? payload.contacts : [];
  let usedProse = false;
  if (!rawContacts.length && text && status !== 'error') {
    const prose = _extractContactsFromProse(text);
    if (prose.length) { rawContacts = prose; usedProse = true; }
  }
  const parsedN = rawContacts.length;

  const contacts = []; const notAffiliated = []; let inbox = null, businessPhone = null, state = null;
  let dropReason = '';
  for (const c of rawContacts) {
    const name = _cleanStr(c && c.name);
    if (!name) { dropReason = dropReason || 'no-name'; continue; } // ONLY drop when there is no name
    const title = _labelTitle(source, c && c.title) || null;      // title may be null; keep anyway
    // sourceUrl: the model's if it is a clean URL, else the best web-search
    // citation, else null. A messy or missing URL never drops a real person.
    let sourceUrl = _safeUrl(c && c.sourceUrl);
    if (!sourceUrl && citations.length) sourceUrl = citations[0];
    const rawEmail = c && c.email;
    const { email, emailSource } = await resolveEmail(name, domain, rawEmail);
    if (!email && _isGenericInbox(rawEmail) && !inbox) inbox = _validEmail(rawEmail);
    const _li = (c && typeof c.linkedinUrl === 'string' && /linkedin\.com\/(in|company)\//i.test(c.linkedinUrl)) ? c.linkedinUrl.trim() : null;
    // WHO DO THEY WORK FOR. Decided here, before the person can be merged, ranked
    // and served -- there was no check on a person at any later point.
    const affiliationScope = _scopeOf(c && c.affiliationScope, title, brand, sourceUrl, loc);
    const affiliationEvidence = _cleanStr(c && c.affiliationEvidence);
    const row = { name, title, email, emailSource, phone: _normalizePhone(c && c.phone), linkedinUrl: _li, sourceUrl, confidence: (c && c.confidence) === 'high' ? 'high' : 'medium', source, affiliationScope, affiliationEvidence };
    if (affiliationScope === 'parent-or-brand') {
      // Not a contact, and not thrown away either: an agent who can see WHY the
      // parent's CEO was set aside will not go looking for him by hand.
      notAffiliated.push(row);
      dropReason = dropReason || 'parent-or-brand';
      continue;
    }
    contacts.push(row);
  }
  const be = _validEmail(payload && payload.businessEmail);
  if (!inbox && be) inbox = be;
  businessPhone = _normalizePhone(payload && payload.businessPhone);
  state = _cleanStr(payload && payload.state) || null;
  if (!contacts.length && parsedN) dropReason = dropReason || 'validation';

  return {
    source, contacts, notAffiliated, inbox, businessPhone, state, status,
    ms: Date.now() - t0, rawLen: text.length, parsed: parsedN, kept: contacts.length,
    searches, outTokens, apiMs,
    dropReason: dropReason || (status === 'error' ? 'error:' + errMsg : ''), usedProse,
  };
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
      merged.linkedinUrl = c.linkedinUrl || ex.linkedinUrl || null;
      byKey.set(key, merged);
    } else {
      ex.email = ex.email || c.email;
      if (!ex.emailSource && c.email) ex.emailSource = c.emailSource;
      ex.phone = ex.phone || c.phone;
      ex.linkedinUrl = ex.linkedinUrl || c.linkedinUrl || null;
    }
  }
  return [...byKey.values()];
}

async function _fetchBrandContacts(brand, website, force = false, locationHint = '', opts = {}) {
  const loc = _cleanStr(locationHint) || '';
  // Manual "Add a Business" runs a DIFFERENT search (site-first order, and it keeps
  // going until a Tier 1 decision maker is found). Its results must not be served to
  // a normal scan, and a scan's shallower result must not be served to a manual add,
  // so the two use separate cache keys.
  const manualLadder = !!(opts && opts.stopAtTier1);
  // Franchise contacts are location-specific (Planet Smoothie Marietta is not
  // Planet Smoothie Atlanta), so the cache key includes the region when known.
  // CANONICAL region in the key, never the caller's spelling. The card says
  // "Fayetteville, AR", the outreach workflow says "Fayetteville, Arkansas" and Add
  // a Business passes a full street address -- three keys for one business, so every
  // deep lookup re-paid for work already cached and the scan-time warm wrote a row
  // the click could never read.
  const _locKey = canonicalRegion(loc);
  const cacheKey = (_locKey ? `${brand} | ${_locKey}` : brand) + (manualLadder ? ' | manual' : '');
  const domain = _domainFromUrl(website);
  const regionState = normalizeState((loc.split(',').pop() || '').trim());
  const localityRequired = !!(opts && opts.localityRequired);
  // Locality gate. With a known region, verify the phone against it. With NO
  // resolvable region on a LOCAL card we cannot confirm the number is local, so
  // we reject it (a wrong-state phone is worse than none). National-brand lanes
  // (no locality requirement) still allow a region-less number.
  const _localityCheck = (phone, reportedState) => {
    if (regionState) return _phoneLocalityOk(phone, reportedState, regionState);
    return localityRequired ? { ok: false, reason: 'no-region (local, unverifiable)' } : { ok: true, reason: 'no-region' };
  };

  // Shape a cached row into the return value. Extracted so the own-key read and the
  // deep-row read below cannot drift apart.
  const _fromCache = (cached, via) => {
    const ev = (cached && cached.evidence) || {};
    // A row stamped with an older pipeline version (or none) is treated as a miss so
    // the widened multi-source search re-runs once for this brand.
    if (ev.v !== _CONTACTS_CACHE_VERSION) {
      console.log(`[dealScan] contacts brand=${brand} cache version miss (had v=${ev.v || 'none'}), re-running widened search`);
      return null;
    }
    let cphone = ev.businessPhone || null;
    let cunconf = !!ev.phoneUnconfirmed;
    // Re-validate the cached phone against the CURRENT region. A stale wrong-state
    // number (cached before the locality fix) must not survive.
    if (cphone && !_localityCheck(cphone, null).ok) {
      console.log(`[dealScan] contacts brand=${brand} cached phone rejected on read region=${regionState || 'n/a'}`);
      cphone = null; cunconf = true;
    }
    if (via) console.log(`[dealScan] contacts brand=${brand} served from the DEEP row (${(ev.contacts || []).length} named)`);
    return { contacts: ev.contacts || [], notAffiliated: ev.notAffiliated || [], genericInbox: ev.genericInbox || null, personalInbox: ev.personalInbox || null, businessPhone: cphone, phoneUnconfirmed: cunconf, outcome: cached.outcome || 'NONE', cached: true };
  };

  if (!force) {
    const cached = await store.getBrandEvidence(cacheKey, 'contacts', 30);
    if (cached) {
      const out = _fromCache(cached, null);
      if (out) return out;
    }
  }

  // THE CHEAP CARD PASS CAN SERVE A DEEP ROW.
  //
  // The two paths deliberately use different keys so a scan's shallow result is
  // never served to a manual add. But the asymmetry only makes sense in ONE
  // direction: a deep result is a superset of anything this path could produce, so
  // refusing to read it means the card shows "No named contact found" for a
  // business whose owner is sitting in the cache.
  //
  // That is exactly what happened to Pack Rat Outdoor Center. The fan-out ran, found
  // four contacts including a Tier 1, and wrote them under "... | manual". The card
  // then asked for "..." without the suffix, got nothing -- because the cheap path
  // returns an empty list by design -- and rendered "No named contact found. Call
  // (479) 521-6340." The contacts were never lost; nothing ever asked for them.
  //
  // This is also what makes the scan-time ladder warm visible: the card's own lazy
  // contact fill now picks it up with no extra request and no second fan-out.
  if (!force && !manualLadder) {
    const deepRow = await store.getBrandEvidence(cacheKey + ' | manual', 'contacts', 30);
    if (deepRow) {
      const out = _fromCache(deepRow, 'deep');
      if (out) return out;
    }
  }

  // Mine the public sources SEQUENTIALLY with early exit. This is the biggest
  // per-scan cost lever: contacts fan out across every brand, so running all six
  // searches for all ten brands was up to sixty web searches per scan. Instead we
  // stop the moment we have a real decision-maker (owner / officer / GM /
  // marketing — anything ranked above a bare registered agent) with a source.
  // A registered-agent-only hit is a lawyer, not a decision maker, so it does NOT
  // end the search; we keep going (and still keep the agent as a fallback). A
  // total wall budget guards a pathological brand from running all six long
  // searches back to back.
  // Cost gate: skip the web-search fan-out unless the caller opted in (AI Outreach).
  // Card path returns empty here; getBrandContacts still attaches the Places phone.
  if (opts && opts.allowSearch === false) {
    console.log(`[dealScan] contacts brand=${brand} search skipped (card path, no fan-out)`);
    return { contacts: [], notAffiliated: [], genericInbox: null, personalInbox: null, businessPhone: null, phoneUnconfirmed: false, outcome: 'SKIPPED', cached: false };
  }
  // Manual adds get a longer wall budget: the agent is waiting on ONE business they
  // chose, not ten they are skimming, so it is worth spending the extra seconds.
  const CONTACT_WALL_BUDGET_MS = manualLadder ? 40000 : 22000;
  const _cStart = Date.now();
  const results = [];
  // Manual adds search SITE FIRST: the agent already knows the business, so its own
  // about/contact pages are the highest-yield place to find a named owner. Scans keep
  // the shared order (registry-first) untouched.
  const sourceOrder = (opts && Array.isArray(opts.sourceOrder) && opts.sourceOrder.length)
    ? opts.sourceOrder.filter((s) => _CONTACT_SOURCES.indexOf(s) !== -1)
    : _CONTACT_SOURCES;
  // Sources run in PARALLEL WAVES instead of one at a time. Strictly sequential was
  // costing up to 6 x 15s back to back (a real deep call measured 27s), because each
  // source waited on the one before it for no reason: they are independent lookups.
  // A wave's latency is its SLOWEST member, not the sum. The early-exit check still
  // runs between waves, so a Tier 1 hit in wave 1 skips wave 2 entirely.
  // Tradeoff, accepted deliberately: a wave always spends its full width (3 calls)
  // even when the first source alone would have sufficed. Speed is worth more here
  // than the occasional saved call.
  // Shared wave engine (runSourceWaves). The brand ladder and the program contact
  // map run the SAME runner; only the per-source function and the stop rules differ.
  const _waveRun = await runSourceWaves(
    sourceOrder,
    (src) => _searchContactSource(src, brand, loc, domain, regionState),
    {
      wallBudgetMs: CONTACT_WALL_BUDGET_MS,
      label: `brand=${brand}`,
      // A wave may cut its straggler once this is true of any settled result.
      // r.contacts can no longer contain a parent-or-brand person (they are held
      // back at extraction), so a parent's CEO -- who ranks 0 and used to satisfy
      // this instantly -- can no longer stop the search on the wrong person. An
      // "unclear" local owner still counts: the ladder demotes them out of Tier 1,
      // but making the fan-out keep searching past a chamber owner would run all
      // seven sources on almost every business and roughly double the bill.
      hasWin: (r) => (r.contacts || []).some((c) => _TIER1_RANKS.indexOf(_contactAuthorityRank(c.title)) !== -1),
      onResult: (r) => {
        const _t1hit = (r.contacts || []).some((c) => _TIER1_RANKS.indexOf(_contactAuthorityRank(c.title)) !== -1);
        console.log(`[brand-contacts] source=${r.source} ms=${r.ms} found=${r.kept} tier1=${_t1hit ? 'yes' : 'no'} searches=${r.searches} outTokens=${r.outTokens} apiMs=${r.apiMs} rawLen=${r.rawLen} status=${r.status} parsed=${r.parsed}${r.dropReason ? ` dropReason=${r.dropReason}` : ''}${r.usedProse ? ' prose=1' : ''}`);
      },
      // Between waves: scan stops at anything above a bare registered agent (cost
      // lever); the manual ladder keeps going until a real Tier 1 decision maker.
      isSatisfied: (all) => {
        const best = _mergeContacts(all.flatMap((x) => x.contacts))
          .sort((a, b) => _contactAuthorityRank(a.title) - _contactAuthorityRank(b.title))[0];
        if (!best) return false;
        const bestRank = _contactAuthorityRank(best.title);
        return manualLadder ? _TIER1_RANKS.indexOf(bestRank) !== -1 : bestRank < 9;
      },
    }
  );
  for (const r of _waveRun.results) results.push(r);
  console.log(`[brand-contacts] fanout brand=${brand} sources=${results.length}/${sourceOrder.length} waveSize=${_waveRun.waveSize} totalMs=${Date.now() - _cStart}`);
  if (manualLadder) {
    const _t1 = _mergeContacts(results.flatMap((x) => x.contacts))
      .some((c) => _TIER1_RANKS.indexOf(_contactAuthorityRank(c.title)) !== -1);
    if (!_t1) console.log(`[dealScan] contacts brand=${brand} manual ladder: all ${results.length} source(s) exhausted, no tier 1 found`);
  }
  const bySource = {};
  for (const r of results) bySource[r.source] = r;

  // Everyone a source found but held back as the parent's, deduped. Reported, never
  // silently dropped: an agent who can see that Follett's CEO was set aside does not
  // go looking for him by hand.
  const notAffiliated = _mergeContacts(results.flatMap((r) => r.notAffiliated || []));
  if (notAffiliated.length) {
    console.log(`[brand-contacts] brand=${brand} held back ${notAffiliated.length} parent/brand contact(s): `
      + notAffiliated.map((c) => `${c.name} (${c.title || 'no title'})`).join(', '));
  }
  // Merge named contacts across sources, then locality-check every phone.
  let named = _mergeContacts(results.flatMap((r) => r.contacts));
  for (const c of named) {
    if (c.phone && !_localityCheck(c.phone, null).ok) c.phone = null;
  }
  // Rank: owner/founder, then officer/member, GM, marketing, registered agent
  // last. Prefer a high-confidence source on ties.
  named.sort((a, b) =>
    (_contactAuthorityRank(a.title) - _contactAuthorityRank(b.title)) ||
    ((a.confidence === 'high' ? 0 : 1) - (b.confidence === 'high' ? 0 : 1))
  );
  named = named.slice(0, 4);

  // Business inbox. The published business-level email was previously labeled a
  // "general inbox" WITHOUT ever testing whether it is actually generic, so a real
  // person's mailbox (mccall@...) was presented as "not a named person". Now the
  // generic test decides: a non-generic local part is a possible person, and it is
  // either attached to the matching person on the ladder or surfaced as its own
  // named mailbox, never buried.
  let genericInbox = null;
  let personalInbox = null;
  for (const src of _CONTACT_SOURCES) {
    const cand = bySource[src] && bySource[src].inbox;
    if (!cand) continue;
    if (_isGenericInbox(cand)) { if (!genericInbox) genericInbox = cand; }
    else if (!personalInbox) personalInbox = cand;
  }
  if (personalInbox) {
    const _lp = String(personalInbox).split('@')[0];
    const _owner = named.find((c) => !c.email && _localPartMatchesName(_lp, c.name));
    if (_owner) {
      _owner.email = personalInbox;
      _owner.emailSource = 'published';
      console.log(`[dealScan] contacts brand=${brand} attached mailbox ${personalInbox} to "${_owner.name}" (local part matches name)`);
      personalInbox = null; // now owned by a person, not a standalone row
    } else if (named.some((c) => c.email && c.email.toLowerCase() === personalInbox.toLowerCase())) {
      personalInbox = null; // already on the ladder
    } else {
      console.log(`[dealScan] contacts brand=${brand} mailbox ${personalInbox} is NOT generic, surfacing as a named mailbox`);
    }
  }

  // Business phone: gather every published number (maps first, it carries a
  // confirmed city/state), then take the first that passes the locality check.
  const phoneCandidates = [];
  if (bySource.maps && bySource.maps.businessPhone) phoneCandidates.push({ phone: bySource.maps.businessPhone, state: bySource.maps.state });
  for (const r of results) { if (r.businessPhone) phoneCandidates.push({ phone: r.businessPhone, state: r.state || null }); }
  let businessPhone = null, phoneUnconfirmed = false;
  for (const pc of phoneCandidates) {
    const chk = _localityCheck(pc.phone, pc.state);
    if (chk.ok) { businessPhone = pc.phone; break; }
  }
  if (!businessPhone && phoneCandidates.length) {
    phoneUnconfirmed = true;
    console.log(`[dealScan] contacts brand=${brand} phone rejected region=${regionState || 'n/a'}`);
  }

  const anyTimeout = results.some((r) => r.status === 'timeout');
  const anyError = results.some((r) => r.status === 'error');

  const evidence = { kind: 'contacts', v: _CONTACTS_CACHE_VERSION, contacts: named, notAffiliated, genericInbox, personalInbox, businessPhone, phoneUnconfirmed };
  // Cache whenever we have a usable affordance OR a definitive empty (all sources
  // ran and found nothing). Never cache a pure transient failure.
  let outcome;
  if (named.length) outcome = 'OK';
  else if (businessPhone || genericInbox) outcome = 'FALLBACK';
  else if (anyTimeout) outcome = 'TIMEOUT';
  else if (anyError) outcome = 'ERROR';
  else outcome = 'NONE';
  const hasAffordance = named.length || businessPhone || genericInbox || personalInbox;
  if (hasAffordance || outcome === 'NONE') {
    await store.saveBrandEvidence(cacheKey, 'contacts', brand, website, evidence, outcome);
  }
  return { contacts: named, notAffiliated, genericInbox, personalInbox, businessPhone, phoneUnconfirmed, outcome, cached: false };
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
  // Local-lane cards (school / hometown markets) require a locality check on any
  // phone: a wrong-state number is worse than none. National-brand lanes (social,
  // topnil) have no market and no locality requirement.
  const localityRequired = !!(ctx && (ctx.market === 'school' || ctx.market === 'hometown'));
  let places = null;
  const _placesT0 = Date.now();
  try { places = await lookupPlace(brand, locationHint); } catch (_) { places = null; }
  const _placesMs = Date.now() - _placesT0;
  const effectiveWebsite = website || (places && places.website) || null;
  // Cost gate: the 6-source contact web-search fan-out is the biggest Anthropic
  // cost driver. Only run it on the AI Outreach path (ctx.enrichEmail), where the
  // agent chose to pursue this business. On the card path we return the Places
  // phone/website only — cheap, and phone is the actionable contact anyway.
  const _deep = !!(ctx && ctx.enrichEmail);
  // Kick the two INDEPENDENT lookups off now so they overlap the contact fan-out
  // instead of running after it. It does not need the contact list to start, and
  // serially it was adding ~8s to the wall time of a deep call. Failure-tolerant:
  // resolves to null.
  let _igPromise = null;
  if (_deep && effectiveWebsite) {
    try {
      const { findInstagram } = require('./services/instagramLookup');
      _igPromise = findInstagram(effectiveWebsite).catch(() => null);
    } catch (_) { _igPromise = null; }
  }
  // Manual "Add a Business" passes sourceOrder (site first) and stopAtTier1, so the
  // ladder keeps searching past a Tier 2 manager. Scans pass neither and are unchanged.
  const res = await _fetchBrandContacts(brand, effectiveWebsite, false, locationHint, {
    localityRequired,
    allowSearch: _deep,
    sourceOrder: (ctx && Array.isArray(ctx.sourceOrder)) ? ctx.sourceOrder : null,
    stopAtTier1: !!(ctx && ctx.stopAtTier1),
  });
  // Collapse titles at READ time as well, so already-cached rows written before
  // the title fix (stacked "... (per news report) (state filing)") also serve a
  // single clean qualifier, without waiting for a re-search.
  res.contacts = (res.contacts || []).map((c) => ({ ...c, title: _labelTitle(c.source, c.title) }));
  // Places phone is authoritative for this exact business location, so it
  // overrides the web-searched number and bypasses the locality gate.
  if (places && places.phone) { res.businessPhone = places.phone; res.phoneUnconfirmed = false; }
  // NO EMAIL IS INVENTED, GUESSED, OR BOUGHT. Hunter.io used to run here and do
  // three things: fill an address onto a fan-out contact by surname match, CREATE
  // a contact out of its best personal address titled "Company contact (not
  // confirmed owner)", and backfill a generic inbox. It is gone.
  //
  // The second one is why. A Hunter contact carried a name AND an email, which is
  // exactly the test greetableContacts applies, so the greeting guard approved
  // addressing that person by first name -- on an address whose own title said
  // they might not work there. That is the invented-recipient failure with an
  // extra step. Measured yield across 20 Birmingham businesses: 3 such people and
  // not one published address, against a 50-call monthly ceiling.
  //
  // Every email on the ladder is now one a source found published for that person.
  let _igMs = 0;
  // Instagram: for a local business the owner's DM is often a better channel than
  // the phone, and it is a genuinely DIFFERENT contact rather than another copy of
  // the same number. Site-scraped only (no AI, one fetch, cached 30 days), gated on
  // the deep path so a plain card scan does not pay for it.
  if (_igPromise) {
    const _igT0 = Date.now();
    try {
      const handle = await Promise.race([_igPromise, new Promise((res2) => setTimeout(() => res2('__late__'), SIDE_LOOKUP_GRACE_MS))]);
      if (handle === '__late__') console.log(`[brand-contacts] instagram still running after fan-out, dropped after ${SIDE_LOOKUP_GRACE_MS}ms`);
      else if (handle) res.instagram = handle;
    } catch (e) { console.warn('[dealScan] instagram lookup failed:', e.message); }
    _igMs = Date.now() - _igT0;
  }
  // Phase breakdown, so time spent OUTSIDE the fan-out is never unexplained again.
  if (_deep) console.log(`[brand-contacts] deep brand=${brand} placesMs=${_placesMs} igWaitMs=${_igMs}`);
  // Make the card actionable: hand the top named contact the business line as a
  // callable number when they have none of their own. "Ask for Bryan" plus the
  // shop's number is the real local play; a name with no number is a dead end.
  if (res.businessPhone) {
    const _named = (res.contacts || []).find((c) => c.name && String(c.name).trim() && !c.phone);
    if (_named) _named.phone = res.businessPhone;
  }
  const withEmail = res.contacts.filter((c) => c.email).length;
  const withPhone = res.contacts.filter((c) => c.phone).length + (res.businessPhone ? 1 : 0);
  const found = res.contacts.length + (res.businessPhone ? 1 : 0) + (res.genericInbox ? 1 : 0);
  const source = res.cached ? 'cache' : res.outcome === 'TIMEOUT' ? 'TIMEOUT' : res.outcome === 'ERROR' ? 'ERROR' : 'web';
  console.log(`[dealScan] contacts brand=${brand} found=${found} named=${res.contacts.length} withEmail=${withEmail} withPhone=${withPhone} source=${source}`);
  const loc = _cleanStr(locationHint) || '';
  const mapsUrl = (places && places.mapsUrl) || ((!res.contacts.length && !res.businessPhone)
    ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(brand + (loc ? ' ' + loc : ''))
    : null);
  const approach = _contactApproach(ctx || {}, res.contacts[0] || null, res);
  return { contacts: res.contacts, notAffiliated: res.notAffiliated || [], genericInbox: res.genericInbox, personalInbox: res.personalInbox || null, instagram: res.instagram || null, businessPhone: res.businessPhone, approach, mapsUrl, website: (places && places.website) || website || null };
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
  const { TOPNIL_SEEDS } = require('./dealScanSeeds');
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
  const tally = { topnil: { OK: 0, SALVAGED: 0, NO_EVIDENCE: 0, TIMEOUT: 0, ERROR: 0 } };

  // SOCIAL lane is now served entirely from the curated social_brands index
  // (getSocialBrands) — no web/AI, no evidence cache — so nothing to pre-warm.

  // TOP NIL is served from deal_comps only now (no web searches at scan time), so
  // there is nothing to pre-warm for it. Warming the old topnil evidence cache
  // would run web searches for a cache the lane no longer reads — pure waste.
  const topnil = uniqBrands(TOPNIL_SEEDS);
  console.log('[prewarm] topnil: skipped (lane is served from deal_comps, no web searches)');

  // Warm per-brand contacts too (30-day cache), so a scan does not pay a contact
  // web search for common brands.
  tally.contacts = { OK: 0, FALLBACK: 0, NONE: 0, TIMEOUT: 0, ERROR: 0 };
  const seenC = new Set();
  const allBrands = [...topnil].filter((b) => {
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
// TOP NIL lane, served from deal_comps ONLY — zero web searches, zero AI calls.
// The lane used to run 3-4 discovery web searches plus a per-brand disclosed-deal
// search for every brand on every scan, and returned "No recent disclosed deals
// found" every time because deal_comps has no consumer-brand rows yet. That was
// pure cost for no value. Now the lane surfaces exactly what the comp database
// actually knows: brands with real disclosed deals, built into the same card
// shape. When deal_comps has nothing, the lane is honestly empty.
async function _topnilFromComps(athlete, excludeBrands) {
  const _t0 = Date.now();
  const rate = calculateRate(athlete, 'ig-reel');
  const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);
  const tier = reach > 500000 ? 'macro' : reach > 100000 ? 'mid' : reach > 25000 ? 'micro' : 'nano';
  const sport = athlete.sport || 'football';
  const valLow  = tier === 'macro' ? 2500 : tier === 'mid' ? 800 : tier === 'micro' ? 250 : 100;
  const valHigh = tier === 'macro' ? 15000 : tier === 'mid' ? 4000 : tier === 'micro' ? 1000 : 500;
  const ctx2 = { rate, valLow, valHigh, sport };
  const athleteTagSubs = validTagSubs(athlete.tags);
  const _excl = new Set((excludeBrands || []).map((b) => (b || '').toLowerCase().trim()));

  const cards = [];
  const seen = new Set();

  // 1) Brands with REAL disclosed deals from the comp database lead: richest
  // context. Each still renders as a "brand to know" card, never as an apology.
  let compBrands = [];
  try { compBrands = await store.getTopNilComps(6, 3); } catch (_) { compBrands = []; }
  for (const b of compBrands) {
    const name = String(b.brand || '').trim();
    const key = name.toLowerCase();
    if (!name || _excl.has(key) || seen.has(key)) continue;
    const deals = (b.deals || []).map((r) => ({
      athlete: _cleanStr(r.athlete_name),
      sport: _cleanStr(r.sport),
      followers: (typeof r.followers === 'number' ? r.followers : parseInt(r.followers, 10)) || null,
      dealType: _cleanStr(r.deal_type),
      date: r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : null,
      sourceUrl: _safeUrl(r.source),
      source: 'comp',
    })).filter((d) => d.athlete);
    seen.add(key);
    const f = { name, website: null, category: 'nil', email: null, _seed: false };
    cards.push(_buildNationalBrandCard(f, ctx2, athlete, athleteTagSubs, deals));
  }

  // 2) National seed brands as context cards: what the brand is + that it works
  // with athletes at scale + the named contacts we find lazily. No web search,
  // no disclosed-deal claim we do not have. Tag-weighted to the athlete.
  for (const s of (getSeeds('topnil', tier, athleteTagSubs) || [])) {
    const name = String(s.name || '').trim();
    const key = name.toLowerCase();
    if (!name || _excl.has(key) || seen.has(key)) continue;
    seen.add(key);
    const f = { name, website: s.website || null, category: s.category || 'nil', email: s.email || null, _seed: true };
    cards.push(_buildNationalBrandCard(f, ctx2, athlete, athleteTagSubs, []));
  }

  cards.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
  const out = cards.slice(0, 6).map((c, i) => ({ ...c, rank: i + 1 }));
  console.log(`[dealScan:topnil] national brands to know: ${out.length} card(s) (${compBrands.length} with disclosed deals), 0 web searches, in ${Date.now() - _t0}ms`);
  return out;
}

// "Planet Smoothie (Marietta)", "PLANET SMOOTHIE ". Reduce all of them to the
// same key by dropping any market suffix after the first comma, dropping any
// parenthetical, normalizing & to "and", and stripping case, spaces and
// punctuation. So the persisted shown-set matches the pool candidate regardless
// of how the model or the search phrased the name.
function _brandKey(s) {
  return String(s || '')
    .toLowerCase()
    .split(',')[0]              // drop ", Marietta" style market suffix
    .replace(/\([^)]*\)/g, '')  // drop "(Marietta)" style parenthetical
    .replace(/&/g, ' and ')     // "Ben & Jerry's" == "Ben and Jerry's"
    .replace(/[^a-z0-9]+/g, ''); // strip case-insensitive punctuation + whitespace
}

// Normalized ROOT domain from a URL or hostname: lowercased, scheme and path
// stripped, leading "www." and any remaining subdomain removed down to the last
// two labels. The multi-part TLD case (a.co.uk) is a known limitation, acceptable
// for the US DTC brands the social/national lanes carry.
function _rootDomain(url) {
  let s = String(url || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme
  s = s.split(/[/?#]/)[0];                       // host + port only
  s = s.split('@').pop();                        // drop any user@ part
  s = s.split(':')[0];                           // drop :port
  s = s.replace(/^www\./, '');
  if (!s || !s.includes('.')) return s;
  const parts = s.split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

// SINGLE source of truth for a brand's engagement-ledger identity key. Used by the
// scan selection, the shown/contacted upserts, the retirement endpoints, and the
// backfill, so a brand is keyed exactly one way everywhere. NEVER key on the
// display name silently; the name-slug fallbacks below are logged so we can see
// how often a real key was unavailable.
//   local           -> "place:<google place_id>" (stable; the Homewood store is a
//                       different key from the Hoover one). No place_id (web-search
//                       markets, never Places) -> "localname:<name>-<city>" + WARN.
//   social/national  -> "dom:<root domain>". No domain -> "name:<name-slug>" + WARN.
function resolveBrandKey(opp, lane) {
  const o = opp || {};
  const laneN = String(lane || o.lane || 'local').toLowerCase();
  const name = o.brand || o.brand_name || o.name || '';
  if (laneN === 'local') {
    const pid = o.place_id || o.placeId || null;
    if (pid) return 'place:' + String(pid).trim();
    const city = o.city || o.market_city || o.region || '';
    const nslug = _normMarket(name);
    if (nslug) {
      console.warn(`[brandKey] LOCAL fallback (no place_id) name="${name}" city="${city}"`);
      return 'localname:' + nslug + (city ? '-' + _normMarket(String(city).split(',')[0]) : '');
    }
    return null;
  }
  const dom = _rootDomain(o.website || o.url || o.domain || '');
  if (dom) return 'dom:' + dom;
  const nslug = _normMarket(name);
  if (nslug) {
    console.warn(`[brandKey] ${laneN} fallback (no domain) name="${name}"`);
    return 'name:' + nslug;
  }
  return null;
}

// Select the next page of UNSEEN candidates from a local market pool, ranked by
// the caller's priority (then name, so pagination is deterministic and refreshes
// walk the pool without repeats). Identity is compared by _brandKey, NOT by exact
// string, so a suffix/case/whitespace variant of a shown brand is still excluded.
// getName lets callers page items keyed on .name (web pool) or .brand (knowledge
// path). Returns { page, unseenTotal, exhausted }.
function _localNextPage(pool, excludeBrands, pageSize, priorityFn, getName) {
  const nameOf = typeof getName === 'function' ? getName : (f) => f && f.name;
  const excl = new Set((excludeBrands || []).map(_brandKey).filter(Boolean));
  const unseen = (pool || []).filter((f) => { const n = nameOf(f); return n && !excl.has(_brandKey(n)); });
  const pf = typeof priorityFn === 'function' ? priorityFn : () => 0;
  unseen.sort((a, b) => (pf(b) - pf(a)) || String(nameOf(a)).localeCompare(String(nameOf(b))));
  const page = unseen.slice(0, pageSize);
  return { page, unseenTotal: unseen.length, exhausted: unseen.length <= pageSize };
}

async function getDealRecommendations(athlete, role, excludeBrands, lane, opts = {}) {
  // Deal Scan lanes. LOCAL runs the web-search pipeline below; TOP NIL is served
  // from deal_comps only (no web/AI). SOCIAL is served upstream at the endpoint
  // from the curated social_brands index (store.getSocialBrands) and never reaches
  // this function, so there is no social branch here.
  lane = lane || 'local';
  if (lane === 'topnil') {
    return _topnilFromComps(athlete, excludeBrands);
  }

  // Deal Scan uses Sonnet (scoped to this function only) — faster than Opus,
  // strong enough for structured local-brand research.
  const MODEL_DEALSCAN = MODEL_FAST; // web-search business discovery: extraction, runs on the cheap tier
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
  // GROUNDING RULE. The why-yes rule below primes "foot traffic near campus", and a
  // thin candidate (no category, no evidence) gave the model room to name a campus we
  // never mentioned: a Birmingham business came back citing "UConn campus". Naming the
  // wrong school is worse than naming none, so the school/city/state given above are
  // the ONLY ones allowed, and a groundless angle must be dropped, not invented.
  const GROUNDING_RULE = `NEVER name any university, college, campus, city, or landmark other than the exact ones given above for this athlete. Do not guess or substitute a school. If you cannot ground the "why they'd say yes" angle in the facts provided, use a general local angle ("a local business marketing to the same community") instead of inventing a place.`;
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
    // Google place_id is the local brand's stable ledger identity. It comes from
    // the Places pool candidate (meta); the model-scored card never carries it, so
    // read it from meta first. Attach both the id and the resolved brand_key so
    // the route can upsert the engagement ledger and the card can drive retirement.
    const placeId = (meta && meta.place_id) || d.place_id || null;
    const _bkCity = market === 'hometown' ? hometownCity : city;
    return {
      ...d,
      rank: i + 1,
      resultType: 'local',
      lane: 'local',
      isLocal: true,
      source,
      market,
      place_id: placeId,
      brandKey: resolveBrandKey({ place_id: placeId, brand: d.brand, city: _bkCity, lane: 'local' }, 'local'),
      marketLabel: hasHometown ? marketLabelFor(market) : null,
      // Region for the lazy contacts lookup (franchise phone disambiguation).
      // ALWAYS carry a state so the contact locality check can run. A hometown
      // typed without a state falls back to the school's state rather than
      // leaving the region stateless (which would disable the locality check).
      region: market === 'hometown' && hometown
        ? (normalizeState((hometown.split(',').pop() || '').trim()) ? hometown : `${hometown}, ${state}`)
        : `${city}, ${state}`,
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
    // HARD never-repeat + pagination for the fallback path too. The prompt asks
    // the model to exclude shown brands, but that is SOFT: seeded/thin markets
    // (the demo) make the model re-emit the same handful every refresh. Filter by
    // _brandKey so a business shown once is dropped no matter how it is re-phrased,
    // then page 10 at a time. When the filter empties the list, return an empty
    // page flagged exhausted so the UI shows the honest banner instead of repeats.
    const PAGE = 10;
    const page = _localNextPage(parsed, excludeBrands, PAGE, (d) => (d.fitScore || 0), (d) => d.brand);
    console.log(`[dealScan] local shownSet=${new Set((excludeBrands || []).map(_brandKey).filter(Boolean)).size} excluded=${parsed.length - page.unseenTotal} poolAfterExclude=${page.unseenTotal} returned=${page.page.length} poolTotal=${parsed.length} source=knowledge`);
    const cards = page.page.map((d, i) => finalizeLocal(d, i, 'knowledge', d.website || null, null));
    cards._poolExhausted = page.exhausted;
    cards._poolTotal = parsed.length;
    return cards;
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
    const mk = (q, cats) => `Use web search: ${q}. Return 15 to 20 real businesses you actually find. More is better. Return every one you can find, not just the best. Each as {"name","website","category","email","evidence","franchise"}. For EVERY business, actively look for marketing-activity signals: sponsors a high school, youth, or college team; runs local ads or billboards; has done NIL or athlete partnerships before; runs an active promotional social media presence. "evidence": under 12 words describing ONLY what the search actually shows (e.g. "Sponsors Homewood High athletics"), null when nothing found. Never invent evidence. "franchise": true only when it is a locally owned or operated franchise location of a national brand and you can point at the specific location or operator, else false. "email" only if shown on their site, else null. Favor: ${cats}. Output ONLY the JSON array, no commentary before it.`;

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
    // Postgres, keyed by market+lane only (GLOBAL, shared across all agents;
    // TTL 30 days). Live searches run ONLY for cache misses and write through, so
    // once any agent builds a market pool every other agent scanning that market
    // rides it with zero web searches. Phase-2 scoring runs fresh per athlete, and
    // the per-athlete shown-set (rotation) lives on athletes.deal_scan_cache, so
    // the shared pool never collides with per-athlete freshness.
    const normMarket = _normMarket; // shared with resolveLocalMarketKey so keys match
    const schoolCacheKey = `${normMarket(schoolMarket)}:local`;
    const hometownCacheKey = hasHometown ? `${normMarket(hometown)}:local` : null;
    const [schoolCached, hometownCached] = await Promise.all([
      store.getMarketCache(schoolCacheKey),
      hometownCacheKey ? store.getMarketCache(hometownCacheKey) : Promise.resolve(null),
    ]);
    // A thin cached pool (from a partially successful search day) is used AND
    // topped up with a live search, then rewritten, so partial pools speed up
    // the next scan without freezing a bad day for the whole TTL.
    // A pool under 15 is too small to serve 10 fresh cards per scan, so treat it
    // as thin and top it up. The old bar of 5 left small markets permanently starved.
    // COST GUARD: a genuinely small market will never reach 15, so without this it
    // would re-run the widened search on every single scan forever. If the pool was
    // rebuilt within THIN_RETRY_H and is still thin, it can't grow — serve what we
    // have and try again tomorrow. Caps a thin market at one widened pass per day.
    const THIN_RETRY_H = 24;
    const _ageH = (cc) => (Date.now() - new Date(cc.fetchedAt).getTime()) / 3.6e6;
    const _thinEligible = (cc, min) => !!(cc && cc.candidates.length < min && _ageH(cc) >= THIN_RETRY_H);
    const schoolThin = _thinEligible(schoolCached, 15);
    const hometownThin = _thinEligible(hometownCached, 2);
    const _ageD = (cc) => ((Date.now() - new Date(cc.fetchedAt).getTime()) / 8.64e7).toFixed(1);

    const found = [];
    const seen = new Set();
    const addCandidate = (it, market) => {
      const nm = ((it && it.name) || '').trim();
      if (!nm) return;
      // HARD EXCLUDE: corporate businesses where no local manager can approve a deal
      // (Walmart, banks, national grocery/pharmacy, gas stations). Dropped from the
      // pool at ingest, so they never reach selection, caching, or the ledger. Covers
      // cache-served and web-search candidates; the Places builder drops them too.
      if (isNoLocalAuthority(nm)) return;
      // Dedup by _brandKey (not raw lowercase) so a suffix/case variant of a pool
      // business is not re-added, which is what keeps a deepen batch genuinely new.
      const key = _brandKey(nm);
      if (!key || seen.has(key)) return;
      seen.add(key);
      found.push({
        name: nm, website: it.website || null, category: it.category || null,
        email: it.email || null, evidence: it.evidence || null,
        franchise: it.franchise === true, market,
        // Preserve Places extras (present on Places-built + cache-served candidates)
        // so the ledger keys on place_id and ranking tiers by Places type. addCandidate
        // used to strip these, which silently downgraded cached pools to name keys.
        place_id: it.place_id || null,
        types: Array.isArray(it.types) ? it.types : undefined,
        chain: it.chain === true ? true : undefined,
      });
    };
    // ── Manual "Add a Business" injection ─────────────────────────────────────
    // The agent named ONE business and picked its exact Places location. Inject it
    // as the only candidate and skip every discovery step (market cache, Places
    // build, web search): there is nothing to discover. It then flows through the
    // SAME hard-exclude (addCandidate), tier ranking, scoring prompt and
    // finalizeLocal as a scanned business, so a manual card is identical in shape
    // and honesty to a scanned one. Nothing here writes the shared market pool.
    const _isManual = !!(opts && opts.manualCandidate);
    if (_isManual) {
      addCandidate(opts.manualCandidate, 'school');
      if (!found.length) {
        // Only addCandidate can drop it here, and only for the hard-exclude list.
        console.log(`[dealScan] manual add REJECTED name="${(opts.manualCandidate || {}).name}" reason=no_local_authority`);
        const blocked = [];
        blocked._manualBlocked = 'no_local_authority';
        blocked._poolExhausted = true; blocked._poolTotal = 0; blocked._poolUnseen = 0;
        return blocked;
      }
      // Log the exact grounding facts the scoring prompt will receive, so "was the
      // right school passed" is answerable from the logs instead of inferred.
      console.log(`[dealScan] manual add candidate="${found[0].name}" place_id=${found[0].place_id || 'none'} types=${JSON.stringify(found[0].types || [])} | GROUNDING athlete="${athlete.name}" school="${school}" city="${city}" state="${state}" locationKnown=${locationKnown}`);
    }
    // Serve cached markets straight into the pool (market re-tagged from the
    // cache bucket, never trusted from the stored blob). Skipped for a manual add.
    if (schoolCached && !_isManual) for (const cnd of schoolCached.candidates) addCandidate(cnd, 'school');
    if (hometownCached && !_isManual) for (const cnd of hometownCached.candidates) addCandidate(cnd, 'hometown');

    // ── Pagination + never-repeat ─────────────────────────────────────────────
    // excludeBrands is the persisted shown-set for this athlete. Each scan/refresh
    // returns the NEXT unseen businesses from the pool with ZERO web searches until
    // the pool is exhausted for this athlete. Exhaustion is NOT auto-deepened: the
    // agent hits the honest banner and only pays for a deeper pass by clicking
    // "Find more businesses", which sets opts.deepen. That deeper pass searches new
    // categories, a wider radius and next-tier businesses, excluding the whole pool.
    // Compare by _brandKey, not raw string: the shown-set carries names as the
    // model rendered them on the prior scan ("Planet Smoothie, Marietta"), while
    // the pool candidate is "Planet Smoothie". Raw-string exclusion missed those
    // and re-showed businesses on refresh; _brandKey collapses both to one key.
    const _excludeSet = new Set((excludeBrands || []).map(_brandKey).filter(Boolean));
    const _unseenOf = (list) => list.filter((f) => f && f.name && !_excludeSet.has(_brandKey(f.name)));
    const _cacheHadPool = !!(schoolCached || hometownCached);
    // Explicit, on-demand only (never automatic). Deepening a market with no pool
    // yet is just a normal cold scan, so require an existing pool to deepen.
    const deepen = !!(opts && opts.deepen) && _cacheHadPool;
    // Exclude the ENTIRE existing pool (plus the athlete's shown-set) from the
    // deeper pass so the new batch is genuinely new, not a reshuffle of the pool.
    const _deepExcl = deepen
      ? ' Do NOT list any of these businesses already known; they are excluded, find DIFFERENT real ones: ' + Array.from(new Set([...found.map((f) => f.name), ...(excludeBrands || [])])).filter(Boolean).slice(0, 60).join(', ') + '.'
      : '';
    const _poolBefore = found.length;
    if (deepen) console.log(`[dealScan] deepen requested: expanding the ${_poolBefore}-business ${schoolMarket} pool with a deeper search pass`);

    // Per-market cache economics. A HIT that still searches means a thin pool is
    // being topped up or an exhausted pool expanded on demand; a plain HIT fires
    // zero web searches, which is the whole point: a second agent in the same
    // market rides the shared pool for free. SCHOOL_SEARCH_N / HOMETOWN_SEARCH_N are
    // the planned category searches per market (fewer, distinct ones when deepening)
    // and are the single source of truth for both the log and the search +
    // cache-write gating below.
    // Initial cold-market school passes raised 5 -> 8 (folded in pet/home-services,
    // personal-care, and specialty-retail categories). A deeper cold pool gives the
    // first agent in a market room to page/refresh before the rotation window
    // recycles, and reduces how often auto-deepen has to fire. Tradeoff: +3 Haiku
    // web-search calls per cold market build (~+$0.02-0.03, one-time, then cached
    // and shared across every agent in that market). Deepen stays 4 distinct passes.
    const SCHOOL_SEARCH_N = deepen ? 4 : 8, HOMETOWN_SEARCH_N = deepen ? 1 : 2;
    const schoolWillSearch = (!schoolCached || schoolThin || deepen);
    const hometownWillSearch = hasHometown && (!hometownCached || hometownThin || deepen);

    // ── Google Places discovery (school market) ───────────────────────────────
    // For a COLD school build (not deepen), pull the FULL local-business pool from
    // Google Places instead of the handful an LLM recalls. Gated on a real market
    // (locationKnown), a key, and the discovery flag; built at most once per market
    // per 24h. Declared here, AFTER schoolWillSearch/deepen exist, so there is no
    // temporal-dead-zone reference. Falls back to the web-search path when disabled,
    // keyless, geocode/Places fails, or Places returns nothing (G: never delete it).
    let placesSchoolUsed = false;
    const _placesEnabled = (process.env.DEAL_SCAN_DISCOVERY || 'places') !== 'websearch'
      && !!(process.env.GOOGLE_PLACES_API_KEY || '').trim();
    // A manual add never builds the market pool: the business is already chosen.
    const _placesEligible = _placesEnabled && schoolWillSearch && !deepen && locationKnown && !_isManual;
    // #2: log entry visibility, not just success, so a scan that never reaches the
    // build shows WHY (which gate failed).
    console.log(`[dealScan] Places eligible=${_placesEligible} market=${schoolCacheKey} (enabled=${_placesEnabled} schoolWillSearch=${schoolWillSearch} deepen=${deepen} locationKnown=${locationKnown})`);
    if (_placesEligible) {
      if ((opts && opts.forcePlaces) || _placesBuildAllowed(schoolCacheKey)) {
        console.log(`[dealScan] Places branch ENTER market=${schoolCacheKey} force=${!!(opts && opts.forcePlaces)}`);
        try {
          const pr = await buildMarketPoolFromPlaces(school);
          if (pr.ok && pr.candidates.length) {
            _placesBuildRecord(schoolCacheKey);
            for (const c of pr.candidates) {
              const k = _brandKey(c.name);
              if (k && !seen.has(k)) { seen.add(k); found.push(c); }
            }
            placesSchoolUsed = true;
            // Persist the FULL pool now (no truncation), keyed to this market.
            const poolSchool = found.filter((f) => f.market === 'school');
            if (poolSchool.length) store.setMarketCache(schoolCacheKey, poolSchool);
            console.log(`[dealScan] PLACES school market=${schoolCacheKey} poolSize=${poolSchool.length} placesCalls=${pr.placesCalls} elapsedMs=${pr.ms}`);
          } else {
            console.warn(`[dealScan] Places returned nothing (${pr.reason || 'empty'}) for ${schoolCacheKey}; falling back to web search`);
          }
        } catch (e) {
          console.error('[dealScan] Places build threw, falling back to web search:', e.message);
        }
      } else {
        console.log(`[dealScan] Places build for ${schoolCacheKey} skipped by 24h cost guard; using web search`);
      }
    }

    const _mktLog = (key, cached, willSearch, n, thin) => {
      if (!cached) return `[dealScan] market cache key=${key} -> MISS (building pool, ${n} web searches)`;
      if (!willSearch) return `[dealScan] market cache key=${key} -> HIT age=${_ageD(cached)}d (0 web searches)`;
      return `[dealScan] market cache key=${key} -> HIT age=${_ageD(cached)}d ${thin ? 'thin, topping up' : 'expanding on demand'} (${n} web searches)`;
    };
    console.log(_mktLog(schoolCacheKey, schoolCached, schoolWillSearch, SCHOOL_SEARCH_N, schoolThin));
    if (hometownCacheKey) console.log(_mktLog(hometownCacheKey, hometownCached, hometownWillSearch, HOMETOWN_SEARCH_N, hometownThin));

    // Live searches for cache misses (and thin cached pools, topped up).
    // The old two big category bundles asked one call for 8 businesses x 6
    // fields; the JSON regularly blew past max_tokens and truncated, which
    // parsed as empty — so EVERY production scan "found 0" and fell to the
    // knowledge path. Now: smaller single-purpose searches that finish
    // reliably, a 30s cap (parallel, so wall-clock stays about one search),
    // per-call outcome logging, and truncation salvage in the parser.
    const LOCAL_SEARCH_CAP_MS = 30000;
    // Wide geography for a deep pool: the school city PLUS the surrounding metro
    // and nearby towns, not just the city proper.
    const _geo = `in and around ${city}, ${state}, the surrounding metro area, and nearby towns`;
    // Deepen geography: push OUT past the initial pass, to further-out suburbs and
    // neighboring towns, and ask for smaller, independent, next-tier businesses.
    const _geoWide = `in the further-out suburbs and neighboring towns within about 40 miles of ${city}, ${state}, beyond the main metro`;
    const _tierWide = 'Favor smaller, independent, less prominent local businesses, not the biggest or most obvious names. ';
    // A thin market must reach past the city on the NORMAL pass too, not only when
    // the agent manually clicks "Find more". Keeps the metro AND pulls nearby towns.
    const _geoThin = `in and around ${city}, ${state}, the surrounding metro area, and any towns within about 45 miles`;
    const _geoStd = schoolThin ? _geoThin : _geo;
    const searchDefs = [];
    if (_isManual) { /* manual add: no discovery passes, the business is already known */ }
    else if (schoolWillSearch && deepen) {
      // Deeper pass: wider radius (_geoWide) and next tier (_tierWide), excluding the
      // whole existing pool (_deepExcl). Since the initial build was widened to 8
      // categories, three of these overlap the first pass by name but reach FARTHER,
      // next-tier businesses; deep-services-venues stays fully distinct.
      searchDefs.push(
        { label: 'deep-home-pet', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `${_tierWide}pet stores, groomers and veterinary clinics, and home services like HVAC, plumbing, landscaping, roofing, and cleaning companies ${_geoWide}${tagEmphasisQ}${_deepExcl}`,
          'pet services and veterinary, home services, landscaping and cleaning'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'deep-personal-care', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `${_tierWide}barbershops, hair and nail salons, tattoo studios, dance and cheer studios, martial arts gyms, and yoga or pilates studios ${_geoWide}${tagEmphasisQ}${_deepExcl}`,
          'barbershops and salons, tattoo studios, dance and martial arts, yoga and pilates'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'deep-specialty-retail', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `${_tierWide}jewelers, florists, bike shops, outdoor and hunting stores, pharmacies, bookstores, game and hobby shops, and specialty grocers ${_geoWide}${tagEmphasisQ}${_deepExcl}`,
          'jewelers and florists, bike and outdoor shops, game and hobby shops, specialty grocers'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'deep-services-venues', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `${_tierWide}tutoring and test prep, childcare, event and party venues, breweries and taprooms, farmers markets, print shops, and moving or storage companies ${_geoWide}${_deepExcl}`,
          'tutoring and childcare, event venues, breweries and taprooms, print and moving services'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
      );
    } else if (schoolWillSearch && !placesSchoolUsed) {
      searchDefs.push(
        { label: 'school-auto-gym', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `car dealerships, auto services, gyms, and fitness or training facilities ${_geoStd} that sponsor local sports teams or run local ads${tagEmphasisQ}${_deepExcl}`,
          `${catHint}, car dealerships, gyms and training facilities`), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'school-food-nutrition', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `restaurants, bars, coffee shops, food spots, smoothie and supplement shops ${_geoStd} that sponsor school sports or advertise locally${tagEmphasisQ}${_deepExcl}`,
          'restaurants and food spots, coffee shops, smoothie and supplement shops'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'school-retail', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `apparel and clothing stores, sporting goods stores, boutiques, and local retail ${_geoStd} that advertise locally or sponsor teams${tagEmphasisQ}${_deepExcl}`,
          'apparel and local retail, sporting goods stores, boutiques'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'school-wellness', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `chiropractors, physical therapy, med spas, dentists, optometrists, and health and wellness businesses ${_geoStd} that advertise locally or sponsor youth sports${_deepExcl}`,
          'chiropractors and physical therapy, med spas and salons, health and wellness'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'school-services-ent', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `entertainment venues, golf and bowling, real estate agents, banks and credit unions, insurance agencies, and local professional services ${_geoStd} that advertise locally or sponsor local sports${_deepExcl}`,
          'entertainment, real estate agents, banks and credit unions, local professional services'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        // Passes 6-8: folded in from the deepen set so a cold market starts deeper
        // (see SCHOOL_SEARCH_N note above). Standard geo/tier, same as passes 1-5.
        { label: 'school-pet-home', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `pet stores, groomers and veterinary clinics, and home services like HVAC, plumbing, landscaping, roofing, and cleaning companies ${_geoStd} that advertise locally or sponsor local sports${_deepExcl}`,
          'pet services and veterinary, home services, landscaping and cleaning'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'school-personal-care', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `barbershops, hair and nail salons, tattoo studios, dance and cheer studios, martial arts gyms, and yoga or pilates studios ${_geoStd} that advertise locally or sponsor youth sports${tagEmphasisQ}${_deepExcl}`,
          'barbershops and salons, tattoo studios, dance and martial arts, yoga and pilates'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'school-specialty-retail', market: 'school', p: timedSearch(oneShotWebSearch(mk(
          `jewelers, florists, bike shops, outdoor and hunting stores, pharmacies, bookstores, game and hobby shops, and specialty grocers ${_geoStd} that advertise locally or sponsor teams${tagEmphasisQ}${_deepExcl}`,
          'jewelers and florists, bike and outdoor shops, game and hobby shops, specialty grocers'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
      );
    }
    if (_isManual) { /* manual add: no hometown discovery either */ }
    else if (hometownWillSearch && deepen) {
      searchDefs.push(
        { label: 'deep-hometown', market: 'hometown', p: timedSearch(oneShotWebSearch(mk(
          `${_tierWide}pet and home services, salons and barbershops, dance and martial arts studios, jewelers and florists, tutoring, event venues, breweries, and specialty retail in the further-out suburbs and towns within about 40 miles of ${hometown}, beyond the town center${tagEmphasisQ}${_deepExcl}`,
          'next-tier local businesses beyond the town center of ' + hometown), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
      );
    } else if (hometownWillSearch) {
      searchDefs.push(
        { label: 'hometown-core', market: 'hometown', p: timedSearch(oneShotWebSearch(mk(
          `car dealerships, gyms, restaurants, coffee shops, apparel and retail, smoothie and supplement shops in and around ${hometown} that sponsor local youth sports or spend on local marketing${tagEmphasisQ}${_deepExcl}`,
          `${catHint}, car dealerships, restaurants, smoothie and supplement shops in ${hometown}`), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
        { label: 'hometown-services', market: 'hometown', p: timedSearch(oneShotWebSearch(mk(
          `chiropractors, med spas, boutiques, real estate agents, banks, insurance agencies, and entertainment venues in and around ${hometown} that advertise locally or sponsor youth sports${_deepExcl}`,
          'chiropractors, boutiques and local retail, real estate agents, banks, med spas'), searchSys, 2600, 4, MODEL_DEALSCAN), LOCAL_SEARCH_CAP_MS) },
      );
    }

    if (searchDefs.length) {
      const _tSearch = Date.now();
      const outcomes = await Promise.all(searchDefs.map((s) => s.p));
      // FILTER TRACE: track raw model output -> parsed items -> pooled (after the
      // addCandidate dedup/no-name filter), per pass AND in aggregate, so we can see
      // exactly where candidates are lost between the search and the pool.
      let _totalParsed = 0, _totalPooled = 0;
      outcomes.forEach((o, idx) => {
        const def = searchDefs[idx];
        let detail = '';
        if (o.status === 'ok') {
          const before = found.length;
          const { items, salvaged } = extractJsonArrayItems(o.raw);
          for (const it of items) addCandidate(it, def.market);
          const added = found.length - before;
          _totalParsed += items.length; _totalPooled += added;
          detail = items.length
            ? ` parsed=${items.length}${salvaged ? ' (SALVAGED from truncated output)' : ''} pooled=${added} dropped=${items.length - added} (duplicate/no-name)`
            : ` parsed-but-empty (raw ${o.raw.length} chars)`;
        } else if (o.status === 'error') {
          detail = ` — ${o.err}`;
        }
        console.log(`[dealScan] search ${def.label}: ${o.status.toUpperCase()} in ${o.ms}ms${detail}`);
      });
      // Aggregate filter step 1 (parse -> pool, i.e. the addCandidate dedup filter).
      console.log(`[dealScan] FILTER parse->pool: ${_totalParsed} parsed across ${searchDefs.length} passes, ${_totalPooled} pooled, ${_totalParsed - _totalPooled} dropped as duplicate or no-name`);
      console.log(`[dealScan] phase 1 live search found ${found.length} candidates total (${found.filter(f => f.market === 'hometown').length} hometown) in ${Date.now() - _tSearch}ms (elapsed ${Date.now() - _t0}ms)`);
      // On-demand deepen accounting: how many genuinely-new businesses the deeper
      // pass added to the shared pool, and how many web searches it cost.
      if (deepen) console.log(`[dealScan] deepen market=${schoolCacheKey} newFound=${found.length - _poolBefore} webSearches=${searchDefs.length}`);

      // One broadened retry before falling back.
      if (found.length < 3) {
        console.warn(`[dealScan] only ${found.length} candidates — running one broadened retry search`);
        const retryOut = await timedSearch(oneShotWebSearch(
          mk(`popular local businesses, restaurants, gyms, car dealerships and shops in ${city}, ${state}`, 'any local business that advertises locally'),
          searchSys, 1800, 4, MODEL_DEALSCAN
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
      if (schoolWillSearch && !placesSchoolUsed) { // Places already wrote its full pool above
        const poolSchool = found.filter((f) => f.market === 'school');
        if (poolSchool.length >= 1) store.setMarketCache(schoolCacheKey, poolSchool);
        else console.warn(`[dealScan] market cache write SKIPPED ${schoolCacheKey}: 0 school candidates`);
      }
      if (hometownCacheKey && hometownWillSearch) {
        const poolHome = found.filter((f) => f.market === 'hometown');
        if (poolHome.length >= 1) store.setMarketCache(hometownCacheKey, poolHome);
        else console.warn(`[dealScan] market cache write SKIPPED ${hometownCacheKey}: 0 hometown candidates`);
      }
    } else {
      const _src = placesSchoolUsed ? 'Places (no web passes needed)' : 'market cache';
      console.log(`[dealScan] phase 1 served from ${_src}: ${found.length} candidates (${found.filter(f => f.market === 'hometown').length} hometown) in ${Date.now() - _t0}ms`);
    }

    // #1: ONE unambiguous pool-size line on EVERY local scan (cold build, warm
    // cache, or Places), so "did the pool actually build for this market" is never
    // a guess again. schoolPool is the count for the resolved market key.
    const _schoolPoolN = found.filter((f) => f.market === 'school').length;
    const _hometownPoolN = found.filter((f) => f.market === 'hometown').length;
    const _poolSource = placesSchoolUsed ? 'places' : (searchDefs.length ? (_cacheHadPool ? 'cache+websearch' : 'websearch') : 'cache');
    console.log(`[dealScan] POOL market=${schoolCacheKey} schoolPool=${_schoolPoolN} hometownPool=${_hometownPoolN} totalPool=${found.length} source=${_poolSource} locationKnown=${locationKnown}`);

    // Too thin to be a credible local scan. For a REAL market (locationKnown) an
    // empty or near-empty pool means discovery failed or the market is genuinely
    // empty: say so honestly instead of papering over it with model-invented
    // brands (the ~8-count knowledge fallback). Only an UNKNOWN location, where
    // there is no real market to search, falls back to labeled model knowledge.
    // A manual add is EXPECTED to be exactly one candidate, so the thin-pool rule
    // does not apply to it.
    if (found.length < 3 && !_isManual) {
      if (locationKnown) {
        console.error(`[dealScan] LOCAL POOL EMPTY market=${schoolCacheKey} found=${found.length} (locationKnown) -> honest empty, NOT model knowledge`);
        const empty = []; empty._poolExhausted = true; empty._poolTotal = found.length; empty._poolUnseen = 0; return empty;
      }
      const e = new Error(`only ${found.length} web candidates`); e._thinFallback = true; throw e;
    }

    // ── Paginate: score only the NEXT page of UNSEEN businesses ────────────────
    // A deep pool is built once; each scan/refresh shows the next 10 the agent has
    // not seen for this athlete. When nothing unseen remains (even after deepening)
    // return an empty page flagged exhausted so the UI shows the honest banner.
    const PAGE = 10;
    // ── Per-athlete brand engagement ledger drives selection ──────────────────
    // Identity is the brand_key (place_id for local), NOT the display name. The
    // route passes opts.ledger = { byKey, retiredNameSlugs }. Rules (#2):
    //   a. exclude every brand_key that is contacted/responded/closed/dead;
    //   b. fill the page from candidates with NO ledger row (unseen), by fit;
    //   c. if unseen runs dry, backfill from state=shown, oldest last_shown first,
    //      so brands the agent ignored cycle back;
    //   d. only an EMPTY page (no unseen AND no shown) is the exhausted banner.
    // Displaying never retires a brand; the shown upsert happens in the route.
    for (const f of found) {
      if (!f._bk) f._bk = resolveBrandKey({ place_id: f.place_id, brand: f.name, city: (f.market === 'hometown' ? hometownCity : city), lane: 'local' }, 'local');
    }
    const _ledger = (opts && opts.ledger) || {};
    const _ledgerByKey = _ledger.byKey || {};
    const _retiredSlugs = _ledger.retiredNameSlugs instanceof Set ? _ledger.retiredNameSlugs : new Set();
    const _RETIRED = new Set(['contacted', 'responded', 'closed', 'dead']);
    // Type tier feeds selection priority so high-signing types (restaurants,
    // fitness, apparel, auto dealers, nutrition, chiro, med spas) are more likely to
    // reach the scored page, and low types (pet, vet) less likely. Low is a penalty,
    // not a filter: a genuinely great low-type business can still make the page.
    const _tierPriority = (f) => { const t = businessTier(f); return t === 'high' ? 3 : t === 'low' ? -2 : 0; };
    const _candPriority = (f) => {
      const tagHits = deriveMatchedTags({ brand: f.name, category: f.category }, f, athleteTagSubs).length;
      return (tagHits ? 4 + tagHits : 0) + (f.evidence ? 2 : 0) + (f.market === 'hometown' ? 3 : 0) + _tierPriority(f);
    };
    const _isRetired = (f) => {
      const row = f._bk ? _ledgerByKey[f._bk] : null;
      if (row && _RETIRED.has(row.state)) return true;
      // Migration bridge: pre-ledger "worked" brands were name-keyed. Also exclude
      // a candidate whose NAME-slug matches a retired name-keyed row even though we
      // now prefer place_id. A backward-compat guard, not a primary key.
      if (_retiredSlugs.size && _retiredSlugs.has(_brandKey(f.name))) return true;
      return false;
    };
    // A manual add bypasses ledger SELECTION entirely: the agent explicitly asked for
    // this business, so it is the page. Duplicate handling happens in the route
    // (which returns the existing card instead of calling this), and the ledger write
    // still happens afterwards, so nothing here can create a duplicate row.
    const _notRetired = _isManual ? found : found.filter((f) => !_isRetired(f));
    const _excludedContacted = found.length - _notRetired.length;
    const _unseen = _notRetired.filter((f) => !(f._bk && _ledgerByKey[f._bk]));
    const _shownPool = _notRetired.filter((f) => f._bk && _ledgerByKey[f._bk] && _ledgerByKey[f._bk].state === 'shown');
    _unseen.sort((a, b) => _candPriority(b) - _candPriority(a));
    _shownPool.sort((a, b) => (_ledgerByKey[a._bk].lastShownAt || 0) - (_ledgerByKey[b._bk].lastShownAt || 0));
    const _page = _isManual ? found.slice(0, 1) : _unseen.slice(0, PAGE);
    let _shownBackfill = 0;
    if (!_isManual && _page.length < PAGE) {
      const fill = _shownPool.slice(0, PAGE - _page.length);
      _shownBackfill = fill.length;
      for (const f of fill) _page.push(f);
    }
    // #5: one ledger line per scan.
    console.log(`[dealScan] LEDGER athlete=${athlete.id} lane=local unseen=${_unseen.length} shown_backfill=${_shownBackfill} excluded_contacted=${_excludedContacted} page=${_page.length}`);
    console.log(`[dealScan] local poolTotal=${found.length} notRetired=${_notRetired.length} unseen=${_unseen.length} shownPool=${_shownPool.length} returned=${_page.length} source=web`);
    if (_page.length === 0) {
      console.log('[dealScan] local ledger exhausted: no unseen and no shown-backfill');
      const empty = []; empty._poolExhausted = true; empty._poolTotal = found.length; empty._poolUnseen = 0; return empty;
    }

    // Phase 2: score + enrich this page of real businesses (no web search).
    // Hometown spares come from the whole not-retired pool so the reserve backstop
    // can still splice hometown picks in even if none landed on the priority page.
    const hometownFound = _notRetired.filter((f) => f.market === 'hometown');
    if (hasHometown && hometownFound.length === 0) {
      console.warn(`[dealScan] hometown search found 0 viable candidates for "${hometown}" — local lane will be school-market only`);
    }
    // Reserve 2-3 slots for hometown whenever its search found anything viable,
    // so school results cannot crowd them out.
    const reserveHometown = hasHometown ? Math.min(3, hometownFound.length) : 0;
    const wantCount = _page.length;
    const marketScoringLine = hasHometown
      ? `Each candidate carries a "market" field: "school" (${city}, near ${school}) or "hometown" (${hometown} — the athlete GREW UP there; use the hometown-hero angle: local recognition, community ties, "local kid makes good"). Keep the market value from the input.${reserveHometown ? ` HARD REQUIREMENT: include AT LEAST ${reserveHometown} hometown-market pick(s). Those slots are reserved for hometown even if school candidates score higher.` : ''}`
      : `Every candidate is in the school market ("market":"school").`;
    // Map business name -> full candidate (email validation, market/franchise
    // repair, and evidence pass-through in finalize).
    const metaByName = new Map();
    for (const f of found) if (f.name) metaByName.set(f.name.toLowerCase().trim(), f);

    // Only this ledger-selected page (10) is sent to scoring: keeps the output
    // token budget safe (scoring 24 candidates used to truncate the JSON and crash
    // phase 2) AND is the pagination unit. The page was already ranked by fit
    // (unseen by _candPriority, then shown-backfill oldest-first) above.
    const scoreCandidates = _page;
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

${GROUNDING_RULE}

Pick the best ${wantCount} for this athlete (fewer only if fewer are genuinely good — never pad) and score each 1-100. ${WHY_YES_RULE} Candidates with real marketing-activity "evidence" (team sponsorships, local ads, prior NIL or athlete partnerships, active promo social) get a STRONG ranking boost: they are proven local marketers, so the outreach makes sense. Rationale is 1-2 tight sentences MAXIMUM. Compact JSON only: no prose fields beyond the template, no commentary before or after the array. When a candidate has "evidence", CITE it in the rationale (e.g. "already sponsors a local little league team, so athlete deals are a natural next step"). Never invent evidence that is not in the input. For contactEmail: use the email given if present, otherwise info@/owner@/contact@ at the REAL website domain provided — never invent a fake domain; use null if no domain is known. Output ONLY this JSON array sorted by fitScore descending:
[{"rank":1,"brand":"","tier":"local","category":"auto|gym|food|restaurant|nutrition|apparel|finance|insurance|realestate|training|chiro|medspa|local","dealType":"post|reel|ambassador|appearance","campaign":"","rationale":"","estimatedValueLow":${valLow},"estimatedValueHigh":${valHigh},"contactApproach":"","timingNote":"","fitScore":88,"isLocal":true,"market":"school|hometown","isFranchise":false,"matchedTags":[],"contactName":null,"contactTitle":"","contactEmail":"","contactLinkedIn":null}]`;

    // ── Phase 2 scoring: NARROW error boundary with layered recovery ──────────
    // A scoring failure must never discard phase 1's good candidates. Recovery
    // ladder: tolerant salvage of truncated output -> one retry with a reduced
    // candidate set -> deterministic assembly straight from the candidates.
    // The knowledge path is reserved for phase 1 itself producing nothing.
    const scoreSys = 'You are a JSON-only NIL deal API. Output ONLY a valid JSON array. Never fabricate a business, evidence, or an email domain — only use the businesses, evidence, and domains provided.';
    const runScore = async (candList) => {
      const raw = await oneShot(buildScorePrompt(candList), scoreSys, 3500, MODEL_SCORE);
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
      // Assemble only from the ledger-selected page, so a deterministic fallback can
      // never surface a retired (contacted) brand.
      const ranked = [...scoreCandidates].sort((a, b) => (_candPriority(b) + _sportFit(b)) - (_candPriority(a) + _sportFit(a)));
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
      // Feed the type tier into the fit score so high-signing types surface first and
      // low types (pet, vet) sink, without removing anyone. Tier comes from the Places
      // candidate (meta has the raw types); fall back to the card's category. The bump
      // is bounded so a strong low-type business can still out-score a weak high-type.
      // GROUNDING GUARD: a rationale that names a DIFFERENT school than this
      // athlete's is a hallucination ("UConn campus" for a Samford athlete). The
      // prompt forbids it, but a prompt rule is not a guarantee, so catch it
      // deterministically here and replace the sentence with a grounded one. Naming
      // no school is strictly better than naming the wrong one.
      const _bad = _foreignSchoolIn(d.rationale, school);
      if (_bad) {
        console.error(`[dealScan] GROUNDING VIOLATION brand="${d.brand}" athleteSchool="${school}" invented="${_bad}" rationale="${String(d.rationale).slice(0, 140)}"`);
        d.rationale = `Local ${d.category || 'business'} in the ${city} market with natural customer overlap for a ${sport} athlete at ${school}.`;
        d._groundingFixed = true;
      }
      const _tier = businessTier(meta || d);
      d._tier = _tier;
      // Diagnostic: the raw Google types array and both category labels (Places vs the
      // model's) next to the resolved tier, so a mis-tiered business is never a guess.
      console.log(`[dealScan] TIER brand="${d.brand}" rawTypes=${JSON.stringify((meta && meta.types) || null)} placesCat=${meta ? (meta.category || null) : null} modelCat=${d.category || null} -> tier=${_tier}`);
      if (_tier !== 'medium') {
        const bump = _tier === 'high' ? 6 : -6;
        d.fitScore = Math.max(1, Math.min(100, (Number(d.fitScore) || 80) + bump));
      }
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
    // Page was non-empty (an empty page returned the exhausted banner earlier), so
    // this is NOT the exhausted state (#2d: banner only when nothing at all to show).
    localCards._poolExhausted = false;
    localCards._poolTotal = found.length;
    localCards._poolUnseen = _unseen.length; // genuine NEW-brand count drives auto-deepen
    return localCards; // contacts load lazily via /api/agent/brand-contacts (non-blocking)
  } catch (webErr) {
    // Only a DELIBERATE thin-market signal is allowed to fall through to the model-
    // knowledge path. A real discovery failure (bug, ReferenceError, network) must
    // NOT be masked as uncached model-knowledge results — log it loudly and return
    // an honest empty local lane instead (#3).
    if (!(webErr && webErr._thinFallback)) {
      console.error('[dealScan] LOCAL DISCOVERY FAILED (returning honest empty, NOT model knowledge):', webErr && webErr.message);
      if (webErr && webErr.stack) console.error(webErr.stack);
      const empty = []; empty._poolExhausted = true; empty._poolTotal = 0; empty._poolUnseen = 0;
      return empty;
    }
    console.warn('[dealScan] local pool too thin, trying model knowledge:', webErr.message);
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

  const _genT0 = Date.now();
  try {
    const raw = await oneShot(prompt, 'You write authentic, casual-but-professional outreach emails in a real college athlete\'s voice. Output ONLY valid JSON {"subject","body"}, no markdown, no preamble. Never use em dashes or en dashes. Use commas, periods, or separate sentences instead. Never state or assume the athlete\'s gender. Refer to the sport plainly (say \'basketball\', never \'men\'s basketball\' or \'women\'s basketball\'). Do not use he/she/his/her for the athlete, use the athlete\'s name or they/them. No gendered descriptors of any kind.', 1200, MODEL_GEN);
    console.log(`[generateDealPitch] model=${MODEL_GEN} ms=${Date.now() - _genT0}`);
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
    const raw = await oneShot(prompt, 'You write short friendly follow-up emails in a real athlete\'s voice. Output ONLY JSON {"subject","body"}. Never use em dashes or en dashes. Use commas, periods, or separate sentences instead. Never state or assume the athlete\'s gender. Refer to the sport plainly (say \'basketball\', never \'men\'s basketball\' or \'women\'s basketball\'). Do not use he/she/his/her for the athlete, use the athlete\'s name or they/them. No gendered descriptors of any kind.', 500, MODEL_FAST);
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

  const _genT0 = Date.now();
  try {
    const raw = await oneShot(prompt, 'You are a senior NIL agency strategist. Return only valid JSON. No markdown, no code fences, no preamble. Every field must be specific to this athlete and brand, with no placeholder text and no generic statements. Never use em dashes or en dashes. Use commas, periods, or separate sentences instead. Never state or assume the athlete\'s gender. Refer to the sport plainly (say \'basketball\', never \'men\'s basketball\' or \'women\'s basketball\'). Do not use he/she/his/her for the athlete, use the athlete\'s name or they/them. No gendered descriptors of any kind.', 2000, MODEL_GEN);
    console.log(`[generateAthleteBrandKit] model=${MODEL_GEN} ms=${Date.now() - _genT0}`);
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
    const raw = await oneShot(legacyPrompt, 'You are an elite sports agent writing brand outreach. Return only valid JSON. Never use em dashes or en dashes. Use commas, periods, or separate sentences instead. Never state or assume the athlete\'s gender. Refer to the sport plainly (say \'basketball\', never \'men\'s basketball\' or \'women\'s basketball\'). Do not use he/she/his/her for the athlete, use the athlete\'s name or they/them. No gendered descriptors of any kind.', 8000);
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

  const _genT0 = Date.now();
  try {
    const raw = await oneShot(prompt, system, 4000, MODEL_GEN);
    console.log(`[generateOutreach] model=${MODEL_GEN} ms=${Date.now() - _genT0}`);
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
  MODEL_BALANCED,
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
  lookupSchoolLocation,
  resolveLocalMarketKey,
  resolveBrandKey,
  brandNameSlug: _brandKey, // shared name-slug for the ledger migration bridge
  contactAuthorityRank: _contactAuthorityRank, // injected into services/contactLadder
  MANUAL_SOURCE_ORDER,                         // shared wave order for deep lookups
  deepContactCtx,                              // the one deep-lookup ctx, shared by every caller
  runSourceWaves,                              // shared parallel wave engine
  withTimeout,                                 // SOFT cap: resolves to a fallback value
  withDeadline,                                // HARD cap: rejects. See the note at the top.
  toolLoop,                                    // bounded client-side tool turn (assistant)
  // Haiku + web_search primitive. UNCAPPED: every caller must wrap it in
  // withTimeout. The contact ladder does so at 15s; discoverStaffUrl did not, and
  // that is exactly how the 135-school run hung.
  webSearchJson: _contactWebSearchRaw,
  rootDomain: _rootDomain,                     // injected for the cross-domain contact check
  TIER1_RANKS: _TIER1_RANKS,
  prewarmDealEvidence,
  getBrandContacts,
  // Internal evidence helpers exposed for unit tests only.
  _test: {
    _fmtFollowers, _cleanStr, _safeUrl, _primaryFollowers,
    _socialVerdict, _topnilVerdict, _deriveTypicalProfile,
    _buildTopNilCard,
    _isGenericInbox, _validEmail, _normalizePhone, _contactAuthorityRank,
    resolveEmail, _fetchBrandContacts, _contactApproach, getBrandContacts, _phoneLocalityOk,
    _labelTitle, _mergeContacts, _mergeNameKey, _sourceLead, _CONTACT_SOURCES,
    _parseContactsPayload, _extractContactsFromProse, _extractCitationUrls, _splitNames,
    _searchContactSource, _localNextPage, _brandKey,
    _setContactSearchImpl: (fn) => { _contactSearchImpl = fn; },
  },
};
