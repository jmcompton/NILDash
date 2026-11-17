'use strict';
// ── LAST NIGHT, ATHLETE BY ATHLETE (/admin/night-report) ────────────────────
//
// The status page counts "athletes hit by our failures" and "agents with 0
// cards" but never says which athletes or why. Every answer was already on
// the run row (outreach_queue_runs.details): cards filled, the named reason a
// night came up empty, the note, and our own failures with the service and the
// provider's words (nightFaults). This reads it and shows it. Read only.

const REASON_WORDS = {
  'our-fault': 'our failure, not the market',
};

async function nights(pool, { days = 3 } = {}) {
  const rows = (await pool.query(
    `SELECT r.run_date, r.agent_id, r.filled, r.note, r.details, u.name, u.email
       FROM outreach_queue_runs r LEFT JOIN users u ON u.id = r.agent_id
      WHERE r.run_date > CURRENT_DATE - $1::int
      ORDER BY r.run_date DESC, COALESCE(r.filled, 0) DESC, u.name`, [Math.max(1, Math.min(14, days))])).rows;
  const out = [];
  for (const r of rows) {
    const det = Array.isArray(r.details) ? r.details : [];
    const athletes = det.filter((d) => d && d.athleteId).map((d) => ({
      name: d.athleteName || d.athleteId,
      filled: Number(d.filled) || 0,
      reason: d.emptyReason || d.skipped || null,
      note: d.note || null,
      paused: !!d.paused,
      faults: (Array.isArray(d.nightFaults) ? d.nightFaults : []).map((f) => `${f.service || 'service'}: ${String(f.reason || '').slice(0, 200)}`),
      schoolProblem: d.schoolProblem || null,
    }));
    out.push({ night: String(r.run_date instanceof Date ? r.run_date.toISOString().slice(0, 10) : r.run_date).slice(0, 10),
      agent: r.name || r.email || r.agent_id, filled: Number(r.filled) || 0, note: r.note || null, athletes });
  }
  return out;
}

// Why athletes came up empty, counted. -> [[reason, n]]
function tally(list) {
  const c = new Map();
  for (const n of list) for (const a of n.athletes) {
    if (a.filled > 0) continue;
    const k = a.faults.length ? 'our failure: ' + a.faults[0].split(':')[0] : (a.reason || (a.paused ? 'paused' : 'no reason recorded'));
    c.set(k, (c.get(k) || 0) + 1);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

function renderHtml(list) {
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
  const byNight = new Map();
  for (const n of list) { if (!byNight.has(n.night)) byNight.set(n.night, []); byNight.get(n.night).push(n); }
  let body = '';
  for (const [night, agents] of byNight) {
    const t = tally(agents);
    body += `<h2>${esc(night)}</h2><div class="sum">${agents.reduce((s, a) => s + a.filled, 0)} cards across ${agents.length} agents. Empty athletes: ${t.map(([k, v]) => `${v} ${esc(REASON_WORDS[k] || k)}`).join(', ') || 'none'}</div>`;
    for (const a of agents) {
      if (!a.athletes.length && !a.note) continue;
      body += `<div class="ag"><div class="h">${esc(a.agent)} <span class="n">${a.filled} card${a.filled === 1 ? '' : 's'}</span></div>${a.note ? `<div class="m">${esc(a.note)}</div>` : ''}`;
      for (const x of a.athletes) {
        body += `<div class="at${x.filled ? '' : ' empty'}"><b>${esc(x.name)}</b>: ${x.filled} card${x.filled === 1 ? '' : 's'}${x.reason ? `, ${esc(REASON_WORDS[x.reason] || x.reason)}` : ''}${x.schoolProblem ? `, school: ${esc(x.schoolProblem)}` : ''}
          ${x.note ? `<div class="m">${esc(x.note)}</div>` : ''}${x.faults.map((f) => `<div class="f">${esc(f)}</div>`).join('')}</div>`;
      }
      body += '</div>';
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Night report</title>
<style>body{margin:0;background:#0F1A14;color:#E8EFEA;font:14px/1.5 system-ui,Arial,sans-serif}.w{max-width:980px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0}h2{font-size:17px;margin:26px 0 4px}
.sum{color:#C8F135;margin-bottom:8px}.ag{border-top:1px solid #24382B;padding:10px 0}.h{font-weight:700}.n{color:#9FB1A6;font-weight:400;margin-left:6px}.at{padding:4px 0 4px 12px}.empty b{color:#F6C177}
.m{color:#9FB1A6;font-size:12px}.f{color:#F28B82;font-size:12px}</style></head><body><div class="w"><h1>Night report</h1>
<div class="m">Each night, each agent, each athlete: cards filled and, for an empty athlete, why. Read only.</div>${body || '<p class="m">No runs recorded.</p>'}</div></body></html>`;
}

module.exports = { nights, tally, renderHtml };
