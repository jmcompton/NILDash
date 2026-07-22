// Best-effort Instagram handle finder: fetch a business website and extract the
// first real instagram.com/<handle> link. Cached 30 days (lane 'instagram').
// Returns null on any failure — the caller falls back to a search link. Never
// guesses a handle.
const store = require('../store');
const TIMEOUT_MS = 8000;
const CACHE_DAYS = 30;
const BAD = new Set(['p','reel','reels','explore','tv','stories','accounts','about','developer','directory','legal','privacy','safety','help','sitemap','www']);

function _extractHandle(html) {
  if (!html) return null;
  const re = /instagram\.com\/(?:#!\/)?@?([A-Za-z0-9._]{2,30})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const h = m[1].replace(/\/+$/, '').toLowerCase();
    if (h && !BAD.has(h)) return h;
  }
  return null;
}

async function findInstagram(website) {
  if (!website) return null;
  let url = String(website).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let domain;
  try { domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return null; }

  try {
    const cached = await store.getBrandEvidence(domain, 'instagram', CACHE_DAYS);
    if (cached && cached.evidence) { const ev = cached.evidence; return ev.found === false ? null : (ev.handle || null); }
  } catch (_) { /* fall through */ }

  let html = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NILDashBot/1.0)' } });
    clearTimeout(t);
    if (!resp.ok) { console.warn('[instagram] ' + domain + ' http=' + resp.status); return null; }
    html = await resp.text();
  } catch (e) { console.warn('[instagram] ' + domain + ' error=' + e.message); return null; }

  const handle = _extractHandle(html);
  if (!handle) {
    try { await store.saveBrandEvidence(domain, 'instagram', website, null, { found: false }, 'NONE'); } catch (_) {}
    console.log('[instagram] ' + domain + ' found=0');
    return null;
  }
  try { await store.saveBrandEvidence(domain, 'instagram', website, null, { found: true, handle: handle }, 'OK'); } catch (_) {}
  console.log('[instagram] ' + domain + ' found=1 handle=' + handle);
  return handle;
}

module.exports = { findInstagram };
