'use strict';
// ── THE PREFLIGHT: IS EVERYTHING THE NIGHT DEPENDS ON ACTUALLY ANSWERING? ───
//
// The Places outage was not really about Google. An outside service went away
// and the run kept going quietly; the morning alert caught the symptom the
// next day. This catches the cause before the night starts: shortly before the
// nightly window, ONE cheap real call to every external service the run and
// the morning depend on, agent side and university side alike.
//
// Each result is written to service_checks (service, ok, response time, the
// provider's own error text). If anything fails, the admin is emailed AT ONCE,
// and the email says in plain words what will not work tonight because of it.
//
// A key being SET proves nothing: a key that is present but refused, or an API
// that is switched off on the project, only shows up when you call it. So each
// check makes a real request, the cheapest one that exercises the path the
// night uses:
//
//   google-places         searchText, one result, id only
//   anthropic             a 1-token message on the fast model
//   anthropic-web-search  one web search (the tool has its own org setting)
//   deepseek              a 1-token chat completion
//   web-search            one query through the configured provider (Serper...)
//   hunter                the account endpoint (free: spends no search credit)
//   resend                the domains list, and the sending domain is verified
//   admin-alert-email     a destination exists (not a network call)
//   mailbox-tokens        every connected mailbox of an agent with athletes:
//                         its tokens decrypt, and a real token refresh succeeds
//   database              SELECT 1
//
// Cost: a fraction of a cent, plus one web search.

const OF = require('./ourFault');

const TIMEOUT_MS = 15000;
// What each service's failure means for tonight, in plain words.
const CONSEQUENCE = {
  'google-places': 'Places market builds fail, so no new businesses are discovered tonight (scans fall back to web search only); per-business Places lookups (phone, website) are missing; schools not in the built-in map cannot be located. University team scans cannot find businesses at all.',
  anthropic: 'No pitch can be written (the writer is Sonnet) and the Haiku fast tier fails wherever DeepSeek is not used. Expect zero cards tonight, and no university sponsor asks.',
  'anthropic-web-search': 'Web searches on the Anthropic path (discovery passes, contact sources, owner-name search) fail. Where DeepSeek handles search this is a fallback only; otherwise contacts and discovery come back empty.',
  deepseek: 'Fast-tier calls (discovery, contacts, owner-name search) fall back to Anthropic Haiku: the night still runs if Anthropic is up, at a higher cost.',
  'web-search': 'DeepSeek cannot search the web, so every search falls back to Anthropic web search. If that is also down, discovery and contact finding return nothing.',
  hunter: 'Hunter address lookups fail: no Tier 2 addresses (surname matches, domain patterns), so more businesses end as call or DM cards instead of email.',
  resend: 'No email leaves through Resend: no agent digests, no morning alert, no reply notifications. THIS ALERT MAY NOT ARRIVE for the same reason; the status page still shows it.',
  'admin-alert-email': 'The preflight alert and the morning alert have nowhere to go: failures tonight will not reach anyone.',
  'mailbox-tokens': 'Approved emails for the listed agents will not send tonight: their mailbox connection is refused, so their cards will be held.',
  'token-encryption': 'No stored mailbox token can be read: no approved email sends for any agent.',
  database: 'The nightly run cannot read or write anything.',
};

async function timed(fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Date.now() - t0, detail: detail || null, error: null };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 500), detail: (e && e.detail) || null };
  }
}

async function withTimeout(p, ms, label) {
  let t;
  try {
    return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); })]);
  } finally { clearTimeout(t); }
}

async function httpJson(fetchImpl, url, init) {
  const ac = new AbortController();
  const k = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, { ...(init || {}), signal: ac.signal });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (_) { j = null; }
    if (!r.ok) {
      const msg = (j && j.error && (j.error.message || j.error.status)) || (j && (j.message || j.name))
        || (j && Array.isArray(j.errors) && j.errors[0] && (j.errors[0].details || j.errors[0].message)) || text.slice(0, 200);
      throw new Error(`HTTP ${r.status}: ${msg}`);
    }
    return j;
  } finally { clearTimeout(k); }
}

const isEmail = (s) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(String(s || '').trim());

// Every check. deps: { fetch, pool, ai, ds, wst, gmail, outlook, emailStore } for tests.
function checks(deps) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const need = (name, v) => { if (!v) { const e = new Error(`${name} is not set`); throw e; } return v; };
  return {
    database: () => deps.pool.query('SELECT 1').then(() => 'ok'),

    'admin-alert-email': async () => {
      const to = process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL || '';
      if (!to) throw new Error('neither ADMIN_ALERT_EMAIL nor ADMIN_EMAIL is set: alerts have no destination');
      if (!isEmail(to)) throw new Error(`the alert destination "${to}" is not an email address`);
      return process.env.ADMIN_ALERT_EMAIL ? `ADMIN_ALERT_EMAIL = ${to}` : `ADMIN_ALERT_EMAIL is unset; using ADMIN_EMAIL = ${to}`;
    },

    'google-places': async () => {
      const key = need('GOOGLE_PLACES_API_KEY', (process.env.GOOGLE_PLACES_API_KEY || '').trim());
      const j = await httpJson(fetchImpl, 'https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
        body: JSON.stringify({ textQuery: 'Cypress College, Cypress, CA', pageSize: 1 }),
      });
      if (!j || !Array.isArray(j.places) || !j.places.length) throw new Error('answered, but returned no place for a known address');
      return 'searchText answered';
    },

    anthropic: async () => {
      const ai = deps.ai || require('../ai');
      const client = ai.getClient();
      await withTimeout(client.messages.create({ model: ai.MODEL_FAST, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }), TIMEOUT_MS, 'anthropic');
      return `${ai.MODEL_FAST} answered`;
    },

    'anthropic-web-search': async () => {
      const ai = deps.ai || require('../ai');
      const client = ai.getClient();
      const msg = await withTimeout(client.messages.create({
        model: ai.MODEL_FAST, max_tokens: 64,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        messages: [{ role: 'user', content: 'Search the web once for "Cypress College" and reply with one word.' }],
      }), TIMEOUT_MS * 2, 'anthropic web search');
      const f = ai._webSearchFault ? ai._webSearchFault(msg.content, 'preflight') : null;
      if (f) throw new Error(f.reason);
      const ran = (msg.content || []).some((b) => b && b.type === 'web_search_tool_result');
      return ran ? 'one search ran' : 'answered without searching (tool available)';
    },

    deepseek: async () => {
      const ds = deps.ds || require('./deepseek');
      // Not configured is not a failure: with no key the fast tier routes to
      // Anthropic (services/deepseek.route), which has its own check.
      if (!ds.apiKey()) throw new Error('DEEPSEEK_API_KEY is not set');
      await ds.chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1, timeoutMs: TIMEOUT_MS, ledger: false });
      return `${ds.model()} answered`;
    },

    'web-search': async () => {
      const wst = deps.wst || require('./webSearchTool');
      const sp = wst.provider();
      if (!sp) throw new Error('no web search provider key is set (SERPER_API_KEY, BRAVE_SEARCH_API_KEY or TAVILY_API_KEY)');
      const rs = await withTimeout(sp.search('Cypress College athletics', 1), TIMEOUT_MS, sp.name);
      return `${sp.name} answered (${rs.length} result${rs.length === 1 ? '' : 's'})`;
    },

    hunter: async () => {
      const key = need('HUNTER_API_KEY', process.env.HUNTER_API_KEY);
      const j = await httpJson(fetchImpl, 'https://api.hunter.io/v2/account?api_key=' + encodeURIComponent(key));
      const d = (j && j.data) || {};
      const left = d.requests && d.requests.searches ? d.requests.searches.available - d.requests.searches.used : null;
      if (left !== null && left <= 0) throw new Error(`no Hunter searches left this period (${d.requests.searches.used} of ${d.requests.searches.available} used)`);
      return left === null ? 'account answered' : `${left} search(es) left this period`;
    },

    resend: async () => {
      const key = need('RESEND_API_KEY', process.env.RESEND_API_KEY);
      const j = await httpJson(fetchImpl, 'https://api.resend.com/domains', { headers: { Authorization: 'Bearer ' + key } });
      const from = process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>';
      const domain = (String(from).match(/@([^>\s]+)/) || [])[1];
      const list = (j && Array.isArray(j.data)) ? j.data : [];
      const row = domain ? list.find((d) => String(d.name).toLowerCase() === domain.toLowerCase()) : null;
      if (domain && list.length && !row) throw new Error(`the sending domain ${domain} is not on this Resend account`);
      if (row && row.status && row.status !== 'verified') throw new Error(`the sending domain ${domain} is ${row.status}, not verified`);
      return domain ? `${domain} verified` : 'key accepted';
    },

    'mailbox-tokens': async () => {
      const pool = deps.pool;
      const rows = (await pool.query(
        `SELECT e.id, e.user_id, e.provider, e.email_address, u.name, u.email AS agent_email
           FROM email_accounts e JOIN users u ON u.id = e.user_id
          WHERE COALESCE(e.status, 'active') <> 'disconnected'
            AND u.archived IS NOT TRUE
            AND EXISTS (SELECT 1 FROM athletes a WHERE a.agent_id = u.id)`)).rows;
      if (!rows.length) return 'no connected mailboxes to check';
      const emailStore = deps.emailStore || require('./emailStore');
      const bad = [];
      let checked = 0, undecryptable = 0;
      for (const r of rows) {
        const full = await emailStore.getEmailAccountWithTokens(r.id);
        if (!full || !full.refreshToken) {
          undecryptable++;
          bad.push(`${r.name || r.agent_email} (${r.email_address}): the stored token could not be read`);
          continue;
        }
        if (r.provider === 'gmail' || r.provider === 'outlook' || r.provider === 'microsoft365') {
          const prov = r.provider === 'gmail' ? (deps.gmail || require('./providers/gmail')) : (deps.outlook || require('./providers/outlook'));
          if (prov.isAvailable && !prov.isAvailable()) { bad.push(`${r.name || r.agent_email}: ${r.provider} is not configured on this server`); continue; }
          try { await withTimeout(prov.refreshAccessToken(full.refreshToken), TIMEOUT_MS, r.provider); checked++; }
          catch (e) { bad.push(`${r.name || r.agent_email} (${r.email_address}): ${r.provider} refused the token: ${String(e.message).slice(0, 160)}`); }
        } else checked++;
      }
      if (undecryptable && undecryptable === rows.length) {
        const e = new Error(`none of the ${rows.length} stored mailbox token(s) could be decrypted: the encryption key probably changed`);
        e.detail = { tokenEncryption: true, agents: bad };
        throw e;
      }
      if (bad.length) { const e = new Error(`${bad.length} of ${rows.length} mailbox(es) will not send: ${bad.join('; ')}`); e.detail = { agents: bad }; throw e; }
      return `${checked} mailbox(es) refreshed`;
    },
  };
}

// Run every check, write each result, and return the list.
async function runAll(pool, opts = {}) {
  const deps = { pool, ...(opts.deps || {}) };
  const C = checks(deps);
  const runId = 'pf_' + Date.now().toString(36);
  const results = [];
  for (const [service, fn] of Object.entries(C)) {
    const r = await timed(fn);
    // DeepSeek that is simply not configured and not routed to is not a failure.
    if (!r.ok && service === 'deepseek' && /DEEPSEEK_API_KEY is not set/.test(r.error)) {
      let routed = false;
      try { routed = require('./deepseek').configured(); } catch (_) {}
      if (!routed) { r.ok = true; r.detail = 'not configured; the fast tier uses Anthropic'; r.error = null; }
    }
    const svc = (!r.ok && service === 'mailbox-tokens' && r.detail && r.detail.tokenEncryption) ? 'token-encryption' : service;
    results.push({ service: svc, ok: r.ok, ms: r.ms, error: r.error, detail: r.detail });
    await pool.query(
      `INSERT INTO service_checks (run_id, service, ok, ms, error, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [runId, svc, r.ok, r.ms, r.error, r.detail == null ? null : JSON.stringify(r.detail)]).catch((e) =>
      console.error('[preflight] could not record ' + svc + ': ' + e.message));
    if (!r.ok) OF.record(svc, r.error, 'preflight');
    console[r.ok ? 'log' : 'error'](`[preflight] ${svc}: ${r.ok ? 'ok' : 'FAILED'} ${r.ms}ms ${r.ok ? (typeof r.detail === 'string' ? r.detail : '') : r.error}`);
  }
  return { runId, results, failed: results.filter((x) => !x.ok) };
}

function render(run, when) {
  const failed = run.failed;
  const subject = `NILDash PREFLIGHT FAILED: ${failed.map((f) => f.service).join(', ')} (tonight's run is affected)`;
  const lines = [subject, '', `Checked ${new Date(when || Date.now()).toISOString()}, before the nightly run.`, ''];
  for (const f of failed) {
    lines.push(`${f.service.toUpperCase()}: ${f.error}`);
    lines.push(`  What will not work tonight: ${CONSEQUENCE[f.service] || 'anything that depends on it.'}`);
    lines.push('');
  }
  const okNames = run.results.filter((r) => r.ok).map((r) => r.service);
  if (okNames.length) lines.push('Answering normally: ' + okNames.join(', ') + '.');
  lines.push('Live status: ' + String(process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '') + '/admin/status');
  const text = lines.join('\n');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return { subject, text, html: `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(text)}</pre>` };
}

async function _send(msg) {
  const to = process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL;
  if (!to) throw new Error('no alert destination: set ADMIN_ALERT_EMAIL');
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const from = process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>';
  return resend.emails.send({ from, to, subject: msg.subject, text: msg.text, html: msg.html });
}

// ── WHEN IT RUNS ────────────────────────────────────────────────────────────
// Once per Central date, in the half hour before the nightly window opens
// (00:30 to 01:00 Central), claimed in preflight_runs so a restart or a second
// instance does not run it twice. The queue tick also calls ensureTonight, so
// a server that restarted past 00:30 still checks before it fills.
function centralParts(ms) {
  const OQ = require('../jobs/outreachQueue');
  const f = new Intl.DateTimeFormat('en-US', { timeZone: OQ.CENTRAL_TZ, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms == null ? Date.now() : ms));
  const g = (t) => Number((f.find((p) => p.type === t) || {}).value || 0);
  return { hour: g('hour') % 24, minute: g('minute'), date: OQ.today(ms) };
}
function inPreflightWindow(ms) {
  const OQ = require('../jobs/outreachQueue');
  const p = centralParts(ms);
  const startHour = OQ.WINDOW_START_HOUR;
  return (p.hour === (startHour + 23) % 24 && p.minute >= 30) || (p.hour >= startHour && p.hour < OQ.WINDOW_END_HOUR);
}

async function ensureTonight(pool, opts = {}) {
  if (!opts.force && !inPreflightWindow(opts.now)) return { skipped: 'outside the preflight window' };
  // The night's date: the half hour before 1am belongs to the night that follows.
  const night = require('../jobs/outreachQueue').today((opts.now == null ? Date.now() : opts.now) + 3600000);
  const claim = await pool.query(
    `INSERT INTO preflight_runs (night, status) VALUES ($1, 'running') ON CONFLICT (night) DO NOTHING RETURNING night`, [night]);
  if (!opts.force && !claim.rowCount) return { skipped: 'already ran for ' + night };
  const run = await runAll(pool, opts);
  let alert = null;
  if (run.failed.length) {
    const msg = render(run, opts.now);
    try { await (opts.send || _send)(msg); alert = 'sent'; }
    catch (e) {
      alert = 'FAILED: ' + e.message;
      console.error('[preflight] ALERT COULD NOT BE SENT: ' + e.message + ' -- the failures are on /admin/status');
    }
  }
  await pool.query(`INSERT INTO preflight_runs (night, status, failed, alert, run_id) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (night) DO UPDATE SET status = EXCLUDED.status, failed = EXCLUDED.failed, alert = EXCLUDED.alert, run_id = EXCLUDED.run_id, finished_at = NOW()`,
  [night, run.failed.length ? 'failed' : 'ok', run.failed.length, alert, run.runId]).catch(() => {});
  return { night, ...run, alert };
}

module.exports = { runAll, ensureTonight, render, checks, inPreflightWindow, CONSEQUENCE };
