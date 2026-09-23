'use strict';
// ── MY BRANDS: EVERY BUSINESS NILDASH HAS FOUND FOR AN AGENT'S ATHLETES ─────
//
// Read-only over what the nightly run, the on-demand fill and the Deal Scan
// already wrote. No search, no model call, no cache refresh: this page is a
// list of what we have.
//
// ONE ROW PER ATHLETE PER BUSINESS. The same salon found for two athletes is
// two rows, because the pitch, the status and the outcome belong to the
// athlete it was found for.
//
// SOURCES, in this order of trust for the contact on the row:
//   outreach_queue      the cards (business, owner, email, phone, Instagram,
//                       category, lane, found date), every state
//   brand_engagement    businesses the Deal Scan showed that never became a
//                       card (state shown/contacted/responded/closed)
//   brand_contacts      the Deal Scan's people for a brand, when the card
//                       carries no contact
//   brand_evidence_cache (places lane) the address, for the town
//
// STATUS IS DERIVED, NEVER GUESSED, from the outreach records for that
// athlete and that business, strongest first:
//   deal signed   a deal for that athlete and brand with stage closed, or the
//                 engagement ledger says closed, or a card's outcome is closed
//   replied       a card or an email with replied_at, a card outcome replied,
//                 or the ledger says responded
//   pitched       a card marked sent, an email sent, or the ledger says contacted
//   sending       an email approved and not yet sent (it has no sent_at): the
//                 release queue has it. NOT pitched until it actually leaves.
//   not pitched   everything else
//
// STRICT ISOLATION. Every query is bound to the agent id; there is no path
// that returns another agent's rows, and the admin summary is counts only.

const STATUSES = ['not pitched', 'sending', 'pitched', 'replied', 'deal signed'];
const PAGE_SIZE = 50;

const lower = (s) => String(s || '').trim().toLowerCase();

// ── LOCAL, OR SOCIAL AND NATIONAL ───────────────────────────────────────────
// The list opens on local businesses: a social or DTC brand rarely has an
// owner and pushes the rows an agent can act on down the page. The lane on
// the card or the ledger row decides; no lane means local, which is what the
// nightly job assumed before lanes were recorded.
const SOCIAL_LANES = new Set(['social', 'national', 'dtc']);
function scopeOf(lane) { return SOCIAL_LANES.has(lower(lane)) ? 'social' : 'local'; }

// ── A CATEGORY AN AGENT WOULD SAY ───────────────────────────────────────────
// The card's category_key is the writer's playbook ("local-trust",
// "local-visibility", "social") and means nothing to an agent. The business
// type comes from what Places recorded about the place (its primary type and
// types), then from the Deal Scan's enrichment industry, and when neither
// says, the plain lane: "Local business" or "Social brand".
const TYPE_WORDS = [
  [/barber/, 'Barber'],
  [/hair|beauty_salon|nail|spa\b|salon|tanning|massage/, 'Salon'],
  [/gym|fitness|yoga|pilates|crossfit|martial|boxing|climbing|sports_club|swimming/, 'Gym'],
  [/restaurant|cafe|coffee|bakery|bar\b|pizza|food|meal|diner|sandwich|ice_cream|dessert|brewery|winery|steak|sushi|taco|burger|chicken|bbq|barbecue|juice|smoothie|donut|bagel|deli|grill|pub|tea_house|wine_bar|night_club/, 'Restaurant'],
  [/car_|auto|tire|vehicle|truck|motorcycle|gas_station|parking|towing/, 'Auto'],
  [/doctor|dentist|dental|physio|chiropract|hospital|clinic|health|pharmacy|medical|orthodont|optom|optic|therap|wellness|urgent_care|veterinar|counsel/, 'Health'],
  [/clothing|apparel|shoe|boutique|jewel|fashion|sporting_goods|sports_wear|athletic/, 'Apparel'],
  [/bank|credit_union|credit union|finance|financial|insurance|accounting|tax|mortgage|loan/, 'Finance'],
  [/real_estate|realtor|realty|apartment|property|home_builder|moving/, 'Real estate'],
  [/grocery|supermarket|convenience|market\b|liquor|butcher/, 'Grocery'],
  [/school|university|college|tutor|education|preschool|academy|driving/, 'School'],
  [/church|place_of_worship|synagogue|mosque/, 'Church'],
  [/hotel|lodging|motel|resort|inn\b|bed_and_breakfast/, 'Hotel'],
  [/lawyer|attorney|legal|law_firm/, 'Legal'],
  [/entertainment|amusement|bowling|arcade|golf|cinema|theater|theatre|museum|zoo|stadium|park\b|recreation|escape/, 'Entertainment'],
  [/store|shop|retail|furniture|hardware|electronics|book|florist|pet|gift|department|mall|bicycle|bike/, 'Retail'],
  [/plumb|electric|roof|contractor|landscap|clean|repair|hvac|painter|construction|home_improvement|storage|laundry|locksmith/, 'Home services'],
];
function plainCategory(placeType, placeTypes, industry, lane) {
  const hay = [placeType, ...(Array.isArray(placeTypes) ? placeTypes : [])].map(lower).filter(Boolean);
  for (const t of hay) for (const [re, word] of TYPE_WORDS) if (re.test(t)) return word;
  const ind = String(industry || '').trim();
  if (ind && ind.length <= 30 && !/^(local|social|national|dtc|unknown|n\/a|other)$/i.test(ind)) {
    for (const [re, word] of TYPE_WORDS) if (re.test(lower(ind).replace(/\s+/g, '_'))) return word;
    return ind.charAt(0).toUpperCase() + ind.slice(1);
  }
  return scopeOf(lane) === 'social' ? 'Social brand' : 'Local business';
}

function townOf(address, lane, athleteSchool, athleteHometown) {
  try {
    if (address) {
      const cs = require('./schoolGeocode').cityStateFromAddress(address);
      if (cs && cs.city) return `${cs.city}, ${cs.state}`;
    }
  } catch (_) { /* no town */ }
  if (lane === 'local' || !lane) {
    try {
      const hit = athleteSchool ? require('./schoolResolver').resolveSchool(athleteSchool) : null;
      if (hit && hit.city) return `${hit.city}${hit.state ? ', ' + require('./schoolResolver').stateCode(hit.state) || hit.state : ''}`;
    } catch (_) { /* no town */ }
    if (athleteHometown) return String(athleteHometown);
  }
  return '';
}

function isPerson(name) {
  try { return !require('./outreachQueue').personNameProblem(name); } catch (_) { return !!name; }
}

// The raw rows for one agent: cards, ledger rows, contacts, deals, emails.
async function loadRaw(pool, agentId) {
  const [cards, ledger, contacts, deals, logs, athletes, industries] = await Promise.all([
    pool.query(
      `SELECT q.id, q.athlete_id, q.brand_name, q.contact_name, q.contact_title, q.email, q.phone, q.instagram, q.instagram_scope,
              q.category_key, q.lane, q.state, q.outcome, q.replied_at, q.sent_at, q.created_at,
              q.brand_key, q.identity_key,
              p.evidence->>'placeId' AS place_id, e.website,
              p.evidence->>'address' AS address, p.evidence->>'primaryType' AS place_type, p.evidence->'types' AS place_types
         FROM outreach_queue q
         LEFT JOIN LATERAL (
           SELECT evidence FROM brand_evidence_cache b
            WHERE b.lane = 'places' AND LOWER(b.brand) = LOWER(q.brand_name)
            ORDER BY b.refreshed_at DESC LIMIT 1
         ) p ON TRUE
         LEFT JOIN LATERAL (
           SELECT website FROM company_enrichment ce
            WHERE ce.agent_id = $1 AND LOWER(ce.brand_name) = LOWER(q.brand_name)
              AND ce.website IS NOT NULL AND ce.website <> '' LIMIT 1
         ) e ON TRUE
        WHERE q.agent_id = $1 AND q.brand_name IS NOT NULL AND q.brand_name <> ''
        ORDER BY q.created_at DESC`, [agentId]),
    pool.query(
      `SELECT athlete_id, brand_name, brand_key, lane, state, outcome, first_shown_at, created_at, contacted_at
         FROM brand_engagement
        WHERE agent_id = $1 AND brand_name IS NOT NULL AND brand_name <> ''`, [agentId]),
    pool.query(
      `SELECT brand_name, name, title, email, phone
         FROM brand_contacts
        WHERE agent_id = $1
        ORDER BY priority_rank ASC, confidence_score DESC`, [agentId]),
    pool.query(
      `SELECT athlete_id, LOWER(TRIM(data->>'brand')) AS brand, LOWER(COALESCE(data->>'stage', data->>'status', '')) AS stage
         FROM deals WHERE agent_id = $1 AND COALESCE(data->>'brand', '') <> ''`, [agentId]),
    pool.query(
      `SELECT athlete_id, LOWER(TRIM(brand_name)) AS brand, status, sent_at, replied_at, cadence_stopped_at
         FROM outreach_logs WHERE agent_id = $1`, [agentId]),
    pool.query(
      `SELECT id, data->>'name' AS name, data->>'school' AS school, data->>'hometown' AS hometown, data->>'city' AS city
         FROM athletes WHERE agent_id = $1`, [agentId]),
    pool.query(
      `SELECT brand_name, industry FROM company_enrichment WHERE agent_id = $1 AND industry IS NOT NULL AND industry <> ''`, [agentId]).catch(() => ({ rows: [] })),
  ]);
  return { cards: cards.rows, ledger: ledger.rows, contacts: contacts.rows, deals: deals.rows, logs: logs.rows, athletes: athletes.rows, industries: (industries && industries.rows) || [] };
}

// Rows in, the list out. Pure over the raw rows, so the test can feed it.
function buildRows(raw) {
  const athleteById = new Map(raw.athletes.map((a) => [a.id, a]));
  const contactsByBrand = new Map();
  for (const c of raw.contacts) { const k = lower(c.brand_name); if (!contactsByBrand.has(k)) contactsByBrand.set(k, []); contactsByBrand.get(k).push(c); }
  const key = (athleteId, brand) => athleteId + '|' + lower(brand);
  const rows = new Map();

  // Cards first: newest first, so the first card seen for a pair carries the
  // contact and the found date is the OLDEST card's.
  for (const c of raw.cards) {
    if (!athleteById.has(c.athlete_id)) continue;   // an athlete no longer on the roster
    const k = key(c.athlete_id, c.brand_name);
    let r = rows.get(k);
    if (!r) {
      r = { athleteId: c.athlete_id, brand: c.brand_name, ownerName: null, ownerTitle: null, email: null, phone: null, instagram: null,
        // The cross-agent identity, carried so services/brandFlags can match
        // this business to the same business on another roster by Place ID or
        // domain. Never shown, and never a name (see brandFlags).
        brandKey: c.brand_key || c.identity_key || null, placeId: c.place_id || null, website: c.website || null,
        placeType: c.place_type || null, placeTypes: c.place_types || null, lane: c.lane || null, address: c.address || null, foundAt: c.created_at,
        pitched: false, sending: false, replied: false, closed: false, source: 'card' };
      rows.set(k, r);
    }
    if (c.created_at && (!r.foundAt || new Date(c.created_at) < new Date(r.foundAt))) r.foundAt = c.created_at;
    if (!r.ownerName && c.contact_name && isPerson(c.contact_name)) { r.ownerName = c.contact_name; r.ownerTitle = c.contact_title || null; }
    if (!r.email && c.email) r.email = c.email;
    if (!r.phone && c.phone) r.phone = c.phone;
    if (!r.instagram && c.instagram && c.instagram_scope !== 'brand') r.instagram = c.instagram;
    if (!r.placeType && c.place_type) { r.placeType = c.place_type; r.placeTypes = c.place_types || null; }
    if (!r.lane && c.lane) r.lane = c.lane;
    if (!r.address && c.address) r.address = c.address;
    if (!r.brandKey && (c.brand_key || c.identity_key)) r.brandKey = c.brand_key || c.identity_key;
    if (!r.placeId && c.place_id) r.placeId = c.place_id;
    if (!r.website && c.website) r.website = c.website;
    // A card is 'sent' only once its email has a sent_at (services/closer); an
    // approved email card is 'sending' until then.
    if (c.state === 'sent' || c.sent_at) r.pitched = true;
    if (c.state === 'sending') r.sending = true;
    if (c.replied_at || c.outcome === 'replied') r.replied = true;
    if (c.outcome === 'closed') r.closed = true;
  }
  // The ledger: businesses the Deal Scan showed, and the strongest state it holds.
  for (const e of raw.ledger) {
    if (!athleteById.has(e.athlete_id)) continue;
    const k = key(e.athlete_id, e.brand_name);
    let r = rows.get(k);
    if (!r) {
      r = { athleteId: e.athlete_id, brand: e.brand_name, ownerName: null, ownerTitle: null, email: null, phone: null, instagram: null,
        brandKey: e.brand_key || null, placeId: null, website: null,
        placeType: null, placeTypes: null, lane: e.lane || null, address: null, foundAt: e.first_shown_at || e.created_at,
        pitched: false, sending: false, replied: false, closed: false, source: 'scan' };
      rows.set(k, r);
    }
    const at = e.first_shown_at || e.created_at;
    if (at && (!r.foundAt || new Date(at) < new Date(r.foundAt))) r.foundAt = at;
    if (!r.brandKey && e.brand_key) r.brandKey = e.brand_key;
    if (e.state === 'contacted' || e.contacted_at) r.pitched = true;
    if (e.state === 'responded') r.replied = true;
    if (e.state === 'closed' || e.outcome === 'closed') r.closed = true;
  }
  // Emails and deals, by athlete and brand.
  for (const l of raw.logs) {
    const r = rows.get(l.athlete_id + '|' + l.brand);
    if (!r) continue;
    if (l.sent_at || l.status === 'sent') r.pitched = true;
    else if (l.status === 'approved' && !l.cadence_stopped_at) r.sending = true;
    if (l.replied_at) r.replied = true;
  }
  for (const d of raw.deals) {
    const r = rows.get(d.athlete_id + '|' + d.brand);
    if (r && d.stage === 'closed') r.closed = true;
  }
  // The Deal Scan's contacts fill a row the card left blank, and its industry
  // names the business type when Places did not.
  const industryByBrand = new Map((raw.industries || []).map((x) => [lower(x.brand_name), x.industry]));
  const out = [];
  for (const r of rows.values()) {
    const a = athleteById.get(r.athleteId) || {};
    if (!r.ownerName || (!r.email && !r.phone)) {
      for (const c of contactsByBrand.get(lower(r.brand)) || []) {
        if (!r.ownerName && c.name && isPerson(c.name)) { r.ownerName = c.name; r.ownerTitle = c.title || null; }
        if (!r.email && c.email) r.email = c.email;
        if (!r.phone && c.phone) r.phone = c.phone;
      }
    }
    const status = r.closed ? 'deal signed' : r.replied ? 'replied' : r.pitched ? 'pitched'
      : r.sending ? 'sending' : 'not pitched';
    const scope = scopeOf(r.lane);
    // A social or DTC brand has no town: it is national. A local business
    // with no town we could place shows a dash, never a guess.
    const town = scope === 'social' ? '' : townOf(r.address, r.lane, a.school, a.hometown || a.city);
    out.push({
      athleteId: r.athleteId, athlete: a.name || r.athleteId, brand: r.brand,
      town, townLabel: town || (scope === 'social' ? 'National' : '—'),
      ownerName: r.ownerName, ownerTitle: r.ownerTitle,
      contact: r.email || r.phone || (r.instagram ? '@' + String(r.instagram).replace(/^@/, '') : ''),
      email: r.email, phone: r.phone, instagram: r.instagram,
      category: plainCategory(r.placeType, r.placeTypes, industryByBrand.get(lower(r.brand)), r.lane),
      lane: r.lane, scope, status, foundAt: r.foundAt,
      // The cross-agent identity, carried so the badge can be matched by
      // Place ID or domain (services/brandFlags). It is this agent's own key
      // for their own card: nothing about anyone else rides on it.
      brandKey: r.brandKey || null, placeId: r.placeId || null, website: r.website || null,
    });
  }
  return out;
}

function counts(rows) {
  return {
    businesses: rows.length,
    owners: rows.filter((r) => r.ownerName).length,
    replied: rows.filter((r) => r.status === 'replied' || r.status === 'deal signed').length,
    deals: rows.filter((r) => r.status === 'deal signed').length,
  };
}

const FILTERS = { all: () => true, replied: (r) => r.status === 'replied' || r.status === 'deal signed', pitched: (r) => r.status === 'pitched', sending: (r) => r.status === 'sending', 'not pitched': (r) => r.status === 'not pitched', 'deal signed': (r) => r.status === 'deal signed' };
const STATUS_RANK = { 'deal signed': 0, replied: 1, pitched: 2, sending: 3, 'not pitched': 4 };
const SCOPES = ['local', 'social', 'all'];
function applyView(rows, opts = {}) {
  const filter = FILTERS[opts.filter] ? opts.filter : 'all';
  const scope = SCOPES.includes(opts.scope) ? opts.scope : 'local';
  const q = lower(opts.q);
  let list = rows.filter(FILTERS[filter]);
  if (scope !== 'all') list = list.filter((r) => r.scope === scope);
  if (opts.athleteId) list = list.filter((r) => r.athleteId === opts.athleteId);
  if (q) list = list.filter((r) => [r.brand, r.town, r.ownerName, r.contact, r.category, r.athlete].some((v) => lower(v).includes(q)));
  const sort = ['newest', 'business', 'athlete', 'status'].includes(opts.sort) ? opts.sort : 'newest';
  const cmp = {
    newest: (a, b) => new Date(b.foundAt || 0) - new Date(a.foundAt || 0),
    business: (a, b) => lower(a.brand).localeCompare(lower(b.brand)) || lower(a.athlete).localeCompare(lower(b.athlete)),
    athlete: (a, b) => lower(a.athlete).localeCompare(lower(b.athlete)) || lower(a.brand).localeCompare(lower(b.brand)),
    status: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || new Date(b.foundAt || 0) - new Date(a.foundAt || 0),
  }[sort];
  list.sort(cmp);
  return { list, filter, scope, sort };
}

// The page: filtered, sorted, paged, with the counts over EVERYTHING the
// agent has (the counts do not move with the filter) and the athlete list.
async function pageFor(pool, agentId, opts = {}) {
  const raw = await loadRaw(pool, agentId);
  const rows = buildRows(raw);
  const { list, filter, scope, sort } = applyView(rows, opts);
  const size = Math.max(1, Math.min(200, parseInt(opts.pageSize, 10) || PAGE_SIZE));
  const pages = Math.max(1, Math.ceil(list.length / size));
  const page = Math.max(1, Math.min(pages, parseInt(opts.page, 10) || 1));
  const athletes = raw.athletes.map((a) => ({ id: a.id, name: a.name || a.id })).sort((a, b) => lower(a.name).localeCompare(lower(b.name)));
  // ── THE BADGE, ON THIS PAGE'S ROWS ONLY ────────────────────────────────
  // Fifty rows, one query. What comes back is two booleans a row: never an
  // agent, an athlete, a value or a contact from anyone else's book
  // (services/brandFlags).
  const pageRows = list.slice((page - 1) * size, page * size);
  try { await require('./brandFlags').attachFlags(pool, pageRows); } catch (e) { console.error('[myBrands] flags:', e.message); }
  const loggedDeals = await require('./dealLog').loggedFor(pool, agentId, pageRows).catch(() => new Map());
  for (const r of pageRows) {
    const id = loggedDeals.get(r.athleteId + '|' + lower(r.brand));
    r.dealLoggedId = id == null ? null : id;
  }
  return {
    counts: counts(rows), total: rows.length, filtered: list.length,
    scopeCounts: { local: rows.filter((r) => r.scope === 'local').length, social: rows.filter((r) => r.scope === 'social').length },
    page, pages, pageSize: size, filter, scope, sort, athleteId: opts.athleteId || null, q: opts.q || '',
    rows: pageRows,
    athletes,
  };
}

// The CSV: exactly what the filter shows, every row, plus the date found.
const CSV_COLUMNS = ['Business', 'Town', 'Owner', 'Contact', 'Category', 'Athlete', 'Status', 'Date found'];
function csvFor(rows) {
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([r.brand, r.townLabel === '—' ? '' : (r.townLabel || r.town), r.ownerName, r.contact, r.category, r.athlete, r.status, r.foundAt ? new Date(r.foundAt).toISOString().slice(0, 10) : ''].map(cell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
async function csvForAgent(pool, agentId, opts = {}) {
  const raw = await loadRaw(pool, agentId);
  const { list } = applyView(buildRows(raw), opts);
  return csvFor(list);
}

// ── ADMIN: COUNTS ACROSS EVERY AGENT, AND NOTHING ELSE ─────────────────────
// Totals only. No name, no address, no contact leaves this function.
async function adminSummary(pool) {
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(DISTINCT LOWER(TRIM(brand_name))) FROM outreach_queue WHERE brand_name IS NOT NULL AND brand_name <> '')::int AS card_businesses,
       (SELECT COUNT(DISTINCT LOWER(TRIM(brand_name))) FROM brand_engagement WHERE brand_name IS NOT NULL AND brand_name <> '')::int AS scan_businesses,
       (SELECT COUNT(DISTINCT LOWER(TRIM(brand_name))) FROM (
          SELECT brand_name FROM outreach_queue WHERE brand_name IS NOT NULL AND brand_name <> ''
          UNION SELECT brand_name FROM brand_engagement WHERE brand_name IS NOT NULL AND brand_name <> '') u)::int AS businesses,
       (SELECT COUNT(DISTINCT LOWER(TRIM(brand_name))) FROM outreach_queue WHERE contact_name IS NOT NULL AND contact_name <> '')::int AS owners_on_cards,
       (SELECT COUNT(DISTINCT LOWER(TRIM(brand_name))) FROM brand_contacts WHERE name IS NOT NULL AND name <> '')::int AS owners_from_scan,
       (SELECT COUNT(DISTINCT agent_id) FROM outreach_queue)::int AS agents_with_cards,
       (SELECT COUNT(*) FROM outreach_queue)::int AS cards`);
  const row = r.rows[0] || {};
  return {
    businesses: row.businesses || 0, cardBusinesses: row.card_businesses || 0, scanBusinesses: row.scan_businesses || 0,
    owners: Math.max(row.owners_on_cards || 0, row.owners_from_scan || 0), ownersOnCards: row.owners_on_cards || 0, ownersFromScan: row.owners_from_scan || 0,
    agentsWithCards: row.agents_with_cards || 0, cards: row.cards || 0,
  };
}

module.exports = { pageFor, csvForAgent, csvFor, buildRows, applyView, counts, loadRaw, adminSummary, townOf, scopeOf, plainCategory, STATUSES, SCOPES, PAGE_SIZE, CSV_COLUMNS };
