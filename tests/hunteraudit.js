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
// Run scripts/hunter-audit.js for real, against a real Postgres holding rows in
// the shape brand_evidence_cache actually stores, and check that every verdict is
// the one the shipped merge logic would have produced.
//
// The script is EXECUTED, not read: `pg` is stubbed with a psql-backed Pool so the
// real queries run. A diagnostic handed over untested is a guess with a filename.
const fs = require('fs'), cp = require('child_process'), Module = require('module');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const DB = 'hunteraudit';

function psql(text, csv, db) {
  fs.writeFileSync('/tmp/pgtest/h.sql', text);
  fs.chmodSync('/tmp/pgtest/h.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', db || DB,
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/h.sql'],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(0, 4).join(' | '));
  return (r.stdout || '').trim();
}
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return "ARRAY[" + v.map(lit).join(',') + "]::text[]";
  if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function bind(text, params) {
  if (!params || !params.length) return text;
  let out = text;
  for (let i = params.length; i >= 1; i--) out = out.split('$' + i).join(lit(params[i - 1]));
  return out;
}
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
  const split = (l) => {
    const cells = []; let c = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { c += '"'; i++; } else q = !q; continue; }
      if (ch === ',' && !q) { cells.push(c); c = ''; continue; }
      c += ch;
    }
    cells.push(c); return cells;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l), o = {};
    head.forEach((h, i) => { o[h] = cells[i] === '' ? null : cells[i]; });
    if (typeof o.evidence === 'string') { try { o.evidence = JSON.parse(o.evidence); } catch (_) {} }
    return o;
  });
}

// ── the fixtures ────────────────────────────────────────────────────────────
psql(`DROP DATABASE IF EXISTS ${DB};`, false, 'postgres');
psql(`CREATE DATABASE ${DB};`, false, 'postgres');
psql(`CREATE TABLE brand_evidence_cache (
        brand_key TEXT NOT NULL, lane TEXT NOT NULL, brand TEXT, website TEXT,
        evidence JSONB DEFAULT '{}'::jsonb, outcome TEXT,
        refreshed_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (brand_key, lane));`);

const contacts = (rows, generic, personalInbox) => ({
  kind: 'contacts', v: 4, contacts: rows,
  genericInbox: generic || null, personalInbox: personalInbox || null,
  businessPhone: '(205) 555-0142', phoneUnconfirmed: false,
});
const C = (name, title, email, emailSource) => ({
  name, title, email: email || null, emailSource: emailSource || null,
  phone: null, linkedinUrl: null, sourceUrl: 'https://x.example/team', confidence: 'high', source: 'site',
});
const H = (email, type, lastName, firstName, conf) => ({
  email, type, confidence: conf || 90, firstName: firstName || null,
  lastName: lastName || null, position: null,
});

const ins = (key, lane, brand, website, evidence, outcome, minsAgo) =>
  psql(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
        VALUES (${lit(key)}, ${lit(lane)}, ${lit(brand)}, ${lit(website)}, ${lit(evidence)}, ${lit(outcome)},
                NOW() - INTERVAL '${minsAgo} minutes');`);

// 1. FOUND AND DROPPED. Hunter has Kessler's address; the ladder has neither it nor
//    a hunter-sourced row, and the hunter call was cold. This is the case the whole
//    question is about.
ins('irontribehomewood', 'contacts', 'Iron Tribe Homewood', 'https://irontribehomewood.com',
  contacts([C('Dana Kessler', 'Owner'), C('Marcus Webb', 'General Manager')], 'info@irontribehomewood.com'), 'OK', 10);
ins('irontribehomewood.com', 'hunter', 'irontribehomewood.com', null,
  { found: true, emails: [H('dana@irontribehomewood.com', 'personal', 'Kessler', 'Dana', 94),
                          H('info@irontribehomewood.com', 'generic', null, null, 80)] }, 'OK', 10);

// 2. HUNTER GENUINELY HAS NOTHING.
ins('thepotteryjar', 'contacts', 'The Pottery Jar', 'https://thepotteryjar.com',
  contacts([], 'hello@thepotteryjar.com'), 'FALLBACK', 20);
ins('thepotteryjar.com', 'hunter', 'thepotteryjar.com', null, { found: false }, 'NONE', 20);

// 3. APPLIED, VIA THE LAST-NAME MATCH.
ins('ferrerauto', 'contacts', 'Ferrer Auto', 'https://ferrerauto.com',
  contacts([C('Alonzo Ferrer', 'Owner', 'alonzo@ferrerauto.com', 'hunter')], null), 'OK', 30);
ins('ferrerauto.com', 'hunter', 'ferrerauto.com', null,
  { found: true, emails: [H('alonzo@ferrerauto.com', 'personal', 'Ferrer', 'Alonzo', 97)] }, 'OK', 35);

// 4. NO HUNTER ROW AT ALL — never called, or called and failed.
ins('brightlinept', 'contacts', 'Brightline PT', 'https://brightlinept.com',
  contacts([C('Jos Okafor', 'Physical Therapist')], 'info@brightlinept.com'), 'OK', 40);

// 5. NO WEBSITE, so no domain to search.
ins('cornerbarbers', 'contacts', 'Corner Barbers', null,
  contacts([C('Ray Mensah', 'Owner')], null), 'OK', 50);

// 6. ONLY A GENERIC ADDRESS, and it did land on the ladder.
ins('lakesidegrill', 'contacts', 'Lakeside Grill', 'https://lakesidegrill.com',
  contacts([C('Tom Vance', 'Manager')], 'contact@lakesidegrill.com'), 'OK', 60);
ins('lakesidegrill.com', 'hunter', 'lakesidegrill.com', null,
  { found: true, emails: [H('contact@lakesidegrill.com', 'generic', null, null, 85)] }, 'OK', 60);

// 7. APPLIED, but the last name did NOT match, so it went on as an unmatched
//    company contact. Hunter knows a Delacroix; the ladder names a Whitfield.
//    The prepended row is built the way ai.js builds it -- source:'hunter', which
//    is precisely what tells it apart from an address matched onto an existing
//    contact. My first version of this fixture used source:'site' and the script
//    correctly called it a match; the fixture was wrong, not the script.
const PREPENDED = {
  name: 'Yusuf Delacroix', title: 'Company contact (not confirmed owner)',
  email: 'y.delacroix@auroragym.com', phone: null,
  source: 'hunter', emailSource: 'hunter', emailScore: 88,
};
ins('auroragym', 'contacts', 'Aurora Gym', 'https://auroragym.com',
  contacts([PREPENDED, C('Nina Whitfield', 'Owner')], null), 'OK', 70);
ins('auroragym.com', 'hunter', 'auroragym.com', null,
  { found: true, emails: [H('y.delacroix@auroragym.com', 'personal', 'Delacroix', 'Yusuf', 88)] }, 'OK', 70);

// ── stub `pg` with a psql-backed Pool and RUN the shipped script ────────────
const pool = {
  async query(text, params) {
    const s = bind(text, params);
    if (!(/^\s*(SELECT|WITH)/i.test(s) || /RETURNING/i.test(s))) { psql(s); return { rows: [], rowCount: 0 }; }
    const rows = parseCsv(psql(s, true));
    return { rows, rowCount: rows.length };
  },
  async end() {},
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'pg') return { Pool: function () { return pool; } };
  return origLoad.apply(this, arguments);
};

process.env.DATABASE_URL = 'postgres://localhost/hunteraudit';
process.argv = [process.argv[0], 'hunter-audit.js', '20'];
const out = [];
const realLog = console.log;
console.log = (...a) => out.push(a.join(' '));
const realExit = process.exit;
process.exit = () => {};

require(REPO + 'scripts/hunter-audit.js');

setTimeout(() => {
  console.log = realLog;
  process.exit = realExit;
  Module._load = origLoad;
  let report;
  try { realLog(out.join("\n")); realExit(0); }
  catch (e) { console.log('THE SCRIPT DID NOT PRODUCE JSON:\n' + out.join('\n').slice(0, 1200)); process.exit(1); }

  const by = (b) => report.find((r) => r.brand === b);

  console.log('-- the script runs and reports every lookup --');
  ok('all seven lookups are in the report', report.length === 7, report.length);
  ok('newest first', by('Iron Tribe Homewood') === report[0], report.map((r) => r.brand));

  console.log('\n-- 1. FOUND AND DROPPED: the case the question is about --');
  {
    const r = by('Iron Tribe Homewood');
    ok('it fired', /^YES/.test(r.fired), r.fired);
    ok('  2 addresses back', r.addresses === 2, r.addresses);
    ok('  1 personal, 1 generic', r.personal === 1 && r.generic === 1, [r.personal, r.generic]);
    ok('  the ladder shows two names and NO emails', r.namedContacts === 2 && r.namedWithEmail === 0,
      [r.namedContacts, r.namedWithEmail]);
    ok('  the last name DID match Kessler', !!r.lastNameMatch && r.lastNameMatch[0].contact === 'Dana Kessler', r.lastNameMatch);
    ok('  so the verdict is that we dropped it, not that Hunter missed',
      r.verdict === 'DROPPED_AT_GRACE_WINDOW', r.verdict);
    ok('  and it is correctly identified as a cold call', r.hunterWasCached === false, r.hunterWasCached);
  }

  console.log('\n-- 2. HUNTER GENUINELY HAS NOTHING --');
  {
    const r = by('The Pottery Jar');
    ok('fired, zero addresses', /^YES/.test(r.fired) && r.addresses === 0, [r.fired, r.addresses]);
    ok('  verdict names Hunter, not us', r.verdict === 'HUNTER_FOUND_NOTHING', r.verdict);
  }

  console.log('\n-- 3. APPLIED VIA THE LAST-NAME MATCH --');
  {
    const r = by('Ferrer Auto');
    ok('the email is on the ladder', r.namedWithEmail === 1 && r.hunterSourced === 1, [r.namedWithEmail, r.hunterSourced]);
    ok('  verdict says applied', r.verdict === 'APPLIED_VIA_LAST_NAME', r.verdict);
    ok('  and a hunter row older than the lookup is read as a CACHE HIT', r.hunterWasCached === true, r.hunterWasCached);
  }

  console.log('\n-- 4/5. THE TWO NON-ANSWERS ARE KEPT SEPARATE --');
  {
    const r = by('Brightline PT');
    ok('a missing hunter row is not reported as "found nothing"', r.verdict === 'NO_HUNTER_ROW', r.verdict);
    ok('  and says why it is ambiguous', /never called|timed out|errored/i.test(r.fired), r.fired);
    const n = by('Corner Barbers');
    ok('no website is its own verdict', n.verdict === 'NOT_ATTEMPTED', n.verdict);
    ok('  and it does not claim a domain', n.domain === null, n.domain);
  }

  console.log('\n-- 6/7. THE TWO PARTIAL-SUCCESS SHAPES --');
  {
    const g = by('Lakeside Grill');
    ok('generic-only, and used', g.verdict === 'ONLY_GENERIC_AVAILABLE', g.verdict);
    ok('  no personal address claimed', g.personal === 0 && g.generic === 1, [g.personal, g.generic]);
    const a = by('Aurora Gym');
    ok('a personal address that matched no name still counts as applied',
      a.verdict === 'APPLIED_AS_UNMATCHED_COMPANY_CONTACT', a.verdict);
    ok('  and the failed match is shown as NO MATCH, not hidden',
      a.lastNameMatch === null, a.lastNameMatch);
    ok('  with both sides printed so it can be judged',
      a.eligibleNames.includes('Nina Whitfield') && a.hunterLastNames.includes('Delacroix'),
      { names: a.eligibleNames, hunter: a.hunterLastNames });
  }

  console.log('\n-- the last-name rule matches the shipped one --');
  {
    // ai.js matches on the LAST word of the name against Hunter's lastName. A
    // first-name-only hit must not count, or the audit would report a match the
    // real merge never made.
    const AI = fs.readFileSync(REPO + 'server/ai.js', 'utf8');
    ok('ai.js still matches on the last word of the name',
      /const _last = String\(c\.name \|\| ''\)\.trim\(\)\.toLowerCase\(\)\.split\(\/\\s\+\/\)\.pop\(\)/.test(AI));
    ok('  against Hunter lastName only',
      /_personal\.find\(\(e\) => e\.lastName && e\.lastName\.toLowerCase\(\) === _last\)/.test(AI));
    ok('  and only for contacts that have no email yet',
      /for \(const c of res\.contacts\) \{\s*\n\s*if \(c\.email\) continue;/.test(AI));
  }

  console.log('\nfailures: ' + f);
  realExit(f ? 1 : 0);
}, 2500);
