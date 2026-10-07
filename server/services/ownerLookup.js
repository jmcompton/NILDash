'use strict';
// ── "FIND THE OWNER": THE PAID LOOKUP, ONLY WHEN STAFF ASK ──────────────────
//
// The night uses only free sources (teamScan.PAID_CONTACTS_AT_NIGHT), so a
// card can name the business and every way to reach it without naming the
// person. This is the paid step for the one business someone on staff wants:
// the owner search and the contact ladder (campusContacts.resolveAndStore),
// about $0.10-0.24 a lookup.
//
//   - one lookup per business per university, ever: a second tap on the same
//     business, or the same business on another team's card, costs nothing
//   - a monthly cap per university (UNIVERSITY_OWNER_LOOKUP_MONTHLY_USD, $20)
//   - a found owner goes onto the card: the greeting becomes their first name
//     ("Hi Dana," for "Hi Taqueria Sol team,"), their own address replaces a
//     shared inbox, a phone or handle we lacked is added. Nothing is sent.
const MONTHLY_USD = parseFloat(process.env.UNIVERSITY_OWNER_LOOKUP_MONTHLY_USD) || 20;
const _busy = new Set();

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS university_owner_lookups (
    id SERIAL PRIMARY KEY, university_id TEXT NOT NULL, brand TEXT NOT NULL, draft_id TEXT, user_id TEXT,
    cost_usd NUMERIC NOT NULL DEFAULT 0, found BOOLEAN, error TEXT, contact_name TEXT, contact_title TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS university_owner_lookups_uni_idx ON university_owner_lookups (university_id, brand)`).catch(() => {});
}

async function spentThisMonth(pool, universityId) {
  await ensureTable(pool);
  return Number((await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS usd FROM university_owner_lookups
      WHERE university_id = $1 AND at >= date_trunc('month', NOW()) AND COALESCE(user_id, '') <> 'night'`, [universityId])).rows[0].usd) || 0;
}

// ── THE NIGHT'S NAMES: one budget for the school ────────────────────────────
// Tonight's local cards with no owner's name, best fit for their team first,
// each looked up once (never a business looked up before), until the budget
// cannot cover the dearest lookup. Recorded as user 'night', outside the
// staff's monthly "Find the owner" cap. -> { tried, found, usd, stoppedFor }
// WHAT A LOOKUP COSTS HERE: this university's own history once it has 10
// lookups (cost of every lookup / how many), the ladder's list price before.
// Cypress: 123 lookups, $0.083 each, 87% named -> $0.10 a name.
async function measuredRate(pool, universityId) {
  const CC = require('./campusContacts');
  const k = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status IN ('reachable','unreachable'))::int AS looked,
                                      COUNT(*) FILTER (WHERE reachable)::int AS reachable,
                                      COALESCE(SUM(cost_usd) FILTER (WHERE status IN ('reachable','unreachable','error')),0)::float AS spent
                                 FROM university_contacts WHERE university_id = $1`, [universityId]).catch(() => ({ rows: [{ looked: 0, reachable: 0, spent: 0 }] }))).rows[0];
  const list = { low: CC.perBusinessUsd('low', false).metered, high: CC.perBusinessUsd('high', false).metered };
  const history = k.looked >= 10 && k.spent > 0;
  const perLookup = history ? k.spent / k.looked : (list.low + list.high) / 2;
  const hitRate = history ? k.reachable / k.looked : 0.5;
  return { history, looked: k.looked, perLookup, hitRate, perNamed: hitRate > 0 ? perLookup / hitRate : list.high * 2, listHigh: list.high };
}

async function nameTonight(pool, universityId, night, budgetUsd, deps = {}) {
  await ensureTable(pool);
  // The next lookup must fit what is left: twice this school's measured
  // average (a lookup varies), never more than the list price of the dearest.
  const rate = await measuredRate(pool, universityId);
  const worst = rate.history ? Math.min(rate.listHigh, rate.perLookup * 2) : rate.listHigh;
  const out = { tried: 0, found: 0, usd: 0, stoppedFor: null };
  if (!(budgetUsd > 0)) { out.stoppedFor = 'no budget'; return out; }
  const rows = (await pool.query(
    `SELECT d.id, (SELECT (x->>'score')::int FROM jsonb_array_elements(COALESCE(c.team_fit, '[]'::jsonb)) x WHERE x->>'team_id' = d.team_id) AS fit
       FROM university_drafts d
       LEFT JOIN university_contacts c ON c.university_id = d.university_id AND c.brand = d.brand_name
      WHERE d.university_id = $1 AND d.night = $2::date AND d.kind = 'pitch' AND d.lane <> 'social' AND d.contact_name IS NULL
        AND NOT EXISTS (SELECT 1 FROM university_owner_lookups o WHERE o.university_id = d.university_id AND o.brand = d.brand_name AND o.error IS NULL)
      ORDER BY fit DESC NULLS LAST, d.created_at`, [universityId, night])).rows;
  for (const r of rows) {
    if (out.usd + worst > budgetUsd + 1e-9) { out.stoppedFor = 'budget'; break; }
    const x = await findOwner(pool, universityId, 'night', r.id, { ai: deps.ai, free: deps.free, ignoreCap: true });
    out.tried++;
    out.usd += Number(x.costUsd) || 0;
    if (x.ok && x.found) out.found++;
  }
  if (!out.stoppedFor) out.stoppedFor = rows.length ? 'every nameless card tried' : 'no nameless cards';
  return out;
}

// The card's text with the found person's name in the greeting.
function greet(text, name, brand) {
  if (!text) return text;
  const first = String(name || '').trim().split(/\s+/)[0];
  if (!/^[A-Z][a-z'-]+$/.test(first)) return text;
  const lines = String(text).split('\n');
  const esc = String(brand || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^Hi .* team,\s*$/.test(lines[0]) && (!brand || new RegExp(esc, 'i').test(lines[0]))) lines[0] = `Hi ${first},`;
  return lines.join('\n');
}

// Put what is on the contact row onto the card. -> the fields changed.
async function applyToDraft(pool, draft, k) {
  const QC = require('./campusQuality');
  const own = k.email && !QC.isGenericInbox(k.email) ? k.email : null;
  const set = {
    contact_name: k.contact_name || draft.contact_name || null,
    contact_title: k.contact_title || draft.contact_title || null,
    contact_email: own || draft.contact_email || k.generic_email || null,
    email_is_shared: own ? false : draft.email_is_shared,
    contact_phone: draft.contact_phone || k.phone || null,
    contact_instagram: draft.contact_instagram || k.instagram || null,
    body: greet(draft.body, k.contact_name, draft.brand_name),
    dm_text: greet(draft.dm_text, k.contact_name, draft.brand_name),
  };
  await pool.query(
    `UPDATE university_drafts SET contact_name = $2, contact_title = $3, contact_email = $4, email_is_shared = $5, contact_phone = $6,
       contact_instagram = $7, body = $8, dm_text = $9, updated_at = NOW() WHERE id = $1`,
    [draft.id, set.contact_name, set.contact_title, set.contact_email, set.email_is_shared, set.contact_phone, set.contact_instagram, set.body, set.dm_text]);
  return set;
}

// -> { ok, status?, error?, found, cached, costUsd, card fields, leftUsd }
async function findOwner(pool, universityId, userId, draftId, deps = {}) {
  await ensureTable(pool);
  const draft = (await pool.query(`SELECT * FROM university_drafts WHERE id = $1 AND university_id = $2 AND kind = 'pitch'`, [draftId, universityId])).rows[0];
  if (!draft) return { ok: false, status: 404, error: 'card not found' };
  if (draft.lane === 'social') return { ok: false, status: 400, error: 'a brand program is reached through its program page, not an owner' };
  if (draft.contact_name) return { ok: true, found: true, cached: true, costUsd: 0, card: draft };
  const brand = draft.brand_name;
  const contactRow = async () => (await pool.query(
    `SELECT contact_name, contact_title, email, generic_email, phone, instagram FROM university_contacts WHERE university_id = $1 AND brand = $2`,
    [universityId, brand])).rows[0] || {};
  // ONE LOOKUP PER BUSINESS, EVER.
  const prior = (await pool.query(`SELECT found FROM university_owner_lookups WHERE university_id = $1 AND brand = $2 AND error IS NULL
                                    ORDER BY at DESC LIMIT 1`, [universityId, brand])).rows[0];
  if (prior) {
    const k = await contactRow();
    if (prior.found && k.contact_name) return { ok: true, found: true, cached: true, costUsd: 0, card: { ...draft, ...(await applyToDraft(pool, draft, k)) } };
    return { ok: true, found: false, cached: true, costUsd: 0, card: draft };
  }
  const spent = deps.ignoreCap ? 0 : await spentThisMonth(pool, universityId);
  if (!deps.ignoreCap && spent >= MONTHLY_USD) {
    return { ok: false, status: 402, error: `This month's owner lookups are used up ($${MONTHLY_USD.toFixed(2)}). They reset on the 1st.`, leftUsd: 0 };
  }
  const key = universityId + '|' + brand;
  if (_busy.has(key)) return { ok: false, status: 409, error: 'already looking this one up' };
  _busy.add(key);
  try {
    const CP = require('./campusPool');
    const u = await CP.universityOf(pool, universityId);
    const TS = require('./teamScan');
    const r = await require('./campusContacts').resolveAndStore(pool, universityId, { brand, place_id: draft.place_id || null },
      { city: (u && (TS.cityOf(u.location) || u.location)) || null, ai: deps.ai, history: false, marketKey: u && u.marketKey, deps: deps.free });
    const k = await contactRow();
    const found = !r.error && !!k.contact_name;
    await pool.query(`INSERT INTO university_owner_lookups (university_id, brand, draft_id, user_id, cost_usd, found, error, contact_name, contact_title)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [universityId, brand, draftId, userId ? String(userId) : null, Number(r.costUsd) || 0, r.error ? null : found, r.error || null,
        found ? k.contact_name : null, found ? k.contact_title || null : null]);
    const leftUsd = Math.max(0, MONTHLY_USD - spent - (Number(r.costUsd) || 0));
    if (r.error) return { ok: false, status: 502, error: 'The lookup failed on our side. Try again later.', leftUsd, costUsd: Number(r.costUsd) || 0 };
    if (!found) return { ok: true, found: false, cached: false, costUsd: Number(r.costUsd) || 0, card: draft, leftUsd };
    return { ok: true, found: true, cached: false, costUsd: Number(r.costUsd) || 0, card: { ...draft, ...(await applyToDraft(pool, draft, k)) }, leftUsd };
  } finally {
    _busy.delete(key);
  }
}

module.exports = { findOwner, nameTonight, measuredRate, applyToDraft, greet, spentThisMonth, ensureTable, MONTHLY_USD };
