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

module.exports = { SIGNALS, verifySocialProof };
