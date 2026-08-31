'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// THE FAN-OUT WORKED AND THE CARD NEVER ASKED FOR THE RESULT.
//
//   [brand-contacts] source=chamber ms=4508 found=4 tier1=yes parsed=4
//   [brand-contacts] fanout brand=Pack Rat Outdoor Center sources=3/7 totalMs=4510
//
// Four contacts including a Tier 1, and the card said "No named contact found.
// Call (479) 521-6340."
//
// Nothing dropped them. The deep fan-out writes under "<brand> | <region> | manual"
// and the card's lazy contact fill asks for "<brand> | <region>" -- a key only ever
// written by the CHEAP pass, which returns an empty list by design. Two keys, and
// the one the card reads can never contain a person.
//
// The SHIPPED _fetchBrandContacts is executed against a real Postgres holding a
// real deep row.
const fs = require('fs'), cp = require('child_process');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const AI = fs.readFileSync(R + 'server/ai.js', 'utf8');
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');
const DB = 'deeprow';

function psql(text, csv, db) {
  fs.writeFileSync('/tmp/pgtest/d.sql', text);
  fs.chmodSync('/tmp/pgtest/d.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', db || DB,
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/d.sql'],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(0, 4).join(' | '));
  return (r.stdout || '').trim();
}
const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";

psql(`DROP DATABASE IF EXISTS ${DB};`, false, 'postgres');
psql(`CREATE DATABASE ${DB};`, false, 'postgres');
psql(`CREATE TABLE brand_evidence_cache (brand_key TEXT NOT NULL, lane TEXT NOT NULL,
        brand TEXT, website TEXT, evidence JSONB DEFAULT '{}'::jsonb, outcome TEXT,
        refreshed_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (brand_key, lane));`);

// A real store, backed by psql, with the two functions _fetchBrandContacts uses.
const store = {
  async getBrandEvidence(brandKey, lane, maxAgeDays = 7) {
    const rows = psql(`SELECT brand, website, evidence, outcome, refreshed_at
       FROM brand_evidence_cache WHERE brand_key = ${q(String(brandKey).trim().toLowerCase())} AND lane = ${q(lane)}
        AND refreshed_at > NOW() - (${q(String(maxAgeDays))} || ' days')::interval LIMIT 1`, true);
    const lines = rows.split('\n').filter(Boolean);
    if (lines.length < 2) return null;
    // evidence is the only column we need and it is JSON; pull it out by position.
    const m = rows.match(/\{.*\}/s);
    return { evidence: m ? JSON.parse(m[0].replace(/""/g, '"').replace(/^"|"$/g, '')) : {}, outcome: 'OK' };
  },
  async saveBrandEvidence() {},
  scanMeter: { bumpHit() {}, bumpMiss() {} },
};

const CONTACTS = [
  { name: 'Bryan Hembree', title: 'Owner', email: null, phone: null, source: 'chamber', confidence: 'medium' },
  { name: 'Sarah Hembree', title: 'Co-Owner', email: null, phone: null, source: 'chamber', confidence: 'medium' },
  { name: 'Mike Reeves', title: 'Store Manager', email: null, phone: null, source: 'chamber', confidence: 'medium' },
  { name: 'Jen Castillo', title: 'Sales Associate', email: null, phone: null, source: 'chamber', confidence: 'medium' },
];
const VERSION = parseInt((AI.match(/const _CONTACTS_CACHE_VERSION = (\d+);/) || [])[1], 10);
const EV = { kind: 'contacts', v: VERSION, contacts: CONTACTS, genericInbox: null,
  personalInbox: null, businessPhone: '(479) 521-6340', phoneUnconfirmed: false };

const BRAND = 'Pack Rat Outdoor Center';
const REGION = 'Fayetteville, AR';
// Written the way the DEEP path writes it: canonical region plus the manual suffix.
const { canonicalRegion } = require(R + 'server/services/regionKey.js');
const DEEP_KEY = `${BRAND} | ${canonicalRegion(REGION)} | manual`;
const CHEAP_KEY = `${BRAND} | ${canonicalRegion(REGION)}`;
psql(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome)
      VALUES (${q(DEEP_KEY.toLowerCase())}, 'contacts', ${q(BRAND)}, NULL, ${q(JSON.stringify(EV))}::jsonb, 'OK');`);

// ── run the SHIPPED cheap path ──────────────────────────────────────────────
function liftFn(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) throw new Error('FIXTURE BROKEN: ' + sig);
  let i = src.indexOf('(', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (!depth) { i++; break; } }
  }
  let j = src.indexOf('{', i), d = 0, end = j;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { end = j; break; } } }
  return src.slice(start, end + 1);
}
const FETCH = liftFn(AI, 'async function _fetchBrandContacts(');
let fanoutRan = 0;
const mkFetch = () => new Function(
  'store', 'canonicalRegion', 'normalizeState', '_CONTACTS_CACHE_VERSION', '_CONTACT_SOURCES',
  'MANUAL_SOURCE_ORDER', '_phoneLocalityOk', '_domainFromUrl', 'runSourceWaves', '_searchContactSource',
  '_mergeContacts', '_contactAuthorityRank', '_TIER1_RANKS', '_isGenericInbox', '_localPartMatchesName',
  '_normalizePhone', '_validEmail', '_cleanStr', 'stateName', '_extractContactsFromProse',
  '_parseContactsPayload', '_safeUrl', '_labelTitle', '_CR', 'console',
  FETCH + '\n return _fetchBrandContacts;')(
  store, canonicalRegion, require(R + 'server/areaCodes').normalizeState, VERSION,
  ['registry', 'facebook', 'maps', 'news', 'chamber', 'site', 'linkedin'],
  ['site', 'facebook', 'chamber', 'linkedin', 'maps', 'news', 'registry'],
  () => ({ ok: true, reason: 'ok' }), (u) => String(u || ''),
  async () => { fanoutRan++; return { results: [], ms: 0, waveSize: 3, wavesRun: 0 }; },
  async () => ({ source: 'x', contacts: [], kept: 0 }),
  (a) => a, () => 7, [0, 1, 2, 4, 5], () => false, () => false,
  (p) => p, (e) => e,
  (v) => (v == null ? null : String(v).trim() || null),
  (a) => a, () => [], () => null, (u) => u, (src2, t) => t,
  // _fetchBrandContacts ranks and flags through services/contactRank now.
  require(R + 'server/services/contactRank'),
  { log() {}, warn() {} });

(async () => {
  console.log('-- THE CHEAP CARD PASS, WITH A DEEP ROW ALREADY IN THE CACHE --');
  {
    fanoutRan = 0;
    const out = await mkFetch()(BRAND, null, false, REGION, { localityRequired: true, allowSearch: false });
    ok('THE CARD GETS THE FOUR CONTACTS', (out.contacts || []).length === 4, (out.contacts || []).length);
    ok('  including the Tier 1 owner',
      (out.contacts || []).some((c) => c.name === 'Bryan Hembree'), (out.contacts || []).map((c) => c.name));
    ok('  and the main line', out.businessPhone === '(479) 521-6340', out.businessPhone);
    ok('  it is marked as served from cache', out.cached === true, out.cached);
    ok('  and NO fan-out was run for it', fanoutRan === 0, fanoutRan);
  }

  console.log('\n-- WITH NO DEEP ROW, THE CHEAP PASS IS UNCHANGED --');
  {
    fanoutRan = 0;
    const out = await mkFetch()('Nowhere Cafe', null, false, REGION, { localityRequired: true, allowSearch: false });
    ok('it returns nothing rather than inventing anything', (out.contacts || []).length === 0, out.contacts);
    ok('  and is reported as SKIPPED, exactly as before', out.outcome === 'SKIPPED', out.outcome);
    ok('  with no fan-out', fanoutRan === 0, fanoutRan);
  }

  console.log('\n-- THE ASYMMETRY IS ONE-WAY: A DEEP CALLER NEVER READS A SHALLOW ROW --');
  {
    // A shallow row for a different business, and a deep request for it.
    const shallow = { kind: 'contacts', v: VERSION, contacts: [], genericInbox: null,
      personalInbox: null, businessPhone: '(479) 555-0000', phoneUnconfirmed: false };
    const B2 = 'Shallow Only Co';
    psql(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome)
          VALUES (${q((B2 + ' | ' + canonicalRegion(REGION)).toLowerCase())}, 'contacts', ${q(B2)}, ${q(JSON.stringify(shallow))}::jsonb, 'OK');`);
    fanoutRan = 0;
    const out = await mkFetch()(B2, null, false, REGION,
      { localityRequired: true, allowSearch: true, stopAtTier1: true, sourceOrder: ['site'] });
    ok('the deep path does NOT serve itself the shallow row', out.cached !== true, out);
    ok('  it runs the fan-out instead', fanoutRan === 1, fanoutRan);
  }

  console.log('\n-- AND THE CARD RENDERS A LADDER, NOT A FLAT LIST --');
  {
    const batch = SRV.slice(SRV.indexOf('async function _brandContactsBatch'), SRV.indexOf("app.post('/api/agent/brand-contacts'"));
    ok('the cheap branch builds a ladder when it has named contacts',
      /if \(named\) \{[\s\S]{0,260}buildContactLadder\(out/.test(batch), (batch.match(/const named = [\s\S]{0,300}/) || [])[0]);
    ok('  and still returns the bare shape when it has none',
      /return \{ brand: b\.brand, \.\.\.out \};/.test(batch), null);
    // Prove the ladder that would be built is the actionable one.
    const { buildContactLadder } = require(R + 'server/services/contactLadder');
    // _contactAuthorityRank now delegates to services/contactRank, so the lifted
    // copy needs the same binding the module has.
    const _CR = require(R + 'server/services/contactRank');
    const rankOf = new Function('_CR', liftFn(AI, 'function _contactAuthorityRank(title) {') + '\n return _contactAuthorityRank;')(_CR);
    const L = buildContactLadder({ contacts: CONTACTS, businessPhone: '(479) 521-6340' },
      { rankOf, category: 'outdoor retail', brand: BRAND });
    ok('the ladder has a Tier 1', L.hasTier1 === true, L.hasTier1);
    ok('  naming the owner', (L.tiers[0].rows || []).some((r) => r.name === 'Bryan Hembree'),
      L.tiers[0].rows.map((r) => r.name));
    ok('  with the main line to ask on', !!L.mainLine, L.mainLine);
    ok('  and the sales associate held back as staff', L.staffHeldBack === 1, L.staffHeldBack);
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
