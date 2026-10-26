'use strict';
// ── WHO THE SALES AUTOPILOT WRITES TO: TWO LANES (services/salesAutopilot) ──
//
// LANE A, AGENCIES. Small and mid-size firms whose agents represent NFL, NBA,
// MLB or NHL players, and NIL-only agencies. Never the giants (CAA, WME,
// Klutch, Excel, Wasserman, and the few others their size). Each night walks
// the next slices of league x state, a web search per slice, so no night
// repeats the last.
// LANE B, SCHOOLS. NIL directors and coordinators at junior colleges,
// Division II, Division III, NAIA and Group of Five schools (the Sun Belt is
// one of the five), from the school lists the app already keeps
// (services/schoolsDivisions, data/twoYearColleges, marketScore.G5). A web
// search per school finds the person and the domain their staff email uses.
//
// EVERY PROSPECT, BOTH LANES:
//   - a named person, first and last name;
//   - an email Hunter found AND verified tonight (a fresh check, never a
//     cached verdict): Hunter status "valid", or a webmail mailbox Hunter
//     confirmed deliverable. No verified email, no prospect;
//   - never a catch-all domain (Hunter accept_all), never a role address
//     (info@, sales@, admin@ and the rest);
//   - never anyone already in NILDash (any account: agents, trial users, past
//     users, university staff, and their firm's domain), anyone on the
//     suppression list, anyone JohnMark has already written to or heard
//     from, anyone already prospected, or Second Wind Pro.

const lc = (s) => String(s || '').trim().toLowerCase();

const LEAGUES = ['NFL', 'NBA', 'MLB', 'NHL', 'NIL'];
const LEAGUE_ASK = {
  NFL: 'sports agencies whose NFLPA-certified agents represent NFL players',
  NBA: 'sports agencies whose NBPA-certified agents represent NBA players',
  MLB: 'sports agencies whose MLBPA-certified agents represent MLB players',
  NHL: 'sports agencies whose NHLPA-certified agents represent NHL players',
  NIL: 'NIL agencies that represent college athletes for name, image and likeness deals',
};
// States in the order the slices walk them: the biggest college-sports
// markets first, then the rest.
const STATES = ['TX', 'FL', 'GA', 'CA', 'AL', 'NC', 'OH', 'TN', 'LA', 'PA', 'MI', 'IL', 'NY', 'SC', 'VA', 'OK', 'MS', 'AZ', 'IN', 'MO',
  'KY', 'AR', 'CO', 'NJ', 'MD', 'WA', 'OR', 'MA', 'MN', 'WI', 'IA', 'KS', 'NE', 'UT', 'NV', 'NM', 'WV', 'CT', 'ID', 'MT', 'ND', 'SD',
  'WY', 'DE', 'RI', 'NH', 'VT', 'ME', 'HI', 'AK', 'DC'];

// The giants, by name and by domain.
const GIANTS = [
  { re: /\b(creative artists agency|c\.?a\.?a\.? sports|^caa\b)/i, domains: ['caa.com'] },
  { re: /\b(wme|william morris|endeavor)\b/i, domains: ['wmeagency.com', 'wme.com', 'endeavorco.com'] },
  { re: /\bklutch\b/i, domains: ['klutchsports.com'] },
  { re: /\bexcel sports\b/i, domains: ['excelsm.com', 'excelsportsmanagement.com'] },
  { re: /\bwasserman\b/i, domains: ['teamwass.com', 'wasserman.com'] },
  { re: /\boctagon\b/i, domains: ['octagon.com'] },
  { re: /\bathletes first\b/i, domains: ['athletesfirst.net', 'athletesfirst.com'] },
  { re: /\broc nation\b/i, domains: ['rocnation.com'] },
  { re: /\b(img|i\.m\.g\.)\b/i, domains: ['img.com'] },
];
function giant(name, domain) {
  const d = lc(domain);
  return GIANTS.find((g) => g.re.test(String(name || '')) || g.domains.some((x) => d === x || d.endsWith('.' + x))) || null;
}
// Second Wind Pro: never.
function secondWind(name, domain, email) {
  return /second\s*wind/i.test(String(name || '')) || /secondwind/i.test(lc(domain)) || /secondwind/i.test(lc(email));
}
const OUR_DOMAINS = ['comptongroupllc.com', 'comptongroup.com', 'comptonsales.com', 'mynildash.com', 'nildash.com', 'nildash.app', 'reply.mynildash.com'];

// A role mailbox, never a person.
const ROLE_LOCALS = new Set(['info', 'sales', 'admin', 'contact', 'hello', 'hi', 'office', 'support', 'team', 'marketing', 'media', 'press',
  'nil', 'athletics', 'compliance', 'recruiting', 'tickets', 'ticketing', 'sports', 'general', 'inquiries', 'inquiry', 'noreply',
  'no-reply', 'webmaster', 'hr', 'jobs', 'careers', 'legal', 'mail', 'help', 'service', 'agency', 'agents', 'clients', 'management',
  'business', 'partnerships', 'sponsorships', 'communications', 'news', 'frontdesk', 'reception', 'billing', 'accounts', 'events']);
function isRole(email) {
  const local = lc(email).split('@')[0] || '';
  const ET = require('./emailTier');
  if (ET.isGeneric(email) || ET.isRoleMailbox(email)) return true;
  const bare = local.replace(/\d+$/, '');
  return ROLE_LOCALS.has(local) || ROLE_LOCALS.has(bare) || ROLE_LOCALS.has(bare.split(/[._+-]/)[0]);
}
const FREE = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|aol|icloud|me|mac|live|msn|protonmail|proton|pm|att|sbcglobal|comcast|bellsouth|verizon|cox|charter|earthlink|gmx|mail|zoho)\./;
const isFree = (domain) => FREE.test(lc(domain));
function cleanDomain(x) {
  let d = lc(x).replace(/^mailto:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  if (d.includes('@')) d = d.split('@').pop();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}
function splitName(full) {
  const parts = String(full || '').replace(/[,()]/g, ' ').trim().split(/\s+/).filter((w) => !/^(dr|mr|mrs|ms|jr|sr|ii|iii|iv)\.?$/i.test(w));
  if (parts.length < 2) return null;
  const ok = (w) => /^[A-Za-z][A-Za-z'.-]+$/.test(w);
  const first = parts[0], last = parts[parts.length - 1];
  return ok(first) && ok(last) && first.length > 1 && last.length > 1 ? { first, last, full: parts.join(' ') } : null;
}

// A STAFF-DIRECTORY ADDRESS MUST BE THE NAMED PERSON'S. The research once named
// "Jenny Miller" and handed back jeheimstead@cpp.edu from the same page:
// someone else's mailbox, which would have gone out as "Hi Jenny". The
// address's local part has to carry the last name or the first name (3+
// letters), or be first initial + last / first + last initial.
function emailFitsName(email, name) {
  if (!email || !name) return false;
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const f = String(name.first || '').toLowerCase().replace(/[^a-z]/g, '');
  const l = String(name.last || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!local || !f || !l) return false;
  if (l.length >= 3 && local.includes(l)) return true;
  if (f.length >= 3 && local.includes(f)) return true;
  return local === f[0] + l || local === f + l[0];
}

// ── TIME ZONE BY STATE (the send window is 9 to 4 in theirs) ─────────────
const TZ = {};
for (const s of ['CT', 'DE', 'DC', 'FL', 'GA', 'IN', 'KY', 'ME', 'MD', 'MA', 'MI', 'NH', 'NJ', 'NY', 'NC', 'OH', 'PA', 'RI', 'SC', 'VT', 'VA', 'WV']) TZ[s] = 'America/New_York';
for (const s of ['AL', 'AR', 'IL', 'IA', 'KS', 'LA', 'MN', 'MS', 'MO', 'NE', 'ND', 'OK', 'SD', 'TN', 'TX', 'WI']) TZ[s] = 'America/Chicago';
for (const s of ['CO', 'ID', 'MT', 'NM', 'UT', 'WY']) TZ[s] = 'America/Denver';
TZ.AZ = 'America/Phoenix';
for (const s of ['CA', 'NV', 'OR', 'WA']) TZ[s] = 'America/Los_Angeles';
TZ.AK = 'America/Anchorage'; TZ.HI = 'Pacific/Honolulu';
const tzFor = (state) => TZ[String(state || '').toUpperCase()] || 'America/Chicago';

// ── THE SCHOOL LIST ───────────────────────────────────────────────────────
// Every school the lane may try, levels interleaved so a night is not all one
// division.
let _schools = null;
function schoolList() {
  if (_schools) return _schools;
  const SD = require('./schoolsDivisions');
  const lists = [
    require('./marketScore').G5.map(([name, st]) => ({ name, state: st, level: 'Group of Five' })),
    SD.D2.map((l) => SD.parse([l])).map((o) => Object.entries(o)[0]).map(([name, v]) => ({ name, city: v.city, state: v.state, level: 'Division II' })),
    SD.NAIA.map((l) => SD.parse([l])).map((o) => Object.entries(o)[0]).map(([name, v]) => ({ name, city: v.city, state: v.state, level: 'NAIA' })),
    require('../data/twoYearColleges').NJCAA.map((name) => ({ name, state: null, level: 'junior college' })),
    SD.D3.map((l) => SD.parse([l])).map((o) => Object.entries(o)[0]).map(([name, v]) => ({ name, city: v.city, state: v.state, level: 'Division III' })),
  ];
  const out = [];
  const seen = new Set();
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const s = l[i];
      if (s && !seen.has(lc(s.name))) { seen.add(lc(s.name)); out.push(s); }
    }
  }
  _schools = out;
  return out;
}

// The next `n` agency slices from `cursor` (league fastest, then state).
function agencySlices(cursor, n) {
  const out = [];
  const total = LEAGUES.length * STATES.length;
  for (let i = 0; i < n; i++) {
    const k = (Number(cursor) + i) % total;
    out.push({ league: LEAGUES[k % LEAGUES.length], state: STATES[Math.floor(k / LEAGUES.length)], index: k });
  }
  return out;
}

// ── RESEARCH: THE APP'S OWN WEB SEARCH ───────────────────────────────────
// ai.oneShotWebSearch on the fast tier: DeepSeek and the search provider,
// with the Anthropic fallback the app always had. JSON or null.
async function webJson(prompt, site, maxSearches) {
  const ai = require('../ai');
  const scanMeter = require('../scanMeter');
  const text = await scanMeter.label({ site, agentId: 'nildash-sales' },
    () => ai.oneShotWebSearch(prompt, 'You research sports agencies and college athletic departments from public web sources and return strict JSON. You never invent people, emails or facts.',
      2500, maxSearches || 4, ai.MODEL_FAST));
  return firstJson(String(text || ''));
}
// The first JSON value in a model's text, or null.
function firstJson(text) {
  const s = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const starts = [s.indexOf('['), s.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const a = Math.min(...starts);
  const b = s.lastIndexOf(s[a] === '[' ? ']' : '}');
  if (b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}
function agencyPrompt(slice) {
  const where = require('./salesWriter').stateName(slice.state) || slice.state;
  return `Find small and mid-size ${LEAGUE_ASK[slice.league]} based in ${where}. Leave out CAA, WME, Klutch, Excel Sports Management, Wasserman, Octagon, Athletes First, Roc Nation, IMG and any firm with more than about 50 agents. Leave out Second Wind Pro.
For each firm, from its own website or a news source: the firm name, its website domain, its city and state, one agent, founder or president by full name with their title, and one plain sentence about the firm that a source states (its sport, level, how many athletes it represents, or a notable client).
Return ONLY JSON: {"firms":[{"firm":"","domain":"","city":"","state":"","person":{"name":"","title":""},"fact":"","source":""}]}
Up to 8 firms. null for anything you cannot find with a source. Never guess a name or a domain.`;
}
function schoolPrompt(s) {
  return `Find the person who runs NIL (name, image and likeness) for ${s.name} athletics${s.city ? ` in ${s.city}, ${s.state}` : s.state ? ` (${s.state})` : ''}, a ${s.level} school: the NIL director, NIL coordinator, or the athletics staff member whose title covers NIL. Use the athletics staff directory or a school news release.
Return ONLY JSON: {"person":{"name":"","title":""},"emailDomain":"the domain athletics staff email addresses use, e.g. school.edu","email":"their address if the directory lists it, else null","state":"the two-letter state","fact":"one plain sentence about the department that a source states (its conference, how many sports it sponsors, or an NIL program it runs)","source":"URL"}
null for anything you cannot find with a source. Never guess a name or an email.`;
}

// ── HUNTER, LIVE ──────────────────────────────────────────────────────────
// The finder and Domain Search through hunterLookup (its own budget and
// cache); every verification logged first (verifyBudget, source 'sales')
// and FORCED fresh: "verified by Hunter the same night".
function liveHunter(pool, { day } = {}) {
  const H = require('./hunterLookup');
  const EV = require('./emailVerify');
  const VB = require('./verifyBudget');
  const HP = require('./hunterPace');
  return {
    findEmail: (first, last, domain) => H.findEmail(first, last, domain),
    // A fault (no key, a breaker, an outage) comes back as is: it is not
    // "nobody there", and the firm is tried again another night.
    domainSearch: (domain) => H.findDomainEmails(domain, { withPattern: true }),
    verify: async (email) => {
      const verifier = async (e) => {
        const paced = HP.blocked('verify');
        if (paced) return { ok: false, why: paced, budget: true };
        const wrote = await VB.record(pool, { agentId: 'nildash-sales', athleteId: null, business: null, email: e, day: day || new Date().toISOString().slice(0, 10), source: 'sales' });
        if (!wrote) return { ok: false, why: 'the verification credit log is not writable, so nothing is being spent' };
        return H.verifyEmail(e);
      };
      const m = await EV.verifyMany(pool, [email], { verifier, concurrency: 1, force: true });
      return m.get(EV.norm(email)) || null;
    },
  };
}

// Verified tonight, a person, not a catch-all: the one bar.
function verifiedOk(v) {
  if (!v) return { ok: false, why: 'the verifier did not answer' };
  if (v.notRun) return { ok: false, why: 'not verified: ' + (v.detail || 'the check did not run'), notRun: true, budget: !!v.budget };
  if (String(v.status || '') === 'accept_all') return { ok: false, why: 'catch-all domain (Hunter accept_all)' };
  if (v.result !== 'valid') return { ok: false, why: `not verified (${v.status || v.result || 'unknown'})` };
  return { ok: true };
}

// ── EXCLUSIONS, LOADED ONCE A RUN ─────────────────────────────────────────
async function exclusions(pool) {
  const q = async (sql, params) => (await pool.query(sql, params || []).catch(() => ({ rows: [] }))).rows;
  const emails = new Set(), domains = new Set(), names = new Set();
  const addPerson = (e) => {
    const x = lc(e); if (!x.includes('@')) return;
    emails.add(x);
    const d = x.split('@')[1];
    if (d && !isFree(d)) domains.add(d);
  };
  // Everyone with a NILDash account, whatever their state: agents, trials,
  // past users, university staff. Their firm's domain too.
  for (const r of await q(`SELECT LOWER(email) AS e FROM users WHERE email IS NOT NULL`)) addPerson(r.e);
  for (const r of await q(`SELECT LOWER(email) AS e FROM university_users WHERE email IS NOT NULL`)) addPerson(r.e);
  for (const r of await q(`SELECT LOWER(name) AS n, LOWER(COALESCE(short_name, '')) AS s FROM universities`)) { names.add(r.n); if (r.s) names.add(r.s); }
  // People JohnMark already knows: his own mail threads, the talked-to list,
  // the old Growth tab.
  const admin = lc(process.env.ADMIN_EMAIL || 'johnmarkcompton@gmail.com');
  for (const r of await q(`SELECT DISTINCT LOWER(x) AS e FROM email_threads t JOIN users u ON u.id = t.user_id, unnest(t.participant_emails) x WHERE LOWER(u.email) = $1`, [admin])) emails.add(r.e);
  for (const r of await q(`SELECT LOWER(email) AS e FROM mailbox_prospect_people WHERE email IS NOT NULL`)) emails.add(r.e);
  for (const r of await q(`SELECT LOWER(email) AS e FROM growth_prospects WHERE email IS NOT NULL`)) emails.add(r.e);
  // Already prospected: the person, and the firm (one prospect a domain).
  const prospected = new Set(), prospectDomains = new Set();
  for (const r of await q(`SELECT LOWER(email) AS e, LOWER(domain) AS d FROM sales_prospects`)) { prospected.add(r.e); if (r.d) prospectDomains.add(r.d); }
  for (const d of OUR_DOMAINS) domains.add(d);
  return {
    // Why this firm or school may not be tried, or null.
    org(name, domain) {
      const d = lc(domain);
      if (secondWind(name, d)) return 'Second Wind Pro';
      const g = giant(name, d);
      if (g) return 'a giant agency';
      if (d && domains.has(d)) return 'already in NILDash (its domain)';
      if (d && prospectDomains.has(d)) return 'already prospected (its domain)';
      if (d && OUR_DOMAINS.some((o) => d === o || d.endsWith('.' + o))) return 'one of our own domains';
      return null;
    },
    school(name) { return names.has(lc(name)) ? 'already a NILDash university' : null; },
    // Why this address may not be written to, or null (suppression is read live).
    async email(email) {
      const e = lc(email);
      if (secondWind(null, null, e)) return 'Second Wind Pro';
      if (emails.has(e)) return 'already in NILDash or already in touch with JohnMark';
      if (prospected.has(e)) return 'already prospected';
      const d = e.split('@')[1];
      if (d && domains.has(d)) return 'already in NILDash (its domain)';
      if (isRole(e)) return 'a role address, not a person';
      const sup = await require('./suppression').isSuppressed(pool, e);
      if (sup.suppressed) return 'on the suppression list';
      return null;
    },
    claim(email, domain) { prospected.add(lc(email)); if (domain) prospectDomains.add(lc(domain)); },
  };
}

// ── ONE CANDIDATE: A PERSON AND A VERIFIED EMAIL, OR WHY NOT ─────────────
// cand: { lane, org, domain, person: { name, title }, email?, ... }
// ctx: { hunter, ex, credits: { used, max } }
const TITLE_A = /\b(agent|founder|co-founder|president|owner|partner|ceo|principal|managing director|director)\b/i;
const TITLE_B = /\b(nil|name,? image|likeness|collective|revenue|marketing|external|associate athletic director|deputy|athletic director|compliance)\b/i;
async function findPerson(cand, ctx) {
  const H = ctx.hunter;
  const spend = (n) => { ctx.credits.used += n; };
  const room = () => ctx.credits.used < ctx.credits.max;
  let name = splitName(cand.person && cand.person.name);
  let title = (cand.person && cand.person.title) || null;
  let email = null, how = null;
  const domain = cleanDomain(cand.domain || (cand.email && cand.email.split('@')[1]));
  if (!domain) return { skip: 'no domain to look the person up on' };
  if (isFree(domain) && !cand.email) return { skip: 'a free-mail domain, nobody to look up' };
  // 1. The person the research named, through Hunter's finder.
  if (name) {
    if (!room()) return { skip: 'tonight\'s Hunter credits for sales are spent', budget: true };
    spend(1);
    const f = await H.findEmail(name.first, name.last, domain).catch((e) => ({ email: null, fault: { reason: e.message } }));
    if (f && f.budget) return { skip: 'Hunter credits are spent for tonight', budget: true };
    if (f && f.fault) return { skip: 'Hunter could not be asked (' + String(f.fault.reason || f.fault).slice(0, 80) + ')', notRun: true };
    if (f && f.acceptAll === true) return { skip: 'catch-all domain (Hunter accept_all)', domain };
    if (f && f.email) { email = lc(f.email); how = 'Hunter Email Finder'; }
    else if (cand.email && lc(cand.email).split('@')[1] === domain && emailFitsName(cand.email, name)) { email = lc(cand.email); how = 'the staff directory'; }
  }
  // 2. Nobody named, or the finder had nothing: Domain Search, the best
  //    personal address with a title that fits the lane.
  if (!email) {
    if (!room()) return { skip: 'tonight\'s Hunter credits for sales are spent', budget: true };
    spend(1);
    const h = await H.domainSearch(domain).catch((e) => ({ fault: { reason: e.message } }));
    if (h && h.budget) return { skip: 'Hunter credits are spent for tonight', budget: true };
    if (h && h.fault) return { skip: 'Hunter could not be asked (' + String(h.fault.reason || h.fault).slice(0, 80) + ')', notRun: true };
    const fits = cand.lane === 'school' ? TITLE_B : TITLE_A;
    const people = ((h && h.emails) || []).filter((e) => e && e.email && e.type !== 'generic' && e.firstName && e.lastName);
    const pick = people.find((e) => fits.test(String(e.position || ''))) || (name ? null : null);
    if (!pick) return { skip: name ? `Hunter has no address for ${name.full} at ${domain}` : `no named person with a fitting title at ${domain}`, domain };
    email = lc(pick.email); how = 'Hunter Domain Search';
    name = splitName(`${pick.firstName} ${pick.lastName}`);
    title = pick.position || title;
  }
  if (!name) return { skip: 'no named person', domain };
  if (isRole(email)) return { skip: 'a role address, not a person', domain };
  const why = await ctx.ex.email(email);
  if (why) return { skip: why, domain };
  // 3. Verified tonight.
  if (!room()) return { skip: 'tonight\'s Hunter credits for sales are spent', budget: true };
  spend(1);
  const v = await H.verify(email).catch((e) => ({ result: 'unknown', notRun: true, detail: e.message }));
  const ok = verifiedOk(v);
  if (!ok.ok) return { skip: ok.why, domain, budget: !!ok.budget };
  return { email, person: name.full, first: name.first, last: name.last, title, domain, how, verify: { status: v.status || null, result: v.result, at: new Date().toISOString() } };
}

module.exports = {
  LEAGUES, LEAGUE_ASK, STATES, GIANTS, OUR_DOMAINS, ROLE_LOCALS,
  giant, secondWind, isRole, isFree, cleanDomain, splitName, emailFitsName, tzFor, schoolList, agencySlices, agencyPrompt, schoolPrompt, webJson, firstJson,
  liveHunter, verifiedOk, exclusions, findPerson,
};
