'use strict';
// Social lane proof verification — the SINGLE gate that decides whether a brand's
// program page is real. Fetch the page, require HTTP 200, then require at least one
// program-language signal on the body (after stripping <script>/<style> so a
// tracking snippet or JSON-LD blob can't trigger a false match).
//
// Shared verbatim by the admin verify-seed / reverify endpoints AND the nightly
// social discovery job, so there is exactly one implementation. NEVER weaken the
// 200 check or the SIGNALS language check — AI-proposed candidates must pass THIS.
const SIGNALS = [
  /\bambassador/i,
  /\baffiliate/i,
  /creator program/i,
  /brand partner/i,
  /become a rep/i,
  /sponsored athlete/i,
  /\bname,? image/i,
  /\bnil\b(?!\s*\))/i,
];

// A STATED follower threshold: a number (optionally with commas / a k suffix)
// sitting within ~30 chars of an audience word (follower/followers/following/
// audience), in EITHER order. Proximity is required so a bare figure with no
// audience word nearby ("50K prize", "$25K giveaway", "1,000 reviews") does NOT
// count as a tier statement. Matches "10k followers", "5,000 followers",
// "audience of 12,000", "50K+ audience".
const _AUDIENCE = '(?:followers?|following|audience)';
const _NUM = '\\d[\\d,]*\\+?\\s*k?';
const TIER_STATED_RE = new RegExp(
  '\\b' + _NUM + '\\b[\\s\\S]{0,30}?\\b' + _AUDIENCE + '\\b' +
  '|\\b' + _AUDIENCE + '\\b[\\s\\S]{0,30}?\\b' + _NUM + '\\b',
  'i'
);

// True when a URL's path is effectively the site root: empty, "/", "/home", or
// "/index.html" after dropping query string and hash. Used to reject a program
// path that 301s to the homepage (the program page is gone).
function isHomepage(url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '').toLowerCase();
    return p === '' || p === '/home' || p === '/index.html';
  } catch { return false; }
}

function _decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&#0*34;|&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&[a-z0-9#]+;/gi, ' '); // any remaining entity -> space
}

// Build a READABLE proofSnippet plus a tierStated flag from the verified page.
// verifySocialProof matches SIGNALS against the tag-laden body (a term can live in
// an href/class/meta); this reads the same page but works on tag-stripped prose so
// the snippet is human-readable. Snippet extraction and tier detection are kept
// independent: a failure of one never zeroes the other. Never affects pass/fail.
// reason distinguishes the three cases: 'matched' (the term verifySocialProof
// matched was in the prose), 'alternate_signal' (that term was markup-only but the
// prose states a different program signal), 'markup_only' (no signal in the prose).
function _proofEvidence(body, matchedRe) {
  const text = _decodeEntities(String(body).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  // Tier detection stands on its own: a stated follower threshold ANYWHERE in the
  // readable text counts, even when snippet extraction below finds nothing.
  const tierStated = TIER_STATED_RE.test(text);

  const snippetAround = (m) => {
    const idx = m.index, len = m[0].length;
    const start = Math.max(0, idx - 150);
    const end = Math.min(text.length, idx + len + 150);
    let snip = text.slice(start, end);
    if (start > 0) snip = snip.replace(/^\S*\s+/, '');         // drop a partial leading word
    if (end < text.length) snip = snip.replace(/\s+\S*$/, ''); // drop a partial trailing word
    const stop = Math.max(snip.lastIndexOf('. '), snip.lastIndexOf('! '), snip.lastIndexOf('? '));
    if (stop >= 40) snip = snip.slice(0, stop + 1);            // prefer a sentence boundary
    return snip.trim() || null;
  };

  // Consider a candidate snippet and either accept it (return the result object)
  // or reject it (log the reason and return null). _rejectSnippet returns a reason
  // string when the snippet reads like footer/nav chrome rather than program prose.
  const consider = (m, reason) => {
    const snip = snippetAround(m);
    if (!snip) return null;
    const rej = _rejectSnippet(snip);
    if (rej) { console.log(`[socialProof] snippet rejected (${rej}) path=${reason}: ${snip.slice(0, 90)}`); return null; }
    return { proofSnippet: snip, tierStated, reason };
  };

  // 1. Primary: the SAME term verifySocialProof matched, in the prose. Accept only
  //    if its snippet passes the chrome filters.
  const primary = new RegExp(matchedRe.source, 'i').exec(text);
  if (primary) { const r = consider(primary, 'matched'); if (r) return r; }

  // 2. Fallback: the matched term was markup-only OR its snippet was chrome. Walk
  //    every occurrence of every SIGNALS term and take the first CLEAN snippet (a
  //    nav /affiliate link often pairs with body copy elsewhere saying "ambassador"
  //    or "become a rep").
  for (const re of SIGNALS) {
    const rx = new RegExp(re.source, 'ig');
    let alt;
    while ((alt = rx.exec(text)) !== null) {
      if (alt[0].length === 0) { rx.lastIndex++; continue; }
      const r = consider(alt, 'alternate_signal');
      if (r) return r;
    }
  }

  // 3. Every candidate was chrome (or there is no program language in the prose).
  //    Snippet null; tierStated already computed independently above.
  return { proofSnippet: null, tierStated, reason: 'markup_only' };
}

// Reject a candidate snippet that reads like footer social links or a nav menu
// rather than program copy. Returns a short reason string when rejected, else
// null. Applied to both the primary and alternate_signal candidates.
const _VERB_WORDS = ['you', 'your', 'we', 'our', 'can', 'will', 'receive', 'earn', 'get', 'apply', 'join', 'become', 'offers', 'provides', 'includes'];
const _SOCIAL_PLATFORMS = ['instagram', 'facebook', 'twitter', 'tiktok', 'youtube', 'pinterest', 'linkedin'];
function _rejectSnippet(s) {
  const t = String(s || '').trim();
  if (!t) return 'empty';
  const lower = t.toLowerCase();

  // Legacy chrome tells: many pipe separators or a skip-link / menu-toggle phrase.
  if ((t.match(/\|/g) || []).length > 2) return 'pipes';
  if (/skip to content|skip to main|toggle menu/i.test(t)) return 'skip-link';

  const words = lower.split(/\s+/).filter(Boolean);

  // 1. REPETITION: any lowercased 2-word sequence appears 3+ times (e.g. footer
  //    "Visit our facebook Visit our x Visit our youtube").
  if (words.length >= 2) {
    const bigrams = Object.create(null);
    for (let k = 0; k < words.length - 1; k++) {
      const bg = words[k] + ' ' + words[k + 1];
      bigrams[bg] = (bigrams[bg] || 0) + 1;
      if (bigrams[bg] >= 3) return 'repetition';
    }
  }

  // 2. SOCIAL PLATFORM DENSITY: 3+ distinct platform names means a share bar.
  let distinct = 0;
  for (const p of _SOCIAL_PLATFORMS) if (lower.indexOf(p) !== -1) distinct++;
  if (distinct >= 3) return 'social-density';

  // 3. ALL CAPS: >50% of words with 3+ letters are entirely uppercase (nav menus
  //    like "HAND & STONE TREATMENTS SPAVIA TREATMENTS").
  const longWords = t.split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ''))
    .filter((w) => w.length >= 3);
  if (longWords.length) {
    let caps = 0;
    for (const w of longWords) if (w === w.toUpperCase()) caps++;
    if (caps / longWords.length > 0.5) return 'all-caps';
  }

  // 4. LOW VERB DENSITY: program copy addresses the reader. Reject if no
  //    reader-addressing word is present.
  const wordSet = new Set(words);
  if (!_VERB_WORDS.some((v) => wordSet.has(v))) return 'low-verb';

  return null;
}

// One-time, insert-time AI summary of a verified program page. Called ONLY by the
// admin verify-seed / reverify endpoints and the nightly discovery job -- NEVER on
// the scan path, which stays a pure DB read with zero AI calls. One Haiku call, no
// web search. Returns one plain sentence, or null on NONE / empty / too long / any
// error. A failed summary must never block an insert.
async function summarizeProgram(pageText) {
  // SUMDIAG: temporary diagnostic logging at every exit so a live reverify run
  // reveals why a summary comes back null. Logic is unchanged.
  const text = String(pageText || '').slice(0, 6000).trim();
  console.log(`[socialProof][SUMDIAG] pageTextLen=${text.length}`);
  try {
    if (!text) { console.log('[socialProof][SUMDIAG] null reason=empty_pagetext'); return null; }
    const ai = require('../ai');
    const prompt = 'Here is the text of a brand\'s athlete or creator program page. In ONE sentence under 25 words, state what an athlete gets by joining. Be concrete about compensation if the page mentions it. Write plainly, no marketing language, no exclamation points. If the page does not actually describe a program, return exactly NONE.\n\n' + text;
    const raw = await ai.oneShot(prompt, 'You summarize brand program pages in one plain, factual sentence. Output only the sentence, or exactly NONE.', 120, ai.MODEL_FAST);
    const out = String(raw || '').trim().replace(/^["']+|["']+$/g, '').trim();
    if (!out || out.toUpperCase() === 'NONE') { console.log(`[socialProof][SUMDIAG] null reason=none_response raw=${String(raw || '').slice(0, 200)}`); return null; }
    const words = out.split(/\s+/).filter(Boolean).length;
    if (words > 40) { console.log(`[socialProof][SUMDIAG] null reason=too_long words=${words} raw=${String(raw || '').slice(0, 200)}`); return null; }
    console.log(`[socialProof][SUMDIAG] ok summary=${out}`);
    return out;
  } catch (e) {
    console.log(`[socialProof][SUMDIAG] null reason=threw err=${e.message}`);
    return null;
  }
}

async function verifySocialProof(proofUrl) {
  if (!proofUrl) return { ok: false, reason: 'missing proof_url', status_code: null, finalUrl: null };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(proofUrl, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' },
    });
    clearTimeout(t);
    const status = resp.status;
    const finalUrl = resp.url || proofUrl;
    if (status !== 200) return { ok: false, reason: 'non-200 status', status_code: status, finalUrl };
    // A program path that redirects to the homepage means the program page is gone:
    // the requested URL was a specific page but we landed on the site root. Fail it
    // (independent of SIGNALS) so findProgramUrl moves on to the next candidate and
    // reverify retires the row. A directly-supplied homepage proof_url is unaffected.
    if (!isHomepage(proofUrl) && isHomepage(finalUrl)) {
      return { ok: false, reason: 'redirected to homepage', status_code: status, finalUrl };
    }
    // Strip <script> and <style> blocks first so a tracking snippet or JSON-LD
    // blob can't trigger a match, then require at least one program signal.
    const body = (await resp.text())
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const matched = SIGNALS.find((re) => re.test(body));
    if (!matched) return { ok: false, reason: 'no program language found on page', status_code: status, finalUrl };
    // Capture what was matched for the card. Does not affect the pass/fail above.
    // proofReason is 'matched' | 'alternate_signal' | 'markup_only'.
    const { proofSnippet, tierStated, reason: proofReason } = _proofEvidence(body, matched);
    // Tag-stripped visible text of the verified page, surfaced so an insert point can
    // summarize it once (summarizeProgram) without refetching. Does not affect pass/fail.
    const pageText = _decodeEntities(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    return { ok: true, reason: null, status_code: status, finalUrl, matched: matched.source, proofSnippet, tierStated, proofReason, pageText };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, reason: 'fetch error: ' + e.message, status_code: null, finalUrl: null };
  }
}

module.exports = { SIGNALS, verifySocialProof, findProgramUrl, summarizeProgram };

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
// A link is a program-page candidate if its href OR its anchor text mentions any
// of these. Scoring only; the real decision is still verifySocialProof.
const PROGRAM_LINK_RE = /ambassador|affiliate|creator|become a rep|partner with us|nil|college/i;
// Tried in order when the homepage yields no verifiable program link.
const FALLBACK_PATHS = [
  '/pages/ambassador', '/pages/ambassadors', '/pages/affiliate', '/pages/affiliates',
  '/pages/creators', '/pages/college', '/pages/nil', '/ambassador', '/affiliate', '/pages/become-a-rep',
];
const MAX_FETCHES_PER_BRAND = 8; // homepage + verify attempts, so cost stays bounded

// findProgramUrl(website): the server finds a brand's OWN ambassador / affiliate /
// creator program page from its homepage, instead of asking the model to guess a
// URL. Fetches the homepage, scores same-domain links, verifies the top few, then
// tries common program paths. Every candidate URL still goes through
// verifySocialProof (200 + SIGNALS), so nothing is trusted without the gate.
// Returns { url, via: 'link' | 'fallback', snippet, tierStated } on the first page
// that passes, else null.
async function findProgramUrl(website) {
  if (!website) return null;
  let base;
  try {
    let w = String(website).trim();
    if (!/^https?:\/\//i.test(w)) w = 'https://' + w;
    base = new URL(w);
  } catch { return null; }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;

  let fetches = 0;
  const tryVerify = async (u) => {
    if (fetches >= MAX_FETCHES_PER_BRAND) return null;
    fetches++;
    const v = await verifySocialProof(u);
    return v.ok ? { url: v.finalUrl || u, snippet: v.proofSnippet || null, tierStated: !!v.tierStated, pageText: v.pageText || '' } : null;
  };

  // 1. Fetch the homepage.
  let html = '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(base.href, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': BROWSER_UA } });
    clearTimeout(t);
    fetches++; // homepage fetch counts toward the budget
    if (resp.ok) html = await resp.text();
  } catch { /* no homepage -> go straight to fallback paths */ }

  // 2-3. Parse <a href>, resolve same-domain absolutes, score by program keywords.
  const scored = [];
  if (html) {
    const baseHost = base.hostname.replace(/^www\./, '');
    const seen = new Set();
    const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      const text = String(m[2] || '').replace(/<[^>]*>/g, ' ');
      let abs;
      try { abs = new URL(href, base.href); } catch { continue; }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
      const host = abs.hostname.replace(/^www\./, '');
      if (host !== baseHost && !host.endsWith('.' + baseHost)) continue; // same registrable domain
      const key = abs.href.split('#')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      const score = (PROGRAM_LINK_RE.test(href) ? 1 : 0) + (PROGRAM_LINK_RE.test(text) ? 1 : 0);
      if (score > 0) scored.push({ url: key, score });
    }
    scored.sort((a, b) => b.score - a.score);
  }

  // 4. Verify the top 3 scoring links; first pass wins.
  for (const s of scored.slice(0, 3)) {
    const hit = await tryVerify(s.url);
    if (hit) return { url: hit.url, via: 'link', snippet: hit.snippet, tierStated: hit.tierStated, pageText: hit.pageText };
    if (fetches >= MAX_FETCHES_PER_BRAND) return null;
  }

  // 5. Fallback: try common program paths in order, within the fetch budget.
  for (const p of FALLBACK_PATHS) {
    if (fetches >= MAX_FETCHES_PER_BRAND) break;
    let u;
    try { u = new URL(p, base.origin).href; } catch { continue; }
    const hit = await tryVerify(u);
    if (hit) return { url: hit.url, via: 'fallback', snippet: hit.snippet, tierStated: hit.tierStated, pageText: hit.pageText };
  }

  // 6. Nothing passed.
  return null;
}
