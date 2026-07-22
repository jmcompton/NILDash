// Hunter.io Email Finder: owner name + business domain -> verified email.
// Cached 30 days in brand_evidence_cache (lane 'hunter') so Hunter is billed at
// most once per person per month. Any failure returns null; only surfaces an
// email at or above MIN_SCORE confidence, never a guess.
const store = require('../store');

const FINDER_URL = 'https://api.hunter.io/v2/email-finder';
const TIMEOUT_MS = 20000;
const CACHE_DAYS = 30;
const MIN_SCORE = 50;

function _key(domain, first, last) {
  return String(domain || '').toLowerCase() + '|' + String(first || '').toLowerCase() + '|' + String(last || '').toLowerCase();
}

async function findEmail(firstName, lastName, domain) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey || !domain || !firstName) return null;

  const cacheKey = _key(domain, firstName, lastName);
  try {
    const cached = await store.getBrandEvidence(cacheKey, 'hunter', CACHE_DAYS);
    if (cached && cached.evidence) {
      const ev = cached.evidence;
      return ev.found === false ? null : ev;
    }
  } catch (_) { /* fall through to live lookup */ }

  const params = new URLSearchParams({ domain: domain, first_name: firstName, api_key: apiKey });
  if (lastName) params.set('last_name', lastName);

  const _attempt = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(FINDER_URL + '?' + params.toString(), { signal: ctrl.signal });
      clearTimeout(t);
      if (!resp.ok) { console.warn('[hunter] ' + firstName + ' @' + domain + ' http=' + resp.status); return { httpFail: true }; }
      return { json: await resp.json() };
    } catch (e) {
      clearTimeout(t);
      return { err: e };
    }
  };
  let data = null;
  let r = await _attempt();
  if (r.err) {
    console.warn('[hunter] ' + firstName + ' @' + domain + ' retry after error=' + r.err.message);
    r = await _attempt();
  }
  if (r.httpFail) return null;
  if (r.err) { console.warn('[hunter] ' + firstName + ' @' + domain + ' error=' + r.err.message); return null; }
  data = r.json;

  const d = data && data.data;
  const email = d && d.email;
  const score = d && typeof d.score === 'number' ? d.score : 0;
  if (!email || score < MIN_SCORE) {
    try { await store.saveBrandEvidence(cacheKey, 'hunter', domain, null, { found: false }, 'NONE'); } catch (_) {}
    console.log('[hunter] ' + firstName + ' @' + domain + ' found=0 score=' + score);
    return null;
  }
  const out = { found: true, email: email, score: score };
  try { await store.saveBrandEvidence(cacheKey, 'hunter', domain, null, out, 'OK'); } catch (_) {}
  console.log('[hunter] ' + firstName + ' @' + domain + ' found=1 score=' + score);
  return out;
}

module.exports = { findEmail };
