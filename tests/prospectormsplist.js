'use strict';
// ── PROSPECTOR: OUR OWN SALES LIST, BUILT BY CITY ───────────────────────────
// services/prospector/msplist + the run's gaps-only mode. Local Postgres;
// Google listings, the gap run and the owner lookup are stand-ins.
//
//   - chains, national firms and companies already on the list are skipped;
//   - one free gaps-only run per city; owners looked up only for the rest;
//   - only verified owners become drafts, each with three different nearby
//     businesses, a mix of kinds, in plain words;
//   - everything lands as a DRAFT; nothing is approved or sent;
//   - a city with too few gaps drafts nothing;
//   - the routes are wired and admin only.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('prospectormsplisttest', { schema: true });
require('./helpers/offlineDns').install();
delete process.env.PROSPECTOR_AUTOSEND_ON;

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const L = require(REPO + 'server/services/prospector/msplist.js');
const O = require(REPO + 'server/services/prospector/outreach.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const P = () => store.pool;

const msp = (name, domain, locations = 1) => ({ name, domain, address: '1 Main St, Hoover, AL 35244', category: 'Computer support', locations });
const places = { find: async () => ({ businesses: [msp('Magic City IT, LLC', 'magiccityit.test'), msp('Geek Squad', 'bestbuy.test'), msp('BigChain IT', 'bigchain.test', 9),
  msp('Hoover Tech Partners', 'hoovertech.test'), msp('NoOwner IT', 'noowner.test'), msp('Unverified IT', 'unverified.test'), msp('Known IT', 'known.test')], errors: [] }) };
const gap = (name, cat, short, level = 'high', town = 'Hoover') => ({ b: { name, domain: name.toLowerCase().replace(/[^a-z]/g, '') + '.test', category: cat, address: `9 Elm St, ${town}, AL 35244` },
  f: { level, short, problems: ['x'] } });
const GAPS = [gap('Family Care Dental', 'Dentist', 'no DMARC'), gap('Valley Animal Clinic', 'Veterinarian', 'no SPF'), gap('Smith & Jones Law', 'Law firm', 'no DMARC'),
  gap('Beck CPAs', 'Accountant', 'DMARC monitor only', 'medium', 'Pelham'), gap('Bright Smiles', 'Dentist', 'no DMARC'), gap('Oak Insurance', 'Insurance agency', 'weak SPF', 'medium')];
const runs = [];
const run = (gaps) => async (pool, input) => { runs.push(input); return { runId: 77, summary: { checked: 140, withGap: 90 }, gaps }; };
const owners = {
  'magiccityit.test': { ok: true, email: 'Dana@MagicCityIT.test', first: 'Dana', last: 'Hart', verified: true },
  'hoovertech.test': { ok: true, email: 'office@hoovertech.test', first: '', last: '', verified: true, kind: 'inbox' },
  'noowner.test': { ok: false, why: 'nobody found' },
  'unverified.test': { ok: true, email: 'x@unverified.test', first: 'X', verified: false, verifyStatus: 'accept_all' },
};
const lookedUp = [];
const findOwner = async (row) => { lookedUp.push(row.domain); return owners[row.domain] || { ok: false, why: 'none' }; };

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await O.ensureTables(P());
  await O.importRows(P(), [{ email: 'a@known.test', company: 'Known IT', area: 'Hoover, AL', subject: 'S', body: 'B' }]);

  OUT.push('-- plain words --');
  ok('kinds in plain words', L.kindOf('Bright Smiles', 'Dentist') === 'dental office' && L.kindOf('Valley Animal Clinic', '') === 'vet clinic' && L.kindOf('Beck CPAs', 'Accountant') === 'accounting firm');
  ok('the town from the address', L.townOf('9 Elm St, Pelham, AL 35124', 'Hoover, AL') === 'Pelham' && L.townOf('', 'Hoover, AL') === 'Hoover');
  ok('the gap in plain words', L.gapOf({ short: 'no DMARC' }) === 'no DMARC record' && L.gapOf({ short: 'weak SPF' }) === 'SPF lets anyone send');
  ok('company names without LLC or a tagline', L.cleanName('Magic City IT, LLC') === 'Magic City IT' && L.cleanName('Acme - Managed IT in Hoover') === 'Acme');
  ok('the 50 biggest metros are the default', L.TOP_METROS.length === 50);

  OUT.push('-- one city --');
  const r = await L.buildCity(P(), { area: 'Hoover, AL', max: 15, batch: 'test', deps: { places, run: run(GAPS), findOwner } });
  const why = Object.fromEntries(r.skipped.map((s) => [s.company, s.why]));
  ok('national firms and chains are skipped', why['Geek Squad'] === 'national firm' && /chain/.test(why['BigChain IT'] || ''), why);
  ok('a company already on the list is not looked up again', why['Known IT'] === 'already on the list' && !lookedUp.includes('known.test'), lookedUp);
  ok('one free gaps-only run for the city', runs.length === 1 && runs[0].gapsOnly === true && runs[0].area === 'Hoover, AL', runs);
  ok('only verified owners become drafts', r.drafted === 2 && r.owners === 2 && /not verified/.test(why['Unverified IT'] || '') && why['NoOwner IT'] === 'nobody found', r);
  const rows = (await P().query(`SELECT * FROM prospector_outreach WHERE source = 'msplist' ORDER BY id`)).rows;
  ok('everything is a draft; nothing approved or sent', rows.length === 2 && rows.every((x) => x.state === 'draft' && !x.approved_at && x.step === 0), rows.map((x) => x.state));
  const dana = rows.find((x) => x.email === 'dana@magiccityit.test');
  ok('the email greets the owner and names three businesses near them', dana && /^Hi Dana,/.test(dana.body) && dana.subject === '3 businesses near you with an email gap'
    && (dana.body.match(/^.+ \(.+\): .+$/gm) || []).length === 3 && dana.body.includes('90 of the 140'), dana && dana.body);
  ok('a mix of kinds, high risk first', /Family Care Dental \(dental office, Hoover\): no DMARC record/.test(dana.body) && /vet clinic/.test(dana.body) && /law firm/.test(dana.body), dana.body);
  const office = rows.find((x) => x.email === 'office@hoovertech.test');
  ok('a shared inbox gets "Hi there"', office && /^Hi there,/.test(office.body));
  const pick = (b) => (b.match(/^(.+?) \(/gm) || []).filter((l) => !/^Hi /.test(l));
  ok('different businesses for the second IT company in the city', JSON.stringify(pick(office.body)) !== JSON.stringify(pick(dana.body)), [pick(dana.body), pick(office.body)]);
  ok('the batch and area are recorded', rows.every((x) => x.batch === 'test' && x.area === 'Hoover, AL' && x.company !== 'Magic City IT, LLC'));

  OUT.push('-- edge cases --');
  lookedUp.length = 0;
  const thin = await L.buildCity(P(), { area: 'Tiny, AL', deps: { places: { find: async () => ({ businesses: [msp('Fresh IT', 'fresh.test')], errors: [] }) }, run: run(GAPS.slice(0, 2)), findOwner } });
  ok('a city with fewer than 3 gaps drafts nothing and spends no Hunter credits', thin.drafted === 0 && lookedUp.length === 0 && thin.skipped.some((s) => /only 2/.test(s.why)), thin);
  const again = await L.buildCity(P(), { area: 'Hoover, AL', deps: { places, run: run(GAPS), findOwner } });
  ok('building the same city again adds nobody twice', again.drafted === 0, again);

  OUT.push('-- the job --');
  const alerts = [];
  const job = L.start(P(), { areas: ['Pelham, AL'], max: 5, deps: { places: { find: async () => ({ businesses: [msp('Pelham IT', 'pelhamit.test')], errors: [] }) }, run: run(GAPS),
    findOwner: async () => ({ ok: true, email: 'bo@pelhamit.test', first: 'Bo', verified: true }), alert: async (m) => alerts.push(m) } });
  for (let i = 0; i < 50 && L.get(job.id).status === 'running'; i++) await new Promise((r2) => setTimeout(r2, 50));
  ok('a build runs in the background and reports each city', L.get(job.id).status === 'done' && L.get(job.id).cities[0].drafted === 1, L.get(job.id));
  ok('JohnMark is emailed that drafts wait for his OK', alerts.length === 1 && /1 new IT company drafts ready for your OK/.test(alerts[0].subject) && /Nothing has been sent/.test(alerts[0].text), alerts);

  OUT.push('-- wiring --');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const routes = ["app.post('/api/lab/prospector/outreach/build'", "app.get('/api/lab/prospector/outreach/build/:id'"];
  const adm = (x) => { const i = IX.indexOf(x); return i > 0 && IX.slice(i, i + 200).includes('_statusAdminOk(req)'); };
  ok('the build routes exist and check admin first', routes.every(adm));
  const RS = fs.readFileSync(REPO + 'server/services/prospector/run.js', 'utf8');
  ok('a gaps-only run stops before looking anyone up', RS.indexOf('if (input.gapsOnly)') > 0 && RS.indexOf('if (input.gapsOnly)') < RS.indexOf('Contacts.findPerson'));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
