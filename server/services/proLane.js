'use strict';
// ── THE PRO LANE ────────────────────────────────────────────────────────────
//
// A professional athlete's record carries athleteType 'pro' (services/
// athleteRecord). The pipeline was built for a college athlete: it looked for
// the gym down the street, asked for the owner, and pitched a post. A pro with
// a team following needs the opposite at every step, and this module holds
// the rules the three steps read:
//
//   DISCOVERY  businesses with a real marketing budget across the team's metro
//              area: regional multi-location businesses, auto dealer groups,
//              banks and credit unions, health systems, home services, wealth
//              management, regional restaurant and retail chains, and local
//              franchisees of national brands. Never a single-location small
//              business (a barber, a nail salon, an independent cafe), which is
//              the college athlete's market. The team's metro, not a campus
//              radius.
//   CONTACT    the marketing director, VP of marketing or head of partnerships
//              first; the owner only where the business is small enough to
//              have one, which is the fallback search, run only when the
//              marketing search found nobody.
//   THE PITCH  appearance days, autograph signings, season-long ambassador
//              deals, commercial and photo shoots, hospitality events. Never
//              an Instagram post as the whole deal. Lead with the team and
//              the market, never a hometown or a school. Never the word NIL.
//
// Compliance is not touched: the age gate, the category restrictions and the
// state rules read the same record they always did.
//
// Every function here is pure. ai.getDealRecommendations, jobs/outreachQueue
// and services/pitchWriter read them; a college athlete never reaches any of
// them, so the college path is unchanged by construction.

function isPro(a) {
  return !!a && String(a.athleteType || a.athlete_type || '').toLowerCase() === 'pro';
}

// ── DISCOVERY ───────────────────────────────────────────────────────────────
const PRO_TAXONOMY = 'regional multi-location businesses; auto dealer groups and multi-store dealerships; banks and credit unions; '
  + 'health systems, hospital groups and orthopedic or sports-medicine groups; home services companies (HVAC, roofing, plumbing, solar, pest control, windows); '
  + 'wealth management firms and financial advisors; regional restaurant groups and retail chains; '
  + 'local franchisees of national brands (multi-unit operators); regional insurance agencies; real estate brokerages and home builders; '
  + 'furniture, mattress and appliance chains; regional grocery and convenience chains; law firms that advertise on TV or billboards';
const PRO_SKIP = 'SKIP single-location small businesses: independent barber shops, nail and hair salons, independent cafes and coffee shops, '
  + 'smoothie and juice bars, tattoo studios, one-room gyms and studios, food trucks. Those suit a college athlete. '
  + 'Every pick must be a business with a real marketing budget and someone whose job is to spend it.';
const PRO_WHY_YES = 'Every rationale must include a concrete "why they\'d say yes" angle for THIS business and THIS athlete '
  + '(the team\'s following across the metro, customer overlap with the sport\'s fans, they already sponsor sports or advertise regionally, '
  + 'a marketing budget that already buys billboards, radio or TV). Rank by likelihood this specific business responds to this specific athlete.';
const PRO_DEAL_TYPES = 'appearance|signing|ambassador|commercial|hospitality';
// Realistic first-deal range for a pro: a budget line, not pocket money.
const PRO_VALUE = { low: 1500, high: 15000 };

function proGeo(city, state) {
  const where = [city, state].filter(Boolean).join(', ');
  return `across the ${where} metro area: the city, its suburbs and the wider market the team draws from, not one neighborhood`;
}
function proFirstRule(sport, position) {
  return `THIS IS A PROFESSIONAL ATHLETE WITH A TEAM FOLLOWING. Do not look for the gym down the street or the coffee shop by the stadium. `
    + `Look for businesses with a marketing budget: ${PRO_TAXONOMY}. ${PRO_SKIP} Realistic first deal: $${PRO_VALUE.low}-$${PRO_VALUE.high} per appearance, signing or campaign. `
    + `Tune every pick to this athlete's sport (${sport}) and position (${position || 'N/A'}).`;
}
function proHeader() {
  return 'Name 8 to 10 REAL, well-known, established businesses in this metro area that would realistically sign an endorsement or appearance deal with this professional athlete. '
    + 'Use your own knowledge of these markets — you do NOT have web search, so rely on what you actually know. If you are only confident about fewer businesses, return fewer. NEVER pad with invented ones.';
}
// The web-search passes for a pro market, in the shape the scan's search
// definitions take: a query and the plain category list for the parser.
function proSearchDefs(geo) {
  return [
    { label: 'pro-dealers-finance', q: `auto dealer groups and multi-store dealerships, banks, credit unions, wealth management firms and financial advisors ${geo} that sponsor pro or college sports or advertise regionally`, cats: 'auto dealer groups, banks and credit unions, wealth management and financial advisors' },
    { label: 'pro-health-home', q: `health systems, hospital groups, orthopedic and sports-medicine groups, and home services companies (HVAC, roofing, plumbing, solar, pest control, windows) ${geo} that advertise regionally or sponsor sports`, cats: 'health systems and orthopedic groups, home services companies' },
    { label: 'pro-chains-franchise', q: `regional restaurant groups, retail chains, furniture and mattress chains, grocery and convenience chains, and multi-unit franchisees of national brands ${geo} that advertise regionally or sponsor sports`, cats: 'regional restaurant and retail chains, multi-unit franchisees' },
    { label: 'pro-insurance-realestate-legal', q: `regional insurance agencies, real estate brokerages and home builders, and law firms that advertise on TV or billboards ${geo}`, cats: 'insurance agencies, real estate brokerages and home builders, law firms that advertise' },
  ];
}
// A candidate the pro lane will not carry: a single-location small business
// by its name, category or Places types. A chain word ("group", "systems",
// "dealerships") in the name keeps it. Returns the reason, or null.
const SMALL_RE = /\b(barber|barbershop|barbers|nail|nails|salon|hair|beauty|lash|brow|spa|tattoo|piercing|cafe|café|coffee|espresso|smoothie|juice|bakery|donut|doughnut|bagel|boba|tea house|yoga|pilates|crossfit|martial arts|karate|jiu[- ]?jitsu|dance studio|cheer|florist|food truck|ice cream|frozen yogurt|vape|smoke shop|laundromat|dry clean|tutoring|daycare|pet groom|groomer|nail_salon|hair_care|beauty_salon|barber_shop|tattoo_parlor|coffee_shop|bakery|ice_cream_shop|juice_shop|florist)\b/i;
const CHAIN_RE = /\b(group|groups|systems|system|dealerships|dealer group|automotive group|auto group|chain|brands|companies|holdings|franchise|franchisee|enterprises|multi[- ]?unit|regional|health|hospital|medical center|credit union|bank|financial|wealth|insurance|realty|real estate|builders|home services|roofing|hvac|plumbing|solar)\b/i;
function proSkipReason(cand) {
  const c = cand || {};
  const name = String(c.name || c.brand || c.brand_name || '');
  const cat = String(c.category || '');
  const types = Array.isArray(c.types) ? c.types.join(' ') : String(c.primaryType || c.types || '');
  if (CHAIN_RE.test(name)) return null;
  const hay = [name, cat, types].join(' | ');
  const m = hay.match(SMALL_RE);
  if (m) return `single-location small business (${m[0].toLowerCase()}); the pro lane wants a business with a marketing budget`;
  return null;
}

// ── CONTACT ─────────────────────────────────────────────────────────────────
// The ladder's ranking, remapped for a pro: marketing leadership and the
// officers who sign sponsorships outrank the owner, who at a business this
// size is a founder three states away. Tier 1 is still rank <= MARKETING_LEAD
// on the ladder, so an owner stays tier 1 where they are all we have.
function proRankOf(rankOf) {
  const CR = require('./contactRank');
  const R = CR.RANK;
  // "VP of Marketing", "Head of Partnerships", "Chief Marketing Officer": the
  // base ranking only reads "marketing ... director"; the pro lane reads the
  // title either way round, because these are exactly the people it wants.
  const LEAD_RE = /\b(vp|vice president|head|director|chief|senior director|evp|svp)\b[^.]*\b(marketing|partnerships?|sponsorships?|brand|community relations|corporate relations)\b|\b(marketing|partnerships?|sponsorships?|brand)\b[^.]*\b(vp|vice president|head|director|chief|lead|officer)\b|\bcmo\b/i;
  return (title) => {
    const t = String(title || '');
    if (LEAD_RE.test(t) && rankOf(t) < R.PLACEHOLDER) return R.OWNER;   // 0: the person whose job this is
    const r = rankOf(title);
    if (r === R.MARKETING_LEAD) return R.OWNER;        // 0: the person whose job this is
    if (r === R.OFFICER) return R.FRANCHISEE;          // 1: a VP or CMO
    if (r === R.MARKETING_MGR) return R.OFFICER;       // 2: marketing manager
    if (r === R.GM) return R.GM;                       // 3
    if (r === R.OWNER || r === R.FRANCHISEE) return R.MARKETING_LEAD; // 4: still tier 1, but after the people who spend the budget
    return r;
  };
}
// The last-door searches, marketing first; the owner only when nobody in
// marketing turned up.
const PRO_QUERY_ORDER = ['marketing', 'owner'];

// ── THE PITCH ───────────────────────────────────────────────────────────────
const PRO_DEAL_SHAPES = 'an appearance day at their location, an autograph signing, a season-long ambassador deal, a commercial or photo shoot, or a hospitality event for their customers';
const POST_RE = /\b(post|posts|story|stories|reel|reels|instagram|tiktok|content|feed)\b/i;
const REAL_RE = /\b(appearance|appearances|appear|signing|signings|autograph|autographs|ambassador|ambassadors|commercial|commercials|photo shoot|shoot|shoots|hospitality|event|events|evening|night|meet[- ]and[- ]greet|clinic|visit|visits|day at|on site|in[- ]store|in[- ]person)\b/i;
// A pro pitch whose only proposal is a social post is not a pro pitch.
function postOnlyProblem(text) {
  const t = String(text || '');
  if (POST_RE.test(t) && !REAL_RE.test(t)) return 'proposes only a social post; a pro deal is an appearance day, a signing, a season-long ambassador deal, a shoot or a hospitality event';
  return null;
}
// The pitch leads with the team and the market. A hometown or a school in the
// first two sentences is the college framing.
function leadProblem(text, athlete) {
  const t = String(text || '').replace(/^(hi|hello|hey)[^\n]*\n+/i, '');
  const head = t.split(/(?<=[.?!])\s+/).slice(0, 2).join(' ');
  const a = athlete || {};
  const home = String(a.hometown || '').split(',')[0].trim();
  if (home && home.length > 2 && new RegExp('\\b' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(head)) return `leads with the hometown ("${home}"); a pro pitch leads with the team and the market`;
  if (a.school && new RegExp('\\b' + String(a.school).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(head)) return 'leads with a school; a pro pitch leads with the team and the market';
  if (/\b(grew up|hometown|native of|where (he|she|they) (is|are) from)\b/i.test(head)) return 'leads with where they are from; a pro pitch leads with the team and the market';
  return null;
}
function nilProblem(text) {
  return /\bNIL\b/.test(String(text || '')) ? 'uses the word NIL; a pro has endorsement partnerships' : null;
}
// Every pro-only lint in one call, for lintMessage.
function proProblems(text, athlete) {
  return [postOnlyProblem(text), leadProblem(text, athlete), nilProblem(text)].filter(Boolean);
}

module.exports = {
  isPro,
  PRO_TAXONOMY, PRO_SKIP, PRO_WHY_YES, PRO_DEAL_TYPES, PRO_VALUE, proGeo, proFirstRule, proHeader, proSearchDefs, proSkipReason,
  proRankOf, PRO_QUERY_ORDER,
  PRO_DEAL_SHAPES, postOnlyProblem, leadProblem, nilProblem, proProblems,
};
