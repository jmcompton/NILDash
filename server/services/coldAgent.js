'use strict';
// ── THE COLD AGENT: OUR OWN PIPELINE, WORKED LIKE AN ATHLETE'S MARKET ───────
//
// Each weekday morning it picks a few of our own account holders who are not
// getting value yet, runs a REAL demo night for one athlete of theirs (or a
// plausible one), and drafts a short email from the admin that leads with the
// businesses the night found. Nothing is sent until the admin clicks Approve.
//
// WHO (users table only, in this order):
//   1  signed up, never added an athlete
//   2  has athletes, has not logged in for 14+ days
//   3  has athletes, logged in, has never approved a card
// NEVER: anyone who logged in this week; anyone paying (a live subscription);
// comped accounts; our own people and test accounts; a suppressed address
// (bounce, unsubscribe, "no" -- the one list every sender checks); anyone at
// 3 touches; anyone touched in the last 10 days; anyone who replied.
//
// WHAT IT READS. The users table, and for the ONE person it is writing to:
// their own athletes (to run a demo for one) and counts of their own activity
// (to place them in a group). Every query on a customer table is scoped to
// that person's id. It never reads another account's athletes, cards,
// businesses or contacts, and it writes nothing into any customer account:
// the demo runs under a sandbox agent id (SANDBOX_AGENT) and a throwaway
// athlete id, as a dry run, so no card lands on anyone's screen and no
// customer's nightly research is used up.
//
// THE DEMO IS THE NIGHT. jobs/outreachQueue.fillAthlete, dry, with onCard: the
// same discovery, owner ladder and checks as the nightly. The businesses in
// the email are the rows it returned (cold_demo_cards), never placeholders.
//
// SENDING. From the admin's own connected mailbox, with the CAN-SPAM footer
// and a working unsubscribe, through sendRules like every other sender.
// Approve answers at once; the send runs behind it (the same claim pattern as
// the editor's Send). A touch counts only when the email actually left.
const crypto = require('crypto');

const SANDBOX_AGENT = 'nildash-cold-agent';
const SYSTEM = 'cold-agent';
// THE GUARDRAILS ARE CONSTANTS, not settings. The count and the schedule are
// settable without a deploy; these are not settable at all.
const MAX_TOUCHES = 3;
const GAP_DAYS = 10;
const ACTIVE_DAYS = 7;          // logged in this week: leave them alone
const DORMANT_DAYS = 14;        // group 2
const PAYING = new Set(['active', 'trialing', 'past_due', 'unpaid']);
const CLAIM_STALE_MINUTES = 15;
const HARD_DEADLINE = { h: 7, m: 0 };    // Central; no setting can move past this
// THE DEMO HAS TO HAVE SOMETHING IN IT. Fewer businesses with a named person
// than this and nobody is emailed: the person is shown as "no demo", and not
// tried again (not spent on again) for NO_DEMO_RETRY_DAYS.
const MIN_DEMO_CARDS = 3;
const NO_DEMO_RETRY_DAYS = 14;
// REFERRAL PARTNERS WHOSE PEOPLE THE ADMIN HANDLES PERSONALLY. 'pliable' is
// Greg Glynn (referral_partners, seeded in store.js); users.referred_by holds
// the partner code a signup came through. Not a setting: the admin's best
// channel is never risked by a slider. Add people by hand with holdEmails.
const HELD_PARTNERS = ['pliable'];

const DEFAULTS = {
  enabled: true,
  perRun: 1,                    // ONE until real emails have been read; turned up on the page
  startHour: 5, startMinute: 0, // Central
  deadlineHour: 6, deadlineMinute: 40,
  weekdaysOnly: true,
  excludeEmails: [],            // never these, whatever the rules say
  excludeNames: [],
  holdEmails: [],               // handled by the admin personally, never by this agent
  signName: '',                 // the sign-off name; empty = the admin account's name
};

// OUR OWN PEOPLE, by name and by address. The settings add to this list.
const INTERNAL_NAMES = ['keith compton', 'ethan sanders', 'will malcolm', 'trial check', 'card test', 'john mark compton', 'johnmark compton'];
const INTERNAL_DOMAINS = ['comptongroup.com', 'mynildash.com', 'nildash.com', 'nildash.app', 'example.com', 'example.org', 'test.com', 'mailinator.com', 'nildash.local'];
const TESTY = /(^|[^a-z])(test|tester|testing|demo|qa|fake|dummy|sample|trial check|card test)([^a-z]|$)/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const lc = (s) => String(s || '').trim().toLowerCase();

function adminEmail() { return lc(process.env.ADMIN_EMAIL || 'johnmarkcompton@gmail.com'); }
function founderEmails() { return String(process.env.FOUNDER_EMAILS || '').split(',').map(lc).filter(Boolean); }

// ── TABLES ──────────────────────────────────────────────────────────────────
let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS cold_agent_settings (
      id INTEGER PRIMARY KEY DEFAULT 1, settings JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cold_prospects (
      user_id TEXT PRIMARY KEY, email TEXT, touches INTEGER NOT NULL DEFAULT 0,
      first_touch_at TIMESTAMPTZ, last_touch_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'open', stop_reason TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cold_runs (
      id SERIAL PRIMARY KEY, run_date DATE, trigger TEXT, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ, picked INTEGER DEFAULT 0, drafted INTEGER DEFAULT 0, cost_usd NUMERIC,
      note TEXT, detail JSONB)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cold_drafts (
      id TEXT PRIMARY KEY, run_id INTEGER, user_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT,
      grp INTEGER, why TEXT, research JSONB, demo JSONB, subject TEXT, body_text TEXT, touch_no INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', status_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ, sent_at TIMESTAMPTZ,
      send_claimed_at TIMESTAMPTZ, send_error TEXT, message_id TEXT)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS cold_drafts_user ON cold_drafts (user_id, created_at DESC)`);
    // The businesses the demo night returned, one row each: what the email
    // is allowed to name.
    await pool.query(`CREATE TABLE IF NOT EXISTS cold_demo_cards (
      id SERIAL PRIMARY KEY, draft_id TEXT NOT NULL, run_id INTEGER, demo_athlete_id TEXT,
      brand_name TEXT NOT NULL, contact_name TEXT, contact_title TEXT, email TEXT, phone TEXT,
      instagram TEXT, why TEXT, category TEXT, card JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS cold_demo_cards_draft ON cold_demo_cards (draft_id)`);
    await require('./pitchActions').ensureTable(pool).catch(() => {});
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

async function getSettings(pool) {
  await ensureTables(pool);
  const r = (await pool.query(`SELECT settings FROM cold_agent_settings WHERE id = 1`)).rows[0];
  return clampSettings({ ...DEFAULTS, ...((r && r.settings) || {}) });
}
function clampSettings(s) {
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const out = {
    enabled: s.enabled !== false,
    perRun: int(s.perRun, 0, 10, DEFAULTS.perRun),
    startHour: int(s.startHour, 0, 6, DEFAULTS.startHour), startMinute: int(s.startMinute, 0, 59, DEFAULTS.startMinute),
    deadlineHour: int(s.deadlineHour, 0, 6, DEFAULTS.deadlineHour), deadlineMinute: int(s.deadlineMinute, 0, 59, DEFAULTS.deadlineMinute),
    weekdaysOnly: s.weekdaysOnly !== false,
    excludeEmails: (Array.isArray(s.excludeEmails) ? s.excludeEmails : []).map(lc).filter(Boolean).slice(0, 200),
    excludeNames: (Array.isArray(s.excludeNames) ? s.excludeNames : []).map(norm).filter(Boolean).slice(0, 200),
    holdEmails: (Array.isArray(s.holdEmails) ? s.holdEmails : []).map(lc).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 500),
    signName: String(s.signName || '').replace(/[^A-Za-z .'-]/g, '').trim().slice(0, 60),
  };
  // Finished before 7am Central, whatever is typed: the deadline is the last
  // moment a new person is started, and it is never later than 6:59.
  if (out.deadlineHour * 60 + out.deadlineMinute >= HARD_DEADLINE.h * 60 + HARD_DEADLINE.m) { out.deadlineHour = 6; out.deadlineMinute = 59; }
  if (out.startHour * 60 + out.startMinute >= out.deadlineHour * 60 + out.deadlineMinute) { out.startHour = out.deadlineHour; out.startMinute = Math.max(0, out.deadlineMinute - 30); }
  return out;
}
async function saveSettings(pool, patch) {
  const cur = await getSettings(pool);
  const next = clampSettings({ ...cur, ...(patch || {}) });
  await pool.query(`INSERT INTO cold_agent_settings (id, settings, updated_at) VALUES (1, $1, NOW())
                    ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`, [JSON.stringify(next)]);
  return next;
}

// ── WHO ─────────────────────────────────────────────────────────────────────
// One row per account holder, with only what the rules need. Counts of the
// person's own activity, never its contents.
async function candidates(pool) {
  await ensureTables(pool);
  return (await pool.query(`
    SELECT u.id, u.name, u.email, u.role, u.created_at, u.last_login, u.archived, u.comped,
           u.subscription_status, u.agency_name, u.agency_website,
           (SELECT COUNT(*)::int FROM athletes a WHERE a.agent_id = u.id) AS athletes,
           (   EXISTS (SELECT 1 FROM outreach_logs l WHERE l.agent_id = u.id AND l.approved_at IS NOT NULL)
            OR EXISTS (SELECT 1 FROM pitch_actions p WHERE p.agent_id = u.id AND p.action = 'approve')
            OR EXISTS (SELECT 1 FROM outreach_queue q WHERE q.agent_id = u.id AND q.state IN ('sent', 'sending'))) AS ever_approved,
           EXISTS (SELECT 1 FROM email_suppression s WHERE s.email = LOWER(TRIM(u.email))) AS suppressed,
           COALESCE(cp.touches, 0) AS touches, cp.last_touch_at, COALESCE(cp.status, 'open') AS prospect_status, cp.stop_reason,
           EXISTS (SELECT 1 FROM cold_drafts d WHERE d.user_id = u.id AND d.status IN ('pending', 'sending')) AS open_draft,
           (SELECT MAX(d.created_at) FROM cold_drafts d WHERE d.user_id = u.id AND d.status = 'no_demo') AS last_no_demo_at,
           -- CAN THEY LOG IN? The set-password links issued to their address
           -- (password_resets, the evidence the signup funnel reads).
           u.password_reset_required,
           pr.tokens AS reset_tokens, pr.any_used AS reset_used, pr.any_valid AS reset_valid, pr.last_expires AS reset_expires,
           u.referred_by, rp.name AS referred_by_name
      FROM users u LEFT JOIN cold_prospects cp ON cp.user_id = u.id
      LEFT JOIN (SELECT LOWER(TRIM(email)) AS email, COUNT(*)::int AS tokens, BOOL_OR(used) AS any_used,
                        BOOL_OR(NOT COALESCE(used, FALSE) AND expires_at > NOW()) AS any_valid, MAX(expires_at) AS last_expires
                   FROM password_resets GROUP BY 1) pr ON pr.email = LOWER(TRIM(u.email))
      LEFT JOIN referral_partners rp ON rp.code = u.referred_by
     WHERE u.email IS NOT NULL`)).rows;
}

function isInternal(u, settings) {
  const email = lc(u.email), name = norm(u.name);
  const domain = email.split('@')[1] || '';
  const local = email.split('@')[0] || '';
  if (email === adminEmail() || founderEmails().includes(email)) return 'one of us (the admin or a founder)';
  if (INTERNAL_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return `an internal or test address (${domain})`;
  if (INTERNAL_NAMES.includes(name)) return 'one of our own people';
  if ((settings.excludeNames || []).includes(name)) return 'on the exclude list (name)';
  if ((settings.excludeEmails || []).includes(email)) return 'on the exclude list (email)';
  if (TESTY.test(String(u.name || '')) || TESTY.test(local.replace(/[._+-]/g, ' '))) return 'looks like a test account';
  return null;
}

// ── CAN THEY LOG IN? ──────────────────────────────────────────────────────
// The email asks them to log in and look, so it never goes to someone who
// cannot. Usable: they have logged in, or a set-password link was used, or one
// is out there now, unused and unexpired. Anything else is "cannot log in",
// with the evidence as the reason; it clears by itself once a working link is
// issued (password_resets) or they sign in.
function loginProblem(u, now = new Date()) {
  if (u.last_login) return null;
  if (u.reset_used || u.reset_valid) return null;
  const d = (x) => new Date(x).toISOString().slice(0, 10);
  if (Number(u.reset_tokens) > 0) {
    return `a set-password link was issued but never used, and it expired${u.reset_expires ? ' ' + d(u.reset_expires) : ''}; they have never logged in`;
  }
  if (u.password_reset_required) {
    return 'the account was created for them with a password nobody knows, and no set-password link was ever issued';
  }
  return 'they have never logged in since signing up, and no set-password link was ever issued';
}

function heldFor(u, settings) {
  const lp = loginProblem(u);
  if (lp) return { why: 'cannot log in: ' + lp, hold: 'login', detail: lp };
  const partner = lc(u.referred_by);
  if (partner && HELD_PARTNERS.includes(partner)) {
    return { why: `came through ${u.referred_by_name || partner}: yours to handle personally`, hold: 'referral', detail: u.referred_by_name || partner };
  }
  if ((settings.holdEmails || []).includes(lc(u.email))) return { why: 'on your hold list: yours to handle personally', hold: 'hand', detail: 'hold list' };
  return null;
}

// The reason a person is NOT eligible, or null with their group. Pure, so the
// rules are tested directly and an empty run can say exactly why.
function classify(u, settings, now = new Date()) {
  const t = now.getTime();
  const days = (d) => (d ? (t - new Date(d).getTime()) / 86400000 : Infinity);
  if (String(u.role || '') !== 'agent') return { why: 'not an agent account' };
  if (u.archived) return { why: 'archived' };
  const internal = isInternal(u, settings);
  if (internal) return { why: internal };
  if (PAYING.has(lc(u.subscription_status))) return { why: 'paying customer' };
  if (u.comped) return { why: 'comped (free access we gave them)' };
  if (u.suppressed) return { why: 'suppressed (bounced, unsubscribed or said no)' };
  if (u.prospect_status && u.prospect_status !== 'open') return { why: `stopped: ${u.stop_reason || u.prospect_status}` };
  // ── HELD FOR THE ADMIN ──────────────────────────────────────────────────
  // Shown on the page in their own groups, never emailed by this agent.
  const held = heldFor(u, settings);
  if (held) return held;
  if (Number(u.touches) >= MAX_TOUCHES) return { why: `already had ${MAX_TOUCHES} touches` };
  if (days(u.last_touch_at) < GAP_DAYS) return { why: `contacted in the last ${GAP_DAYS} days` };
  if (u.open_draft) return { why: 'a draft is already waiting for approval' };
  if (days(u.last_no_demo_at) < NO_DEMO_RETRY_DAYS) return { why: `no demo on the last try (tried again after ${NO_DEMO_RETRY_DAYS} days)` };
  if (days(u.last_login) < ACTIVE_DAYS) return { why: 'logged in this week' };
  if (Number(u.athletes) === 0) return { group: 1, why: 'signed up, never added an athlete' };
  if (days(u.last_login) >= DORMANT_DAYS) return { group: 2, why: `has ${u.athletes} athlete${u.athletes === 1 ? '' : 's'}, has not logged in for 14+ days` };
  if (!u.ever_approved) return { group: 3, why: `has ${u.athletes} athlete${u.athletes === 1 ? '' : 's'}, logs in, has never approved a card` };
  return { why: 'using it (has approved cards and logged in within 14 days)' };
}

async function pick(pool, { limit, now, settings, onlyIds } = {}) {
  const s = settings || await getSettings(pool);
  // onlyIds: a test's own accounts, so a shared test database's other users
  // do not decide the outcome.
  const rows = (await candidates(pool)).filter((u) => !onlyIds || onlyIds.includes(u.id));
  const picked = [], skipped = {}, held = [];
  for (const u of rows) {
    const c = classify(u, s, now);
    if (c.group) { picked.push({ ...u, group: c.group, groupWhy: c.why }); continue; }
    // Counted by kind, not by each person's own sentence.
    const key = c.hold === 'login' ? 'cannot log in' : c.hold ? 'held for you (' + (c.hold === 'referral' ? c.detail + "'s referrals" : 'hold list') + ')' : c.why;
    skipped[key] = (skipped[key] || 0) + 1;
    if (c.hold) held.push({ id: u.id, name: u.name, email: u.email, hold: c.hold, why: c.why, athletes: Number(u.athletes) || 0, signedUp: u.created_at });
  }
  picked.sort((a, b) => (a.group - b.group) || (new Date(a.created_at) - new Date(b.created_at)));
  const n = Number.isFinite(limit) ? limit : s.perRun;
  return { picked: picked.slice(0, n), eligible: picked.length, skipped, held };
}

// ── RESEARCH ────────────────────────────────────────────────────────────────
// The web search the athlete lookup uses (ai.webSearchMessage), booked to the
// cold agent. Facts with sources or null: nothing is invented.
async function research(u, deps = {}) {
  if (deps.research) return deps.research(u);
  const ai = require('../ai');
  const scanMeter = require('../scanMeter');
  const domain = (lc(u.email).split('@')[1] || '');
  const freeMail = /^(gmail|yahoo|outlook|hotmail|icloud|aol|proton|protonmail|live|me|msn)\./.test(domain);
  const prompt = `Research this person, a sports agent or athlete representative, for a short personal email.
Name: ${u.name || '(unknown)'}
Email: ${u.email}${freeMail ? ' (a personal address)' : ` (domain ${domain})`}
Agency on file: ${u.agency_name || '(none)'}${u.agency_website ? `\nAgency website: ${u.agency_website}` : ''}

Find, from public sources only: their agency, their role, roughly how many athletes they represent, the sports and level (college / pro), where they are based, anything public and recent (last 6 months) worth a one-line mention, and up to 3 athletes publicly listed on their agency's roster with each athlete's school and sport. Also name one college near where they are based.
firmFact: the single most specific public fact about their firm, as one plain third-person sentence in the source's own terms (numbers, sport, level), e.g. "Second Wind Pro has represented more than 30 college football players and negotiated over $750,000 in NIL opportunities." null if no source states one.
Return ONLY JSON:
{"agency":null,"role":null,"rosterSize":null,"sports":[],"level":null,"basedIn":{"city":null,"state":null},"firmFact":null,"recent":null,"rosterAthletes":[{"name":"","school":"","sport":""}],"nearbySchool":null,"sources":[]}
Use null or [] for anything you cannot find with a source. Never guess a name.`;
  try {
    const msg = await scanMeter.label({ site: 'cold-agent.research', agentId: SANDBOX_AGENT, brand: u.email },
      () => ai.webSearchMessage({ prompt, maxSearches: 4, maxTokens: 1800,
        system: 'You research people from public web sources and return strict JSON. You never invent people, athletes or facts.' }));
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    j.rosterAthletes = (Array.isArray(j.rosterAthletes) ? j.rosterAthletes : []).filter((a) => a && a.name && a.school).slice(0, 3);
    return j;
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200), rosterAthletes: [] };
  }
}

// ── WHICH ATHLETE TO DEMO ──────────────────────────────────────────────────
// Their own athlete when they have one (read from THEIR roster only); else
// one from their agency's public roster; else a college near them.
async function demoSubject(pool, u, found) {
  const job = require('../jobs/outreachQueue');
  // A school the name rules place, or one the Places lookup can (the demo
  // itself resolves it with localContextFor, which checks it against where the
  // school actually is).
  const SG = require('./schoolGeocode');
  const R = require('./schoolResolver');
  const ok = (row) => {
    const sch = (row && row.data && row.data.school) || (row && row.school) || '';
    // A name that is more than one school is never a demo: it would be a guess.
    const amb = sch ? R.ambiguity(sch, { state: row && row.data && row.data.state }) : null;
    if (amb && amb.candidates) return false;
    try { const p = job.athleteProfile(row); if (p && p.hasLocalMarket) return true; } catch (_) { /* fall through */ }
    return !!(sch && SG.usable(sch));
  };
  if (Number(u.athletes) > 0) {
    const own = (await pool.query(
      `SELECT id, data, data->>'name' AS name, data->>'school' AS school, data->>'hometown' AS hometown
         FROM athletes WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 25`, [u.id])).rows;
    const hit = own.find((r) => r.name && ok(r));
    if (hit) return { kind: 'their athlete', name: hit.name, data: hit.data || {}, school: hit.school || null, sport: (hit.data || {}).sport || null };
  }
  for (const a of (found && found.rosterAthletes) || []) {
    const data = { name: a.name, school: a.school, sport: a.sport || null };
    if (ok({ data, name: a.name, school: a.school })) return { kind: 'their public roster', name: a.name, data, school: a.school, sport: a.sport || null };
  }
  const school = found && found.nearbySchool;
  if (school) {
    const sport = (found.sports && found.sports[0]) || null;
    const data = { name: `${sport ? sport + ' ' : ''}athlete at ${school}`, school, sport };
    if (ok({ data, name: data.name, school })) return { kind: 'their region', name: null, data, school, sport };
  }
  return null;
}

// ── THE DEMO NIGHT ─────────────────────────────────────────────────────────
// The nightly's own fillAthlete, dry, under the sandbox agent and a throwaway
// athlete id. Returns the cards it would have queued.
async function runDemo(pool, u, subject, deps = {}) {
  if (deps.runDemo) return deps.runDemo(u, subject);
  const job = require('../jobs/outreachQueue');
  const Q = require('./outreachQueue');
  const demoId = 'colddemo:' + crypto.randomBytes(6).toString('hex');
  const ath = { id: demoId, name: subject.name || subject.data.name, data: subject.data };
  const lcx = await job.localContextFor(ath);
  // Businesses this person has already pitched, from THEIR OWN cards: not
  // shown back to them as a find.
  const own = new Set((await pool.query(
    `SELECT brand_name FROM outreach_queue WHERE agent_id = $1
     UNION SELECT brand_name FROM outreach_logs WHERE agent_id = $1`, [u.id])).rows.map((r) => norm(r.brand_name)));
  const cards = [];
  const t0 = Date.now();
  const r = await job.fillAthlete(pool, {
    agentId: SANDBOX_AGENT, athleteId: demoId, athleteName: ath.name, runDate: new Date().toISOString().slice(0, 10),
    athleteProfile: lcx.profile, agentFirstName: deps.senderFirst || 'John', athleteRow: ath.data,
    budget: Q.newBudget(Q.ATHLETE_COST_CEILING_USD, undefined, { rosterSize: 1 }),
    region: lcx.region, regionFault: lcx.fault || null, dryRun: true, maxSlots: 5,
    signature: { has: false, hasLink: false, text: '', url: '' },
    skipBrand: (b) => own.has(norm(b)),
    onCard: (c) => { cards.push(c); },
    onProgress: () => {},
  });
  const spent = (r && r.spendLog) ? r.spendLog : null;
  return { demoAthleteId: demoId, cards, tried: (r && r.tried) ? r.tried.length : 0, ms: Date.now() - t0, note: (r && r.note) || null, spent };
}

// A business is shown only with a named person and a way to reach them.
function usable(c) {
  return !!(c && c.brandName && c.contactName && (c.email || c.phone || c.instagram));
}

// ── THE EMAIL ───────────────────────────────────────────────────────────────
// Short, the admin's own voice, the businesses first. Never shames, never
// says how long it has been, never "following up" or "checking in".
const BANNED = [
  /follow(ing|ed)?[- ]up/i, /check(ing)?[- ]in\b/i, /just (wanted|checking|circling)/i, /touch(ing)? base/i, /circle back/i,
  /haven'?t (logged|used|been|heard|seen)/i, /it'?s been/i, /since you (signed|joined|created|registered)/i, /\ba while\b/i,
  /\b(days|weeks|months) ago\b/i, /\bghost/i, /\binactive\b/i, /\bdormant\b/i, /did you (get|see)/i, /in case you missed/i,
  /\blast (week|month|spring|summer|fall|winter)\b/i, /\b(january|february|april|june|july|august|september|october|november|december)\b/i,
  /hope (this|you)/i, /revolution/i, /game[- ]?chang/i, /ai[- ]powered/i, /cutting[- ]edge/i, /\bunlock/i, /\bleverage/i,
  /\bsupercharge/i, /\bseamless/i, /\bexcited to\b/i, /\breach(ing)? out\b/i, /\bwe noticed\b/i, /\bour records\b/i,
];

// The numbers a fact carries, as their leading digits: "$750,000" and "$750k"
// are both 750; "30+" is 30.
function numbersIn(text) {
  return (String(text || '').match(/\d[\d,.]*/g) || [])
    .map((n) => n.replace(/[,.]\d{3}\b/g, '').replace(/[,.]$/, '').replace(/\D.*$/, ''))
    .filter((n) => n && n.length >= 2);
}
// WHAT THE RESEARCH FOUND ABOUT THEIR FIRM HAS TO BE IN THE EMAIL. Warmth is
// specificity about them; a draft that had the fact and opened with us is
// refused. "Uses it" means it carries the firm's name or one of the fact's
// numbers.
function usesFirmFact(body, research) {
  const fact = research && research.firmFact;
  if (!fact) return true;
  const b = String(body || '').toLowerCase();
  if (numbersIn(fact).some((n) => b.includes(n))) return true;
  const firm = String((research && research.agency) || '').toLowerCase().replace(/\b(llc|inc|group|agency|management|mgmt|sports|the)\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ').trim();
  const head = firm.split(/\s+/).filter((t) => t.length >= 3).slice(0, 2).join(' ');
  return !!head && b.includes(head);
}
function checkEmail(subject, body, names, research) {
  const problems = [];
  const all = `${subject}\n${body}`;
  for (const re of BANNED) if (re.test(all)) problems.push('uses a phrase it may not: ' + re.source);
  // The demo ran minutes before the draft, not overnight.
  if (/\b(last night|yesterday|overnight)\b/i.test(all)) problems.push('says the run was last night; it ran this morning');
  if (research !== undefined && !usesFirmFact(body, research)) problems.push('the research found something about their firm and the email does not use it');
  // NEVER INVENT A FACT ABOUT THEM. Every number outside the business lines
  // must be one the research found.
  if (research !== undefined) {
    const known = new Set(numbersIn([research && research.firmFact, research && research.recent, research && research.rosterSize].filter(Boolean).join(' ')));
    const prose = String(body || '').split('\n').filter((l) => !/^\s*-\s/.test(l)).join('\n');
    const invented = numbersIn(prose).filter((n) => !known.has(n));
    if (invented.length) problems.push(`states a number the research did not find (${invented.join(', ')})`);
  }
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > 170) problems.push(`too long (${words} words)`);
  const named = names.filter((n) => body.includes(n));
  if (named.length < Math.min(3, names.length)) problems.push(`names ${named.length} of the businesses found; it must lead with them`);
  if (require('./placeholders').find(all).length) problems.push('has a placeholder');
  if (/\[[^\]]+\]|\{\{|\}\}/.test(all)) problems.push('has a bracketed placeholder');
  return problems;
}

function firstName(full) {
  const f = String(full || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'.-]{1,}$/.test(f) ? f.charAt(0).toUpperCase() + f.slice(1) : null;
}

function bizLine(c) {
  const who = [c.contactName, c.contactTitle].filter(Boolean).join(', ');
  return `- ${c.brandName}: ${who}`;
}

// The fallback, and the shape the model is asked to keep: a greeting, one
// line on what was run, the businesses, one small ask, the name.
function whenRan(now) {
  return centralNow(now).hour < 12 ? 'this morning' : 'today';
}
function senderBlock(senderFull) { return `${senderFull}\nNILDash`; }

// The fallback, and the shape the writer is held to: them first (the firm
// fact, only if research found one), then what the night found, one line on
// what it is, one small ask, a full name.
function templateEmail({ u, subject: subj, cards, senderFull, touchNo, research, now }) {
  const first = firstName(u.name);
  const n = cards.length;
  const word = ['No', 'One', 'Two', 'Three', 'Four', 'Five'][n] || String(n);
  const forWhom = subj.kind === 'their athlete' ? `${subj.name}${subj.school ? ` at ${subj.school}` : ''}`
    : subj.name ? `${subj.name}${subj.school ? ` at ${subj.school}` : ''}`
      : `${subj.sport ? 'a ' + String(subj.sport).toLowerCase() + ' player' : 'an athlete'} at ${subj.school}`;
  const fact = research && research.firmFact ? String(research.firmFact).trim().replace(/([^.])$/, '$1.') : null;
  const lines = [first ? `${first},` : 'Hi,', ''];
  if (fact) lines.push(fact, '');
  lines.push(`Here's what our agent turned up ${whenRan(now)}${touchNo > 1 ? ' on another market' : ''} for ${forWhom}. ${word} local businesses, each with a named person and a way to reach them:`, '');
  lines.push(...cards.map(bizLine), '');
  lines.push('That runs every night for every athlete on a roster, and it is waiting in the morning.', '');
  lines.push(Number(u.athletes) > 0
    ? "Log in to see yours, or send me the rest of your roster and I'll load them in myself today."
    : "Send me your roster and I'll load them in myself today.");
  lines.push('', senderBlock(senderFull));
  const subject = subj.name ? `${n} businesses for ${subj.name}` : `${n} businesses near ${subj.school}`;
  return { subject, body: lines.join('\n') };
}

async function writeEmail(u, ctx, deps = {}) {
  const { cards, subject: subj, research: found, touchNo, senderFull } = ctx;
  const names = cards.map((c) => c.brandName);
  const R = found || {};
  if (deps.write) {
    const w = await deps.write(u, ctx);
    return { ...w, problems: checkEmail(w.subject, w.body, names, R), by: 'injected' };
  }
  const base = templateEmail({ u, subject: subj, cards, senderFull, touchNo, research: R });
  try {
    const ai = require('../ai');
    const scanMeter = require('../scanMeter');
    const facts = {
      to: { firstName: firstName(u.name), firm: R.agency || u.agency_name || null, firmFact: R.firmFact || null, recent: R.recent || null },
      athlete: { name: subj.name, school: subj.school, sport: subj.sport, whose: subj.kind },
      businesses: cards.map((c) => ({ name: c.brandName, person: c.contactName, title: c.contactTitle || null, why: c.why || null })),
      hasAthletesOnFile: Number(u.athletes) > 0, touchNo, ranWhen: whenRan(), signOff: senderBlock(senderFull),
    };
    const prompt = `Write a short email from ${senderFull} at NILDash to one of our account holders. ${facts.ranWhen === 'this morning' ? 'This morning' : 'Today'} our agent ran a real market for an athlete and found the businesses below.
FACTS (use only these; never add a fact about them or their firm): ${JSON.stringify(facts)}
Shape, in this order:
1. "${facts.to.firstName || 'Hi'}," on its own line.
2. ${facts.to.firmFact ? 'One or two short sentences built on firmFact, in your own words, keeping its specifics (numbers, sport, level). That is the opening: them, not us.' : 'No opening line about them: there is no fact to use. Go straight to the businesses.'}
3. One sentence: what our agent turned up ${facts.ranWhen} and for whom, then the businesses, one per line starting "- " as "Business: Person, Title".
4. One sentence: it runs every night for every athlete on a roster and is waiting in the morning.
5. One small ask: ${facts.hasAthletesOnFile ? 'log in to see theirs, or send the rest of the roster and he will load them himself today' : 'send their roster and he will load them himself today'}.
6. The sign-off exactly: ${JSON.stringify(facts.signOff)}
Rules: under 120 words. Every line says something specific or it is cut; no pleasantries and no filler sentences ("worth a conversation", "real people in your region"). Never say how long it has been or anything about their usage. Never say last night. No marketing language.
Return ONLY JSON: {"subject":"under 8 words, names the athlete or the school","body":"the email text with \\n line breaks"}`;
    const raw = await scanMeter.label({ site: 'cold-agent.write', agentId: SANDBOX_AGENT, brand: u.email },
      () => ai.oneShot(prompt, 'You write short, plain, personal emails. You return strict JSON.', 700, undefined, { prose: true }));
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (j && j.subject && j.body) {
      const problems = checkEmail(j.subject, j.body, names, R);
      if (!problems.length) return { subject: String(j.subject).trim(), body: String(j.body).trim(), problems: [], by: 'writer' };
      return { ...base, problems: checkEmail(base.subject, base.body, names, R), by: 'template', writerProblems: problems };
    }
  } catch (e) {
    return { ...base, problems: checkEmail(base.subject, base.body, names, R), by: 'template', writerError: String(e.message || e).slice(0, 200) };
  }
  return { ...base, problems: checkEmail(base.subject, base.body, names, R), by: 'template' };
}

async function adminUser(pool) {
  return (await pool.query(`SELECT id, name, email, signature_text, scheduling_url FROM users WHERE LOWER(email) = $1 LIMIT 1`, [adminEmail()])).rows[0] || null;
}

// ── ONE PERSON ─────────────────────────────────────────────────────────────
async function prepare(pool, u, { runId, deps = {} } = {}) {
  const admin = await adminUser(pool);
  const settings = await getSettings(pool);
  // A FULL NAME, so a person who signed up months ago knows who is writing.
  const senderFull = deps.senderFull || settings.signName || String((admin && admin.name) || '').trim() || 'John Compton';
  const senderFirst = firstName(senderFull) || 'John';
  const found = await research(u, deps);
  const subj = await demoSubject(pool, u, found);
  // ── NO DEMO, NO EMAIL ────────────────────────────────────────────────────
  // A thin list is never sent. The person is shown as "no demo" with why
  // (and what little it did find), nothing is drafted, and they are not
  // tried again for NO_DEMO_RETRY_DAYS.
  const noDemo = async (why, demo, cards) => {
    const id = 'cold_' + crypto.randomBytes(8).toString('hex');
    await pool.query(
      `INSERT INTO cold_drafts (id, run_id, user_id, email, name, grp, why, research, demo, touch_no, status, status_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'no_demo',$11)`,
      [id, runId || null, u.id, lc(u.email), u.name || null, u.group, u.groupWhy, JSON.stringify(found || {}),
        JSON.stringify(demo || {}), Number(u.touches || 0) + 1, why]);
    for (const c of cards || []) await saveDemoCard(pool, id, runId, demo && demo.demoAthleteId, c);
    return { ok: false, noDemo: true, draftId: id, why };
  };
  if (!subj) return noDemo('no athlete of theirs, no athlete on their agency\'s public roster and no college near them to run a demo for', {}, []);
  const demo = await runDemo(pool, u, subj, { ...deps, senderFirst });
  const cards = (demo.cards || []).filter(usable).slice(0, 5);
  const demoInfo = { athlete: { name: subj.name, school: subj.school, sport: subj.sport, kind: subj.kind }, demoAthleteId: demo.demoAthleteId, tried: demo.tried, ms: demo.ms };
  if (cards.length < MIN_DEMO_CARDS) {
    return noDemo(`the demo night for ${subj.name || subj.school} found ${cards.length} business${cards.length === 1 ? '' : 'es'} with a named person and a way to reach them, out of ${demo.tried || 0} tried (an email needs ${MIN_DEMO_CARDS})`, demoInfo, cards);
  }
  const touchNo = Number(u.touches || 0) + 1;
  const mail = await writeEmail(u, { cards, subject: subj, research: found, touchNo, senderFirst, senderFull }, deps);
  if (mail.problems && mail.problems.length) return { ok: false, why: 'the email failed its own checks: ' + mail.problems.join('; ') };
  const id = 'cold_' + crypto.randomBytes(8).toString('hex');
  await pool.query(
    `INSERT INTO cold_drafts (id, run_id, user_id, email, name, grp, why, research, demo, subject, body_text, touch_no, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')`,
    [id, runId || null, u.id, lc(u.email), u.name || null, u.group, u.groupWhy, JSON.stringify(found || {}),
      JSON.stringify({ athlete: { name: subj.name, school: subj.school, sport: subj.sport, kind: subj.kind }, demoAthleteId: demo.demoAthleteId,
        tried: demo.tried, ms: demo.ms, writtenBy: mail.by, writerProblems: mail.writerProblems || null }),
      mail.subject, mail.body, touchNo]);
  for (const c of cards) await saveDemoCard(pool, id, runId, demo.demoAthleteId, c);
  return { ok: true, draftId: id, cards: cards.length };
}

async function saveDemoCard(pool, draftId, runId, demoAthleteId, c) {
  await pool.query(
    `INSERT INTO cold_demo_cards (draft_id, run_id, demo_athlete_id, brand_name, contact_name, contact_title, email, phone, instagram, why, category, card)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [draftId, runId || null, demoAthleteId || null, c.brandName, c.contactName || null, c.contactTitle || null, c.email || null, c.phone || null,
      c.instagram || null, c.why || null, c.businessCategory || null, JSON.stringify(c)]);
}

// ── A RUN ───────────────────────────────────────────────────────────────────
// Always leaves a row: who it drafted for, who it could not, and -- when
// nobody was eligible -- the count of everyone by the reason they were not.
let _running = false;
async function runOnce(pool, { trigger = 'manual', limit, now, deps = {} } = {}) {
  await ensureTables(pool);
  if (_running) return { ok: false, error: 'a run is already going' };
  _running = true;
  const settings = await getSettings(pool);
  const date = centralNow(now).date;
  const runId = (await pool.query(`INSERT INTO cold_runs (run_date, trigger) VALUES ($1, $2) RETURNING id`, [date, trigger])).rows[0].id;
  const detail = { drafted: [], failed: [], skippedCounts: null, deadline: null };
  try {
    await detectReplies(pool);
    const { picked, eligible, skipped } = await pick(pool, { limit: Number.isFinite(limit) ? limit : settings.perRun, now, settings, onlyIds: deps.onlyIds });
    detail.skippedCounts = skipped;
    detail.eligible = eligible;
    for (const u of picked) {
      if (trigger === 'schedule' && pastDeadline(settings, deps.clock ? deps.clock() : undefined)) {
        detail.deadline = `stopped at the ${settings.deadlineHour}:${String(settings.deadlineMinute).padStart(2, '0')} deadline`;
        break;
      }
      try {
        const r = await prepare(pool, u, { runId, deps });
        if (r.ok) detail.drafted.push({ userId: u.id, name: u.name, email: u.email, group: u.group, draftId: r.draftId, cards: r.cards });
        else if (r.noDemo) (detail.noDemo = detail.noDemo || []).push({ userId: u.id, name: u.name, email: u.email, group: u.group, draftId: r.draftId, why: r.why });
        else detail.failed.push({ userId: u.id, name: u.name, email: u.email, group: u.group, why: r.why });
      } catch (e) {
        detail.failed.push({ userId: u.id, name: u.name, email: u.email, group: u.group, why: 'our failure: ' + String(e.message || e).slice(0, 200) });
        require('./ourFault').record('cold-agent', String(e.message || e).slice(0, 300), 'coldAgent.prepare ' + u.id);
      }
    }
    let note;
    if (!picked.length) {
      const top = Object.entries(skipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join('; ');
      note = `Nobody to contact. ${top || 'No accounts at all.'}`;
    } else {
      note = `Drafted ${detail.drafted.length} of ${picked.length} picked (${eligible} eligible).`
        + (detail.noDemo && detail.noDemo.length ? ` No demo for ${detail.noDemo.length}, not emailed: ${detail.noDemo.map((f) => `${f.name || f.email} (${f.why})`).join('; ')}.` : '')
        + (detail.failed.length ? ` Could not draft ${detail.failed.length}: ${detail.failed.map((f) => `${f.name || f.email} (${f.why})`).join('; ')}.` : '')
        + (detail.deadline ? ' ' + detail.deadline + '.' : '');
    }
    await pool.query(`UPDATE cold_runs SET finished_at = NOW(), picked = $2, drafted = $3, note = $4, detail = $5 WHERE id = $1`,
      [runId, picked.length, detail.drafted.length, note, JSON.stringify(detail)]);
    return { ok: true, runId, picked: picked.length, drafted: detail.drafted.length, note, detail };
  } catch (e) {
    await pool.query(`UPDATE cold_runs SET finished_at = NOW(), note = $2, detail = $3 WHERE id = $1`,
      [runId, 'The run failed: ' + String(e.message || e).slice(0, 300), JSON.stringify(detail)]).catch(() => {});
    require('./ourFault').record('cold-agent', String(e.message || e).slice(0, 300), 'coldAgent.runOnce');
    return { ok: false, runId, error: e.message };
  } finally {
    _running = false;
  }
}

// ── REPLIES STOP THE SEQUENCE ──────────────────────────────────────────────
// A reply from the person, in the admin's own synced inbox, after our last
// touch: no more touches. (A "no" is marked by hand and suppresses them for
// every sender; so does an unsubscribe or a bounce.)
async function detectReplies(pool) {
  const admin = await adminUser(pool);
  if (!admin) return 0;
  const r = await pool.query(
    `UPDATE cold_prospects cp SET status = 'replied', stop_reason = 'they replied', updated_at = NOW()
      WHERE cp.status = 'open' AND cp.touches > 0 AND EXISTS (
        SELECT 1 FROM email_threads t WHERE t.user_id = $1 AND LOWER(cp.email) = ANY (SELECT LOWER(x) FROM unnest(t.participant_emails) x)
           AND t.last_message_at > cp.last_touch_at)`, [admin.id]).catch(() => ({ rowCount: 0 }));
  return r.rowCount || 0;
}

// ── APPROVE: ANSWER AT ONCE, SEND BEHIND IT ────────────────────────────────
// Every guardrail is checked again at the click: the person may have logged
// in, paid, replied or unsubscribed since the draft was written.
async function approve(pool, draftId, { subject, body } = {}, deps = {}) {
  await ensureTables(pool);
  const d = (await pool.query(`SELECT * FROM cold_drafts WHERE id = $1`, [draftId])).rows[0];
  if (!d) return { ok: false, status: 404, error: 'no such draft' };
  if (d.status !== 'pending') return { ok: true, already: true, state: d.status };
  const u = (await candidates(pool)).find((x) => x.id === d.user_id);
  const settings = await getSettings(pool);
  const c = u ? classify({ ...u, open_draft: false }, settings) : { why: 'the account no longer exists' };
  if (!c.group) {
    await pool.query(`UPDATE cold_drafts SET status = 'skipped', status_note = $2, decided_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [draftId, 'not sent: ' + c.why]);
    return { ok: false, status: 409, error: `Not sent: ${c.why}.`, state: 'skipped' };
  }
  const subj = (typeof subject === 'string' && subject.trim()) ? subject.trim() : d.subject;
  const text = (typeof body === 'string' && body.trim()) ? body.trim() : d.body_text;
  const names = (await pool.query(`SELECT brand_name FROM cold_demo_cards WHERE draft_id = $1`, [draftId])).rows.map((r) => r.brand_name);
  const problems = checkEmail(subj, text, names, d.research || {});
  if (problems.length) return { ok: false, status: 400, error: 'The email fails its checks: ' + problems.join('; ') };
  const claim = await pool.query(
    `UPDATE cold_drafts SET status = 'sending', send_claimed_at = NOW(), decided_at = NOW(), subject = $2, body_text = $3
      WHERE id = $1 AND status = 'pending' RETURNING *`, [draftId, subj, text]);
  if (!claim.rowCount) return { ok: true, already: true, state: 'sending' };
  const job = sendOne(pool, claim.rows[0], deps).catch((e) => console.error('[cold-agent] send crashed', draftId, e.message));
  if (deps.awaitSend) await job;
  return { ok: true, state: 'sending' };
}

function textToHtml(t) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return String(t || '').replace(/\r\n/g, '\n').split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean)
    .map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
}

const FOOTER_WHY = 'You received this because you have a NILDash account.';

async function sendOne(pool, d, deps = {}) {
  const sendRules = require('./sendRules');
  const canSpam = require('./canSpam');
  const fail = async (msg) => {
    await pool.query(`UPDATE cold_drafts SET status = 'failed', send_error = $2, send_claimed_at = NULL WHERE id = $1`, [d.id, String(msg).slice(0, 300)]);
    return { ok: false, error: msg };
  };
  try {
    const rule = await sendRules.check(pool, { email: d.email, subject: d.subject, system: SYSTEM, refId: d.id });
    if (!rule.ok) return fail('Not sent: ' + rule.reason);
    const admin = await adminUser(pool);
    const html = canSpam.appendHtml(textToHtml(d.body_text), d.email, { why: FOOTER_WHY });
    let res;
    if (deps.send) res = await deps.send({ to: d.email, subject: d.subject, html, text: d.body_text });
    else {
      if (!admin) return fail('No admin account to send from (ADMIN_EMAIL).');
      const emailStore = require('./emailStore');
      const acct = emailStore.pickSendingAccount(await emailStore.getEmailAccountsByUser(admin.id));
      if (!acct) return fail('Your mailbox is not connected: connect it in Settings so these go out from you.');
      const full = await emailStore.getEmailAccountWithTokens(acct.id);
      const provider = require('../jobs/closerRelease').providerFor(full);
      const args = { to: [d.email], subject: d.subject, bodyHtml: html, attachments: [], replyTo: null, messageId: null };
      res = full.provider === 'imap' && !require('./providers/fakeSend').active()
        ? await provider.sendEmail(full.email_address, full.accessToken, full.refreshToken ? JSON.parse(full.refreshToken) : {}, args)
        : await provider.sendEmail(full.accessToken, full.refreshToken, args);
    }
    // It has left. Facts from here on.
    await pool.query(`UPDATE cold_drafts SET status = 'sent', sent_at = NOW(), send_claimed_at = NULL, send_error = NULL,
                        message_id = $2 WHERE id = $1`, [d.id, (res && (res.providerMessageId || res.messageId)) || null]);
    await pool.query(
      `INSERT INTO cold_prospects (user_id, email, touches, first_touch_at, last_touch_at, updated_at)
       VALUES ($1, $2, 1, NOW(), NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET touches = cold_prospects.touches + 1, last_touch_at = NOW(), email = EXCLUDED.email,
         updated_at = NOW()`, [d.user_id, d.email]);
    await sendRules.record(pool, { email: d.email, subject: d.subject, system: SYSTEM, agentId: SANDBOX_AGENT, refId: d.id });
    return { ok: true };
  } catch (e) {
    const sendGuard = require('./sendGuard');
    const c = sendGuard.classifyError(e);
    return fail('Send failed: ' + (c.kind === 'other' ? (e.message || 'unknown') : c.detail));
  }
}

async function skip(pool, draftId, note) {
  await ensureTables(pool);
  const r = await pool.query(`UPDATE cold_drafts SET status = 'skipped', status_note = $2, decided_at = NOW()
                               WHERE id = $1 AND status IN ('pending', 'failed') RETURNING id`, [draftId, note || 'skipped by the admin']);
  return { ok: !!r.rowCount };
}

// replied: no more touches. no / bounced: suppressed for EVERY sender, for
// good. exclude: never picked again (the account stays mailable otherwise).
async function mark(pool, userId, as) {
  await ensureTables(pool);
  const u = (await pool.query(`SELECT id, email FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u) return { ok: false, error: 'no such user' };
  const reasons = { replied: 'they replied', no: 'they said no', bounced: 'the address bounced', exclude: 'excluded by the admin' };
  if (!reasons[as]) return { ok: false, error: 'as must be replied, no, bounced or exclude' };
  if (as === 'no' || as === 'bounced') {
    await require('./sendRules').suppressManually(pool, u.email, { reason: 'cold agent: ' + reasons[as], kind: as === 'bounced' ? 'bounce' : 'unsubscribe', by: null });
  }
  await pool.query(
    `INSERT INTO cold_prospects (user_id, email, status, stop_reason, updated_at) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status, stop_reason = EXCLUDED.stop_reason, updated_at = NOW()`,
    [u.id, lc(u.email), as === 'exclude' ? 'excluded' : (as === 'replied' ? 'replied' : 'stopped'), reasons[as]]);
  await pool.query(`UPDATE cold_drafts SET status = 'skipped', status_note = $2, decided_at = NOW() WHERE user_id = $1 AND status = 'pending'`,
    [u.id, 'not sent: ' + reasons[as]]);
  return { ok: true };
}

// ── WHAT THE PAGE SHOWS ─────────────────────────────────────────────────────
async function listDrafts(pool, { status } = {}) {
  await ensureTables(pool);
  const rows = (await pool.query(
    `SELECT d.*, COALESCE(cp.touches, 0) AS touches, cp.last_touch_at, cp.status AS prospect_status,
            u.last_login, u.created_at AS signed_up, u.agency_name,
            (SELECT COUNT(*)::int FROM athletes a WHERE a.agent_id = d.user_id) AS athletes
       FROM cold_drafts d LEFT JOIN cold_prospects cp ON cp.user_id = d.user_id LEFT JOIN users u ON u.id = d.user_id
      WHERE ($1::text IS NULL OR d.status = $1) ORDER BY d.created_at DESC LIMIT 100`, [status || null])).rows;
  const ids = rows.map((r) => r.id);
  const cards = ids.length ? (await pool.query(`SELECT * FROM cold_demo_cards WHERE draft_id = ANY($1) ORDER BY id`, [ids])).rows : [];
  return rows.map((r) => ({ ...r, businesses: cards.filter((c) => c.draft_id === r.id) }));
}
async function listRuns(pool, limit = 20) {
  await ensureTables(pool);
  return (await pool.query(`SELECT * FROM cold_runs ORDER BY id DESC LIMIT $1`, [limit])).rows;
}

// ── THE SCHEDULE (Central) ─────────────────────────────────────────────────
function centralNow(now) {
  const d = now ? new Date(now) : new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: p.weekday };
}
function pastDeadline(s, now) {
  const c = centralNow(now);
  return c.hour * 60 + c.minute >= s.deadlineHour * 60 + s.deadlineMinute;
}
function dueAt(s, now) {
  const c = centralNow(now);
  if (!s.enabled || s.perRun < 1) return false;
  if (s.weekdaysOnly && (c.weekday === 'Sat' || c.weekday === 'Sun')) return false;
  const m = c.hour * 60 + c.minute;
  return m >= s.startHour * 60 + s.startMinute && m < s.deadlineHour * 60 + s.deadlineMinute;
}
async function tick(pool, now) {
  await ensureTables(pool);
  const s = await getSettings(pool);
  if (!dueAt(s, now)) return { ran: false };
  const date = centralNow(now).date;
  const done = (await pool.query(`SELECT 1 FROM cold_runs WHERE run_date = $1 AND trigger = 'schedule' LIMIT 1`, [date])).rowCount;
  if (done) return { ran: false, already: true };
  return { ran: true, ...(await runOnce(pool, { trigger: 'schedule', now })) };
}
let _timer = null;
function start(pool) {
  if (_timer) return;
  const go = () => tick(pool).catch((e) => console.error('[cold-agent] tick:', e.message));
  _timer = setInterval(go, 5 * 60 * 1000);
  if (_timer.unref) _timer.unref();
  setTimeout(go, 90 * 1000).unref?.();
}

module.exports = {
  ensureTables, getSettings, saveSettings, clampSettings, candidates, classify, isInternal, pick, research, demoSubject,
  runDemo, usable, checkEmail, templateEmail, writeEmail, prepare, runOnce, detectReplies, approve, sendOne, skip, mark,
  listDrafts, listRuns, centralNow, dueAt, pastDeadline, tick, start,
  SANDBOX_AGENT, SYSTEM, MAX_TOUCHES, GAP_DAYS, ACTIVE_DAYS, DORMANT_DAYS, PAYING, DEFAULTS, INTERNAL_NAMES, FOOTER_WHY,
  loginProblem, heldFor, MIN_DEMO_CARDS, NO_DEMO_RETRY_DAYS, HELD_PARTNERS, usesFirmFact, numbersIn, whenRan, BANNED, textToHtml, adminEmail,
};
