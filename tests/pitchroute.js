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
// pitchRoute against stubbed fetch. The three shapes that matter:
//   a big brand behind bot protection (403) is still a REAL company
//   a brand with a partnerships desk yields that address, not info@
//   a name that resolves to nothing is the only outright decline
const P = require(REPO + 'server/services/pitchRoute.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const SITES = {
  // Partnerships desk, reached via a linked partnerships page.
  'https://redbull.example/': `<html><nav>
     <a href="/careers">Careers</a>
     <a href="/contact">Contact</a>
     <a href="/partnerships">Partnerships</a>
   </nav>info@redbull.example</html>`,
  'https://redbull.example/partnerships': `<html><body>
     Brand partnerships: <a href="mailto:partnerships@redbull.example">partnerships@redbull.example</a>
     Press: <a href="mailto:press@redbull.example">press</a>
     Jobs: careers@redbull.example
   </body></html>`,
  'https://redbull.example/contact': `<html>info@redbull.example</html>`,

  // Marketing desk only.
  'https://bww.example/': `<html><a href="/contact-us">Contact us</a></html>`,
  'https://bww.example/contact-us': `<html>marketing@bww.example and info@bww.example</html>`,

  // Form only, no address anywhere.
  'https://gatorade.example/': `<html><a href="/sponsorships">Sponsorship Requests</a></html>`,
  'https://gatorade.example/sponsorships': `<html><form><input name="n"><textarea></textarea></form></html>`,

  // Real company, nothing usable at all.
  'https://silent.example/': `<html><body>We make things.</body></html>`,

  // Opaque URL, anchor text carries the meaning.
  'https://opaque.example/': `<html><a href="/pages/90210">Partner with us</a></html>`,
  'https://opaque.example/pages/90210': `<html><a href="mailto:collabs@opaque.example">write us</a></html>`,
};

let fetched = [];
const fetchImpl = async (url) => {
  fetched.push(url);
  if (/blocked\.example/.test(url)) return { ok: false, status: 403, headers: { get: () => 'text/html' }, text: async () => '' };
  if (/ghost\.example/.test(url)) { const e = new Error('getaddrinfo ENOTFOUND ghost.example'); throw e; }
  const body = SITES[url];
  if (body === undefined) return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' };
  return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => body };
};

async function main() {
  // ── probeSite: what counts as "this company exists" ──────────────────────
  let p = await P.probeSite('https://redbull.example', fetchImpl);
  ok('a reachable site means the company exists', p.exists === true && !!p.html, p);

  p = await P.probeSite('https://blocked.example', fetchImpl);
  ok('a 403 STILL means the company exists', p.exists === true, p);
  ok('  flagged unreadable rather than nonexistent', p.reachable === false && /blocked/.test(p.reason || ''), p);

  p = await P.probeSite('https://ghost.example', fetchImpl);
  ok('a name that does not resolve is the one real decline', p.exists === false, p);
  ok('  with dns named as the reason', /dns/i.test(p.reason || ''), p.reason);

  p = await P.probeSite('', fetchImpl);
  ok('no website at all cannot be verified', p.exists === false, p);
  p = await P.probeSite('not a url', fetchImpl);
  ok('garbage input cannot be verified', p.exists === false, p);

  // ── the partnerships desk wins ───────────────────────────────────────────
  fetched = [];
  let r = await P.findPitchRoute('https://redbull.example', { fetchImpl });
  ok('finds a route for a brand with no application page', r.kind === 'direct-pitch', r.kind);
  ok('  and it is the PARTNERSHIPS desk, not info@', r.email === 'partnerships@redbull.example', r.email);
  ok('  typed as partnerships', r.routeKind === 'partnerships', r.routeKind);
  ok('  the partnerships page is linked', /\/partnerships$/.test(r.pageUrl || ''), r.pageUrl);
  ok('  labelled so the agent knows what it is', /partnership/i.test(r.pageLabel || ''), r.pageLabel);
  ok('  careers@ was rejected', r.rejected.some((x) => /careers/.test(x.raw)), r.rejected);
  ok('  press@ was rejected too', r.rejected.some((x) => /press/.test(x.raw)), r.rejected);
  ok('  within the fetch cap', r.pagesFetched <= P.MAX_PAGES, r.pagesFetched);
  ok('  and it stopped early once it had the best answer', fetched.length <= 3, fetched);

  // ── marketing desk is second best ────────────────────────────────────────
  r = await P.findPitchRoute('https://bww.example', { fetchImpl });
  ok('a marketing desk counts as a direct pitch route', r.kind === 'direct-pitch', r.kind);
  ok('  marketing@ outranks info@', r.email === 'marketing@bww.example', r.email);
  ok('  typed as marketing', r.routeKind === 'marketing', r.routeKind);

  // ── form only ────────────────────────────────────────────────────────────
  r = await P.findPitchRoute('https://gatorade.example', { fetchImpl });
  ok('a sponsorship form with no address is still a route', r.kind === 'direct-pitch', r);
  ok('  the form URL is captured', /\/sponsorships$/.test(r.formUrl || ''), r.formUrl);
  ok('  and no email is invented', r.email === null, r.email);

  // ── nothing ──────────────────────────────────────────────────────────────
  r = await P.findPitchRoute('https://silent.example', { fetchImpl });
  ok('a real company with no route reports unknown, not a crash', r.kind === 'unknown', r);
  ok('  and invents neither an address nor a page', !r.email && !r.pageUrl && !r.formUrl, r);

  // ── anchor text, opaque URL ──────────────────────────────────────────────
  r = await P.findPitchRoute('https://opaque.example', { fetchImpl });
  ok('a "Partner with us" link with an opaque URL is followed', r.email === 'collabs@opaque.example', r);
  ok('  and collabs@ is typed as partnerships', r.routeKind === 'partnerships', r.routeKind);

  // ── budget is honoured even when every guess 404s ────────────────────────
  fetched = [];
  r = await P.findPitchRoute('https://nowhere.example', { fetchImpl });
  ok('a site that 404s everywhere stays inside the fetch cap', r.pagesFetched <= P.MAX_PAGES, r.pagesFetched);
  ok('  and reports unknown with the failures named', r.kind === 'unknown' && r.notes.length > 0, r.notes);

  // ── a guessed path that 200s but yields nothing is not a "route" ─────────
  //    (nowhere.example 404s; silent.example has a homepage but no contact page)
  r = await P.findPitchRoute('https://silent.example', { fetchImpl });
  ok('a catch-all 200 on a guessed path is not counted as a route', !r.pageUrl, r.pageUrl);

  // ── ranking, in isolation ────────────────────────────────────────────────
  ok('rank: partnerships beats marketing', P.routeRank('partnerships@x.com') < P.routeRank('marketing@x.com'));
  ok('rank: marketing beats a named human', P.routeRank('marketing@x.com') < P.routeRank('jane.doe@x.com'));
  ok('rank: a named human beats info@', P.routeRank('jane.doe@x.com') < P.routeRank('info@x.com'));
  ok('rank: sponsorship is a partnerships desk', P.routeKindOf('sponsorship@x.com') === 'partnerships');
  ok('rank: nil@ is a partnerships desk', P.routeKindOf('nil@x.com') === 'partnerships');

  // ── the copy tells the agent what to DO ──────────────────────────────────
  const d1 = P.describeRoute('Red Bull', 'direct-pitch', { routeKind: 'partnerships', email: 'partnerships@rb.com' });
  ok('direct-pitch copy names the address to write to', /partnerships@rb\.com/.test(d1), d1);
  ok('  and does not explain our indexing policy', !/index/i.test(d1), d1);
  const d2 = P.describeRoute('Gatorade', 'direct-pitch', { formUrl: 'https://g/x', routeKind: null });
  ok('form-only copy points at the form', /contact form/i.test(d2), d2);
  const d3 = P.describeRoute('Silent Co', 'unknown', null);
  ok('unknown copy still says the company is real', /real company/i.test(d3), d3);
  ok('  and suggests a next move rather than stopping', /agency|DM/i.test(d3), d3);
  const d4 = P.describeRoute('Gymshark', 'open-program', null);
  ok('open-program copy points at the application', /apply/i.test(d4), d4);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
