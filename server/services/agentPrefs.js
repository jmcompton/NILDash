'use strict';
// ── THE AGENT'S OWN RULES FOR THEIR CARDS (services/agentPrefs) ──────────────
//
// Two settings an agent asked for after a month of reading pitches:
//
//   NEVER THESE   kinds of business they never want to see for their athletes
//                 ("my athletes won't partner with real estate agents"). The
//                 nightly queue refuses them before any lookup is spent, and
//                 turning one on clears the ones already waiting.
//   STARTING AT   the lowest suggested offer on their cards. The suggestion
//                 is still $250 or $500 from what Google says about the
//                 business (services/offerSuggest); below the agent's floor
//                 it starts at the floor. Setting it lifts the cards already
//                 waiting, figure in the draft included.
//
// Per agent, on the users row. Nothing here changes another agent's cards.

const KINDS = [
  { key: 'real_estate', label: 'Real estate', types: ['real_estate_agency'], words: /\b(real estate|realtor|realtors|realty|property management|properties|homes? for sale|keller williams|re\/max|remax|coldwell|century 21|berkshire hathaway home|exp realty)\b/i },
  { key: 'insurance', label: 'Insurance', types: ['insurance_agency'], words: /\b(insurance|state farm|allstate|farm bureau|nationwide|geico|progressive)\b/i },
  { key: 'finance', label: 'Banks, loans and financial advisors', types: ['bank', 'finance', 'accounting'], words: /\b(bank|credit union|mortgage|lending|loans?|financial (advisors?|planning|group|services)|wealth management|tax services?|cpa)\b/i },
  { key: 'law', label: 'Law firms', types: ['lawyer'], words: /\b(law firm|law office|law group|attorneys?|lawyers?|legal services|injury law)\b/i },
  { key: 'car_dealers', label: 'Car dealerships', types: ['car_dealer'], words: /\b(dealership|auto sales|motors|automotive group|used cars)\b/i },
  { key: 'medical', label: 'Doctors, dentists and clinics', types: ['dentist', 'doctor', 'hospital', 'physiotherapist', 'medical_lab', 'dental_clinic', 'medical_clinic'], words: /\b(dental|dentistry|dentist|orthodont\w*|chiropract\w*|medical|clinic|physicians?|pediatric\w*|dermatolog\w*|urgent care)\b/i },
  { key: 'churches', label: 'Churches', types: ['church', 'place_of_worship'], words: /\b(church|ministries|chapel|parish)\b/i },
];
const KEYS = new Set(KINDS.map((k) => k.key));
const FLOORS = [250, 500, 750, 1000];
const TTL = 10 * 60 * 1000;
const _cache = new Map();

async function ensureColumns(pool) {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS offer_floor INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS never_kinds TEXT[]`).catch(() => {});
}

async function get(pool, agentId) {
  const hit = _cache.get(agentId);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  await ensureColumns(pool);
  const r = (await pool.query(`SELECT offer_floor, never_kinds FROM users WHERE id = $1`, [agentId]).catch(() => ({ rows: [] }))).rows[0] || {};
  const v = { offerFloor: Number(r.offer_floor) > 0 ? Number(r.offer_floor) : null, never: (r.never_kinds || []).filter((k) => KEYS.has(k)) };
  _cache.set(agentId, { at: Date.now(), v });
  return v;
}

// Which of the agent's never-kinds this business is, or null.
// b: { name, category, types }
function blockedBy(prefs, b = {}) {
  if (!prefs || !prefs.never || !prefs.never.length) return null;
  const types = (Array.isArray(b.types) ? b.types : []).map((t) => String(t).toLowerCase());
  const text = [b.name, b.category].filter(Boolean).join(' ').replace(/_/g, ' ');
  for (const k of KINDS) {
    if (!prefs.never.includes(k.key)) continue;
    if (k.types.some((t) => types.includes(t)) || k.words.test(text)) return k;
  }
  return null;
}

// A suggested offer below the floor starts at the floor. -> the offer, changed or not.
function applyFloor(offer, floor) {
  if (!offer || !(floor > 0) || !(Number(offer.amount) < floor)) return offer;
  const OFFER = require('./offerSuggest');
  return Object.assign({}, offer, { amount: floor, label: OFFER.labelOf(floor, offer.kind || 'cash'),
    why: [offer.why, 'your starting price'].filter(Boolean).join('; ') });
}

// The cards already waiting, made to follow the settings. -> { skipped, lifted }
async function applyToOpen(pool, agentId, prefs) {
  const p = prefs || await get(pool, agentId);
  const rows = (await pool.query(
    `SELECT q.id, q.brand_name, q.business_category, q.outreach_log_id, q.offer_amount, q.offer_kind
       FROM outreach_queue q WHERE q.agent_id = $1 AND q.state = 'queued' AND q.sent_at IS NULL`, [agentId]).catch(() => ({ rows: [] }))).rows;
  let skipped = 0, lifted = 0;
  for (const r of rows) {
    if (blockedBy(p, { name: r.brand_name, category: r.business_category })) {
      let ok = false;
      if (r.outreach_log_id) {
        try { const s = await require('./closer').skipDraft(pool, agentId, r.outreach_log_id); ok = !!(s && s.ok); } catch (_) { ok = false; }
      }
      if (!ok) await pool.query(`UPDATE outreach_queue SET state = 'skipped', updated_at = NOW() WHERE id = $1 AND state = 'queued'`, [r.id]);
      skipped++;
      continue;
    }
    if (p.offerFloor && r.offer_amount != null && Number(r.offer_amount) < p.offerFloor) {
      const out = await require('./offerSuggest').setOffer(pool, agentId, 'queue:' + r.id, String(p.offerFloor), r.offer_kind === 'product' ? 'product' : 'cash').catch(() => null);
      if (out && out.ok) lifted++;
    }
  }
  return { skipped, lifted };
}

// body: { offerFloor: 500 | null, never: ['real_estate', ...] } -> { ok, prefs, skipped, lifted }
async function set(pool, agentId, body = {}) {
  await ensureColumns(pool);
  const cur = await get(pool, agentId);
  let floor = cur.offerFloor;
  if ('offerFloor' in body) {
    const f = body.offerFloor == null || body.offerFloor === '' ? null : Number(body.offerFloor);
    if (f !== null && !FLOORS.includes(f)) return { ok: false, error: `Pick a starting price of ${FLOORS.map((x) => '$' + x).join(', ')}, or none.` };
    floor = f;
  }
  let never = cur.never;
  if ('never' in body) {
    if (!Array.isArray(body.never)) return { ok: false, error: 'never must be a list.' };
    never = [...new Set(body.never.map(String).filter((k) => KEYS.has(k)))];
  }
  await pool.query(`UPDATE users SET offer_floor = $2, never_kinds = $3 WHERE id = $1`, [agentId, floor, never]);
  _cache.delete(agentId);
  const prefs = await get(pool, agentId);
  const done = await applyToOpen(pool, agentId, prefs);
  return Object.assign({ ok: true, prefs }, done);
}

function view(prefs) {
  return { offerFloor: prefs.offerFloor, never: prefs.never, floors: FLOORS, kinds: KINDS.map((k) => ({ key: k.key, label: k.label })) };
}

module.exports = { KINDS, FLOORS, ensureColumns, get, set, blockedBy, applyFloor, applyToOpen, view, _cache };
