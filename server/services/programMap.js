'use strict';
// Program Contact Map: who holds power at an FBS football program, so an agent knows
// who to call about a roster spot. A SHARED, cached asset (table program_staff),
// built by a job and served to everyone. It is never run live per query.
//
// It reuses the Deal Scan lookup stack rather than introducing a second one:
//   ai.runSourceWaves  the same parallel wave engine, same straggler cut
//   ai.webSearchJson   the same Haiku + web_search primitive
//   a 15s per-source cap, matching the brand ladder
//
// The rules that matter here are about EVIDENCE, not retrieval:
//   Tier A  the school's own athletics staff directory. Authoritative; it wins.
//   Tier B  official school / collective press releases and athletics news posts.
//   Tier C  LinkedIn, reputable news coverage.
//   Tier D  anything else.
// Confident  = a Tier A hit, OR two INDEPENDENT Tier B/C sources that agree.
// Likely     = a single Tier C source, or a lone Tier B.
// Conflicting= sources disagree on who holds the role. BOTH are kept and shown.
// An email is stored ONLY if the search reported the page it was published on. No
// address is ever constructed or pattern-matched from a name and a domain.

const ai = require('../ai');

const SOURCE_TIMEOUT_MS = 15000;   // same per-source cap as the brand ladder
const WALL_BUDGET_MS = 45000;      // per program, across all waves

// Roles we map, in the order an agent works them.
const ROLES = [
  { key: 'general_manager', label: 'General Manager', match: /\bgeneral manager\b|\bgm\b/i },
  { key: 'player_personnel', label: 'Director of Player Personnel', match: /player personnel/i },
  { key: 'recruiting', label: 'Director of Recruiting', match: /recruiting/i },
  { key: 'head_coach', label: 'Head Coach', match: /head coach/i },
  { key: 'collective_director', label: 'NIL Collective Director', match: /collective|executive director|nil/i },
];

// Official athletics domains, used ONLY to classify a source URL as Tier A. These
// are stable and checkable. Collective names are deliberately NOT hardcoded: they
// change often, and a wrong one would poison the search query. The search discovers
// the collective from the school name instead. If a domain here were wrong the only
// effect is that records fail to reach Confident, which is a safe failure.
const SCHOOLS = {
  'Alabama':       { athletics: 'rolltide.com',        edu: 'ua.edu',      team: 'Alabama Crimson Tide' },
  'Auburn':        { athletics: 'auburntigers.com',    edu: 'auburn.edu',  team: 'Auburn Tigers' },
  'Georgia':       { athletics: 'georgiadogs.com',     edu: 'uga.edu',     team: 'Georgia Bulldogs' },
  'Tennessee':     { athletics: 'utsports.com',        edu: 'utk.edu',     team: 'Tennessee Volunteers' },
  'Ole Miss':      { athletics: 'olemisssports.com',   edu: 'olemiss.edu', team: 'Ole Miss Rebels' },
  'LSU':           { athletics: 'lsusports.net',       edu: 'lsu.edu',     team: 'LSU Tigers' },
  'Texas A&M':     { athletics: '12thman.com',         edu: 'tamu.edu',    team: 'Texas A&M Aggies' },
  'Florida':       { athletics: 'floridagators.com',   edu: 'ufl.edu',     team: 'Florida Gators' },
  'South Carolina':{ athletics: 'gamecocksonline.com', edu: 'sc.edu',      team: 'South Carolina Gamecocks' },
  'Missouri':      { athletics: 'mutigers.com',        edu: 'missouri.edu',team: 'Missouri Tigers' },
};
const PILOT_SCHOOLS = Object.keys(SCHOOLS);

// Source lanes. Wave 1 targets the authoritative and official material; wave 2 is
// the person-specific / journalistic fill-in. One search per lane returns EVERY
// role it can see, so five roles cost about four searches rather than twenty.
const SOURCE_ORDER = ['athletics_directory', 'collective', 'press', 'linkedin', 'news'];

const NEWS_HOSTS = /(^|\.)(espn|si|cbssports|foxsports|yahoo|on3|247sports|rivals|theathletic|al|nola|tennessean|ajc|gainesville|thestate|columbiamissourian|post-gazette|usatoday|sports illustrated|saturdaydownsouth|footballscoop)\./i;

function _host(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
}

// Classify a source URL into the evidence tier. Tier A is intentionally strict: the
// school's OWN athletics site (or .edu), on a staff/coach/administration page.
function classifyTier(url, school) {
  const h = _host(url);
  if (!h) return 'D';
  const cfg = SCHOOLS[school] || {};
  const path = (() => { try { return new URL(String(url)).pathname.toLowerCase(); } catch (_) { return ''; } })();
  const official = (cfg.athletics && (h === cfg.athletics || h.endsWith('.' + cfg.athletics)))
    || (cfg.edu && (h === cfg.edu || h.endsWith('.' + cfg.edu)));
  if (official) {
    // A staff directory / coaches / administration page is the authoritative record.
    if (/staff|directory|coach|administration|personnel|leadership/.test(path)) return 'A';
    return 'B'; // official site, but a news post or other page
  }
  if (h.includes('linkedin.com')) return 'C';
  if (NEWS_HOSTS.test(h)) return 'C';
  // A collective's own site is official-ish material about itself: Tier B.
  if (/collective|nil|club|fund|trust|victorious|traditions/.test(h)) return 'B';
  return 'D';
}

const SYS = 'You research college football program staff with web search and return ONLY structured JSON about real people found on real published pages. Report ONLY what a page actually states. Never invent a name, title, email, phone, or URL, and never construct an email address from a name.';

const JSON_TAIL = `Respond with ONLY a single JSON object and NOTHING else: no prose, no markdown, no code fences.
{"people":[{"name":"Full Name","title":"exact title as published","role":"general_manager|player_personnel|recruiting|head_coach|collective_director|other","email":null,"emailSourceUrl":null,"phone":null,"linkedinUrl":null,"sourceUrl":null}]}
Rules:
- name and title are REQUIRED and must come from a page your search actually opened. title must be the EXACT title as published, not a paraphrase.
- role: pick the closest of the listed keys, or "other" if it is not one of them.
- email: ONLY if the address is literally printed on a page you found. emailSourceUrl MUST be the URL of that exact page. If you cannot give emailSourceUrl, set BOTH email and emailSourceUrl to null. NEVER build an address from a name and a domain, never guess a pattern like first.last@school.edu. A guessed address is worse than none.
- phone: only a real published number, else null. linkedinUrl: only a real profile URL you actually saw, else null.
- sourceUrl: the exact page you found this person on. REQUIRED; omit the person entirely if you cannot cite a page.
- Return {"people":[]} if the search genuinely found nobody.`;

function _lead(source, school) {
  const cfg = SCHOOLS[school] || {};
  const team = cfg.team || school;
  switch (source) {
    case 'athletics_directory':
      return `Search the OFFICIAL athletics staff directory of ${team}${cfg.athletics ? ` on ${cfg.athletics}` : ''} (queries "${team} football staff directory", "site:${cfg.athletics || ''} staff directory football"). From the directory page, extract the FOOTBALL general manager, director of player personnel, director of recruiting, and head coach, with their exact published titles and the directory page URL as sourceUrl.`;
    case 'collective':
      return `Identify the NIL collective that supports ${team} and find its director or executive director. Search "${team} NIL collective executive director" and the collective's own website leadership or about page. Extract the person's name, exact title, and the page URL. Do not guess which collective it is: only report one a page actually names as supporting ${team}.`;
    case 'press':
      return `Search official ${team} athletics news posts and school or collective press releases announcing the hiring of a football general manager, director of player personnel, or director of recruiting (queries "${team} names general manager football", "${team} hires director of player personnel"). Extract the person named, their exact title, and the release URL.`;
    case 'linkedin':
      return `Search LinkedIn for the ${team} football general manager, director of player personnel, and director of recruiting (queries "${team} football general manager linkedin", "${team} director of player personnel linkedin"). Extract each person's name, the exact title on their profile, and the FULL public profile URL as both linkedinUrl and sourceUrl. Only report profiles that name ${team} as the current employer.`;
    case 'news':
    default:
      return `Search reputable news coverage for who currently holds these ${team} football roles: general manager, director of player personnel, director of recruiting, and head coach. Prefer articles from the last 18 months. Extract each person's name, exact title, the article URL as sourceUrl, and the publication date if stated.`;
  }
}

function _parse(raw) {
  let s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return [];
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(o.people) ? o.people : [];
  } catch (_) { return []; }
}

// One source lane for one school.
async function _runSource(source, school) {
  const t0 = Date.now();
  let raw = '', status = 'ran', err = '';
  let searches = 0, outTokens = 0;
  try {
    const r = await Promise.race([
      ai.webSearchJson(`${_lead(source, school)}\n${JSON_TAIL}`, SYS),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout-15s')), SOURCE_TIMEOUT_MS)),
    ]);
    raw = r.text || ''; searches = r.searches || 0; outTokens = r.outTokens || 0;
  } catch (e) { status = 'error'; err = (e && e.message) || 'error'; }
  if (status === 'ran' && !raw) status = 'empty';

  const people = [];
  for (const p of _parse(raw)) {
    const name = String((p && p.name) || '').trim();
    const title = String((p && p.title) || '').trim();
    const sourceUrl = (p && typeof p.sourceUrl === 'string' && /^https?:\/\//i.test(p.sourceUrl)) ? p.sourceUrl.trim() : null;
    // No name, no title, or no citable page: not a record.
    if (!name || !title || !sourceUrl) continue;
    // EMAIL GUARD: an address survives only with the page it was published on.
    // Anything else is dropped, because a constructed address that is right most of
    // the time is worse than an empty field: agents will trust it.
    const emailSourceUrl = (p && typeof p.emailSourceUrl === 'string' && /^https?:\/\//i.test(p.emailSourceUrl)) ? p.emailSourceUrl.trim() : null;
    const email = (emailSourceUrl && p.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(p.email).trim())) ? String(p.email).trim().toLowerCase() : null;
    const linkedinUrl = (p && typeof p.linkedinUrl === 'string' && /linkedin\.com\/(in|company)\//i.test(p.linkedinUrl)) ? p.linkedinUrl.trim() : null;
    people.push({
      name, title,
      role: String((p && p.role) || 'other'),
      email, emailSourceUrl,
      phone: (p && p.phone) ? String(p.phone).trim() : null,
      linkedinUrl, sourceUrl,
      tier: classifyTier(sourceUrl, school),
      source,
    });
  }
  return { source, people, status, err, ms: Date.now() - t0, searches, outTokens, rawLen: raw.length };
}

// Assign a person to a role: trust the model's role key when it is one of ours,
// otherwise fall back to matching the published title.
function _roleOf(p) {
  const known = ROLES.find((r) => r.key === p.role);
  if (known) return known.key;
  for (const r of ROLES) if (r.match.test(p.title)) return r.key;
  return null;
}

function _nameKey(n) { return String(n || '').toLowerCase().replace(/[^a-z]/g, ''); }

// Confidence from the evidence, per the rules at the top of this file.
function _assess(candidates) {
  const tiers = candidates.map((c) => c.tier);
  if (tiers.includes('A')) return 'confident';
  // Two INDEPENDENT sources (different lanes AND different hosts) that agree.
  const bc = candidates.filter((c) => c.tier === 'B' || c.tier === 'C');
  const hosts = new Set(bc.map((c) => _host(c.sourceUrl)));
  const lanes = new Set(bc.map((c) => c.source));
  if (bc.length >= 2 && hosts.size >= 2 && lanes.size >= 2) return 'confident';
  if (bc.length >= 1) return 'likely';
  return 'unverified';
}

// Build the full record set for one school.
async function buildProgram(school) {
  const t0 = Date.now();
  const run = await ai.runSourceWaves(SOURCE_ORDER, (src) => _runSource(src, school), {
    waveSize: 3,
    wallBudgetMs: WALL_BUDGET_MS,
    label: `program=${school}`,
    // A Tier A hit is the win that lets a wave drop its straggler.
    hasWin: (r) => (r.people || []).some((p) => p.tier === 'A'),
    onResult: (r) => {
      const tierA = (r.people || []).some((p) => p.tier === 'A');
      console.log(`[program-map] school="${school}" source=${r.source} ms=${r.ms} found=${r.people.length} tierA=${tierA ? 'yes' : 'no'} searches=${r.searches} outTokens=${r.outTokens} status=${r.status}${r.err ? ' err=' + r.err : ''}`);
    },
    // Never stop early: the collective director and the personnel roles come from
    // different lanes, so every lane can still add a role the others missed.
    isSatisfied: () => false,
  });

  const all = run.results.flatMap((r) => r.people);
  const records = [];
  const meter = { searches: 0, outTokens: 0, sources: run.results.length };
  for (const r of run.results) { meter.searches += r.searches || 0; meter.outTokens += r.outTokens || 0; }

  for (const role of ROLES) {
    const forRole = all.filter((p) => _roleOf(p) === role.key);
    if (!forRole.length) {
      console.log(`[program-map] school="${school}" role=${role.key} found=0 tierA=no confidence=empty`);
      continue;
    }
    // Group by person. Distinct people for the same role = a conflict.
    const byPerson = new Map();
    for (const p of forRole) {
      const k = _nameKey(p.name);
      if (!k) continue;
      if (!byPerson.has(k)) byPerson.set(k, []);
      byPerson.get(k).push(p);
    }
    const people = [...byPerson.values()];
    // A Tier A record settles a disagreement: the official directory wins outright.
    const anyTierA = people.some((cs) => cs.some((c) => c.tier === 'A'));
    const conflicting = people.length > 1 && !anyTierA;
    for (const cands of people) {
      const best = cands.slice().sort((a, b) => 'ABCD'.indexOf(a.tier) - 'ABCD'.indexOf(b.tier))[0];
      const withEmail = cands.find((c) => c.email) || null;
      const withPhone = cands.find((c) => c.phone) || null;
      const withLi = cands.find((c) => c.linkedinUrl) || null;
      // If this person has a Tier A citation they are confident even in a
      // multi-name situation; otherwise a genuine disagreement is labeled.
      const own = _assess(cands);
      const confidence = cands.some((c) => c.tier === 'A') ? 'confident' : (conflicting ? 'conflicting' : own);
      records.push({
        school, role: role.key, role_label: role.label,
        name: best.name, title: best.title,
        email: withEmail ? withEmail.email : null,
        email_source_url: withEmail ? withEmail.emailSourceUrl : null,
        phone: withPhone ? withPhone.phone : null,
        linkedin_url: withLi ? withLi.linkedinUrl : null,
        source_url: best.sourceUrl,
        source_tier: best.tier,
        confidence,
        sources: cands.map((c) => ({ tier: c.tier, lane: c.source, url: c.sourceUrl, title: c.title })),
      });
    }
    const top = records.filter((x) => x.role === role.key);
    console.log(`[program-map] school="${school}" role=${role.key} found=${top.length} tierA=${anyTierA ? 'yes' : 'no'} confidence=${top[0] ? top[0].confidence : 'empty'} ms=${Date.now() - t0}`);
  }

  const filled = new Set(records.map((r) => r.role)).size;
  console.log(`[program-map] school="${school}" roles=${filled}/${ROLES.length} records=${records.length} sources=${meter.sources} searches=${meter.searches} totalMs=${Date.now() - t0}`);
  return { school, records, ms: Date.now() - t0, meter, rolesFilled: filled, rolesTotal: ROLES.length };
}

module.exports = { buildProgram, classifyTier, ROLES, SCHOOLS, PILOT_SCHOOLS, SOURCE_ORDER, _assess, _roleOf };
