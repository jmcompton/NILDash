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
  // GM / football operations bucket. A program calls this seat several things, and
  // missing any of them left the role empty on pages that clearly listed it:
  // "Chief of Staff", "Sr. Director of Football Operations", "Executive Director of
  // Football Management" are all this bucket.
  { key: 'general_manager', label: 'General Manager / Football Ops', match: /\bgeneral manager\b|\bgm\b|chief of staff|director of football operations|football operations|executive director of football|director of football management|\bfootball management\b|\bfootball administration\b/i },
  { key: 'player_personnel', label: 'Player Personnel', match: /player personnel|\bpersonnel\b|\bscouting\b/i },
  { key: 'recruiting', label: 'Recruiting', match: /recruiting|recruitment/i },
  // "Head Football Coach" is as common a title as "Head Coach" and a bare /head coach/
  // never matched it, which left the head coach empty on pages that plainly listed
  // one. Only "football" is allowed between the two words: widening it further would
  // swallow "Head Strength Coach" and "Head Athletic Trainer".
  { key: 'head_coach', label: 'Head Coach', match: /\bhead\s+(?:football\s+)?coach\b/i },
  // "executive director" alone is NOT enough: Tennessee's "Executive Director of
  // Football Management" is a GM, not a collective role. Require collective/NIL.
  { key: 'collective_director', label: 'NIL Collective Director', match: /\bcollective\b|\bnil\b/i },
];

// Seniority within a role, lower = more senior. Where several people plausibly hold
// a role we rank them rather than picking one arbitrarily: Florida lists both a
// General Manager and an ASSISTANT General Manager, and Georgia has four people in
// recruiting operations. All are kept; the most senior becomes the key contact.
function seniorityRank(title) {
  const t = String(title || '').toLowerCase();
  if (/\bhead\s+(?:football\s+)?coach\b/.test(t)) return 0;
  if (/\bassistant\b|\bassoc(iate)?\b|\bdeputy\b/.test(t)) {
    // An "Assistant AD" outranks an "Assistant Director"; both sit below the chief.
    if (/athletic director|\bad\b/.test(t)) return 4;
    return 6;
  }
  if (/\bexecutive director\b|\bgeneral manager\b|\bchief\b/.test(t)) return 1;
  if (/\bsenior\b|\bsr\.?\b/.test(t)) return 2;
  if (/\bdirector\b/.test(t)) return 3;
  if (/\bmanager\b/.test(t)) return 5;
  if (/\bcoordinator\b/.test(t)) return 7;
  if (/\banalyst\b|\bspecialist\b/.test(t)) return 8;
  if (/\bassistant to\b|\bintern\b|\bgraduate\b/.test(t)) return 9;
  return 6;
}



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

// The rest of FBS. Merged UNDERNEATH the pilot map so a pilot entry always wins:
// those ten carry hand-verified URLs and a team name used for grounding, and a bulk
// list must never overwrite them. Everything here has only a domain, which is all
// the sweep needs.
// Fail-soft: server/data is covered by a `data/` .gitignore rule and this file is
// tracked only by an explicit add. If it ever goes missing from a deploy, the
// program map degrades to the pilot ten rather than crashing the whole server at
// require time. An optional school list is not worth a boot failure.
let FBS_SCHOOLS = {};
try {
  FBS_SCHOOLS = require('../data/fbsSchools').FBS_SCHOOLS || {};
} catch (e) {
  console.warn('[program-map] FBS school list not found, falling back to the pilot programs only:', e.message);
}
for (const [school, athletics] of Object.entries(FBS_SCHOOLS)) {
  if (!SCHOOLS[school]) SCHOOLS[school] = { athletics, team: school };
}
const ALL_SCHOOLS = Object.keys(SCHOOLS).sort();

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

// ── FINAL SPORT GUARD ────────────────────────────────────────────────────────
// The section filter stops a department directory from contributing other sports,
// but a page with no usable section headings is left unfiltered by design, and
// nothing downstream re-checked. Missouri came back with the BASEBALL head coach
// (section "BASEBALL", email baseball@missouri.edu) selected as the FOOTBALL head
// coach. Perfectly sourced and completely wrong, which is the dangerous kind.
//
// So this runs on EVERY record from EVERY school, filtered or not. It is a last
// guard, not a replacement for the section filter.

// An email address is a claim about who someone is. baseball@missouri.edu on a row
// selected as the football head coach is a contradiction, and the address is the
// harder evidence of the two. Tokenised rather than regexed so that "patrick" cannot
// match "track" and "jbaseball" cannot match "baseball".
const SPORT_EMAIL_TOKENS = new Map();
for (const [name] of OTHER_SPORTS) SPORT_EMAIL_TOKENS.set(name, name);
for (const [tok, name] of [['mbb', 'basketball'], ['wbb', 'basketball'], ['hoops', 'basketball'],
  ['xc', 'track'], ['crosscountry', 'track'], ['trackandfield', 'track'], ['tf', 'track'],
  ['swim', 'swimming'], ['dive', 'swimming'], ['diving', 'swimming'], ['crew', 'rowing'],
  ['vball', 'volleyball'], ['bball', 'basketball'], ['sball', 'softball']]) {
  SPORT_EMAIL_TOKENS.set(tok, name);
}

function emailNamesOtherSport(email) {
  const v = String(email || '').toLowerCase();
  if (!v) return null;
  const tokens = v.split(/[^a-z]+/).filter(Boolean);
  // An address that names football outright is not a contradiction.
  if (tokens.includes('football') || tokens.includes('fb') || tokens.includes('fball')) return null;
  for (const t of tokens) if (SPORT_EMAIL_TOKENS.has(t)) return SPORT_EMAIL_TOKENS.get(t);
  return null;
}

// Free text (a section heading or a title) that names another sport and does NOT
// name football. "Football / Basketball Operations" is a football role; "BASKETBALL,
// MEN'S" is not.
function textNamesOtherSport(text) {
  const v = String(text || '');
  if (!v.trim()) return null;
  if (FOOTBALL_RE.test(v)) return null;
  for (const [name, re] of OTHER_SPORTS) if (re.test(v)) return name;
  return null;
}

// Returns null when the person is fine, otherwise why they cannot be football.
// kind 'email' means DROP the record: the address contradicts the claim outright.
// kind 'section' or 'title' means the person may stay on the roster but can never
// be selected as a football key contact.
function sportContradiction(p) {
  const byEmail = emailNamesOtherSport(p && p.email);
  if (byEmail) return { kind: 'email', sport: byEmail, evidence: p.email };
  const bySection = textNamesOtherSport(p && p.section);
  if (bySection) return { kind: 'section', sport: bySection, evidence: p.section };
  const byTitle = textNamesOtherSport(p && p.title);
  if (byTitle) return { kind: 'title', sport: byTitle, evidence: p.title };
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

// ── Football staff page: sweep known paths, then fetch forever ───────────────
// URL discovery is a PATTERN problem, not a search problem. Nearly every FBS
// athletics site runs on Sidearm, and the football staff page sits at one of a small
// number of predictable paths. Asking a model to search for it produced 404s and
// run-to-run variance; trying the eight paths that actually work is deterministic,
// costs nothing, and either finds the page or proves it is not at a known path.
//
// Every one of these came off a run that worked:
//   /sports/football/coaches             Georgia, Ole Miss, Alabama
//   /staff-directory/department/football Auburn
//   /sports/football/coaches/            Florida, after redirect
// South Carolina's /staff-directory/football-803-777-4271/ is deliberately absent:
// the phone is part of the slug, so it cannot be a fixed pattern. It stays hand-set.
const STAFF_URL_CANDIDATES = [
  '/sports/football/coaches',
  '/sports/football/coaches/',
  '/sports/football/staff',
  '/staff-directory/department/football',
  '/staff-directory?path=football',
  '/staff-directory/football',
  '/coaches.aspx?path=football',
  '/sports/football/roster/staff',
];

// URLs verified by hand from a run that produced real people with real titles. These
// are seeded as hand-set (locked) so the sweep can never replace them. Alabama is here
// because a count-based sweep did exactly that: it replaced the 19-person coaching
// page holding Kalen DeBoer, Courtney Morgan and Bob Welton with a 381-row navigation
// dump that had no titles, no emails and no roles at all.
const VERIFIED_STAFF_URLS = {
  'Alabama':        'https://rolltide.com/sports/football/coaches',
  'Georgia':        'https://georgiadogs.com/sports/football/coaches',
  'Ole Miss':       'https://olemisssports.com/sports/football/coaches',
  'Florida':        'https://floridagators.com/sports/football/coaches/',
  'South Carolina': 'https://gamecocksonline.com/staff-directory/football-803-777-4271/',
};

// A quality floor still needs a size floor under it, but it is now a sanity check
// rather than the acceptance rule. Acceptance is scoreStaffPage.
const MIN_SWEEP_STAFF = 5;
const SWEEP_PAUSE_MS = 250; // one host, several requests: do not hammer it

const KEY_ROLE_PATTERNS = ROLES.map((r) => r.match);

// Write the hand-verified URL for a school if it has one and nothing is locked yet.
// A URL the user set themselves always wins over this list.
async function seedVerifiedUrl(school, store) {
  const good = VERIFIED_STAFF_URLS[school];
  if (!good) return false;
  const src = await store.getProgramSource(school);
  if (src && src.url_locked) return false;
  await store.saveProgramSourceUrl(school, good, 'manual', src && src.athletics_contact_url);
  console.log(`[program-map] school="${school}" restored verified staff URL and LOCKED it: ${good}`);
  return true;
}

const _pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Try the known paths in order against a school's athletics domain. Returns
// { url, staffCount, tried, via }. url is null when nothing hit, which is the
// signal to fall back to search and flag the school.
//
// Parsing here is DETERMINISTIC ONLY, never the model fallback: a sweep may fetch
// eight pages per school and paying a model to read each miss would be absurd. Once a
// winner is persisted, loadStaff runs normally and can still use the model.
async function sweepStaffUrl(school, store, opts = {}) {
  const staffPage = require('./staffPage');
  const cfg = SCHOOLS[school] || {};
  const domain = cfg.athletics;
  if (!domain) {
    console.warn(`[url-sweep] school="${school}" no athletics domain configured, cannot sweep`);
    return { url: null, staffCount: 0, tried: [], via: 'none' };
  }

  // Restore a hand-verified URL before anything else, so a school that a previous
  // sweep damaged comes back on the next run without manual intervention.
  await seedVerifiedUrl(school, store);
  const src = await store.getProgramSource(school);
  // A hand-set URL is never swept over. That is the whole point of url_locked.
  if (src && src.url_locked && !opts.force) {
    console.log(`[url-sweep] school="${school}" SKIPPED, URL is hand-set: ${src.football_staff_url}`);
    return { url: src.football_staff_url, staffCount: null, tried: [], via: 'manual', skipped: true };
  }

  const tried = [];
  const seen = new Set();
  let best = null;
  // The INCUMBENT is scored as an ordinary candidate rather than trusted on its
  // stored row count. Comparing a stored count against a fresh one is what let a
  // 381-row junk page outrank a 19-row real one; the only fair comparison is to
  // fetch both and score both the same way.
  const incumbent = src && src.football_staff_url;
  const candidates = [
    ...(incumbent ? [{ path: '(current)', url: incumbent, isIncumbent: true }] : []),
    ...STAFF_URL_CANDIDATES.map((p) => ({ path: p, url: `https://${domain}${p}` })),
  ];
  for (const cand of candidates) {
    const { path, url } = cand;
    const got = await staffPage.fetchStaffPage(url);
    if (!got.ok) {
      const status = got.status || got.reason;
      console.log(`[url-sweep] school="${school}" try=${path} status=${status}`);
      tried.push({ path, status, staff: 0 });
      await _pause(SWEEP_PAUSE_MS);
      continue;
    }
    // Two candidates often redirect to the same page (the trailing-slash pair always
    // does). Counting it twice would misreport how many distinct pages exist.
    const finalUrl = got.finalUrl || url;
    if (seen.has(finalUrl)) {
      console.log(`[url-sweep] school="${school}" try=${path} status=${got.status} same page as an earlier try, skipped`);
      tried.push({ path, status: got.status, staff: 0, duplicateOf: finalUrl });
      continue;
    }
    seen.add(finalUrl);

    const parsed = staffPage.parseStaffHtml(got.html, finalUrl);
    // Cut a department-wide directory to its football sections BEFORE scoring, so a
    // page is judged on the football staff it actually contributes.
    const filt = staffPage.filterToFootballSections(parsed);
    const staff = filt.staff;
    const n = staff.length;
    const score = staffPage.scoreStaffPage(staff, KEY_ROLE_PATTERNS);
    const accepted = score.accepted && n >= MIN_SWEEP_STAFF;
    const redirect = finalUrl !== url ? ` -> ${finalUrl}` : '';
    const pct = (x) => `${Math.round(x * 100)}%`;
    const detail = `titles=${pct(score.titleRate)} junk=${pct(score.junkRate)} keyRoles=${score.keyRoles}/${KEY_ROLE_PATTERNS.length}` +
      (filt.filtered ? ` (cut to football sections, -${filt.dropped})` : '');
    console.log(`[url-sweep] school="${school}" try=${path}${redirect} status=${got.status} staff=${n} ${detail}` +
      (accepted ? ' ACCEPTED' : ` REJECTED: ${score.reasons.join('; ') || 'too few rows'}`));
    tried.push({ path, status: got.status, staff: n, url: finalUrl, accepted, score, reasons: score.reasons });
    // Among pages that PASS quality, prefer the one covering more key roles, then the
    // fuller one. Row count never outranks quality, which is the Alabama regression.
    if (accepted && (!best || score.keyRoles > best.score.keyRoles ||
      (score.keyRoles === best.score.keyRoles && n > best.staffCount))) {
      best = { url: finalUrl, staffCount: n, path, score, isIncumbent: !!cand.isIncumbent };
    }
    // The incumbent passing quality means there is nothing to fix, so stop. Otherwise
    // stop at the first candidate PATH that hits, per the spec. --all-paths keeps
    // going so a thin page can be compared against every other candidate, which is
    // how a separate support-staff page shows itself.
    if (accepted && !opts.allPaths) break;
    await _pause(SWEEP_PAUSE_MS);
  }

  if (!best) {
    console.warn(`[url-sweep] school="${school}" NO CANDIDATE PATH WORKED (${tried.length} tried)`);
    return { url: null, staffCount: 0, tried, via: 'none' };
  }
  if (best.isIncumbent) {
    console.log(`[url-sweep] school="${school}" existing URL still passes quality (${best.staffCount} staff, ${best.score.keyRoles} key roles), left alone`);
    return { url: best.url, staffCount: best.staffCount, tried, via: src.football_staff_url_discovered_via || 'existing', skipped: true };
  }
  await store.saveProgramSourceUrl(school, best.url, 'sweep', src && src.athletics_contact_url);
  console.log(`[url-sweep] school="${school}" PERSISTED ${best.url} (${best.staffCount} staff, ${best.score.keyRoles} key roles, via ${best.path})`);
  return { url: best.url, staffCount: best.staffCount, tried, via: 'sweep', score: best.score };
}

// Search is now the EXCEPTION, run only when no known path worked. A school that
// lands here is flagged so it shows up in the output as needing attention.
const STAFF_URL_SYS = 'You find the exact URL of one specific page. Output ONLY JSON. Never invent a URL.';

// Wall-clock caps. Every external call in this file is bounded, because the job
// that uses them walks 135 schools and one stall must cost one school, not the run.
const DISCOVER_TIMEOUT_MS = 30000;   // the search fallback
const SCHOOL_TIMEOUT_MS = 90000;     // backstop around one school's entire fetch

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
    // HARD CAP. webSearchJson is uncapped and inherits the SDK's ten-minute default,
    // so without this one school can block a 135-school run forever. That is not a
    // theoretical risk: it is what happened on Minnesota.
    const r = await ai.withTimeout(
      ai.webSearchJson(prompt, STAFF_URL_SYS), DISCOVER_TIMEOUT_MS, `staff URL search for ${school}`);
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
    const timedOut = /^timeout after/.test(e.message || '');
    console.warn(`[program-map] school="${school}" staff URL discovery ${timedOut ? 'TIMED OUT' : 'failed'}: ${e.message}`);
    if (timedOut) console.warn(`[program-map] school="${school}" NEEDS ATTENTION: search timed out, moving on. Set a URL by hand with --set-url.`);
    return { staffUrl: null, contactUrl: null, timedOut };
  }
}

// Load the football staff page for a school: config first, discover only if missing.
// Returns { staff, url, via, diff, hash }.
async function loadFootballStaff(school, store, opts = {}) {
  const staffPage = require('./staffPage');
  // Restore a hand-verified URL if this school has one and nothing is locked yet.
  // Alabama needs this on a plain fetch, not only under --sweep.
  await seedVerifiedUrl(school, store);
  let src = await store.getProgramSource(school);
  let url = src && src.football_staff_url;
  let needsAttention = false;
  if (!url || opts.rediscover) {
    // Pattern first: eight known paths, deterministic, free.
    const swept = await sweepStaffUrl(school, store, opts);
    url = swept.url;
    // Only if every known path missed does this become a search problem again.
    if (!url) {
      console.warn(`[program-map] school="${school}" no known path worked, falling back to search`);
      const d = await discoverStaffUrl(school, store);
      url = d.staffUrl;
      needsAttention = true;
    }
    src = await store.getProgramSource(school);
  }
  if (!url) {
    console.warn(`[program-map] school="${school}" NEEDS ATTENTION: no staff URL from sweep or search. Set one by hand with --set-url.`);
    return { staff: [], url: null, via: 'none', diff: null, hash: null, needsAttention: true };
  }

  const loaded = await staffPage.loadStaff(url, ai);
  if (!loaded.ok) {
    // A stored URL that has started 404ing is exactly what the sweep repairs, so try
    // it once here rather than making the school a manual chore. _repaired makes this
    // strictly one attempt: without it a replacement that also fails would recurse
    // forever. A hand-set URL is still never swept over even when it breaks, because
    // sweepStaffUrl checks the lock itself. It gets flagged for attention instead.
    if (!opts._repaired) {
      console.warn(`[program-map] school="${school}" stored URL failed (${loaded.reason}), sweeping for a replacement`);
      const swept = await sweepStaffUrl(school, store, opts);
      if (swept.url && swept.url !== url) {
        return loadFootballStaff(school, store, { ...opts, rediscover: false, _repaired: true });
      }
    }
    return { staff: [], url, via: 'none', error: loaded.reason, diff: null, hash: null, needsAttention: true };
  }

  // Weekly re-fetch diff: what changed since the last snapshot IS the alert feature.
  const prev = (src && Array.isArray(src.last_staff)) ? src.last_staff : [];
  const diff = prev.length ? staffPage.diffStaff(prev, loaded.staff) : null;
  if (diff && (diff.added.length || diff.removed.length || diff.changed.length)) {
    console.log(`[program-map] school="${school}" STAFF CHANGES since last fetch: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`);
    for (const a of diff.added) console.log(`    ARRIVED  ${a.name} (${a.title || 'no title'})`);
    for (const r of diff.removed) console.log(`    LEFT     ${r.name} (${r.title || 'no title'})`);
    for (const c of diff.changed) console.log(`    CHANGED  ${c.name}: ${c.from || 'none'} -> ${c.to || 'none'}`);
  }
  // Persist the FINAL resolved URL. Florida had a 2023 .aspx path stored that
  // redirects to /sports/football/coaches/; keeping the old one means re-fetching a
  // stale path forever.
  if (loaded.finalUrl && loaded.finalUrl !== url) {
    await store.saveProgramSourceUrl(school, loaded.finalUrl, 'redirect-resolved', src && src.athletics_contact_url);
    console.log(`[program-map] school="${school}" persisted RESOLVED url: ${loaded.finalUrl}`);
    url = loaded.finalUrl;
  }
  await store.saveProgramStaffSnapshot(school, loaded.staff, loaded.hash, loaded.via);
  // Some directory slugs carry the office number outright (South Carolina's is
  // /staff-directory/football-803-777-4271/). That is a real published number with a
  // citable URL, so take it when it is there.
  const slugPhone = staffPage.phoneFromUrl(loaded.finalUrl || url);
  if (slugPhone) {
    await store.saveProgramContact(school, {
      football_office_phone: slugPhone,
      football_office_phone_source_url: loaded.finalUrl || url,
    });
    console.log(`[program-map] school="${school}" football office phone from URL slug: ${slugPhone}`);
  }
  return { staff: loaded.staff, url: loaded.finalUrl || url, via: loaded.via, diff, hash: loaded.hash, slugPhone };
}

// Turn parsed staff-page rows into records. A page that survived the section filter
// is football by definition, so these are Tier A with no date needed. A page that was
// left UNFILTERED is not, which is what the sport guard below is for.
function recordsFromStaffPage(school, staff, url) {
  // Tag first, then rank within each role. EVERY person is written: the five roles
  // are a key-contacts VIEW over the full list, not a filter that discards the other
  // hundred people an agent may want to search.
  // PAGE-LEVEL CONTEXT. A section naming another sport is a contradiction on its own,
  // but Missouri's General Manager sat under "CREATIVE", which names no sport at all
  // and so passes that test while still being the department's creative GM rather
  // than football's. What condemns it is the page around it: sections for BASEBALL,
  // BASKETBALL and GOLF, and none for football. On a directory demonstrably covering
  // many sports with no football section, a row that names football NOWHERE cannot be
  // assumed to be football.
  //
  // Deliberately narrow. A page whose sections are functional rather than per-sport
  // ("Coaching Staff", "Support Staff") never trips this, and a filtered page has
  // only football sections left, so this affects exactly the unfiltered multi-sport
  // case it was written for.
  const pageSections = [...new Set((staff || []).map((p) => p && p.section).filter(Boolean))];
  const pageNamesOtherSports = pageSections.some((s) => textNamesOtherSport(s));
  const pageHasFootballSection = pageSections.some((s) => FOOTBALL_RE.test(s));
  const multiSportNoFootball = pageNamesOtherSports && !pageHasFootballSection;
  if (multiSportNoFootball) {
    console.warn(`[program-map] school="${school}" this page covers other sports and has NO football section ` +
      `[${pageSections.slice(0, 12).join(', ')}${pageSections.length > 12 ? ', ...' : ''}]. ` +
      `Only rows that name football themselves can hold a football role.`);
  }

  const tagged = [];
  const droppedByEmail = [];
  const demoted = [];
  for (const p of (staff || [])) {
    const bad = sportContradiction(p);
    // An email naming another sport contradicts the row outright. Drop it: a football
    // head coach whose address is baseball@ is not a football contact at any rank.
    if (bad && bad.kind === 'email') {
      droppedByEmail.push({ name: p.name, sport: bad.sport, evidence: bad.evidence });
      continue;
    }
    let role = _roleOf({ role: 'other', title: p.title || '' });
    // A section or title naming another sport cannot hold a FOOTBALL role. The person
    // stays on the roster as untagged staff, because on an unfiltered page they are
    // still someone the school employs, but they can never be a key contact.
    if (role && bad) {
      demoted.push({ name: p.name, role, sport: bad.sport, kind: bad.kind, evidence: bad.evidence });
      role = null;
    } else if (role && multiSportNoFootball
      && !FOOTBALL_RE.test(String(p.title || '')) && !FOOTBALL_RE.test(String(p.section || ''))) {
      demoted.push({ name: p.name, role, sport: 'unstated', kind: 'page',
        evidence: `section "${p.section || 'none'}" on a multi-sport page with no football section` });
      role = null;
    }
    tagged.push({ p, role: role || null });
  }
  if (droppedByEmail.length) {
    console.warn(`[program-map] school="${school}" SPORT GUARD dropped ${droppedByEmail.length} record(s) whose email names another sport:`);
    for (const d of droppedByEmail.slice(0, 10)) console.warn(`    ${d.name}: ${d.evidence} names ${d.sport}`);
    if (droppedByEmail.length > 10) console.warn(`    ... and ${droppedByEmail.length - 10} more`);
  }
  if (demoted.length) {
    console.warn(`[program-map] school="${school}" SPORT GUARD blocked ${demoted.length} record(s) from a football role:`);
    for (const d of demoted.slice(0, 10)) console.warn(`    ${d.name} would have been ${d.role}, but ${d.kind} "${d.evidence}" names ${d.sport}`);
    if (demoted.length > 10) console.warn(`    ... and ${demoted.length - 10} more`);
  }
  const rankByRole = new Map();
  for (const t of tagged) {
    if (!t.role) continue;
    if (!rankByRole.has(t.role)) rankByRole.set(t.role, []);
    rankByRole.get(t.role).push(t);
  }
  for (const [, list] of rankByRole) {
    list.sort((a, b) => seniorityRank(a.p.title) - seniorityRank(b.p.title));
    list.forEach((t, i) => { t.rank = i + 1; });
  }

  const out = [];
  for (const t of tagged) {
    const p = t.p;
    const label = t.role ? ((ROLES.find((r) => r.key === t.role) || {}).label || t.role) : 'Staff';
    out.push({
      school,
      role: t.role || 'staff',
      role_label: label,
      role_rank: t.role ? (t.rank || 1) : null,
      is_key_contact: !!(t.role && t.rank === 1),
      name: p.name, title: p.title || null,
      email: p.email || null,
      email_source_url: p.email ? url : null,
      phone: p.phone || null,
      linkedin_url: null,
      source_url: url,
      source_tier: 'A',
      sport: 'football',
      // Which section of the page this person was listed under. On a department-wide
      // directory this is the evidence that they are football staff and not the
      // swim coach, so it is stored rather than thrown away after filtering.
      page_section: p.section || null,
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
  const covered = new Set(pageRecords.filter((r) => r.role && r.role !== 'staff').map((r) => r.role));
  const missing = ROLES.filter((r) => !covered.has(r.key)).map((r) => r.key);
  // SEARCH IS NOW THE EXCEPTION. It runs only for roles the page did not list.
  // A page that covered everything means zero searches for this program.
  const needSearch = missing.length > 0;
  console.log(`[program-map] school="${school}" fromStaffPage=${[...covered].join(',') || 'none'} needSearch=${needSearch ? missing.join(',') : 'no'}`);
  if (!needSearch) {
    const filled0 = covered.size;
    console.log(`[program-map] school="${school}" fullStaffStored=${pageRecords.length} keyContacts=${pageRecords.filter((r) => r.is_key_contact).length}`);
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

  const filled = new Set(records.filter((r) => r.status === 'current' && r.role && r.role !== 'staff').map((r) => r.role)).size;
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
  seniorityRank,
  buildProgram, dedupeAcrossSchools, reachVia, discoverStaffUrl, sweepStaffUrl, STAFF_URL_CANDIDATES, MIN_SWEEP_STAFF,
  sportContradiction, emailNamesOtherSport, textNamesOtherSport, VERIFIED_STAFF_URLS,
  loadFootballStaff, recordsFromStaffPage, classifyTier, parseDate, isStale, monthsSince,
  detectSport, footballScoped,
  ROLES, SCHOOLS, PILOT_SCHOOLS, ALL_SCHOOLS, SOURCE_ORDER, STALE_MONTHS, _assess, _roleOf, _byRecency, _newestMs,
};
