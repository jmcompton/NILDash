'use strict';
// ── THE SAMPLE: NILDASH RUN FOR ONE OF THE AGENT'S OWN CLIENTS ──────────────
//
// Agents are too busy to take a call to see a demo, so the cold email brings
// the demo with it. For an agency whose college clients are on record, the
// autopilot runs NILDash's own engine (jobs/outreachQueue fillAthlete) for
// one of those clients and puts the result on a private page:
// mynildash.com/sample/<token>. The email leads with it: "I ran NILDash for
// <athlete> at <school>" (services/salesWriter sampleEmail).
//
// SALES_SAMPLE_ON=true turns it on. Off, nothing here runs and the emails are
// the plain template.
//
// WHERE THE AGENCIES COME FROM. A list of agencies, their agents and one or
// more of their reported college clients (sales_pool), loaded once by the
// admin (POST /api/admin/sales/pool) from ScoutSZN's representation pages,
// which ScoutSZN's founder agreed to. Nothing is crawled at run time. The
// agency lane takes from this list first, then falls back to web search.
//
// HOW A SAMPLE IS BUILT. After the night's Hunter window closes (5:30
// Central, weekdays), each drafted prospect with a pending sample gets one:
//   - the client is saved as an athlete under a hidden, archived account
//     (samples@mynildash.invalid), which the nightly run never fills and the
//     morning email never counts;
//   - fillAthlete runs once for them on SALES_SAMPLE_USD (0.60), at most 3
//     slots (maxSlots), signed with the prospect agent's first name, never
//     widening (a school's widen budget belongs to customers' athletes);
//   - then the athlete, its cards and its drafts are deleted, so nothing
//     downstream (media kits, market scores, admin tools) ever sees them;
//   - one paid attempt per prospect: claimed atomically ('building'), and a
//     build that never finished is failed, not retried;
//   - the cards it placed are copied onto the prospect (so the page does not
//     change when cards expire), up to 3, email cards first;
//   - 2 or more cards: the sample is ready, the email is rewritten to lead
//     with it, and its link becomes the sample page. Fewer: the sample failed
//     and the plain template goes instead. Either way the prospect is free to
//     be planned; a pending sample is never sent.
// The page shows the business, why it fits, the person and their title, and
// the pitch. Not the address: that is what the trial is for.

const crypto = require('crypto');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const ON = () => truthy(process.env.SALES_SAMPLE_ON);
const SAMPLE_USD = () => { const n = parseFloat(process.env.SALES_SAMPLE_USD); return Number.isFinite(n) && n > 0 ? Math.min(n, 3) : 0.60; };
const SAMPLE_AT = 5 * 60 + 30;          // Central, weekdays: after the Hunter night (1am to 5am)
const SAMPLE_UNTIL = 7 * 60;            // the day's plan is at 7:00
const PER_TICK = 4;
const MIN_CARDS = 2;
const SHOW = 3;
const SAMPLES_EMAIL = 'samples@mynildash.invalid';
const SAMPLES_ID = 'nildash-samples';
const lc = (s) => String(s || '').trim().toLowerCase();

// ── THE AGENCY LIST ─────────────────────────────────────────────────────────
let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    // sales_prospects and its sample columns are the autopilot's (salesAutopilot.ensureTables).
    await require('./salesAutopilot').ensureTables(pool);
    await pool.query(`CREATE TABLE IF NOT EXISTS sales_pool (
      slug TEXT PRIMARY KEY, agency TEXT NOT NULL, clients INTEGER, agents JSONB NOT NULL DEFAULT '[]',
      players JSONB NOT NULL DEFAULT '[]', schools TEXT, source TEXT, used_at TIMESTAMPTZ, outcome TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

// "Tavion Gadson (DT, Kentucky)" -> { name, position, school }
function parsePlayer(x) {
  if (x && typeof x === 'object') {
    const name = String(x.name || x.n || '').trim();
    return name ? { name, position: String(x.position || x.p || '').trim(), school: String(x.school || x.s || '').trim(), grade: Number(x.grade || x.g) || null } : null;
  }
  const m = /^\s*(.+?)\s*\(([A-Z]{1,4}),\s*([^)]*)\)\s*$/.exec(String(x || ''));
  return m ? { name: m[1].trim(), position: m[2], school: m[3].trim(), grade: null } : null;
}

// Load or refresh the list. rows: [{ slug, agency, clients, agents: [..], players|notable, schools }]
// -> { saved, skipped }
async function importPool(pool, rows, source) {
  await ensureTables(pool);
  let saved = 0, skipped = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const slug = lc(r && r.slug).replace(/[^a-z0-9-]/g, '').slice(0, 120);
    const agency = String((r && r.agency) || '').trim().slice(0, 200);
    const agents = (Array.isArray(r && r.agents) ? r.agents : []).map((a) => String(a || '').trim()).filter((a) => /^[A-Za-z][A-Za-z'.-]+(\s+[A-Za-z][A-Za-z'.-]+)+$/.test(a)).slice(0, 12);
    const players = []
      .concat(Array.isArray(r && r.players) ? r.players : [])
      .concat(r && r.notable ? [r.notable] : [])
      .map(parsePlayer).filter((p) => p && p.name && p.school).slice(0, 30);
    if (!slug || !agency) { skipped++; continue; }
    await pool.query(
      `INSERT INTO sales_pool (slug, agency, clients, agents, players, schools, source) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slug) DO UPDATE SET agency = EXCLUDED.agency, clients = EXCLUDED.clients, agents = EXCLUDED.agents,
         players = EXCLUDED.players, schools = EXCLUDED.schools, source = EXCLUDED.source, updated_at = NOW()`,
      [slug, agency, Number.isFinite(Number(r.clients)) ? Number(r.clients) : null, JSON.stringify(agents), JSON.stringify(players),
        String((r && r.schools) || '').slice(0, 300) || null, String(source || 'import').slice(0, 300)]);
    saved++;
  }
  return { saved, skipped };
}

// The next agencies to try: unused, most clients first.
async function nextAgencies(pool, n) {
  await ensureTables(pool);
  return (await pool.query(
    `SELECT * FROM sales_pool WHERE used_at IS NULL AND jsonb_array_length(agents) > 0 ORDER BY clients DESC NULLS LAST, slug LIMIT $1`, [Math.max(1, n)])).rows;
}
async function markUsed(pool, slug, outcome) {
  await pool.query(`UPDATE sales_pool SET used_at = NOW(), outcome = $2, updated_at = NOW() WHERE slug = $1`, [slug, String(outcome || '').slice(0, 200)]);
}

// The client to build the sample for: a college player with a school, the
// middle of the roster first (that is who NILDash is for), then anyone.
function pickClient(players) {
  const ps = (players || []).map(parsePlayer).filter((p) => p && p.name && p.school);
  if (!ps.length) return null;
  const mid = ps.filter((p) => p.grade == null || (p.grade >= 3.5 && p.grade <= 6.5));
  return (mid[0] || ps[0]);
}

// ── THE HIDDEN ACCOUNT THE SAMPLES ARE BUILT UNDER ─────────────────────────
async function samplesAccount(pool) {
  await pool.query(
    `INSERT INTO users (id, name, email, password, role, archived, seat_override)
     VALUES ($1, 'NILDash Samples', $2, $3, 'agent', TRUE, 0) ON CONFLICT DO NOTHING`,
    [SAMPLES_ID, SAMPLES_EMAIL, '!' + crypto.randomBytes(24).toString('hex')]).catch(() => {});
  await pool.query(`UPDATE users SET archived = TRUE WHERE id = $1`, [SAMPLES_ID]).catch(() => {});
  return SAMPLES_ID;
}

const htmlToText = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

// The cards a fill placed for this athlete, email cards first, as the page shows them.
async function cardsFor(pool, athleteId) {
  const r = await pool.query(
    `SELECT q.brand_name, q.why, q.contact_name, q.contact_title, q.channel, q.business_category, q.lane, q.slot,
            l.subject, l.body_html, q.dm_text
       FROM outreach_queue q LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
      WHERE q.athlete_id = $1 AND q.state = 'queued'
      ORDER BY CASE WHEN q.channel = 'email' THEN 0 ELSE 1 END, q.slot`, [athleteId]);
  return r.rows.filter((c) => c.brand_name).map((c) => ({
    business: c.brand_name, category: c.business_category || null, why: c.why || null,
    contactName: c.contact_name || null, contactTitle: c.contact_title || null, channel: c.channel || null,
    subject: c.subject || null, pitch: c.body_html ? htmlToText(c.body_html) : (c.dm_text || null),
  }));
}

// Build one prospect's sample. deps.fill(ctx) stands in for the engine in tests.
// -> { status: 'ready'|'failed', cards, why? }
async function build(pool, p, deps = {}) {
  await ensureTables(pool);
  const s = p.sample || {};
  const client = s.athlete || null;
  if (!client || !client.name || !client.school) return { status: 'failed', why: 'no client with a school on record', cards: [] };
  const job = require('../jobs/outreachQueue');
  const store = require('../store');
  const Q = require('./outreachQueue');
  const agentId = await samplesAccount(pool);
  const first = require('./salesWriter').firstName(p.person) || 'Your agent';
  await pool.query(`UPDATE users SET sign_first_name = $2, name = $3 WHERE id = $1`, [agentId, first, String(p.person || first)]).catch(() => {});
  const athleteId = s.athleteId || ('ath-sample-' + crypto.randomBytes(6).toString('hex'));
  if (!s.athleteId) {
    await store.saveAthlete(athleteId, {
      id: athleteId, agentId, name: client.name, sport: 'Football', position: client.position || '', athleteType: 'college',
      school: client.school, schoolTier: 'p4-mid', notes: `Sales sample for ${p.org || ''}`.trim(), sample: true,
      createdAt: new Date().toISOString(),
    });
    await pool.query(`UPDATE sales_prospects SET sample = jsonb_set(COALESCE(sample, '{}'::jsonb), '{athleteId}', to_jsonb($2::text)) WHERE id = $1`, [p.id, athleteId]);
  }
  const ath = (await job.loadAthletesForQueue(pool, agentId, athleteId))[0];
  if (!ath) return { status: 'failed', why: 'the sample athlete could not be read back', cards: [] };
  const budget = Q.newBudget(SAMPLE_USD());
  let r;
  try {
    if (deps.fill) r = await deps.fill({ pool, ath, budget, agentId, athleteId });
    else {
      const _ctx = await job.localContextFor(ath);
      const AgentName = require('./agentName');
      const SIG = require('./signature');
      r = await job.fillAthlete(pool, {
        agentId, athleteId, athleteName: ath.name, runDate: job.today(),
        athleteProfile: _ctx.profile,
        agentFirstName: AgentName.pitchSignOffName({ name: ath.agent_name, email: ath.agent_email, sign_first_name: ath.agent_sign_first_name }) || first,
        signature: SIG.signatureOf(ath), athleteRow: ath.data || null,
        budget, region: _ctx.region, regionFault: _ctx.fault || null,
        // Three cards are all the page shows, so three are all it pays for.
        // Never widens: a school's widen budget belongs to customers' athletes.
        noWiden: true, maxSlots: SHOW, onProgress: (m) => console.log('[sales-sample] ' + m),
      });
    }
  } catch (e) {
    return { status: 'failed', why: 'the fill failed: ' + String(e.message || e).slice(0, 200), cards: [] };
  }
  const cards = (await cardsFor(pool, athleteId)).slice(0, SHOW);
  const spent = typeof budget.spent === 'function' ? budget.spent() : null;
  await cleanup(pool, athleteId);
  if (cards.length < MIN_CARDS) return { status: 'failed', why: `only ${cards.length} card(s) placed${r && r.note ? ': ' + String(r.note).slice(0, 160) : ''}`, cards, spent, athleteId };
  return { status: 'ready', cards, spent, athleteId };
}

// The sample athlete is gone once its cards are copied: nothing downstream
// (media kits, market scores, admin tools) should ever see it.
async function cleanup(pool, athleteId) {
  if (!athleteId || !/^ath-sample-/.test(athleteId)) return;
  for (const sql of [
    `DELETE FROM outreach_queue WHERE athlete_id = $1 AND agent_id = '${SAMPLES_ID}'`,
    `DELETE FROM outreach_logs WHERE athlete_id = $1 AND agent_id = '${SAMPLES_ID}'`,
    `DELETE FROM athletes WHERE id = $1 AND agent_id = '${SAMPLES_ID}'`,
  ]) await pool.query(sql, [athleteId]).catch((e) => console.error('[sales-sample] cleanup: ' + e.message));
}

function sampleUrl(token) {
  const app = String(process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');
  return `${app}/sample/${token}`;
}

// After a build: the prospect's sample and its first email.
async function finish(pool, p, res) {
  const SA = require('./salesAutopilot');
  const W = require('./salesWriter');
  const sample = { ...(p.sample || {}), athleteId: res.athleteId || (p.sample && p.sample.athleteId) || null,
    cards: res.cards || [], builtAt: new Date().toISOString(), spent: res.spent == null ? null : res.spent, why: res.why || null };
  if (res.status === 'ready') {
    const token = crypto.randomBytes(12).toString('base64url');
    const ctx = { ...SA.writerCtx(), link: sampleUrl(token) };
    const mail = W.sampleEmail(p, ctx, sample);
    const problems = W.checkEmail(mail, p, ctx, 1);
    if (problems.length) {
      await pool.query(`UPDATE sales_prospects SET sample_status = 'failed', sample = $2, updated_at = NOW() WHERE id = $1`,
        [p.id, JSON.stringify({ ...sample, why: 'the sample email failed its checks: ' + problems.join('; ') })]);
      return { status: 'failed', why: 'checks: ' + problems.join('; ') };
    }
    // One transaction: never a ready sample with the old email, or the reverse.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE sales_emails SET subject = $2, body_text = $3, written_by = 'sample' WHERE prospect_id = $1 AND step = 1 AND state = 'draft'`,
        [p.id, mail.subject, mail.body]);
      await client.query(`UPDATE sales_prospects SET sample_status = 'ready', sample_token = $2, sample = $3, updated_at = NOW() WHERE id = $1`,
        [p.id, token, JSON.stringify(sample)]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    return { status: 'ready', token, url: ctx.link };
  }
  await pool.query(`UPDATE sales_prospects SET sample_status = 'failed', sample = $2, updated_at = NOW() WHERE id = $1`, [p.id, JSON.stringify(sample)]);
  return { status: 'failed', why: res.why };
}

// The weekday step: pending samples, a few per tick, between 5:30 and 7:00
// Central (or any time when forced, e.g. the admin dry run).
let _running = false;
async function tick(pool, { now, force = false, limit = PER_TICK, deps = {} } = {}) {
  if (!ON()) return { skipped: 'SALES_SAMPLE_ON is off' };
  await ensureTables(pool);
  const SA = require('./salesAutopilot');
  const c = SA.centralDay(now);
  if (!force && (['Sat', 'Sun'].includes(c.weekday) || c.minutes < SAMPLE_AT || c.minutes >= SAMPLE_UNTIL)) return { skipped: 'not yet' };
  if (_running) return { skipped: 'already building' };
  _running = true;
  const out = [];
  try {
    // A build that never finished (a restart, the admin child's 15-minute
    // timeout) is failed, never retried: one paid attempt per prospect.
    await pool.query(`UPDATE sales_prospects SET sample_status = 'failed',
        sample = jsonb_set(COALESCE(sample, '{}'::jsonb), '{why}', '"the build was interrupted"'), updated_at = NOW()
      WHERE sample_status = 'building' AND updated_at < NOW() - INTERVAL '45 minutes'`);
    for (let i = 0; i < Math.max(1, limit); i++) {
      // Claimed one at a time, atomically, so two processes never build the same one.
      const p = (await pool.query(
        `UPDATE sales_prospects SET sample_status = 'building', updated_at = NOW()
          WHERE id = (SELECT id FROM sales_prospects WHERE sample_status = 'pending' AND status = 'drafted'
                       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`)).rows[0];
      if (!p) break;
      const res = await build(pool, p, deps).catch((e) => ({ status: 'failed', why: String(e.message || e).slice(0, 200), cards: [] }));
      let fin;
      try { fin = await finish(pool, p, res); }
      catch (e) {
        fin = { status: 'failed', why: 'finish failed: ' + String(e.message || e).slice(0, 200) };
        await pool.query(`UPDATE sales_prospects SET sample_status = 'failed', updated_at = NOW() WHERE id = $1`, [p.id]).catch(() => {});
      }
      out.push({ prospect: p.id, org: p.org, person: p.person, athlete: p.sample && p.sample.athlete && p.sample.athlete.name, ...fin, cards: (res.cards || []).length });
    }
  } finally { _running = false; }
  return { built: out };
}

// ── THE PAGE ────────────────────────────────────────────────────────────────
const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
async function page(pool, token) {
  await ensureTables(pool);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(token || ''))) return null;
  const p = (await pool.query(`SELECT * FROM sales_prospects WHERE sample_token = $1 AND sample_status = 'ready'`, [token])).rows[0];
  if (!p || !p.sample) return null;
  const SA = require('./salesAutopilot');
  const W = require('./salesWriter');
  const s = p.sample;
  const a = s.athlete || {};
  const first = W.firstName(p.person) || '';
  const book = await SA.bookingUrl(pool);
  const sender = SA.senderName();
  const cards = (s.cards || []).slice(0, SHOW).map((c, i) => `
    <section class="card">
      <div class="n">${i + 1}</div>
      <div class="body">
        <h2>${esc(c.business)}</h2>
        ${c.category ? `<p class="cat">${esc(c.category)}</p>` : ''}
        ${c.why ? `<p class="why">${esc(c.why)}</p>` : ''}
        ${c.contactName ? `<p class="who"><b>Contact:</b> ${esc(c.contactName)}${c.contactTitle ? `, ${esc(c.contactTitle)}` : ''} <span class="pill">verified email on file</span></p>` : ''}
        ${c.pitch ? `<details${i === 0 ? ' open' : ''}><summary>The pitch, already written${c.subject ? `: <i>${esc(c.subject)}</i>` : ''}</summary><pre>${esc(c.pitch)}</pre></details>` : ''}
      </div>
    </section>`).join('');
  const trial = SA.TRIAL_ON()
    ? `<a class="btn ghost" href="/?signin=agent&amp;tab=signup&amp;trial=${SA.TRIAL_DAYS}">Start 14-day trial</a>`
    : '';
  const bookBtn = book ? `<a class="btn" href="${esc(book)}">Book 15 minutes with ${esc(sender.split(/\s+/)[0])}</a>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>NILDash sample for ${esc(a.name || 'your client')}</title>
<style>
:root{--bg:#f5f7f4;--fg:#15201a;--muted:#5d6b62;--line:#dde4dd;--card:#fff;--acc:#1b7a48}
@media (prefers-color-scheme:dark){:root{--bg:#101511;--fg:#e7ede8;--muted:#9aa99f;--line:#2a332d;--card:#18201b;--acc:#4cc283}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:24px max(16px,env(safe-area-inset-left))}
main{max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.brand{font-weight:800;letter-spacing:.02em;color:var(--acc)}h1{margin:4px 0 0;font-size:1.7rem;line-height:1.15}
.lede{color:var(--muted);margin:6px 0 0}.card{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.n{flex:0 0 32px;height:32px;border-radius:50%;background:var(--acc);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
.body{min-width:0;flex:1}h2{margin:0;font-size:1.15rem}.cat{margin:2px 0 0;color:var(--muted);font-size:.9rem}.why{margin:8px 0 0}
.who{margin:8px 0 0}.pill{display:inline-block;font-size:.75rem;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);margin-left:4px}
details{margin-top:10px}summary{cursor:pointer;color:var(--acc);font-weight:600}pre{white-space:pre-wrap;font:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;margin:8px 0 0}
.cta{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:10px}
.cta h2{font-size:1.2rem}.btns{display:flex;flex-wrap:wrap;gap:10px}.btn{display:inline-block;padding:10px 16px;border-radius:8px;background:var(--acc);color:#fff;text-decoration:none;font-weight:600}
.btn.ghost{background:transparent;color:var(--acc);border:1px solid var(--acc)}.fine{color:var(--muted);font-size:.85rem;margin:0}
</style></head><body><main>
<div><div class="brand">NILDash</div>
<h1>${esc(s.cards && s.cards.length >= 3 ? '3' : String((s.cards || []).length))} brands ready to pitch for ${esc(a.name || 'your client')}</h1>
<p class="lede">Built for ${esc(first || 'you')} at ${esc(p.org || 'your agency')}${a.school ? `. ${esc(a.name)}${a.position ? `, ${esc(a.position)}` : ''}, ${esc(a.school)}` : ''}. Each one is a real business, the person who decides, and a pitch already written in your name.</p></div>
${cards}
<section class="cta"><h2>Get this every morning for every athlete you represent</h2>
<p class="fine">5 pitches per athlete, already written, going to verified people. You review and send. NILDash finds and writes; you and your athletes decide every deal.</p>
<div class="btns">${bookBtn}${trial}</div>
${SA.TRIAL_ON() ? '<p class="fine">Card at signup. The first charge is on day 15; cancel before then and you pay nothing.</p>' : ''}
</section>
<p class="fine">Representation is from public reporting. This sample was built on ${esc(String(s.builtAt || '').slice(0, 10))} and does not update.</p>
</main></body></html>`;
}

module.exports = { ON, SAMPLE_USD, SAMPLE_AT, SAMPLE_UNTIL, MIN_CARDS, SHOW, SAMPLES_ID, SAMPLES_EMAIL,
  ensureTables, importPool, nextAgencies, markUsed, pickClient, parsePlayer, samplesAccount, cardsFor, cleanup, build, finish, tick, page, sampleUrl, htmlToText };
