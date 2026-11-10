'use strict';
//   node tests/brandmarket.js   (local test Postgres)
//
// The brand marketplace (services/brandMarket): a local business posts what
// it wants from a local athlete; once it confirms, every agent with an athlete
// who fits gets one email, with a reply-to straight to the business.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const BM = require(REPO + 'server/services/brandMarket.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };
const P = () => store.pool;
const AG = ['bm-ag1', 'bm-ag2', 'bm-ag3', 'bm-samp'];
function recorder() { const sent = []; return { sent, send: async (m) => { sent.push(m); return { id: 'x' }; } }; }
const tokenOf = async (id) => (await P().query(`SELECT token FROM brand_requests WHERE id = $1`, [id])).rows[0].token;

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await BM.ensureTables(P());
  const clean = async () => {
    await P().query(`DELETE FROM brand_request_sends WHERE agent_id = ANY($1)`, [AG]);
    await P().query(`DELETE FROM brand_market_optout WHERE agent_id = ANY($1)`, [AG]);
    await P().query(`DELETE FROM brand_requests WHERE email LIKE '%@bm.example'`);
    await P().query(`DELETE FROM athletes WHERE agent_id = ANY($1)`, [AG]);
    await P().query(`DELETE FROM users WHERE id = ANY($1)`, [AG]);
  };
  await clean();
  const users = [['bm-ag1', 'Ann Agent', 'ann@bm.example'], ['bm-ag2', 'Bob Agent', 'bob@bm.example'], ['bm-ag3', 'Cy Agent', 'cy@bm.example'], ['bm-samp', 'Samples', 'samples@mynildash.invalid']];
  for (const [id, name, email] of users) await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,$2,$3,'x','agent')`, [id, name, email]);
  // Ann: a soccer player at Temple (Philadelphia) and a footballer at Penn (same town).
  await store.saveAthlete('bm-a1', { id: 'bm-a1', agentId: 'bm-ag1', name: 'Jordan Hale', sport: 'womens soccer', school: 'Temple University' });
  await store.saveAthlete('bm-a2', { id: 'bm-a2', agentId: 'bm-ag1', name: 'Max Penn', sport: 'football', school: 'University of Pennsylvania' });
  // Bob: football at Villanova (about 12 miles from Temple): within 30 miles.
  await store.saveAthlete('bm-a3', { id: 'bm-a3', agentId: 'bm-ag2', name: 'Vic Nova', sport: 'football', school: 'Villanova University' });
  // Cy: football in Alabama: far away.
  await store.saveAthlete('bm-a4', { id: 'bm-a4', agentId: 'bm-ag3', name: 'Sam Ford', sport: 'football', school: 'Samford University' });
  // The hidden samples account, right next door: never.
  await store.saveAthlete('bm-a5', { id: 'bm-a5', agentId: 'bm-samp', name: 'Sample Kid', sport: 'football', school: 'Temple University' });

  OUT.push('-- the form --');
  ok('school search finds Temple by name', BM.schoolSearch('temple').some((s) => s.name === 'Temple University' && s.state === 'PA'), BM.schoolSearch('temple'));
  ok('  and by town', BM.schoolSearch('sioux city').some((s) => /Morningside/.test(s.name)));
  const r0 = recorder();
  let err = null; try { await BM.submit(P(), { business: 'Joe Coffee', email: 'bad', schools: [{ name: 'Temple University', state: 'PA' }], details: 'We want a post about our shop opening.' }, { send: r0.send }); } catch (e) { err = e.message; }
  ok('a bad email is refused', /real email/.test(err || ''), err);
  err = null; try { await BM.submit(P(), { business: 'Joe Coffee', email: 'joe@bm.example', schools: [{ name: 'Nowhere U', state: 'PA' }], details: 'We want a post about our shop opening.' }, { send: r0.send }); } catch (e) { err = e.message; }
  ok('a school not in the directory is refused', /Pick at least one school/.test(err || ''), err);
  ok('a bot that fills the hidden field is ignored, nothing saved', (await BM.submit(P(), { website_url: 'x', business: 'Bot', email: 'bot@bm.example' }, { send: r0.send })).ok
    && !(await P().query(`SELECT 1 FROM brand_requests WHERE email='bot@bm.example'`)).rows.length);

  const r1 = recorder();
  const sub = await BM.submit(P(), { business: 'Joe Coffee Philly', category: 'coffee shop', name: 'Joe Smith', email: 'joe@bm.example', phone: '215-555-0100',
    schools: [{ name: 'Temple University', state: 'PA' }], sports: ['football', 'soccer'], does: ['social post', 'appearance'], budget: '$250 to $1,000',
    details: 'We want a football or soccer player to post about our new shop and stop by opening day.' }, { send: r1.send });
  ok('a request is saved pending', sub.ok && (await P().query(`SELECT status FROM brand_requests WHERE id=$1`, [sub.id])).rows[0].status === 'pending');
  ok('  the business gets a confirm link', r1.sent.some((m) => m.to === 'joe@bm.example' && /\/brands\/confirm\//.test(m.text)), r1.sent.map((m) => m.to));
  ok('  JohnMark is told', r1.sent.some((m) => /^Brand request: Joe Coffee Philly/.test(m.subject)));
  ok('  no agent gets anything before it is confirmed', !r1.sent.some((m) => /bm\.example$/.test(m.to) && m.to !== 'joe@bm.example' && /local business wants/.test(m.subject)));

  OUT.push('', '-- confirmed: who gets it --');
  const r2 = recorder();
  const c = await BM.confirm(P(), await tokenOf(sub.id), { send: r2.send });
  const toAgents = r2.sent.filter((m) => /A local business wants your athlete/.test(m.subject));
  ok('confirmed, it goes live and reaches 2 agents', c.ok && c.status === 'live' && c.agents === 2, c);
  const ann = toAgents.find((m) => m.to === 'ann@bm.example');
  ok('Ann gets ONE email naming both her athletes in town (same school and same city)', ann && /Jordan Hale/.test(ann.text) && /Max Penn/.test(ann.text), ann && ann.text);
  ok('Bob gets it for his athlete within 30 miles (Villanova)', toAgents.some((m) => m.to === 'bob@bm.example' && /Vic Nova/.test(m.text)));
  ok('Cy, in Alabama, does not', !toAgents.some((m) => m.to === 'cy@bm.example'));
  ok('the samples account never does', !toAgents.some((m) => /invalid/.test(m.to)));
  ok('replies go straight to the business', toAgents.every((m) => m.replyTo === 'joe@bm.example'));
  ok('  and the email says what they want, the budget, and how to stop these', ann && /What they want: We want a football/.test(ann.text) && /Budget: \$250 to \$1,000/.test(ann.text) && /\/brands\/off\?a=/.test(ann.text));
  ok('the business is told how many agents got it', r2.sent.some((m) => m.to === 'joe@bm.example' && /went to 2 agents/.test(m.subject)));
  const again = await BM.confirm(P(), await tokenOf(sub.id), { send: recorder().send });
  ok('the link again changes nothing', again.ok && again.already, again);

  OUT.push('', '-- every day after --');
  await store.saveAthlete('bm-a6', { id: 'bm-a6', agentId: 'bm-ag3', name: 'New Owl', sport: 'football', school: 'Temple University' });
  await P().query(`UPDATE brand_requests SET last_matched_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [sub.id]);
  const r3 = recorder();
  const t = await BM.tick(P(), { deps: { send: r3.send, force: true } });
  ok('the daily match reaches an agent whose athlete was added since', r3.sent.some((m) => m.to === 'cy@bm.example' && /New Owl/.test(m.text)), r3.sent.map((m) => m.to));
  ok('  and nobody twice', !r3.sent.some((m) => m.to === 'ann@bm.example' || m.to === 'bob@bm.example'));
  ok('it runs at 10am Central only', (await BM.tick(P(), { now: new Date('2026-11-10T20:00:00Z'), deps: { send: recorder().send } })).skipped === 'not the hour');

  const sport = await BM.submit(P(), { business: 'Golf Shop', email: 'golf@bm.example', schools: [{ name: 'Temple University', state: 'PA' }], sports: ['golf'],
    details: 'Looking for a golfer to show our new clubs on social.' }, { send: recorder().send });
  const r4 = recorder();
  const c4 = await BM.confirm(P(), await tokenOf(sport.id), { send: r4.send });
  ok('a sport nobody nearby plays reaches no agent, and the business is told it stays live', c4.agents === 0 && r4.sent.some((m) => m.to === 'golf@bm.example' && /stays live for 60 days/.test(m.text)), c4);

  OUT.push('', '-- stopping --');
  const sig = BM.optOutUrl('bm-ag1').match(/s=([0-9a-f]+)/)[1];
  ok('a forged stop link does nothing', (await BM.optOut(P(), 'bm-ag1', '0'.repeat(32))) === false);
  ok('the agent\'s own link turns them off', (await BM.optOut(P(), 'bm-ag1', sig)) === true);
  const s3 = await BM.submit(P(), { business: 'Pizza Place', email: 'pizza@bm.example', schools: [{ name: 'Temple University', state: 'PA' }],
    details: 'We want an athlete to do a pizza review video.' }, { send: recorder().send });
  const r5 = recorder();
  await BM.confirm(P(), await tokenOf(s3.id), { send: r5.send });
  ok('  and they get no more requests', !r5.sent.some((m) => m.to === 'ann@bm.example') && r5.sent.some((m) => m.to === 'bob@bm.example'));
  ok('the business can close its request', (await BM.close(P(), await tokenOf(s3.id))).ok && (await P().query(`SELECT status FROM brand_requests WHERE id=$1`, [s3.id])).rows[0].status === 'closed');
  const prevOn = process.env.BRAND_MARKET; process.env.BRAND_MARKET = 'off';
  err = null; try { await BM.submit(P(), { business: 'X', email: 'x@bm.example', schools: [{ name: 'Temple University', state: 'PA' }], details: 'something long enough here' }, { send: recorder().send }); } catch (e) { err = e.status; }
  if (prevOn === undefined) delete process.env.BRAND_MARKET; else process.env.BRAND_MARKET = prevOn;
  ok('off with BRAND_MARKET=off', err === 503, err);

  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('routes: the page, school search, submit (rate limited), confirm, close, stop, admin list',
    /app\.get\('\/brands'/.test(idx) && /app\.get\('\/api\/brands\/schools', _portalFreeLimiter/.test(idx) && /app\.post\('\/api\/brands', _portalLeadLimiter/.test(idx)
      && /app\.get\('\/brands\/confirm\/:token'/.test(idx) && /app\.get\('\/brands\/close\/:token'/.test(idx) && /app\.get\('\/brands\/off'/.test(idx)
      && /app\.get\('\/api\/admin\/brand-requests', _coldAdmin/.test(idx));
  const page = fs.readFileSync(REPO + 'server/views/brands.html', 'utf8');
  ok('the page has the hidden bot field, the school search and the business address', /name="website_url"/.test(page) && /\/api\/brands\/schools/.test(page) && /Compton Group LLC, 3000 Northwoods Pkwy/.test(page));

  await clean();
}
main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  console.log(OUT.join('\n'));
  console.log(`\n${OUT.filter((l) => l.startsWith('PASS')).length} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
