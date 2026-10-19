'use strict';
// THE HOMEPAGE'S HERO PICTURE: the agent Home screen, one athlete's morning of
// cards, on the demo account, at phone width. Rebuilds public/images/
// home-morning.png whenever Home changes.
//
//   node scripts/home-screenshot.js
//
// LOCAL ONLY. It makes its own fresh database, seeds the demo account
// (server/scripts/seedDemo: fictional athletes) and adds five fictional
// businesses with fictional contacts on reserved .example addresses, so no
// real business or person is ever shown. It refuses to run with DATABASE_URL
// set or against a Postgres that is not on this machine.
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..') + path.sep;

const host = process.env.PGHOST || '/tmp';
if (process.env.DATABASE_URL || !(host.startsWith('/') || /^(localhost|127\.0\.0\.1)$/.test(host))) {
  console.error('Refusing: this writes demo cards, and runs only against a local Postgres (unset DATABASE_URL; PGHOST a socket path or localhost).');
  process.exit(2);
}
process.env.PGHOST = host;
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require(ROOT + 'tests/helpers/freshDb').freshDb('homeshot', { schema: true });
const PORT = parseInt(process.env.SHOT_PORT, 10) || 3917;
const OUT = process.env.SHOT_OUT || (ROOT + 'public/images/home-morning.png');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

// Five fictional businesses for the demo's Jordan Blake (Kennesaw State).
const CARDS = [
  { brand: 'Ridgeline Smoothie Bar', key: 'demo-ridgeline-smoothie', name: 'Tasha Greene', title: 'Owner', email: 'tasha@ridgelinesmoothie.example',
    why: 'Jordan posts his post-practice recovery routine, and most of his followers are Kennesaw State students who live within a few miles of the shop.',
    body: 'Hi Tasha,\n\nJordan Blake, a junior guard at Kennesaw State, makes a post-workout smoothie part of his routine and shares it with a mostly student audience a few miles from you.\n\nWould a month of Instagram posts and an in-store visit be worth a quick call?' },
  { brand: 'Northside Cycle Works', key: 'demo-northside-cycle', name: 'Marcus Hale', title: 'Owner', email: 'marcus@northsidecycle.example',
    why: 'Off-season conditioning content does well on Jordan’s page, and the shop is on the route he rides to campus.',
    body: 'Hi Marcus,\n\nJordan Blake trains on a bike most of the off-season and films it.' },
  { brand: 'Ironleaf Barbell Club', key: 'demo-ironleaf-barbell', name: 'Renee Ortiz', title: 'Marketing Manager', email: 'renee.ortiz@ironleafbarbell.example',
    why: 'A strength gym looking for members aged 18 to 24, and Jordan’s lifting videos are his most shared posts.',
    body: 'Hi Renee,\n\nJordan Blake’s lifting videos are his most shared posts.' },
  { brand: 'Copper Kettle Tacos', key: 'demo-copper-kettle', name: 'Luis Romero', title: 'Owner', email: 'luis@copperkettletacos.example',
    why: 'Game-night specials near campus, and Jordan already tags local spots after home games.',
    body: 'Hi Luis,\n\nJordan Blake tags local spots after every home game.' },
  { brand: 'Peak Motion Physical Therapy', key: 'demo-peak-motion', name: 'Amy Whitlock', title: 'Marketing Director', email: 'awhitlock@peakmotionpt.example',
    why: 'Sports recovery clinic that sponsors college athletes, and Jordan talks about mobility work in his weekly videos.',
    body: 'Hi Amy,\n\nJordan Blake talks about mobility work every week.' },
];

async function seed() {
  const store = require(ROOT + 'server/store');
  await new Promise((r) => setTimeout(r, parseInt(process.env.INIT_WAIT_MS, 10) || 6000));
  const P = store.pool;
  const { seedDemo } = require(ROOT + 'server/scripts/seedDemo');
  const demo = await seedDemo(P);
  const agentId = (demo && demo.agentId) || (await P.query(`SELECT id FROM users WHERE email = 'demo@comptongroupllc.com'`)).rows[0].id;
  // A business address, so Home does not open on the address prompt, and the
  // assistant left closed, so the picture is Home itself.
  await P.query(`UPDATE users SET business_street = '100 Demo Way', business_city = 'Marietta', business_state = 'GA', business_zip = '30060' WHERE id = $1`, [agentId]).catch((e) => console.warn('address: ' + e.message));
  await P.query(`UPDATE users SET assistant_autoopen_off = TRUE WHERE id = $1`, [agentId]).catch((e) => console.warn('assistant: ' + e.message));
  const ath = (await P.query(`SELECT id FROM athletes WHERE agent_id = $1 AND data->>'name' = 'Jordan Blake'`, [agentId])).rows[0];
  if (!ath) throw new Error('the demo seed has no Jordan Blake');
  // A connected mailbox on a reserved address, so the card shows who it sends
  // from. No tokens: nothing can actually send from it.
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status) VALUES ('demo-shot-mailbox', $1, 'gmail', 'agent@demoagency.example', 'active')
                 ON CONFLICT DO NOTHING`, [agentId]).catch((e) => console.warn('mailbox: ' + e.message));
  // A date of birth on every demo athlete, so Home does not hold the cards for
  // a missing age.
  await P.query(`UPDATE athletes SET data = data || '{"dob":"2005-02-14"}'::jsonb WHERE agent_id = $1`, [agentId]);
  const JOB = require(ROOT + 'server/jobs/outreachQueue');
  let slot = 1;
  for (const c of CARDS) {
    await P.query(`INSERT INTO email_verification (email, result, detail, source, status, checked_at) VALUES ($1, 'valid', 'demo', 'demo', 'valid', NOW())
                   ON CONFLICT DO NOTHING`, [c.email]).catch((e) => console.warn('verify row: ' + e.message));
    const ok = await JOB.insertCard(P, { agentId, athleteId: ath.id, slot: slot++, card: {
      brandKey: c.key, brandName: c.brand, why: c.why, contactName: c.name, contactTitle: c.title, greetName: c.name.split(' ')[0],
      email: c.email, emailKind: 'person', emailTier: 1, channel: 'email', subject: `Jordan Blake x ${c.brand}`,
      emailBody: c.body, lane: 'local', athleteName: 'Jordan Blake' } });
    if (!ok) throw new Error('card not written: ' + c.brand);
  }
  await P.query(`UPDATE outreach_queue SET email_verified = TRUE WHERE agent_id = $1`, [agentId]).catch(() => {});
  console.log(`seeded ${CARDS.length} fictional cards for the demo's Jordan Blake`);
}

async function shoot() {
  // No real keys: a dummy mail key (the server will not boot without one) and
  // none for the paid providers, so nothing can be sent or bought.
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'development', SESSION_SECRET: 'home-screenshot',
    RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '' };
  for (const k of ['ANTHROPIC_API_KEY', 'OUTREACH_QUEUE_ENABLED', 'HUNTER_API_KEY', 'GOOGLE_PLACES_API_KEY']) delete env[k];
  const srv = spawn(process.execPath, [ROOT + 'server/index.js'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    const base = `http://localhost:${PORT}`;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(base + '/health')).ok) break; } catch (_) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    let pw;
    try { pw = require('playwright'); }
    catch (_) { pw = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); }
    const { chromium } = pw;
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const login = await page.request.post(base + '/api/auth/login', { data: { email: 'demo@comptongroupllc.com', password: 'NILDashDemo2026' } });
    if (!login.ok()) throw new Error('demo login failed: ' + login.status());
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#home-panel .hq-card', { timeout: 20000 });
    // Keep the picture to Home: no assistant bubble, no toasts.
    // Keep the picture to the morning's cards: no assistant, no toasts, no
    // Instagram connection line above them. The first card is opened.
    await page.addStyleTag({ content: '#nil-assistant,.toast,#toast,#home-ig-line{display:none!important}' });
    await page.click('#home-panel .hq-card .hq-rowtoggle').catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: OUT });
    await browser.close();
    console.log('wrote ' + OUT);
  } finally { srv.kill(); }
}

seed().then(shoot).then(() => process.exit(0)).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
