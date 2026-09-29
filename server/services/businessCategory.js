'use strict';
// ── WHAT KIND OF BUSINESS THIS IS, IN ONE WORD THE WHOLE APP AGREES ON ──────
//
// Three features need to ask "is this the same kind of business as that one":
// the skip penalty (an agent who skips four coffee shops is telling us
// something), the diversity rule (five cards should not be five restaurants),
// and the card itself. They must agree, or an agent skips "coffee" and the
// slate keeps offering "cafe".
//
// The raw values arrive from three places that do not share a vocabulary:
//
//   Google Places   primaryType / types[]: meal_takeaway, hair_care,
//                   beauty_salon, car_dealer ... (services/placesMarket maps a
//                   subset already; this is the same map, widened, in one place
//                   both can use)
//   the market scan the model's own "category" field, free text, whatever it
//                   felt like: "Coffee Shop", "coffee shop", "cafe/bakery"
//   social_brands   category on the verified index: apparel, supplement, ...
//
// A NULL IS NOT A CATEGORY. An unknown category comes back null, and every
// caller treats null as "we do not know" rather than as a bucket. Bucketing the
// unknowns together would make the diversity rule count two businesses we know
// nothing about as two different kinds, and make the skip penalty punish every
// uncategorised business because one of them was skipped.

// The vocabulary. Deliberately coarse: these are the distinctions an agent
// would actually make when they say "stop sending me gyms", not a taxonomy.
const CATEGORIES = [
  'restaurant', 'coffee', 'bar', 'food',
  'gym', 'wellness', 'salon', 'medspa', 'health',
  'apparel', 'retail', 'supplement',
  'auto', 'dealership', 'realestate', 'insurance', 'bank',
  'services', 'education', 'entertainment', 'pet',
];
const VALID = new Set(CATEGORIES);

// Google Places types -> our word. Superset of placesMarket.TYPE_CATEGORY, which
// covers only the types it searches; a card can carry a primaryType from any
// lookup, so the map has to be wider than the search list.
const PLACES_TYPE = {
  restaurant: 'restaurant', meal_takeaway: 'restaurant', meal_delivery: 'restaurant',
  cafe: 'coffee', coffee_shop: 'coffee',
  bar: 'bar', night_club: 'bar', liquor_store: 'bar',
  bakery: 'food', supermarket: 'retail', grocery_or_supermarket: 'retail', convenience_store: 'retail',
  gym: 'gym', fitness_center: 'gym', sports_complex: 'gym', stadium: 'entertainment',
  // HEALTH is its own kind: an orthodontist or a physical therapy clinic is not
  // a med spa, and for a sports team it is one of the best sponsors there is.
  spa: 'wellness', physiotherapist: 'health', chiropractor: 'health', veterinary_care: 'pet',
  hair_care: 'salon', beauty_salon: 'salon', nail_salon: 'salon', barber_shop: 'salon',
  dentist: 'health', dental_clinic: 'health', doctor: 'health', medical_clinic: 'health', hospital: 'health',
  medical_lab: 'health', pharmacy: 'retail', credit_union: 'bank',
  clothing_store: 'apparel', shoe_store: 'apparel', jewelry_store: 'retail',
  car_dealer: 'dealership', car_repair: 'auto', car_wash: 'auto', car_rental: 'auto',
  bicycle_store: 'retail', pet_store: 'pet', book_store: 'retail', furniture_store: 'retail',
  home_goods_store: 'retail', hardware_store: 'retail', florist: 'retail',
  sporting_goods_store: 'retail', electronics_store: 'retail', department_store: 'retail',
  real_estate_agency: 'realestate', insurance_agency: 'insurance', bank: 'bank',
  accounting: 'services', lawyer: 'services', moving_company: 'services', storage: 'services',
  plumber: 'services', electrician: 'services', roofing_contractor: 'services', painter: 'services',
  school: 'education', university: 'education', library: 'education',
  movie_theater: 'entertainment', bowling_alley: 'entertainment', amusement_park: 'entertainment',
};

// Free-text hints, checked as substrings after the exact maps miss. Ordered:
// the first match wins, so the more specific words come first ("coffee shop"
// must not be caught by "shop").
const TEXT_HINTS = [
  // Specific phrases before the single words they contain: "bar and grill" is
  // a bar, not a grill; a salad or juice bar is not a bar.
  ['bar and grill', 'bar'], ['sports bar', 'bar'], ['wine bar', 'bar'], ['cocktail', 'bar'], ['beer', 'bar'],
  ['juice bar', 'food'], ['smoothie', 'food'], ['salad', 'restaurant'],
  ['nail bar', 'salon'], ['brow bar', 'salon'], ['blow dry', 'salon'],
  ['coffee', 'coffee'], ['cafe', 'coffee'], ['café', 'coffee'], ['espresso', 'coffee'], ['roaster', 'coffee'],
  ['restaurant', 'restaurant'], ['steak', 'restaurant'], ['sushi', 'restaurant'], ['ramen', 'restaurant'],
  ['noodle', 'restaurant'], ['buffet', 'restaurant'], ['bistro', 'restaurant'], ['cafeteria', 'restaurant'],
  ['food court', 'restaurant'], ['tea house', 'coffee'], ['diner', 'restaurant'], ['pizzeria', 'restaurant'], ['pizza', 'restaurant'],
  ['taco', 'restaurant'], ['burger', 'restaurant'], ['barbecue', 'restaurant'], ['bbq', 'restaurant'],
  ['grill', 'restaurant'], ['eatery', 'restaurant'], ['deli', 'restaurant'], ['sandwich', 'restaurant'],
  ['brewery', 'bar'], ['brewing', 'bar'], ['taproom', 'bar'], ['brewpub', 'bar'], ['pub', 'bar'],
  ['bar', 'bar'], ['winery', 'bar'], ['distillery', 'bar'], ['cantina', 'bar'],
  ['bakery', 'food'], ['donut', 'food'], ['dessert', 'food'], ['candy', 'food'], ['chocolate', 'food'],
  ['confection', 'food'], ['bagel', 'food'], ['acai', 'food'], ['smoothie', 'food'], ['juice', 'food'], ['ice cream', 'food'], ['creamery', 'food'],
  ['supplement', 'supplement'], ['nutrition', 'supplement'], ['vitamin', 'supplement'],
  ['gym', 'gym'], ['fitness', 'gym'], ['crossfit', 'gym'], ['martial art', 'gym'], ['jiu', 'gym'],
  ['yoga', 'wellness'], ['pilates', 'wellness'], ['spa', 'wellness'], ['massage', 'wellness'],
  ['med spa', 'medspa'], ['medspa', 'medspa'], ['dermatol', 'medspa'], ['aesthetic', 'medspa'],
  ['chiroprac', 'health'], ['physical therap', 'health'], ['physiotherap', 'health'], ['sports medicine', 'health'],
  ['dental', 'health'], ['dentist', 'health'], ['orthodont', 'health'], ['optometr', 'health'], ['podiatr', 'health'],
  ['urgent care', 'health'], ['pediatric', 'health'], ['medical', 'health'], ['clinic', 'health'],
  ['recovery', 'wellness'], ['wellness', 'wellness'],
  ['salon', 'salon'], ['barber', 'salon'], ['hair', 'salon'], ['nail', 'salon'], ['tattoo', 'salon'],
  ['apparel', 'apparel'], ['clothing', 'apparel'], ['boutique', 'apparel'], ['outfitter', 'apparel'],
  ['footwear', 'apparel'], ['shoe', 'apparel'],
  ['outdoor', 'retail'], ['sporting goods', 'retail'], ['hardware', 'retail'], ['jewel', 'retail'],
  ['florist', 'retail'], ['flower', 'retail'], ['bookstore', 'retail'], ['grocer', 'retail'],
  ['dealership', 'dealership'], ['dealer', 'dealership'], ['motors', 'dealership'],
  ['auto', 'auto'], ['tire', 'auto'], ['collision', 'auto'], ['mechanic', 'auto'],
  ['real estate', 'realestate'], ['realty', 'realestate'], ['realtor', 'realestate'],
  ['insurance', 'insurance'],
  ['bank', 'bank'], ['credit union', 'bank'], ['financial', 'bank'],
  ['veterinar', 'pet'], ['groomer', 'pet'], ['pet', 'pet'],
  ['tutor', 'education'], ['academy', 'education'], ['test prep', 'education'], ['childcare', 'education'],
  ['theater', 'entertainment'], ['theatre', 'entertainment'], ['bowling', 'entertainment'],
  ['golf', 'entertainment'], ['venue', 'entertainment'], ['event', 'entertainment'],
  ['hvac', 'services'], ['plumb', 'services'], ['landscap', 'services'], ['roofing', 'services'],
  ['cleaning', 'services'], ['moving', 'services'], ['storage', 'services'], ['print', 'services'],
  ['law', 'services'], ['account', 'services'], ['agency', 'services'],
  ['store', 'retail'], ['shop', 'retail'], ['market', 'retail'], ['retail', 'retail'],
];

function _clean(v) {
  return String(v == null ? '' : v).toLowerCase().trim().replace(/\s+/g, ' ');
}

// One raw value -> one of CATEGORIES, or null when we genuinely cannot tell.
function normalise(raw) {
  const s = _clean(raw);
  if (!s) return null;
  const snake = s.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (VALID.has(s)) return s;
  if (PLACES_TYPE[snake]) return PLACES_TYPE[snake];
  if (VALID.has(snake)) return snake;
  // Google's specific types arrive snake_cased ("ice_cream_shop",
  // "dental_clinic"); the hints are written with spaces.
  const spaced = s.replace(/_/g, ' ');
  for (const [needle, cat] of TEXT_HINTS) if (spaced.includes(needle)) return cat;
  return null;
}

// The best category a business descriptor can offer, from whichever field it
// happens to carry. Ordered by how much the source actually knows:
//
//   1. an explicit category somebody already resolved
//   2. Places' own primaryType, then its types[] in order
//   3. the business NAME, which is a guess and the last resort -- "Cahaba
//      Brewing Company" is a bar, and a name is often all the market pool has
//
// nameOnly is reported back so a caller can tell a known category from an
// inferred one; the diversity rule counts both, the skip penalty uses both, and
// nothing pretends a guess is a lookup.
function categoryOf(b) {
  const o = b || {};
  const tryOne = (v) => normalise(v);
  const direct = tryOne(o.businessCategory) || tryOne(o.business_category)
    || tryOne(o.category) || tryOne(o.categoryHint);
  if (direct) return { category: direct, nameOnly: false };
  const pt = tryOne(o.primaryType) || tryOne(o.primary_type);
  if (pt) return { category: pt, nameOnly: false };
  const types = Array.isArray(o.types) ? o.types : [];
  for (const t of types) { const c = tryOne(t); if (c) return { category: c, nameOnly: false }; }
  const byName = tryOne(o.brand_name || o.brandName || o.brand || o.name);
  if (byName) return { category: byName, nameOnly: true };
  return { category: null, nameOnly: false };
}

module.exports = { normalise, categoryOf, CATEGORIES, VALID };
