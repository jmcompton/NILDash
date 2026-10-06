// National chain flag list for the Places market builder. Businesses whose name
// matches any entry here are FLAGGED (candidate.chain = true), never dropped, so
// the UI/scoring can treat a corporate-owned national chain (little to no local
// marketing budget, no local decision-maker) differently from an independent.
//
// Edit freely: one lowercase substring per line. Matching is case-insensitive
// substring on the business name, so "starbucks" flags "Starbucks #4821".

const NATIONAL_CHAINS = [
  // Fast food / QSR
  'mcdonald', 'burger king', 'wendy', 'taco bell', 'kfc', 'popeyes', 'chick-fil-a',
  'chick fil a', 'subway', 'jimmy john', 'jersey mike', 'arby', 'sonic drive',
  'dairy queen', 'hardee', 'carl\'s jr', 'whataburger', 'zaxby', 'raising cane',
  'panera', 'chipotle', 'qdoba', 'moe\'s southwest', 'firehouse subs', 'five guys',
  'in-n-out', 'culver', 'jack in the box', 'del taco', 'panda express', 'wingstop',
  // Coffee / drinks
  'starbucks', 'dunkin', 'dutch bros', 'scooter\'s coffee', 'tim hortons',
  'smoothie king', 'tropical smoothie', 'jamba',
  // Casual dining
  'applebee', 'chili\'s', 'olive garden', 'outback', 'texas roadhouse', 'buffalo wild wings',
  'ihop', 'denny', 'cracker barrel', 'red lobster', 'longhorn steakhouse', 'cheesecake factory',
  'red robin', 'tgi friday', 'ruby tuesday', 'waffle house',
  // Grocery / pharmacy / big box
  'walmart', 'target', 'costco', 'sam\'s club', 'kroger', 'publix', 'aldi', 'whole foods',
  'trader joe', 'safeway', 'albertsons', 'winn-dixie', 'food lion', 'meijer', 'heb', 'h-e-b',
  'cvs', 'walgreens', 'rite aid', 'dollar general', 'dollar tree', 'family dollar',
  // Home / hardware / retail
  'home depot', 'lowe\'s', 'lowes home', 'ace hardware', 'tractor supply', 'best buy',
  'bed bath', 'at home', 'hobby lobby', 'michaels', 'petsmart', 'petco', 'pet supplies plus',
  'ross', 't.j. maxx', 'tj maxx', 'marshalls', 'kohl', 'macy', 'jcpenney', 'dillard',
  'old navy', 'gap', 'american eagle', 'hollister', 'foot locker', 'famous footwear',
  'dsw', 'journeys', 'lululemon', 'dick\'s sporting', 'academy sports', 'bass pro', 'cabela',
  'ulta', 'sephora', 'bath & body works', 'gamestop', 'barnes & noble',
  // Fitness / services
  'planet fitness', 'la fitness', 'anytime fitness', 'orangetheory', 'crunch fitness',
  'gold\'s gym', 'crossfit', 'ymca', 'snap fitness', 'f45',
  'great clips', 'supercuts', 'sport clips', 'sally beauty', 'european wax',
  'jiffy lube', 'valvoline', 'firestone', 'midas', 'meineke', 'take 5 oil',
  'aamco', 'discount tire', 'les schwab',
  // Auto dealers (national brands sell through local dealers, but flag the brand names)
  'carmax', 'carvana', 'autonation',
  // Banks / insurance / real estate
  'chase bank', 'wells fargo', 'bank of america', 'pnc bank', 'us bank', 'truist',
  'regions bank', 'fifth third', 'citibank', 'capital one',
  'state farm', 'allstate', 'geico', 'farmers insurance', 'progressive', 'nationwide',
  'liberty mutual', 'american family insurance',
  're/max', 'keller williams', 'coldwell banker', 'century 21', 'exp realty',
  // Misc
  'ups store', 'fedex office', 'orkin', 'terminix', 'servpro', 'stanley steemer',
  // Added after Cypress (2026-10): a store manager at a national chain cannot
  // sign an NIL deal. Sporting goods, auto parts, insurance storefronts,
  // med-spa and dental chains, wireless, rental, entertainment chains.
  'big 5', 'hibbett', 'modell', 'sports authority',
  'autozone', 'o\'reilly auto', 'advance auto', 'napa auto', 'pep boys', 'car-x', 'monro',
  'freeway insurance', 'confie', 'kemper', 'mercury insurance', 'aaa insurance', 'h&r block', 'jackson hewitt', 'liberty tax',
  'laseraway', 'ideal image', 'aspen dental', 'western dental', 'bright now', 'coast dental', 'castle dental', 'gentle dental', 'kaiser permanente',
  'verizon', 't-mobile', 'at&t store', 'cricket wireless', 'metro by t-mobile', 'boost mobile', 'mattress firm',
  'enterprise rent', 'hertz', 'u-haul', 'public storage', 'extra space storage',
  '24 hour fitness', 'eos fitness', 'chuck e. cheese', 'dave & buster', 'round1', 'main event', 'sky zone', 'urban air', 'boot barn', 'skechers',
];

const _lc = NATIONAL_CHAINS.map((s) => String(s).toLowerCase());

// True when a business name contains any national-chain marker.
function isNationalChain(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  return _lc.some((c) => n.indexOf(c) !== -1);
}

// ── IS THIS BUSINESS ACTUALLY A CHAIN OR FRANCHISE LOCATION? ───────────────
// For decisions about WHO to pitch (ownerNameSearch.titleProblem): a founder
// or CEO at a chain location is the parent company's, at a one-location studio
// they are the person we want. So this needs real evidence, not resemblance:
//   - the business name STARTS with a known chain or franchisor, as whole words
//   - not the substring scan above, which matches "Ross Family Dentistry"
//   - not an affiliate brand whose locations are independently owned
//     (CrossFit, YMCA): their founder IS the local owner
//   - not a list entry too ambiguous to be evidence (ross, gap, target ...)
const FRANCHISORS = [
  'healthsource', 'la colombe', 'carvana', 'the joint chiropractic', 'massage envy', 'hand & stone', 'hand and stone',
  'club pilates', 'pure barre', 'corepower yoga', 'yogasix', 'yoga six', 'stretchlab', 'cyclebar', 'rumble boxing',
  'title boxing club', '9round', 'mathnasium', 'kumon', 'sylvan learning', 'huntington learning', 'code ninjas',
  'domino', 'papa john', 'pizza hut', 'little caesars', 'marco\'s pizza', 'jet\'s pizza', 'hungry howie',
  'nike', 'adidas', 'under armour', 'gatorade', 'red bull', 'sweetgreen', 'cava', 'crumbl', 'insomnia cookies',
  'tropical smoothie cafe', 'playa bowls', 'nothing bundt cakes', 'kona ice', 'the ups store', 'sport clips',
  'drybar', 'amazing lash', 'hammer & nails', 'restore hyper wellness', 'iv drip', 'hydration room',
];
const NOT_EVIDENCE = new Set(['crossfit', 'ymca', 'ross', 'gap', 'target', 'at home', 'heb', 'h-e-b', 'kohl', 'macy', 'dillard',
  'journeys', 'dsw', 'cvs', 'kfc', 'ihop', 'f45', 'midas', 'aldi', 'ulta', 'heb', 'denny', 'wendy', 'arby', 'culver', 'hardee', 'outback']);
const _starts = [...new Set(_lc.filter((c) => !NOT_EVIDENCE.has(c)).concat(FRANCHISORS))];
function _esc(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function isChainLocation(name) {
  const n = String(name || '').toLowerCase().replace(/[’']/g, "'").trim();
  if (!n) return null;
  for (const c of _starts) {
    if (new RegExp('^(the\\s+)?' + _esc(c) + "('s|s)?\\b").test(n)) return c;
  }
  return null;
}

module.exports = { NATIONAL_CHAINS, isNationalChain, isChainLocation, FRANCHISORS };
