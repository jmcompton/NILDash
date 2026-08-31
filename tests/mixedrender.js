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
// THE PAGE, ACTUALLY RENDERED. The functions above are the real ones lifted out
// of index.html -- not a copy -- and driven with a real buildHome payload in a
// real browser. Assertions read out of the resulting DOM.
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Home = require(ROOT + 'server/services/homeQueue.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d !== undefined ? '   ' + d : '')); };

const AG = 'rnd-agent', ATH = 'rnd-ath';

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  for (const t of ['outreach_logs', 'outreach_queue', 'company_enrichment']) {
    await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [AG]).catch(() => {});
  }
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'A','r@x.com','x','agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH, AG, JSON.stringify({ name: 'Jeremiah Cole', school: 'Alabama', dob: '2004-06-01' })]);
  await P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email)
     VALUES ('r-1',$1,$2,'Trak Shak','Quick idea for Trak Shak',
             '<p>Hi there,</p><p>Trak Shak sponsors the local half marathon every spring.</p>','draft','jeff@trakshak.com')`,
    [AG, ATH]);
  await P.query(
    `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,why,
                                 dm_text,instagram,phone,phone_ask_for,sponsor_note)
     VALUES ($1,$2,1,'name:hoover cycles','Hoover Cycles','dm','queued',
             'Two miles from campus and already sponsors a cycling team.',
             'Hi — quick idea about working with a local athlete.','hoovercycles',NULL,NULL,
             'Named on the athletics department sponsor page.'),
            ($1,$2,2,'name:vestavia grill','Vestavia Grill','call','queued',
             'Family owned, backs the youth league.',
             NULL,NULL,'205-555-0100','Dana',NULL)`, [AG, ATH]);

  const payload = await Home.buildHome(P, AG, { athleteId: ATH });
  check('three channels in the payload', payload.cards.length === 3,
    JSON.stringify(payload.cards.map((c) => c.channel)));

  // Lift the REAL renderer out of the shipping page. Nothing here is a re-write:
  // if index.html changes, this test renders the change.
  const HTML = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
  const cut = (a, b) => HTML.slice(HTML.indexOf(a), HTML.indexOf(b));
  const js = cut('function hqEscape(s)', 'async function hqLoad')
    + cut('var HQ_CH = {', 'function hqRawId(')
    + cut('function hqCardAt(i)', 'function hqCopyDm(');
  const css = cut('.hq-chan{', '.hq-note{margin:6px');

  const page = `<!doctype html><meta charset="utf-8"><style>${css}</style>
<div id="cards"></div><script>
${js}
var HQ = { data: ${JSON.stringify(payload)} };
document.getElementById('cards').innerHTML =
  HQ.data.cards.map(function (c, i) { return hqRenderCard(c, i); }).join('');
document.title = 'OK';
</script>`;
  const f = '/tmp/mixedrender.html';
  fs.writeFileSync(f, page);
  const dom = execFileSync(CHROMIUM,
    ['--headless', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=3000',
      '--dump-dom', '--allow-file-access-from-files', 'file://' + f],
    { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });

  check('the page ran with no script error', /<title>OK<\/title>/.test(dom));

  // ONLY WHAT WAS RENDERED. --dump-dom returns the <script> element too, and the
  // renderer's own source contains every string this test looks for -- so
  // matching the whole document counts the code as though it were output.
  const cards = dom.slice(dom.indexOf('<div id="cards">'), dom.indexOf('<script>'));
  const n = (dom.match(/class="hq-card [a-z]+"/g) || []).length;
  check('three cards drew', n === 3, 'cards=' + n);

  // THE ORDER IS THE LADDER, and it is asserted rather than assumed. Both queue
  // cards reach a named human (a storefront handle; a number with "ask for
  // Dana"); the email draft has an address nobody has verified. So the two
  // reachable-2 cards come first and the email is last -- which is exactly the
  // behaviour the two reserved email slots exist to stop from becoming
  // "the email never appears at all".
  const order = payload.cards.map((c) => c.channel).join(',');
  check('the strongest-reach cards lead, the unverified email is last',
    order === 'dm,call,email', order);
  const iOf = (ch) => payload.cards.findIndex((c) => c.channel === ch);
  const DM = iOf('dm'), CALL = iOf('call'), MAIL = iOf('email');

  console.log('\nBADGES');
  check('the email card is badged', /hq-chan email">Email</.test(cards));
  check('the DM card is badged', /hq-chan dm">Instagram DM</.test(cards));
  check('the call card is badged', /hq-chan call">Call</.test(cards));

  console.log('\nEACH CHANNEL CARRIES ITS OWN ACTION');
  check('the DM card has the copy-and-open button', /Copy DM &amp; open Instagram/.test(cards));
  check('  wired to the card position, not a quoted id',
    cards.indexOf('hqCopyDm(' + DM + ', this)') !== -1);
  check('  and the message is editable on the card',
    cards.indexOf('id="hq-dm-' + DM + '"') !== -1);
  check('  with the message in the box',
    new RegExp('id="hq-dm-' + DM + '"[^>]*>Hi — quick idea about working with a local athlete\\.').test(cards));
  check('the call card shows the number', /205-555-0100/.test(cards));
  check('  and who to ask for', /ask for Dana/.test(cards));
  check('  behind a tel: link that dials', /href="tel:2055550100"/.test(cards));
  check('the email card has NO per-card send',
    cards.indexOf('hqCardDone(' + MAIL + ',') === -1);
  check('  but does have the read-and-edit panel',
    cards.indexOf('id="hq-read-' + MAIL + '"') !== -1 && cards.indexOf('hqEdit(' + MAIL + ')') !== -1);
  check('every non-email card can be marked done', (cards.match(/hqCardDone\(/g) || []).length === 2);
  check('  and skipped', (cards.match(/hqCardSkip\(/g) || []).length === 2);
  check('the call card has no message box — there is no script, and none is faked',
    cards.indexOf('id="hq-dm-' + CALL + '"') === -1);

  console.log('\nWHAT THE CARD SAYS');
  check('the sponsor evidence is above the fold, not behind a click',
    /Named on the athletics department sponsor page\./.test(cards));
  check('the why sentence is on every card', (cards.match(/class="hq-why"/g) || []).length >= 3);
  check('the email body is still one click away, not open',
    cards.indexOf('class="hq-mail" id="hq-mail-' + MAIL + '" hidden') !== -1);
  check('no raw namespaced id leaked into a DOM id', !/id="[^"]*(email|queue):/.test(cards));
  check('and none into an inline handler', !/onclick="[^"]*(email|queue):/.test(cards));

  const failed = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - failed.length) + '/' + out.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
