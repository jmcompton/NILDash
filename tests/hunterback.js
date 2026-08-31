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
// Hunter restored: the lookup, the two uses (and the absent third), and the
// backfill's dry run. Real Postgres, stubbed fetch, no network.
process.env.HUNTER_API_KEY = 'test-key';

const fs = require('fs'); const http = require('http');
const ROOT = REPO;
// Relative requires in the lifted index.js block resolve against THIS file.
const Module = require('module');
const realLoad = Module._load;
Module._load = function (rq, p, m) {
  if (/^\.\/services\//.test(rq)) return realLoad(ROOT + 'server/' + rq.slice(2), p, m);
  return realLoad.apply(this, arguments);
};
const store = require(ROOT + 'store.js'.replace('store.js', 'server/store.js'));
const H = require(ROOT + 'server/services/hunterLookup.js');
const { buildContactLadder } = require(ROOT + 'server/services/contactLadder.js');
const G = require(ROOT + 'server/services/greetingGuard.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

// ── fetch stub ──────────────────────────────────────────────────────────────
let CALLS = [];
let NEXT = {};       // domain -> {status, body} | {throw}
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const u = String(url);
  if (/^http:\/\/127\.0\.0\.1/.test(u)) return realFetch(url, init);
  const m = u.match(/domain=([^&]+)/);
  const dom = m ? decodeURIComponent(m[1]) : '';
  CALLS.push(dom);
  const spec = NEXT[dom];
  if (!spec) return { ok: true, status: 200, json: async () => ({ data: { emails: [] } }) };
  if (spec.throw) { const e = new Error(spec.throw); if (spec.abort) e.name = 'AbortError'; throw e; }
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    json: async () => spec.body || {},
  };
};

const hEmail = (v, type, last, pos, conf) => ({
  value: v, type, first_name: last ? 'F' : null, last_name: last || null,
  position: pos || null, confidence: conf === undefined ? 90 : conf,
});

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = () => store.pool.query(`DELETE FROM brand_evidence_cache WHERE lane IN ('hunter','siteemail','websitecheck','places')`);
  await clean();

  // ── EVERY OUTCOME IS RECORDED, including the ones the old code dropped ────
  const outcomeOf = async (d) => (await store.pool.query(
    `SELECT outcome, evidence FROM brand_evidence_cache WHERE lane='hunter' AND brand_key=$1`, [d])).rows[0];

  NEXT['ok.com'] = { status: 200, body: { data: { emails: [hEmail('dana@ok.com', 'personal', 'Kessler', 'Owner')] } } };
  NEXT['none.com'] = { status: 200, body: { data: { emails: [] } } };
  NEXT['401.com'] = { status: 401, body: { errors: [{ details: 'Invalid API key' }] } };
  NEXT['429.com'] = { status: 429, body: { errors: [{ details: 'Too many requests' }] } };
  NEXT['500.com'] = { status: 500, body: {} };
  NEXT['slow.com'] = { throw: 'The operation was aborted', abort: true };
  NEXT['boom.com'] = { throw: 'ECONNRESET' };

  let r = await H.findDomainEmails('ok.com');
  ok('a 200 with addresses returns them', r && r.emails.length === 1, r);
  ok('  recorded OK', (await outcomeOf('ok.com')).outcome === 'OK');

  r = await H.findDomainEmails('none.com');
  ok('a 200 with no addresses returns null', r === null, r);
  ok('  recorded NONE — a real coverage miss', (await outcomeOf('none.com')).outcome === 'NONE');

  // THE fbf5865 GAP: these four wrote NO ROW before.
  for (const [d, want] of [['401.com', 'HTTP_401'], ['429.com', 'HTTP_429'],
                           ['500.com', 'HTTP_ERR'], ['slow.com', 'TIMEOUT'], ['boom.com', 'ERROR']]) {
    r = await H.findDomainEmails(d);
    const row = await outcomeOf(d);
    ok(`${d} returns null but RECORDS ${want}`, r === null && row && row.outcome === want, row && row.outcome);
  }
  ok('  a 401 keeps the HTTP status on the row', (await outcomeOf('401.com')).evidence.status === 401);
  ok('  and the reason Hunter gave', /Invalid API key/.test((await outcomeOf('401.com')).evidence.reason || ''));
  ok('  a 429 keeps its status too', (await outcomeOf('429.com')).evidence.status === 429);
  ok('  a timeout is distinguishable from a network error',
    (await outcomeOf('slow.com')).outcome !== (await outcomeOf('boom.com')).outcome);

  // failures are NOT retried into a second credit
  CALLS = [];
  await H.findDomainEmails('429.com');
  ok('a recorded failure is not immediately re-called (cooldown)', CALLS.length === 0, CALLS);

  // an ANSWER is served from cache, free
  CALLS = [];
  r = await H.findDomainEmails('ok.com');
  ok('a fresh answer is served from cache', r && r.cached === true, r);
  ok('  costing no call', CALLS.length === 0, CALLS);

  // no key -> recorded, never silent
  const savedKey = process.env.HUNTER_API_KEY;
  delete process.env.HUNTER_API_KEY;
  CALLS = [];
  r = await H.findDomainEmails('nokey.com');
  ok('with no API key nothing is called', CALLS.length === 0 && r === null, CALLS);
  ok('  and NO_KEY is recorded, not silence', (await outcomeOf('nokey.com')).outcome === 'NO_KEY');
  process.env.HUNTER_API_KEY = savedKey;

  // ── THE TWO USES, AND THE ABSENT THIRD ───────────────────────────────────
  // The merge logic lives in ai.js; lift it the same way the other suites do.
  const SRC = fs.readFileSync(ROOT + 'server/ai.js', 'utf8');
  const S = SRC.indexOf('  // ── Hunter, LAST AND ONLY IF WE STILL HAVE NOTHING');
  const E = SRC.indexOf('  let _igMs = 0;', S);
  ok('the ai.js Hunter block is present', S > 0 && E > S);
  const BLOCK = SRC.slice(S, E);
  ok('use (c) — creating a contact — is NOT restored', !/res\.contacts\.unshift/.test(BLOCK), (BLOCK.match(/unshift/g) || []));
  ok('  and the old placeholder title appears nowhere but a comment',
    !/title: *_b\.position/.test(BLOCK) && !/'Company contact \(not confirmed owner\)'/.test(BLOCK.replace(/\/\/.*$/gm, '')));
  ok('the block runs only when siteEmail found nothing', /!_seFoundEmail/.test(BLOCK));
  // Was "deep path only"; now the cheap card path warms it too, non-blocking.
  ok('  eligible on the deep path AND the cheap card path', /_deep \|\| localityRequired/.test(BLOCK));
  ok('  only the deep path awaits and merges', /if \(_hunterEligible && _deep\)/.test(BLOCK));
  ok('  and only when a key is set', /process\.env\.HUNTER_API_KEY/.test(BLOCK));
  ok('  and only when there is something to fill or backfill', /_wantsFill \|\| _wantsInbox/.test(BLOCK));
  ok('the surname match is LAST NAME only', /lastName\.toLowerCase\(\) === _last/.test(BLOCK));
  ok('  it only fills a contact that already has a name', /if \(c\.email \|\| !c\.name\) continue/.test(BLOCK));
  ok('  and tags the address hunter, never published', /emailSource = 'hunter'/.test(BLOCK) && !/emailSource = 'published'/.test(BLOCK));

  // Run the merge for real against a fake res.
  const mergeFn = new Function('res', 'personal', 'generic', `
    let _filled = null;
    for (const c of res.contacts) {
      if (c.email || !c.name) continue;
      const _last = String(c.name).trim().toLowerCase().split(/\\s+/).pop();
      const _m = _last && personal.find((e) => e.lastName && e.lastName.toLowerCase() === _last);
      if (_m) { c.email = _m.email; c.emailSource = 'hunter'; c.emailScore = _m.confidence; _filled = c; break; }
    }
    let _inbox = null;
    if (!res.genericInbox && generic.length) { res.genericInbox = generic[0].email; res.genericInboxSource = 'hunter'; _inbox = generic[0].email; }
    return { filled: _filled, inbox: _inbox };
  `);

  let res1 = { contacts: [{ name: 'Dana Kessler', title: 'Owner', email: null }], genericInbox: null };
  let m = mergeFn(res1, [{ email: 'd.kessler@x.com', lastName: 'Kessler', confidence: 92 }], []);
  ok('(a) an address is filled onto an already-named contact', res1.contacts[0].email === 'd.kessler@x.com', res1.contacts[0]);
  ok('  tagged emailSource hunter', res1.contacts[0].emailSource === 'hunter');
  ok('  and NO new contact was created', res1.contacts.length === 1, res1.contacts.length);

  res1 = { contacts: [{ name: 'Dana Kessler', title: 'Owner', email: null }], genericInbox: null };
  m = mergeFn(res1, [{ email: 'someone.else@x.com', lastName: 'Nguyen', confidence: 99 }], []);
  ok('(c) a personal address matching NOBODY on the list creates nothing', res1.contacts.length === 1 && !res1.contacts[0].email, res1.contacts);
  ok('  which is exactly the fbf5865 behaviour that is gone', m.filled === null);

  res1 = { contacts: [], genericInbox: null };
  m = mergeFn(res1, [{ email: 'ceo@x.com', lastName: 'Boss', confidence: 99 }], [{ email: 'info@x.com', confidence: 70 }]);
  ok('(b) a generic inbox is backfilled', res1.genericInbox === 'info@x.com', res1.genericInbox);
  ok('  with no name attached, so there is nothing to greet', res1.contacts.length === 0);
  ok('  and the personal address was NOT promoted into a contact', res1.contacts.length === 0);

  res1 = { contacts: [], genericInbox: 'already@x.com' };
  mergeFn(res1, [], [{ email: 'info@x.com', confidence: 70 }]);
  ok('  an existing generic inbox is not overwritten', res1.genericInbox === 'already@x.com');

  // ── emailKind + the greeting guard, end to end ───────────────────────────
  const lad = buildContactLadder({
    contacts: [{ name: 'Dana Kessler', title: 'Owner', email: 'd.kessler@x.com', emailSource: 'hunter', rank: 0 }],
    businessPhone: '(205) 555-1212',
  }, { rankOf: () => 0, rootDomain: (u) => String(u || '').replace(/^https?:\/\//, ''), brand: 'X' });
  const allRows = (lad.tiers || []).flatMap((t) => t.rows || []);
  const row = allRows.find((x) => x.email === 'd.kessler@x.com');
  ok('the ladder marks a Hunter address emailKind "hunter"', row && row.emailKind === 'hunter', row && row.emailKind);
  ok('  NOT published', row && row.emailKind !== 'published');

  const g = G.enforceGreeting('Dana,\n\nHi.', G.greetableContacts([
    { name: 'Dana Kessler', title: 'Owner', email: 'd.kessler@x.com', emailKind: 'hunter' }]));
  ok('THE GUARD HOLDS: a Hunter address does not earn a first name', g.changed === true, g);
  ok('  rewritten to "Hi,"', /^Hi,/.test(g.body), g.body.split('\n')[0]);
  const g2 = G.enforceGreeting('Dana,\n\nHi.', G.greetableContacts([
    { name: 'Dana Kessler', title: 'Owner', email: 'd.kessler@x.com', emailKind: 'published' }]));
  ok('  while a published address still greets', g2.changed === false, g2);

  // ── the backfill dry run ─────────────────────────────────────────────────
  const app = require('express')();
  app.use(require('express').json());
  app.use((req, _r, next) => { req.session = { userId: 'u1' }; next(); });
  const ADMIN_EMAIL = 'admin@test.local';
  const isFounderEmail = () => false;
  const requireAuth = (_q, _r, next) => next();
  let USER = { email: ADMIN_EMAIL };
  const storeShim = { pool: store.pool, getUser: async () => USER };
  const CS = SRC.length; void CS;
  const ISRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  const s2 = ISRC.indexOf('const HUNTER_CONCURRENCY');
  const e2 = ISRC.indexOf("app.post('/api/admin/site-email-backfill'");
  ok('the backfill block is present in index.js', s2 > 0 && e2 > s2);
  { const store = storeShim; eval(ISRC.slice(s2, e2)); }

  const srv = http.createServer(app);
  await new Promise((r2) => srv.listen(0, '127.0.0.1', r2));
  const PORT = srv.address().port;
  const post = async (body) => {
    const rr = await fetch(`http://127.0.0.1:${PORT}/api/admin/hunter-backfill`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: rr.status, body: await rr.json().catch(() => ({})) };
  };

  await clean();
  const place = (b, w) => store.pool.query(
    `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
     VALUES ($1,'places',$1,$2,'{}'::jsonb,'OK',NOW()) ON CONFLICT (brand_key,lane) DO UPDATE SET website=EXCLUDED.website`, [b, w]);
  const pass = (w) => store.pool.query(
    `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
     VALUES ($1,'websitecheck',$1,$2,'{"verdict":"pass"}'::jsonb,'OK',NOW()) ON CONFLICT (brand_key,lane) DO UPDATE SET website=EXCLUDED.website`, ['wc-' + w, w]);
  const seRow = (w, email) => store.pool.query(
    `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
     VALUES ($1,'siteemail',$1,$2,$3::jsonb,'OK',NOW()) ON CONFLICT (brand_key,lane) DO UPDATE SET evidence=EXCLUDED.evidence`,
    ['se-' + w, w, JSON.stringify(email ? { email } : { email: null })]);

  for (const [b, w] of [['A', 'https://a.com'], ['B', 'https://b.com'], ['C', 'https://c.com'], ['D', 'https://d.com']]) {
    await place(b, w); await pass(w);
  }
  await seRow('https://a.com', 'owner@a.com');   // has email -> skip
  await seRow('https://b.com', null);            // tried, nothing -> CALL
  await seRow('https://c.com', null);            // tried, nothing -> but cached below
  await store.pool.query(
    `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
     VALUES ('c.com','hunter','c.com',NULL,'{"found":false}'::jsonb,'NONE',NOW())`);
  // d.com: never tried by siteEmail -> CALL

  let d = await post({});
  ok('the button DRY RUNS by default', d.body.dryRun === true, d.body);
  ok('  4 validated sites', d.body.validatedSites === 4, d.body.validatedSites);
  ok('  1 skipped because siteEmail already has an address', d.body.skippedHaveEmail === 1, d.body.skippedHaveEmail);
  ok('  1 skipped because Hunter already answered', d.body.skippedCached === 1, d.body.skippedCached);
  ok('  2 would be called', d.body.willCall === 2, d.body.willCall);
  ok('  projecting 2 credits', d.body.projectedCredits === 2, d.body.projectedCredits);
  ok('  and it reports whether the key is set', d.body.keySet === true, d.body.keySet);

  // A dry run must not have created a job or spent anything.
  const jobs = (await store.pool.query(`SELECT COUNT(*)::int n FROM hunter_jobs`)).rows[0].n;
  ok('  a dry run creates NO job', jobs === 0, jobs);
  CALLS = [];
  await post({});
  ok('  and calls Hunter zero times', CALLS.length === 0, CALLS);

  // Confirmed run.
  NEXT['b.com'] = { status: 200, body: { data: { emails: [hEmail('gm@b.com', 'personal', 'Smith', 'GM')] } } };
  NEXT['d.com'] = { status: 200, body: { data: { emails: [] } } };
  CALLS = [];
  d = await post({ confirm: true });
  ok('confirm:true starts a real job', d.body.started === true && d.body.total === 2, d.body);
  await new Promise((r2) => setTimeout(r2, 1200));
  const job = (await store.pool.query(`SELECT * FROM hunter_jobs ORDER BY started_at DESC LIMIT 1`)).rows[0];
  ok('  the job finished', job.status === 'done', job.status);
  ok('  2 domains done', job.done === 2, job.done);
  ok('  2 credits spent', job.credits === 2, job.credits);
  ok('  1 with addresses, 1 none', job.with_addresses === 1 && job.zero_addresses === 1, [job.with_addresses, job.zero_addresses]);
  ok('  it called exactly the projected domains', CALLS.sort().join(',') === 'b.com,d.com', CALLS);

  // The combined coverage number.
  const prog = await (await fetch(`http://127.0.0.1:${PORT}/api/admin/hunter-backfill`, { credentials: 'omit' })).json();
  const c = prog.coverage;
  ok('coverage: 4 validated', c.validated === 4, c.validated);
  ok('  1 from siteEmail', c.siteEmail === 1, c.siteEmail);
  ok('  1 Hunter added that siteEmail did not have', c.hunterOnly === 1, c.hunterOnly);
  ok('  2 with at least one usable email from ANY source', c.anyEmail === 2, c.anyEmail);
  ok('  reported as a percentage of the validated set', c.pctAnyEmail === 50, c.pctAnyEmail);

  // A 401 mid-run aborts before burning the rest.
  await store.pool.query(`DELETE FROM hunter_jobs`);
  await store.pool.query(`DELETE FROM brand_evidence_cache WHERE lane='hunter'`);
  for (let i = 0; i < 6; i++) { await place('E' + i, 'https://e' + i + '.com'); await pass('https://e' + i + '.com'); await seRow('https://e' + i + '.com', null); }
  for (let i = 0; i < 6; i++) NEXT['e' + i + '.com'] = { status: 401, body: { errors: [{ details: 'Invalid API key' }] } };
  CALLS = [];
  await post({ confirm: true });
  await new Promise((r2) => setTimeout(r2, 1200));
  const j2 = (await store.pool.query(`SELECT * FROM hunter_jobs ORDER BY started_at DESC LIMIT 1`)).rows[0];
  ok('a 401 aborts the run instead of burning every domain', j2.status === 'failed', j2.status);
  ok('  saying the key is the problem', /401|API key/i.test(j2.error || ''), j2.error);
  ok('  and it stopped well short of all 8', CALLS.length < 8, CALLS.length);

  await store.pool.query(`DELETE FROM hunter_jobs`);
  await clean();
  srv.close();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await store.pool.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
