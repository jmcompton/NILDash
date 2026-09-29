'use strict';
// ── /admin/status: ONE SCREEN ───────────────────────────────────────────────
//
// Every external service, green or red, with when it was last checked (the
// preflight's service_checks rows), and the last seven nights of output for
// agents and for universities. Read only: no buttons that spend, no writes.
//
// A service that has never been checked is shown GREY, not green. "No row"
// is not "fine" -- that is the whole lesson of the Places outage.
//
// Every read is separate and a failed read is SHOWN as failed on the page
// (readErrors), never rendered as an empty table that looks like a quiet week.
const PF = require('./preflight');

// token-encryption is not its own check: the mailbox check reports it when no
// stored token decrypts. It is shown only while that is the latest word.
const SERVICES = Object.keys(PF.CONSEQUENCE).filter((s) => s !== 'token-encryption');
const DAYS = 7;

async function collect(pool) {
  const readErrors = [];
  const q = async (label, sql, params = []) => {
    try { return (await pool.query(sql, params)).rows; }
    catch (e) { readErrors.push(`${label}: ${e.message}`); return null; }
  };

  // Latest check per service, and the last time each one was green.
  const latest = await q('service_checks', `
    SELECT DISTINCT ON (service) service, ok, ms, error, checked_at
      FROM service_checks ORDER BY service, checked_at DESC`);
  const lastOk = await q('service_checks (last ok)', `
    SELECT service, MAX(checked_at) AS at FROM service_checks WHERE ok GROUP BY service`);
  const byService = new Map((latest || []).map((r) => [r.service, r]));
  const okAt = new Map((lastOk || []).map((r) => [r.service, r.at]));
  const te = byService.get('token-encryption'), mb = byService.get('mailbox-tokens');
  if (te && mb && new Date(mb.checked_at) > new Date(te.checked_at)) byService.delete('token-encryption');
  const names = [...SERVICES, ...[...byService.keys()].filter((s) => !SERVICES.includes(s))];
  const services = names.map((s) => {
    const r = byService.get(s);
    return {
      service: s,
      state: !r ? 'unchecked' : r.ok ? 'ok' : 'failed',
      ms: r ? r.ms : null,
      error: r && !r.ok ? r.error : null,
      checkedAt: r ? r.checked_at : null,
      lastOkAt: okAt.get(s) || null,
      consequence: PF.CONSEQUENCE[s] || null,
    };
  });

  const preflights = await q('preflight_runs', `
    SELECT night, status, failed, alert, started_at, finished_at
      FROM preflight_runs WHERE night > CURRENT_DATE - $1::int ORDER BY night DESC`, [DAYS + 1]);

  const faults = await q('service_faults', `
    SELECT service, SUM(1 + COALESCE(suppressed, 0))::int AS n, MAX(at) AS last,
           (ARRAY_AGG(reason ORDER BY at DESC))[1] AS reason
      FROM service_faults WHERE at > NOW() - ($1::int || ' days')::interval
     GROUP BY service ORDER BY n DESC`, [DAYS]);

  // Agents: one row per night. Cards filled, agents who ran, agents with
  // athletes who got nothing, and faults the queue recorded that night.
  const agentNights = await q('outreach_queue_runs', `
    SELECT r.run_date AS night,
           COUNT(*)::int AS agents,
           COALESCE(SUM(r.filled), 0)::int AS cards,
           COUNT(*) FILTER (WHERE COALESCE(r.filled, 0) = 0)::int AS zero_agents,
           COALESCE(SUM(r.spent_usd), 0)::numeric(10,2) AS spent,
           COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(r.details, '[]'::jsonb)) d
                           WHERE CASE WHEN jsonb_typeof(d->'nightFaults') = 'array'
                                      THEN jsonb_array_length(d->'nightFaults') > 0 ELSE false END)), 0)::int AS athletes_with_faults
      FROM outreach_queue_runs r
     WHERE r.run_date > CURRENT_DATE - $1::int
     GROUP BY r.run_date ORDER BY r.run_date DESC`, [DAYS + 1]);

  const builds = await q('places_market_builds', `
    SELECT (at AT TIME ZONE 'America/Chicago')::date AS night,
           COUNT(*)::int AS total, COUNT(*) FILTER (WHERE NOT ok)::int AS failed
      FROM places_market_builds WHERE at > NOW() - ($1::int || ' days')::interval
     GROUP BY 1 ORDER BY 1 DESC`, [DAYS]);

  const digests = await q('nightly_digest_sends', `
    SELECT run_date AS night, status, COUNT(*)::int AS n
      FROM nightly_digest_sends WHERE run_date > CURRENT_DATE - $1::int
     GROUP BY 1, 2`, [DAYS + 1]);

  // Universities: asks written per night per university, and the departments
  // (teams) that have not had a sponsor ask in the window at all.
  const univNights = await q('university_drafts', `
    SELECT (d.created_at AT TIME ZONE 'America/Chicago')::date AS night,
           u.id AS university_id, COALESCE(u.name, u.id) AS university,
           COUNT(*)::int AS asks, COUNT(DISTINCT d.team_id)::int AS teams
      FROM university_drafts d LEFT JOIN universities u ON u.id = d.university_id
     WHERE d.created_at > NOW() - ($1::int || ' days')::interval
     GROUP BY 1, 2, 3 ORDER BY 1 DESC, 3`, [DAYS]);

  const quietTeams = await q('university_teams', `
    SELECT COALESCE(u.name, t.university_id) AS university, t.id, t.name, t.sport,
           (SELECT MAX(d.created_at) FROM university_drafts d WHERE d.team_id = t.id) AS last_ask
      FROM university_teams t LEFT JOIN universities u ON u.id = t.university_id
     WHERE NOT EXISTS (SELECT 1 FROM university_drafts d
                        WHERE d.team_id = t.id AND d.created_at > NOW() - ($1::int || ' days')::interval)
     ORDER BY 1, 3`, [DAYS]);

  // DATE columns arrive as local-midnight Dates; read their parts, not the ISO string.
  const key = (v) => {
    if (!(v instanceof Date)) return String(v).slice(0, 10);
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  };
  // One row per night for the whole window, so a night with NO row reads as
  // "no run", not as a missing line nobody notices.
  const nights = [];
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    nights.push(key(d));
  }
  const agentByNight = new Map((agentNights || []).map((r) => [key(r.night), r]));
  const buildByNight = new Map((builds || []).map((r) => [key(r.night), r]));
  const pfByNight = new Map((preflights || []).map((r) => [key(r.night), r]));
  const digestByNight = new Map();
  for (const r of digests || []) {
    const k = key(r.night);
    if (!digestByNight.has(k)) digestByNight.set(k, {});
    digestByNight.get(k)[r.status] = r.n;
  }
  const agents = nights.map((n) => ({
    night: n,
    run: agentByNight.get(n) || null,
    builds: buildByNight.get(n) || null,
    digests: digestByNight.get(n) || null,
    preflight: pfByNight.get(n) || null,
  }));
  const universities = nights.map((n) => ({
    night: n,
    rows: (univNights || []).filter((r) => key(r.night) === n),
  }));

  return {
    at: new Date().toISOString(),
    services,
    faults: faults || [],
    agents,
    universities,
    quietTeams: quietTeams || [],
    readErrors,
  };
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ago(t) {
  if (!t) return 'never';
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

function renderHtml(s) {
  const dot = (state) => `<span class="dot ${state}"></span>`;
  const svc = s.services.map((r) => `<tr class="${r.state}">
    <td>${dot(r.state)}<b>${esc(r.service)}</b></td>
    <td>${r.state === 'unchecked' ? 'never checked' : esc(ago(r.checkedAt))}<div class="sm">${r.checkedAt ? esc(new Date(r.checkedAt).toISOString().replace('T', ' ').slice(0, 16)) + ' UTC' : ''}</div></td>
    <td>${r.ms == null ? '' : r.ms + ' ms'}</td>
    <td>${r.state === 'failed'
      ? `<div class="err">${esc(r.error)}</div><div class="sm">Last green: ${esc(ago(r.lastOkAt))}. ${esc(r.consequence || '')}</div>`
      : r.state === 'unchecked' ? '<span class="sm">No preflight has checked this yet.</span>' : ''}</td></tr>`).join('');

  const agentRows = s.agents.map((a) => {
    const r = a.run;
    const pf = a.preflight;
    const dg = a.digests || {};
    const bad = !r || r.cards === 0 || r.zero_agents > 0 || (a.builds && a.builds.failed) || (pf && pf.failed) || dg.failed || dg.held;
    return `<tr class="${bad ? 'warn' : ''}"><td>${esc(a.night)}</td>
      <td>${pf ? (pf.failed ? `<span class="bad">${pf.failed} failed</span>` : '<span class="good">all ok</span>') : '<span class="sm">none</span>'}</td>
      <td>${r ? r.agents : '<span class="bad">no run</span>'}</td>
      <td>${r ? `<b>${r.cards}</b>` : ''}</td>
      <td>${r ? (r.zero_agents ? `<span class="bad">${r.zero_agents}</span>` : '0') : ''}</td>
      <td>${r ? (r.athletes_with_faults ? `<span class="bad">${r.athletes_with_faults}</span>` : '0') : ''}</td>
      <td>${a.builds ? `${a.builds.total}${a.builds.failed ? ` <span class="bad">(${a.builds.failed} failed)</span>` : ''}` : '<span class="sm">0</span>'}</td>
      <td>${a.digests ? Object.entries(dg).map(([k, v]) => `${esc(k)} ${v}`).join(', ') : '<span class="sm">none</span>'}</td>
      <td>${r ? '$' + esc(r.spent) : ''}</td></tr>`;
  }).join('');

  const univRows = s.universities.map((u) => `<tr class="${u.rows.length ? '' : 'warn'}"><td>${esc(u.night)}</td><td>${u.rows.length
    ? u.rows.map((r) => `${esc(r.university)}: <b>${r.asks}</b> ask(s) across ${r.teams} team(s)`).join('<br>')
    : '<span class="bad">no sponsor asks</span>'}</td></tr>`).join('');

  const quiet = s.quietTeams.length
    ? `<table><tr><th>university</th><th>team</th><th>last ask</th></tr>${s.quietTeams.map((t) =>
      `<tr><td>${esc(t.university)}</td><td>${esc(t.name || t.sport || t.id)}</td><td>${t.last_ask ? esc(ago(t.last_ask)) : '<span class="bad">never</span>'}</td></tr>`).join('')}</table>`
    : '<p class="sm">Every department had at least one sponsor ask in the last 7 days.</p>';

  const faults = s.faults.length
    ? `<table><tr><th>service</th><th>failures (7 days)</th><th>last</th><th>most recent reason</th></tr>${s.faults.map((f) =>
      `<tr><td>${esc(f.service)}</td><td>${f.n}</td><td>${esc(ago(f.last))}</td><td class="sm">${esc(String(f.reason || '').slice(0, 200))}</td></tr>`).join('')}</table>`
    : '<p class="sm">No failures recorded on our side in the last 7 days.</p>';

  const red = s.services.filter((r) => r.state === 'failed').length;
  const grey = s.services.filter((r) => r.state === 'unchecked').length;
  const head = s.readErrors.length
    ? ['bad', `This page could not read everything: ${s.readErrors.length} read(s) failed. The tables below may be incomplete.`]
    : red ? ['bad', `${red} service(s) failing.`]
      : grey ? ['warnb', `${grey} service(s) have never been checked. Run the preflight: /api/admin/scripts/preflight?text=1`]
        : ['goodb', 'Every service answered its last check.'];

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>System status</title>
<style>
 body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:24px 16px;max-width:1100px;color:#111;background:#fff}
 h1{font-size:19px;margin:0 0 4px} h3{margin:26px 0 8px}
 .sub,.sm{color:#666;font-size:12.5px}
 .wrap{overflow-x:auto}
 table{border-collapse:collapse;width:100%;margin-bottom:8px}
 th,td{border-bottom:1px solid #e6e9ef;padding:7px 9px;text-align:left;font-size:13px;vertical-align:top}
 th{background:#f7f9fc;font-weight:600}
 .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
 .dot.ok{background:#1f9d55} .dot.failed{background:#d64545} .dot.unchecked{background:#aab}
 tr.failed td{background:#fdf1f1} tr.warn td{background:#fffaf0}
 .err{color:#a11;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word}
 .bad{color:#b22;font-weight:600} .good{color:#1f7a45}
 .banner{padding:12px 14px;border-radius:8px;margin:14px 0 6px}
 .banner.bad{background:#fdecec;border:1px solid #f2c2c2;font-weight:600}
 .banner.warnb{background:#fff8e6;border:1px solid #f0dda6}
 .banner.goodb{background:#f2f9ec;border:1px solid #cfe4b6}
 code{background:#f3f5f9;padding:1px 5px;border-radius:4px}
</style>
<h1>System status</h1>
<div class="sub">Generated ${esc(s.at.replace('T', ' ').slice(0, 16))} UTC. Read only. JSON: <code>/api/admin/status</code></div>
<div class="banner ${head[0]}">${esc(head[1])}</div>
${s.readErrors.length ? `<div class="err">${s.readErrors.map(esc).join('\n')}</div>` : ''}

<h3>External services</h3>
<div class="sub">From the preflight that runs before each night's job. Grey means never checked, which is not the same as working.</div>
<div class="wrap"><table><tr><th>service</th><th>last checked</th><th>time</th><th>provider's error / what breaks</th></tr>${svc}</table></div>

<h3>Agents, last 7 nights</h3>
<div class="wrap"><table><tr><th>night</th><th>preflight</th><th>agents run</th><th>cards</th><th>agents with 0 cards</th><th>athletes hit by our failures</th><th>market builds</th><th>digests</th><th>spend</th></tr>${agentRows}</table></div>

<h3>Universities, last 7 nights</h3>
<div class="wrap"><table><tr><th>night</th><th>sponsor asks</th></tr>${univRows}</table></div>
<h3>Athletics departments with no sponsor ask in 7 days</h3>
<div class="wrap">${quiet}</div>

<h3>Failures on our side, last 7 days</h3>
<div class="sub">Recorded by the one rule (services/ourFault). None of these were cached or counted as a fact about a market.</div>
<div class="wrap">${faults}</div>`;
}

module.exports = { collect, renderHtml, SERVICES, DAYS };
