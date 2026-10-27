'use strict';
// ── THE SALES AUTOPILOT: NILDASH FINDS ITS OWN CUSTOMERS ───────────────────
//
// Every weekday it finds new prospects in two lanes (services/salesFind:
// agencies and school NIL staff), writes one short plain-text email to each
// as JohnMark (services/salesWriter), and sends them from his own Outlook
// mailbox (services/salesMailbox) on a schedule built to protect that
// address. Replies, bounces, bookings and unsubscribes stop a sequence
// (services/salesReplies). Nobody approves a send; JohnMark reads replies
// and takes demo calls.
//
// THE SWITCHES, all off by default:
//   SALES_AUTOPILOT_ON=true   the nightly find-and-draft and the reply reader.
//                             Nothing is sent: a dry run every weekday.
//   SALES_AUTOSEND_ON=true    the emails go out (needs the one above).
//   SALES_TRIAL_ON=true       the 14-day trial: the emails offer it, /try and
//                             the homepage start it.
// The numbers: SALES_DAILY_NEW (20 new prospects a weekday, split evenly by
// lane), SALES_DAILY_CAP (30 sends a day at most, follow-ups included),
// SALES_HUNTER_MAX (Hunter credits a night for sales, 120), SALES_MAX_QUEUE
// (the scheduled night drafts only while fewer than 60 first emails wait).
//
// PROTECTING THE ADDRESS. john@comptongroupllc.com is the main business
// address, so:
//   - warm-up: 10 new sends on the first sending day, 3 more each sending
//     day after, never over SALES_DAILY_CAP; follow-ups count;
//   - weekdays only, at random times between 9am and 4pm in the prospect's
//     time zone, at least 4 minutes apart, at most 2 a day to one domain;
//   - verified addresses only (Hunter, at most 30 days old at send time);
//   - plain text, one link besides the unsubscribe, the CAN-SPAM footer;
//   - follow-ups on day 3 and day 7, in the same thread, and none after a
//     reply, a booking, a bounce, an unsubscribe or a trial;
//   - a HARD STOP (paused, and JohnMark emailed why) when bounces pass 2% of
//     the last 7 days' sends, on any spam complaint, or on any sign that
//     Microsoft limited the mailbox. It stays stopped until he resumes it:
//     /api/admin/scripts/sales-autopilot?resume=1&text=1

const crypto = require('crypto');
const F = require('./salesFind');
const W = require('./salesWriter');
const MB = require('./salesMailbox');

const SYSTEM = 'sales-autopilot';
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const ON = () => truthy(process.env.SALES_AUTOPILOT_ON);
const SEND_ON = () => ON() && truthy(process.env.SALES_AUTOSEND_ON);
const TRIAL_ON = () => truthy(process.env.SALES_TRIAL_ON);
function intEnv(k, d, lo, hi) { const n = parseInt(process.env[k], 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
const DAILY_NEW = () => intEnv('SALES_DAILY_NEW', 20, 0, 200);
const DAILY_CAP = () => intEnv('SALES_DAILY_CAP', 30, 1, 500);
const HUNTER_MAX = () => intEnv('SALES_HUNTER_MAX', 120, 0, 5000);
const MAX_QUEUE = () => intEnv('SALES_MAX_QUEUE', 60, 0, 5000);
const WARMUP_START = 10;
const WARMUP_STEP = 3;
const WINDOW_FROM = 9 * 60;     // local minutes
const WINDOW_TO = 16 * 60;
const MIN_GAP_MS = 4 * 60000;
const DOMAIN_PER_DAY = 2;
const FOLLOW_UP_AFTER = { 2: 3, 3: 7 };   // step -> days after the first email
const BOUNCE_LIMIT = 0.02;
const BOUNCE_DAYS = 7;
const VERIFY_MAX_DAYS = 30;
const RUN_AT = 4 * 60;          // Central, weekdays: find and draft
const PLAN_AT = 7 * 60;         // Central, weekdays: today's send times
const LIVE = ['drafted', 'active'];
const CENTRAL = 'America/Chicago';
const lc = (s) => String(s || '').trim().toLowerCase();

function appUrl() { return String(process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, ''); }
function link() { return appUrl() + '/try'; }
function senderName() { return String(process.env.SALES_SENDER_NAME || 'JohnMark Compton').replace(/[^A-Za-z .'-]/g, '').trim() || 'JohnMark Compton'; }
function writerCtx() { return { link: link(), trialOn: TRIAL_ON(), senderName: senderName(), senderPhone: String(process.env.SALES_SENDER_PHONE || '').trim() }; }
// The writer's context for one prospect: a ready sample's page is that
// email's one link (services/salesSample); everyone else gets /try.
function ctxFor(p) {
  const base = writerCtx();
  return p && p.sample_status === 'ready' && p.sample_token ? { ...base, link: require('./salesSample').sampleUrl(p.sample_token) } : base;
}
// A first email as it should read today: the sample version when there is a
// ready sample, the template otherwise.
function firstEmailFor(p) {
  const ctx = ctxFor(p);
  return p && p.sample_status === 'ready' && p.sample ? W.sampleEmail(p, ctx, p.sample) : W.templateEmail(p, ctx);
}
function footerWhy(lane) {
  return lane === 'school'
    ? 'You received this because of your work with NIL at your athletic department.'
    : 'You received this because of your work representing athletes.';
}

// ── TABLES ──────────────────────────────────────────────────────────────────
let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS sales_prospects (
      id TEXT PRIMARY KEY, lane TEXT NOT NULL, org TEXT, domain TEXT, person TEXT NOT NULL, title TEXT,
      email TEXT NOT NULL, verify_status TEXT, verify_result TEXT, verified_at TIMESTAMPTZ, found_by TEXT,
      league TEXT, level TEXT, city TEXT, state TEXT, tz TEXT, fact TEXT, source TEXT, detail JSONB,
      status TEXT NOT NULL DEFAULT 'drafted', stop_reason TEXT, tag TEXT, run_id INTEGER,
      root_message_id TEXT, conversation_id TEXT, first_sent_at TIMESTAMPTZ, last_sent_at TIMESTAMPTZ, replied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sales_prospects_email ON sales_prospects (email)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS sales_prospects_status ON sales_prospects (status)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sales_emails (
      id TEXT PRIMARY KEY, prospect_id TEXT NOT NULL, step INTEGER NOT NULL, subject TEXT, body_text TEXT,
      state TEXT NOT NULL DEFAULT 'draft', plan_date DATE, planned_for TIMESTAMPTZ, claimed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ,
      message_id TEXT, conversation_id TEXT, written_by TEXT, error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sales_emails_step ON sales_emails (prospect_id, step)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS sales_emails_state ON sales_emails (state, planned_for)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sales_runs (
      id SERIAL PRIMARY KEY, run_date DATE, trigger TEXT, dry BOOLEAN, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ, drafted INTEGER DEFAULT 0, credits INTEGER DEFAULT 0, note TEXT, detail JSONB)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sales_state (
      id INTEGER PRIMARY KEY DEFAULT 1, paused BOOLEAN NOT NULL DEFAULT FALSE, paused_reason TEXT, paused_at TIMESTAMPTZ,
      resumed_at TIMESTAMPTZ, inbox_checked_at TIMESTAMPTZ, folder_id TEXT, cursors JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`INSERT INTO sales_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sales_events (
      id SERIAL PRIMARY KEY, prospect_id TEXT, kind TEXT NOT NULL, tag TEXT, message_id TEXT, detail JSONB,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sales_events_message ON sales_events (message_id, kind) WHERE message_id IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS sales_events_at ON sales_events (kind, at)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sales_tried (
      key TEXT PRIMARY KEY, lane TEXT, outcome TEXT, tried_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sales_trials (
      user_id TEXT PRIMARY KEY, email TEXT, source TEXT, prospect_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // THE SAMPLE (services/salesSample): pending, ready or failed; its page token; what it holds.
    await pool.query(`ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS sample_status TEXT`);
    await pool.query(`ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS sample_token TEXT`);
    await pool.query(`ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS sample JSONB`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sales_prospects_sample_token ON sales_prospects (sample_token) WHERE sample_token IS NOT NULL`);
    await require('./sendRules').ensureTable(pool).catch(() => {});
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

async function getState(pool) {
  await ensureTables(pool);
  const r = (await pool.query(`SELECT * FROM sales_state WHERE id = 1`)).rows[0] || {};
  return { ...r, cursors: r.cursors || {} };
}
async function saveCursors(pool, cursors) {
  await pool.query(`UPDATE sales_state SET cursors = $1, updated_at = NOW() WHERE id = 1`, [JSON.stringify(cursors || {})]);
}

// ── TIME ────────────────────────────────────────────────────────────────────
function partsIn(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const centralDay = (now) => partsIn(now ? new Date(now) : new Date(), CENTRAL);
const weekend = (p) => p.weekday === 'Sat' || p.weekday === 'Sun';
// The UTC instant of `minutes` past midnight on `date` (YYYY-MM-DD) in tz.
function zonedTime(date, minutes, tz) {
  const [y, m, d] = date.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  for (let i = 0; i < 3; i++) {
    const p = partsIn(t, tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    const diff = (Date.UTC(py, pm - 1, pd) + p.minutes * 60000) - (Date.UTC(y, m - 1, d) + minutes * 60000);
    if (!diff) break;
    t -= diff;
  }
  return new Date(t);
}
const addDays = (date, n) => { const t = new Date(date + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
function nextWeekday(date) { let d = addDays(date, 1); while (['Sat', 'Sun'].includes(partsIn(d + 'T18:00:00Z', 'UTC').weekday)) d = addDays(d, 1); return d; }
const fmtLocal = (when, tz) => { const p = partsIn(when, tz); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

// ── WARM-UP ─────────────────────────────────────────────────────────────────
// Day 1 is the first weekday anything was sent: 10. Each sending day after
// adds 3, to SALES_DAILY_CAP. A day the autopilot was paused or off does not
// count, so a stop never comes back at a higher level.
async function warmup(pool, today) {
  const r = (await pool.query(
    `SELECT COUNT(DISTINCT (sent_at AT TIME ZONE '${CENTRAL}')::date)::int AS n FROM sales_emails
      WHERE sent_at IS NOT NULL AND (sent_at AT TIME ZONE '${CENTRAL}')::date < $1::date`, [today])).rows[0];
  const before = r ? r.n : 0;
  return { day: before + 1, cap: Math.min(DAILY_CAP(), WARMUP_START + WARMUP_STEP * before), dailyCap: DAILY_CAP() };
}

// ── THE NIGHT: FIND AND DRAFT ─────────────────────────────────────────────
const newId = (p) => p + '_' + crypto.randomBytes(8).toString('hex');

async function tried(pool, key) {
  return (await pool.query(`SELECT 1 FROM sales_tried WHERE key = $1 AND tried_at > NOW() - INTERVAL '180 days'`, [key])).rowCount > 0;
}
async function markTried(pool, key, lane, outcome) {
  await pool.query(`INSERT INTO sales_tried (key, lane, outcome, tried_at) VALUES ($1, $2, $3, NOW())
    ON CONFLICT (key) DO UPDATE SET outcome = EXCLUDED.outcome, tried_at = NOW()`, [key, lane, String(outcome || '').slice(0, 200)]);
}

// Run fn over items, n at a time, starting no new one once stop() says so.
async function eachLimit(items, n, fn, stop) {
  let i = 0;
  const worker = async () => {
    for (;;) {
      if (stop && stop()) return;
      const k = i++;
      if (k >= items.length) return;
      await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

async function saveProspect(pool, cand, found, ctx) {
  const id = newId('sp');
  const p = {
    id, lane: cand.lane, org: cand.org || null, domain: found.domain || cand.domain || null, person: found.person, title: found.title || null,
    email: found.email, league: cand.league || null, level: cand.level || null, city: cand.city || null,
    state: cand.state ? String(cand.state).toUpperCase().slice(0, 2) : null, fact: cand.fact || null, source: cand.source || null,
  };
  p.tz = F.tzFor(p.state);
  const mail = await W.write(p, writerCtx(), ctx.deps);
  // A client on record and SALES_SAMPLE_ON: the sample is built after the
  // Hunter night (services/salesSample), and the email waits for it.
  const sample = cand.sample && cand.sample.athlete && require('./salesSample').ON() ? cand.sample : null;
  const ins = await pool.query(
    `INSERT INTO sales_prospects (id, lane, org, domain, person, title, email, verify_status, verify_result, verified_at, found_by,
       league, level, city, state, tz, fact, source, detail, status, run_id, sample_status, sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'drafted',$20,$21,$22)
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [id, p.lane, p.org, p.domain, p.person, p.title, p.email, found.verify.status, found.verify.result, found.verify.at, found.how,
      p.league, p.level, p.city, p.state, p.tz, p.fact, p.source, JSON.stringify({ writerProblems: mail.writerProblems || null, writerError: mail.writerError || null }), ctx.runId || null,
      sample ? 'pending' : null, sample ? JSON.stringify(sample) : null]);
  if (!ins.rowCount) return null;
  await pool.query(`INSERT INTO sales_emails (id, prospect_id, step, subject, body_text, state, written_by) VALUES ($1,$2,1,$3,$4,'draft',$5)`,
    [newId('se'), id, mail.subject, mail.body, mail.by]);
  return { id, lane: p.lane, org: p.org, person: p.person, title: p.title, email: p.email, state: p.state, tz: p.tz,
    verify: found.verify, foundBy: found.how, subject: mail.subject, body: mail.body, writtenBy: mail.by,
    sample: sample ? { athlete: sample.athlete, status: 'pending' } : null };
}

function skipper(out) { return (why) => { const k = String(why || 'unknown').replace(/ \(.*\)$/, ''); out.skipped[k] = (out.skipped[k] || 0) + 1; }; }

async function laneAgencies(pool, want, ctx, cursors) {
  const out = { lane: 'agency', want, drafted: [], skipped: {}, searches: 0, budgetOut: false, held: 0, fromList: 0 };
  if (want <= 0) return out;
  const skip = skipper(out);
  if (require('./salesSample').ON()) {
    await laneFromList(pool, want, ctx, out, skip);
    if (out.drafted.length >= want || out.budgetOut) return out;
  }
  const start = cursors.agency || 0;
  const slices = F.agencySlices(start, Math.max(6, want));
  const enough = () => out.drafted.length + out.held >= want || out.budgetOut;
  await eachLimit(slices, 3, async (slice) => {
    if (enough()) return;
    out.searches++;
    cursors.agency = start + out.searches;
    let res = null;
    try { res = ctx.deps.research ? await ctx.deps.research('agency', slice) : await F.webJson(F.agencyPrompt(slice), 'sales.research', 5); }
    catch (e) { skip('the web search failed: ' + String(e.message || e).slice(0, 80)); return; }
    const firms = (res && Array.isArray(res.firms) ? res.firms : []).slice(0, 8);
    if (!firms.length) skip('a search found no firms');
    for (const firm of firms) {
      if (enough()) return;
      const domain = F.cleanDomain(firm && firm.domain);
      const name = String((firm && firm.firm) || '').trim();
      if (!name) { skip('no firm name'); continue; }
      const key = 'agency:' + (domain || lc(name));
      if (await tried(pool, key)) { skip('tried on an earlier night'); continue; }
      const blocked = ctx.ex.org(name, domain);
      if (blocked) { skip(blocked); await markTried(pool, key, 'agency', blocked); continue; }
      const cand = { lane: 'agency', org: name, domain, person: firm.person || null, league: slice.league, state: firm.state || slice.state,
        city: firm.city || null, fact: firm.fact || null, source: firm.source || null };
      const r = await F.findPerson(cand, ctx);
      if (r.skip) {
        skip(r.skip);
        if (r.budget) { out.budgetOut = true; return; }
        if (!r.notRun) await markTried(pool, key, 'agency', r.skip);
        continue;
      }
      // A slot is held before the first await, so parallel workers never
      // draft past the lane's number.
      if (enough()) return;
      out.held++;
      ctx.ex.claim(r.email, domain);
      try {
        await markTried(pool, key, 'agency', 'drafted');
        const saved = await saveProspect(pool, cand, r, ctx);
        if (saved) out.drafted.push(saved);
      } finally { out.held--; }
    }
  }, enough);
  return out;
}

// The agency list first (services/salesSample): agencies with college
// clients on record, so the email can bring a sample for one of them.
async function laneFromList(pool, want, ctx, out, skip) {
  const SS = require('./salesSample');
  const rows = await SS.nextAgencies(pool, Math.max(want * 3, 6));
  const enough = () => out.drafted.length + out.held >= want || out.budgetOut;
  await eachLimit(rows, 3, async (row) => {
    if (enough()) return;
    const key = 'pool:' + row.slug;
    if (await tried(pool, key)) { skip('tried on an earlier night'); await SS.markUsed(pool, row.slug, 'tried before'); return; }
    const pre = ctx.ex.org(row.agency, null);
    if (pre) { skip(pre); await SS.markUsed(pool, row.slug, pre); await markTried(pool, key, 'agency', pre); return; }
    out.searches++;
    let res = null;
    try { res = ctx.deps.research ? await ctx.deps.research('pool', row) : await F.webJson(F.poolPrompt(row), 'sales.research', 3); }
    catch (e) { skip('the web search failed: ' + String(e.message || e).slice(0, 80)); return; }
    const domain = F.cleanDomain(res && res.domain);
    if (!domain) { skip('no website found for the agency'); await SS.markUsed(pool, row.slug, 'no website'); await markTried(pool, key, 'agency', 'no website'); return; }
    const blocked = ctx.ex.org(row.agency, domain);
    if (blocked) { skip(blocked); await SS.markUsed(pool, row.slug, blocked); await markTried(pool, key, 'agency', blocked); return; }
    const agents = (row.agents || []).map((a) => String(a));
    const named = res && res.person && res.person.name && agents.find((a) => lc(a) === lc(res.person.name));
    const person = { name: named || agents[0], title: (named && res.person.title) || 'Agent' };
    const client = SS.pickClient(row.players);
    const cand = { lane: 'agency', org: row.agency, domain, person, league: 'NFL', state: (res && res.state) || null, city: (res && res.city) || null,
      fact: null, source: 'scoutszn:' + row.slug, sample: client ? { athlete: client, slug: row.slug } : null };
    const r = await F.findPerson(cand, ctx);
    if (r.skip) {
      skip(r.skip);
      if (r.budget) { out.budgetOut = true; return; }
      if (!r.notRun) { await markTried(pool, key, 'agency', r.skip); await SS.markUsed(pool, row.slug, r.skip); }
      return;
    }
    // The email names their client, so it goes only to an agent the list
    // names: never to whoever Domain Search turned up at a domain the web
    // search may have got wrong.
    if (r.how === 'Hunter Domain Search' || !agents.some((a) => lc(a) === lc(r.person))) {
      const why = 'not one of the agents on record for the agency';
      skip(why); await markTried(pool, key, 'agency', why); await SS.markUsed(pool, row.slug, why);
      return;
    }
    if (enough()) return;
    out.held++;
    ctx.ex.claim(r.email, domain);
    try {
      await markTried(pool, key, 'agency', 'drafted');
      await markTried(pool, 'agency:' + domain, 'agency', 'drafted');
      await SS.markUsed(pool, row.slug, 'drafted');
      const saved = await saveProspect(pool, cand, r, ctx);
      if (saved) { out.drafted.push(saved); out.fromList++; }
    } finally { out.held--; }
  }, enough);
}

async function laneSchools(pool, want, ctx, cursors) {
  const out = { lane: 'school', want, drafted: [], skipped: {}, searches: 0, budgetOut: false, held: 0 };
  if (want <= 0) return out;
  const skip = skipper(out);
  const all = F.schoolList();
  const start = (cursors.school || 0) % all.length;
  const order = all.slice(start).concat(all.slice(0, start));
  const picks = [];
  const triedSet = new Set((await pool.query(`SELECT key FROM sales_tried WHERE lane = 'school' AND tried_at > NOW() - INTERVAL '180 days'`)).rows.map((r) => r.key));
  for (const s of order) {
    if (picks.length >= Math.min(60, want * 4)) break;
    if (triedSet.has('school:' + lc(s.name))) continue;
    const blocked = ctx.ex.school(s.name);
    if (blocked) { skip(blocked); continue; }
    picks.push(s);
  }
  cursors.school = (start + Math.max(1, picks.length)) % all.length;
  const enough = () => out.drafted.length + out.held >= want || out.budgetOut;
  await eachLimit(picks, 5, async (s) => {
    if (enough()) return;
    const key = 'school:' + lc(s.name);
    out.searches++;
    let res = null;
    try { res = ctx.deps.research ? await ctx.deps.research('school', s) : await F.webJson(F.schoolPrompt(s), 'sales.research', 4); }
    catch (e) { skip('the web search failed: ' + String(e.message || e).slice(0, 80)); return; }
    if (!res || !res.person || !res.person.name) { skip('no NIL director or coordinator found'); await markTried(pool, key, 'school', 'no NIL person found'); return; }
    const domain = F.cleanDomain(res.emailDomain || (res.email && String(res.email).split('@')[1]));
    const blocked = ctx.ex.org(s.name, domain);
    if (blocked) { skip(blocked); await markTried(pool, key, 'school', blocked); return; }
    const cand = { lane: 'school', org: s.name, domain, person: res.person, email: res.email || null, level: s.level,
      state: s.state || res.state || null, city: s.city || null, fact: res.fact || null, source: res.source || null };
    const r = await F.findPerson(cand, ctx);
    if (r.skip) {
      skip(r.skip);
      if (r.budget) { out.budgetOut = true; return; }
      if (!r.notRun) await markTried(pool, key, 'school', r.skip);
      return;
    }
    if (enough()) return;
    out.held++;
    ctx.ex.claim(r.email, domain);
    try {
      await markTried(pool, key, 'school', 'drafted');
      const saved = await saveProspect(pool, cand, r, ctx);
      if (saved) out.drafted.push(saved);
    } finally { out.held--; }
  }, enough);
  return out;
}

let _running = false;
// runOnce(pool, { trigger, now, want, deps }) -> { ok, runId, drafted, lanes, note }
// trigger 'schedule' (the weekday night) drafts only while fewer than
// SALES_MAX_QUEUE first emails wait; 'dry-run' (the admin script) drafts the
// full SALES_DAILY_NEW. Neither sends anything.
async function runOnce(pool, { trigger = 'manual', now, want, deps = {} } = {}) {
  await ensureTables(pool);
  if (_running) return { ok: false, error: 'a run is already going' };
  _running = true;
  const date = centralDay(now).date;
  const runId = (await pool.query(`INSERT INTO sales_runs (run_date, trigger, dry) VALUES ($1, $2, $3) RETURNING id`, [date, trigger, !SEND_ON()])).rows[0].id;
  try {
    const waiting = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM sales_emails e JOIN sales_prospects p ON p.id = e.prospect_id
        WHERE e.step = 1 AND e.state IN ('draft', 'scheduled') AND p.status = 'drafted'`)).rows[0].n;
    let target = Number.isFinite(want) ? want : DAILY_NEW();
    let held = 0;
    if (trigger === 'schedule') { const room = Math.max(0, MAX_QUEUE() - waiting); held = Math.max(0, target - room); target = Math.min(target, room); }
    const perLane = { agency: Math.ceil(target / 2), school: Math.floor(target / 2) };
    const state = await getState(pool);
    const cursors = { ...state.cursors };
    const ctx = { hunter: deps.hunter || F.liveHunter(pool, { day: date }), ex: await F.exclusions(pool),
      credits: { used: 0, max: Number.isFinite(deps.hunterMax) ? deps.hunterMax : HUNTER_MAX() }, deps, runId, date };
    const [a, b] = await Promise.all([laneAgencies(pool, perLane.agency, ctx, cursors), laneSchools(pool, perLane.school, ctx, cursors)]);
    await saveCursors(pool, cursors);
    const drafted = a.drafted.length + b.drafted.length;
    const lanes = { agency: a, school: b };
    const short = (l) => (l.drafted.length < l.want ? ` (${l.want - l.drafted.length} short${l.budgetOut ? ', Hunter credits for sales ran out' : ''})` : '');
    const note = `Drafted ${drafted} of ${target}: ${a.drafted.length} agencies${short(a)}, ${b.drafted.length} schools${short(b)}. `
      + `${ctx.credits.used} Hunter credit(s), ${a.searches + b.searches} web search(es).`
      + (held ? ` ${held} not drafted: ${waiting} first emails already wait (SALES_MAX_QUEUE ${MAX_QUEUE()}).` : '')
      + (SEND_ON() ? '' : ' Dry run: SALES_AUTOSEND_ON is off, nothing is sent.');
    const detail = { lanes: Object.fromEntries(Object.entries(lanes).map(([k, l]) => [k, { want: l.want, drafted: l.drafted.map((d) => d.id), skipped: l.skipped, searches: l.searches, budgetOut: l.budgetOut }])),
      credits: ctx.credits.used, waiting, held };
    await pool.query(`UPDATE sales_runs SET finished_at = NOW(), drafted = $2, credits = $3, note = $4, detail = $5 WHERE id = $1`,
      [runId, drafted, ctx.credits.used, note, JSON.stringify(detail)]);
    return { ok: true, runId, drafted, target, lanes, note, prospects: a.drafted.concat(b.drafted) };
  } catch (e) {
    await pool.query(`UPDATE sales_runs SET finished_at = NOW(), note = $2 WHERE id = $1`, [runId, 'The run failed: ' + String(e.message || e).slice(0, 300)]).catch(() => {});
    require('./ourFault').record('sales-autopilot', String(e.message || e).slice(0, 300), 'salesAutopilot.runOnce');
    return { ok: false, runId, error: e.message };
  } finally {
    _running = false;
  }
}

// ── THE DAY'S PLAN ──────────────────────────────────────────────────────────
// Which emails go today and when. Follow-ups that are due first (they count
// toward the cap), then first emails, the two lanes taken in turn. Each gets
// a random minute between 9am and 4pm in the prospect's time zone, at least
// 4 minutes from every other send today, and no domain gets more than 2.
// save=false is the preview (the dry run's "day 1" report): nothing written.
async function planDay(pool, { now, save = true, deps = {}, date } = {}) {
  await ensureTables(pool);
  const at = now ? new Date(now) : new Date();
  const today = date || centralDay(at).date;
  const dayParts = partsIn(today + 'T18:00:00Z', 'UTC');
  if (weekend(dayParts)) return { ok: false, date: today, why: 'a weekend: nothing is sent on Saturday or Sunday', planned: [] };
  const w = await warmup(pool, today);
  const rnd = deps.random || Math.random;
  if (save) {
    // Anything planned for an earlier day and never sent is planned again.
    await pool.query(`UPDATE sales_emails SET state = 'draft', plan_date = NULL, planned_for = NULL WHERE state = 'scheduled' AND plan_date < $1::date`, [today]);
    const already = (await pool.query(`SELECT COUNT(*)::int AS n FROM sales_emails WHERE plan_date = $1::date AND state IN ('scheduled', 'sending', 'sent')`, [today])).rows[0].n;
    if (already) return { ok: true, date: today, already: true, warmup: w, planned: [] };
  }
  // What today already holds: sent, sending, scheduled.
  const fixed = (await pool.query(
    `SELECT e.sent_at, e.planned_for, p.domain, p.email FROM sales_emails e JOIN sales_prospects p ON p.id = e.prospect_id
      WHERE (e.state IN ('sent', 'sending') AND (e.sent_at AT TIME ZONE '${CENTRAL}')::date = $1::date)
         OR (e.state = 'scheduled' AND e.plan_date = $1::date)`, [today])).rows;
  const times = fixed.map((r) => new Date(r.sent_at || r.planned_for).getTime());
  const perDomain = {};
  for (const r of fixed) { const d = lc(r.domain || r.email.split('@')[1]); perDomain[d] = (perDomain[d] || 0) + 1; }
  let room = Math.max(0, w.cap - fixed.length);
  const planned = [], notToday = [];
  const nowMs = at.getTime();
  const verifiedSince = new Date(zonedTime(today, WINDOW_TO, CENTRAL).getTime() - VERIFY_MAX_DAYS * 86400000);

  const place = (p) => {
    const tz = p.tz || F.tzFor(p.state);
    const start = zonedTime(today, WINDOW_FROM, tz).getTime();
    const end = zonedTime(today, WINDOW_TO, tz).getTime();
    const from = Math.max(start, nowMs + 5 * 60000);
    if (from >= end) return null;
    for (let i = 0; i < 60; i++) {
      const t = Math.floor((from + rnd() * (end - from)) / 60000) * 60000;
      if (times.every((x) => Math.abs(x - t) >= MIN_GAP_MS)) return t;
    }
    return null;
  };
  const take = async (cand) => {
    const d = lc(cand.domain || cand.email.split('@')[1]);
    if ((perDomain[d] || 0) >= DOMAIN_PER_DAY) { notToday.push({ ...cand, why: `2 emails to ${d} already today` }); return false; }
    const t = place(cand);
    if (t === null) { notToday.push({ ...cand, why: 'no free time left in their 9 to 4 window today' }); return false; }
    times.push(t); perDomain[d] = (perDomain[d] || 0) + 1; room--;
    const row = { ...cand, at: new Date(t).toISOString(), local: fmtLocal(t, cand.tz || F.tzFor(cand.state)), central: fmtLocal(t, CENTRAL) };
    planned.push(row);
    return true;
  };

  // 1. Follow-ups that are due today.
  const live = (await pool.query(
    `SELECT p.*, ((p.first_sent_at AT TIME ZONE '${CENTRAL}')::date)::text AS first_day,
            (SELECT MAX(step) FROM sales_emails e WHERE e.prospect_id = p.id AND e.state = 'sent') AS last_step,
            (SELECT subject FROM sales_emails e WHERE e.prospect_id = p.id AND e.step = 1) AS first_subject
       FROM sales_prospects p WHERE p.status = 'active' AND p.first_sent_at IS NOT NULL ORDER BY p.first_sent_at`)).rows;
  for (const p of live) {
    if (room <= 0) break;
    const step = Number(p.last_step || 0) + 1;
    if (!FOLLOW_UP_AFTER[step]) continue;
    const firstDay = String(p.first_day).slice(0, 10);
    if (addDays(firstDay, FOLLOW_UP_AFTER[step]) > today) continue;
    if ((await pool.query(`SELECT 1 FROM sales_emails WHERE prospect_id = $1 AND (state IN ('sent','sending') AND (sent_at AT TIME ZONE '${CENTRAL}')::date = $2::date)`, [p.id, today])).rowCount) continue;
    const fu = W.followUp(p, step, writerCtx());
    const cand = { prospectId: p.id, step, lane: p.lane, person: p.person, org: p.org, email: p.email, domain: p.domain, state: p.state, tz: p.tz,
      subject: 'Re: ' + String(p.first_subject || '').replace(/^re:\s*/i, ''), body: fu.body };
    if (await take(cand) && save) {
      const t = planned[planned.length - 1].at;
      await pool.query(
        `INSERT INTO sales_emails (id, prospect_id, step, subject, body_text, state, plan_date, planned_for, written_by)
         VALUES ($1,$2,$3,$4,$5,'scheduled',$6,$7,'template')
         ON CONFLICT (prospect_id, step) DO UPDATE SET state = 'scheduled', plan_date = EXCLUDED.plan_date, planned_for = EXCLUDED.planned_for
           WHERE sales_emails.state IN ('draft', 'failed')`, [newId('se'), p.id, step, cand.subject, fu.body, today, t]);
    }
  }
  // 2. First emails, oldest first, lanes in turn, verified in the last 30 days.
  const drafts = (await pool.query(
    `SELECT e.id AS email_id, e.subject, e.body_text, p.* FROM sales_emails e JOIN sales_prospects p ON p.id = e.prospect_id
      WHERE e.step = 1 AND e.state = 'draft' AND p.status = 'drafted' AND p.verified_at >= $1
        AND (p.sample_status IS NULL OR p.sample_status <> 'building')
        AND (p.sample_status IS NULL OR p.sample_status <> 'pending' OR NOT $2)
      ORDER BY e.created_at, e.id`, [verifiedSince, require('./salesSample').ON()])).rows;
  const byLane = { agency: drafts.filter((d) => d.lane === 'agency'), school: drafts.filter((d) => d.lane !== 'agency') };
  const turn = [];
  for (let i = 0; i < Math.max(byLane.agency.length, byLane.school.length); i++) {
    if (byLane.agency[i]) turn.push(byLane.agency[i]);
    if (byLane.school[i]) turn.push(byLane.school[i]);
  }
  for (const d of turn) {
    if (room <= 0) break;
    const cand = { emailId: d.email_id, prospectId: d.id, step: 1, lane: d.lane, person: d.person, org: d.org, email: d.email, domain: d.domain,
      state: d.state, tz: d.tz, subject: d.subject, body: d.body_text, verifiedAt: d.verified_at };
    if (await take(cand) && save) {
      await pool.query(`UPDATE sales_emails SET state = 'scheduled', plan_date = $2, planned_for = $3 WHERE id = $1 AND state = 'draft'`,
        [d.email_id, today, planned[planned.length - 1].at]);
    }
  }
  planned.sort((x, y) => x.at.localeCompare(y.at));
  return { ok: true, date: today, warmup: w, planned, notToday, waiting: drafts.length - planned.filter((x) => x.step === 1).length };
}

// ── STOPS ───────────────────────────────────────────────────────────────────
// A sequence ends: nothing more goes to this person.
async function stopProspect(pool, prospectId, status, reason, extra = {}) {
  const r = await pool.query(
    `UPDATE sales_prospects SET status = $2, stop_reason = $3, tag = COALESCE($4, tag), replied_at = COALESCE($5, replied_at), updated_at = NOW()
      WHERE id = $1 AND status IN ('drafted', 'active') RETURNING id`,
    [prospectId, status, String(reason || status).slice(0, 300), extra.tag || null, extra.repliedAt || null]);
  await pool.query(`UPDATE sales_emails SET state = 'cancelled', error = $2 WHERE prospect_id = $1 AND state IN ('draft', 'scheduled')`,
    [prospectId, 'sequence stopped: ' + String(reason || status).slice(0, 200)]);
  return r.rowCount > 0;
}
async function event(pool, { prospectId, kind, tag, messageId, detail }) {
  const r = await pool.query(
    `INSERT INTO sales_events (prospect_id, kind, tag, message_id, detail) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (message_id, kind) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
    [prospectId || null, kind, tag || null, messageId || null, detail ? JSON.stringify(detail) : null]);
  return r.rowCount > 0;
}

// An address was suppressed anywhere (the unsubscribe link, a bounce, by
// hand): its sequence stops now. Called by POST /unsubscribe as it happens,
// and by every reply scan for anything suppressed another way.
async function onSuppressed(pool, email) {
  await ensureTables(pool);
  const p = (await pool.query(`SELECT id FROM sales_prospects WHERE email = $1 AND status IN ('drafted', 'active')`, [lc(email)])).rows[0];
  if (!p) return false;
  const sup = await require('./suppression').isSuppressed(pool, email);
  const kind = sup && sup.kind === 'bounce' ? 'bounced' : 'unsubscribed';
  await event(pool, { prospectId: p.id, kind: kind === 'bounced' ? 'bounce' : 'unsubscribe', detail: { via: 'suppression list', reason: sup && sup.reason } });
  return stopProspect(pool, p.id, kind, kind === 'bounced' ? 'bounced' : 'unsubscribed (the link in the email)');
}
async function syncStops(pool) {
  await ensureTables(pool);
  let n = 0;
  const sup = (await pool.query(`SELECT p.id, p.email FROM sales_prospects p JOIN email_suppression s ON s.email = p.email WHERE p.status IN ('drafted', 'active')`).catch(() => ({ rows: [] }))).rows;
  for (const r of sup) if (await onSuppressed(pool, r.email)) n++;
  // Signed up (a trial, or any account): no more sales email.
  const signed = (await pool.query(`SELECT p.id, u.id AS user_id FROM sales_prospects p JOIN users u ON LOWER(u.email) = p.email WHERE p.status IN ('drafted', 'active')`).catch(() => ({ rows: [] }))).rows;
  for (const r of signed) {
    await event(pool, { prospectId: r.id, kind: 'trial', detail: { userId: r.user_id } });
    if (await stopProspect(pool, r.id, 'trial', 'signed up for NILDash')) n++;
  }
  return n;
}

// ── THE HARD STOP ─────────────────────────────────────────────────────────
async function pause(pool, reason, deps = {}) {
  await ensureTables(pool);
  const r = await pool.query(`UPDATE sales_state SET paused = TRUE, paused_reason = $1, paused_at = NOW(), updated_at = NOW() WHERE id = 1 AND paused = FALSE RETURNING id`,
    [String(reason).slice(0, 500)]);
  if (!r.rowCount) return { paused: true, already: true };
  console.error('[sales-autopilot] STOPPED: ' + reason);
  const msg = {
    subject: `Sales autopilot stopped: ${String(reason).slice(0, 90)}`,
    text: [`The sales autopilot stopped sending from ${MB.fromAddress()} and will stay stopped until you turn it back on.`, '',
      `Why: ${reason}`, '',
      'Nothing else goes out from it. Replies are still read and sorted into the NILDash Prospects folder.', '',
      'Numbers for the last 7 days: /api/admin/scripts/sales-autopilot?text=1&days=7',
      'To turn it back on: /api/admin/scripts/sales-autopilot?resume=1&text=1'].join('\n'),
  };
  try { await (deps.alert || alert)(msg); } catch (e) { console.error('[sales-autopilot] could not email the stop: ' + e.message); }
  return { paused: true };
}
async function resume(pool) {
  await ensureTables(pool);
  const r = await pool.query(`UPDATE sales_state SET paused = FALSE, paused_reason = NULL, resumed_at = NOW(), updated_at = NOW() WHERE id = 1 RETURNING resumed_at`);
  return { resumed: r.rowCount > 0 };
}
// Bounces over 2% of the last 7 days' sends: stop.
async function bounceCheck(pool, deps = {}) {
  const s = (await pool.query(`SELECT COUNT(*)::int AS n FROM sales_emails WHERE sent_at > NOW() - INTERVAL '${BOUNCE_DAYS} days'`)).rows[0].n;
  const b = (await pool.query(`SELECT COUNT(*)::int AS n FROM sales_events WHERE kind = 'bounce' AND at > NOW() - INTERVAL '${BOUNCE_DAYS} days'`)).rows[0].n;
  if (s > 0 && b / s > BOUNCE_LIMIT) {
    return pause(pool, `bounces are ${b} of ${s} sends in the last ${BOUNCE_DAYS} days (${(100 * b / s).toFixed(1)}%), over 2%`, deps);
  }
  return { paused: false, sent: s, bounces: b };
}

// The admin email: Resend, to JohnMark (SALES_ALERT_TO, else the admin alert
// address). Never from his own mailbox: a stop may be about that mailbox.
function alertTo() { return String(process.env.SALES_ALERT_TO || process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL || '').trim(); }
async function alert(msg) {
  const to = alertTo();
  if (!to) throw new Error('no alert destination: set SALES_ALERT_TO, ADMIN_ALERT_EMAIL or ADMIN_EMAIL');
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const from = process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>';
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const r = await resend.emails.send({ from, to, subject: msg.subject, text: msg.text,
    html: `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(msg.text)}</pre>` });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// ── SENDING ─────────────────────────────────────────────────────────────────
// One tick, every minute while SALES_AUTOSEND_ON: the earliest email whose
// time has come, if the last send was 4 minutes ago or more. Everything is
// checked again at the moment of sending.
async function sendTick(pool, { now, deps = {} } = {}) {
  await ensureTables(pool);
  if (!SEND_ON() && !deps.force) return { skipped: 'SALES_AUTOSEND_ON is off' };
  const st = await getState(pool);
  if (st.paused) return { skipped: 'stopped: ' + st.paused_reason };
  const at = now ? new Date(now) : new Date();
  if (weekend(centralDay(at))) return { skipped: 'a weekend' };
  const last = (await pool.query(`SELECT MAX(sent_at) AS t FROM sales_emails`)).rows[0].t;
  if (last && at.getTime() - new Date(last).getTime() < MIN_GAP_MS) return { skipped: 'less than 4 minutes since the last send' };
  // A claim that never finished (a crash mid-send) is not sent again: it may
  // have left. It is marked and reported.
  await pool.query(`UPDATE sales_emails SET state = 'unknown', error = 'the send was interrupted; not retried in case it went' WHERE state = 'sending' AND claimed_at < $1`,
    [new Date(at.getTime() - 15 * 60000)]);
  const claim = await pool.query(
    `UPDATE sales_emails SET state = 'sending', claimed_at = $1 WHERE id = (
       SELECT id FROM sales_emails WHERE state = 'scheduled' AND planned_for <= $1 ORDER BY planned_for, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [at]);
  if (!claim.rowCount) return { skipped: 'nothing due' };
  return sendOne(pool, claim.rows[0], { now: at, deps });
}

async function sendOne(pool, e, { now, deps = {} } = {}) {
  const at = now ? new Date(now) : new Date();
  const p = (await pool.query(`SELECT * FROM sales_prospects WHERE id = $1`, [e.prospect_id])).rows[0];
  const giveBack = async (why) => {
    await pool.query(`UPDATE sales_emails SET state = 'draft', plan_date = NULL, planned_for = NULL, claimed_at = NULL, error = $2 WHERE id = $1`, [e.id, why]);
    return { ok: false, held: true, why };
  };
  const cancel = async (why) => {
    await pool.query(`UPDATE sales_emails SET state = 'cancelled', error = $2 WHERE id = $1`, [e.id, String(why).slice(0, 300)]);
    return { ok: false, cancelled: true, why };
  };
  if (!p) return cancel('the prospect is gone');
  if (!LIVE.includes(p.status)) return cancel('sequence stopped: ' + p.status);
  // Their window, today, a weekday where they are.
  const tz = p.tz || F.tzFor(p.state);
  const local = partsIn(at, tz);
  if (weekend(local) || local.minutes < WINDOW_FROM || local.minutes >= WINDOW_TO) return giveBack(`outside 9 to 4 on a weekday in ${tz}`);
  if (!p.verified_at || at.getTime() - new Date(p.verified_at).getTime() > VERIFY_MAX_DAYS * 86400000) {
    await stopProspect(pool, p.id, 'stopped', 'the verification is more than 30 days old');
    return cancel('the verification is more than 30 days old');
  }
  // The caps, counted again now.
  const today = centralDay(at).date;
  const w = await warmup(pool, today);
  const sentToday = (await pool.query(`SELECT COUNT(*)::int AS n FROM sales_emails WHERE state IN ('sent') AND (sent_at AT TIME ZONE '${CENTRAL}')::date = $1::date`, [today])).rows[0].n;
  if (sentToday >= w.cap) return giveBack(`today's cap of ${w.cap} is reached`);
  const dom = lc(p.domain || p.email.split('@')[1]);
  const domToday = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM sales_emails e JOIN sales_prospects q ON q.id = e.prospect_id
      WHERE e.state = 'sent' AND (e.sent_at AT TIME ZONE '${CENTRAL}')::date = $1::date AND LOWER(COALESCE(q.domain, split_part(q.email, '@', 2))) = $2`, [today, dom])).rows[0].n;
  if (domToday >= DOMAIN_PER_DAY) return giveBack(`2 emails to ${dom} already today`);
  // Suppression and the shared send rules, as every sender does.
  const sendRules = require('./sendRules');
  const refId = 'sales:' + p.id;
  const rule = await sendRules.check(pool, { email: p.email, subject: e.subject, system: SYSTEM, refId, now: at });
  if (!rule.ok) {
    if (rule.kind === 'suppressed') { await onSuppressed(pool, p.email); return cancel('not sent: ' + rule.reason); }
    if (rule.kind === 'window') return giveBack('not yet: ' + rule.reason);
    await stopProspect(pool, p.id, 'stopped', rule.reason);
    return cancel('not sent: ' + rule.reason);
  }
  // The text: the email, then the CAN-SPAM footer. Plain, one link, nothing added.
  let body = String(e.body_text || '').replace(/\s+$/, '');
  // Written while SALES_TRIAL_ON said otherwise (a dry run before the trial
  // went on, or the trial turned off since): a first email that would
  // promise the wrong thing goes as today's template instead.
  if (e.step === 1 && /14-day trial/i.test(body) !== TRIAL_ON()) {
    body = firstEmailFor(p).body;
    await pool.query(`UPDATE sales_emails SET body_text = $2, written_by = $3 WHERE id = $1`, [e.id, body, p.sample_status === 'ready' ? 'sample' : 'template']);
  }
  const problems = W.checkEmail({ subject: e.step === 1 ? e.subject : 'x', body }, p, e.step === 1 ? ctxFor(p) : writerCtx(), e.step);
  if (problems.length) return cancel('the email fails its checks: ' + problems.join('; '));
  const text = require('./canSpam').appendText(body, p.email, { why: footerWhy(p.lane) });
  const mb = deps.mailbox || await MB.account(pool);
  if (!mb.ok || !mb.canSend) {
    await giveBack('the sending mailbox is not connected');
    await pause(pool, mb.why || `${MB.fromAddress()} cannot send (not connected, or Mail.Send was not granted)`, deps);
    return { ok: false, why: 'mailbox' };
  }
  const gdeps = deps.graph ? { graph: deps.graph } : {};
  try {
    let res;
    if (e.step === 1) {
      res = await MB.sendNew(mb, { to: p.email, subject: e.subject, text }, gdeps);
    } else {
      // In the same thread, or not at all.
      let root = p.root_message_id;
      if (!root) {
        const first = (await pool.query(`SELECT subject, sent_at FROM sales_emails WHERE prospect_id = $1 AND step = 1`, [p.id])).rows[0];
        const found = first ? await MB.findSent(mb, { to: p.email, subject: first.subject, since: new Date(new Date(first.sent_at).getTime() - 3600000) }, gdeps).catch(() => null) : null;
        if (found && found.messageId) {
          root = found.messageId;
          await pool.query(`UPDATE sales_prospects SET root_message_id = $2, conversation_id = COALESCE(conversation_id, $3) WHERE id = $1`, [p.id, root, found.conversationId]);
        }
      }
      if (!root) {
        await stopProspect(pool, p.id, 'stopped', 'the first email could not be found in Sent Items, so no follow-up (they go in the thread or not at all)');
        return cancel('the first email could not be found in Sent Items');
      }
      res = await MB.reply(mb, { messageId: root, to: p.email, text }, gdeps);
    }
    await pool.query(`UPDATE sales_emails SET state = 'sent', sent_at = $2, claimed_at = NULL, error = NULL, message_id = $3, conversation_id = $4 WHERE id = $1`,
      [e.id, at, (res && res.messageId) || null, (res && res.conversationId) || null]);
    await pool.query(
      `UPDATE sales_prospects SET status = CASE WHEN status = 'drafted' THEN 'active' ELSE status END,
         first_sent_at = COALESCE(first_sent_at, $2), last_sent_at = $2,
         root_message_id = COALESCE(root_message_id, $3), conversation_id = COALESCE(conversation_id, $4), updated_at = NOW() WHERE id = $1`,
      [p.id, at, e.step === 1 ? (res && res.messageId) || null : null, e.step === 1 ? (res && res.conversationId) || null : null]);
    await sendRules.record(pool, { email: p.email, subject: e.subject, system: SYSTEM, agentId: 'nildash-sales', refId, now: at });
    return { ok: true, id: e.id, step: e.step, to: p.email };
  } catch (err) {
    if (MB.isSendLimit(err)) {
      await giveBack('Microsoft limited sending: ' + err.message);
      await event(pool, { prospectId: p.id, kind: 'send_limit', detail: { error: String(err.message).slice(0, 300) } });
      await pause(pool, `Microsoft limited sending from ${MB.fromAddress()}: ${String(err.message).slice(0, 200)}`, deps);
      return { ok: false, why: 'send limit', error: err.message };
    }
    await pool.query(`UPDATE sales_emails SET state = 'failed', claimed_at = NULL, error = $2 WHERE id = $1`, [e.id, 'send failed: ' + String(err.message).slice(0, 280)]);
    require('./ourFault').record('sales-autopilot', 'send failed: ' + String(err.message).slice(0, 280), 'salesAutopilot.sendOne');
    return { ok: false, why: 'send failed', error: err.message };
  }
}

// ── THE NUMBERS (the 5:30 email and the admin script) ───────────────────────
// For Central dates from..to inclusive.
async function numbers(pool, from, to) {
  await ensureTables(pool);
  const day = (col) => `(${col} AT TIME ZONE '${CENTRAL}')::date BETWEEN $1::date AND $2::date`;
  const one = async (sql) => (await pool.query(sql, [from, to])).rows[0];
  const sends = await one(`SELECT COUNT(*) FILTER (WHERE step = 1)::int AS first, COUNT(*) FILTER (WHERE step > 1)::int AS followups FROM sales_emails WHERE sent_at IS NOT NULL AND ${day('sent_at')}`);
  const ev = await one(`SELECT COUNT(*) FILTER (WHERE kind = 'reply')::int AS replies,
      COUNT(*) FILTER (WHERE kind = 'reply' AND tag = 'interested')::int AS interested,
      COUNT(*) FILTER (WHERE kind = 'reply' AND tag = 'not now')::int AS not_now,
      COUNT(*) FILTER (WHERE kind = 'reply' AND tag = 'wrong person')::int AS wrong_person,
      COUNT(*) FILTER (WHERE (kind = 'reply' AND tag = 'unsubscribe') OR kind = 'unsubscribe')::int AS unsubscribes,
      COUNT(*) FILTER (WHERE kind = 'bounce')::int AS bounces,
      COUNT(*) FILTER (WHERE kind = 'complaint')::int AS complaints,
      COUNT(*) FILTER (WHERE kind = 'booked')::int AS booked
    FROM sales_events WHERE ${day('at')}`);
  // A trial counts once Stripe has it (the checkout finished).
  const trials = await one(`SELECT COUNT(*)::int AS n FROM sales_trials t JOIN users u ON u.id = t.user_id
      WHERE ${day('t.created_at')} AND (u.stripe_subscription_id IS NOT NULL OR u.subscription_status IN ('trialing', 'active'))`);
  const drafted = await one(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE lane = 'agency')::int AS agencies, COUNT(*) FILTER (WHERE lane = 'school')::int AS schools FROM sales_prospects WHERE ${day('created_at')}`);
  return { from, to, sent: sends.first + sends.followups, firstEmails: sends.first, followups: sends.followups, ...ev,
    trials: trials.n, drafted: drafted.n, draftedAgencies: drafted.agencies, draftedSchools: drafted.schools };
}

// The 5:30 section: yesterday's numbers and today's warm-up level.
async function morningSection(pool, { now } = {}) {
  await ensureTables(pool);
  const today = centralDay(now).date;
  const y = addDays(today, -1);
  const n = await numbers(pool, y, y);
  const w = await warmup(pool, today);
  const st = await getState(pool);
  const mode = !ON() ? 'off' : SEND_ON() ? 'sending' : 'dry run (SALES_AUTOSEND_ON is off)';
  const lines = [
    `SALES AUTOPILOT (${y}): ${mode}${st.paused ? `. STOPPED since ${String(st.paused_at && new Date(st.paused_at).toISOString()).slice(0, 16)} UTC: ${st.paused_reason}` : ''}`,
    `  sent ${n.sent} (${n.firstEmails} first, ${n.followups} follow-up), replies ${n.replies}, interested ${n.interested}, trials started ${n.trials}, bounces ${n.bounces}`,
    `  warm-up: day ${w.day}, up to ${w.cap} sends today (cap ${w.dailyCap})`,
    `  drafted ${n.drafted} (${n.draftedAgencies} agencies, ${n.draftedSchools} schools)${n.unsubscribes ? `, unsubscribes ${n.unsubscribes}` : ''}${n.booked ? `, demos booked ${n.booked}` : ''}`,
    '  Details: /api/admin/scripts/sales-autopilot?text=1&days=7',
  ];
  return { lines, paused: !!st.paused, numbers: n, warmup: w };
}

// ── THE 14-DAY TRIAL (SALES_TRIAL_ON) ───────────────────────────────────────
// A signup that came through "Start 14-day trial" (?trial=14 on the signup
// link, from /try or the homepage) gets a 14-day Stripe trial: card at
// checkout, first charge on day 15. The plan is whatever the agent checkout
// sells (STRIPE_AGENT_PRICE_ID): PRICING_V2_ON is not on main yet, and when
// it lands in createAgentCheckoutSession this follows it.
const TRIAL_DAYS = 14;
function trialDaysFor(asked) { return TRIAL_ON() && String(asked == null ? '' : asked).trim() === String(TRIAL_DAYS) ? TRIAL_DAYS : 0; }
async function recordTrial(pool, user, source) {
  await ensureTables(pool);
  const p = (await pool.query(`SELECT id FROM sales_prospects WHERE email = $1`, [lc(user.email)])).rows[0];
  await pool.query(`INSERT INTO sales_trials (user_id, email, source, prospect_id) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING`,
    [user.id, lc(user.email), source || 'signup', p ? p.id : null]);
  if (p) {
    await event(pool, { prospectId: p.id, kind: 'trial', detail: { userId: user.id } });
    await stopProspect(pool, p.id, 'trial', 'started a 14-day trial');
  }
}

// /try: book 15 minutes, or start the trial. One page, no tracking.
async function bookingUrl(pool) {
  const env = String(process.env.SALES_BOOKING_URL || '').trim();
  if (/^https:\/\//.test(env)) return env;
  const admin = lc(process.env.ADMIN_EMAIL || 'johnmarkcompton@gmail.com');
  const u = (await pool.query(`SELECT scheduling_url FROM users WHERE LOWER(email) = $1`, [admin]).catch(() => ({ rows: [] }))).rows[0];
  return u && /^https:\/\//.test(String(u.scheduling_url || '')) ? u.scheduling_url : null;
}
async function tryPage(pool) {
  const fs = require('fs');
  const path = require('path');
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const book = await bookingUrl(pool);
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'try.html'), 'utf8');
  const bookBtn = book
    ? `<a class="btn primary" href="${esc(book)}">Book 15 minutes with ${esc(senderName().split(/\s+/)[0])}</a>`
    : `<a class="btn primary" href="mailto:${esc(MB.fromAddress())}?subject=${encodeURIComponent('15 minutes on NILDash')}">Email ${esc(senderName().split(/\s+/)[0])} for 15 minutes</a>`;
  const trialBtn = TRIAL_ON()
    ? `<a class="btn ghost" href="/?signin=agent&amp;tab=signup&amp;trial=${TRIAL_DAYS}">Start 14-day trial</a><p class="fine">Card at signup. The first charge is on day 15; cancel before then and you pay nothing.</p>`
    : '';
  return html.replace('<!--BOOK-->', bookBtn).replace('<!--TRIAL-->', trialBtn);
}

// ── THE SCHEDULE ────────────────────────────────────────────────────────────
// Every 5 minutes: the weekday night run (from 4:00 Central, once), today's
// plan (from 7:00 Central, once, when sending), and the reply reader. Every
// minute: the send tick.
async function tick(pool, { now, deps = {} } = {}) {
  if (!ON()) return { skipped: 'SALES_AUTOPILOT_ON is off' };
  await ensureTables(pool);
  const c = centralDay(now);
  const out = {};
  if (!weekend(c) && c.minutes >= RUN_AT) {
    const done = (await pool.query(`SELECT 1 FROM sales_runs WHERE run_date = $1 AND trigger = 'schedule' LIMIT 1`, [c.date])).rowCount;
    if (!done) out.run = await runOnce(pool, { trigger: 'schedule', now, deps });
  }
  if (require('./salesSample').ON()) out.samples = await require('./salesSample').tick(pool, { now, deps }).catch((e) => ({ error: e.message }));
  if (SEND_ON() && !weekend(c) && c.minutes >= PLAN_AT && c.minutes < WINDOW_TO + 60) out.plan = await planDay(pool, { now, deps });
  out.replies = await require('./salesReplies').scan(pool, { now, deps }).catch((e) => ({ error: e.message }));
  return out;
}
let _timers = null;
function start(pool) {
  if (_timers) return;
  const slow = () => tick(pool).catch((e) => console.error('[sales-autopilot] tick:', e.message));
  const fast = () => (SEND_ON() ? sendTick(pool) : Promise.resolve()).catch((e) => console.error('[sales-autopilot] send:', e.message));
  _timers = [setInterval(slow, 5 * 60 * 1000), setInterval(fast, 60 * 1000)];
  for (const t of _timers) if (t.unref) t.unref();
  const boot = setTimeout(slow, 2 * 60 * 1000); if (boot.unref) boot.unref();
  console.log(`[sales-autopilot] ${ON() ? (SEND_ON() ? 'on, sending' : 'on, dry run (SALES_AUTOSEND_ON is off)') : 'off (SALES_AUTOPILOT_ON)'}`);
}

module.exports = {
  ON, SEND_ON, TRIAL_ON, DAILY_NEW, DAILY_CAP, HUNTER_MAX, MAX_QUEUE, SYSTEM, WARMUP_START, WARMUP_STEP, WINDOW_FROM, WINDOW_TO,
  MIN_GAP_MS, DOMAIN_PER_DAY, FOLLOW_UP_AFTER, BOUNCE_LIMIT, BOUNCE_DAYS, VERIFY_MAX_DAYS, RUN_AT, PLAN_AT, CENTRAL,
  ensureTables, getState, warmup, runOnce, planDay, sendTick, sendOne, stopProspect, event, onSuppressed, syncStops, pause, resume,
  bounceCheck, alert, alertTo, numbers, morningSection, tick, start, link, appUrl, senderName, writerCtx, footerWhy, ctxFor, firstEmailFor,
  trialDaysFor, recordTrial, tryPage, bookingUrl, TRIAL_DAYS,
  partsIn, centralDay, zonedTime, addDays, nextWeekday, fmtLocal, truthy,
};
