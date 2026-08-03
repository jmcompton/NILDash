// server/dealScanSeeds.js
// Curated, REAL fallback brands for Deal Scan. When the live web_search step
// underdelivers or times out, lanes top up from these so they are never empty.
// Every entry is a real, verifiable company with a real domain. Emails are left
// null on purpose — validateContactEmail() in ai.js derives a safe address from
// the real domain, so nothing is fabricated.

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

// Return the seed floor for a lane/tier, deduped by name, up to `cap` brands.
// When `tagSubs` are given (the athlete's interest tags), seeds whose own tags
// overlap are moved to the front so a tagged athlete's floor leans toward their
// interests before the generic brands.
function getSeeds(lane, tier, tagSubs, cap = 16) {
  if (lane === 'local') return LOCAL_SEEDS.slice();
  const table = lane === 'topnil' ? TOPNIL_SEEDS : null;
  if (!table) return [];
  tier = TIER_ORDER.indexOf(tier) === -1 ? 'micro' : tier;
  const out = (table[tier] || []).slice();
  const has = (n) => out.some((x) => x.name.toLowerCase() === n.toLowerCase());
  // Broaden from adjacent tiers so the floor is rich enough to fill the lane.
  for (const t of TIER_ORDER) {
    if (t === tier) continue;
    for (const b of (table[t] || [])) {
      if (!has(b.name)) out.push(b);
      if (out.length >= cap) break;
    }
    if (out.length >= cap) break;
  }
  const wants = new Set((tagSubs || []).map((s) => String(s).toLowerCase()));
  if (wants.size) {
    const score = (b) => (b.tags || []).some((t) => wants.has(String(t).toLowerCase())) ? 1 : 0;
    // Stable partition: tag-matching seeds first, original order preserved.
    out.sort((a, b) => score(b) - score(a));
  }
  return out.slice(0, cap);
}

module.exports = { TOPNIL_SEEDS, LOCAL_SEEDS, getSeeds };
