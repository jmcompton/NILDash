'use strict';
// A fixture brand with the evidence the signing-evidence bar asks for
// (services/signingEvidence): a verified athlete-program page, dated today,
// with a stated follower range that takes any athlete. Tests whose mocked
// social or national lanes must reach the slate call seed() with the brand
// names they hand the lanes, and clear() when done.
//
// The rows carry a sport tag no athlete has, so a real social-pool query
// (sports @> [sport] OR 'all') never returns them: they are evidence for a
// named brand, not stock in anyone's pool.
const TAG = '__evidence_fixture__';
async function seed(pool, brands) {
  for (const b of brands) {
    const slug = String(b).toLowerCase().replace(/[^a-z0-9]+/g, '');
    await pool.query(
      `INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, tier_stated, brand_size, active)
       VALUES ($1,'apparel',$2,ARRAY[$4]::text[],0,99999999,'cash_code',$3,CURRENT_DATE,true,'small',true)
       ON CONFLICT (brand) DO UPDATE SET tier_stated = true, proof_date = CURRENT_DATE, tier_min = LEAST(social_brands.tier_min, 0),
         tier_max = GREATEST(social_brands.tier_max, 99999999), active = true`,
      [b, `https://${slug}.example`, `https://${slug}.example/athletes`, TAG]);
  }
}
// Deal evidence instead, for a brand that must NOT have a program page: a
// logged deal with a source, this month, with an athlete of `followers`.
// Four deals per brand at 1.5k, 6k, 25k and 100k followers, so it is
// comparable (within 4x) for any athlete from a few hundred to 400k.
async function seedDeals(pool, brands) {
  for (const b of brands) {
    for (const f of [1500, 6000, 25000, 100000]) {
      await pool.query(`INSERT INTO deal_comps (brand, followers, sport, source, athlete_name, created_at)
                        VALUES ($1, $2, $3, 'https://news.example/fixture-deal', 'Fixture Athlete', NOW())`, [b, f, TAG]);
    }
  }
}
async function clear(pool, brands) {
  await pool.query(`DELETE FROM deal_comps WHERE brand = ANY($1) AND sport = $2`, [brands, TAG]).catch(() => {});
  await pool.query(`DELETE FROM social_brands WHERE brand = ANY($1) AND sports @> ARRAY[$2]::text[]`, [brands, TAG]).catch(() => {});
}
module.exports = { seed, seedDeals, clear, TAG };
