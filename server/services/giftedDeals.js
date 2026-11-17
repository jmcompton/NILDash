'use strict';
// ── GIFTED DEALS AND THE ATHLETE'S NIL REPORT ───────────────────────────────
//
// A lot of an athlete's NIL is product, not cash: a blanket company sends a
// blanket, the athlete posts it on a story. Nothing tracked it, so at the end
// of the year nobody could say what the athlete received, and a family had no
// number for their tax preparer. (An agent asked for exactly this: log the
// gifts, and a yearly report; monthly too.)
//
//   gifted_deals   one row per gift: brand, product, retail value, the day it
//                  arrived, what the athlete posted and where, a link to it
//
// THE REPORT, per athlete, for a month or a year: cash deals (signed deals the
// agent logged, with what was paid when it is known) and gifted product, with
// totals and the businesses whose total for the period reached $600. Printable,
// so the agent can save it as a PDF and send it to the family.
//
// WHAT IT DOES NOT SAY. It gives totals, not tax or eligibility advice: product
// can be taxable at its value, and whether a gift counts toward NIL Go's $600
// is for the school's compliance office. The report says both plainly.

const THRESHOLD = 600;
const PLATFORMS = ['instagram story', 'instagram post', 'tiktok', 'x', 'youtube', 'facebook', 'other', 'not posted yet'];

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS gifted_deals (
    id           SERIAL PRIMARY KEY,
    agent_id     TEXT NOT NULL,
    athlete_id   TEXT NOT NULL,
    brand        TEXT NOT NULL,
    product      TEXT,
    retail_value NUMERIC,
    received_on  DATE NOT NULL DEFAULT CURRENT_DATE,
    platform     TEXT,
    posted       TEXT,
    post_url     TEXT,
    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS gifted_deals_athlete_idx ON gifted_deals (athlete_id, received_on DESC)`);
}

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
function money(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= 10000000 ? Math.round(n * 100) / 100 : NaN;
}
function day(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : NaN;
}

async function ownsAthlete(pool, agentId, athleteId) {
  return !!(await pool.query(`SELECT 1 FROM athletes WHERE id = $1 AND agent_id = $2`, [String(athleteId || ''), agentId])).rows[0];
}

// -> { ok, gift } | { ok:false, status, error }
async function add(pool, agentId, b = {}) {
  await ensureTables(pool);
  if (!(await ownsAthlete(pool, agentId, b.athleteId))) return { ok: false, status: 404, error: 'Pick one of your athletes.' };
  const brand = clean(b.brand, 120);
  if (brand.length < 2) return { ok: false, status: 400, error: 'Enter the brand.' };
  const value = money(b.retailValue);
  if (Number.isNaN(value)) return { ok: false, status: 400, error: 'Enter the retail value in dollars.' };
  const received = b.receivedOn ? day(b.receivedOn) : new Date().toISOString().slice(0, 10);
  if (Number.isNaN(received)) return { ok: false, status: 400, error: 'Enter the date it arrived.' };
  const platform = b.platform ? clean(b.platform, 40).toLowerCase() : null;
  if (platform && !PLATFORMS.includes(platform)) return { ok: false, status: 400, error: 'Pick where it was posted.' };
  let url = clean(b.postUrl, 500) || null;
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const r = await pool.query(
    `INSERT INTO gifted_deals (agent_id, athlete_id, brand, product, retail_value, received_on, platform, posted, post_url, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [agentId, String(b.athleteId), brand, clean(b.product, 160) || null, value, received, platform, clean(b.posted, 300) || null, url, clean(b.notes, 500) || null]);
  return { ok: true, gift: shape(r.rows[0]) };
}

async function remove(pool, agentId, id) {
  await ensureTables(pool);
  const r = await pool.query(`DELETE FROM gifted_deals WHERE id = $1 AND agent_id = $2`, [Number(id) || 0, agentId]);
  return r.rowCount ? { ok: true } : { ok: false, status: 404, error: 'Not found.' };
}

function shape(g) {
  return { id: g.id, athleteId: g.athlete_id, brand: g.brand, product: g.product, retailValue: g.retail_value == null ? null : Number(g.retail_value),
    receivedOn: g.received_on instanceof Date ? g.received_on.toISOString().slice(0, 10) : String(g.received_on).slice(0, 10),
    platform: g.platform, posted: g.posted, postUrl: g.post_url, notes: g.notes };
}

// A period from "2026" or "2026-11". -> { label, start, end } | null
function periodOf(p) {
  const s = String(p || '').trim();
  let m = s.match(/^(\d{4})$/);
  if (m) return { kind: 'year', label: m[1], start: `${m[1]}-01-01`, end: `${+m[1] + 1}-01-01` };
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    const y = +m[1], mo = +m[2];
    const end = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
    const label = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return { kind: 'month', label, start: `${y}-${String(mo).padStart(2, '0')}-01`, end };
  }
  return null;
}

// The athlete's report for a period. -> report | null
async function report(pool, agentId, athleteId, period) {
  await ensureTables(pool);
  const per = periodOf(period);
  if (!per) return { error: 'Pick a month (2026-11) or a year (2026).' };
  const a = (await pool.query(`SELECT id, data FROM athletes WHERE id = $1 AND agent_id = $2`, [String(athleteId || ''), agentId])).rows[0];
  if (!a) return null;
  const agent = (await pool.query(`SELECT name, email FROM users WHERE id = $1`, [agentId])).rows[0] || {};
  const gifts = (await pool.query(`SELECT * FROM gifted_deals WHERE athlete_id = $1 AND agent_id = $2 AND received_on >= $3 AND received_on < $4 ORDER BY received_on, id`,
    [a.id, agentId, per.start, per.end])).rows.map(shape);
  // Cash deals: every signed deal logged (deal_outcomes), plus a signed Pipeline
  // deal never logged. Paid amounts from the Pipeline when recorded.
  const logged = (await pool.query(
    `SELECT o.brand, o.deal_value, o.deliverable, o.closed_at, o.deal_id, d.amount_received, d.paid_date
       FROM deal_outcomes o LEFT JOIN athlete_self_deals d ON d.id::text = o.deal_id
      WHERE o.athlete_id = $1 AND o.agent_id = $2 AND o.closed_at >= $3 AND o.closed_at < $4 ORDER BY o.closed_at`,
    [a.id, agentId, per.start, per.end])).rows;
  const loggedIds = new Set(logged.map((x) => String(x.deal_id || '')).filter(Boolean));
  const pipe = (await pool.query(
    `SELECT d.id, d.brand_name, d.value, d.deliverables, d.amount_received, d.paid_date,
            COALESCE(to_jsonb(d)->>'nil_go_signed_at', CASE WHEN to_jsonb(d)->>'crm_stage' IN ('contract_signed','filed_nil_go','cleared','paid') THEN to_jsonb(d)->>'crm_stage_at' END) AS signed_at
       FROM athlete_self_deals d
      WHERE d.athlete_id = $1 AND d.agent_id = $2`, [a.id, agentId])).rows
    .filter((d) => d.signed_at && d.signed_at.slice(0, 10) >= per.start && d.signed_at.slice(0, 10) < per.end && !loggedIds.has(String(d.id)));
  const cash = logged.map((x) => ({ brand: x.brand, value: x.deal_value == null ? null : Number(x.deal_value), received: x.amount_received == null ? null : Number(x.amount_received),
    what: x.deliverable || null, date: new Date(x.closed_at).toISOString().slice(0, 10) }))
    .concat(pipe.map((d) => ({ brand: d.brand_name, value: d.value == null ? null : Number(d.value), received: d.amount_received == null ? null : Number(d.amount_received),
      what: d.deliverables || null, date: d.signed_at.slice(0, 10) })))
    .sort((x, y) => x.date.localeCompare(y.date));
  const sum = (arr, k) => Math.round(arr.reduce((s, x) => s + (Number(x[k]) || 0), 0) * 100) / 100;
  const byBrand = new Map();
  for (const c of cash) byBrand.set(c.brand, (byBrand.get(c.brand) || 0) + (c.value || 0));
  for (const g of gifts) byBrand.set(g.brand, (byBrand.get(g.brand) || 0) + (g.retailValue || 0));
  const over = [...byBrand.entries()].filter(([, v]) => v >= THRESHOLD).map(([brand, total]) => ({ brand, total: Math.round(total * 100) / 100 }));
  return {
    athlete: { id: a.id, name: (a.data && a.data.name) || 'Athlete', school: (a.data && a.data.school) || null, sport: (a.data && a.data.sport) || null },
    agent: { name: agent.name || null, email: agent.email || null },
    period: per, cash, gifts,
    totals: { cashSigned: sum(cash, 'value'), cashReceived: sum(cash, 'received'), giftedValue: sum(gifts, 'retailValue'), gifts: gifts.length, deals: cash.length,
      unvaluedGifts: gifts.filter((g) => g.retailValue == null).length },
    overThreshold: over,
  };
}

function renderHtml(r) {
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const $ = (n) => (n == null ? 'not set' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const t = r.totals;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.athlete.name)} NIL report, ${esc(r.period.label)}</title>
<style>body{margin:0;background:#fff;color:#111827;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}.w{max-width:820px;margin:0 auto;padding:32px 20px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:26px 0 8px}.sub{color:#6b7280}.tiles{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.tile{flex:1;min-width:150px;border:1px solid #e5e7eb;border-radius:8px;padding:12px}
.v{font-size:20px;font-weight:700}.l{color:#6b7280;font-size:12px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #f3f4f6;vertical-align:top}th{color:#6b7280;font-weight:600}
.note{font-size:12px;color:#6b7280;margin-top:22px;border-top:1px solid #e5e7eb;padding-top:12px}.print{margin-top:18px}@media print{.print{display:none}}</style></head><body><div class="w">
<h1>${esc(r.athlete.name)}: NIL report</h1>
<div class="sub">${esc(r.period.label)}${r.athlete.school ? ' · ' + esc(r.athlete.school) : ''}${r.athlete.sport ? ' · ' + esc(r.athlete.sport) : ''}${r.agent.name ? ' · Prepared by ' + esc(r.agent.name) : ''}</div>
<div class="tiles"><div class="tile"><div class="v">${$(t.cashSigned)}</div><div class="l">cash deals signed (${t.deals})</div></div>
<div class="tile"><div class="v">${$(t.cashReceived)}</div><div class="l">cash received, where recorded</div></div>
<div class="tile"><div class="v">${$(t.giftedValue)}</div><div class="l">gifted product, retail value (${t.gifts})</div></div></div>
<h2>Cash deals</h2>${r.cash.length ? `<table><tr><th>Date</th><th>Business</th><th>Deal</th><th>Amount</th><th>Received</th></tr>${r.cash.map((c) => row([esc(c.date), esc(c.brand), esc(c.what || ''), $(c.value), c.received == null ? '' : $(c.received)])).join('')}</table>` : '<div class="sub">None in this period.</div>'}
<h2>Gifted product</h2>${r.gifts.length ? `<table><tr><th>Arrived</th><th>Brand</th><th>Product</th><th>Retail value</th><th>Posted</th></tr>${r.gifts.map((g) => row([esc(g.receivedOn), esc(g.brand), esc(g.product || ''), $(g.retailValue),
    esc([g.platform, g.posted].filter(Boolean).join(': ')) + (g.postUrl ? ` <a href="${esc(g.postUrl)}">link</a>` : '')])).join('')}</table>` : '<div class="sub">None in this period.</div>'}
${r.overThreshold.length ? `<h2>Businesses at $600 or more this period</h2><div>${r.overThreshold.map((o) => esc(o.brand) + ': ' + $(o.total)).join('<br>')}</div>` : ''}
<div class="note">Totals only, not tax or eligibility advice. Gifted product can be taxable income at its value: share this with your tax preparer. Whether a gift counts toward NIL Go's $600 reporting line is a question for the school's compliance office.${t.unvaluedGifts ? ` ${t.unvaluedGifts} gift${t.unvaluedGifts === 1 ? ' has' : 's have'} no retail value entered.` : ''}</div>
<button class="print" onclick="window.print()">Print or save as PDF</button>
</div></body></html>`;
}

module.exports = { ensureTables, add, remove, list: async (pool, agentId, athleteId) => { await ensureTables(pool); return (await pool.query(`SELECT * FROM gifted_deals WHERE agent_id = $1 ${athleteId ? 'AND athlete_id = $2' : ''} ORDER BY received_on DESC, id DESC LIMIT 300`, athleteId ? [agentId, String(athleteId)] : [agentId])).rows.map(shape); },
  periodOf, report, renderHtml, PLATFORMS, THRESHOLD };
