'use strict';
// ── RESULTS: WHAT THE WORK TURNED INTO ──────────────────────────────────────
//
// NILDash could not prove it works. Every piece was recorded somewhere (the
// sends and follow-ups in outreach_logs, the replies stamped on them, the
// reply read by replyAutopilot, the signed deal in deal_outcomes) but nothing
// counted the chain. Without the count there is no number for an agent, a
// parent, the website or a sales call.
//
// ONE DEFINITION, used by the agent's Home, the admin page and anything else:
//
//   pitched      first emails that actually went out (touch 1, sent_at set)
//   businesses   distinct businesses those went to
//   followUps    follow-up emails that actually went out (touch 2 and 3)
//   replies      conversations with a reply (any touch), counted once
//   interested   of those, the reply read as interested or a question
//   afterFollow  of those, the reply came after a follow-up had gone out
//   deals        deals logged as signed (deal_outcomes)
//   dollars      their signed value (a deal with no value counts as a deal,
//                adds nothing to dollars)
//   waiting      follow-ups written and due, not sent, not stopped: what is
//                sitting on the agent's approval (not windowed)
//
// A WINDOW counts each event by its own date: a send by sent_at, a reply by
// when it came, a deal by closed_at. So "last 30 days" can show a reply to a
// pitch sent 40 days ago, which is the truth of the 30 days.
//
// READ ONLY. Counts only real agent accounts (role 'agent', not archived);
// team members act as their owner and are never a row of their own.

const DAY = 86400000;
const INTERESTED = ['interested', 'question'];

function sinceOf(days) {
  const d = Number(days);
  return d > 0 ? new Date(Date.now() - d * DAY) : null;
}

// Filters shared by every query. -> { where, params }
function scope({ agentId, athleteId, since, until } = {}, alias, timeCol, startAt = 1) {
  const w = [], p = [];
  const add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + (startAt + p.length - 1))); };
  if (agentId) add(`${alias}.agent_id = ?`, String(agentId));
  if (athleteId) add(`${alias}.athlete_id = ?`, String(athleteId));
  if (since && timeCol) add(`${timeCol} >= ?`, since);
  if (until && timeCol) add(`${timeCol} < ?`, until);
  return { where: w.length ? ' AND ' + w.join(' AND ') : '', params: p };
}

const AGENTS = `JOIN users u ON u.id = l.agent_id AND u.role = 'agent' AND COALESCE(u.archived, false) = false`;

// Per agent (or one row for everything). opts: { since, until, agentId, athleteId, byAgent }
async function counts(pool, opts = {}) {
  const by = opts.byAgent ? 'l.agent_id' : `'all'`;
  const empty = () => ({ pitched: 0, businesses: 0, followUps: 0, replies: 0, interested: 0, afterFollow: 0, deals: 0, dollars: 0, waiting: 0 });
  const out = new Map();
  const row = (k) => { if (!out.has(k)) out.set(k, empty()); return out.get(k); };

  // Sends: first emails and follow-ups.
  {
    const s = scope(opts, 'l', 'l.sent_at');
    const r = await pool.query(
      `SELECT ${by} AS k,
              COUNT(*) FILTER (WHERE COALESCE(l.touch_no, 1) = 1)::int AS pitched,
              COUNT(DISTINCT COALESCE(NULLIF(l.brand_key, ''), LOWER(TRIM(l.brand_name)))) FILTER (WHERE COALESCE(l.touch_no, 1) = 1)::int AS businesses,
              COUNT(*) FILTER (WHERE COALESCE(l.touch_no, 1) > 1)::int AS follow_ups
         FROM outreach_logs l ${AGENTS}
        WHERE l.sent_at IS NOT NULL${s.where}
        GROUP BY 1`, s.params);
    for (const x of r.rows) Object.assign(row(x.k), { pitched: x.pitched, businesses: x.businesses, followUps: x.follow_ups });
  }

  // Replies: one per conversation (the root and its follow-ups), dated by the
  // first reply. afterFollow: a follow-up in that conversation went out first.
  {
    const s = scope({ ...opts, since: null, until: null }, 'l', null);
    const params = s.params.slice();
    let win = '';
    if (opts.since) { params.push(opts.since); win += ` AND c.first_reply >= $${params.length}`; }
    if (opts.until) { params.push(opts.until); win += ` AND c.first_reply < $${params.length}`; }
    const r = await pool.query(
      `WITH c AS (
         SELECT l.agent_id, COALESCE(l.parent_id, l.id) AS root,
                MIN(l.replied_at) AS first_reply,
                BOOL_OR((to_jsonb(l)->>'reply_intent') = ANY($${params.length + 1}::text[])) AS interested,
                MIN(l.sent_at) FILTER (WHERE COALESCE(l.touch_no, 1) > 1) AS first_follow
           FROM outreach_logs l ${AGENTS}
          WHERE (l.sent_at IS NOT NULL OR l.replied_at IS NOT NULL)${s.where}
          GROUP BY 1, 2
         HAVING MIN(l.replied_at) IS NOT NULL)
       SELECT ${opts.byAgent ? 'c.agent_id' : `'all'`} AS k, COUNT(*)::int AS replies,
              COUNT(*) FILTER (WHERE c.interested)::int AS interested,
              COUNT(*) FILTER (WHERE c.first_follow IS NOT NULL AND c.first_follow < c.first_reply)::int AS after_follow
         FROM c WHERE true${win}
        GROUP BY 1`, params.concat([INTERESTED]));
    for (const x of r.rows) Object.assign(row(x.k), { replies: x.replies, interested: x.interested, afterFollow: x.after_follow });
  }

  // Deals signed and their value.
  {
    const s = scope(opts, 'd', 'd.closed_at');
    const r = await pool.query(
      `SELECT ${opts.byAgent ? 'd.agent_id' : `'all'`} AS k, COUNT(*)::int AS deals, COALESCE(SUM(d.deal_value), 0)::float AS dollars
         FROM deal_outcomes d JOIN users u ON u.id = d.agent_id AND u.role = 'agent' AND COALESCE(u.archived, false) = false
        WHERE true${s.where}
        GROUP BY 1`, s.params);
    for (const x of r.rows) Object.assign(row(x.k), { deals: x.deals, dollars: Math.round(x.dollars) });
  }

  // Follow-ups written and waiting on the agent (now, not windowed).
  {
    const s = scope({ ...opts, since: null, until: null }, 'l', null);
    const r = await pool.query(
      `SELECT ${by} AS k, COUNT(*)::int AS waiting
         FROM outreach_logs l ${AGENTS}
        WHERE COALESCE(l.touch_no, 1) > 1 AND l.sent_at IS NULL AND l.status = 'draft'
          AND l.cadence_stopped_at IS NULL AND COALESCE(l.body_html, '') <> ''${s.where}
        GROUP BY 1`, s.params);
    for (const x of r.rows) row(x.k).waiting = x.waiting;
  }
  return out;
}

// Rates that mean something only with a base under them.
function rates(c) {
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
  return { replyRate: pct(c.replies, c.businesses), followShare: pct(c.afterFollow, c.replies) };
}

// One agent (or one athlete), for Home: last 30 days and all time.
async function forAgent(pool, agentId, { athleteId = null, days = 30 } = {}) {
  const recent = (await counts(pool, { agentId, athleteId, since: sinceOf(days) })).get('all') || (await blank());
  const all = (await counts(pool, { agentId, athleteId })).get('all') || (await blank());
  return { days, recent: { ...recent, ...rates(recent) }, allTime: { ...all, ...rates(all) } };
}
async function blank() { return { pitched: 0, businesses: 0, followUps: 0, replies: 0, interested: 0, afterFollow: 0, deals: 0, dollars: 0, waiting: 0 }; }

// The whole platform, for the admin page: totals, per agent, and by week.
async function platform(pool, { days = 30, weeks = 8 } = {}) {
  const since = sinceOf(days);
  const total = (await counts(pool, { since })).get('all') || (await blank());
  const allTime = (await counts(pool, {})).get('all') || (await blank());
  const per = await counts(pool, { since: null, byAgent: true });
  const recent = await counts(pool, { since, byAgent: true });
  const ids = [...new Set([...per.keys(), ...recent.keys()])];
  const names = ids.length ? (await pool.query(`SELECT id, name, email FROM users WHERE id = ANY($1::text[])`, [ids])).rows : [];
  const nameOf = new Map(names.map((u) => [u.id, u.name || u.email || u.id]));
  const agents = ids.map((id) => ({ id, name: nameOf.get(id) || id, recent: recent.get(id) || null, allTime: per.get(id) }))
    .sort((a, b) => (b.allTime.replies - a.allTime.replies) || (b.allTime.pitched - a.allTime.pitched));
  // Weeks, newest first, Monday to Monday (UTC).
  const byWeek = [];
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  for (let i = 0; i < weeks; i++) {
    const start = new Date(monday.getTime() - i * 7 * DAY), end = new Date(start.getTime() + 7 * DAY);
    const c = (await counts(pool, { since: start, until: end })).get('all') || (await blank());
    byWeek.push({ week: start.toISOString().slice(0, 10), ...c });
  }
  return { days, total: { ...total, ...rates(total) }, allTime: { ...allTime, ...rates(allTime) }, agents, byWeek };
}

module.exports = { counts, forAgent, platform, rates, INTERESTED };

// ── THE ADMIN PAGE (/admin/results) ─────────────────────────────────────────
function renderHtml(d) {
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const n = (x) => Number(x || 0).toLocaleString('en-US');
  const pct = (x) => (x == null ? '-' : x + '%');
  const cells = (c) => c
    ? `<td>${n(c.businesses)}</td><td>${n(c.pitched)}</td><td>${n(c.followUps)}</td><td>${n(c.replies)}</td><td>${n(c.interested)}</td><td>${n(c.afterFollow)}</td><td>${n(c.deals)}</td><td>$${n(c.dollars)}</td>`
    : '<td colspan="8" class="dim">nothing in the window</td>';
  const head = '<th>businesses</th><th>first emails</th><th>follow-ups</th><th>replies</th><th>interested</th><th>reply after a follow-up</th><th>deals</th><th>$ signed</th>';
  const tile = (label, v) => `<div class="tile"><div class="v">${v}</div><div class="l">${esc(label)}</div></div>`;
  const t = d.total, a = d.allTime;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Results</title>
<style>body{margin:0;background:#0F1A14;color:#E8EFEA;font:14px/1.45 system-ui,-apple-system,Segoe UI,Arial,sans-serif}.w{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}.sub{color:#9FB1A6;font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:16px}.tile{background:#16241C;border:1px solid #24382B;border-radius:10px;padding:12px}
.v{font-size:24px;font-weight:700;color:#C8F135}.l{color:#9FB1A6;font-size:12px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #24382B;white-space:nowrap}th{color:#9FB1A6;font-weight:600}.dim{color:#6E8476}</style></head><body><div class="w">
<h1>Results</h1><div class="sub">What the work turned into. Real agent accounts only. Each event counted by its own date. Read only.</div>
<h2>Last ${d.days} days</h2><div class="tiles">
${tile('businesses pitched', n(t.businesses))}${tile('follow-ups sent', n(t.followUps))}${tile('replies', n(t.replies))}${tile('reply rate', pct(t.replyRate))}${tile('replies after a follow-up', pct(t.followShare))}${tile('deals signed', n(t.deals))}${tile('$ signed', '$' + n(t.dollars))}${tile('follow-ups waiting on agents', n(a.waiting))}</div>
<h2>All time</h2><div class="tiles">
${tile('businesses pitched', n(a.businesses))}${tile('follow-ups sent', n(a.followUps))}${tile('replies', n(a.replies))}${tile('reply rate', pct(a.replyRate))}${tile('replies after a follow-up', pct(a.followShare))}${tile('deals signed', n(a.deals))}${tile('$ signed', '$' + n(a.dollars))}</div>
<h2>By week</h2><div class="scroll"><table><tr><th>week of</th>${head}</tr>
${d.byWeek.map((w) => `<tr><td>${esc(w.week)}</td>${cells(w)}</tr>`).join('')}</table></div>
<h2>By agent, all time</h2><div class="scroll"><table><tr><th>agent</th>${head}<th>waiting</th></tr>
${d.agents.map((x) => `<tr><td>${esc(x.name)}</td>${cells(x.allTime)}<td>${n(x.allTime.waiting)}</td></tr>`).join('') || '<tr><td colspan="10" class="dim">No sends yet.</td></tr>'}</table></div>
</div></body></html>`;
}

module.exports.renderHtml = renderHtml;
