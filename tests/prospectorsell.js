'use strict';
// ── PROSPECTOR, SOLD WITH NO CALL ────────────────────────────────────────────
// services/prospector/billing + samples + the public routes. Local test
// Postgres; Stripe and the Prospector run are stand-ins.
//
//   - plans and prices as approved ($299 / $499 / $1,499, yearly = 10 months);
//   - Stripe prices are created once under lookup keys, then reused;
//   - checkout refuses a taken area and never uses NILDash's "tier" key;
//   - the webhook makes the customer once, claims the area, flags a clash;
//   - a canceled customer releases the area;
//   - the free sample: built in the IT company's area, signed from them;
//   - the public road refuses personal email, repeats, floods and taken areas;
//   - the routes are wired, the admin ones checked, the pages escape.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('prospectorselltest', { schema: true });
require('./helpers/offlineDns').install();
process.env.PROSPECTOR_PUBLIC_SAMPLES_PER_DAY = '3';

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const B = require(REPO + 'server/services/prospector/billing.js');
const S = require(REPO + 'server/services/prospector/samples.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const P = () => store.pool;

function fakeStripe() {
  const calls = { products: [], prices: [], sessions: [] };
  const prices = [];
  return {
    calls,
    prices: {
      list: async ({ lookup_keys }) => ({ data: prices.filter((p) => lookup_keys.includes(p.lookup_key)) }),
      create: async (a) => { const p = { id: 'price_' + (prices.length + 1), ...a }; prices.push(p); calls.prices.push(a); return p; },
    },
    products: {
      search: async () => ({ data: [] }),
      create: async (a) => { calls.products.push(a); return { id: 'prod_' + calls.products.length }; },
    },
    checkout: { sessions: {
      create: async (a) => { calls.sessions.push(a); return { id: 'cs_' + calls.sessions.length, url: 'https://checkout.stripe.test/' + calls.sessions.length }; },
      retrieve: async (id) => (id === 'cs_late' ? { id: 'cs_late', status: 'complete', customer: 'cus_late', subscription: 'sub_late',
        customer_details: { email: 'late@acme.test' }, metadata: { product: 'prospector', prospector_plan: 'starter', period: 'monthly', area: 'Mobile, AL', area_key: 'mobile-al', company: 'Late IT' } } : null),
    } },
  };
}

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));

  OUT.push('-- plans --');
  const pp = B.publicPlans();
  ok('three plans at $299 / $499 / $1,499, yearly is ten months', JSON.stringify(pp.map((p) => [p.key, p.monthly, p.yearly])) === JSON.stringify([['starter', 299, 2990], ['territory', 499, 4990], ['dfy', 1499, 14990]]), pp);
  ok('Territory is the popular plan and about $5 a lead; Starter about $12', pp[1].popular && pp[1].perLead === 4.99 && pp[0].perLead === 11.96);
  ok('Territory and Done For You send and carry the guarantee; Starter does not', pp[1].sends && pp[2].sends && pp[1].guarantee && pp[2].guarantee && !pp[0].sends && !pp[0].guarantee);
  ok('no price id ever leaves the module', !JSON.stringify(pp).includes('price_'));
  ok('areas: "Birmingham, AL" and " birmingham  al " are one area', B.areaKey('Birmingham, AL') === 'birmingham-al' && B.areaKey(' birmingham  al ') === 'birmingham-al' && B.areaKey('  ') === null);

  OUT.push('-- Stripe prices --');
  const st = fakeStripe();
  const id1 = await B.ensurePrice(st, 'territory', 'monthly');
  const id2 = await B.ensurePrice(st, 'territory', 'monthly');
  ok('a missing price is created once under its lookup key, then reused', id1 === id2 && st.calls.prices.length === 1 && st.calls.prices[0].lookup_key === 'prospector_territory_monthly' && st.calls.prices[0].unit_amount === 49900, st.calls.prices);
  await B.ensurePrice(st, 'dfy', 'yearly');
  const y = st.calls.prices.find((p) => p.lookup_key === 'prospector_dfy_yearly');
  ok('yearly Done For You is $14,990 a year', y && y.unit_amount === 1499000 && y.recurring.interval === 'year');
  ok('products are tagged product=prospector', st.calls.products.every((p) => p.metadata.product === 'prospector'));
  let bad = null; try { await B.ensurePrice(st, 'gold', 'monthly'); } catch (e) { bad = e; }
  ok('an unknown plan is refused', bad && bad.status === 400);

  OUT.push('-- checkout --');
  const co = await B.createCheckout(P(), { plan: 'territory', period: 'yearly', area: 'Hoover, AL', company: 'Magic City IT', sampleToken: 'tok1', email: 'pat@magic.test', baseUrl: 'https://x.test/' }, { stripe: st });
  const sess = st.calls.sessions.at(-1);
  ok('a subscription checkout with the area and plan in its metadata', co.url && sess.mode === 'subscription' && sess.metadata.product === 'prospector'
    && sess.metadata.prospector_plan === 'territory' && sess.metadata.period === 'yearly' && sess.metadata.area_key === 'hoover-al' && sess.subscription_data.metadata.product === 'prospector', sess);
  ok('never the "tier" key NILDash\'s webhook reads', !('tier' in sess.metadata) && !('tier' in sess.subscription_data.metadata));
  ok('back to the sample page on cancel, to the welcome page on success', sess.cancel_url === 'https://x.test/s/tok1' && /\/prospector\/welcome\?session_id=\{CHECKOUT_SESSION_ID\}$/.test(sess.success_url) && sess.customer_email === 'pat@magic.test', sess);
  let e1 = null; try { await B.createCheckout(P(), { plan: 'territory', period: 'weekly', area: 'Hoover, AL' }, { stripe: st }); } catch (e) { e1 = e; }
  let e2 = null; try { await B.createCheckout(P(), { plan: 'territory', period: 'monthly', area: '' }, { stripe: st }); } catch (e) { e2 = e; }
  ok('a bad period or a missing area is refused in plain words', e1 && e1.status === 400 && e2 && e2.status === 400 && /area/i.test(e2.message));

  OUT.push('-- the webhook --');
  const session = { id: 'cs_A', customer: 'cus_A', subscription: 'sub_A', customer_details: { email: 'pat@magic.test' },
    metadata: { product: 'prospector', prospector_plan: 'territory', period: 'yearly', area: 'Hoover, AL', area_key: 'hoover-al', company: 'Magic City IT', sample_token: 'tok1' } };
  ok('a session that is not ours is ignored', (await B.onCheckoutCompleted(P(), { id: 'cs_x', metadata: { user_id: '7' } })) === null);
  const c1 = await B.onCheckoutCompleted(P(), session);
  const c1b = await B.onCheckoutCompleted(P(), session);
  const n = await P().query(`SELECT COUNT(*)::int AS n FROM prospector_customers`);
  ok('the customer is made once, active, with the area', c1.status === 'active' && c1.area_key === 'hoover-al' && c1b.id === c1.id && n.rows[0].n === 1, c1);
  const holder = await B.areaHolder(P(), 'hoover al');
  ok('the area is now held by them', holder && holder.id === c1.id);
  let taken = null; try { await B.createCheckout(P(), { plan: 'starter', period: 'monthly', area: 'Hoover, AL' }, { stripe: st }); } catch (e) { taken = e; }
  ok('a second IT company cannot check out the same area', taken && taken.status === 409 && /already taken/.test(taken.message));
  const clash = await B.onCheckoutCompleted(P(), { ...session, id: 'cs_B', customer: 'cus_B', subscription: 'sub_B' });
  ok('a payment that slips through for a held area is kept and flagged, not lost', clash.status === 'area-conflict');
  const upd = await B.onSubscription(P(), { id: 'sub_A', status: 'past_due', metadata: { product: 'prospector', prospector_plan: 'territory', period: 'yearly' } }, 'customer.subscription.updated');
  ok('subscription status follows Stripe', upd.status === 'past_due');
  ok('a subscription that is not ours is ignored', (await B.onSubscription(P(), { id: 'sub_A', status: 'canceled', metadata: { tier: 'growth' } }, 'customer.subscription.deleted')) === null);
  await B.onSubscription(P(), { id: 'sub_A', status: 'canceled', metadata: { product: 'prospector' } }, 'customer.subscription.deleted');
  ok('a canceled customer releases the area', (await B.areaHolder(P(), 'Hoover, AL')) === null);

  OUT.push('-- onboarding --');
  const ob = await B.onboard(P(), 'cs_A', { company: 'Magic City IT LLC', senderName: 'Pat Smith', about: 'Hoover IT shop' });
  ok('onboarding saves the sender details', ob.company === 'Magic City IT LLC' && ob.sender_name === 'Pat Smith' && ob.onboarded_at);
  const late = await B.onboard(P(), 'cs_late', { senderName: 'Lee' }, { stripe: st });
  ok('onboarding before the webhook lands reads the session from Stripe', late.area_key === 'mobile-al' && late.sender_name === 'Lee' && late.email === 'late@acme.test', late);
  let nope = null; try { await B.onboard(P(), 'cs_none', {}, { stripe: st }); } catch (e) { nope = e; }
  ok('an incomplete or unknown checkout is refused', nope && nope.status === 404);

  OUT.push('-- the free sample --');
  const runs = [];
  const fakeRun = async (pool, input) => {
    runs.push(input);
    const R = require(REPO + 'server/services/prospector/run.js');
    await R.ensureTables(pool);
    const id = (await pool.query(`INSERT INTO prospector_runs (playbook, area, status, summary) VALUES ('it-msp', $1, 'done', $2) RETURNING id`,
      [input.area, JSON.stringify({ checked: 120, withGap: 70, high: 40 })])).rows[0].id;
    input.onStart(id);
    await pool.query(`INSERT INTO prospector_leads (run_id, business, domain, category, level, finding, person, verified, verify_status, email)
      VALUES ($1,'Smile Dental','smile.test','Dentist','high',$2,$3,true,'valid',$4)`, [id,
      JSON.stringify({ problems: ['No DMARC record. Anyone can send email pretending to be @smile.test.'], mail: 'Google Workspace' }),
      JSON.stringify({ first: 'Bo', last: 'Kim', title: 'Owner', email: 'bo@smile.test', kind: 'named', source: 'hunter' }),
      JSON.stringify({ subject: 'Email at smile.test', body: 'Hi Bo,\n\n...\n\nPat Smith\nMagic City IT' })]);
    return { runId: id };
  };
  const made = await S.create(P(), { company: 'Magic City IT', first: 'Pat', last: 'Smith', email: 'pat@magic.test', area: 'Pelham, AL' }, { run: fakeRun });
  await made.done;
  ok('the sample runs in the IT company\'s area, 10 leads, signed from them', runs[0].area === 'Pelham, AL' && runs[0].limit === 10 && runs[0].sender.name === 'Pat Smith' && runs[0].sender.company === 'Magic City IT', runs[0]);
  const v = await S.view(P(), made.token, { countView: true });
  ok('the page shows the leads, the person, the email and the plans', v.status === 'ready' && v.leads.length === 1 && v.leads[0].person.email === 'bo@smile.test'
    && v.leads[0].verified && /No DMARC/.test(v.leads[0].problem) && v.plans.length === 3 && v.summary.withGap === 70 && v.areaTaken === false, v);
  ok('nothing internal leaks into the page (no run id, no ip, no source)', !('run_id' in v) && !('ip' in v) && !('source' in v));
  await new Promise((r) => setTimeout(r, 50));
  const views = await P().query(`SELECT views FROM prospector_samples WHERE token = $1`, [made.token]);
  ok('views are counted', views.rows[0].views === 1);
  ok('an unknown token is nothing', (await S.view(P(), 'nope')) === null);
  let nocomp = null; try { await S.create(P(), { area: 'X, AL' }, { run: fakeRun }); } catch (e) { nocomp = e; }
  ok('a sample needs a company', nocomp && nocomp.status === 400);

  OUT.push('-- the public road --');
  let gm = null; try { await S.requestPublic(P(), { company: 'A', email: 'a@gmail.com', area: 'Tuscaloosa, AL' }, { run: fakeRun }); } catch (e) { gm = e; }
  ok('personal email is refused', gm && gm.status === 400 && /company email/.test(gm.message));
  const p1 = await S.requestPublic(P(), { company: 'Acme IT', first: 'Al', email: 'al@acmeit.test', area: 'Tuscaloosa, AL', ip: '9.9.9.9' }, { run: fakeRun });
  const p2 = await S.requestPublic(P(), { company: 'Acme IT', first: 'Al', email: 'bob@acmeit.test', area: 'Tuscaloosa, AL', ip: '9.9.9.9' }, { run: fakeRun });
  ok('the same company within a week gets the same sample, no new credits', p2.existing === true && p2.token === p1.token);
  await S.requestPublic(P(), { company: 'B IT', email: 'b@bit.test', area: 'Auburn, AL', ip: '9.9.9.9' }, { run: fakeRun });
  await S.requestPublic(P(), { company: 'C IT', email: 'c@cit.test', area: 'Dothan, AL', ip: '9.9.9.9' }, { run: fakeRun });
  let ipcap = null; try { await S.requestPublic(P(), { company: 'D IT', email: 'd@dit.test', area: 'Selma, AL', ip: '9.9.9.9' }, { run: fakeRun }); } catch (e) { ipcap = e; }
  ok('one address cannot ask for more than 3 a day', ipcap && ipcap.status === 429);
  let daycap = null; try { await S.requestPublic(P(), { company: 'E IT', email: 'e@eit.test', area: 'Gadsden, AL', ip: '8.8.8.8' }, { run: fakeRun }); } catch (e) { daycap = e; }
  ok('the daily cap for everyone holds', daycap && daycap.status === 429, daycap && daycap.message);
  process.env.PROSPECTOR_PUBLIC_SAMPLES_PER_DAY = '50';
  await B.onCheckoutCompleted(P(), { id: 'cs_C', customer: 'cus_C', subscription: 'sub_C', metadata: { product: 'prospector', prospector_plan: 'starter', period: 'monthly', area: 'Florence, AL', area_key: 'florence-al' } });
  let held = null; try { await S.requestPublic(P(), { company: 'F IT', email: 'f@fit.test', area: 'Florence, AL', ip: '7.7.7.7' }, { run: fakeRun }); } catch (e) { held = e; }
  ok('a taken area is refused before any credits are spent', held && held.status === 409);

  OUT.push('-- wiring --');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const routes = ["app.get('/it'", "app.get('/s/:token'", "app.get('/prospector/welcome'", "app.get('/api/prospector/plans'", "app.post('/api/prospector/sample-request'",
    "app.get('/api/prospector/sample/:token'", "app.post('/api/prospector/checkout'", "app.get('/api/prospector/welcome'", "app.post('/api/prospector/onboard'",
    "app.post('/api/lab/prospector/samples'", "app.get('/api/lab/prospector/samples'"];
  ok('every route exists', routes.every((r) => IX.includes(r)), routes.filter((r) => !IX.includes(r)));
  const adm = (r) => { const i = IX.indexOf(r); return IX.slice(i, i + 200).includes('_statusAdminOk(req)'); };
  ok('the admin sample routes check admin first', adm("app.post('/api/lab/prospector/samples'") && adm("app.get('/api/lab/prospector/samples'"));
  const wh = IX.indexOf("_PB.onCheckoutCompleted"), nild = IX.indexOf("const athleteId = session.metadata && session.metadata.athlete_id");
  ok('the webhook hands Prospector events over before NILDash\'s own handlers', wh > 0 && nild > 0 && wh < nild);
  ok('the public sample request and checkout are rate limited', /app\.post\('\/api\/prospector\/sample-request', _prospectorPublicLimiter/.test(IX) && /app\.post\('\/api\/prospector\/checkout', _prospectorPublicLimiter/.test(IX));
  const pages = ['prospector-sales.html', 'prospector-sample.html', 'prospector-welcome.html'].map((f) => fs.readFileSync(REPO + 'server/views/' + f, 'utf8'));
  ok('every page escapes what it shows', pages.every((h) => /const esc = /.test(h)));
  ok('the sample and welcome pages are kept out of search', /noindex/.test(pages[1]) && /noindex/.test(pages[2]));
  ok('the sales page shows no price that is not in the plans', !/\$697|\$1,497|\$297/.test(pages[0]));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
