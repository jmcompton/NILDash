// server/dealScanSeeds.js
// Curated, REAL fallback brands for Deal Scan. When the live web_search step
// underdelivers or times out, lanes top up from these so they are never empty.
// Every entry is a real, verifiable company with a real domain. Emails are left
// null on purpose — validateContactEmail() in ai.js derives a safe address from
// the real domain, so nothing is fabricated.

const SOCIAL_SEEDS = {
  nano: [
    { name: 'Bucked Up',        website: 'buckedup.com',        category: 'supplements', email: null },
    { name: 'Raw Nutrition',    website: 'getrawnutrition.com', category: 'supplements', email: null },
    { name: 'YoungLA',          website: 'youngla.com',         category: 'apparel',     email: null },
    { name: 'Alani Nu',         website: 'alaninu.com',         category: 'energydrink', email: null },
    { name: 'Built Bar',        website: 'builtbar.com',        category: 'nutrition',   email: null },
    { name: 'Manscaped',        website: 'manscaped.com',       category: 'accessories', email: null },
    { name: 'NOCCO',            website: 'nocco.com',           category: 'energydrink', email: null },
    { name: 'Gymshark',         website: 'gymshark.com',        category: 'apparel',     email: null },
  ],
  micro: [
    { name: '1st Phorm',        website: '1stphorm.com',        category: 'supplements', email: null },
    { name: 'Ghost Lifestyle',  website: 'ghostlifestyle.com',  category: 'supplements', email: null },
    { name: 'Celsius',          website: 'celsius.com',         category: 'energydrink', email: null },
    { name: 'Vuori',            website: 'vuoriclothing.com',   category: 'apparel',     email: null },
    { name: 'AG1',              website: 'drinkag1.com',        category: 'nutrition',   email: null },
    { name: 'Rhone',            website: 'rhone.com',           category: 'apparel',     email: null },
    { name: 'Alani Nu',         website: 'alaninu.com',         category: 'energydrink', email: null },
    { name: 'Gymshark',         website: 'gymshark.com',        category: 'apparel',     email: null },
  ],
  mid: [
    { name: 'C4 Energy',        website: 'cellucor.com',        category: 'energydrink', email: null },
    { name: 'Liquid Death',     website: 'liquiddeath.com',     category: 'beverage',    email: null },
    { name: 'BODYARMOR',        website: 'drinkbodyarmor.com',  category: 'energydrink', email: null },
    { name: 'Therabody',        website: 'therabody.com',       category: 'fitness',     email: null },
    { name: 'Lululemon',        website: 'lululemon.com',       category: 'apparel',     email: null },
    { name: 'Celsius',          website: 'celsius.com',         category: 'energydrink', email: null },
  ],
  macro: [
    { name: 'Nike',             website: 'nike.com',            category: 'apparel',     email: null },
    { name: 'Under Armour',     website: 'underarmour.com',     category: 'apparel',     email: null },
    { name: 'Gatorade',         website: 'gatorade.com',        category: 'energydrink', email: null },
    { name: 'New Balance',      website: 'newbalance.com',      category: 'apparel',     email: null },
    { name: 'BODYARMOR',        website: 'drinkbodyarmor.com',  category: 'energydrink', email: null },
  ],
};

const TOPNIL_SEEDS = {
  nano: [
    { name: 'Liquid I.V.',        website: 'liquid-iv.com',       category: 'nutrition',   email: null },
    { name: 'The Players Trunk',  website: 'theplayerstrunk.com', category: 'retail',      email: null },
    { name: 'Barstool Sports',    website: 'barstoolsports.com',  category: 'nil',         email: null },
    { name: 'Smoothie King',      website: 'smoothieking.com',    category: 'food',        email: null },
    { name: 'Lids',               website: 'lids.com',            category: 'retail',      email: null },
    { name: "Raising Cane's",     website: 'raisingcanes.com',    category: 'food',        email: null },
  ],
  micro: [
    { name: "Raising Cane's",     website: 'raisingcanes.com',    category: 'food',        email: null },
    { name: 'Celsius',            website: 'celsius.com',         category: 'energydrink', email: null },
    { name: 'Liquid I.V.',        website: 'liquid-iv.com',       category: 'nutrition',   email: null },
    { name: 'Buffalo Wild Wings', website: 'buffalowildwings.com',category: 'food',        email: null },
    { name: 'Crocs',              website: 'crocs.com',           category: 'apparel',     email: null },
    { name: 'The Players Trunk',  website: 'theplayerstrunk.com', category: 'retail',      email: null },
  ],
  mid: [
    { name: 'Dr Pepper',          website: 'drpepper.com',        category: 'food',        email: null },
    { name: 'Celsius',            website: 'celsius.com',         category: 'energydrink', email: null },
    { name: 'Urban Outfitters',   website: 'urbanoutfitters.com', category: 'retail',      email: null },
    { name: 'Buffalo Wild Wings', website: 'buffalowildwings.com',category: 'food',        email: null },
    { name: 'State Farm',         website: 'statefarm.com',       category: 'finance',     email: null },
  ],
  macro: [
    { name: 'Nike',               website: 'nike.com',            category: 'apparel',     email: null },
    { name: 'Gatorade',           website: 'gatorade.com',        category: 'energydrink', email: null },
    { name: 'Beats by Dre',       website: 'beatsbydre.com',      category: 'tech',        email: null },
    { name: 'Dr Pepper',          website: 'drpepper.com',        category: 'food',        email: null },
    { name: 'State Farm',         website: 'statefarm.com',       category: 'finance',     email: null },
  ],
};

const LOCAL_SEEDS = [
  { name: 'Local Car Dealership',          category: 'auto',       angle: 'The #1 local NIL spender. Dealerships love athlete endorsements for community visibility and showroom appearances.' },
  { name: 'Local Gym / Fitness Studio',    category: 'gym',        angle: 'Gyms near campus sign athletes for credibility, class promos, and member referrals.' },
  { name: 'Campus-Area Restaurant',        category: 'restaurant', angle: 'Popular spots near campus do meal, appearance, and social deals to drive student traffic.' },
  { name: 'Credit Union / Community Bank', category: 'finance',    angle: 'Community lenders sponsor athletes for local goodwill and a younger audience.' },
  { name: 'Local Apparel / Boot Store',    category: 'apparel',    angle: 'Regional retailers run product-plus-post deals tied to game days.' },
  { name: 'Med Spa / Dental Practice',     category: 'health',     angle: 'Local practices value athlete reach with a young, local demographic.' },
  { name: 'Sports Training Facility',      category: 'training',   angle: 'Academies and training centers partner with athletes for camps and lessons.' },
  { name: 'Local Insurance Agency',        category: 'insurance',  angle: 'State Farm/Allstate local agents sponsor athletes for community presence.' },
];

const TIER_ORDER = ['nano', 'micro', 'mid', 'macro'];

function getSeeds(lane, tier) {
  if (lane === 'local') return LOCAL_SEEDS.slice();
  const table = lane === 'social' ? SOCIAL_SEEDS : lane === 'topnil' ? TOPNIL_SEEDS : null;
  if (!table) return [];
  tier = TIER_ORDER.indexOf(tier) === -1 ? 'micro' : tier;
  const out = (table[tier] || []).slice();
  const has = (n) => out.some((x) => x.name.toLowerCase() === n.toLowerCase());
  if (out.length < 8) {
    for (const t of TIER_ORDER) {
      if (t === tier) continue;
      for (const b of (table[t] || [])) {
        if (!has(b.name)) out.push(b);
        if (out.length >= 10) break;
      }
      if (out.length >= 10) break;
    }
  }
  return out;
}

module.exports = { SOCIAL_SEEDS, TOPNIL_SEEDS, LOCAL_SEEDS, getSeeds };
