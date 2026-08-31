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
// findSiteEmail end to end with a stubbed fetch (no network), the ladder row it
// produces, and the approach line. Real Postgres for the domain cache.
const path = REPO + 'server/';
const S = require(path + 'services/siteEmail.js');
const { buildContactLadder } = require(path + 'services/contactLadder.js');
const store = require(path + 'store.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

// A fake site: homepage links to /contact, contact page has the address.
const SITES = {
  'https://onyxcoffeelab.com/': `<html><nav><a href="/about">About</a><a href="/contact">Contact</a>
     <a href="/careers">Careers</a></nav><body>Great coffee</body></html>`,
  'https://onyxcoffeelab.com/contact': `<html><body>
     <a href="mailto:andrea@onyxcoffeelab.com">Email Andrea</a>
     <a href="mailto:careers@onyxcoffeelab.com">Jobs</a>
     <img src="logo@2x.png"> info@onyxcoffeelab.com
     </body></html>`,
  'https://onyxcoffeelab.com/about': `<html><body>Founded 2012</body></html>`,
  // role-only site
  'https://sawsbbq.com/': `<html><a href="/contact-us">Contact</a></html>`,
  'https://sawsbbq.com/contact-us': `<html>info@sawsbbq.com</html>`,
  // form-only site
  'https://ridgebarber.com/': `<html><a href="/contact">Contact</a></html>`,
  'https://ridgebarber.com/contact': `<html><form><input name="name"><textarea></textarea></form></html>`,
  // nothing at all
  'https://torqueauto.com/': `<html><body>Cars</body></html>`,
  // franchise: address is on the corporate domain
  'https://wingstop.com/': `<html><a href="/contact">Contact</a></html>`,
  'https://wingstop.com/contact': `<html><a href="mailto:guestrelations@wingstop.com">Contact us</a></html>`,
};
let fetchCount = 0;
const fetchImpl = async (url) => {
  fetchCount++;
  const body = SITES[url];
  if (body === undefined) return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' };
  return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => body };
};

async function main() {
  await new Promise((r) => setTimeout(r, 1800));
  await store.pool.query(`DELETE FROM brand_evidence_cache WHERE lane='siteemail'`);

  // ── personal beats role, rejects filtered ────────────────────────────────
  fetchCount = 0;
  let r = await S.findSiteEmail('https://onyxcoffeelab.com', { brand: 'Onyx Coffee Lab', fetchImpl });
  ok('finds the personal address', r.email === 'andrea@onyxcoffeelab.com', r.email);
  ok('  typed personal', r.type === 'personal', r.type);
  ok('  personal outranks the info@ on the same page', r.email !== 'info@onyxcoffeelab.com');
  ok('  careers@ was rejected with a reason', r.rejected.some((x) => /careers/.test(x.raw)), r.rejected);
  ok('  the @2x.png artifact never became a candidate', !/2x\.png/.test(r.email || ''), r.email);
  ok('  not flagged corporate', r.corporate === false);
  ok('HARD CAP: at most 3 fetches', fetchCount <= 3, fetchCount);
  ok('  and it reports how many pages it read', r.pagesFetched <= 3 && r.pagesFetched >= 1, r.pagesFetched);
  ok('  no model call was made', r.usedModel === false);

  // ── cached by DOMAIN: second call is free ────────────────────────────────
  fetchCount = 0;
  const r2 = await S.findSiteEmail('https://onyxcoffeelab.com/some/other/page', { brand: 'Onyx again', fetchImpl });
  ok('second lookup of the same DOMAIN is served from cache', r2.cached === true, r2.cached);
  ok('  costing zero fetches', fetchCount === 0, fetchCount);
  ok('  and returning the same address', r2.email === 'andrea@onyxcoffeelab.com');

  // ── role only ────────────────────────────────────────────────────────────
  r = await S.findSiteEmail('https://sawsbbq.com', { brand: 'Saws BBQ', fetchImpl });
  ok('a site with only info@ yields a role type', r.type === 'role' && r.email === 'info@sawsbbq.com', r);

  // ── form only ────────────────────────────────────────────────────────────
  r = await S.findSiteEmail('https://ridgebarber.com', { brand: 'Ridge Barber', fetchImpl });
  ok('no address but a real form -> type form', r.type === 'form' && !r.email, r);
  ok('  with the form URL captured', /\/contact$/.test(r.formUrl || ''), r.formUrl);

  // ── nothing ──────────────────────────────────────────────────────────────
  r = await S.findSiteEmail('https://torqueauto.com', { brand: 'Torque', fetchImpl });
  ok('a site with neither yields nothing, not a crash', r.email === null && r.type === null && !r.formUrl, r);

  // ── franchise, via cached notAffiliated ──────────────────────────────────
  const notAffiliated = [{ name: 'Michael Skipworth', title: 'CEO', email: null,
    sourceUrl: 'https://ir.wingstop.com/leadership', affiliationScope: 'parent-or-brand' }];
  r = await S.findSiteEmail('https://wingstop.com', { brand: 'Wingstop', notAffiliated, fetchImpl });
  ok('a franchise address is FOUND', r.email === 'guestrelations@wingstop.com', r.email);
  ok('  and flagged corporate from the cached parent contact', r.corporate === true, r);
  ok('  with the signal named', /parent-or-brand/.test(r.corporateVia || ''), r.corporateVia);

  // ── the ladder row ───────────────────────────────────────────────────────
  const lad = buildContactLadder({
    contacts: [], businessPhone: '(479) 555-1212',
    siteEmail: { email: 'andrea@onyxcoffeelab.com', type: 'personal', corporate: false, sourceUrl: 'https://onyxcoffeelab.com/contact' },
  }, { rankOf: () => 9, rootDomain: S.rootDomain, brand: 'Onyx Coffee Lab' });
  const t3 = (lad.tiers || []).find((t) => t.tier === 3);
  const row = (t3 ? t3.rows : []).find((x) => x.email === 'andrea@onyxcoffeelab.com');
  ok('the ladder renders a row for the site email', !!row, t3 && t3.rows);
  ok('  carrying the type so the card can badge it', row && row.emailType === 'personal', row && row.emailType);
  ok('  titled as coming from their website', row && /website/i.test(row.title), row && row.title);
  ok('  and linking the page it came from', row && /onyxcoffeelab\.com\/contact/.test(row.sourceUrl || ''));

  const ladCorp = buildContactLadder({
    contacts: [], businessPhone: null,
    siteEmail: { email: 'guestrelations@wingstop.com', type: 'role', corporate: true, corporateVia: 'parent-or-brand contact at the same domain' },
  }, { rankOf: () => 9, rootDomain: S.rootDomain, brand: 'Wingstop' });
  const corpRow = ladCorp.tiers.find((t) => t.tier === 3).rows.find((x) => x.email);
  ok('a corporate address is shown and LABELLED, not hidden', corpRow && corpRow.corporate === true, corpRow);
  ok('  its title says it is not this location', corpRow && /not this location/i.test(corpRow.title), corpRow && corpRow.title);

  const ladForm = buildContactLadder({
    contacts: [], businessPhone: null, siteEmail: { email: null, type: 'form', formUrl: 'https://ridgebarber.com/contact' },
  }, { rankOf: () => 9, rootDomain: S.rootDomain, brand: 'Ridge' });
  const formRow = ladForm.tiers.find((t) => t.tier === 3).rows.find((x) => x.formUrl);
  ok('a form-only business gets a Contact form row', !!formRow, ladForm.tiers);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
