'use strict';
// ── "SEE IT FOR YOUR ATHLETE": NILDASH'S FREE SAMPLE, ASKED FOR BY THE AGENT ─
//
// mynildash.com/pitches. An agent types in one athlete (name, school, sport,
// level) and their own email. NILDash runs its own overnight engine for that
// athlete (jobs/outreachQueue fillAthlete, the same call the nightly run makes)
// and shows the result on a private page, /pitches/<token>: up to 5 local
// businesses, why each fits, the person who decides, and the pitch already
// written in the agent's name. The agent asked for it, so nothing about it
// reads as us looking them up.
//
// The page's one button starts the trial (SALES_TRIAL_ON) or the plan, with
// their email filled in; once they are in, the athlete they typed is already
// on their roster (claimFor, called when their roster first loads with
// access).
//
// COSTS AND LIMITS. Each build spends Hunter lookups and a little AI, so:
//   - NIL_TRY_ON must be on, or requests wait and nothing is built;
//   - at most NIL_TRY_PER_DAY builds a day (default 5), one at a time; the
//     rest wait for the next day, first come first served;
//   - one request per email a week (the same link comes back), two per IP a
//     day; a hidden field catches bots;
//   - each build is capped at NIL_TRY_USD (default 1.00) and never widens.
// Built under a hidden archived account (tries@mynildash.invalid); the
// athlete and its cards are deleted after the cards are copied, so nothing
// else in NILDash ever sees them.
//
// When it is ready: the agent gets the link by email, and JohnMark gets an
// alert (a hand-raised lead). An agent on the cold list stops getting cold
// emails the moment they ask.

const crypto = require('crypto');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const ON = () => truthy(process.env.NIL_TRY_ON);
const PER_DAY = () => { const n = parseInt(process.env.NIL_TRY_PER_DAY, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 5; };
const USD = () => { const n = parseFloat(process.env.NIL_TRY_USD); return Number.isFinite(n) && n > 0 ? Math.min(n, 3) : 1.0; };
const SHOW = 5;
const MIN_CARDS = 2;
const PER_IP = 2;
const TRIES_ID = 'nildash-tries';
const TRIES_EMAIL = 'tries@mynildash.invalid';
const SPORTS = ['Football', 'Basketball', 'Baseball', 'Softball', 'Soccer', 'Volleyball', 'Track and Field', 'Wrestling', 'Golf', 'Tennis',
  'Lacrosse', 'Swimming', 'Hockey', 'Gymnastics', 'Other'];
// The level the agent picks -> the school tier the engine sizes deals by.
const LEVELS = { p4: 'p4-mid', d1: 'mid-mid', d2: 'd2-mid', d3: 'd3-mid', naia: 'naia-mid', juco: 'juco-d1', hs: null };
const CENTRAL = 'America/Chicago';

const lc = (s) => String(s || '').trim().toLowerCase();
const clip = (v, n) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, n);
const err = (msg, status = 400, field) => Object.assign(new Error(msg), { status, field });

let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS nil_tries (
      token TEXT PRIMARY KEY, email TEXT NOT NULL, agent_name TEXT, agency TEXT,
      athlete_name TEXT NOT NULL, school TEXT NOT NULL, sport TEXT NOT NULL, position TEXT, level TEXT NOT NULL DEFAULT 'd1',
      status TEXT NOT NULL DEFAULT 'pending', cards JSONB, why TEXT, spent NUMERIC, ip TEXT,
      views INT NOT NULL DEFAULT 0, last_viewed_at TIMESTAMPTZ, emailed_at TIMESTAMPTZ,
      user_id TEXT, claimed_athlete_id TEXT, claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, built_at TIMESTAMPTZ)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS nil_tries_email ON nil_tries (email, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS nil_tries_status ON nil_tries (status, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS nil_tries_user ON nil_tries (user_id)`);
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

function centralDate(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function appUrl() { return String(process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, ''); }
function pageUrl(token) { return `${appUrl()}/pitches/${token}`; }

// ── ASKING ──────────────────────────────────────────────────────────────────
// -> { token, existing? }. Throws { status, field, message } a person can read.
async function request(pool, input, opts = {}) {
  await ensureTables(pool);
  const b = input || {};
  if (clip(b.website, 50)) throw err('Something went wrong. Refresh and try again.', 400);   // the hidden field
  const email = lc(b.email).slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) throw err('Enter your email so we can send you the link.', 400, 'email');
  const athlete = clip(b.athlete || b.athleteName, 80);
  if (athlete.length < 3 || !/\s/.test(athlete)) throw err("Enter the athlete's first and last name.", 400, 'athlete');
  const school = clip(b.school, 120);
  if (school.length < 2) throw err('Enter the school. We find businesses near it.', 400, 'school');
  const sport = SPORTS.find((s) => lc(s) === lc(b.sport)) || null;
  if (!sport) throw err('Pick the sport.', 400, 'sport');
  const level = Object.prototype.hasOwnProperty.call(LEVELS, lc(b.level)) ? lc(b.level) : 'd1';
  const name = clip(b.name || b.agentName, 80);
  const agency = clip(b.agency, 120);
  const position = clip(b.position, 30);
  const ip = clip(opts.ip, 64) || null;

  // The same email this week: the same page back, no second build.
  const again = (await pool.query(`SELECT token FROM nil_tries WHERE email = $1 AND created_at > NOW() - INTERVAL '7 days'
    ORDER BY created_at DESC LIMIT 1`, [email])).rows[0];
  if (again) return { token: again.token, existing: true };
  if (ip) {
    const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM nil_tries WHERE ip = $1 AND created_at > NOW() - INTERVAL '1 day'`, [ip])).rows[0].n;
    if (n >= PER_IP) throw err('You have already asked for two today. Check your email for the links.', 429);
  }
  const token = crypto.randomBytes(16).toString('base64url');
  await pool.query(`INSERT INTO nil_tries (token, email, agent_name, agency, athlete_name, school, sport, position, level, ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [token, email, name || null, agency || null, athlete, school, sport, position || null, level, ip]);
  // On the cold list: asking for it is a reply in itself, so the cold emails stop.
  try {
    const p = (await pool.query(`SELECT id FROM sales_prospects WHERE LOWER(email) = $1 AND status IN ('drafted', 'active')`, [email])).rows[0];
    if (p) await require('./salesAutopilot').stopProspect(pool, p.id, 'replied', 'asked for a free sample on /pitches', { tag: 'interested' });
  } catch (_) { /* no cold list here */ }
  return { token };
}

// ── BUILDING ────────────────────────────────────────────────────────────────
async function triesAccount(pool, signFirst) {
  await pool.query(
    `INSERT INTO users (id, name, email, password, role, archived, seat_override)
     VALUES ($1, 'NILDash Tries', $2, $3, 'agent', TRUE, 0) ON CONFLICT DO NOTHING`,
    [TRIES_ID, TRIES_EMAIL, '!' + crypto.randomBytes(24).toString('hex')]).catch(() => {});
  await pool.query(`UPDATE users SET archived = TRUE, sign_first_name = $2 WHERE id = $1`, [TRIES_ID, signFirst || 'Your agent']).catch(() => {});
  return TRIES_ID;
}
async function cleanup(pool, athleteId) {
  if (!athleteId || !/^ath-try-/.test(athleteId)) return;
  for (const sql of [
    `DELETE FROM outreach_queue WHERE athlete_id = $1 AND agent_id = '${TRIES_ID}'`,
    `DELETE FROM outreach_logs WHERE athlete_id = $1 AND agent_id = '${TRIES_ID}'`,
    `DELETE FROM athletes WHERE id = $1 AND agent_id = '${TRIES_ID}'`,
  ]) await pool.query(sql, [athleteId]).catch((e) => console.error('[nil-try] cleanup: ' + e.message));
}

// One request's build. deps.fill(ctx) stands in for the engine in tests.
async function build(pool, t, deps = {}) {
  const store = require('../store');
  const job = require('../jobs/outreachQueue');
  const Q = require('./outreachQueue');
  const SS = require('./salesSample');
  const first = clip(t.agent_name, 80).split(' ')[0] || 'Your agent';
  const agentId = await triesAccount(pool, first);
  const athleteId = 'ath-try-' + crypto.randomBytes(6).toString('hex');
  await store.saveAthlete(athleteId, {
    id: athleteId, agentId, name: t.athlete_name, sport: t.sport, position: t.position || '', school: t.school,
    athleteType: 'college', ...(LEVELS[t.level] ? { schoolTier: LEVELS[t.level] } : {}),
    notes: 'Free sample from /pitches', sample: true, createdAt: new Date().toISOString(),
  });
  const budget = Q.newBudget(USD());
  let r;
  try {
    const ath = (await job.loadAthletesForQueue(pool, agentId, athleteId))[0];
    if (!ath) throw new Error('the athlete could not be read back');
    if (deps.fill) r = await deps.fill({ pool, ath, budget, agentId, athleteId });
    else {
      const ctx = await job.localContextFor(ath);
      const SIG = require('./signature');
      r = await job.fillAthlete(pool, {
        agentId, athleteId, athleteName: ath.name, runDate: job.today(), athleteProfile: ctx.profile,
        agentFirstName: first, signature: SIG.signatureOf(ath), athleteRow: ath.data || null,
        budget, region: ctx.region, regionFault: ctx.fault || null,
        noWiden: true, maxSlots: SHOW, onProgress: (m) => console.log('[nil-try] ' + m),
      });
    }
  } catch (e) {
    await cleanup(pool, athleteId);
    return { status: 'failed', why: 'the build failed: ' + String(e.message || e).slice(0, 200), cards: [] };
  }
  const cards = (await SS.cardsFor(pool, athleteId)).slice(0, SHOW);
  const spent = typeof budget.spent === 'function' ? budget.spent() : null;
  await cleanup(pool, athleteId);
  if (cards.length < MIN_CARDS) return { status: 'failed', why: `only ${cards.length} found${r && r.note ? ': ' + String(r.note).slice(0, 160) : ''}`, cards, spent };
  return { status: 'ready', cards, spent };
}

// Every 2 minutes while on: the oldest waiting request, if today's builds are
// under the cap. One at a time.
let _busy = false;
async function tick(pool, { now = new Date(), deps = {} } = {}) {
  await ensureTables(pool);
  if (!ON() && !deps.force) return { skipped: 'NIL_TRY_ON is off' };
  if (_busy) return { skipped: 'already building' };
  _busy = true;
  try {
    // A build that never finished (a restart) goes back to the queue once.
    await pool.query(`UPDATE nil_tries SET status = 'pending' WHERE status = 'building' AND started_at < $1::timestamptz - INTERVAL '45 minutes'`, [now]);
    const today = centralDate(now);
    const built = (await pool.query(`SELECT COUNT(*)::int AS n FROM nil_tries WHERE started_at IS NOT NULL
      AND (started_at AT TIME ZONE '${CENTRAL}')::date = $1::date`, [today])).rows[0].n;
    if (built >= PER_DAY()) return { skipped: `today's ${PER_DAY()} are done` };
    const t = (await pool.query(`UPDATE nil_tries SET status = 'building', started_at = $1
      WHERE token = (SELECT token FROM nil_tries WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [now])).rows[0];
    if (!t) return { skipped: 'nothing waiting' };
    const res = await build(pool, t, deps).catch((e) => ({ status: 'failed', why: String(e.message || e).slice(0, 200), cards: [] }));
    await pool.query(`UPDATE nil_tries SET status = $2, cards = $3, why = $4, spent = $5, built_at = $6 WHERE token = $1`,
      [t.token, res.status, JSON.stringify(res.cards || []), res.why || null, res.spent == null ? null : res.spent, now]);
    await tellThem(pool, { ...t, status: res.status, cards: res.cards }, deps);
    return { token: t.token, status: res.status, cards: (res.cards || []).length, why: res.why || null };
  } finally { _busy = false; }
}

// The agent's link by email; JohnMark's alert either way.
async function tellThem(pool, t, deps = {}) {
  const first = clip(t.agent_name, 80).split(' ')[0];
  const ready = t.status === 'ready';
  const n = (t.cards || []).length;
  const subject = ready ? `${n} businesses ready to pitch for ${t.athlete_name}` : `Your NILDash sample for ${t.athlete_name}`;
  const text = ready
    ? `${first ? `Hi ${first},` : 'Hi,'}\n\nNILDash found ${n} local businesses that fit ${t.athlete_name} at ${t.school}, with the person who decides and a pitch already written for each one:\n\n${pageUrl(t.token)}\n\nThis is what NILDash does every morning for every athlete you represent.\n\nJohnMark\nNILDash`
    : `${first ? `Hi ${first},` : 'Hi,'}\n\nNILDash couldn't find enough businesses near ${t.school} for ${t.athlete_name} on this run. Reply with another athlete and I'll run it by hand.\n\nJohnMark\nNILDash`;
  try {
    if (deps.sendAgent) await deps.sendAgent(t.email, { subject, text });
    else if (process.env.RESEND_API_KEY) {
      const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
      const from = process.env.NIL_TRY_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>';
      const replyTo = String(process.env.SALES_FROM_ADDRESS || 'john@comptongroupllc.com').trim();
      const r = await resend.emails.send({ from, to: t.email, subject, text, reply_to: replyTo });
      if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
    }
    await pool.query(`UPDATE nil_tries SET emailed_at = NOW() WHERE token = $1`, [t.token]);
  } catch (e) { console.error('[nil-try] email:', e.message); }
  try {
    const msg = { subject: `NILDash sample ${ready ? 'ready' : 'failed'}: ${t.agent_name || t.email} (${t.athlete_name})`,
      text: `${t.agent_name || '(no name)'} <${t.email}>${t.agency ? ', ' + t.agency : ''} asked for a sample for ${t.athlete_name} (${t.sport}, ${t.school}).\n`
        + (ready ? `${n} businesses found. Their page: ${pageUrl(t.token)}\n\nThis agent raised their hand.` : `It failed: ${t.why || 'too few businesses'}. Worth a personal reply.`) };
    if (deps.alert) await deps.alert(msg); else await require('./salesAutopilot').alert(msg);
  } catch (e) { console.error('[nil-try] alert:', e.message); }
}

// ── WHAT THE PAGE SHOWS ─────────────────────────────────────────────────────
// The business, why, the person and their title, the pitch. Never an email
// address or a street address: that is what the trial is for.
async function view(pool, token, opts = {}) {
  await ensureTables(pool);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
  const t = (await pool.query(`SELECT * FROM nil_tries WHERE token = $1`, [token])).rows[0];
  if (!t) return null;
  if (opts.countView) pool.query(`UPDATE nil_tries SET views = views + 1, last_viewed_at = NOW() WHERE token = $1`, [token]).catch(() => {});
  let ahead = 0;
  if (t.status === 'pending') {
    ahead = (await pool.query(`SELECT COUNT(*)::int AS n FROM nil_tries WHERE status = 'pending' AND created_at < $1`, [t.created_at])).rows[0].n;
  }
  const SA = require('./salesAutopilot');
  const trialOn = SA.TRIAL_ON();
  const q = new URLSearchParams({ signin: 'agent', tab: 'signup', email: t.email, try: t.token });
  if (trialOn) q.set('trial', String(SA.TRIAL_DAYS || 14));
  const cards = (Array.isArray(t.cards) ? t.cards : []).slice(0, SHOW).map((c) => ({
    business: c.business, category: c.category || null, why: c.why || null, contactName: c.contactName || null,
    contactTitle: c.contactTitle || null, channel: c.channel || null, subject: c.subject || null, pitch: c.pitch || null,
  }));
  return { status: t.status, athlete: t.athlete_name, school: t.school, sport: t.sport, position: t.position, level: t.level,
    agentFirst: clip(t.agent_name, 80).split(' ')[0] || null, cards, ahead, building: ON(),
    trialOn, trialDays: trialOn ? (SA.TRIAL_DAYS || 14) : 0, signupUrl: '/?' + q.toString(), createdAt: t.created_at, builtAt: t.built_at };
}

// ── AFTER THEY SIGN UP ──────────────────────────────────────────────────────
// The signup carried the token: the request is linked to the new account.
async function link(pool, token, userId) {
  await ensureTables(pool);
  if (!token || !userId) return false;
  const r = await pool.query(`UPDATE nil_tries SET user_id = $2 WHERE token = $1 AND user_id IS NULL`, [String(token).slice(0, 64), userId]);
  return r.rowCount > 0;
}
// The roster loads with access and is empty: the athlete they typed goes on
// it, once. -> the athlete, or null.
async function claimFor(pool, user, deps = {}) {
  await ensureTables(pool);
  if (!user || !user.id) return null;
  const t = (await pool.query(`SELECT * FROM nil_tries WHERE (user_id = $1 OR LOWER(email) = $2) AND claimed_at IS NULL
    ORDER BY created_at DESC LIMIT 1`, [user.id, lc(user.email)])).rows[0];
  if (!t) return null;
  const claim = await pool.query(`UPDATE nil_tries SET claimed_at = NOW(), user_id = COALESCE(user_id, $2) WHERE token = $1 AND claimed_at IS NULL RETURNING token`, [t.token, user.id]);
  if (!claim.rowCount) return null;
  const create = deps.createAthlete || require('./athleteCreate').createAthlete;
  const r = await create(user, { name: t.athlete_name, sport: t.sport, position: t.position || '', school: t.school,
    athleteType: 'college', ...(LEVELS[t.level] ? { schoolTier: LEVELS[t.level] } : {}), notes: 'Added from your free sample' });
  if (!r || !r.ok) {
    await pool.query(`UPDATE nil_tries SET claimed_at = NULL WHERE token = $1`, [t.token]);
    return null;
  }
  await pool.query(`UPDATE nil_tries SET claimed_athlete_id = $2 WHERE token = $1`, [t.token, r.athlete && r.athlete.id]);
  return r.athlete || null;
}

async function recent(pool, n = 100) {
  await ensureTables(pool);
  return (await pool.query(`SELECT token, email, agent_name, agency, athlete_name, school, sport, level, status, why, views, user_id,
      claimed_at, created_at, built_at, jsonb_array_length(COALESCE(cards, '[]'::jsonb)) AS cards FROM nil_tries ORDER BY created_at DESC LIMIT $1`, [n])).rows;
}

let _timer = null;
function start(pool) {
  if (_timer) return;
  _timer = setInterval(() => { if (ON()) tick(pool).catch((e) => console.error('[nil-try] tick:', e.message)); }, 2 * 60 * 1000);
  if (_timer.unref) _timer.unref();
}

module.exports = { ON, PER_DAY, USD, SHOW, SPORTS, LEVELS, TRIES_ID, ensureTables, request, build, tick, view, link, claimFor, recent, start, pageUrl,
  _reset() { _ready = null; } };
