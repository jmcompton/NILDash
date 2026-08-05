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
];

const _lc = NATIONAL_CHAINS.map((s) => String(s).toLowerCase());

// True when a business name contains any national-chain marker.
function isNationalChain(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  return _lc.some((c) => n.indexOf(c) !== -1);
}

module.exports = { NATIONAL_CHAINS, isNationalChain };
