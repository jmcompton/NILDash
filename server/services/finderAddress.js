'use strict';
// ── EVERY ADDRESS FROM ONE PLACE: THE EMAIL FINDER (SEND_GATE_ON) ────────────
//
// The nightly cards got their addresses from services/emailFinder: a named
// person, an address at the business's own domain, verified. Everything an
// agent did by hand did not. A Deal Scan card carried whatever the model
// wrote (its prompt said "otherwise info@/owner@/contact@ at the real
// website domain"); Write Outreach and the editor prefilled what a web search
// or a site scrape suggested, labelled "Confident"; the athlete's brand email
// took the address typed or suggested. None was verified, and that is where
// general.counsel@hibbett.com and circleheart@myyahoo.com came from.
//
// Now, with SEND_GATE_ON:
//   forPerson()  the ONLY source of an address shown or prefilled anywhere:
//                the email finder for that named person at that business,
//                valid-only (a catch-all never passes), cached 30 days.
//   strip()      every address an AI, a web search or a scrape put on a
//                result is removed before it reaches the browser. Names,
//                titles, phones and handles stay.
//   badge()      each address shown says Verified or Not verified.
// The send gate (services/sendGate) still checks whatever is sent.

const lc = (s) => String(s || '').trim().toLowerCase();
const ON = () => require('./sendGate').ON();
const FRESH_DAYS = 30;

let _table = null;
function ensureTable(pool) {
  if (_table) return _table;
  _table = pool.query(`
    CREATE TABLE IF NOT EXISTS finder_addresses (
      brand_key  TEXT NOT NULL,
      person     TEXT NOT NULL,
      domain     TEXT,
      email      TEXT,
      verdict    TEXT,
      how        TEXT,
      why        TEXT,
      found_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (brand_key, person)
    )`).catch((e) => { _table = null; console.error('[finder-address] table: ' + e.message); });
  return _table;
}

function keyOf(brand) { return lc(brand).replace(/\s+/g, ' '); }

function shape(row, name) {
  const SG = require('./sendGate');
  const email = row && row.email ? lc(row.email) : null;
  const verified = !!email && row.verdict === 'valid' && !SG.addressProblem(email, name);
  return { email, verified, label: email ? (verified ? 'Verified' : 'Not verified') : null,
    verdict: (row && row.verdict) || null, how: (row && row.how) || null,
    why: email ? (verified ? null : `the finder could not verify ${email}`) : ((row && row.why) || 'the email finder found no address for this person'),
    from: 'finder', foundAt: (row && row.found_at) || null };
}

// What the finder found before, if anything, no older than 30 days. Free.
async function cached(pool, brand, name) {
  if (!brand || !name) return null;
  await ensureTable(pool);
  const r = (await pool.query(
    `SELECT * FROM finder_addresses WHERE brand_key = $1 AND person = $2 AND found_at > NOW() - ($3 || ' days')::interval`,
    [keyOf(brand), lc(name), String(FRESH_DAYS)]).catch(() => ({ rows: [] }))).rows[0];
  return r ? shape(r, name) : null;
}

// ── THE ONE SOURCE ──────────────────────────────────────────────────────────
// args: { brand, name, title, website, domain, region, agentId, athleteId, source, force }
// deps: emailFinder.liveDeps-shaped (tests inject); live otherwise.
async function forPerson(pool, args = {}, deps = null) {
  const name = String(args.name || '').trim();
  const brand = String(args.brand || '').trim();
  if (!brand) return shape({ why: 'no business' }, name);
  const Q = require('./outreachQueue');
  const notPerson = name ? Q.personNameProblem(name, brand) : 'no contact name';
  if (!name || notPerson) return shape({ why: `nobody named to find an address for (${notPerson || 'no name'})` }, name);
  if (!args.force) { const c = await cached(pool, brand, name); if (c) return c; }

  const EF = require('./emailFinder');
  const ET = require('./emailTier');
  const d = deps || EF.liveDeps(pool, { agentId: args.agentId || null, athleteId: args.athleteId || null, business: brand, source: args.source || 'finder-manual' });
  let domain = args.domain ? ET.rootDomain(args.domain) : (args.website ? ET.rootDomain(args.website) : null);
  let why = null;
  if (!domain && typeof d.resolveDomain === 'function') {
    try { const r = await d.resolveDomain(brand, { region: args.region || '' }); domain = r && (r.domain || (r.website && ET.rootDomain(r.website))) || null; }
    catch (e) { why = 'the business website could not be found (' + e.message + ')'; }
  }
  let out;
  if (!domain) out = { why: why || 'no website for this business, so no address at its domain' };
  else {
    const corp = typeof d.corporate === 'function' ? d.corporate(domain, brand, null) : null;
    if (corp) out = { domain, why: corp + ', so no local address there' };
    else {
      let hunter = null;
      if (typeof d.hunterCached === 'function') { try { hunter = await d.hunterCached(domain); } catch (_) { hunter = null; } }
      const r = await EF.find({ name, domain, examples: [], strictDomain: false, roleOnly: false, hunter, skip: [], validOnly: true }, d);
      out = { domain, email: r.email || null, verdict: r.verdict || null, how: r.how || null, why: r.email ? null : (r.stop || 'no address at ' + domain + ' verified for ' + name) };
    }
  }
  await ensureTable(pool);
  await pool.query(
    `INSERT INTO finder_addresses (brand_key, person, domain, email, verdict, how, why, found_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (brand_key, person) DO UPDATE SET domain = EXCLUDED.domain, email = EXCLUDED.email, verdict = EXCLUDED.verdict,
       how = EXCLUDED.how, why = EXCLUDED.why, found_at = NOW()`,
    [keyOf(brand), lc(name), out.domain || null, out.email ? lc(out.email) : null, out.verdict || null, out.how || null, out.why || null])
    .catch((e) => console.error('[finder-address] write: ' + e.message));
  return shape({ ...out, found_at: new Date() }, name);
}

// What the nightly finder verified for a card, kept here too, so the Deal
// Scan, the editor and the athlete see the same address for that person.
async function remember(pool, { brand, name, email, domain = null, verdict = 'valid', how = 'nightly' }) {
  if (!brand || !name || !email) return;
  await ensureTable(pool);
  await pool.query(
    `INSERT INTO finder_addresses (brand_key, person, domain, email, verdict, how, why, found_at)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,NOW())
     ON CONFLICT (brand_key, person) DO UPDATE SET domain = EXCLUDED.domain, email = EXCLUDED.email, verdict = EXCLUDED.verdict,
       how = EXCLUDED.how, why = NULL, found_at = NOW()`,
    [keyOf(brand), lc(name), domain || String(email).split('@')[1] || null, lc(email), verdict, how])
    .catch((e) => console.error('[finder-address] remember: ' + e.message));
}

// ── NOTHING ELSE REACHES THE BROWSER ────────────────────────────────────────
// Keys that carry an address someone other than the finder produced, and the
// notes that only describe one.
const ADDRESS_KEYS = new Set([
  'email', 'contactEmail', 'contact_email', 'genericInbox', 'personalInbox', 'general_email', 'generalEmail',
  'personalEmail', 'roleEmail', 'bookingEmail', 'fbEmail', 'inbox',
]);
const DROP_KEYS = new Set([
  'siteEmail', 'addressLadder', 'emailCheck', 'genericInboxCheck', 'personalInboxCheck', 'emailSource', 'emailKind',
  'emailTier', 'emailTierReason', 'emailDomainNote', 'emailType', 'emailSourceUrl', 'email_check', 'emailScore',
]);
// Strip in place, deeply. `finder` objects (ours) and arrays of plain values pass.
function strip(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return obj;
  if (Array.isArray(obj)) { for (const x of obj) strip(x, depth + 1); return obj; }
  for (const k of Object.keys(obj)) {
    if (k === 'finder') continue;
    if (ADDRESS_KEYS.has(k) && (typeof obj[k] === 'string' || obj[k] === null)) { delete obj[k]; continue; }
    if (DROP_KEYS.has(k)) { delete obj[k]; continue; }
    if (k === 'hunterPattern' || k === 'emailPattern') { if (obj[k] && typeof obj[k] === 'object') delete obj[k].example; continue; }
    if (obj[k] && typeof obj[k] === 'object') strip(obj[k], depth + 1);
  }
  return obj;
}

// A contact list with the finder's address on each named person it has one
// for (cached: free). Each address carries its Verified / Not verified label.
async function annotate(pool, brand, contacts) {
  if (!Array.isArray(contacts)) return contacts;
  for (const c of contacts) {
    if (!c || !c.name) continue;
    const f = await cached(pool, brand, c.name);
    if (f && f.email) { c.email = f.email; c.emailVerified = f.verified; c.emailLabel = f.label; c.emailFrom = 'finder'; }
  }
  return contacts;
}

// Deep, after strip(): every named person in a `contacts` list or a ladder's
// `rows`, and every card's `contactName`, gets the finder's address for that
// business when it has one (cached: free), with its label. Nothing else.
const PEOPLE_KEYS = new Set(['contacts', 'rows', 'notAffiliated']);
function brandOf(o, inherited) {
  if (typeof o.brand === 'string' && o.brand) return o.brand;
  if (o.brand && typeof o.brand.name === 'string') return o.brand.name;
  if (typeof o.brand_name === 'string' && o.brand_name) return o.brand_name;
  if (typeof o.brandName === 'string' && o.brandName) return o.brandName;
  return inherited || null;
}
async function annotateDeep(pool, obj, brand = null, inPeople = false, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return obj;
  if (Array.isArray(obj)) { for (const x of obj) await annotateDeep(pool, x, brand, inPeople, depth + 1); return obj; }
  const b = brandOf(obj, brand);
  if (b && typeof obj.contactName === 'string' && obj.contactName && !obj.contactEmail) {
    const f = await cached(pool, b, obj.contactName);
    if (f && f.email) { obj.contactEmail = f.email; obj.contactEmailVerified = f.verified; obj.contactEmailLabel = f.label; obj.contactEmailFrom = 'finder'; }
  }
  if (inPeople && b && typeof obj.name === 'string' && obj.name && !obj.email) {
    const f = await cached(pool, b, obj.name);
    if (f && f.email) { obj.email = f.email; obj.emailVerified = f.verified; obj.emailLabel = f.label; obj.emailFrom = 'finder'; }
  }
  for (const k of Object.keys(obj)) {
    if (k === 'finder' || !obj[k] || typeof obj[k] !== 'object') continue;
    await annotateDeep(pool, obj[k], b, PEOPLE_KEYS.has(k), depth + 1);
  }
  return obj;
}

module.exports = { ON, FRESH_DAYS, ensureTable, forPerson, cached, remember, strip, annotate, annotateDeep, ADDRESS_KEYS, DROP_KEYS };
