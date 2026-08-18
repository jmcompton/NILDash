#!/usr/bin/env node
// scripts/hunter-audit.js
//
// Answers, per deep contact lookup: did Hunter fire, did its result reach the
// ladder or get dropped, how many addresses came back, personal vs generic, and
// whether the last-name match succeeded.
//
// WHY THE DATABASE AND NOT THE LOGS. hunterLookup.js caches every ANSWERED Hunter
// call in brand_evidence_cache (lane 'hunter', 30 days), and the contact fan-out
// caches its result beside it (lane 'contacts'). The cache is written by the
// lookup itself, BEFORE and independently of whether ai.js managed to use the
// answer -- which is exactly what makes "Hunter found nothing" distinguishable
// from "Hunter found them and we dropped it". Logs rotate; these rows do not.
//
// THE ONE THING THIS CANNOT SEE: a call that timed out or errored writes no row
// at all (findDomainEmails returns null before saving). So "no hunter row" is
// ambiguous between "never called" and "called and failed". Every other state is
// decided exactly. Grep the logs for `[hunter] @<domain>` to split that one case.
//
// Usage:
//   DATABASE_URL=... node scripts/hunter-audit.js            # last 20 lookups
//   DATABASE_URL=... node scripts/hunter-audit.js 40         # last 40
//   DATABASE_URL=... node scripts/hunter-audit.js 20 --json  # machine readable

'use strict';

const { Pool } = require('pg');

const LIMIT = parseInt(process.argv[2], 10) || 20;
const AS_JSON = process.argv.includes('--json');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. On Railway: railway run node scripts/hunter-audit.js');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
});

// ── copies of the shipped rules, so the audit decides the same way the code did ──
// _domainFromUrl and the Hunter last-name match in server/ai.js.
function domainFromUrl(url) {
  let s = String(url || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].split('@').pop().split(':')[0].replace(/^www\./, '');
  return s.includes('.') ? s : '';
}
// ai.js: `const _last = String(c.name).trim().toLowerCase().split(/\s+/).pop()`
// matched against Hunter's e.lastName. Last name ONLY -- a first-name-only match
// never fills anything.
function lastNameOf(name) {
  return String(name || '').trim().toLowerCase().split(/\s+/).pop() || '';
}

const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n).slice(0, n);
const ago = (t) => {
  if (!t) return '?';
  const m = (Date.now() - new Date(t).getTime()) / 60000;
  if (m < 60) return Math.round(m) + 'm';
  if (m < 1440) return (m / 60).toFixed(1) + 'h';
  return (m / 1440).toFixed(1) + 'd';
};

(async () => {
  // Deep lookups, newest first. A 'contacts' row exists for every fan-out that
  // produced an affordance or a definitive empty.
  const { rows: lookups } = await pool.query(
    `SELECT brand_key, brand, website, evidence, outcome, refreshed_at
       FROM brand_evidence_cache
      WHERE lane = 'contacts'
      ORDER BY refreshed_at DESC
      LIMIT $1`, [LIMIT]
  );
  if (!lookups.length) {
    console.log('No contact lookups cached. Either none has run in 30 days, or every one failed transiently.');
    await pool.end();
    return;
  }

  const domains = [...new Set(lookups.map((l) => domainFromUrl(l.website)).filter(Boolean))];
  const { rows: hunterRows } = domains.length
    ? await pool.query(
        `SELECT brand_key, evidence, outcome, refreshed_at
           FROM brand_evidence_cache
          WHERE lane = 'hunter' AND brand_key = ANY($1)`, [domains])
    : { rows: [] };
  const byDomain = new Map(hunterRows.map((r) => [r.brand_key, r]));

  const report = lookups.map((l) => {
    const ev = l.evidence || {};
    const named = Array.isArray(ev.contacts) ? ev.contacts : [];
    const domain = domainFromUrl(l.website);

    const out = {
      brand: l.brand,
      domain: domain || null,
      when: l.refreshed_at,
      contactsOutcome: l.outcome,
      namedContacts: named.length,
      namedWithEmail: named.filter((c) => c && c.email).length,
      hunterSourced: named.filter((c) => c && c.emailSource === 'hunter').length,
      genericInbox: ev.genericInbox || null,
    };

    if (!domain) {
      out.fired = 'NO — no website, so no domain to search';
      out.verdict = 'NOT_ATTEMPTED';
      return out;
    }
    const h = byDomain.get(domain);
    if (!h) {
      // findDomainEmails only skips the write when the call failed or was never made.
      out.fired = 'UNKNOWN — no cached result (never called, or timed out / errored)';
      out.verdict = 'NO_HUNTER_ROW';
      return out;
    }

    const hev = h.evidence || {};
    out.hunterAt = h.refreshed_at;
    // A hunter row older than the lookup means the lookup read it from cache and
    // returned instantly -- the 2.5s grace window cannot have dropped it.
    const gapSec = (new Date(l.refreshed_at).getTime() - new Date(h.refreshed_at).getTime()) / 1000;
    out.hunterWasCached = gapSec > 60;

    if (hev.found === false) {
      out.fired = 'YES';
      out.addresses = 0; out.personal = 0; out.generic = 0;
      out.verdict = 'HUNTER_FOUND_NOTHING';
      return out;
    }
    const emails = Array.isArray(hev.emails) ? hev.emails : [];
    const personal = emails.filter((e) => e.type === 'personal');
    const generic = emails.filter((e) => e.type === 'generic');
    out.fired = 'YES';
    out.addresses = emails.length;
    out.personal = personal.length;
    out.generic = generic.length;

    // HOW the address got on the ladder is recorded in the row itself, and the two
    // paths leave different marks:
    //   last-name match  -> the EXISTING contact keeps its source ('site', 'news')
    //                       and gains emailSource:'hunter'
    //   prepend fallback -> a NEW row with source:'hunter' and the honest title
    //                       "Company contact (not confirmed owner)"
    // Reading it off the row is exact. Recomputing the match after the fact is not:
    // once an address has been applied the contact is no longer eligible for it, so
    // a successful match looks identical to no match at all.
    const matchedInPlace = named.filter((c) => c && c.emailSource === 'hunter' && c.source !== 'hunter');
    const prepended = named.filter((c) => c && c.source === 'hunter');
    out.hunterSourced = matchedInPlace.length + prepended.length;
    out.matchedInPlace = matchedInPlace.map((c) => ({ contact: c.name, email: c.email }));
    out.prepended = prepended.map((c) => ({ contact: c.name || '(unnamed)', email: c.email }));
    out.hunterLastNames = personal.map((e) => e.lastName).filter(Boolean);

    // For a lookup where nothing was applied, recompute what the match WOULD have
    // done, so a drop can be told apart from a genuine near-miss.
    const eligible = named.filter((c) => c && !c.email && c.name);
    const wouldMatch = [];
    for (const c of eligible) {
      const ln = lastNameOf(c.name);
      const m = ln && personal.find((e) => e.lastName && e.lastName.toLowerCase() === ln);
      if (m) wouldMatch.push({ contact: c.name, email: m.email });
    }
    out.eligibleNames = eligible.map((c) => c.name);
    out.lastNameMatch = matchedInPlace.length
      ? matchedInPlace.map((c) => ({ contact: c.name, email: c.email }))
      : (wouldMatch.length ? wouldMatch : null);
    out.lastNameMatchWasApplied = matchedInPlace.length > 0;

    // THE DISCRIMINATION. When Hunter returned a personal address, the merge step
    // ALWAYS applies something: a last-name match, or failing that it prepends the
    // best personal address as its own contact row. So a lookup with personal
    // addresses available and nothing hunter-sourced on the ladder means the result
    // never reached the merge -- i.e. it was dropped at the grace window.
    if (personal.length && out.hunterSourced === 0) {
      out.verdict = out.hunterWasCached ? 'APPLIED_NOTHING_DESPITE_CACHED_RESULT' : 'DROPPED_AT_GRACE_WINDOW';
    } else if (matchedInPlace.length) {
      out.verdict = 'APPLIED_VIA_LAST_NAME';
    } else if (prepended.length) {
      out.verdict = 'APPLIED_AS_UNMATCHED_COMPANY_CONTACT';
    } else if (generic.length) {
      out.verdict = out.genericInbox ? 'ONLY_GENERIC_AVAILABLE' : 'GENERIC_AVAILABLE_NOT_USED';
    } else {
      out.verdict = 'HUNTER_FOUND_NOTHING';
    }
    return out;
  });

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    await pool.end();
    return;
  }

  console.log(`\n${report.length} most recent deep contact lookups\n`);
  console.log(pad('BRAND', 26) + pad('AGE', 7) + pad('FIRED', 7) + pad('ADDR', 6) + pad('PERS', 6)
    + pad('GEN', 5) + pad('NAMES', 7) + pad('W/EMAIL', 9) + 'VERDICT');
  console.log('-'.repeat(118));
  for (const r of report) {
    console.log(
      pad(r.brand, 26) + pad(ago(r.when), 7)
      + pad(r.fired.startsWith('YES') ? 'yes' : (r.verdict === 'NOT_ATTEMPTED' ? 'no' : '?'), 7)
      + pad(r.addresses === undefined ? '-' : r.addresses, 6)
      + pad(r.personal === undefined ? '-' : r.personal, 6)
      + pad(r.generic === undefined ? '-' : r.generic, 5)
      + pad(r.namedContacts, 7) + pad(r.namedWithEmail, 9) + r.verdict);
  }

  console.log('\n── detail where it matters ──');
  for (const r of report) {
    if (r.verdict === 'HUNTER_FOUND_NOTHING' || r.verdict === 'NOT_ATTEMPTED') continue;
    console.log(`\n${r.brand}  (${r.domain})  ${r.verdict}`);
    if (r.hunterWasCached !== undefined) {
      console.log(`  hunter result was ${r.hunterWasCached ? 'CACHED (returned instantly, grace window irrelevant)' : 'a COLD call (subject to the 2.5s grace window)'}`);
    }
    if (r.hunterLastNames) {
      console.log(`  names with no email:  ${r.eligibleNames.length ? r.eligibleNames.join(', ') : '(none)'}`);
      console.log(`  hunter last names:    ${r.hunterLastNames.length ? r.hunterLastNames.join(', ') : '(none — all addresses are generic or unattributed)'}`);
      console.log(`  last-name match:      ${r.lastNameMatch
        ? r.lastNameMatch.map((m) => m.contact + ' -> ' + m.email).join(', ')
          + (r.lastNameMatchWasApplied ? '  [applied]' : '  [WOULD have matched, but nothing was applied]')
        : 'NO MATCH'}`);
      if (r.prepended && r.prepended.length) {
        console.log(`  prepended fallback:   ${r.prepended.map((m) => m.contact + ' -> ' + m.email).join(', ')}`);
      }
    }
  }

  const counts = report.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  console.log('\n── summary ──');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 42)} ${v}`);
  console.log('\nNO_HUNTER_ROW is the only ambiguous verdict: never called, or called and failed.');
  console.log('Split it with:  railway logs | grep "\\[hunter\\] @"\n');

  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
