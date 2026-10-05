'use strict';
// ── A NATIONAL OR SOCIAL BRAND IS A LEAD ONLY IF IT SIGNS ATHLETES LIKE THIS ONE
//
// Nike came up 10 times in one night across six agents. Nike is not going to
// sign a Division I softball player off a cold email; offering it is a
// fantasy, and it tells the agent we do not understand the business. The
// national lane ranked brands by how many NIL deals were logged against them,
// which is exactly how the incumbents rise to the top.
//
// THE BAR, for the national and the social lane alike: evidence WE FOUND, with
// a source, that the brand signed or partnered with a COMPARABLE athlete in
// the last 12 months. Comparable: within 4x of this athlete's reach (not a
// top draft pick or an Olympian). Two kinds count:
//   deal     a logged NIL deal (deal_comps) with a source, ingested in the
//            last 12 months, with an athlete of comparable reach, never one
//            with a draft status
//   program  an athlete or ambassador program page we verified in the last
//            12 months (social_brands) whose STATED follower range includes
//            this athlete: they partner with athletes of exactly this size
// No evidence, no card.
//
// HARD REFUSE, evidence or not: the household incumbents of their category.
//
// Once the bar is met, ranked: a public program to apply to first (the most
// valuable find), then DTC / growth-stage over national, then athletes signed
// in this athlete's own sport.
//
// Every card records its size band and its evidence (outreach_queue.size_band,
// signing_evidence) so reply rate by band can be measured, not asserted
// (scripts/lane-band-report.js).

// The household incumbents. A college athlete reaching them cold is not a
// real outcome. Matched on whole words at the start of the brand name.
const INCUMBENTS = [
  'nike', 'jordan brand', 'air jordan', 'adidas', 'under armour', 'new balance', 'puma', 'reebok', 'asics', 'converse',
  'gatorade', 'powerade', 'bodyarmor', 'body armor', 'coca-cola', 'coca cola', 'coke', 'pepsi', 'pepsico', 'red bull',
  'monster energy', 'prime hydration', 'beats by dre', 'beats', 'apple', 'samsung', 'google', 'amazon', 'microsoft',
  'ea sports', 'electronic arts', 'mcdonald', 'mcdonald\'s', 'walmart', 'target', 'verizon', 'at&t', 't-mobile',
  'state farm', 'geico', 'allstate', 'progressive', 'dick\'s sporting goods', 'foot locker', 'oakley', 'ray-ban',
];
const _esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

function incumbent(brand) {
  const b = fold(brand);
  if (!b) return null;
  for (const i of INCUMBENTS) if (new RegExp('^(the\\s+)?' + _esc(i) + "('s|s)?\\b").test(b)) return i;
  return null;
}

const MONTHS = 12;
const REACH_SPAN = 4;            // comparable: within 4x either way
const NO_REACH_MAX_FOLLOWERS = 100000;

function reachOf(a) {
  const x = a || {};
  return Number(x.reach) || ((Number(x.instagram) || 0) + (Number(x.tiktok) || 0)) || 0;
}

// What we found for one brand and one athlete. Never throws.
//   { ok, evidence: [{ kind, ... , source, date }], program, sameSport, band, deals }
async function forBrand(pool, brand, athlete) {
  const reach = reachOf(athlete);
  const sport = fold(athlete && athlete.sport) || null;
  const out = { ok: false, evidence: [], program: false, sameSport: false, band: null, deals: 0 };
  try {
    // Every logged deal for the brand, for the size band.
    const tot = (await pool.query(`SELECT COUNT(*)::int n FROM deal_comps WHERE LOWER(btrim(brand)) = LOWER(btrim($1))`, [brand])).rows[0];
    out.deals = tot ? tot.n : 0;
    // COMPARABLE, SOURCED, RECENT deals.
    const deals = (await pool.query(`
      SELECT athlete_name, followers, sport, school, school_tier, source, created_at
        FROM deal_comps
       WHERE LOWER(btrim(brand)) = LOWER(btrim($1))
         AND created_at > NOW() - ($2 || ' months')::interval
         AND COALESCE(btrim(source), '') <> ''
         AND COALESCE(btrim(draft_status), '') = ''
         AND followers > 0
         AND (CASE WHEN $3::int > 0 THEN followers BETWEEN GREATEST(1, $3::int / $4::int) AND $3::int * $4::int
                   ELSE followers <= $5::int END)
       ORDER BY (LOWER(sport) = $6::text) DESC NULLS LAST, created_at DESC
       LIMIT 3`, [brand, String(MONTHS), Math.round(reach), REACH_SPAN, NO_REACH_MAX_FOLLOWERS, sport || ''])).rows;
    for (const d of deals) {
      const same = !!(sport && fold(d.sport) === sport);
      if (same) out.sameSport = true;
      out.evidence.push({ kind: 'deal', athlete: d.athlete_name || null, followers: d.followers, sport: d.sport || null,
        school: d.school || null, source: d.source, date: d.created_at, sameSport: same });
    }
    // A VERIFIED PROGRAM whose stated range takes this athlete.
    const prog = (await pool.query(`
      SELECT brand, proof_url, proof_date, proof_snippet, offer_summary, tier_min, tier_max, sports, brand_size, website
        FROM social_brands
       WHERE active = true AND LOWER(btrim(brand)) = LOWER(btrim($1))
         AND proof_date > (NOW() - ($2 || ' months')::interval)::date
         AND tier_stated = true AND COALESCE(btrim(proof_url), '') <> ''
         AND ($3::int <= 0 OR (tier_min <= CEIL($3::int * 1.25) AND tier_max >= FLOOR($3::int * 0.75)))
       ORDER BY proof_date DESC LIMIT 1`, [brand, String(MONTHS), Math.round(reach)])).rows[0];
    let size = null;
    if (prog) {
      out.program = true;
      size = prog.brand_size || null;
      const sports = (prog.sports || []).map(fold);
      if (sport && sports.includes(sport)) out.sameSport = true;
      out.evidence.unshift({ kind: 'program', source: prog.proof_url, date: prog.proof_date, offer: prog.offer_summary || null,
        snippet: prog.proof_snippet ? String(prog.proof_snippet).slice(0, 240) : null, range: [prog.tier_min, prog.tier_max] });
    } else {
      const s = (await pool.query(`SELECT brand_size FROM social_brands WHERE LOWER(btrim(brand)) = LOWER(btrim($1)) LIMIT 1`, [brand])).rows[0];
      size = s ? s.brand_size : null;
    }
    out.band = bandOf({ brand, size, deals: out.deals, program: out.program });
    out.ok = out.evidence.length > 0;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// incumbent | national | growth | small
//   national  a brand our index sizes national, or 20+ logged NIL deals
//   growth    DTC / growth stage: sized small with a program, or 3-19 deals
//   small     anything less
function bandOf({ brand, size, deals, program }) {
  if (incumbent(brand)) return 'incumbent';
  if (size === 'national' || Number(deals) >= 20) return 'national';
  if ((size === 'small' && program) || Number(deals) >= 3) return 'growth';
  return 'small';
}

// Higher is better, once the bar is met: a program to apply to, then DTC /
// growth over national, then the athlete's own sport.
function score(ev) {
  if (!ev || !ev.ok) return -1;
  return (ev.program ? 3 : 0) + (ev.band === 'growth' || ev.band === 'small' ? 2 : 0) + (ev.sameSport ? 1 : 0);
}

// One line for the card and the run row.
function sentence(ev) {
  if (!ev || !ev.ok) return null;
  const e = ev.evidence[0];
  const d = e.date ? new Date(e.date).toISOString().slice(0, 7) : '';
  if (e.kind === 'program') return `runs an athlete program for athletes your size (${e.range[0].toLocaleString()}-${e.range[1].toLocaleString()} followers), verified ${d}: ${e.source}`;
  return `signed ${e.athlete || 'an athlete'}${e.sport ? ` (${e.sport}` : ''}${e.followers ? `${e.sport ? ', ' : ' ('}${Number(e.followers).toLocaleString()} followers` : ''}${e.sport || e.followers ? ')' : ''}, logged ${d}: ${e.source}`;
}

// The national and social candidates, filtered and ranked. Each kept one
// carries sizeBand, signingEvidence and evidenceNote; each refused one is
// returned in `refused` with why.
async function filterAndRank(pool, cands, athlete) {
  const kept = [], refused = [];
  for (const c of cands || []) {
    const name = c.brand_name || c.brand;
    const inc = incumbent(name);
    if (inc) { refused.push({ brand: name, lane: c.lane, why: `a household incumbent (${inc}): a college athlete reaching them cold is not a real outcome` }); continue; }
    const ev = await forBrand(pool, name, athlete);
    if (!ev.ok) {
      refused.push({ brand: name, lane: c.lane, band: ev.band, why: ev.error ? `could not check its signings: ${ev.error}`
        : `no evidence it signed or partnered with an athlete of comparable reach in the last ${MONTHS} months` });
      continue;
    }
    kept.push({ ...c, sizeBand: ev.band, signingEvidence: ev.evidence, evidenceNote: sentence(ev), evidenceScore: score(ev), hasProgram: ev.program, sameSportEvidence: ev.sameSport });
  }
  kept.sort((a, b) => b.evidenceScore - a.evidenceScore);
  return { kept, refused };
}

module.exports = { INCUMBENTS, incumbent, forBrand, bandOf, score, sentence, filterAndRank, reachOf, MONTHS, REACH_SPAN };
