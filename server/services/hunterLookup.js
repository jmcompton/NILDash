// Hunter.io Domain Search: given a business domain, return the emails Hunter has
// for it (personal + generic) so callers can build an email ladder — matched
// decision-maker first, any real person next, a real generic inbox last. Cached
// 30 days per domain in brand_evidence_cache (lane 'hunter'). Any failure returns
// null. NEVER guesses an address — only returns emails Hunter actually has.
const store = require('../store');

const SEARCH_URL = 'https://api.hunter.io/v2/domain-search';
const TIMEOUT_MS = 20000;
const CACHE_DAYS = 30;
const LIMIT = 5;

async function findDomainEmails(domain) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey || !domain) return null;
  const key = String(domain).toLowerCase();

  try {
    const cached = await store.getBrandEvidence(key, 'hunter', CACHE_DAYS);
    if (cached && cached.evidence) {
      const ev = cached.evidence;
      return ev.found === false ? null : ev;
    }
  } catch (_) { /* fall through */ }

  const params = new URLSearchParams({ domain: key, limit: String(LIMIT), api_key: apiKey });

  const _attempt = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(SEARCH_URL + '?' + params.toString(), { signal: ctrl.signal });
      clearTimeout(t);
      if (!resp.ok) { console.warn('[hunter] @' + key + ' http=' + resp.status); return { httpFail: true }; }
      return { json: await resp.json() };
    } catch (e) { clearTimeout(t); return { err: e }; }
  };

  let r = await _attempt();
  if (r.err) { console.warn('[hunter] @' + key + ' retry after error=' + r.err.message); r = await _attempt(); }
  if (r.httpFail) return null;
  if (r.err) { console.warn('[hunter] @' + key + ' error=' + r.err.message); return null; }

  const d = r.json && r.json.data;
  const raw = (d && Array.isArray(d.emails)) ? d.emails : [];
  const emails = raw.map((e) => ({
    email: e.value || null,
    type: e.type || null,
    confidence: typeof e.confidence === 'number' ? e.confidence : 0,
    firstName: e.first_name || null,
    lastName: e.last_name || null,
    position: e.position || null,
  })).filter((e) => e.email);

  if (!emails.length) {
    try { await store.saveBrandEvidence(key, 'hunter', domain, null, { found: false }, 'NONE'); } catch (_) {}
    console.log('[hunter] @' + key + ' found=0');
    return null;
  }
  const out = { found: true, emails: emails };
  try { await store.saveBrandEvidence(key, 'hunter', domain, null, out, 'OK'); } catch (_) {}
  const _p = emails.filter((e) => e.type === 'personal').length;
  const _g = emails.filter((e) => e.type === 'generic').length;
  console.log('[hunter] @' + key + ' found=' + emails.length + ' personal=' + _p + ' generic=' + _g);
  return out;
}

module.exports = { findDomainEmails };
