'use strict';
// ── PROSPECTOR (services/prospector) ─────────────────────────────────────────
// Local test Postgres. Places, DNS, Hunter and the model are stand-ins.
//
//   - the email security finding, case by case, in plain words;
//   - a business's website must be its own domain;
//   - the right person by title, never info@, never an avoided title;
//   - only "valid" is verified; catch-all is kept but not verified;
//   - every email is checked; a bad one falls back to the true template;
//   - a run spends Hunter only on businesses with a gap, worst first, capped;
//   - it is saved and can be reopened; the routes are admin only.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('prospectortest', { schema: true });
require('./helpers/offlineDns').install();

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const PB = require(REPO + 'server/services/prospector/playbooks.js');
const Sec = require(REPO + 'server/services/prospector/emailSecurity.js');
const Places = require(REPO + 'server/services/prospector/places.js');
const Contacts = require(REPO + 'server/services/prospector/contacts.js');
const Writer = require(REPO + 'server/services/prospector/writer.js');
const R = require(REPO + 'server/services/prospector/run.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const P = () => store.pool;
const it = PB.get('it-msp');

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));

  OUT.push('-- the email security finding --');
  const MX = ['aspmx.l.google.com'];
  const a1 = Sec.assess('dent.com', { mx: MX, spf: ['v=spf1 include:_spf.google.com ~all'], dmarc: [] });
  ok('no DMARC is high, says anyone can pretend to be them', a1.level === 'high' && /pretending to be @dent\.com/.test(a1.problems[0]) && a1.mail === 'Google Workspace', a1);
  const a2 = Sec.assess('law.com', { mx: ['x.mail.protection.outlook.com'], spf: ['v=spf1 include:spf.protection.outlook.com -all'], dmarc: ['v=DMARC1; p=none; rua=mailto:x@y.z'] });
  ok('DMARC p=none is medium, monitor only', a2.level === 'medium' && /monitor only/.test(a2.problems[0]) && a2.mail === 'Microsoft 365', a2);
  const a3 = Sec.assess('cpa.com', { mx: MX, spf: ['v=spf1 -all'], dmarc: ['v=DMARC1; p=reject'] });
  ok('DMARC reject and SPF -all: protected', a3.level === 'none' && a3.problems.length === 0, a3);
  const a4 = Sec.assess('gym.com', { mx: MX, spf: [], dmarc: [] });
  ok('no SPF and no DMARC: high, both named', a4.level === 'high' && a4.problems.length === 2, a4);
  const a5 = Sec.assess('two.com', { mx: MX, spf: ['v=spf1 a ~all', 'v=spf1 mx ~all'], dmarc: ['v=DMARC1; p=quarantine'] });
  ok('two SPF records: high', a5.level === 'high' && a5.problems.some((p) => /Two SPF/.test(p)), a5);
  const a6 = Sec.assess('open.com', { mx: MX, spf: ['v=spf1 +all'], dmarc: ['v=DMARC1; p=quarantine'] });
  ok('SPF +all: medium', a6.level === 'medium' && /\+all/.test(a6.problems[0]), a6);
  ok('no mail server: skipped, nobody to email', Sec.assess('x.com', { mx: [], spf: [], dmarc: [] }).level === 'skip');
  const fake = { resolveMx: async () => [{ exchange: 'aspmx.l.google.com' }], resolveTxt: async (n) => (n.startsWith('_dmarc.') ? [] : [['v=spf1 ', 'include:_spf.google.com ~all']]) };
  const live = await Sec.check('Clinic.COM', { resolver: fake });
  ok('check: joins split TXT records, lower-cases the domain', live.level === 'high' && live.domain === 'clinic.com' && /~all/.test(live.spf), live);
  const broken = await Sec.check('down.com', { resolver: { resolveMx: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); }, resolveTxt: async () => [] } });
  ok('a DNS failure is an error, never "protected"', broken.level === 'error', broken);

  OUT.push('-- domains --');
  ok('a business site is its domain, www dropped', Places.domainOf('https://www.SmileDental.com/contact') === 'smiledental.com');
  ok('social pages and site-builder hosts are not', Places.domainOf('https://facebook.com/smile') === null && Places.domainOf('https://smile.wixsite.com/x') === null && Places.domainOf('') === null);

  OUT.push('-- the person --');
  const emails = [
    { email: 'info@d.com', type: 'generic', firstName: null, confidence: 99 },
    { email: 'sam@d.com', type: 'personal', firstName: 'Sam', lastName: 'Lee', position: 'Dental Hygienist', confidence: 95 },
    { email: 'ann@d.com', type: 'personal', firstName: 'Ann', lastName: 'Ray', position: 'Office Manager', confidence: 80 },
    { email: 'bo@d.com', type: 'personal', firstName: 'Bo', lastName: 'Kim', position: 'Owner', confidence: 70 },
    { email: 'int@d.com', type: 'personal', firstName: 'Ivy', position: 'Marketing Intern', confidence: 99 },
  ];
  ok('owner beats office manager beats anyone else; never info@', Contacts.pick(it, emails).email === 'bo@d.com');
  ok('an avoided title is never chosen', Contacts.pick(it, [emails[4]]) === null);
  const found = await Contacts.findPerson(it, 'd.com', { findDomainEmails: async () => ({ found: true, emails }), verifyEmail: async () => ({ ok: true, status: 'valid' }) });
  ok('valid address: verified', found.ok && found.verified === true && found.person.title === 'Owner', found);
  const catchall = await Contacts.findPerson(it, 'd.com', { findDomainEmails: async () => ({ found: true, emails }), verifyEmail: async () => ({ ok: true, status: 'accept_all' }) });
  ok('catch-all: kept, never called verified', catchall.ok && catchall.verified === false && catchall.verifyStatus === 'accept_all');
  const emptySite = async () => ({ outcomeKind: 'fetched-empty', people: [], personalEmail: null, roleEmail: null, formUrl: null });
  const none = await Contacts.findPerson(it, 'd.com', { findDomainEmails: async () => null, findSiteEmail: emptySite, verifyEmail: async () => { throw new Error('should not verify'); } });
  ok('nobody at the domain or on the site: a plain reason, no verify spent', none.ok === false && /knows no one/.test(none.why) && /website: fetched-empty/.test(none.why), none);
  const fault = await Contacts.findPerson(it, 'd.com', { findDomainEmails: async () => ({ found: false, emails: [], fault: { outcome: 'budget', reason: 'budget spent' } }), findSiteEmail: emptySite });
  ok('a Hunter fault is reported as ours', fault.ok === false && /Hunter: budget spent/.test(fault.why));

  OUT.push('-- the ladder: website, then the office inbox --');
  ok('names: "Dr. Jane A. Smith, DMD" is Jane Smith', JSON.stringify(Contacts.splitName('Dr. Jane A. Smith, DMD')) === JSON.stringify({ first: 'Jane', last: 'Smith' }) && Contacts.splitName('Smith') === null);
  ok('inboxes: office@ beats info@; careers@ and billing@ never', Contacts.bestInbox(['info@d.com', 'office@d.com']) === 'office@d.com' && Contacts.bestInbox(['careers@d.com', 'billing@d.com']) === null);
  const vOk = async () => ({ ok: true, status: 'valid' });
  const hunterGeneric = async () => ({ found: true, emails: [{ email: 'info@d.com', type: 'generic', confidence: 90 }] });
  const s1 = await Contacts.findPerson(it, 'd.com', { findDomainEmails: hunterGeneric, verifyEmail: vOk,
    findSiteEmail: async () => ({ outcomeKind: 'found', people: [{ name: 'Dr. Jane Smith', title: 'Owner' }], personalEmail: 'jane@d.com', roleEmail: 'office@d.com' }) }, { website: 'https://d.com' });
  ok('the site publishes the owner\'s own address: named, from the website', s1.ok && s1.kind === 'named' && s1.source === 'website' && s1.person.first === 'Jane' && s1.person.title === 'Owner' && s1.verified, s1);
  const finderCalls = [];
  const s2 = await Contacts.findPerson(it, 'd.com', { findDomainEmails: hunterGeneric, verifyEmail: async () => ({ ok: true, status: 'accept_all' }),
    findEmail: async (f, l, d) => { finderCalls.push([f, l, d]); return { email: 'jsmith@d.com', score: 88 }; },
    findSiteEmail: async () => ({ outcomeKind: 'found', people: [{ name: 'Jane Smith', title: 'Owner' }], personalEmail: null, roleEmail: 'office@d.com' }) });
  ok('the site names the owner: Hunter\'s finder looks her up by name', s2.ok && s2.kind === 'named' && s2.source === 'website+hunter' && s2.person.email === 'jsmith@d.com' && JSON.stringify(finderCalls[0]) === '["Jane","Smith","d.com"]' && s2.verified === false, s2);
  const s3 = await Contacts.findPerson(it, 'd.com', { findDomainEmails: hunterGeneric, verifyEmail: vOk, findEmail: async () => ({ email: null }),
    findSiteEmail: async () => ({ outcomeKind: 'found', people: [{ name: 'Jane Smith', title: 'Owner' }], personalEmail: null, roleEmail: 'office@d.com' }) });
  ok('no address for the owner: the office inbox, greeting nobody, owner noted', s3.ok && s3.kind === 'inbox' && s3.person.email === 'office@d.com' && s3.person.first === '' && s3.person.owner === 'Jane Smith, Owner', s3);
  const s4 = await Contacts.findPerson(it, 'd.com', { findDomainEmails: hunterGeneric, verifyEmail: vOk, findSiteEmail: emptySite });
  ok('nothing on the site: Hunter\'s generic address is the inbox', s4.ok && s4.kind === 'inbox' && s4.person.email === 'info@d.com' && s4.source === 'hunter');
  const s5 = await Contacts.findPerson(it, 'd.com', { findDomainEmails: async () => null, findSiteEmail: async () => ({ outcomeKind: 'found', type: 'form', people: [], formUrl: 'https://d.com/contact' }) });
  ok('a contact form only: not an address, said so', s5.ok === false && /contact form only/.test(s5.why) && s5.formUrl === 'https://d.com/contact');
  const s6 = await Contacts.findPerson(it, 'd.com', { findDomainEmails: async () => null, verifyEmail: vOk,
    findSiteEmail: async () => ({ outcomeKind: 'found', corporate: true, people: [], personalEmail: 'bob@d.com', roleEmail: 'info@d.com' }) });
  ok('a chain\'s corporate address is never used', s6.ok === false, s6);

  OUT.push('-- not a fit --');
  ok('a hospital is skipped; an animal hospital is a vet and kept', PB.skipReason(it, { name: 'UAB St. Vincent’s', category: 'Hospital' }) && !PB.skipReason(it, { name: 'Avondale Animal Hospital', category: 'Veterinary Care' }));
  ok('a medical center by name, and a chain of 5 locations, are skipped', /large/.test(PB.skipReason(it, { name: 'Grandview Medical Center', category: 'Medical clinic' })) && /chain/.test(PB.skipReason(it, { name: 'Smile Co', category: 'Dentist', locations: 5 })));
  ok('a two-office dental practice is a fit', PB.skipReason(it, { name: 'Smile Co', category: 'Dentist', locations: 2 }) === null);
  const fakePlaces = async (url, o) => {
    const q = JSON.parse(o.body).textQuery;
    const mk = (id, name, site) => ({ id, displayName: { text: name }, websiteUri: site, businessStatus: 'OPERATIONAL' });
    const places = /dental/.test(q) ? [mk('1', 'D1', 'https://d1.com'), mk('2', 'D2', 'https://d2.com'), mk('3', 'Chain A', 'https://chain.com'), mk('4', 'Chain B', 'https://chain.com/loc2')]
      : [mk('5', 'L1', 'https://l1.com'), mk('6', 'L2', 'https://l2.com')];
    return { ok: true, json: async () => ({ places }) };
  };
  const pf = await Places.find(['dental office', 'law firm'], 'B', { apiKey: 'k', fetchImpl: fakePlaces });
  ok('every term searched, results taken in turn (dentist, lawyer, dentist...)', pf.businesses.map((b) => b.name).join(',') === 'D1,L1,D2,L2,Chain A', pf.businesses.map((b) => b.name));
  ok('two places on one website count as two locations', pf.businesses.find((b) => b.domain === 'chain.com').locations === 2);

  OUT.push('-- the email --');
  const ctx = { business: 'Smile Dental', domain: 'smile.com', category: 'Dentist', area: 'Birmingham, AL', finding: a1,
    person: { first: 'Bo', last: 'Kim', title: 'Owner' }, sender: { name: 'Pat Smith', company: 'Magic City IT', about: '' } };
  const goodBody = 'Hi Bo,\n\nI was looking at smile.com and noticed it has no DMARC record, so anyone can send email that looks like it came from your office.\n\nFor a dental office that is how billing scams start. It is a short fix.\n\nWorth a 10 minute call this week?\n\nPat Smith\nMagic City IT';
  const good = await Writer.write(ctx, it, { oneShot: async () => JSON.stringify({ subject: 'Email at smile.com', body: goodBody }) });
  ok('a clean email passes as written', good.source === 'writer' && good.body === goodBody, good);
  const bad = await Writer.write(ctx, it, { oneShot: async () => JSON.stringify({ subject: 'Urgent!', body: 'Bo, you were hacked. We scanned smile.com. $199 to fix!' }) });
  ok('hacked, scanned, a price, "!": falls back to the template', bad.source === 'template' && bad.rejected.length >= 3 && /no DMARC record/i.test(bad.body), bad.rejected);
  const dashes = await Writer.write(ctx, it, { oneShot: async () => JSON.stringify({ subject: 'Email at smile.com', body: goodBody.replace('office.', 'office — really.') }) });
  ok('long dashes are replaced, not left', dashes.source === 'writer' && !/[—–]/.test(dashes.body));
  const thrown = await Writer.write(ctx, it, { oneShot: async () => { throw new Error('529'); } });
  ok('a model failure: the template, never nothing', thrown.source === 'template' && /Pat Smith/.test(thrown.body));
  ok('the writer uses the NILDash writer model', Writer.MODEL === 'claude-sonnet-4-6');
  ok('the template names the domain, the finding and the sender, no blanks', Writer.check(Writer.template(ctx), ctx).length === 0, Writer.check(Writer.template(ctx), ctx));

  const inboxCtx = { ...ctx, person: { first: '', last: '', title: 'Office inbox', email: 'office@smile.com', owner: 'Bo Kim, Owner' } };
  ok('to an office inbox the writer is told to greet nobody by name', /Hi there/.test(Writer.recipient(inboxCtx)) && /Bo Kim/.test(Writer.recipient(inboxCtx)));
  ok('a shared inbox greeted by name is rejected; "Hi there" passes',
    Writer.check({ subject: 's', body: goodBody }, inboxCtx).includes('greets a shared inbox by name')
    && Writer.check({ subject: 's', body: goodBody.replace('Hi Bo,', 'Hi there,') }, inboxCtx).length === 0);
  ok('the wrong first name is rejected', Writer.check({ subject: 's', body: goodBody.replace('Hi Bo,', 'Hi Sam,') }, ctx).includes('greets the wrong name'));
  ok('the template to an inbox says "Hi there"', /^Hi there,/.test(Writer.template(inboxCtx).body));

  OUT.push('-- a run --');
  const biz = [
    { name: 'A Dental', domain: 'a.com', category: 'Dentist', ratings: 50 },
    { name: 'B Law', domain: 'b.com', category: 'Law firm', ratings: 900 },
    { name: 'C CPA', domain: 'c.com', category: 'Accountant', ratings: 10 },
    { name: 'D Vet', domain: 'd.com', category: 'Vet', ratings: 300 },
    { name: 'E PT', domain: 'e.com', category: 'PT', ratings: 5 },
  ];
  const levels = { 'a.com': 'medium', 'b.com': 'high', 'c.com': 'none', 'd.com': 'high', 'e.com': 'skip' };
  const hunted = [];
  let started = null;
  const out = await R.run(P(), { playbook: 'it-msp', area: 'Birmingham, AL', limit: 2, sender: { name: 'Pat', company: 'Magic City IT' }, onStart: (id) => { started = id; } }, {
    places: { find: async () => ({ businesses: biz, errors: [] }) },
    emailSecurity: { check: async (d) => ({ domain: d, level: levels[d], mail: 'Google Workspace', problems: levels[d] === 'none' || levels[d] === 'skip' ? [] : [`No DMARC record. Anyone can send email pretending to be @${d}, and many inboxes will accept it.`] }) },
    contacts: { findDomainEmails: async (d) => { hunted.push(d); return { found: true, emails: [{ email: 'o@' + d, type: 'personal', firstName: 'Olu', position: 'Owner', confidence: 90 }] }; },
      verifyEmail: async (e) => ({ ok: true, status: e === 'o@b.com' ? 'valid' : 'accept_all' }) },
    writer: { oneShot: async () => 'not json' },
  });
  ok('the run answers with its id as soon as it starts', started && started === out.runId);
  ok('every business checked; gaps counted by level', out.summary.checked === 5 && out.summary.withGap === 3 && out.summary.high === 2 && out.summary.protected === 1 && out.summary.noMail === 1, out.summary);
  ok('Hunter only on gaps, worst first (high, more reviews first), capped at the limit', JSON.stringify(hunted.sort()) === JSON.stringify(['b.com', 'd.com']), hunted);
  ok('verified counted from "valid" only', out.summary.verified === 1 && out.summary.people === 2);
  const saved = await R.get(P(), out.runId);
  ok('saved and reopened: done, 2 leads, verified first', saved.run.status === 'done' && saved.leads.length === 2 && saved.leads[0].domain === 'b.com' && saved.leads[0].verified === true, saved.leads.map((l) => [l.domain, l.verified]));
  ok('each lead keeps the finding, the person and the email', saved.leads.every((l) => l.finding && l.person && l.email && l.email.body));
  ok('recent runs list it', (await R.recent(P())).some((r) => r.id === out.runId));
  const hunted2 = [];
  const out2 = await R.run(P(), { playbook: 'it-msp', area: 'B', limit: 5 }, {
    places: { find: async () => ({ businesses: [...biz, { name: 'Big Hospital', domain: 'h.com', category: 'Hospital', ratings: 5000 }], errors: [] }) },
    emailSecurity: { check: async (d) => ({ domain: d, level: d === 'h.com' ? 'high' : levels[d], problems: ['No DMARC record. x'] }) },
    contacts: { findDomainEmails: async (d) => { hunted2.push(d); return { found: true, emails: [{ email: 'info@' + d, type: 'generic' }] }; },
      findSiteEmail: async () => ({ outcomeKind: 'fetched-empty', people: [] }), verifyEmail: async () => ({ ok: true, status: 'valid' }) },
    writer: { oneShot: async () => 'not json' },
  });
  ok('a hospital is skipped before any check or credit', out2.summary.skipped === 1 && out2.summary.skippedWhy['a hospital'] === 1 && !hunted2.includes('h.com'), out2.summary);
  ok('office inboxes count as reachable, not as named people', out2.summary.reachable === 3 && out2.summary.inboxes === 3 && out2.summary.people === 0, out2.summary);
  const saved2 = await R.get(P(), out2.runId);
  ok('the lead keeps how it was reached', saved2.leads.every((l) => l.person.kind === 'inbox' && l.person.source === 'hunter') && saved2.leads.every((l) => /^Hi there,/.test(l.email.body)));
  let refused = null;
  try { await R.run(P(), { playbook: 'nope', area: 'x' }); } catch (e) { refused = e; }
  ok('an unknown market is refused in plain words', refused && refused.status === 400);

  OUT.push('-- wiring --');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const routes = ["app.get('/lab/prospector'", "app.get('/api/lab/prospector/playbooks'", "app.get('/api/lab/prospector/runs'", "app.get('/api/lab/prospector/runs/:id'", "app.post('/api/lab/prospector/run'"];
  ok('page and API routes exist', routes.every((r) => IX.includes(r)));
  const block = IX.slice(IX.indexOf("app.get('/lab/prospector'"), IX.indexOf("app.get('/admin/status'"));
  ok('every prospector route checks admin first', (block.match(/_statusAdminOk\(req\)/g) || []).length === 5);
  const H = fs.readFileSync(REPO + 'server/views/prospector.html', 'utf8');
  ok('the page escapes everything it shows', /const esc = /.test(H) && !/innerHTML = l\./.test(H));
  ok('only ready markets can be picked', PB.list().find((p) => p.key === 'staffing').ready === false && PB.list().find((p) => p.key === 'it-msp').ready === true);

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
