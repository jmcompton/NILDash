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
// Six fixes to the home page. The ranking is exercised by running the SHIPPED sort
// over synthesised items, not by reading the priority numbers and agreeing with them.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');
const IDX = fs.readFileSync(R + 'public/index.html', 'utf8');
const ONB = fs.readFileSync(R + 'public/onboarding.js', 'utf8');
const code = (s) => s.replace(/^\s*\/\/.*$/gm, '');

console.log('-- 1. THERE IS EXACTLY ONE ASSISTANT CONTROL --');
{
  ok('help.js is deleted', !fs.existsSync(R + 'public/help.js'));
  ok('nothing loads it', !/help\.js/.test(IDX));
  ok('and nothing references it', !fs.readdirSync(R + 'public')
    .filter((x) => x.endsWith('.js'))
    .some((x) => /help\.js|assistant-btn|assistant-panel/.test(fs.readFileSync(R + 'public/' + x, 'utf8'))),
    fs.readdirSync(R + 'public').filter((x) => x.endsWith('.js')
      && /assistant-btn/.test(fs.readFileSync(R + 'public/' + x, 'utf8'))));

  // NOTHING ELSE may mount a fixed circular control in that corner. This is the
  // check that would have caught it: the old one hid in a file called help.js and
  // was invisible to a search for "assistant".
  const offenders = [];
  for (const file of fs.readdirSync(R + 'public').filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(R + 'public/' + file, 'utf8');
    for (const m of src.matchAll(/position:fixed;[^'"`]*/g)) {
      const rule = m[0];
      if (/border-radius:\s*50%/.test(rule) && /bottom:/.test(rule) && /right:/.test(rule)) {
        offenders.push(file + ' :: ' + rule.slice(0, 60));
      }
    }
  }
  ok('no file mounts a round fixed button in the bottom-right corner', offenders.length === 0, offenders);
  ok('the docked tab is the one control, and it is not a circle',
    /#na-tab\{position:fixed/.test(fs.readFileSync(R + 'public/assistant.js', 'utf8'))
    && /border-radius:10px 0 0 10px/.test(fs.readFileSync(R + 'public/assistant.js', 'utf8')));
}

console.log('\n-- 2. GETTING STARTED IS GONE FROM HOME --');
{
  ok('the mount point is removed', !/home-checklist-anchor/.test(IDX));
  // Removing the anchor ALONE was not enough: the renderer fell back to appending
  // onto the home view, so the card would have moved rather than gone.
  ok('the renderer returns before building anything',
    /function renderChecklist\(\) \{[\s\S]{0,900}?return;/.test(ONB));
  const body = ONB.slice(ONB.indexOf('function renderChecklist()'));
  const upToReturn = body.slice(0, body.indexOf('return;'));
  ok('and it cleans up any card already on screen', /nil-getting-started[\s\S]{0,80}remove\(\)/.test(upToReturn));
  ok('the fallback that appended onto home is now unreachable',
    upToReturn.indexOf('home.appendChild') === -1);
}

console.log('\n-- 5. THE RANKING, RUN RATHER THAN READ --');
{
  // END ANCHOR CHOSEN BY POSITION, not by name: home-metrics is defined EARLIER in
  // the file than /today, so slicing between them gave a backwards range and an
  // empty string, and every assertion below would have been measuring ''.
  const start = SRV.indexOf("app.get('/api/agent/today'");
  const after = SRV.indexOf("app.get('/api/", start + 10);
  const blk = SRV.slice(start, after === -1 ? SRV.length : after);
  if (!/raw\.push/.test(blk) || blk.length < 2000) {
    console.log('FIXTURE BROKEN: lifted ' + blk.length + ' chars for /today. Aborting.');
    process.exit(1);
  }
  const sortSrc = /raw\.sort\((.*?)\);/.exec(code(blk));
  ok('there is one sort', !!sortSrc, sortSrc && sortSrc[0]);
  const sorter = new Function('return ' + sortSrc[1])();

  // Priorities, read from the shipped source so the test cannot drift.
  const pri = {};
  for (const m of blk.matchAll(/priority: ([^,]+), kind: '([a-z_]+)'/g)) pri[m[2]] = m[1].trim();
  // ONE TIER FOR EVERY STALE DEAL. Two tiers put the deliverables between them, so
  // a deal cold for 118 days sorted behind one cold for 64 and fell off a six-row
  // list. Coldness ranks; reachability only picks the card.
  ok('every stale deal shares one priority', pri.stale_deal === '0', pri.stale_deal);
  ok('an overdue deliverable sits below them all', pri.deliverable_due === '1', pri.deliverable_due);
  ok('reachability is carried as data, not baked into the priority',
    /kind: 'stale_deal', days, reachable,/.test(blk));

  const leadSrc = /const leadIdx = raw\.findIndex\((.*?)\);/.exec(code(blk));
  ok('there is a lead promotion', !!leadSrc, leadSrc && leadSrc[0]);
  const leadFn = new Function('return ' + leadSrc[1])();
  const rank = (arr) => {
    arr.sort(sorter);
    const i = arr.findIndex(leadFn);
    if (i > 0) arr.unshift(arr.splice(i, 1)[0]);
    return arr;
  };
  const mk = (kind, days, reachable) => ({
    kind, days, reachable: !!reachable,
    priority: kind === 'stale_deal' ? 0 : Number(pri[kind]),
  });

  // THE CASE THAT WAS WRONG: 35 deliverables overdue for months beat a deal that
  // went cold at 118 days, because deliverable_due was priority 0 unconditionally.
  let items = rank([mk('deliverable_due'), mk('stale_deal', 118, true)]);
  ok('the 118-day cold deal comes first', items[0].kind === 'stale_deal', items.map((x) => x.kind));

  // THE REGRESSION: the coldest deal on the board disappeared past the six-row cap
  // because warmer reachable deals AND every deliverable outranked it.
  items = rank([
    mk('stale_deal', 95, true), mk('stale_deal', 90, true), mk('stale_deal', 118, false),
    mk('stale_deal', 64, true), mk('deliverable_due'), mk('deliverable_due'),
    mk('deliverable_due'), mk('deliverable_due'), mk('deliverable_due')]);
  ok('the card takes the coldest deal it can act on', items[0].days === 95 && items[0].reachable,
    { days: items[0].days, reachable: items[0].reachable });
  ok('and the COLDEST deal is the first row of the list', items[1].days === 118, items[1].days);
  ok('so it is visible inside a six-row list',
    items.slice(1, 7).some((x) => x.days === 118), items.slice(1, 7).map((x) => x.days));
  ok('the rest stay in coldness order',
    items.slice(1).filter((x) => x.kind === 'stale_deal').map((x) => x.days).join(',') === '118,90,64',
    items.slice(1).filter((x) => x.kind === 'stale_deal').map((x) => x.days));
  ok('deliverables still sit below every stale deal',
    items.findIndex((x) => x.kind === 'deliverable_due')
      > items.map((x) => x.kind).lastIndexOf('stale_deal'), items.map((x) => x.kind));

  // With nothing reachable, the coldest simply leads and nothing is promoted.
  items = rank([mk('stale_deal', 40, false), mk('stale_deal', 118, false), mk('deliverable_due')]);
  ok('with no reachable deal the coldest takes the card', items[0].days === 118, items.map((x) => x.days));
  ok('and no phantom promotion reorders anything',
    items.map((x) => x.kind).join(',') === 'stale_deal,stale_deal,deliverable_due', items.map((x) => x.kind));

  // A single reachable deal must not be moved onto itself or duplicated.
  items = rank([mk('stale_deal', 50, true), mk('deliverable_due')]);
  ok('a lead already at the front is left alone', items.length === 2 && items[0].days === 50,
    items.map((x) => x.kind));

  // The tie-break used to read _days, which only stale_scan ever set, so ties fell
  // back to insertion order.
  items = [mk('stale_deal', 30, true), mk('stale_deal', 118, true), mk('stale_deal', 74, true)];
  items.sort(sorter);
  ok('within a tier the coldest leads', items.map((x) => x.days).join(',') === '118,74,30',
    items.map((x) => x.days));
  ok('the tie-break reads the public days field', /b\.days \|\| 0/.test(sortSrc[1]), sortSrc[1]);
  ok('_days is gone entirely', !/_days/.test(blk));

  // The whole ladder still orders sensibly.
  const ladder = ['stale_deal', 'deliverable_due', 'inquiry', 'kit_view', 'deliverables_week',
    'never_scanned', 'stale_scan'];
  const shuffled = ladder.map((k) => mk(k, 1, k === 'stale_deal')).reverse();
  shuffled.sort(sorter);
  ok('the full ladder sorts as intended', shuffled[0].kind === 'stale_deal'
    && shuffled[1].kind === 'deliverable_due' && shuffled[shuffled.length - 1].kind === 'stale_scan',
    shuffled.map((x) => x.kind));

  console.log('\n-- and the list reports its true size --');
  ok('the cap is the caller\'s', /parseInt\(req\.query\.limit, 10\) \|\| 5/.test(blk));
  ok('the response carries the FULL count, so "see all N" is not a guess',
    /total: raw\.length/.test(blk));
  ok('two-line kinds carry a title', /kind: 'stale_deal'[\s\S]{0,200}title: d\.brand/.test(blk));
  ok('and the athlete as the subtitle', /kind: 'stale_deal'[\s\S]{0,220}subtitle: d\.athleteName/.test(blk));
  // A deliverable has no day-count column, so its sentence is not the duplicated one.
  ok('a deliverable keeps its sentence, which carries the count',
    !/kind: 'deliverable_due',\s*\n\s*title:/.test(blk));
}

console.log('\n-- REACHABILITY IS READ FROM WHERE CONTACTS ACTUALLY LIVE --');
{
  const start = SRV.indexOf("app.get('/api/agent/today'");
  const after = SRV.indexOf("app.get('/api/", start + 10);
  const blk = SRV.slice(start, after === -1 ? SRV.length : after);

  // The gate existed but could never open: extractDealContact reads deal.contacts
  // and deal.contactEmail, and NOTHING in the codebase writes either onto a deal.
  const writers = [];
  for (const file of ['server/index.js', 'public/index.html', 'public/outreach-engine.js', 'public/pipeline.js']) {
    const src = fs.readFileSync(R + file, 'utf8');
    for (const m of src.matchAll(/(contactEmail|contactName|contacts)\s*:/g)) {
      const around = src.slice(Math.max(0, m.index - 120), m.index + 60);
      // Reading them back out, or passing them to a view, is not writing them ONTO
      // a deal. Only a saveDeal/POST body counts.
      if (/saveDeal|body:|JSON\.stringify\(\{[^}]*stage/.test(around)) writers.push(file + ': ' + around.slice(-70));
    }
  }
  ok('still nothing writes a contact onto a deal', writers.length === 0, writers);
  ok('so the deal-JSON check alone would never fire', /!!dc\.contactEmail \|\|/.test(blk));

  ok('brand_contacts is queried for this agent', /FROM brand_contacts[\s\S]{0,120}agent_id = \$1/.test(blk));
  ok('and only rows that actually have an email', /COALESCE\(email,''\) <> ''/.test(blk));
  ok('matched case-insensitively on brand name', /LOWER\(brand_name\) AS brand/.test(blk));
  ok('the result becomes a lookup set', /const REACHABLE_BRANDS = new Set\(/.test(blk));
  ok('and the set is built before the stale-deal loop uses it',
    blk.indexOf('const REACHABLE_BRANDS') < blk.indexOf('REACHABLE_BRANDS.has('), null);
  ok('the brand is lowercased on the way in too', /REACHABLE_BRANDS\.has\(String\(d\.brand \|\| ''\)\.toLowerCase\(\)\)/.test(blk));
  ok('it is a soft query, so a missing table cannot blank the page',
    /softQuery\(\s*`SELECT DISTINCT LOWER\(brand_name\)/.test(blk));

  // The destructure must line up, or every row lands in the wrong variable.
  const destr = /const \[([^\]]+)\] = await Promise\.all/.exec(blk);
  ok('the destructure names the new binding', /reachR/.test(destr[1]), destr[1]);
  const names = destr[1].split(',').map((x) => x.trim());
  const bodies = [...blk.matchAll(/(?:store\.pool\.query|softQuery)\(/g)].length;
  ok('one binding per query', names.length === bodies, { names: names.length, queries: bodies });
  // RELATIVE, NOT A HARDCODED INDEX. Pinning names[8] broke the moment another
  // query was inserted ahead of it, reporting a correct destructure as wrong.
  // What matters is that each binding sits where its query does.
  ok('the mailbox binding precedes the reachability one',
    names.indexOf('mailR') === names.indexOf('reachR') - 1, names);
  ok('and reachability precedes the orphan one',
    names.indexOf('reachR') === names.indexOf('orphanR') - 1, names);
  ok('every binding is named exactly once', new Set(names).size === names.length, names);
}

console.log('\n-- GMAIL SURFACES WHERE AGENTS ACTUALLY ARE --');
{
  const start = SRV.indexOf("app.get('/api/agent/today'");
  const after = SRV.indexOf("app.get('/api/", start + 10);
  const blk = SRV.slice(start, after === -1 ? SRV.length : after);
  const clean = code(blk);

  console.log('  · the action, and what it outranks');
  ok('there is a no_mailbox action', /kind: 'no_mailbox'/.test(blk));
  ok('it outranks EVERYTHING, including a cold deal at priority 0',
    /priority: -1, kind: 'no_mailbox'/.test(blk));
  // Only once the work has started. Before a scan it is advice, not a blockage.
  ok('gated on having actually scanned', /if \(hasScanned && !mailboxes\)/.test(clean));
  ok('hasScanned comes from the per-athlete scan rows',
    /const hasScanned = \(scanR\.rows \|\| \[\]\)\.some\(\(r\) => r\.last_scan\)/.test(clean));
  ok('the mailbox count is its own query', /FROM email_accounts WHERE user_id = \$1/.test(blk));
  ok('and it is soft, so a missing table cannot blank the page',
    /softQuery\(`SELECT COUNT\(\*\)::int AS n FROM email_accounts/.test(blk));
  ok('the action leaves for OAuth rather than opening a tab',
    /connect: 'gmail'/.test(blk));

  console.log('  · and the lead promotion cannot jump over it');
  // The promotion moves the coldest reachable deal to the front for the card. Left
  // unguarded it would lift that deal over no_mailbox, which is the one thing that
  // must come first.
  ok('promotion only fires when a stale deal ALREADY leads',
    /leadIdx > 0 && raw\[0\] && raw\[0\]\.kind === 'stale_deal'/.test(clean));

  const sorter = new Function('return ' + /raw\.sort\((.*?)\);/.exec(clean)[1])();
  const leadFn = new Function('return ' + /const leadIdx = raw\.findIndex\((.*?)\);/.exec(clean)[1])();
  const rank = (arr) => {
    arr.sort(sorter);
    const i = arr.findIndex(leadFn);
    if (i > 0 && arr[0] && arr[0].kind === 'stale_deal') arr.unshift(arr.splice(i, 1)[0]);
    return arr;
  };
  const mk = (kind, days, reachable) => ({ kind, days, reachable: !!reachable,
    priority: kind === 'no_mailbox' ? -1 : (kind === 'stale_deal' ? 0 : 1) });

  let items = rank([mk('stale_deal', 118, false), mk('stale_deal', 95, true),
    mk('no_mailbox'), mk('deliverable_due')]);
  ok('no_mailbox takes the card even against a reachable cold deal',
    items[0].kind === 'no_mailbox', items.map((x) => x.kind));
  ok('and the deals keep their own order behind it',
    items.slice(1).filter((x) => x.kind === 'stale_deal').map((x) => x.days).join(',') === '118,95',
    items.slice(1).filter((x) => x.kind === 'stale_deal').map((x) => x.days));

  // With a mailbox connected the promotion behaves exactly as before.
  items = rank([mk('stale_deal', 118, false), mk('stale_deal', 95, true), mk('deliverable_due')]);
  ok('with no no_mailbox item the card still prefers a reachable deal',
    items[0].days === 95 && items[0].reachable, items.map((x) => x.days));
  ok('and the coldest is still the first row', items[1].days === 118, items[1].days);

  console.log('  · the Deal Scan line');
  ok('the line exists above the results', IDX.indexOf('id="ds-mailbox-line"') < IDX.indexOf('id="scan-ranked-label"')
    && IDX.indexOf('id="ds-mailbox-line"') !== -1, null);
  ok('it says outreach sends from your own email', /Outreach sends from your own email\./.test(IDX));
  ok('with a connect link', /dsConnectGmail\(\); return false;/.test(IDX));
  // Not a banner and not dismissible: no close control, no background panel.
  const lineBlock = IDX.slice(IDX.indexOf('id="ds-mailbox-line"'), IDX.indexOf('id="scan-ranked-label"'));
  ok('it is one line, not a panel', !/background:/.test(lineBlock) && !/border:/.test(lineBlock), lineBlock.slice(0, 120));
  ok('and carries no dismiss control', !/dismiss|&times;|✕/i.test(lineBlock));
  ok('it is checked when the tab opens', /if \(id === 'deals'\)[^\n]*dsCheckMailboxLine\(\)/.test(IDX));
  ok('and again after every scan, so a second scan still shows it',
    /_dsRenderAll\(\);\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*dsCheckMailboxLine\(\);/.test(IDX));
  ok('an unknown answer hides it rather than nagging wrongly',
    /if \(!r\.ok\) \{ el\.style\.display = 'none'; return; \}/.test(IDX));
  ok('a connected mailbox hides it',
    /el\.style\.display = \(Array\.isArray\(list\) && list\.length\) \? 'none' : 'block'/.test(IDX));

  console.log('  · the momentum strip explains the zero it can explain');
  ok('the metrics endpoint reports whether a mailbox exists',
    /mailboxConnected: \(\(\(mailboxR\.rows \|\| \[\]\)\[0\] \|\| \{\}\)\.n \|\| 0\) > 0/.test(SRV));
  ok('the strip says WHY when the reason is known',
    /m\.mailboxConnected === false/.test(IDX));
  ok('and only when nothing has been sent', /if \(!sent && m && m\.mailboxConnected === false\)/.test(IDX));
  ok('it names the mailbox rather than repeating the zero',
    /No mailbox connected, so nothing can be sent/.test(IDX));
  ok('and offers the connect hop there too', /class="hm-connect"/.test(IDX));

  // The wizard is three steps now, not five: Gmail moved from step 4 to step 2
  // and the review and summary steps were cut. What this block protects is the
  // BEHAVIOUR, not the numbering -- connecting a mailbox must stay optional, and
  // an agent who skips it must still reach the end.
  console.log('  · connecting a mailbox is still optional');
  ok('the Gmail step is still skippable', /obSkipStep\(2\)/.test(IDX));
  ok('and still continues without connecting', /onclick="obStep\(3\)"/.test(IDX));
  ok('  and the wizard is three steps', /const OB_TOTAL\s*=\s*3;/.test(IDX));
  ok('the checklist was NOT rebuilt', !/home-checklist-anchor/.test(IDX));
}

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
