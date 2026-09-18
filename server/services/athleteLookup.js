'use strict';
// ── THE ATHLETE LOOKUP: A NAME AND A SCHOOL, AND THE REST IS FOUND ──────────
//
// The agent gives a name and a school (or a team for a pro). This finds the
// rest: sport, position, class year, jersey number, hometown, height and
// weight when listed, Instagram and TikTok handles with approximate follower
// counts, and a one-line highlight. Three levels, decided from what was given:
//
//   college       ESPN's live roster feed first (football, basketball,
//                 baseball, volleyball), then a cited web search over the
//                 school's athletics site, ESPN, the recruiting sites, and the
//                 NAIA, NJCAA and Division III roster pages.
//   high_school   a cited web search over MaxPreps, the state athletic
//                 association and the school's athletics page. NEVER a birth
//                 date or an age: the record is a minor's, and the date of
//                 birth comes from the agent or not at all.
//   pro           the roster feeds (services/proRosterFeeds: ESPN's leagues,
//                 MLB StatsAPI, the NHL API, HockeyTech, the G League) first,
//                 then a cited web search for whatever they did not settle.
//
// EVERY FIELD COMES FROM A SOURCE. A feed field carries the feed URL. A web
// field carries the page it was read from, and that page must be one the
// search actually returned or fetched: a URL the model did not get from the
// search is not a source, and the field is blanked. A field with no source
// is blank. Nothing is guessed. Follower counts are approximate and dated.
//
// THE MODEL IS DEEPSEEK AND THE SEARCH IS SERPER (services/webSearchTool),
// never Anthropic. With no DeepSeek key or no search key the feeds still run
// and the web stage is skipped with a note that says why.
//
// CACHED for LOOKUP_CACHE_DAYS (30) by level, name and school or team, so
// the same athlete on the Add Client button, the chat and the import costs
// one search. A miss is cached for a day. `force` reads past the cache.
//
// COST. Every DeepSeek turn and the searches go on the ledger under
// lookup.<level> with the athlete's name as the brand, so spend-breakdown
// shows cost per lookup; the result carries costUsd too.

const { getRoster, resolveESPNSportPath } = require('./university/ESPNRosterService');
const DS = require('./deepseek');
const Ledger = require('./aiLedger');

const CACHE_DAYS = parseInt(process.env.LOOKUP_CACHE_DAYS, 10) || 30;
const MISS_CACHE_HOURS = parseInt(process.env.LOOKUP_MISS_CACHE_HOURS, 10) || 24;
const MAX_SEARCHES = parseInt(process.env.LOOKUP_MAX_SEARCHES, 10) || 4;
const MAX_FETCHES = parseInt(process.env.LOOKUP_MAX_FETCHES, 10) || 2;
const BATCH_CONCURRENCY = parseInt(process.env.LOOKUP_CONCURRENCY, 10) || 4;

// ── Sports ESPN's college feed actually supports ─────────────────────────────
const ESPN_SUPPORTED_SPORTS = new Set([
  'football',
  "men's basketball",
  "women's basketball",
  'baseball',
  "women's volleyball",
]);

const SCHOOL_ALIASES = {
  'uconn': 'Connecticut',
  'university of connecticut': 'Connecticut',
  'ucf': 'UCF',
  'usc': 'USC',
  'ucla': 'UCLA',
  'lsu': 'LSU',
  'byu': 'BYU',
  'tcu': 'TCU',
  'smu': 'SMU',
  'osu': 'Ohio State',
  'ohio state': 'Ohio State',
  'ole miss': 'Mississippi',
  'unc': 'North Carolina',
  'nc state': 'NC State',
  'n.c. state': 'NC State',
  'vt': 'Virginia Tech',
  'virginia tech': 'Virginia Tech',
  'pitt': 'Pittsburgh',
  'penn state': 'Penn State',
  'psu': 'Penn State',
  'texas a&m': 'Texas A&M',
  'a&m': 'Texas A&M',
  'miami fl': 'Miami',
  'miami (fl)': 'Miami',
  'miami oh': 'Miami (OH)',
  'miami (oh)': 'Miami (OH)',
  'fsu': 'Florida State',
  'florida state': 'Florida State',
  'uk': 'Kentucky',
  'ku': 'Kansas',
  'iu': 'Indiana',
  'mu': 'Missouri',
  'msu': 'Michigan State',
  'asu': 'Arizona State',
  'wsu': 'Washington State',
  'wvu': 'West Virginia',
  'ttu': 'Texas Tech',
  'ou': 'Oklahoma',
  'vcu': 'VCU',
  'unlv': 'UNLV',
  'unm': 'New Mexico',
  'utep': 'UTEP',
  'utsa': 'UTSA',
  'usf': 'South Florida',
  'umass': 'UMass',
  'unt': 'North Texas',
  'uab': 'UAB',
  'uncw': 'UNC Wilmington',
  'fiu': 'Florida International',
  'fau': 'Florida Atlantic',
  'siu': 'Southern Illinois',
  'slu': 'Saint Louis',
  'uga': 'Georgia',
  'uva': 'Virginia',
  'umd': 'Maryland',
  'bu': 'Boston University',
  'bc': 'Boston College',
  'gw': 'George Washington',
  'du': 'Denver',
  'bama': 'Alabama',
  'roll tide': 'Alabama',
};

// ── Sport Normalization → canonical sport key ─────────────────────────────
const SPORT_NORMALIZE = {
  'football': 'football',
  'cfb': 'football',
  'basketball': "men's basketball",
  'mens basketball': "men's basketball",
  "men's basketball": "men's basketball",
  'mbb': "men's basketball",
  'womens basketball': "women's basketball",
  "women's basketball": "women's basketball",
  'wbb': "women's basketball",
  'baseball': 'baseball',
  'bsb': 'baseball',
  'softball': 'softball',
  'sb': 'softball',
  "women's softball": 'softball',
  'soccer': "women's soccer",
  "women's soccer": "women's soccer",
  'womens soccer': "women's soccer",
  "men's soccer": "men's soccer",
  'mens soccer': "men's soccer",
  'volleyball': "women's volleyball",
  "women's volleyball": "women's volleyball",
  'womens volleyball': "women's volleyball",
  'lacrosse': "men's lacrosse",
  "men's lacrosse": "men's lacrosse",
  "women's lacrosse": "women's lacrosse",
  'track': 'track & field',
  'track & field': 'track & field',
  'swimming': 'swimming',
  'gymnastics': 'gymnastics',
  'wrestling': 'wrestling',
  'golf': 'golf',
  'tennis': 'tennis',
  'field hockey': 'field hockey',
  'cross country': 'cross country',
};

// ── Eligibility year → label ──────────────────────────────────────────────
function espnYearToEligibility(yr) {
  return { Fr: 'Freshman', So: 'Sophomore', Jr: 'Junior', Sr: 'Senior', Gr: 'Grad Transfer' }[yr] || yr || null;
}

// ── School tier inference from known programs ─────────────────────────────
function inferSchoolTier(name) {
  const n = (name || '').toLowerCase();
  const elite = ['alabama', 'georgia', 'ohio state', 'michigan', 'clemson', 'lsu', 'oklahoma', 'notre dame', 'texas', 'penn state', 'oregon', 'florida', 'usc', 'ucla'];
  if (elite.some(p => n.includes(p))) return 'p4-top10';
  const p4 = ['sec', 'big ten', 'big 12', 'acc', 'kentucky', 'tennessee', 'missouri', 'iowa', 'purdue', 'maryland', 'rutgers', 'illinois', 'minnesota', 'nebraska', 'northwestern', 'indiana', 'michigan state', 'wisconsin', 'kansas', 'baylor', 'oklahoma state', 'kansas state', 'iowa state', 'west virginia', 'texas tech', 'cincinnati', 'houston', 'ucf', 'utah', 'colorado', 'arizona', 'arizona state', 'washington state', 'oregon state', 'cal ', 'stanford', 'nc state', 'wake forest', 'virginia', 'virginia tech', 'boston college', 'pitt', 'louisville', 'duke', 'north carolina', 'miami', 'florida state', 'georgia tech', 'syracuse'];
  if (p4.some(p => n.includes(p))) return 'p4-mid';
  return 'mid-mid';
}

// ── Input normalization ──────────────────────────────────────────────────
function normalizeName(name) {
  return (name || '').trim().replace(/[''`]/g, "'").replace(/\s+/g, ' ').toLowerCase();
}

function normalizeSchool(school) {
  if (!school) return null;
  const key = school.trim().toLowerCase().replace(/[^a-z0-9\s&().'-]/g, '').replace(/\s+/g, ' ');
  return SCHOOL_ALIASES[key] || school.trim();
}

function normalizeSport(sport) {
  if (!sport) return null;
  const key = (sport || '').trim().toLowerCase();
  if (key in SPORT_NORMALIZE) return SPORT_NORMALIZE[key];
  for (const [k, v] of Object.entries(SPORT_NORMALIZE)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return sport;
}

// ── Name Match Scoring (0–35) ────────────────────────────────────────────
function nameMatchScore(query, candidate) {
  if (!query || !candidate) return 0;
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (q === c) return 35;

  const qClean = q.replace(/[^a-z]/g, '');
  const cClean = c.replace(/[^a-z]/g, '');
  if (qClean === cClean) return 33; // punctuation/spacing variant

  const qW = q.split(/\s+/).filter(Boolean);
  const cW = c.split(/\s+/).filter(Boolean);
  if (!qW.length || !cW.length) return 0;

  const qFirst = qW[0], qLast = qW[qW.length - 1];
  const cFirst = cW[0], cLast = cW[cW.length - 1];

  if (qFirst === cFirst && qLast === cLast) return 32;   // full match (middle name diff)
  if (qLast === cLast && qFirst[0] === cFirst[0]) return 25; // last + initial
  if (qLast === cLast) return 18;                         // last name only
  if (qFirst === cFirst && qFirst.length > 2) return 15; // first name only
  for (const qw of qW) for (const cw of cW) if (qw === cw && qw.length > 2) return 12;
  if (cClean.includes(qClean) || qClean.includes(cClean)) return 10;
  return 0;
}

// ── Loose school name comparison ─────────────────────────────────────────
function schoolsMatch(a, b) {
  if (!a || !b) return false;
  const clean = s => s.toLowerCase()
    .replace(/\b(university of|university|college|state university|high school|the )\b/g, '')
    .replace(/[^a-z0-9]/g, '').trim();
  const ca = clean(a), cb = clean(b);
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

// ── WHICH LEVEL ──────────────────────────────────────────────────────────
// A pro is a pro when the caller says so. A high school is read off the
// school's name (services/athleteCreate.isHighSchool). Everything else is
// college, which includes NAIA, JUCO and Division III: the web stage names
// those roster sites.
function levelOf(q) {
  if (q.level && ['college', 'high_school', 'pro'].includes(q.level)) return q.level;
  if (q.athleteType === 'pro') return 'pro';
  try { if (require('./athleteCreate').isHighSchool(q.school)) return 'high_school'; } catch (_) {}
  return 'college';
}

// ── THE CACHE ────────────────────────────────────────────────────────────
const fold = (s) => String(s || '').trim().toLowerCase().replace(/[’'`.\-]/g, '').replace(/\s+/g, ' ');
function cacheKey(level, q) {
  return `${level}|${fold(q.name)}|${fold(level === 'pro' ? (q.team || q.city) : q.school)}`;
}
function _pool() { try { return require('../store').pool; } catch (_) { return null; } }
async function cacheGet(key) {
  const pool = _pool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT result, checked_at, found FROM athlete_lookup_cache
        WHERE cache_key = $1
          AND checked_at > NOW() - (CASE WHEN found THEN ($2 || ' days') ELSE ($3 || ' hours') END)::interval`,
      [key, String(CACHE_DAYS), String(MISS_CACHE_HOURS)]);
    const row = r.rows[0];
    if (!row) return null;
    return Object.assign({}, row.result, { cached: true, checkedAt: row.checked_at });
  } catch (e) {
    if (!/does not exist/.test(e.message)) console.warn('[lookup] cache read:', e.message);
    return null;
  }
}
async function cachePut(key, level, q, result) {
  const pool = _pool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO athlete_lookup_cache (cache_key, level, query, result, cost_usd, found, checked_at)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,NOW())
       ON CONFLICT (cache_key) DO UPDATE SET level = EXCLUDED.level, query = EXCLUDED.query, result = EXCLUDED.result,
         cost_usd = EXCLUDED.cost_usd, found = EXCLUDED.found, checked_at = NOW()`,
      [key, level, JSON.stringify(q), JSON.stringify(result), result.costUsd == null ? null : result.costUsd, !!result.found]);
  } catch (e) {
    if (!/does not exist/.test(e.message)) console.warn('[lookup] cache write:', e.message);
  }
}

// ── THE FIELDS, AND THE SOURCE RULE ──────────────────────────────────────
// Every field the profile can carry. A candidate keeps a field only when
// `sources[field]` is a URL the search returned or fetched (or a profile
// URL that is, which the other fields inherit). Anything about a birth date
// or an age is dropped whatever the level: the rule is one rule.
const FIELDS = ['name', 'school', 'team', 'league', 'city', 'sport', 'position', 'year', 'jersey', 'hometown', 'hometownState',
  'height', 'weight', 'instagramHandle', 'instagram', 'tiktokHandle', 'tiktok', 'highlight', 'college'];
const NEVER = /birth|dob|\bage\b|born/i;
const KNOWN_OK = new Set(['team', 'league', 'sport', 'position', 'city', 'jersey']);
const cleanHandle = (h) => { const s = String(h || '').trim().replace(/^https?:\/\/(www\.)?(instagram|tiktok)\.com\/@?/i, '').replace(/^@+/, '').replace(/[/?#].*$/, '').toLowerCase(); return /^[a-z0-9._]{1,40}$/.test(s) ? s : null; };
function parseCount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const m = String(v).trim().toLowerCase().match(/^([\d.,]+)\s*([km])?\b/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (m[2] === 'k') n *= 1000; if (m[2] === 'm') n *= 1000000;
  return Math.round(n);
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

// sanitize(raw, citations) -> a candidate with only sourced fields, or null.
function sanitizeWeb(raw, citations, level) {
  if (!raw || typeof raw !== 'object') return null;
  const cited = new Set((citations || []).map((u) => String(u).trim()));
  const srcIn = (raw.sources && typeof raw.sources === 'object') ? raw.sources : {};
  const profile = [srcIn.profile, srcIn._all, raw.source, raw.sourceUrl].map((u) => String(u || '').trim()).find((u) => cited.has(u)) || null;
  const sources = {};
  const out = {};
  for (const f of FIELDS) {
    let v = raw[f];
    if (v === undefined && f === 'jersey') v = raw.jersey_number;
    if (v === undefined && f === 'instagram') v = raw.instagramFollowers;
    if (v === undefined && f === 'tiktok') v = raw.tiktokFollowers;
    if (v === null || v === undefined || v === '' || NEVER.test(f)) continue;
    if (f === 'instagramHandle' || f === 'tiktokHandle') v = cleanHandle(v);
    else if (f === 'instagram' || f === 'tiktok') v = parseCount(v);
    else v = String(v).trim().slice(0, f === 'highlight' ? 240 : 120);
    if (v === null || v === '') continue;
    // A field with its own source keeps it only if that page was searched
    // or fetched; a source the search never returned blanks the field. A
    // field with no source of its own inherits the profile page.
    const s = String(srcIn[f] || '').trim();
    // A PRO IS A PUBLIC FIGURE: the team, league, sport, position, city and
    // jersey may come from what the model already knows (source
    // 'knowledge'), the way an agent would say them without looking. What
    // changes (the season line, the handles, the follower counts, a recent
    // team change) still has to be read from a page the search returned.
    if (level === 'pro' && KNOWN_OK.has(f) && /^knowledge$/i.test(s)) { out[f] = v; sources[f] = 'knowledge'; continue; }
    const url = s ? (cited.has(s) ? s : null) : profile;
    if (!url) continue;                 // no source, no field
    out[f] = v; sources[f] = url;
  }
  // The name is the query itself, not a finding: it rides on whatever page
  // the other fields came from, so a candidate that only carries the
  // socials (an enrichment of a feed hit) is not thrown away for it.
  if (!out.name && raw.name && Object.keys(sources).length) {
    out.name = String(raw.name).trim().slice(0, 120);
    sources.name = profile || sources[Object.keys(sources)[0]];
  }
  if (!out.name) return null;
  for (const k of Object.keys(out)) if (NEVER.test(k)) { delete out[k]; delete sources[k]; }
  if (out.instagram !== undefined || out.tiktok !== undefined) { out.followersAsOf = todayIso(); out.followersApprox = true; }
  out.sources = sources;
  out.sourceUrl = profile || sources.name || null;
  out.sourceLabel = String(raw.sourceLabel || (level === 'high_school' ? 'MaxPreps / school site' : 'Web search')).slice(0, 60);
  out.confidence = Math.max(0, Math.min(100, parseInt(raw.confidence, 10) || 60));
  out.source = 'web-search';
  return out;
}

// ── THE PROMPTS, ONE PER LEVEL ───────────────────────────────────────────
const SHAPE = `Return ONLY a JSON object, no markdown:
{
  "found": true or false,
  "athletes": [
    {
      "name": "full name as the source prints it",
      "school": "school (college or high school) or null", "team": "pro team or null", "league": "league or null", "city": "team's home city as 'City, ST' or null",
      "sport": "sport or null", "position": "position or null", "year": "class year (Freshman/Sophomore/Junior/Senior/Grad, or 'Class of 2027' for high school) or null",
      "jersey": "jersey number or null", "hometown": "'City, ST' or null", "hometownState": "two-letter state or null",
      "height": "as listed or null", "weight": "as listed or null",
      "instagramHandle": "handle without @ or null", "instagram": approximate follower count as a number or null,
      "tiktokHandle": "handle without @ or null", "tiktok": approximate follower count as a number or null,
      "highlight": "one line: an award, a stat line, or recent news, or null",
      "sources": { "profile": "the roster or profile URL most fields came from", "<field>": "the URL that field was read from, for every field not from the profile URL" },
      "sourceLabel": "the site the profile came from", "confidence": 0-100
    }
  ],
  "searchNote": "one sentence about what you found or why nothing matched"
}`;
const RULES_PRO_HEAD = `RULES:
- This is a PUBLIC FIGURE. Start with what you already know: the team, the league, the sport, the position, the team's home city as "City, ST" and the jersey number. Put "knowledge" as the source for each of those; do not spend a search on them.
- Use your searches ONLY for what changes: the current season's stat line and honors (read the official league page or Wikipedia and write one sentence: the current season line plus career highlights, as "highlight"), the Instagram and TikTok handles and follower counts, and whether they changed teams recently (if a page shows a newer team, use it and cite the page).
- Every field that is NOT team, league, sport, position, city or jersey must be read from a page the search returned or you fetched, with its URL in "sources". A field you cannot point at a URL for is null.`;
const RULES_COLLEGE_HEAD = `RULES:
- Every field must be read from a page the search returned or you fetched, and its URL must be in "sources". A field you cannot point at a URL for is null. Never guess, never fill from memory.`;
const RULES_TAIL = `
- Follower counts: read the number off the instagram.com or tiktok.com result snippet ("12.3K followers") for the exact handle; approximate is fine; null when no snippet shows one.
- If more than one athlete could match, list each (up to three) with sport, position and class year so the agent can choose.
- Never report a birth date, a birthday or an age, under any field name.
- If nothing matched, return found: false with an empty list.`;
const RULES = RULES_COLLEGE_HEAD + '\n' + RULES_TAIL;
const RULES_PRO = RULES_PRO_HEAD + '\n' + RULES_TAIL;

function promptFor(level, q, feedTop) {
  const nm = q.name;
  if (level === 'high_school') {
    return `Find this HIGH SCHOOL athlete.
Name: ${nm}
School: ${q.school || 'unknown'}${q.sport ? '\nSport: ' + q.sport : ''}
Search MaxPreps (site:maxpreps.com), the state high school athletic association, and the school's own athletics page. Useful queries: "${nm}" ${q.school || ''} maxpreps; "${nm}" ${q.school || ''} ${q.sport || ''} roster; "${nm}" instagram.
${SHAPE}
${RULES}
- This athlete is a minor. Do not look for, and do not return, any birth date or age.`;
  }
  if (level === 'pro') {
    const known = feedTop ? `A roster feed already confirmed: ${feedTop.name}, ${feedTop.team || ''} (${feedTop.league || ''})${feedTop.position ? ', ' + feedTop.position : ''}. Find what the feed does not carry: Instagram and TikTok handles with approximate follower counts, and a one-line highlight. Do not re-report fields the feed carries unless a page shows them.\n` : '';
    // THE WEB IS THE PRIMARY PATH FOR A PRO (the roster feeds do not answer
    // from production; see services/proRosterFeeds). Wikipedia and the team's
    // official roster page first; the lookup accepts the answer only when a
    // search result names the player, the team and the position together.
    const teamQ = q.team ? ' ' + q.team : '';
    return `Find this PROFESSIONAL athlete.
Name: ${nm}
Sport: ${q.sport || 'unknown'}
Team: ${q.team || 'unknown'}${q.city ? '\nCity: ' + q.city : ''}
${known}First, from what you already know, fill the team, league, sport, position, home city and jersey number (source "knowledge"). Then search for what changes: "${nm}"${teamQ} stats (the official league page: nfl.com, nba.com, mlb.com, nhl.com, mlssoccer.com, wnba.com, or Wikipedia; write one sentence with the current season line and career highlights as "highlight"); "${nm}" instagram; "${nm}" tiktok. If a result shows a newer team than you knew, use it and cite the page.
${SHAPE}
${RULES_PRO}
- A college athlete is NOT a match; if the only person by this name is on a college roster, return found: false and say so.`;
  }
  const known = feedTop ? `ESPN's roster feed already confirmed: ${feedTop.name}, ${feedTop.school} ${feedTop.sport}${feedTop.position ? ', ' + feedTop.position : ''}${feedTop.year ? ', ' + feedTop.year : ''}. Find what the feed does not carry: Instagram and TikTok handles with approximate follower counts, and a one-line highlight (an award, a stat line, recent news).\n` : '';
  return `Find this COLLEGE athlete.
Name: ${nm}
School: ${q.school || 'unknown'}${q.sport ? '\nSport: ' + q.sport : ''}
${known}Search the school's athletics site roster first (the official roster page lists position, class year, jersey number, hometown, height and weight), then ESPN, 247Sports, On3 and Rivals. For a small school also try naia.org, njcaa.org and the Division III roster pages (site:prestosports.com, site:sidearmsports.com). Then "${nm}" ${q.school || ''} instagram and tiktok.
${SHAPE}
${RULES}`;
}
const SYSTEM = 'You are an athlete data lookup assistant. You report only what the pages the search returned actually say, with the URL of the page for every field. You never fabricate athlete data and you never report a birth date or an age.';

// A search result that names the player, their team and their position, in
// its own title or snippet. The evidence a pro web candidate must have.
function proWebEvidence(cand, results) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[’'`.\-]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const nameParts = norm(cand.name).split(' ').filter((x) => x.length > 1);
  const last = nameParts[nameParts.length - 1];
  const team = norm(cand.team);
  const teamWords = team.split(' ').filter((x) => x.length > 2);
  const pos = norm(cand.position);
  if (!last || !teamWords.length || !pos) return null;
  const POS_WORDS = { qb: ['qb', 'quarterback'], rb: ['rb', 'running back'], wr: ['wr', 'wide receiver'], te: ['te', 'tight end'], ol: ['ol', 'offensive line'], lb: ['lb', 'linebacker'], db: ['db', 'cornerback', 'safety'], cb: ['cb', 'cornerback'], s: ['safety'], k: ['kicker'], p: ['punter', 'pitcher'], de: ['de', 'defensive end'], dt: ['dt', 'defensive tackle'],
    pg: ['pg', 'point guard', 'guard'], sg: ['sg', 'shooting guard', 'guard'], sf: ['sf', 'small forward', 'forward'], pf: ['pf', 'power forward', 'forward'], c: ['center', 'centre', 'c'], g: ['guard'], f: ['forward'],
    sp: ['pitcher', 'starting pitcher'], rp: ['pitcher', 'reliever'], '1b': ['first base', 'first baseman', '1b'], '2b': ['second base', 'second baseman', '2b'], '3b': ['third base', 'third baseman', '3b'], ss: ['shortstop', 'ss'], lf: ['left field', 'outfield', 'lf'], cf: ['center field', 'outfield', 'cf'], rf: ['right field', 'outfield', 'rf'], of: ['outfield', 'outfielder', 'of'], dh: ['designated hitter', 'dh'],
    lw: ['left wing', 'winger', 'lw'], rw: ['right wing', 'winger', 'rw'], d: ['defenseman', 'defence', 'defense'], gk: ['goalkeeper', 'goalie'] };
  const posWords = [pos, ...(POS_WORDS[pos] || [])].filter(Boolean);
  for (const r of results) {
    const text = norm(`${r.title || ''} ${r.snippet || ''}`);
    if (!new RegExp('(^| )' + last + '( |$)').test(text)) continue;
    if (!teamWords.some((w) => new RegExp('(^| )' + w + '( |$)').test(text))) continue;
    if (!posWords.some((w) => new RegExp('(^| )' + w + '( |$)').test(text))) continue;
    return { url: r.url, title: r.title || '' };
  }
  return null;
}

// ── THE WEB STAGE ────────────────────────────────────────────────────────
// DeepSeek through the search loop, Serper preferred. Never Anthropic.
let _searchLoopOverride = null;
function _setSearchLoopForTests(fn) { _searchLoopOverride = fn || null; }
function searchProvider() {
  const WST = require('./webSearchTool');
  const serper = WST.PROVIDERS.serper;
  return serper.key() ? serper : WST.provider();
}
async function webStage(level, q, feedTop, ctx) {
  const rt = DS.route('lookup', { needsSearch: true });
  if (rt.provider !== 'deepseek' && !_searchLoopOverride) {
    return { skipped: `web search unavailable: ${rt.reason}`, candidates: [], citations: [], usage: null, ms: 0 };
  }
  const WST = require('./webSearchTool');
  const site = `lookup.${level}`;
  const t0 = Date.now();
  let r;
  try {
    const run = _searchLoopOverride || WST.searchLoop;
    r = await run({ prompt: promptFor(level, q, feedTop), system: SYSTEM, maxSearches: MAX_SEARCHES, maxFetches: MAX_FETCHES,
      maxTokens: 1800, temperature: 0, provider: _searchLoopOverride ? undefined : searchProvider(),
      ctx: { site, brand: q.name, agentId: ctx && ctx.agentId } });
  } catch (e) {
    return { skipped: `web search failed: ${e.message}`, candidates: [], citations: [], usage: null, ms: Date.now() - t0 };
  }
  let parsed = null;
  try { const m = String(r.text || '').match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; } catch (_) { parsed = null; }
  const citations = Array.isArray(r.citations) ? r.citations : [];
  const list = (parsed && Array.isArray(parsed.athletes)) ? parsed.athletes : [];
  const candidates = list.map((a) => sanitizeWeb(a, citations, level)).filter(Boolean);
  return { candidates, citations, usage: r.usage || null, searches: r.searches || 0, ms: Date.now() - t0,
    results: Array.isArray(r.results) ? r.results : [], rawCount: list.length,
    searchNote: parsed && parsed.searchNote ? String(parsed.searchNote).slice(0, 300) : null, parsedFound: !!(parsed && parsed.found) };
}

// ── THE FEED STAGES ──────────────────────────────────────────────────────
// ESPN's college roster: every field it lists is sourced to the roster URL.
async function espnCollegeStage(normName, normSchool, normSport, notes) {
  if (!normSchool || !normSport || !ESPN_SUPPORTED_SPORTS.has(normSport)) return [];
  try {
    const result = await getRoster(normSchool, normSport);
    if (!result.athletes || !result.athletes.length) { if (result.error) notes.push('ESPN: ' + result.error); return []; }
    const teamName = (result.team && result.team.name) || normSchool;
    const url = `https://site.api.espn.com/apis/site/v2/sports/${result.sportPath}/teams/${result.team && result.team.id}/roster`;
    return result.athletes.map((a) => {
      const ns = nameMatchScore(normName, a.name);
      if (ns < 12) return null;
      const fields = { name: a.name, school: teamName, sport: normSport, position: a.position || null, year: espnYearToEligibility(a.year),
        jersey: a.number || null, height: a.height || null, weight: a.weight ? `${a.weight} lbs` : null, hometown: a.hometown || null };
      const sources = {};
      for (const [k, v] of Object.entries(fields)) if (v && k !== 'sport') sources[k] = url;
      return Object.assign(fields, { sources, espn_id: a.espn_id || null, source: 'espn-roster', sourceLabel: 'ESPN Live Roster', sourceUrl: url,
        confidence: Math.min(96, 60 + ns), _ns: ns });
    }).filter(Boolean).sort((a, b) => b._ns - a._ns).slice(0, 5);
  } catch (e) {
    notes.push('ESPN: ' + e.message);
    return [];
  }
}

// ── MERGE: a feed candidate takes the web fields it lacks ────────────────
function mergeInto(feed, web) {
  if (!web) return feed;
  const out = Object.assign({}, feed);
  out.sources = Object.assign({}, feed.sources || {});
  for (const f of FIELDS) {
    if ((out[f] === null || out[f] === undefined || out[f] === '') && web[f] !== undefined) { out[f] = web[f]; out.sources[f] = web.sources[f]; }
  }
  if (web.followersAsOf && (out.instagram !== undefined || out.tiktok !== undefined)) { out.followersAsOf = web.followersAsOf; out.followersApprox = true; }
  out.source = feed.source + '+web';
  out.sourceLabel = feed.sourceLabel + ' + web';
  out.confidence = Math.min(99, (feed.confidence || 60) + 3);
  return out;
}

// The flat shape every caller has read since the first version, plus the
// new fields. `stats` and `knownFor` carry the highlight for the form and
// the writer; `notes` is empty rather than a guess.
function finish(c, level) {
  const isPro = level === 'pro';
  return {
    athleteType: isPro ? 'pro' : 'college', level,
    name: c.name, school: isPro ? null : (c.school || null), team: c.team || null, league: c.league || null, city: c.city || null,
    sport: c.sport || null, position: c.position || null, year: isPro ? null : (c.year || null),
    jersey: c.jersey || null, hometown: c.hometown || null, hometownState: c.hometownState || null,
    height: c.height || null, weight: c.weight || null,
    instagramHandle: c.instagramHandle || null, instagram: c.instagram || 0,
    tiktokHandle: c.tiktokHandle || null, tiktok: c.tiktok || 0,
    followersAsOf: c.followersAsOf || null, followersApprox: c.followersApprox === true,
    highlight: c.highlight || null, stats: c.highlight || null, knownFor: isPro ? (c.highlight || null) : null,
    engagement: 0, notes: null, previousSchool: null, interestTags: [],
    schoolTier: isPro ? null : inferSchoolTier(c.school),
    college: c.college || null,
    sources: c.sources || {}, sourceUrl: c.sourceUrl || null, source: c.source || null, sourceLabel: c.sourceLabel || null,
    confidence: c.confidence || 0,
  };
}

function flattenCandidate(c) { return Object.assign({ found: true }, c); }

// ── THE ENTRY POINT ──────────────────────────────────────────────────────
// resolveAthlete(ai, { name, school, sport, position, year, athleteType, team, city, level }, { agentId, force })
//   -> { found, candidates (<=3), autoSelect, level, needsSport, message, notes,
//        cached, checkedAt, costUsd, ms, ...(the best candidate flattened when autoSelect) }
// `ai` is accepted for the callers that pass it and not used: the model is
// DeepSeek through the search loop.
async function resolveAthlete(ai, q, opts = {}) {
  const t0 = Date.now();
  const name = String((q && q.name) || '').trim();
  if (!name) return { found: false, candidates: [], level: 'college', message: 'A name is needed.', notes: [], costUsd: 0, ms: 0 };
  const level = levelOf(q);
  const key = cacheKey(level, q);
  if (!opts.force) {
    const hit = await cacheGet(key);
    if (hit) { hit.ms = Date.now() - t0; return hit; }
  }
  const notes = [];
  const normName = normalizeName(name);
  let feedCands = [];
  let normSchool = null, normSport = null;
  if (level === 'pro') {
    const Feeds = require('./proRosterFeeds');
    const proSport = String(q.sport || '').trim().toLowerCase().replace(/\s+/g, ' ') || null;
    const f = await Feeds.searchFeeds({ name, sport: proSport, team: String(q.team || '').trim() || null });
    notes.push(...f.notes);
    feedCands = f.candidates;
  } else if (level === 'college') {
    normSchool = normalizeSchool(q.school);
    normSport = normalizeSport(q.sport);
    feedCands = await espnCollegeStage(normName, normSchool, normSport, notes);
  }
  const feedTop = feedCands[0] || null;
  // THE TRACE: which sources were asked, what each answered, where it gave
  // up. Logged line by line and returned on the result, so "No verified
  // athlete found" is never the whole story again.
  const trace = [];
  if (level === 'pro') trace.push(`roster feeds (${notes.length ? notes.join('; ') : 'none tried'}) -> ${feedCands.length} candidate(s)`);
  else if (level === 'college') trace.push(`ESPN college roster${normSchool ? ' for ' + normSchool : ''}${normSport ? ' ' + normSport : ''} -> ${feedCands.length} candidate(s)${notes.length ? ' (' + notes.join('; ') + ')' : ''}`);
  else trace.push('no roster feed for a high school athlete');

  // The web stage: the whole profile when no feed answered, the rest of it
  // (socials, highlight) when one did.
  const web = await webStage(level, { name, school: q.school, sport: q.sport, team: q.team, city: q.city }, feedTop, { agentId: opts.agentId });
  if (web.skipped) notes.push(web.skipped);
  const costUsd = web.usage ? (Ledger.estimateUsd(DS.model(), web.usage, 'deepseek') || 0) : 0;
  trace.push(web.skipped ? `web search: ${web.skipped}` : `web search: ${web.searches || 0} search(es), ${(web.results || []).length} result(s) seen, model returned ${web.rawCount || 0} athlete(s), ${web.candidates.length} kept with a cited source${web.searchNote ? ' (' + web.searchNote + ')' : ''}`);
  // ── A PRO FROM THE WEB IS ACCEPTED ONLY WHEN A SOURCE NAMES THE PLAYER,
  //    THEIR TEAM AND THEIR POSITION. The model's JSON is a claim; a search
  //    result's title or snippet is the evidence. With no such result the
  //    candidate is dropped and the trace says so.
  // A PRO CANDIDATE STANDS ON A TEAM AND A POSITION, the way a college one
  // stands on a school: from what the model knows (a public figure) or from a
  // page. A search result that names the player, the team and the position
  // together is noted as corroboration; its absence is not a refusal.
  if (level === 'pro' && !feedTop && web.candidates.length) {
    const before = web.candidates.length;
    web.candidates = web.candidates.filter((w) => {
      if (!w.team || !w.position) { trace.push(`web candidate "${w.name}" dropped: no team or no position (team ${w.team || '?'}, position ${w.position || '?'})`); return false; }
      const ev = proWebEvidence(w, web.results || []);
      const how = (w.sources && w.sources.team === 'knowledge') ? 'team and position from model knowledge (public figure)' : 'team and position from a cited page';
      if (ev) { w.evidenceUrl = ev.url; trace.push(`web candidate "${w.name}" kept: ${how}; corroborated by ${ev.url}`); }
      else trace.push(`web candidate "${w.name}" kept: ${how}; no search result corroborated team and position together`);
      return true;
    });
    if (before && !web.candidates.length) trace.push('web search gave up: every candidate lacked a team or a position');
  }

  let candidates = [];
  if (feedTop) {
    const enrich = web.candidates.find((w) => nameMatchScore(feedTop.name, w.name) >= 25) || null;
    candidates.push(mergeInto(feedTop, enrich));
    for (const c of feedCands.slice(1)) if ((c._ns || 0) >= 15) candidates.push(c);
  } else {
    for (const w of web.candidates) {
      if (level === 'college' && normSchool && w.school && !schoolsMatch(w.school, normSchool)) continue;
      if (level === 'high_school' && q.school && w.school && !schoolsMatch(w.school, q.school)) continue;
      if (nameMatchScore(name, w.name) < 12) continue;
      candidates.push(Object.assign({}, w, { school: w.school || (level === 'pro' ? null : q.school) || null, team: w.team || q.team || null, city: w.city || q.city || null }));
    }
  }
  // A pro's city comes from the team when no page said it (services/proTeams).
  if (level === 'pro') {
    const PT = require('./proTeams');
    for (const c of candidates) {
      if (!c.city && c.team) { const t = PT.findTeam(c.team); if (t) { c.city = t.market; c.sources = Object.assign({}, c.sources, { city: 'team-table' }); if (!c.league) c.league = t.league; } }
    }
  }
  candidates = candidates.map((c) => finish(c, level)).sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 3);
  // A field the agent supplied is not guessed: it is theirs, and it is kept
  // when the sources did not contradict it (sourced 'agent').
  for (const c of candidates) {
    for (const [f, v] of [['sport', q.sport], ['position', q.position], ['year', q.year]]) {
      if (!c[f] && v && String(v).trim()) { c[f] = String(v).trim(); c.sources[f] = 'agent'; }
    }
  }
  const sports = new Set(candidates.map((c) => String(c.sport || '').toLowerCase()).filter(Boolean));
  const needsSport = !candidates.length || sports.size > 1;
  // The best candidate's flat fields ride on the result when it auto-selects
  // (the form reads them there), but the result's own keys win: `notes` here
  // is the lookup's notes, never the candidate's.
  const result = Object.assign({}, (candidates.length === 1 && candidates[0].confidence >= 95) ? flattenCandidate(candidates[0]) : {}, {
    found: candidates.length > 0, level, candidates, needsSport,
    autoSelect: candidates.length === 1 && candidates[0].confidence >= 95,
    espnSupported: level === 'college' && !!(normSport && ESPN_SUPPORTED_SPORTS.has(normSport)),
    message: candidates.length ? null : (web.searchNote || notes.filter((n) => /unavailable|failed/.test(n))[0] || 'No verified athlete found. Please fill in details manually.'),
    searchNote: web.searchNote || null, notes, citations: web.citations || [],
    costUsd, searches: web.searches || 0, ms: Date.now() - t0, cached: false, checkedAt: new Date().toISOString(),
  });
  if (candidates.length) candidates[0].best = true;
  result.trace = trace;
  if (!candidates.length) result.message = `${result.message} Checked: ${trace.join(' | ')}`.slice(0, 900);
  for (const line of trace) console.log(`[lookup] ${level} "${name}": ${line}`);
  console.log(`[lookup] ${level} "${name}"${q.school ? ' @ ' + q.school : ''}${q.team ? ' / ' + q.team : ''}: ${candidates.length} candidate(s), ${result.searches} search(es), ${costUsd.toFixed(4)}, ${result.ms}ms${notes.length ? ' [' + notes.join('; ') + ']' : ''}`);
  // A skipped web stage with no feed answer is not a fact about the athlete: not cached.
  if (candidates.length || !web.skipped) await cachePut(key, level, { name, school: q.school || null, team: q.team || null, sport: q.sport || null }, result);
  return result;
}

// Several at once, in parallel, a few at a time. Order is preserved.
async function resolveMany(ai, list, opts = {}) {
  const items = Array.isArray(list) ? list : [];
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await resolveAthlete(ai, items[i] || {}, opts); }
      catch (e) { out[i] = { found: false, candidates: [], level: levelOf(items[i] || {}), message: 'The lookup failed: ' + e.message, notes: [e.message], costUsd: 0, ms: 0 }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(BATCH_CONCURRENCY, items.length)) }, worker));
  return out;
}

// Kept for the callers and tests that read them. The Anthropic-backed
// stages are gone: this is the DeepSeek web stage under the old names.
async function _deepseekStage(site, userPrompt, system) {
  const rt = DS.route(site, { needsSearch: true });
  if (rt.provider !== 'deepseek') return undefined;
  try {
    const WST = require('./webSearchTool');
    const r = await WST.searchLoop({ prompt: userPrompt, system, maxSearches: 3, maxTokens: 1500, temperature: 0, ctx: { site }, provider: searchProvider() });
    const jsonMatch = String(r.text || '').match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    console.warn(`[lookup] DeepSeek search failed (${e.message})`);
    return null;
  }
}
function leagueFor(sport) {
  const s = String(sport || '').toLowerCase();
  if (!s) return null;
  if (/football/.test(s)) return 'NFL';
  if (/women.*basketball|wnba/.test(s)) return 'WNBA';
  if (/men.*basketball|\bnba\b/.test(s)) return 'NBA';
  if (/basketball/.test(s)) return 'NBA or WNBA';
  if (/baseball/.test(s)) return 'MLB';
  if (/women.*hockey|\bpwhl\b/.test(s)) return 'PWHL';
  if (/hockey/.test(s)) return 'NHL or PWHL';
  if (/women.*soccer|nwsl/.test(s)) return 'NWSL';
  if (/men.*soccer|\bmls\b/.test(s)) return 'MLS';
  if (/soccer/.test(s)) return 'MLS or NWSL';
  if (/golf/.test(s)) return 'PGA Tour or LPGA';
  if (/tennis/.test(s)) return 'ATP or WTA';
  if (/softball/.test(s)) return 'AUSL';
  if (/volleyball/.test(s)) return 'Pro Volleyball Federation or LOVB';
  return null;
}
async function proSearchStage(normName, team, city, normSport, normPosition) {
  const r = await resolveAthlete(null, { name: normName, team, city, sport: normSport, position: normPosition, athleteType: 'pro' });
  return { found: r.found, confidenceScore: r.candidates[0] ? r.candidates[0].confidence : 0, athletes: r.candidates, searchNote: r.message || r.searchNote };
}

module.exports = {
  resolveAthlete, resolveMany, levelOf, cacheKey, sanitizeWeb, promptFor, FIELDS, proWebEvidence, RULES, RULES_PRO, KNOWN_OK,
  normalizeName, normalizeSchool, normalizeSport, nameMatchScore, schoolsMatch, ESPN_SUPPORTED_SPORTS,
  leagueFor, proSearchStage, _deepseekStage, _setSearchLoopForTests,
  CACHE_DAYS, MISS_CACHE_HOURS,
};
