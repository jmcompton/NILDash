'use strict';
// ── THE OFFER BOARD ─────────────────────────────────────────────────────────
//
// Every school's offer for one client, in one place, compared the way a
// family should compare them: guaranteed money first. An agent logs what each
// school put on the table; the board totals it, sorts it, and checks each one
// against the Protect College Sports Act before anyone signs.
//
//   GUARANTEED  the school's own revenue-share money, per year. Under the
//               House settlement this comes from the school, so it is the
//               money that is there if things go sideways.
//   NIL         money from a collective, a booster or a business. Under the
//               PCSA it needs a real business purpose (work named) and, from
//               a collective or a big booster, pay in line with comparable
//               players. Not in writing = not real yet.
//   TERM        years. A deal cannot run past his eligibility.
//   FEE         the agent's fee on endorsement money is capped at 5%.
//
// Agent data, scoped to the agent who wrote it, for his own athlete. Nothing
// here is shared with anyone else, and nothing is sent: the family update is
// text for the agent to send himself.

const crypto = require('crypto');
const Schools = require('./schools');

const STATUSES = ['talking', 'offered', 'in_writing', 'declined', 'committed'];
const PAYERS = ['collective', 'business', 'booster', 'school', 'none'];
const FEE_CAP = 0.05;

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS portal_offers (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, athlete_id TEXT NOT NULL,
    school TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'offered',
    guaranteed_per_year INT, nil_per_year INT, nil_payer TEXT, nil_deliverables TEXT,
    years INT DEFAULT 1, in_writing BOOLEAN DEFAULT FALSE, expires_on DATE,
    conditions TEXT, notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  // The day he committed: the PCSA report clock (5 days) starts here.
  await pool.query(`ALTER TABLE portal_offers ADD COLUMN IF NOT EXISTS signed_on DATE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_portal_offers_owner ON portal_offers (agent_id, athlete_id)`);
}

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
const money = (v) => {
  if (v == null || v === '') return null;
  const n = Math.round(Number(String(v).replace(/[$,\s]/g, '')));
  if (!Number.isFinite(n) || n < 0 || n > 50_000_000) throw bad('Money must be a dollar amount.');
  return n;
};
// A real calendar date or null. "2026-02-30" passes a pattern and then
// crashes Postgres, so it has to round-trip.
const realDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const clip = (s, n) => (s == null || String(s).trim() === '' ? null : String(s).trim().slice(0, n));

function clean(b = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || b.school !== undefined) {
    const s = Schools.canonical(b.school) || clip(b.school, 80);
    if (!s) throw bad('Which school made the offer?');
    out.school = s;
  }
  if (!partial || b.status !== undefined) {
    const st = String(b.status || 'offered');
    if (!STATUSES.includes(st)) throw bad('Unknown status.');
    out.status = st;
  }
  if (!partial || b.guaranteedPerYear !== undefined) out.guaranteed_per_year = money(b.guaranteedPerYear);
  if (!partial || b.nilPerYear !== undefined) out.nil_per_year = money(b.nilPerYear);
  if (!partial || b.nilPayer !== undefined) {
    const p = b.nilPayer ? String(b.nilPayer) : null;
    if (p && !PAYERS.includes(p)) throw bad('Unknown NIL payer.');
    out.nil_payer = p;
  }
  if (!partial || b.nilDeliverables !== undefined) out.nil_deliverables = clip(b.nilDeliverables, 500);
  if (!partial || b.years !== undefined) {
    const y = b.years == null || b.years === '' ? 1 : parseInt(b.years, 10);
    if (!Number.isFinite(y) || y < 1 || y > 6) throw bad('Years must be 1 to 6.');
    out.years = y;
  }
  if (!partial || b.inWriting !== undefined) out.in_writing = !!b.inWriting;
  if (!partial || b.expiresOn !== undefined) {
    const d = b.expiresOn ? String(b.expiresOn) : null;
    if (d && !realDate(d)) throw bad('Expiry must be a real date.');
    out.expires_on = d;
  }
  if (out.status === 'in_writing') out.in_writing = true;
  if (b.signedOn !== undefined) {
    const d = b.signedOn ? String(b.signedOn) : null;
    if (d && !realDate(d)) throw bad('Signing date must be a real date.');
    out.signed_on = d;
  }
  if (!partial || b.conditions !== undefined) out.conditions = clip(b.conditions, 500);
  if (!partial || b.notes !== undefined) out.notes = clip(b.notes, 1000);
  return out;
}

function shape(r) {
  return {
    id: r.id, school: r.school, status: r.status,
    guaranteedPerYear: r.guaranteed_per_year, nilPerYear: r.nil_per_year, nilPayer: r.nil_payer,
    nilDeliverables: r.nil_deliverables, years: r.years || 1, inWriting: !!r.in_writing,
    expiresOn: r.expires_on ? (r.expires_on instanceof Date ? r.expires_on.toISOString().slice(0, 10) : String(r.expires_on).slice(0, 10)) : null,
    conditions: r.conditions, notes: r.notes, updatedAt: r.updated_at,
    signedOn: r.signed_on ? (r.signed_on instanceof Date ? r.signed_on.toISOString().slice(0, 10) : String(r.signed_on).slice(0, 10)) : null,
  };
}

async function list(pool, agentId, athleteId) {
  await ensureTable(pool);
  const r = await pool.query(`SELECT * FROM portal_offers WHERE agent_id = $1 AND athlete_id = $2 ORDER BY created_at`, [agentId, athleteId]);
  return r.rows.map(shape);
}

async function create(pool, agentId, athleteId, body) {
  await ensureTable(pool);
  const c = clean(body);
  const n = await pool.query(`SELECT COUNT(*)::int n FROM portal_offers WHERE agent_id = $1 AND athlete_id = $2`, [agentId, athleteId]);
  if (n.rows[0].n >= 40) throw bad('That is a lot of offers. Remove some first.');
  const id = 'po_' + crypto.randomBytes(9).toString('hex');
  if (c.status === 'committed' && !c.signed_on) c.signed_on = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  await pool.query(`INSERT INTO portal_offers (id, agent_id, athlete_id, school, status, guaranteed_per_year, nil_per_year, nil_payer, nil_deliverables, years, in_writing, expires_on, conditions, notes, signed_on)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, agentId, athleteId, c.school, c.status, c.guaranteed_per_year, c.nil_per_year, c.nil_payer, c.nil_deliverables, c.years, c.in_writing, c.expires_on, c.conditions, c.notes, c.signed_on || null]);
  return (await pool.query(`SELECT * FROM portal_offers WHERE id = $1`, [id])).rows.map(shape)[0];
}

// The WHERE carries the agent and the athlete, so an id from someone else's
// board updates nothing and comes back 404.
async function update(pool, agentId, athleteId, id, body) {
  await ensureTable(pool);
  const c = clean(body, { partial: true });
  const keys = Object.keys(c);
  if (!keys.length) throw bad('Nothing to change.');
  let sets = keys.map((k, i) => `${k} = $${i + 4}`).join(', ');
  // Committing starts the report clock (today, on a real move into committed),
  // unless a signing date was given; leaving committed clears it, so a mistake
  // undone does not leave a stale date behind. The right-hand status is the
  // row's value before this update.
  const today = `(NOW() AT TIME ZONE 'America/Chicago')::date`;
  if (c.status === 'committed' && c.signed_on === undefined) sets += `, signed_on = CASE WHEN status = 'committed' THEN COALESCE(signed_on, ${today}) ELSE ${today} END`;
  else if (c.status && c.status !== 'committed' && c.signed_on === undefined) sets += ', signed_on = NULL';
  const r = await pool.query(`UPDATE portal_offers SET ${sets}, updated_at = NOW() WHERE id = $1 AND agent_id = $2 AND athlete_id = $3 RETURNING *`,
    [String(id), agentId, athleteId, ...keys.map((k) => c[k])]);
  if (!r.rows[0]) { const e = new Error('Offer not found'); e.status = 404; throw e; }
  return shape(r.rows[0]);
}

async function remove(pool, agentId, athleteId, id) {
  await ensureTable(pool);
  const r = await pool.query(`DELETE FROM portal_offers WHERE id = $1 AND agent_id = $2 AND athlete_id = $3`, [String(id), agentId, athleteId]);
  if (!r.rowCount) { const e = new Error('Offer not found'); e.status = 404; throw e; }
  return { ok: true };
}

const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const daysUntil = (d, now) => Math.round((new Date(d + 'T23:59:00Z') - now) / 86400000);

// The checks on one offer. seasonsLeft: seasons he can play at a new school
// (from the enter check), or null when unknown.
function checks(o, { seasonsLeft = null, now = new Date() } = {}) {
  const out = [];
  const g = o.guaranteedPerYear || 0, nil = o.nilPerYear || 0;
  if (!o.inWriting && o.status !== 'declined') out.push({ level: 'flag', rule: 'writing', text: 'Not in writing yet. Until it is, it is a number on a phone call.' });
  if (nil > 0 && ['collective', 'booster'].includes(o.nilPayer) && !o.nilDeliverables) {
    out.push({ level: 'flag', rule: 'nilPurpose', text: `The ${o.nilPayer} NIL money names no work. The Protect College Sports Act requires a real business purpose: get the posts, appearances or other work in writing.` });
  } else if (nil > 0 && o.nilDeliverables) {
    out.push({ level: 'ok', rule: 'nilPurpose', text: `NIL work named: ${o.nilDeliverables}.` });
  }
  if (nil > 0 && ['collective', 'booster'].includes(o.nilPayer)) {
    out.push({ level: 'warn', rule: 'commensurate', text: 'Collective and big-booster pay has to be in line with what comparable players earn. Keep the comparable deals on file.' });
  }
  if (nil > 0 && !o.nilPayer) out.push({ level: 'warn', rule: 'payer', text: 'Who pays the NIL part? A collective, a business and the school are treated differently.' });
  if (seasonsLeft != null && (o.years || 1) > seasonsLeft) {
    out.push({ level: 'flag', rule: 'term', text: `${o.years} years offered but he has ${seasonsLeft} season${seasonsLeft === 1 ? '' : 's'} left: a deal cannot run past his eligibility.` });
  }
  if (o.expiresOn && o.status !== 'declined' && o.status !== 'committed') {
    const d = daysUntil(o.expiresOn, now);
    if (d < 0) out.push({ level: 'flag', rule: 'expires', text: `Expired ${-d} day${d === -1 ? '' : 's'} ago.` });
    else if (d <= 3) out.push({ level: 'warn', rule: 'expires', text: d === 0 ? 'Expires today.' : `Expires in ${d} day${d === 1 ? '' : 's'}.` });
  }
  if (g > 0 && nil === 0 && o.inWriting) out.push({ level: 'ok', rule: 'guarantee', text: 'All of it guaranteed by the school, in writing.' });
  if (g === 0 && nil > 0) out.push({ level: 'warn', rule: 'guarantee', text: 'Nothing guaranteed by the school: every dollar is NIL.' });
  if (nil > 0) out.push({ level: 'ok', rule: 'agentFee', text: `Agent fee on the NIL part is capped at 5%: at most ${usd(nil * FEE_CAP)} a year.` });
  return out;
}

// The board: totals, guaranteed money first, the checks, and the deadlines.
function compare(offers, { seasonsLeft = null, now = new Date(), windows = null, group = null } = {}) {
  const Value = require('./value');
  const live = offers.filter((o) => o.status !== 'declined');
  const rows = live.map((o) => {
    const years = o.years || 1;
    const g = o.guaranteedPerYear || 0, nil = o.nilPerYear || 0;
    const info = Schools.info(o.school);
    return {
      ...o, level: info ? info.level : null, conference: info ? info.conference : null,
      perYear: g + nil, guaranteedTotal: g * years, totalValue: (g + nil) * years,
      guaranteedShare: g + nil > 0 ? Math.round((g / (g + nil)) * 100) : null,
      checks: [...checks(o, { seasonsLeft, now }), ...(group && info ? [Value.place(g + nil, group, info.level)].filter(Boolean).map((x) => ({ ...x, rule: 'market' })) : [])],
    };
  });
  rows.sort((a, b) => b.guaranteedTotal - a.guaranteedTotal || b.totalValue - a.totalValue || a.school.localeCompare(b.school));
  const best = rows[0] || null;
  const mostTotal = rows.slice().sort((a, b) => b.totalValue - a.totalValue)[0] || null;
  const deadlines = rows.filter((r) => r.expiresOn && r.status !== 'committed')
    .map((r) => ({ date: r.expiresOn, text: `${r.school} offer expires`, days: daysUntil(r.expiresOn, now) }))
    .filter((d) => d.days >= -1);
  if (windows && windows.main) {
    deadlines.push({ date: windows.main.opens, text: 'Portal window opens', days: daysUntil(windows.main.opens, now) });
    deadlines.push({ date: windows.main.closes, text: 'Portal window closes', days: daysUntil(windows.main.closes, now) });
  }
  deadlines.sort((a, b) => a.date.localeCompare(b.date));
  let headline = null;
  if (best && mostTotal && best.id !== mostTotal.id && mostTotal.totalValue > best.totalValue) {
    headline = `${best.school} guarantees the most (${usd(best.guaranteedTotal)}). ${mostTotal.school} is bigger on paper (${usd(mostTotal.totalValue)}), but ${100 - (mostTotal.guaranteedShare || 0)}% of it is NIL.`;
  } else if (best && best.totalValue > 0) {
    headline = best.guaranteedTotal === best.totalValue
      ? `${best.school} leads: ${usd(best.guaranteedTotal)}, all of it guaranteed by the school.`
      : `${best.school} leads: ${usd(best.guaranteedTotal)} guaranteed, ${usd(best.totalValue)} in all.`;
  }
  const committed = rows.find((r) => r.status === 'committed') || null;
  if (committed) headline = `He committed to ${committed.school}: ${usd(committed.guaranteedTotal)} guaranteed, ${usd(committed.totalValue)} in all.`;
  return { offers: rows, declined: offers.filter((o) => o.status === 'declined'), deadlines: deadlines.filter((d) => d.days >= -1), headline, committed: committed ? committed.id : null };
}

// ── THE COMMIT PACKAGE ──────────────────────────────────────────────────────
// Once he commits: what has to happen, in order, with the dates.
function commitPackage(o, { others = [], seasonsLeft = null, now = new Date(), agentReady = null } = {}) {
  if (!o) return null;
  const pcsa = require('../pcsa');
  const items = [];
  items.push(o.inWriting
    ? { level: 'ok', text: 'The deal is in writing.' }
    : { level: 'flag', text: 'Get the final deal in writing before he signs anything else.' });
  const nil = o.nilPerYear || 0;
  if (nil > 0) {
    // Two different reports. The PCSA one counts NIL in a 12-month window (a
    // year of this deal); NIL Go takes any deal worth over $600 in all.
    const d = pcsa.disclosure({ value: nil, signedAt: o.signedOn, now });
    if (d.required) items.push({ level: d.level, text: `Protect College Sports Act report: ${d.text} Due within 5 days of signing.`, dueBy: d.dueBy || null });
    if (nil * (o.years || 1) > 600) items.push({ level: 'warn', text: `Report the deal through NIL Go: it is worth ${usd(nil * (o.years || 1))} in all, over the $600 line.` });
    if (['collective', 'booster'].includes(o.nilPayer) && !o.nilDeliverables) items.push({ level: 'flag', text: 'The NIL contract has to name the work (posts, appearances). Add it before signing.' });
    items.push({ level: 'ok', text: `Your fee on the NIL part: at most ${usd(nil * FEE_CAP)} a year (5%). Put it in the agency contract.` });
  }
  if (seasonsLeft != null && (o.years || 1) > seasonsLeft) items.push({ level: 'flag', text: `The deal runs ${o.years} years but he has ${seasonsLeft} season${seasonsLeft === 1 ? '' : 's'} left. Cut the term to his eligibility.` });
  if (agentReady === false) items.push({ level: 'flag', text: 'Finish your agent registration on the Compliance page before you sign him to anything.' });
  else if (agentReady === true) items.push({ level: 'ok', text: 'Your agent registration is on file.' });
  const rest = [...new Set(others.filter((x) => x && x !== o.school))];
  if (rest.length) items.push({ level: 'warn', text: `Let the other schools know he committed: ${rest.join(', ')}. It keeps the door open for later.` });
  items.push({ level: 'warn', text: 'Send the family the final update (below).' });
  return { school: o.school, signedOn: o.signedOn || null, items };
}

// The update for the family, as text the agent sends himself.
function familyUpdate({ athleteName, agentName, board, now = new Date() }) {
  const first = String(athleteName || 'your son').split(/\s+/)[0];
  const day = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
  const lines = [`Subject: ${first}'s portal update, ${day}`, '', `Hi ${first} and family, here is where everything stands.`, ''];
  if (!board.offers.length) lines.push('No offers on the table yet. I am talking with schools and will update you as they come in.');
  else {
    lines.push('Offers, guaranteed money first:');
    for (const o of board.offers) {
      const g = o.guaranteedPerYear ? `${usd(o.guaranteedPerYear)} a year guaranteed by the school` : 'nothing guaranteed by the school';
      const nil = o.nilPerYear ? `, plus ${usd(o.nilPerYear)} a year in NIL${o.inWriting ? '' : ' (not in writing yet)'}` : '';
      lines.push(`- ${o.school}: ${g}${nil}, ${o.years} year${o.years === 1 ? '' : 's'}.`);
    }
    if (board.headline) { lines.push(''); lines.push(board.headline); }
  }
  const soon = board.deadlines.filter((d) => d.days >= 0 && d.days <= 14);
  if (soon.length) {
    lines.push('', 'Coming up:');
    for (const d of soon) lines.push(`- ${new Date(d.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}: ${d.text}`);
  }
  lines.push('', 'Questions? Just reply and it comes straight to me.', agentName ? `\n${agentName}` : '');
  return lines.join('\n').trim();
}

module.exports = { commitPackage, ensureTable, list, create, update, remove, compare, checks, familyUpdate, clean, STATUSES, PAYERS, FEE_CAP };
