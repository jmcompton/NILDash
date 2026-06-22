// server/services/university/WebExtractionService.js
// HTTP fetching + Claude AI extraction for university roster pages.
//
// DESIGN:
//   1. Fetch HTML from a given URL (with timeout, retry, user-agent rotation)
//   2. Clean HTML — strip scripts, styles, nav, footer; keep table/list content
//   3. Send cleaned HTML to Claude with a structured extraction prompt
//   4. Return an array of raw athlete objects for scoring
//
// Claude is used as the extraction engine because Sidearm Sports and other
// CMS platforms render slightly different HTML structures per school. CSS
// selector scraping breaks constantly; LLM extraction is robust to layout
// changes as long as the semantic content is present.

'use strict';

const { getClient } = require('../../ai');

// ── Constants ─────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_CHARS   = 80_000;   // Claude context limit safety
const MAX_RETRIES      = 2;
const RETRY_DELAY_MS   = 1_200;

// Rotate user agents to reduce simple bot blocks
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

let _uaIndex = 0;
function nextUserAgent() {
  const ua = USER_AGENTS[_uaIndex % USER_AGENTS.length];
  _uaIndex++;
  return ua;
}

// ── Delay helper ──────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── HTTP fetch with timeout + retry ───────────────────────────────────────
// Uses Node 18+ native fetch (global) — no external package needed.
async function fetchWithRetry(url, attempt = 0) {
  // Node 18+ ships fetch as a global. Verify it's available.
  if (typeof fetch === 'undefined') {
    throw new Error('Native fetch unavailable — requires Node.js 18+');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': nextUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);

    return {
      ok:         res.ok,
      status:     res.status,
      html:       res.ok ? await res.text() : null,
      redirected: res.redirected,
      finalUrl:   res.url,
    };
  } catch (err) {
    clearTimeout(timer);
    if (attempt < MAX_RETRIES) {
      await delay(RETRY_DELAY_MS * (attempt + 1));
      return fetchWithRetry(url, attempt + 1);
    }
    return { ok: false, status: null, html: null, error: err.message };
  }
}

// ── HTML cleaning ─────────────────────────────────────────────────────────
// Removes noise (scripts, styles, SVGs, event handlers) but KEEPS the HTML
// structure — class names, table/list markup, and tag semantics are what
// allow Claude to recognize and group athlete records reliably.
function cleanHtml(html) {
  if (!html) return '';

  let cleaned = html
    // Remove all <script> blocks entirely (JS code, not useful)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Remove all <style> blocks
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Remove <noscript> blocks
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    // Remove SVG blocks
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Strip inline event handlers (onclick, onload, etc.)
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(/ on\w+='[^']*'/gi, '')
    // Strip inline style attributes (verbose, no semantic value)
    .replace(/ style="[^"]*"/gi, '')
    .replace(/ style='[^']*'/gi, '')
    // Strip data-* attributes except data-name, data-position, data-year, data-number
    // (those sometimes carry roster data on Sidearm sites)
    .replace(/ data-(?!name|position|year|number|class|hometown)[a-z-]+="[^"]*"/gi, '')
    // Collapse whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Truncate to stay within Claude context budget
  if (cleaned.length > MAX_HTML_CHARS) {
    cleaned = cleaned.slice(0, MAX_HTML_CHARS) + '\n[... content truncated ...]';
  }

  return cleaned;
}

// ── Claude AI extraction ───────────────────────────────────────────────────
// Sends cleaned page text to Claude and asks for structured athlete data.
async function extractAthletesWithClaude(cleanedText, context) {
  const { universityName, sport, sourceUrl } = context;

  if (!cleanedText || cleanedText.length < 50) {
    return { athletes: [], extractionNotes: 'Page content too short to extract' };
  }

  let client;
  try {
    client = getClient();
  } catch (err) {
    return { athletes: [], extractionNotes: `Claude unavailable: ${err.message}` };
  }

  const prompt = `You are extracting structured athlete roster data from a university athletics webpage.

University: ${universityName}
Sport: ${sport}
Source URL: ${sourceUrl}

The content below is cleaned HTML from the roster page — HTML tags and class names are preserved to help you identify athlete records. Sidearm Sports CMS (used by most NCAA programs) wraps each player in elements with classes like "roster_player", "s-person-card", "roster-card", etc. Look for repeating patterns of player cards/rows.

Page content:
---
${cleanedText}
---

Extract all athletes listed on this page. For each athlete, return a JSON object with these fields:
- name: full name (string, required)
- number: jersey number (string or null)
- position: position abbreviation or full name (string or null)
- year: academic year — Fr, So, Jr, Sr, Grad, RS Fr, etc. (string or null)
- height: height in format like "6-2" or "6'2\"" (string or null)
- weight: weight in pounds as number (integer or null)
- hometown: city, state or city, country (string or null)
- high_school: name of high school or prep school (string or null)
- major: academic major (string or null)

Rules:
1. Only extract athletes who are clearly listed as players/roster members.
2. Do not extract coaches, staff, or support personnel.
3. If a field is not present on the page, use null — do not guess.
4. Return ONLY valid JSON — no explanation, no markdown, no extra text.
5. If the page does not contain a roster (404, redirect, wrong page, CAPTCHA, or login wall), return {"athletes":[],"note":"no roster found"}.

Return format:
{"athletes": [...], "note": "optional extraction note"}`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content?.[0]?.text || '';

    // Parse JSON response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { athletes: [], extractionNotes: 'Claude returned non-JSON response' };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const athletes = Array.isArray(parsed.athletes) ? parsed.athletes : [];

    // Basic sanity filter — must have a name
    const valid = athletes.filter(a => typeof a.name === 'string' && a.name.trim().length > 1);

    return {
      athletes: valid.map(a => ({
        name:        (a.name || '').trim(),
        number:      a.number   != null ? String(a.number).trim()   : null,
        position:    a.position != null ? String(a.position).trim() : null,
        year:        a.year     != null ? String(a.year).trim()     : null,
        height:      a.height   != null ? String(a.height).trim()   : null,
        weight:      a.weight   != null ? parseInt(a.weight, 10) || null : null,
        hometown:    a.hometown   != null ? String(a.hometown).trim()   : null,
        high_school: a.high_school != null ? String(a.high_school).trim() : null,
        major:       a.major    != null ? String(a.major).trim()    : null,
      })),
      extractionNotes: parsed.note || null,
    };
  } catch (err) {
    return { athletes: [], extractionNotes: `Extraction error: ${err.message}` };
  }
}

// ── Parse Sidearm JSON API response directly ──────────────────────────────
function parseSidearmJson(rawJson) {
  try {
    const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;

    // Sidearm returns { roster: [...] } or { players: [...] } or just an array
    const list = parsed.roster || parsed.players || parsed.data || (Array.isArray(parsed) ? parsed : null);
    if (!list || !list.length) return { athletes: [], extractionNotes: 'Sidearm API: empty roster' };

    const athletes = list.map(p => ({
      name:        [p.firstname, p.lastname].filter(Boolean).join(' ').trim() || p.name_full || p.name || null,
      number:      p.jersey != null ? String(p.jersey).trim() : null,
      position:    p.position || p.pos || null,
      year:        p.academic_year || p['class'] || p.year || null,
      height:      p.height || (p.height_ft != null ? `${p.height_ft}-${p.height_in || 0}` : null),
      weight:      p.weight ? parseInt(p.weight, 10) || null : null,
      hometown:    [p.hometown_city, p.hometown_state || p.hometown_country].filter(Boolean).join(', ') || p.hometown || null,
      high_school: p.highschool || p.high_school || null,
      major:       p.major || null,
    })).filter(a => a.name && a.name.length > 1);

    return { athletes, extractionNotes: `Sidearm JSON API: ${athletes.length} athletes parsed directly` };
  } catch (err) {
    return { athletes: [], extractionNotes: `Sidearm JSON parse error: ${err.message}` };
  }
}

// ── Main export: fetch + extract from a single URL ────────────────────────
// Returns:
//   { ok, status, athletes[], fetchMs, extractionNotes, error? }
async function fetchAndExtract(url, context) {
  const t0 = Date.now();

  // 1. Fetch
  const fetchResult = await fetchWithRetry(url);
  const fetchMs = Date.now() - t0;

  if (!fetchResult.ok) {
    return {
      ok:             false,
      status:         fetchResult.status,
      athletes:       [],
      fetchMs,
      extractionNotes: null,
      error:          fetchResult.error || `HTTP ${fetchResult.status}`,
    };
  }

  // 2a. If source is flagged as JSON (Sidearm API), parse directly — no Claude needed
  if (context.isJson) {
    const extraction = parseSidearmJson(fetchResult.html);
    return {
      ok:              true,
      status:          fetchResult.status,
      athletes:        extraction.athletes,
      fetchMs,
      extractionNotes: extraction.extractionNotes,
      redirected:      fetchResult.redirected,
      finalUrl:        fetchResult.finalUrl,
    };
  }

  // 2b. HTML path: clean then send to Claude
  const cleanedText = cleanHtml(fetchResult.html);

  // 3. Extract via Claude
  const extraction = await extractAthletesWithClaude(cleanedText, context);

  return {
    ok:              true,
    status:          fetchResult.status,
    athletes:        extraction.athletes,
    fetchMs,
    extractionNotes: extraction.extractionNotes,
    redirected:      fetchResult.redirected,
    finalUrl:        fetchResult.finalUrl,
  };
}

// ── Batch: fetch + extract from multiple sources ───────────────────────────
// Processes sources sequentially to be polite to servers.
// Stops early if Tier 1 source yields ≥5 athletes.
async function fetchAndExtractAll(sources, context, { stopEarlyOnTier1 = true } = {}) {
  const results = [];

  for (const source of sources) {
    // Merge source-level flags (like isJson) into context for this fetch
    const sourceContext = { ...context, isJson: !!source.isJson };
    const result = await fetchAndExtract(source.url, sourceContext);
    results.push({ source, ...result });

    // Early exit: if Tier 1 gave us a good result, skip lower tiers
    if (stopEarlyOnTier1 && source.tier === 1 && result.ok && result.athletes.length >= 5) {
      console.log(`[WebExtraction] Tier 1 success (${result.athletes.length} athletes) — skipping remaining sources`);
      break;
    }

    // Brief pause between requests to avoid hammering servers
    await delay(800);
  }

  return results;
}

module.exports = { fetchAndExtract, fetchAndExtractAll, cleanHtml };
