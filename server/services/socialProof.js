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
    // Strip <script> and <style> blocks first so a tracking snippet or JSON-LD
    // blob can't trigger a match, then require at least one program signal.
    const body = (await resp.text())
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const matched = SIGNALS.find((re) => re.test(body));
    if (!matched) return { ok: false, reason: 'no program language found on page', status_code: status, finalUrl };
    return { ok: true, reason: null, status_code: status, finalUrl, matched: matched.source };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, reason: 'fetch error: ' + e.message, status_code: null, finalUrl: null };
  }
}

module.exports = { SIGNALS, verifySocialProof, findProgramUrl };

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
// Returns { url, via: 'link' | 'fallback' } on the first page that passes, else null.
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
    return v.ok ? (v.finalUrl || u) : null;
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
    if (hit) return { url: hit, via: 'link' };
    if (fetches >= MAX_FETCHES_PER_BRAND) return null;
  }

  // 5. Fallback: try common program paths in order, within the fetch budget.
  for (const p of FALLBACK_PATHS) {
    if (fetches >= MAX_FETCHES_PER_BRAND) break;
    let u;
    try { u = new URL(p, base.origin).href; } catch { continue; }
    const hit = await tryVerify(u);
    if (hit) return { url: hit, via: 'fallback' };
  }

  // 6. Nothing passed.
  return null;
}
