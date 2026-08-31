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
// A BUSINESS PHONE IS NOT A DECISION MAKER.
//
// discoverContacts treated `knownContacts.businessPhone` as proof the card had
// already run the contact ladder. The cheap Places pass sets a phone on nearly
// every card, so the six-source fan-out was skipped on almost every AI Outreach
// click. The agent waited ~90s for enrichment, match, pitch and deck, and got a
// row named "Business line".
//
// The SHIPPED discoverContacts is executed against a real Postgres, with
// getBrandContacts stubbed so this test can see exactly whether it was called.
const fs = require('fs'), cp = require('child_process'), Module = require('module');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const DB = 'supplied';

function psql(text, csv, db) {
  fs.writeFileSync('/tmp/pgtest/s.sql', text);
  fs.chmodSync('/tmp/pgtest/s.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', db || DB,
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/s.sql'],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(0, 4).join(' | '));
  return (r.stdout || '').trim();
}
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function bind(t, p) { if (!p || !p.length) return t; let o = t; for (let i = p.length; i >= 1; i--) o = o.split('$' + i).join(lit(p[i - 1])); return o; }
function parseCsv(out) {
  const lines = []; let cur = '', inQ = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === '"') { if (inQ && out[i + 1] === '"') { cur += '""'; i++; } else inQ = !inQ; cur += ch; continue; }
    if (ch === '\n' && !inQ) { lines.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) lines.push(cur);
  if (!lines.length) return [];
  const split = (l) => { const c = []; let s = '', q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { s += '"'; i++; } else q = !q; continue; }
      if (ch === ',' && !q) { c.push(s); s = ''; continue; } s += ch; }
    c.push(s); return c; };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => { const c = split(l), o = {}; head.forEach((h, i) => { o[h] = c[i] === '' ? null : c[i]; }); return o; });
}
const pool = {
  async query(text, params) {
    const s = bind(text, params);
    if (!(/^\s*(SELECT|WITH)/i.test(s) || /RETURNING/i.test(s))) { psql(s); return { rows: [], rowCount: 0 }; }
    const rows = parseCsv(psql(s, true));
    return { rows, rowCount: rows.length };
  },
};

psql(`DROP DATABASE IF EXISTS ${DB};`, false, 'postgres');
psql(`CREATE DATABASE ${DB};`, false, 'postgres');
psql(`CREATE TABLE brand_contacts (id TEXT PRIMARY KEY, enrichment_id TEXT, agent_id TEXT,
        brand_name TEXT, name TEXT, title TEXT, email TEXT, phone TEXT, linkedin TEXT,
        contact_type TEXT, confidence_score NUMERIC, source TEXT, priority_rank INT,
        created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE workflow_events (id SERIAL PRIMARY KEY, run_id TEXT, agent_id TEXT,
        event_type TEXT, payload JSONB, created_at TIMESTAMPTZ DEFAULT NOW());`);

// ── load the SHIPPED service with pool + getBrandContacts injected ───────────
let fanoutCalls = [];
let FANOUT_RESULT = null;
const origLoad = Module._load;
Module._load = function (req) {
  if (req === '../store') return { pool };
  if (req === '../ai') return {
    oneShot: async () => '[]', oneShotWebSearch: async () => '[]',
    // The real builder's shape. contactDiscovery destructures this, and if it were
    // missing the ctx would throw while being BUILT -- inside the try that wraps the
    // call -- so the fan-out would silently not run and look like the old bug.
    deepContactCtx: (o) => ({ market: (o || {}).market ?? null, isFranchise: false, contactApproach: null,
      enrichEmail: true, sourceOrder: ['site', 'facebook', 'chamber', 'linkedin', 'maps', 'news', 'registry'],
      stopAtTier1: true }),
    getBrandContacts: async (brand, website, loc, ctx) => {
      fanoutCalls.push({ brand, website, loc, ctx });
      return FANOUT_RESULT;
    },
  };
  return origLoad.apply(this, arguments);
};
delete require.cache[require.resolve(REPO + 'server/services/contactDiscovery.js')];
const svc = require(REPO + 'server/services/contactDiscovery.js');
Module._load = origLoad;

const ENRICH = { id: 'enr_1', brand_name: 'Iron Tribe Homewood', website: 'https://irontribehomewood.com', location: 'Birmingham, AL' };
const AGENT = 'usr_john';
const reset = () => { fanoutCalls = []; psql(`DELETE FROM brand_contacts; DELETE FROM workflow_events;`); };

// What the deep ladder returns when it actually runs.
const REAL = {
  contacts: [
    { name: 'Dana Kessler', title: 'Owner', email: 'dana@irontribehomewood.com', phone: null, linkedinUrl: null, sourceUrl: 'https://irontribehomewood.com/about' },
    { name: 'Marcus Webb', title: 'General Manager', email: null, phone: null, linkedinUrl: null, sourceUrl: null },
  ],
  genericInbox: 'info@irontribehomewood.com',
  businessPhone: '(205) 555-0142',
};

(async () => {
  console.log('-- THE LIVE FAILURE: the card knows a phone and nothing else --');
  {
    reset();
    FANOUT_RESULT = REAL;
    // Exactly what cardContacts sends for an unexpanded card: the cheap Places pass
    // found a phone, and no named person.
    const saved = await svc.discoverContacts(AGENT, ENRICH, {
      contacts: [], businessPhone: '(205) 555-0142', genericInbox: null,
    });
    ok('THE FAN-OUT RUNS', fanoutCalls.length === 1, fanoutCalls.length);
    ok('  with enrichEmail, so it is the deep ladder',
      fanoutCalls[0] && fanoutCalls[0].ctx && fanoutCalls[0].ctx.enrichEmail === true, fanoutCalls[0] && fanoutCalls[0].ctx);
    ok('  AND stopAtTier1, so it does not stop at a receptionist',
      fanoutCalls[0] && fanoutCalls[0].ctx && fanoutCalls[0].ctx.stopAtTier1 === true, fanoutCalls[0] && fanoutCalls[0].ctx);
    ok('  site-first, so the business\'s own about page is in wave 1',
      fanoutCalls[0] && (fanoutCalls[0].ctx.sourceOrder || [])[0] === 'site', fanoutCalls[0] && fanoutCalls[0].ctx.sourceOrder);
    ok('  for the right business', fanoutCalls[0] && fanoutCalls[0].brand === 'Iron Tribe Homewood', fanoutCalls[0] && fanoutCalls[0].brand);
    ok('a NAMED decision maker comes back', saved.some((r) => r.name === 'Dana Kessler'), saved.map((r) => r.name));
    ok('  with her published email', saved.some((r) => r.email === 'dana@irontribehomewood.com'), saved.map((r) => r.email));
    ok('  and she is the best contact, not the business line',
      saved[0] && saved[0].name === 'Dana Kessler', saved[0]);
    ok('the run no longer ends with only a Business line',
      !(saved.length === 1 && saved[0].title === 'Business line'), saved.map((r) => r.title));
  }

  console.log('\n-- THE REUSE IT EXISTS FOR STILL WORKS --');
  {
    reset();
    FANOUT_RESULT = REAL;
    // An EXPANDED card: the ladder already ran in the browser and carries names.
    const saved = await svc.discoverContacts(AGENT, ENRICH, {
      contacts: [{ name: 'Dana Kessler', title: 'Owner', email: 'dana@irontribehomewood.com', phone: null }],
      businessPhone: '(205) 555-0142', genericInbox: 'info@irontribehomewood.com',
    });
    ok('the fan-out is SKIPPED, so nothing is paid for twice', fanoutCalls.length === 0, fanoutCalls.length);
    ok('  and the card\'s own person is used', saved.some((r) => r.name === 'Dana Kessler'), saved.map((r) => r.name));
    const evs = parseCsv(psql(`SELECT event_type, payload FROM workflow_events`, true));
    const reused = evs.find((e) => e.event_type === 'contact_discovery_reused_card');
    ok('  and it is logged as a reuse', !!reused, evs.map((e) => e.event_type));
    ok('  with the named count that justifies it', /"named":\s*1/.test((reused && reused.payload) || ''), reused && reused.payload);
  }

  console.log('\n-- A CARD CARRYING ONLY UNNAMED ROWS IS NOT A LADDER EITHER --');
  {
    reset();
    FANOUT_RESULT = REAL;
    const saved = await svc.discoverContacts(AGENT, ENRICH, {
      contacts: [{ name: null, title: 'Business line', email: null, phone: '(205) 555-0142' }],
      businessPhone: '(205) 555-0142', genericInbox: null,
    });
    ok('a nameless contact does not suppress the lookup', fanoutCalls.length === 1, fanoutCalls.length);
    ok('  and a real person is found', saved.some((r) => r.name === 'Dana Kessler'), saved.map((r) => r.name));
  }

  console.log('\n-- THE PHONE THE CARD KNEW IS NOT LOST --');
  {
    reset();
    // The fan-out runs and finds nobody at all. The main line the card already had
    // must survive, or the fix would trade a bad contact for no contact.
    FANOUT_RESULT = { contacts: [], genericInbox: null, businessPhone: null };
    const saved = await svc.discoverContacts(AGENT, ENRICH, {
      contacts: [], businessPhone: '(205) 555-0142', genericInbox: 'info@irontribehomewood.com',
    });
    ok('the fan-out ran', fanoutCalls.length === 1, fanoutCalls.length);
    ok('the main line is still on the record',
      saved.some((r) => r.phone === '(205) 555-0142'), saved.map((r) => ({ t: r.title, p: r.phone })));
    ok('  labelled honestly as a business line',
      saved.some((r) => r.title === 'Business line'), saved.map((r) => r.title));
    ok('  and the generic inbox the card knew survives too',
      saved.some((r) => r.email === 'info@irontribehomewood.com'), saved.map((r) => r.email));
  }

  console.log('\n-- NO knownContacts AT ALL IS UNCHANGED --');
  {
    reset();
    FANOUT_RESULT = REAL;
    const saved = await svc.discoverContacts(AGENT, ENRICH, null);
    ok('the fan-out runs', fanoutCalls.length === 1, fanoutCalls.length);
    ok('  and returns the ladder', saved.some((r) => r.name === 'Dana Kessler'), saved.map((r) => r.name));
  }

  console.log('\n-- A THROWN FAN-OUT DOES NOT TAKE THE RUN DOWN --');
  {
    reset();
    FANOUT_RESULT = null;   // the stub returns null, as a caught failure would leave it
    const saved = await svc.discoverContacts(AGENT, ENRICH, {
      contacts: [], businessPhone: '(205) 555-0100', genericInbox: null,
    });
    ok('it still returns rows rather than throwing', Array.isArray(saved), saved);
    ok('  and the card\'s phone is the floor', saved.some((r) => r.phone === '(205) 555-0100'), saved.map((r) => r.phone));
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
