'use strict';
// ── IS THIS THE SAME BUSINESS? ───────────────────────────────────────────────
//
// One answer, in one place, because there were three and they disagreed.
//
//   scout.normBrand   lowercase + flatten punctuation to spaces. Collapsed 0 of
//                     9 realistic variant pairs.
//   ai._brandKey      strips punctuation, drops a comma suffix and a
//                     parenthetical. Better, still name-only, not exported.
//   ai.resolveBrandKey  place_id or root domain. The RIGHT answer -- and the
//                     slate dedupe ignored it in favour of the display name,
//                     which is the thing that varies.
//
// So the same owner arrived twice as "Cahaba Brewing Company" and "Cahaba
// Brewing Co.", carrying the SAME place_id, and both got a card.
//
// THREE BASES, STRONGEST FIRST. The basis travels with the key so a caller can
// tell a certain match from a probable one, and so the collapse log can show
// whether the weakest one is doing real work.
//
//   place    a Google place_id. Two rows with one place_id are one storefront.
//   domain   the root domain, normalised. Protocol, www., path, query and
//            trailing slash are not identity.
//   name     normalised name plus market. THE FALLBACK, and the only one that
//            can be wrong: two genuinely different businesses sharing a name in
//            one market collapse into one. Rare, and the trade is deliberate --
//            but it is why the basis is on every log line.

// Suffixes that are legal or decorative rather than identifying. Stripped only
// from the END, so "Company Bakery" keeps its first word.
const SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'l l c', 'ltd', 'limited', 'co', 'corp',
  'corporation', 'company', 'plc', 'lp', 'llp', 'pllc', 'pc', 'sa', 'nv', 'bv',
  'gmbh', 'group', 'holdings', 'enterprises',
]);

// Root domain: last two labels. The multi-part TLD case (a.co.uk) is a known
// limitation, the same one _rootDomain already accepts, and these are US
// businesses.
function normDomain(url) {
  let s = String(url || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // protocol
  s = s.split(/[/?#]/)[0];                        // path, query, fragment
  s = s.replace(/:\d+$/, '');                     // port
  s = s.replace(/^www\./, '');                    // www.
  s = s.replace(/\.+$/, '');                      // trailing dots
  if (!s || !s.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  const parts = s.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join('.');
}

function normName(s) {
  let out = String(s || '').toLowerCase();
  out = out.replace(/\([^)]*\)/g, ' ');       // "(Homewood)"
  out = out.split(',')[0];                    // ", Birmingham"
  out = out.replace(/&/g, ' and ');           // "Board & Brew" == "Board and Brew"
  out = out.replace(/['’`]/g, '');            // "Jerry's" == "Jerrys"
  out = out.replace(/[^a-z0-9]+/g, ' ').trim();
  out = out.replace(/^the\s+/, '');           // "The Hall CP" == "Hall CP"
  // Strip trailing legal/decorative suffixes, repeatedly: "Brewing Co Inc".
  let words = out.split(' ').filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  out = words.join(' ');
  return out || null;
}

function normMarket(s) {
  const m = String(s || '').toLowerCase().split(',')[0];
  return m.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

// The one entry point. Accepts anything shaped like a candidate, a queue row or
// an outreach row, because all three ask the same question.
function identityOf(c, opts = {}) {
  const o = c || {};
  const place = o.place_id || o.placeId || null;
  if (place) return { key: 'place:' + String(place).trim(), basis: 'place' };

  const dom = normDomain(o.website || o.url || o.domain || o.site || '');
  if (dom) return { key: 'dom:' + dom, basis: 'domain' };

  // An existing brand_key may already BE a strong key. Honour it rather than
  // throwing it away for a name -- that discarding is the whole bug.
  const bk = String(o.brand_key || o.brandKey || '').trim();
  if (/^place:/.test(bk)) return { key: bk, basis: 'place' };
  if (/^dom:/.test(bk)) return { key: 'dom:' + (normDomain(bk.slice(4)) || bk.slice(4)), basis: 'domain' };

  const name = normName(o.brand_name || o.brandName || o.brand || o.name || '');
  if (!name) return { key: null, basis: null };
  const mkt = normMarket(o.market_key || o.marketKey || o.market || o.city || o.region || opts.market || '');
  return { key: 'name:' + name + (mkt ? '@' + mkt : ''), basis: 'name' };
}

function keyOf(c, opts) { return identityOf(c, opts).key; }

// EVERY identity a row can produce, not just its strongest. This is what makes
// the two-pool case work: brand_engagement hands us a place_id and the market
// pool hands us only a name, so the same brewery arrives under `place:ChIJabc`
// and `name:cahaba brewing@birmingham-al`. Comparing strongest-to-strongest they
// never touch, and both get a card -- which is precisely the bug. A row occupies
// all of its identities and collides on ANY overlap.
function identitiesOf(c, opts = {}) {
  const o = c || {};
  const out = [];
  const push = (key, basis) => { if (key && !out.some((x) => x.key === key)) out.push({ key, basis }); };

  const place = o.place_id || o.placeId || null;
  if (place) push('place:' + String(place).trim(), 'place');

  const dom = normDomain(o.website || o.url || o.domain || o.site || '');
  if (dom) push('dom:' + dom, 'domain');

  const bk = String(o.brand_key || o.brandKey || '').trim();
  if (/^place:/.test(bk)) push(bk, 'place');
  else if (/^dom:/.test(bk)) push('dom:' + (normDomain(bk.slice(4)) || bk.slice(4)), 'domain');

  // The name is ALWAYS added, even when a stronger key exists, because the
  // weaker copy of the same business may carry nothing else.
  const name = normName(o.brand_name || o.brandName || o.brand || o.name || '');
  if (name) {
    const mkt = normMarket(o.market_key || o.marketKey || o.market || o.city || o.region || opts.market || '');
    push('name:' + name + (mkt ? '@' + mkt : ''), 'name');
  }
  return out;
}

// Collapse a ranked list, keeping the FIRST occurrence -- callers rank before
// calling, so first is best. Returns the survivors and a record of every
// collapse for the caller to log.
function dedupe(list, opts = {}) {
  const seen = new Map();      // key -> the candidate that claimed it
  const kept = [];
  const collapses = [];
  for (const c of (list || [])) {
    const ids = identitiesOf(c, opts);
    if (!ids.length) { kept.push(c); continue; }   // unidentifiable: never silently dropped
    // Collide on the FIRST identity already taken. Ordered strongest-first, so a
    // place_id match is reported as such even when the name also matches.
    let hit = null;
    for (const id of ids) {
      const w = seen.get(id.key);
      if (w) { hit = { id, winner: w }; break; }
    }
    if (hit) {
      collapses.push({ key: hit.id.key, basis: hit.id.basis, winner: hit.winner.c, loser: c,
        winnerKeys: hit.winner.ids.map((x) => x.key), loserKeys: ids.map((x) => x.key) });
      // The loser's OTHER identities are claimed for the winner too, so a third
      // copy matching only on the loser's name still collapses into the winner
      // rather than starting a second group.
      for (const id of ids) if (!seen.has(id.key)) seen.set(id.key, hit.winner);
      continue;
    }
    const entry = { c, ids };
    for (const id of ids) seen.set(id.key, entry);
    kept.push(c);
  }
  return { kept, collapses };
}

// One line per collapse, with everything needed to judge whether the weakest
// basis is earning its place: both names, both keys, both pools, and which key
// decided it.
function describeCollapse(x, tag) {
  const nm = (c) => (c && (c.brand_name || c.brand || c.name)) || '(unnamed)';
  const bk = (c) => (c && (c.brand_key || c.brandKey)) || '(no key)';
  const pl = (c) => (c && (c.pool || c.lane)) || '(no pool)';
  return `[${tag || 'dedupe'}] collapsed "${nm(x.loser)}" into "${nm(x.winner)}" `
    + `on ${id(x)} (basis=${x.basis}) — `
    + `winner: key=${bk(x.winner)} pool=${pl(x.winner)} | `
    + `loser: key=${bk(x.loser)} pool=${pl(x.loser)}`;
}
function id(x) { return x && x.key; }

module.exports = { identityOf, identitiesOf, keyOf, dedupe, describeCollapse, normDomain, normName, normMarket, SUFFIXES };
