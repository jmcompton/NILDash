'use strict';
// Program Contact Map: who holds power at an FBS football program, and how to reach
// them. A SHARED, cached asset (tables program_staff + program_contact), built by a
// job and served to everyone. Never run live per query.
//
// It reuses the Deal Scan lookup stack rather than introducing a second one:
//   ai.runSourceWaves  the same parallel wave engine, same straggler cut
//   ai.webSearchJson   the same Haiku + web_search primitive
//   a 15s per-source cap, matching the brand ladder
//
// EVIDENCE TIERS
//   Tier A  the school's own athletics staff directory. Authoritative.
//   Tier B  official school / collective press releases and athletics news posts.
//   Tier C  LinkedIn, reputable news coverage.
//   Tier D  anything else, including a page that never names this program.
//
// RECENCY (the rule that keeps a predecessor from being served as the incumbent)
//   Every source carries a publication date when the page states one. Undated pages
//   rank BELOW anything dated. For a role with several candidates the most recently
//   dated source wins and becomes 'current'; the rest are kept as 'previous' WITH
//   their dates, never presented as the incumbent. Nothing whose newest evidence is
//   older than STALE_MONTHS can be Confident on its own, even from Tier A: a 2021
//   press release is not evidence of who holds the seat today.
//
// CONFIDENCE
//   Confident   a fresh (or undated) Tier A hit, OR two INDEPENDENT fresh Tier B/C
//               sources (different lane AND different host) that agree.
//   Likely      a single Tier C, or a lone Tier B.
//   Conflicting two candidates whose evidence is too close in time to separate.
//   Stale       the only evidence is older than STALE_MONTHS.
//
// An email is stored ONLY when the search also returns the page it was printed on.
// Nothing is ever constructed or pattern-matched from a name and a domain.

const ai = require('../ai');

const SOURCE_TIMEOUT_MS = 15000;   // same per-source cap as the brand ladder
const WALL_BUDGET_MS = 55000;      // per program, across all waves
const STALE_MONTHS = 18;           // older evidence can never stand alone as Confident
const TIE_DAYS = 90;               // dates this close cannot separate two candidates

const ROLES = [
  { key: 'general_manager', label: 'General Manager', match: /\bgeneral manager\b|\bgm\b|executive director of football|director of football management|\bfootball management\b|\bfootball personnel\b/i },
  { key: 'player_personnel', label: 'Director of Player Personnel', match: /player personnel/i },
  { key: 'recruiting', label: 'Director of Recruiting', match: /recruiting/i },
  { key: 'head_coach', label: 'Head Coach', match: /head coach/i },
  // "executive director" alone is NOT enough: Tennessee's "Executive Director of
  // Football Management" is a GM, not a collective role. Require collective/NIL.
  { key: 'collective_director', label: 'NIL Collective Director', match: /\bcollective\b|\bnil\b/i },
];

// Official athletics domains, used ONLY to classify a source URL as Tier A. Stable
// and checkable. Collective names are deliberately NOT hardcoded: they change, and a
// wrong one would poison the query, so the search discovers the collective instead.
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

// Wave 1 is the authoritative/official material plus the contact hunt; wave 2 is the
// person-specific and journalistic fill-in. One search per lane returns every role it
// can see, so five roles cost about six lookups rather than twenty-five.
const SOURCE_ORDER = ['athletics_directory', 'contacts', 'collective', 'press', 'linkedin', 'news'];

const NEWS_HOSTS = /(^|\.)(espn|si|cbssports|foxsports|yahoo|on3|247sports|rivals|theathletic|al|nola|tennessean|ajc|gainesville|thestate|columbiamissourian|usatoday|saturdaydownsouth|footballscoop|sports illustrated)\./i;

function _host(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
}

// ── SPORT FILTER ─────────────────────────────────────────────────────────────
// An athletics department publishes general managers, directors of operations and
// personnel staff for EVERY sport, all on the same official domain. Without a sport
// check, a track and field GM found on the school's own site is labeled Confident
// Tier A: perfectly sourced and completely wrong. That is worse than a stale record,
// because nothing about it looks suspect. So a record must be about FOOTBALL, and a
// record that is demonstrably about another sport is DROPPED, not demoted.
const FOOTBALL_RE = /\bfootball\b|\bgridiron\b|\bqb\b|\boffensive line\b|\bdefensive line\b/i;
const OTHER_SPORTS = [
  ['track', /\btrack\b|\bcross ?country\b|\btrack and field\b|\bt&f\b/i],
  ['basketball', /\bbasketball\b|\bhoops\b|\bmbb\b|\bwbb\b/i],
  ['baseball', /\bbaseball\b/i],
  ['softball', /\bsoftball\b/i],
  ['soccer', /\bsoccer\b/i],
  ['volleyball', /\bvolleyball\b/i],
  ['golf', /\bgolf\b/i],
  ['tennis', /\btennis\b/i],
  ['swimming', /\bswim\w*\b|\bdiving\b/i],
  ['gymnastics', /\bgymnastics\b/i],
  ['wrestling', /\bwrestling\b/i],
  ['hockey', /\bhockey\b/i],
  ['rowing', /\browing\b|\bcrew\b/i],
  ['lacrosse', /\blacrosse\b/i],
  ['equestrian', /\bequestrian\b/i],
];

// Which sport does this record belong to? Reads the model's own sport field first,
// then the published title, then the URL. Returns 'football', a named other sport,
// or null when nothing in the evidence says.
function detectSport(modelSport, title, url) {
  const ms = String(modelSport || '').toLowerCase().trim();
  if (ms && ms !== 'unknown' && ms !== 'other') {
    if (FOOTBALL_RE.test(ms)) return 'football';
    for (const [name, re] of OTHER_SPORTS) if (re.test(ms) || ms === name) return name;
  }
  const hay = `${title || ''} ${url || ''}`;
  // Football wins when the evidence names it: "Director of Football Operations" on a
  // page that also lists other sports is still a football role.
  if (FOOTBALL_RE.test(hay)) return 'football';
  for (const [name, re] of OTHER_SPORTS) if (re.test(hay)) return name;
  return null;
}

// Does this specific evidence tie the person to football, rather than merely sitting
// on the school's domain? A department-wide staff directory that lists every sport
// is NOT sufficient on its own: the title must name football, or the page must sit
// on a football path.
function footballScoped(title, url) {
  if (FOOTBALL_RE.test(String(title || ''))) return true;
  const path = (() => { try { return new URL(String(url)).pathname.toLowerCase(); } catch (_) { return String(url || '').toLowerCase(); } })();
  return /\/football\b|\/fball\b|sport=football|\bfootball\b/.test(path);
}

function classifyTier(url, school) {
  const h = _host(url);
  if (!h) return 'D';
  const cfg = SCHOOLS[school] || {};
  const path = (() => { try { return new URL(String(url)).pathname.toLowerCase(); } catch (_) { return ''; } })();
  const official = (cfg.athletics && (h === cfg.athletics || h.endsWith('.' + cfg.athletics)))
    || (cfg.edu && (h === cfg.edu || h.endsWith('.' + cfg.edu)));
  if (official) {
    if (/staff|directory|coach|administration|personnel|leadership/.test(path)) return 'A';
    return 'B';
  }
  if (h.includes('linkedin.com')) return 'C';
  if (NEWS_HOSTS.test(h)) return 'C';
  if (/collective|nil|club|fund|trust|victorious|traditions/.test(h)) return 'B';
  return 'D';
}

// Publication date. Undated is null, which sorts BELOW anything dated.
function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!/\d{4}/.test(str)) return null;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  if (y < 1990 || y > 2100) return null;
  return d;
}
function monthsSince(dateMs, nowMs) {
  if (dateMs == null) return null;
  return (nowMs - dateMs) / (1000 * 60 * 60 * 24 * 30.44);
}
function isStale(dateMs, nowMs) {
  const m = monthsSince(dateMs, nowMs);
  return m != null && m > STALE_MONTHS;
}

const SYS = 'You research college football program staff with web search and return ONLY structured JSON about real people found on real published pages. Report ONLY what a page actually states. Never invent a name, title, email, phone, URL, or date, and never construct an email address from a name.';

const JSON_TAIL = `Respond with ONLY a single JSON object and NOTHING else: no prose, no markdown, no code fences.
{"people":[{"name":"Full Name","title":"exact title as published","role":"general_manager|player_personnel|recruiting|head_coach|collective_director|other","email":null,"emailSourceUrl":null,"phone":null,"linkedinUrl":null,"sourceUrl":null,"publishedDate":null,"programNamedOnPage":true,"isFormer":false,"sport":"football|track|basketball|baseball|softball|soccer|volleyball|other|unknown"}]}
Rules:
- name and title are REQUIRED and must come from a page your search actually opened. title must be the EXACT title as published.
- role: the closest of the listed keys, or "other".
- publishedDate: the page's publication or last-updated date in YYYY-MM-DD form IF the page states one. If the page shows no date, use null. NEVER guess or approximate a date.
- programNamedOnPage: true ONLY if that page explicitly names this program. If the page is about a different school, set it false.
- sport: which SPORT this person's role serves, as the page indicates. ONLY FOOTBALL staff are wanted. An athletics department lists general managers, directors of operations and personnel staff for every sport on the same site, so this must be answered from the page, not assumed. If the page is a department-wide directory that does not say which sport, use "unknown". If the person serves track, basketball, baseball or any other sport, say so plainly and do NOT relabel them as football.
- isFormer: true if the page describes this person as a FORMER holder of the role, or as having left, been hired elsewhere, or been replaced.
- email: ONLY if the address is literally printed on a page you found, and emailSourceUrl MUST be that exact page URL. If you cannot give emailSourceUrl, set BOTH to null. NEVER build an address from a name and a domain. A guessed address is worse than none.
- phone: only a real published number, else null. linkedinUrl: only a profile URL you actually saw, else null.
- sourceUrl: the exact page you found this person on. REQUIRED; omit the person entirely if you cannot cite a page.
- Return {"people":[]} if the search genuinely found nobody.`;

// The contact lane returns program-level reach information, not people.
const CONTACT_TAIL = `Respond with ONLY a single JSON object and NOTHING else: no prose, no markdown, no code fences.
{"footballOfficePhone":null,"footballOfficePhoneSourceUrl":null,"recruitingEmail":null,"recruitingEmailSourceUrl":null,"collectiveEmail":null,"collectiveEmailSourceUrl":null,"collectiveName":null}
Rules:
- Every value must be literally published on a page your search actually opened, and each *SourceUrl must be that exact page.
- If you cannot cite the page an address or number came from, set BOTH that value and its source URL to null.
- NEVER construct an email address from a name, a person, or a domain. Only addresses printed on a real page.
- footballOfficePhone: the football operations or football office main line, not a ticket office or general switchboard if you can tell them apart.`;

function _lead(source, school) {
  const cfg = SCHOOLS[school] || {};
  const team = cfg.team || school;
  switch (source) {
    case 'athletics_directory':
      return `Search the OFFICIAL athletics staff directory of ${team}${cfg.athletics ? ` on ${cfg.athletics}` : ''} for FOOTBALL staff ONLY (queries "${team} FOOTBALL staff directory", "${team} football operations staff", "site:${cfg.athletics || ''} football staff directory"). The department directory also lists track, basketball, baseball and every other sport: ignore all of them. Extract the FOOTBALL general manager, director of player personnel, director of recruiting, and head coach, with exact published titles and the directory URL as sourceUrl. If the directory page shows a last-updated date, report it as publishedDate, otherwise null.`;
    case 'contacts':
      return `Find the published CONTACT details for ${team} football: the football operations or football office main phone number (try the athletics staff directory and the athletics site contact page${cfg.athletics ? ` on ${cfg.athletics}` : ''}), any published recruiting or player personnel email address, and the contact email of the NIL collective that supports ${team} (usually on the collective's own site contact page). Report only what is actually printed on a page, each with the URL of that page.\n${CONTACT_TAIL}`;
    case 'collective':
      return `Identify the NIL collective that supports ${team} and find its director or executive director. Search "${team} NIL collective executive director" and "${team} football NIL collective" and the collective's own leadership or about page. Extract the name, exact title, page URL, and the page's date if stated. Do not guess which collective it is: only report one a page actually names as supporting ${team}.`;
    case 'press':
      return `Search official ${team} athletics news posts and school or collective press releases announcing the hiring of a FOOTBALL general manager, FOOTBALL director of player personnel, or FOOTBALL director of recruiting (queries "${team} football names general manager", "${team} hires football director of player personnel"). Ignore announcements for any other sport: a track and field or baseball general manager is NOT what is wanted. Report the person named, the exact title, the release URL, and the RELEASE DATE, which these pages almost always show. If a release says someone has LEFT or been replaced, set isFormer true for that person.`;
    case 'linkedin':
      return `Search LinkedIn for the ${team} FOOTBALL general manager, FOOTBALL director of player personnel, and FOOTBALL director of recruiting (queries "${team} football general manager linkedin"). If a profile shows the role is for another sport, report that sport rather than calling it football. Extract each person's name, the exact title on their profile, and the FULL public profile URL as both linkedinUrl and sourceUrl. Only report profiles that name ${team} as the CURRENT employer; if a profile shows the role as a past position, set isFormer true.`;
    case 'news':
    default:
      return `Search recent news coverage for who currently holds these ${team} FOOTBALL roles (always include the word football in the query, because the athletics department has a general manager for several sports): general manager, director of player personnel, director of recruiting, and head coach. STRONGLY prefer articles from the last 12 months and always report each article's publication date as publishedDate. If an article says a person has left, been hired elsewhere, or been replaced, set isFormer true for that person.`;
  }
}

function _parse(raw) {
  let s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

function _cleanEmail(email, srcUrl) {
  const url = (typeof srcUrl === 'string' && /^https?:\/\//i.test(srcUrl)) ? srcUrl.trim() : null;
  const e = (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) ? String(email).trim().toLowerCase() : null;
  // Both or neither: an address with no citable page is dropped, never guessed.
  return url && e ? { email: e, url } : { email: null, url: null };
}

async function _runSource(source, school) {
  const t0 = Date.now();
  let raw = '', status = 'ran', err = '';
  let searches = 0, outTokens = 0;
  const isContactLane = source === 'contacts';
  const prompt = isContactLane ? _lead(source, school) : `${_lead(source, school)}\n${JSON_TAIL}`;
  try {
    const r = await Promise.race([
      ai.webSearchJson(prompt, SYS),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout-15s')), SOURCE_TIMEOUT_MS)),
    ]);
    raw = r.text || ''; searches = r.searches || 0; outTokens = r.outTokens || 0;
  } catch (e) { status = 'error'; err = (e && e.message) || 'error'; }
  if (status === 'ran' && !raw) status = 'empty';

  const parsed = _parse(raw) || {};
  const people = [];
  const dropped = [];
  let contacts = null;

  if (isContactLane) {
    const phoneUrl = (typeof parsed.footballOfficePhoneSourceUrl === 'string' && /^https?:\/\//i.test(parsed.footballOfficePhoneSourceUrl)) ? parsed.footballOfficePhoneSourceUrl.trim() : null;
    const rec = _cleanEmail(parsed.recruitingEmail, parsed.recruitingEmailSourceUrl);
    const col = _cleanEmail(parsed.collectiveEmail, parsed.collectiveEmailSourceUrl);
    contacts = {
      football_office_phone: (phoneUrl && parsed.footballOfficePhone) ? String(parsed.footballOfficePhone).trim() : null,
      football_office_phone_source_url: (phoneUrl && parsed.footballOfficePhone) ? phoneUrl : null,
      recruiting_email: rec.email, recruiting_email_source_url: rec.url,
      collective_email: col.email, collective_email_source_url: col.url,
      collective_name: parsed.collectiveName ? String(parsed.collectiveName).trim() : null,
    };
  } else {
    for (const p of (Array.isArray(parsed.people) ? parsed.people : [])) {
      const name = String((p && p.name) || '').trim();
      const title = String((p && p.title) || '').trim();
      const sourceUrl = (p && typeof p.sourceUrl === 'string' && /^https?:\/\//i.test(p.sourceUrl)) ? p.sourceUrl.trim() : null;
      if (!name || !title || !sourceUrl) continue;
      const em = _cleanEmail(p.email, p.emailSourceUrl);
      const linkedinUrl = (p && typeof p.linkedinUrl === 'string' && /linkedin\.com\/(in|company)\//i.test(p.linkedinUrl)) ? p.linkedinUrl.trim() : null;
      const d = parseDate(p && p.publishedDate);
      // A page that does not name this program is not evidence about this program.
      // Demoted to Tier D so it can never make a record Confident.
      const named = p && p.programNamedOnPage === false ? false : true;
      const roleGuess = _roleOf({ role: String((p && p.role) || 'other'), title });
      // SPORT GATE. A collective director is a school-level NIL role, not a
      // sport-specific one, so it is exempt; every football staff role is not.
      const sport = detectSport(p && p.sport, title, sourceUrl);
      if (roleGuess !== 'collective_director' && sport && sport !== 'football') {
        console.warn(`[program-map] school="${school}" role=${roleGuess || 'other'} name="${name}" sportDetected=${sport} DROPPED (source=${source} ${sourceUrl})`);
        dropped.push({ name, title, role: roleGuess || 'other', sport, sourceUrl, source });
        continue;
      }
      let tier = named ? classifyTier(sourceUrl, school) : 'D';
      // A department-wide directory listing every sport is not football evidence on
      // its own: the title must name football, or the page must sit on a football
      // path. Otherwise the Tier A claim is downgraded and needs corroboration.
      let tierNote = null;
      if (tier === 'A' && roleGuess !== 'collective_director' && !footballScoped(title, sourceUrl)) {
        tier = 'B';
        tierNote = 'department-wide directory, sport not stated on the page';
        console.log(`[program-map] school="${school}" role=${roleGuess || 'other'} name="${name}" tierA downgraded: ${tierNote}`);
      }
      people.push({
        name, title,
        role: String((p && p.role) || 'other'),
        email: em.email, emailSourceUrl: em.url,
        phone: (p && p.phone) ? String(p.phone).trim() : null,
        linkedinUrl, sourceUrl, tier, source, sport, tierNote,
        dateMs: d ? d.getTime() : null,
        dateStr: d ? d.toISOString().slice(0, 10) : null,
        isFormer: !!(p && p.isFormer),
        programNamed: named,
      });
    }
  }
  return { source, people, dropped, contacts, status, err, ms: Date.now() - t0, searches, outTokens, rawLen: raw.length };
}

function _roleOf(p) {
  const title = String((p && p.title) || '');
  // A title that names FOOTBALL is a football staff role, never the NIL collective
  // director, whatever the model labeled it. This is the Tennessee case: "Executive
  // Director of Football Management" is a general manager.
  const saysFootball = /\bfootball\b/i.test(title);
  const saysCollective = /\bcollective\b|\bnil\b/i.test(title);
  const misfiled = (key) => key === 'collective_director' && saysFootball && !saysCollective;
  const known = ROLES.find((r) => r.key === (p && p.role));
  if (known && !misfiled(known.key)) return known.key;
  for (const r of ROLES) {
    if (misfiled(r.key)) continue;
    if (r.match.test(title)) return r.key;
  }
  return null;
}
function _nameKey(n) { return String(n || '').toLowerCase().replace(/[^a-z]/g, ''); }

// Newest evidence for a candidate (null when every source is undated).
function _newestMs(cands) {
  const dated = cands.map((c) => c.dateMs).filter((x) => x != null);
  return dated.length ? Math.max(...dated) : null;
}

// Confidence, with the recency gate applied.
function _assess(cands, nowMs) {
  const newest = _newestMs(cands);
  const stale = isStale(newest, nowMs);
  const freshOrUndated = !stale;
  const hasA = cands.some((c) => c.tier === 'A');
  if (stale) return 'stale';            // nothing old stands alone, even Tier A
  if (hasA && freshOrUndated) return 'confident';
  const bc = cands.filter((c) => (c.tier === 'B' || c.tier === 'C') && !isStale(c.dateMs, nowMs));
  const hosts = new Set(bc.map((c) => _host(c.sourceUrl)));
  const lanes = new Set(bc.map((c) => c.source));
  if (bc.length >= 2 && hosts.size >= 2 && lanes.size >= 2) return 'confident';
  if (bc.length >= 1) return 'likely';
  return 'unverified';
}

// Order candidates for a role: most recently dated first, undated last, tier as the
// tie-break. This is what stops a 2021 press release outranking a 2026 one.
function _byRecency(a, b) {
  // AUTHORITY BEFORE RECENCY. The school's own staff directory is the record of who
  // holds the job; a dated news article is a claim ABOUT it. Ole Miss had a Tier A
  // directory listing demoted to 'previous' by an SI article that was not even about
  // Ole Miss. Tier A now outranks any non-A candidate outright, and dates order
  // candidates only within the same authority class.
  const aA = a.some((c) => c.tier === 'A'), bA = b.some((c) => c.tier === 'A');
  if (aA !== bA) return aA ? -1 : 1;
  const am = _newestMs(a), bm = _newestMs(b);
  if (am != null && bm != null && am !== bm) return bm - am;
  if (am != null && bm == null) return -1;
  if (am == null && bm != null) return 1;
  const at = Math.min(...a.map((c) => 'ABCD'.indexOf(c.tier)));
  const bt = Math.min(...b.map((c) => 'ABCD'.indexOf(c.tier)));
  return at - bt;
}

// ── Football staff page: discover once, then fetch forever ───────────────────
// Discovery is a single search, run ONLY when program_source has no URL yet. After
// that the URL is read from the table and never searched for again, which is what
// removes the run-to-run variance.
const STAFF_URL_SYS = 'You find the exact URL of one specific page. Output ONLY JSON. Never invent a URL.';

async function discoverStaffUrl(school, store) {
  const cfg = SCHOOLS[school] || {};
  const team = cfg.team || school;
  const prompt = `Find the official FOOTBALL staff directory or coaching staff page for ${team}${cfg.athletics ? ` on ${cfg.athletics}` : ''}. This is the page listing the football coaches and support staff with their titles, for example a URL like ${cfg.athletics || 'school-athletics.com'}/sports/football/coaches or /staff-directory/football-department. Also find the athletics department CONTACT page that lists office phone numbers.
Respond with ONLY: {"footballStaffUrl":null,"athleticsContactUrl":null}
Rules:
- Both must be real URLs your search actually surfaced on ${cfg.athletics || "the school's athletics site"}. Never construct or guess a URL.
- footballStaffUrl must be the FOOTBALL staff or coaches page, not a department-wide directory and not a roster of players.
- Use null for anything you cannot find.`;
  try {
    const r = await ai.webSearchJson(prompt, STAFF_URL_SYS);
    const o = _parse(r.text) || {};
    const ok = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u.trim() : null;
    const staffUrl = ok(o.footballStaffUrl);
    const contactUrl = ok(o.athleticsContactUrl);
    if (staffUrl) {
      await store.saveProgramSourceUrl(school, staffUrl, 'search', contactUrl);
      console.log(`[program-map] school="${school}" staff URL DISCOVERED and persisted: ${staffUrl}`);
    } else {
      console.warn(`[program-map] school="${school}" staff URL discovery found nothing`);
    }
    return { staffUrl, contactUrl };
  } catch (e) {
    console.warn(`[program-map] school="${school}" staff URL discovery failed: ${e.message}`);
    return { staffUrl: null, contactUrl: null };
  }
}

// Load the football staff page for a school: config first, discover only if missing.
// Returns { staff, url, via, diff, hash }.
async function loadFootballStaff(school, store, opts = {}) {
  const staffPage = require('./staffPage');
  let src = await store.getProgramSource(school);
  let url = src && src.football_staff_url;
  if (!url || opts.rediscover) {
    const d = await discoverStaffUrl(school, store);
    url = d.staffUrl;
    src = await store.getProgramSource(school);
  }
  if (!url) return { staff: [], url: null, via: 'none', diff: null, hash: null };

  const loaded = await staffPage.loadStaff(url, ai);
  if (!loaded.ok) return { staff: [], url, via: 'none', error: loaded.reason, diff: null, hash: null };

  // Weekly re-fetch diff: what changed since the last snapshot IS the alert feature.
  const prev = (src && Array.isArray(src.last_staff)) ? src.last_staff : [];
  const diff = prev.length ? staffPage.diffStaff(prev, loaded.staff) : null;
  if (diff && (diff.added.length || diff.removed.length || diff.changed.length)) {
    console.log(`[program-map] school="${school}" STAFF CHANGES since last fetch: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`);
    for (const a of diff.added) console.log(`    ARRIVED  ${a.name} (${a.title || 'no title'})`);
    for (const r of diff.removed) console.log(`    LEFT     ${r.name} (${r.title || 'no title'})`);
    for (const c of diff.changed) console.log(`    CHANGED  ${c.name}: ${c.from || 'none'} -> ${c.to || 'none'}`);
  }
  await store.saveProgramStaffSnapshot(school, loaded.staff, loaded.hash, loaded.via);
  return { staff: loaded.staff, url: loaded.finalUrl || url, via: loaded.via, diff, hash: loaded.hash };
}

// Turn parsed staff-page rows into records. Everything on this page is football and
// current by definition, so it is Tier A with no sport gate and no date needed.
function recordsFromStaffPage(school, staff, url) {
  const out = [];
  const takenRole = new Set();
  for (const p of (staff || [])) {
    const role = _roleOf({ role: 'other', title: p.title || '' });
    if (!role) continue;
    // First listed holder of a role wins; a directory lists them in seniority order.
    if (takenRole.has(role)) continue;
    takenRole.add(role);
    const label = (ROLES.find((r) => r.key === role) || {}).label || role;
    out.push({
      school, role, role_label: label,
      name: p.name, title: p.title || null,
      email: p.email || null,
      email_source_url: p.email ? url : null,
      phone: p.phone || null,
      linkedin_url: null,
      source_url: url,
      source_tier: 'A',
      sport: 'football',
      source_tier_note: null,
      source_date: null,
      age_months: null,
      status: 'current',
      confidence: 'confident',
      sources: [{ tier: 'A', lane: 'staff_page', url, date: null, title: p.title || null, isFormer: false, sport: 'football' }],
    });
  }
  return out;
}

async function buildProgram(school, nowMs, store) {
  const now = nowMs || Date.now();
  const t0 = Date.now();

  // PRIMARY SOURCE: the school's own football staff page, fetched directly. One
  // deterministic GET replaces the search fan-out for every role it covers.
  let pageRecords = [];
  let pageInfo = null;
  if (store) {
    try {
      pageInfo = await loadFootballStaff(school, store);
      pageRecords = recordsFromStaffPage(school, pageInfo.staff, pageInfo.url);
      console.log(`[program-map] school="${school}" staffPage url=${pageInfo.url || 'none'} parsed=${pageInfo.staff.length} rolesMatched=${pageRecords.length} via=${pageInfo.via}`);
    } catch (e) { console.warn(`[program-map] school="${school}" staff page failed: ${e.message}`); }
  }
  const covered = new Set(pageRecords.map((r) => r.role));
  const missing = ROLES.filter((r) => !covered.has(r.key)).map((r) => r.key);
  // SEARCH IS NOW THE EXCEPTION. It runs only for roles the page did not list.
  // A page that covered everything means zero searches for this program.
  const needSearch = missing.length > 0;
  console.log(`[program-map] school="${school}" fromStaffPage=${[...covered].join(',') || 'none'} needSearch=${needSearch ? missing.join(',') : 'no'}`);
  if (!needSearch) {
    const filled0 = covered.size;
    console.log(`[program-map] school="${school}" roles=${filled0}/${ROLES.length} records=${pageRecords.length} searches=0 totalMs=${Date.now() - t0} (staff page only)`);
    return { school, records: pageRecords, contacts: null, droppedWrongSport: [], staffPage: pageInfo,
      ms: Date.now() - t0, meter: { searches: 0, outTokens: 0, sources: 0 }, rolesFilled: filled0, rolesTotal: ROLES.length };
  }

  const run = await ai.runSourceWaves(SOURCE_ORDER, (src) => _runSource(src, school), {
    waveSize: 3,
    wallBudgetMs: WALL_BUDGET_MS,
    label: `program=${school}`,
    hasWin: (r) => (r.people || []).some((p) => p.tier === 'A'),
    onResult: (r) => {
      const tierA = (r.people || []).some((p) => p.tier === 'A');
      const dated = (r.people || []).filter((p) => p.dateMs != null).length;
      console.log(`[program-map] school="${school}" source=${r.source} ms=${r.ms} found=${r.people.length} dropped=${(r.dropped || []).length} dated=${dated} tierA=${tierA ? 'yes' : 'no'} searches=${r.searches} status=${r.status}${r.err ? ' err=' + r.err : ''}`);
    },
    isSatisfied: () => false,
  });

  const all = run.results.flatMap((r) => r.people);
  const droppedWrongSport = run.results.flatMap((r) => r.dropped || []);
  const contactRow = run.results.map((r) => r.contacts).find(Boolean) || null;
  const meter = { searches: 0, outTokens: 0, sources: run.results.length };
  for (const r of run.results) { meter.searches += r.searches || 0; meter.outTokens += r.outTokens || 0; }

  const records = [...pageRecords];
  for (const role of ROLES) {
    // The staff page already settled this role; a search result cannot override the
    // school's own football staff listing.
    if (covered.has(role.key)) continue;
    const forRole = all.filter((p) => _roleOf(p) === role.key);
    if (!forRole.length) {
      console.log(`[program-map] school="${school}" role=${role.key} found=0 tierA=no confidence=empty`);
      continue;
    }
    const byPerson = new Map();
    for (const p of forRole) {
      const k = _nameKey(p.name);
      if (!k) continue;
      if (!byPerson.has(k)) byPerson.set(k, []);
      byPerson.get(k).push(p);
    }
    // A person every source calls FORMER is a predecessor, not a tie.
    const groups = [...byPerson.values()];
    const active = groups.filter((cs) => !cs.every((c) => c.isFormer));
    const ranked = (active.length ? active : groups).sort(_byRecency);

    // Conflicting only when the top two cannot be separated by date: both undated,
    // or their newest dates fall within TIE_DAYS of each other.
    let conflicting = false;
    if (ranked.length > 1) {
      const a = _newestMs(ranked[0]), b = _newestMs(ranked[1]);
      if (a == null && b == null) conflicting = true;
      else if (a != null && b != null && Math.abs(a - b) <= TIE_DAYS * 864e5) conflicting = true;
    }

    ranked.forEach((cands, idx) => {
      const best = cands.slice().sort((x, y) => {
        if (x.dateMs != null && y.dateMs != null && x.dateMs !== y.dateMs) return y.dateMs - x.dateMs;
        if (x.dateMs != null && y.dateMs == null) return -1;
        if (x.dateMs == null && y.dateMs != null) return 1;
        return 'ABCD'.indexOf(x.tier) - 'ABCD'.indexOf(y.tier);
      })[0];
      const withEmail = cands.find((c) => c.email) || null;
      const withPhone = cands.find((c) => c.phone) || null;
      const withLi = cands.find((c) => c.linkedinUrl) || null;
      const newest = _newestMs(cands);
      // Only the top-ranked candidate is current. Everyone else is a PREVIOUS holder,
      // stored with their date rather than shown as the incumbent.
      const isCurrent = idx === 0 && !cands.every((c) => c.isFormer);
      const own = _assess(cands, now);
      records.push({
        school, role: role.key, role_label: role.label,
        name: best.name, title: best.title,
        email: withEmail ? withEmail.email : null,
        email_source_url: withEmail ? withEmail.emailSourceUrl : null,
        phone: withPhone ? withPhone.phone : null,
        linkedin_url: withLi ? withLi.linkedinUrl : null,
        source_url: best.sourceUrl,
        source_tier: best.tier,
        sport: (cands.map((c) => c.sport).find(Boolean)) || 'unstated',
        source_tier_note: cands.map((c) => c.tierNote).find(Boolean) || null,
        source_date: newest ? new Date(newest).toISOString().slice(0, 10) : null,
        age_months: newest ? Math.round(monthsSince(newest, now) * 10) / 10 : null,
        status: isCurrent ? 'current' : 'previous',
        confidence: isCurrent ? (conflicting ? 'conflicting' : own) : 'previous',
        sources: cands.map((c) => ({ tier: c.tier, lane: c.source, url: c.sourceUrl, date: c.dateStr, title: c.title, isFormer: c.isFormer, sport: c.sport || 'unstated' })),
      });
    });
    const cur = records.filter((x) => x.role === role.key && x.status === 'current')[0];
    const prevN = records.filter((x) => x.role === role.key && x.status === 'previous').length;
    console.log(`[program-map] school="${school}" role=${role.key} found=${ranked.length} tierA=${forRole.some((p) => p.tier === 'A') ? 'yes' : 'no'} confidence=${cur ? cur.confidence : 'empty'} date=${cur ? (cur.source_date || 'undated') : '-'} previous=${prevN}`);
  }

  const filled = new Set(records.filter((r) => r.status === 'current').map((r) => r.role)).size;
  if (droppedWrongSport.length) {
    const bySport = {};
    for (const d of droppedWrongSport) bySport[d.sport] = (bySport[d.sport] || 0) + 1;
    console.log(`[program-map] school="${school}" wrongSportDropped=${droppedWrongSport.length} ${JSON.stringify(bySport)}`);
  }
  console.log(`[program-map] school="${school}" roles=${filled}/${ROLES.length} records=${records.length} dropped=${droppedWrongSport.length} sources=${meter.sources} searches=${meter.searches} totalMs=${Date.now() - t0}`);
  return { school, records, contacts: contactRow, droppedWrongSport, staffPage: pageInfo, ms: Date.now() - t0, meter, rolesFilled: filled, rolesTotal: ROLES.length };
}

// CROSS-SCHOOL DEDUPE. One person cannot hold the same role at two programs. When a
// name shows up for the same role at more than one school, the more recently dated
// evidence keeps 'current' and the others are demoted to 'previous' (they are almost
// always the person's former program). Logged so the rate is visible.
function dedupeAcrossSchools(allRecords) {
  const byPersonRole = new Map();
  for (const r of allRecords) {
    if (r.status !== 'current') continue;
    const k = _nameKey(r.name) + '|' + r.role;
    if (!byPersonRole.has(k)) byPersonRole.set(k, []);
    byPersonRole.get(k).push(r);
  }
  let collisions = 0, demoted = 0;
  for (const [k, rows] of byPersonRole) {
    if (rows.length < 2) continue;
    collisions++;
    const sorted = rows.slice().sort((a, b) => {
      const am = a.source_date ? Date.parse(a.source_date) : null;
      const bm = b.source_date ? Date.parse(b.source_date) : null;
      if (am != null && bm != null && am !== bm) return bm - am;
      if (am != null && bm == null) return -1;
      if (am == null && bm != null) return 1;
      return 'ABCD'.indexOf(a.source_tier) - 'ABCD'.indexOf(b.source_tier);
    });
    const winner = sorted[0];
    console.warn(`[program-map] CROSS-SCHOOL COLLISION name="${winner.name}" role=${winner.role}: ` +
      rows.map((r) => `${r.school}(${r.source_date || 'undated'},${r.source_tier})`).join(' vs ') +
      ` -> keeping ${winner.school}`);
    for (const r of sorted.slice(1)) {
      r.status = 'previous';
      r.confidence = 'previous';
      r.superseded_note = `Same person listed as ${winner.role_label} at ${winner.school} on more recent evidence (${winner.source_date || 'undated'}). Treated as a former ${r.school} record.`;
      demoted++;
    }
  }
  console.log(`[program-map] cross-school dedupe: ${collisions} collision(s), ${demoted} record(s) demoted to previous`);
  return { collisions, demoted };
}

// "How to reach" fallback, mirroring the brand ladder: a record with no direct
// contact still tells the agent what to do.
function reachVia(record, contacts) {
  if (record.email) return `Email ${record.email}`;
  if (record.phone) return `Call ${record.phone}`;
  if (record.linkedin_url) return 'Message on LinkedIn';
  const c = contacts || {};
  if (c.football_office_phone) return `No direct contact published. Call the football office at ${c.football_office_phone} and ask for ${record.name}.`;
  if (record.role === 'collective_director' && c.collective_email) return `No direct contact published. Email the collective at ${c.collective_email}.`;
  if (c.recruiting_email) return `No direct contact published. Email the recruiting office at ${c.recruiting_email}.`;
  return 'No published contact found for this program yet.';
}

module.exports = {
  buildProgram, dedupeAcrossSchools, reachVia, discoverStaffUrl, loadFootballStaff, recordsFromStaffPage, classifyTier, parseDate, isStale, monthsSince,
  detectSport, footballScoped,
  ROLES, SCHOOLS, PILOT_SCHOOLS, SOURCE_ORDER, STALE_MONTHS, _assess, _roleOf, _byRecency, _newestMs,
};
