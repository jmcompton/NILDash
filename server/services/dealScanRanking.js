'use strict';
// Deal Scan local-business ranking + hard-exclude lists. These lists are the
// SINGLE, editable source of truth for two things:
//   1. NO_LOCAL_AUTHORITY: national/corporate businesses that are DROPPED from the
//      local pool because no local manager can approve an athlete deal (corporate
//      sets the marketing budget, so an agent calling the store wastes the call).
//   2. Type tiers: how often a business TYPE actually signs athletes, fed into the
//      fit score so the good types surface first. Low types are ranked down, never
//      removed, because fit varies by athlete.
// Edit the arrays below freely. No other file hard-codes these decisions.

// ── 1. HARD EXCLUDE: corporate-controlled, no local decision-maker ───────────
// A business whose name matches any entry here is DROPPED from the local pool
// (not flagged, not ranked low: removed). One lowercase token per entry; matching
// is case-insensitive and WORD-BOUNDARY based, so "shell" hits "Shell" and "Shell
// Station" but not "Bombshell Salon", and "chase" hits "Chase Bank" but not
// "purchase". Add or remove entries as needed.
const NO_LOCAL_AUTHORITY = [
  // Big box / supercenters / warehouse clubs
  'walmart', 'wal-mart', 'target', 'costco', "sam's club", 'sams club', "bj's wholesale",
  'kmart', 'meijer',
  // National grocery chains
  'kroger', 'publix', 'aldi', 'whole foods', 'trader joe', 'safeway', 'albertsons',
  'winn-dixie', 'food lion', 'harris teeter', 'sprouts', 'heb', 'h-e-b', 'giant eagle',
  'wegmans', 'vons', 'ralphs',
  // National pharmacy chains
  'cvs', 'walgreens', 'rite aid', 'duane reade',
  // Retail banks (national + regional: corporate marketing)
  'chase', 'wells fargo', 'bank of america', 'pnc bank', 'us bank', 'u.s. bank', 'truist',
  'regions bank', 'fifth third', 'citibank', 'citizens bank', 'capital one', 'td bank',
  'huntington bank', 'ally bank',
  // Gas stations / fuel brands
  'shell', 'exxon', 'mobil', 'chevron', 'chevron station', 'circle k', 'quiktrip', 'quik trip',
  'racetrac', 'wawa', 'sheetz', 'speedway', 'phillips 66', 'valero', 'sunoco', 'citgo',
  '7-eleven', '7 eleven', "casey's general", "love's travel", 'pilot travel', 'flying j',
  'buc-ee', 'kwik trip', 'kwik star',
  // Dollar stores
  'dollar general', 'dollar tree', 'family dollar',
];

const _noAuthRe = NO_LOCAL_AUTHORITY.map(
  (s) => new RegExp('\\b' + String(s).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
);

// True when a business name matches any hard-exclude entry (word-boundary match).
function isNoLocalAuthority(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  return _noAuthRe.some((re) => re.test(n));
}

// ── 2. TYPE TIERS: how often a business type signs athletes ──────────────────
// Keyed on the Google Places `types` array first (most precise), then the
// normalized `category` for web-search / model-knowledge candidates that carry no
// Places types. High types get a fit-score boost; low types a penalty; everything
// else is neutral. Low is checked before high so a pet/vet business that also
// carries a generic type is not accidentally promoted.
const HIGH_TIER_TYPES = [
  'restaurant', 'cafe', 'bar', 'meal_takeaway', 'bakery', // food + drink
  'gym',                                                  // fitness
  'clothing_store', 'shoe_store',                         // apparel
  'car_dealer',                                           // auto dealers
];
const LOW_TIER_TYPES = [
  'pet_store', 'veterinary_care',                         // pet stores, vet clinics
  'supermarket', 'pharmacy', 'gas_station', 'convenience_store', 'hardware_store',
];
// Category-keyword fallback (substring on the normalized category string).
const HIGH_TIER_CATEGORIES = [
  'restaurant', 'food', 'coffee', 'bar', 'gym', 'fitness', 'apparel', 'dealership',
  'nutrition', 'supplement', 'smoothie', 'chiro', 'chiropract', 'medspa', 'med spa',
];
const LOW_TIER_CATEGORIES = ['pet', 'vet', 'veterinary', 'animal'];

function _typesHitAny(list, types) {
  for (const t of types) { if (list.indexOf(t) !== -1) return true; }
  return false;
}
function _catHitAny(list, category) {
  const c = String(category || '').toLowerCase();
  if (!c) return false;
  return list.some((k) => c.indexOf(k) !== -1);
}

// Return 'high' | 'medium' | 'low' for a candidate. Places types win; category is
// the fallback for candidates that have no types.
function businessTier(candidate) {
  const c = candidate || {};
  const types = Array.isArray(c.types) ? c.types.map((t) => String(t).toLowerCase()) : [];
  if (types.length) {
    if (_typesHitAny(LOW_TIER_TYPES, types)) return 'low';
    if (_typesHitAny(HIGH_TIER_TYPES, types)) return 'high';
  }
  if (_catHitAny(LOW_TIER_CATEGORIES, c.category)) return 'low';
  if (_catHitAny(HIGH_TIER_CATEGORIES, c.category)) return 'high';
  return 'medium';
}

module.exports = {
  NO_LOCAL_AUTHORITY, isNoLocalAuthority,
  HIGH_TIER_TYPES, LOW_TIER_TYPES, HIGH_TIER_CATEGORIES, LOW_TIER_CATEGORIES, businessTier,
};
