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
// "No named contact found" on a pre-warmed modal. Pre-warming skips the contact
// ladder by design, so the modal opened instantly and immediately looked broken.
//
// The panel renderer and the lookup are pulled out of the shipped file and RUN
// against a fake DOM and a fake fetch, so what is tested is what ships.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const OE = fs.readFileSync(REPO + 'public/outreach-engine.js', 'utf8');
const IDX = fs.readFileSync(REPO + 'public/index.html', 'utf8');

// ── A DOM just real enough ───────────────────────────────────────────────────
// dataset is real, because "did the agent type this themselves" is now recorded
// there rather than inferred from the box being empty. Writing .value in a test is
// not typing, so a fixture that means "the agent typed it" must say so.
function mkDom() {
  const nodes = {
    'outreach-reach-body': { innerHTML: '' },
    'outreach-to-email': { value: '', dataset: {}, oninput: null },
    'outreach-to-pick': { innerHTML: '', value: '', style: {}, onchange: null, selectedIndex: 0 },
    'outreach-to-note': { textContent: '' },
    'outreach-body-input': { value: 'Hi,\n\nFixture Alvarez runs distance at State. Aurora Fitness draws the same crowd. She would film a block in your gym. Worth a call?' },
    'outreach-engine-modal': { style: { display: 'flex' } },
  };
  return { nodes, getElementById: (id) => nodes[id] || null };
}

// Brace-match a named function out of the shipped file.
function liftFn(sig) {
  const start = OE.indexOf(sig);
  if (start === -1) throw new Error('FIXTURE BROKEN: ' + sig);
  let d = 0, j = OE.indexOf('{', start), end = j;
  for (; j < OE.length; j++) { if (OE[j] === '{') d++; else if (OE[j] === '}') { d--; if (!d) { end = j; break; } } }
  return OE.slice(start, end + 1);
}

// A single shipped statement, for the const/var declarations a brace match cannot find.
function liftLine(sig) {
  const start = OE.indexOf(sig);
  if (start === -1) throw new Error('FIXTURE BROKEN: ' + sig);
  const end = OE.indexOf('\n', start);
  return OE.slice(start, end === -1 ? OE.length : end);
}

// Lift and RUN the shipped functions. This file used to reimplement
// resolvePersonalEmail and pickCardContact as local stubs and hand them a contact
// that already carried a name and an email -- so it asserted that a correct contact
// produces a correct recipient, which was never the part that was broken. The
// shipped ones are used now, including the recipient resolver.
function loadModule(dom, fetchImpl, state) {
  const from = OE.indexOf('function reachPanelInner');
  const to = OE.indexOf('// ── Attach media kit');
  const RECIP_FROM = OE.indexOf('// Mirror of the shared generic-inbox rule');
  const RECIP_TO = OE.indexOf('// ── Export');
  if (RECIP_FROM === -1 || RECIP_TO === -1 || RECIP_TO < RECIP_FROM) throw new Error('FIXTURE BROKEN: recipient block');
  const src = [
    liftFn('function escHtml(str) {'),
    liftFn('function pickCardContact(d) {'),
    liftFn('function _rankLikeLadder(contacts, ladder) {'),
    // personalizeGreeting no longer takes the first whitespace token; it defers to
    // salutationNameFE so "Dr. Dawn Mercer" greets "Dr. Mercer" and never "Dr.".
    // Lifted from the shipped file, not restated here, so a change to the rule
    // shows up in this suite.
    liftLine('var _HONORIFIC_ONLY_FE = '),
    liftFn('function salutationNameFE(fullName) {'),
    liftFn('function personalizeGreeting(fullName) {'),
    OE.slice(RECIP_FROM, RECIP_TO),
    OE.slice(from, to),
    // Observe the greeting without replacing it.
    'const _origGreet = personalizeGreeting;',
    'personalizeGreeting = function (n) { __greetings.push(n); return _origGreet(n); };',
  ].join('\n');
  const greetings = [];
  const mod = new Function(
    '__greetings', 'OutreachEngineState', 'document', 'fetch', 'window', 'console', 'API_BASE',
    src + '; return { reachPanelInner, ensureDeepContact, refreshReachPanel, applyFoundContact, retryContact, stillShowing, outreachRecipients, ladderRecipients, recipientNote, pickCardContact };'
  )(greetings, state, dom, fetchImpl, {}, { log: () => {}, warn: () => {} }, '');
  return { mod, greetings };
}

const NAMED = { name: 'Fixture Delacroix', title: 'Owner', email: 'fixture.delacroix@aurorafitness.example', phone: '217-555-0140' };

console.log('-- the three panel states are visibly different --');
{
  const dom = mkDom();
  const { mod } = loadModule(dom, async () => ({}), {});
  const looking = mod.reachPanelInner({ phone: '217-555-0100' }, 'looking');
  ok('LOOKING says it is finding someone', /Finding decision maker/.test(looking), looking.slice(0, 90));
  ok('and shows a spinner', /animation:outreachspin/.test(looking));
  ok('and does NOT claim there is nobody', !/No named contact found/.test(looking));
  ok('the main line is still shown while searching', /217-555-0100/.test(looking));

  const none = mod.reachPanelInner({ phone: '217-555-0100' }, 'none');
  ok('NONE says so plainly', /No named contact found/.test(none));
  ok('and says we actually searched', /We searched this business and could not find/.test(none));
  ok('and keeps the main line, exactly like today', /217-555-0100/.test(none) && /main line above is the way in/.test(none));
  ok('no spinner once it is over', !/animation:outreachspin/.test(none));

  const found = mod.reachPanelInner(NAMED, null);
  ok('FOUND shows the person', /Fixture Delacroix/.test(found) && /Owner/.test(found));
  ok('with their email', /fixture\.delacroix@aurorafitness\.example/.test(found));
  ok('and no "no contact" text', !/No named contact found/.test(found));

  console.log('\n-- a generic inbox is never dressed up as a person --');
  const generic = mod.reachPanelInner({ email: 'info@aurorafitness.example' }, 'none');
  ok('shown as General inbox', /General inbox/.test(generic));
  ok('and labelled as not a person', /general inbox, not a person/.test(generic));
  ok('never as a personal email in the accent colour',
    !/#84CC16">info@/.test(generic), generic.slice(0, 200));

  console.log('\n-- hostile contact data cannot break the panel --');
  const nasty = mod.reachPanelInner({ name: '<img src=x onerror=alert(1)>', title: '"><b>x', phone: '1<script>' }, null);
  ok('the name is escaped', !/<img/.test(nasty), nasty.slice(0, 120));
  ok('the title is escaped', !/<b>/.test(nasty));
  ok('the tel: href is stripped to digits', !/<script/.test(nasty), nasty.slice(0, 260));
}

console.log('\n-- REUSE: an already-expanded card does not run the ladder again --');
(async () => {
  for (const [label, card] of [
    ['_deepLoaded flag', { brand: 'Aurora Fitness', _deepLoaded: true, contacts: [NAMED] }],
    ['a contactLadder present', { brand: 'Aurora Fitness', contactLadder: { topTier: 1 }, contacts: [NAMED] }],
    ['a named contact present', { brand: 'Aurora Fitness', contacts: [NAMED] }],
  ]) {
    const dom = mkDom();
    let calls = 0;
    const { mod } = loadModule(dom, async () => { calls++; return { ok: true, json: async () => ({ results: [{}] }) }; },
      { currentDealResult: card });
    await mod.ensureDeepContact(card);
    ok(`no lookup when ${label}`, calls === 0, calls);
    ok(`  and the panel still shows the person (${label})`, /Fixture Delacroix/.test(dom.nodes['outreach-reach-body'].innerHTML));
  }

  console.log('\n-- a cold card DOES run it, once, and fills everything in --');
  {
    const dom = mkDom();
    let calls = 0; let body = null;
    const card = { brand: 'Aurora Fitness', website: 'https://aurorafitness.example', region: 'Springfield, IL', businessPhone: '217-555-0100' };
    const { mod, greetings } = loadModule(dom, async (url, opts) => {
      calls++; body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ results: [{ brand: 'Aurora Fitness', contacts: [NAMED], businessPhone: '217-555-0100', contactLadder: { topTier: 1 } }] }) };
    }, { currentDealResult: card });

    const p = mod.ensureDeepContact(card);
    ok('the panel shows the searching state IMMEDIATELY, before the reply',
      /Finding decision maker/.test(dom.nodes['outreach-reach-body'].innerHTML),
      dom.nodes['outreach-reach-body'].innerHTML.slice(0, 80));
    await p;

    ok('exactly one lookup', calls === 1, calls);
    ok('and it is the DEEP one', body && body.deep === true, body);
    ok('for exactly one brand, not all ten', body && body.brands.length === 1, body && body.brands.length);
    ok('the panel now shows the person', /Fixture Delacroix/.test(dom.nodes['outreach-reach-body'].innerHTML));
    ok('the greeting was swapped to the first name', greetings.length === 1 && greetings[0] === 'Fixture Delacroix', greetings);
    ok('and ONLY the greeting line changed',
      dom.nodes['outreach-body-input'].value.startsWith('Hi Fixture,\n')
      && /Aurora Fitness draws the same crowd/.test(dom.nodes['outreach-body-input'].value),
      dom.nodes['outreach-body-input'].value.slice(0, 60));
    ok('the To box was filled with the personal email',
      dom.nodes['outreach-to-email'].value === NAMED.email, dom.nodes['outreach-to-email'].value);
    ok('the card is marked so a second open reuses it', card._deepLoaded === true);
  }

  console.log('\n-- an address the agent typed is never overwritten --');
  {
    const dom = mkDom();
    dom.nodes['outreach-to-email'].value = 'owner@theyknewbetter.example';
    dom.nodes['outreach-to-email'].dataset.touched = '1';   // they typed it
    const card = { brand: 'Aurora Fitness' };
    const { mod } = loadModule(dom, async () => ({ ok: true, json: async () => ({ results: [{ contacts: [NAMED] }] }) }), { currentDealResult: card });
    await mod.ensureDeepContact(card);
    ok('their address survives', dom.nodes['outreach-to-email'].value === 'owner@theyknewbetter.example', dom.nodes['outreach-to-email'].value);
  }

  console.log('\n-- but a box the agent has NOT touched is filled in --');
  {
    const dom = mkDom();
    const card = { brand: 'Aurora Fitness' };
    const { mod } = loadModule(dom, async () => ({ ok: true, json: async () => ({ results: [{ contacts: [NAMED] }] }) }), { currentDealResult: card });
    await mod.ensureDeepContact(card);
    ok('the found address lands in the box', dom.nodes['outreach-to-email'].value === NAMED.email, dom.nodes['outreach-to-email'].value);
    ok('  and the note names who it is', /Fixture Delacroix/.test(dom.nodes['outreach-to-note'].textContent), dom.nodes['outreach-to-note'].textContent);
  }

  console.log('\n-- an edited greeting is never clobbered --');
  {
    const dom = mkDom();
    dom.nodes['outreach-body-input'].value = 'Hi Dana,\n\nAlready addressed by hand.';
    const card = { brand: 'Aurora Fitness' };
    const { mod } = loadModule(dom, async () => ({ ok: true, json: async () => ({ results: [{ contacts: [NAMED] }] }) }), { currentDealResult: card });
    await mod.ensureDeepContact(card);
    ok('the hand-written greeting stays', /^Hi Dana,/.test(dom.nodes['outreach-body-input'].value), dom.nodes['outreach-body-input'].value.slice(0, 30));
  }

  console.log('\n-- found nothing: say so, keep the main line --');
  {
    const dom = mkDom();
    const card = { brand: 'Aurora Fitness', businessPhone: '217-555-0100' };
    const { mod, greetings } = loadModule(dom, async () => ({ ok: true, json: async () => ({ results: [{ contacts: [], businessPhone: '217-555-0100' }] }) }), { currentDealResult: card });
    await mod.ensureDeepContact(card);
    const html = dom.nodes['outreach-reach-body'].innerHTML;
    ok('says it searched and found nobody', /We searched this business/.test(html));
    ok('keeps the main line', /217-555-0100/.test(html));
    ok('no greeting change', greetings.length === 0, greetings);
    // A phone is not an email. With no address of any kind there is nothing to
    // prefill, and inventing one would be worse than an empty box.
    ok('and the To box stays empty, because no address was found at all',
      dom.nodes['outreach-to-email'].value === '', dom.nodes['outreach-to-email'].value);
  }

  console.log('\n-- a general inbox IS offered, and never as a person --');
  {
    // CHANGED DELIBERATELY. This used to be withheld: resolvePersonalEmail returns
    // null for info@, so the To box stayed empty even though the only route in was
    // sitting right there on the card. It is pre-filled now, and labelled.
    const dom = mkDom();
    const card = { brand: 'Aurora Fitness' };
    const { mod, greetings } = loadModule(dom, async () => ({ ok: true,
      json: async () => ({ results: [{ contacts: [], genericInbox: 'info@aurorafitness.example', businessPhone: '217-555-0100' }] }) }),
      { currentDealResult: card });
    await mod.ensureDeepContact(card);
    ok('the general inbox is pre-filled', dom.nodes['outreach-to-email'].value === 'info@aurorafitness.example',
      dom.nodes['outreach-to-email'].value);
    ok('  labelled as a general inbox', /general inbox/i.test(dom.nodes['outreach-to-note'].textContent),
      dom.nodes['outreach-to-note'].textContent);
    ok('  and explicitly not a named person', /not a named person/i.test(dom.nodes['outreach-to-note'].textContent),
      dom.nodes['outreach-to-note'].textContent);
    ok('  nobody is greeted by name', greetings.length === 0, greetings);
    ok('  the reach panel still refuses to call it a person',
      !/Fixture/.test(dom.nodes['outreach-reach-body'].innerHTML)
      && /General inbox|No named contact/.test(dom.nodes['outreach-reach-body'].innerHTML),
      dom.nodes['outreach-reach-body'].innerHTML.slice(0, 140));
  }

  console.log('\n-- the ladder decides who leads, not the fan-out order --');
  {
    const dom = mkDom();
    const { mod } = loadModule(dom, async () => ({}), {});
    const LADDER = {
      tiers: [
        { tier: 1, label: 'Owner', rows: [{ name: 'Dana Kessler', title: 'Owner', email: 'dana@x.example', confidence: 'Confident' }] },
        { tier: 2, label: 'GM', rows: [{ name: 'Marcus Webb', title: 'General Manager', email: null, confidence: 'Confident', reachVia: 'Main line, ask for Marcus' }] },
        { tier: 3, label: 'Business channels', rows: [{ name: null, title: 'General inbox', email: 'info@x.example', confidence: 'Fallback' }] },
      ],
    };
    const card = { brand: 'X', contactLadder: LADDER,
      contacts: [{ name: 'Marcus Webb', title: 'General Manager', email: null }, { name: 'Dana Kessler', title: 'Owner', email: 'dana@x.example' }] };
    const recips = mod.outreachRecipients(card, null);
    ok('only the emailable rows are recipients', recips.length === 2, recips.map((r) => r.email));
    ok('  the Confident owner leads', recips[0].email === 'dana@x.example', recips[0]);
    ok('  the Fallback inbox is last', recips[1].confidence === 'Fallback', recips[1]);
    ok('  a row reachable only by the main line is not a recipient',
      !recips.some((r) => r.name === 'Marcus Webb'), recips);
    ok('the reach panel leads with the owner, not the first raw contact',
      mod.pickCardContact(card).name === 'Dana Kessler', mod.pickCardContact(card));
  }

  console.log('\n-- a FAILED search is not reported as an empty one --');
  {
    const dom = mkDom();
    const card = { brand: 'Aurora Fitness', businessPhone: '217-555-0100' };
    const { mod } = loadModule(dom, async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }), { currentDealResult: card });
    await mod.ensureDeepContact(card);
    const html = dom.nodes['outreach-reach-body'].innerHTML;
    ok('it does NOT claim there is nobody', !/We searched this business/.test(html), html.slice(0, 200));
    ok('it says the search did not complete', /did not complete/.test(html));
    ok('and offers a retry', /retryContact/.test(html));
    ok('the main line is still there', /217-555-0100/.test(html));
  }
  {
    const dom = mkDom();
    const card = { brand: 'Aurora Fitness' };
    const { mod } = loadModule(dom, async () => { throw new Error('network'); }, { currentDealResult: card });
    await mod.ensureDeepContact(card);
    ok('a thrown fetch lands in the same place', /did not complete/.test(dom.nodes['outreach-reach-body'].innerHTML));
    ok('and the card is left retryable, not marked done', card._deepLoaded !== true && card._deepLoading === false);
  }

  console.log('\n-- a late reply cannot paint the wrong business --');
  {
    const dom = mkDom();
    const cardA = { brand: 'Aurora Fitness' };
    const cardB = { brand: 'Borealis Coffee' };
    const state = { currentDealResult: cardA };
    let release;
    const { mod, greetings } = loadModule(dom, async () => {
      await new Promise((r) => { release = r; });
      return { ok: true, json: async () => ({ results: [{ contacts: [NAMED] }] }) };
    }, state);
    const p = mod.ensureDeepContact(cardA);
    state.currentDealResult = cardB;          // the agent moved on
    release();
    await p;
    ok('the panel was not repainted for the other business',
      !/Fixture Delacroix/.test(dom.nodes['outreach-reach-body'].innerHTML),
      dom.nodes['outreach-reach-body'].innerHTML.slice(0, 80));
    ok('and no greeting was swapped', greetings.length === 0, greetings);
  }
  {
    const dom = mkDom();
    dom.nodes['outreach-engine-modal'].style.display = 'none';   // modal closed
    const card = { brand: 'Aurora Fitness' };
    const { mod, greetings } = loadModule(dom, async () => ({ ok: true, json: async () => ({ results: [{ contacts: [NAMED] }] }) }), { currentDealResult: card });
    await mod.ensureDeepContact(card);
    ok('a closed modal is not painted into', greetings.length === 0, greetings);
  }

  console.log('\n-- wiring --');
  ok('the lookup fires from the PRE-WARMED path', /ensureDeepContact\(dealResult\);/.test(OE));
  {
    // Never on the /run path: that workflow does its own contact discovery -- and
    // now that a bare business phone no longer counts as "already supplied", it
    // really does run the fan-out, so firing the client lookup too would pay twice
    // for the same six searches.
    //
    // Comments are stripped first. The code deliberately explains WHY it does not
    // call ensureDeepContact here, and a regex over raw source cannot tell a
    // reference in prose from a call.
    const CODE = OE.replace(/^\s*\/\/.*$/gm, '');
    const gen = CODE.slice(CODE.indexOf('async function generateOutreach'), CODE.indexOf('function cardContacts'));
    const runAt = gen.indexOf("outreachAPI.post('/run'");
    const after = gen.slice(runAt);
    ok('and NOT on the /run path', !/ensureDeepContact\s*\(/.test(after), after.slice(0, 160));
  }
  ok('the card expand marks the ladder as run', /d\._deepLoaded = true;/.test(IDX));
  ok('so the modal can tell a deep run from the cheap fan-out',
    /_contactsLoaded is set by the CHEAP fan-out too/.test(IDX));
  ok('the modal pushes its result back onto the card', /window\._dsRefreshContactSlot/.test(IDX) && /_dsRefreshContactSlot/.test(OE));
  ok('retry is exported', /retryContact,/.test(OE));

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})();
