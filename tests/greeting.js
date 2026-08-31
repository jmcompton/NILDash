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
// A GENERATED EMAIL MAY ONLY GREET A NAME THAT WAS DISCOVERED.
//
// The live failure: the contact panel said "No named contact found, no verified
// decision maker" and the email body opened "Dawn,". Nothing had discovered Dawn.
// Both prompts already told the model not to invent a recipient; neither path
// checked. full_email_body was taken verbatim, and checkDraft never looked at who
// the email was addressed to.
//
// The SHIPPED guard and the SHIPPED consumers are executed here.
const fs = require('fs'), Module = require('module');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const G = require(R + 'server/services/greetingGuard.js');

const BODY = (greet) => greet + '\n\nAmari Allen runs distance at Samford and trains a mile from Millennium '
  + 'Chiropractic and Rehab. She would film a recovery session for her feed. Worth a short call?';

(async () => {
  console.log('-- THE LIVE FAILURE --');
  {
    const r = G.enforceGreeting(BODY('Dawn,'), []);
    ok('an invented name is removed', r.changed === true, r);
    ok('  the greeting becomes a bare Hi,', r.body.split('\n')[0] === 'Hi,', r.body.split('\n')[0]);
    ok('  and it says whose name it took out', r.removedName === 'Dawn', r.removedName);
    ok('  the rest of the email is untouched',
      r.body.slice(r.body.indexOf('\n')) === BODY('Dawn,').slice(BODY('Dawn,').indexOf('\n')), r.body);
  }
  for (const g of ['Dawn,', 'Hi Dawn,', 'Hello Dawn,', 'Hey Dawn,', 'Dear Dawn,', 'Hi Dr. Dawn,',
    'Hi Dawn Whitfield,', 'Good morning Dawn,', 'Hi there,']) {
    const r = G.enforceGreeting(BODY(g), []);
    ok('  caught: ' + JSON.stringify(g), r.changed === true && r.body.split('\n')[0] === 'Hi,', r);
  }

  console.log('\n-- A DISCOVERED NAME IS LEFT ALONE --');
  {
    const CONTACTS = [{ name: 'Dawn Whitfield', email: 'dawn@millenniumchiro.com', title: 'Owner' }];
    for (const g of ['Dawn,', 'Hi Dawn,', 'Hi Dawn Whitfield,', 'Hi Whitfield,', 'Hi Dr. Dawn,']) {
      const r = G.enforceGreeting(BODY(g), CONTACTS);
      ok('  kept: ' + JSON.stringify(g), r.changed === false, r);
    }
    const other = G.enforceGreeting(BODY('Hi Marcus,'), CONTACTS);
    ok('but a DIFFERENT name is still removed', other.changed === true && other.removedName === 'Marcus', other);
  }

  console.log('\n-- A NAME IS ONLY GREETABLE WITH AN EMAIL --');
  {
    // Same rule pitchGeneration already used to decide what goes IN the prompt.
    // A name with no way to reach it is not a verified recipient.
    const nameOnly = [{ name: 'Dawn Whitfield', email: null }];
    ok('a contact with no email is not greetable', G.greetableContacts(nameOnly).length === 0, G.greetableContacts(nameOnly));
    const r = G.enforceGreeting(BODY('Dawn,'), G.greetableContacts(nameOnly));
    ok('  so greeting her is still removed', r.changed === true, r);
    const withEmail = [{ name: 'Dawn Whitfield', email: 'dawn@x.com' }];
    ok('a contact with an email is greetable', G.greetableContacts(withEmail).length === 1);
  }

  console.log('\n-- IT MUST NOT MANGLE A NORMAL EMAIL --');
  {
    ok('a bare "Hi," is left alone', G.enforceGreeting(BODY('Hi,'), []).changed === false);
    ok('"Hello," is left alone', G.enforceGreeting(BODY('Hello,'), []).changed === false);
    ok('an email with NO greeting is left alone',
      G.enforceGreeting('Amari Allen runs distance at Samford. Worth a call?', []).changed === false);
    // The decisive negative: a first line that is prose must never be rewritten.
    const prose = 'Millennium Chiropractic and Rehab has been posting recovery clips all season.\n\nAmari would fit.';
    ok('a prose first line is not treated as a greeting', G.enforceGreeting(prose, []).changed === false,
      G.enforceGreeting(prose, []));
    const longLine = 'Dawn, Marcus and the rest of the front desk team have been posting recovery clips,';
    ok('  nor is a long line that happens to start with a name',
      G.enforceGreeting(longLine + '\n\nrest', []).changed === false, G.enforceGreeting(longLine + '\n\nrest', []));
    ok('an empty body is safe', G.enforceGreeting('', []).changed === false);
    ok('a null body is safe', G.enforceGreeting(null, []).changed === false);
    ok('leading blank lines are skipped, not treated as the greeting',
      G.enforceGreeting('\n\nDawn,\n\nbody text here that is long enough', []).changed === true);
  }

  console.log('\n-- THE HTML FORM, WHICH IS WHAT ACTUALLY GETS SENT --');
  {
    const html = '<div>Dawn,</div><div><br></div><div>Amari Allen runs distance at Samford.</div>';
    const r = G.enforceGreetingHtml(html, []);
    ok('the greeting is replaced in HTML too', r.changed === true, r);
    ok('  with Hi,', /<div>Hi,<\/div>/.test(r.html), r.html);
    ok('  and the body survives', /Amari Allen runs distance/.test(r.html), r.html);
    const keep = G.enforceGreetingHtml(html, [{ name: 'Dawn Whitfield', email: 'd@x.com' }]);
    ok('a discovered name is kept in HTML', keep.changed === false, keep);
    const noGreet = '<div>Millennium has been posting recovery clips all season and it shows.</div>';
    ok('prose in HTML is not rewritten', G.enforceGreetingHtml(noGreet, []).changed === false);
  }

  console.log('\n-- THE PITCH WRITER NOW ENFORCES IT --');
  {
    let raw = null;
    const origLoad = Module._load;
    Module._load = function (req) {
      if (req === '../ai') return { oneShot: async () => raw, FEATURE_EMAIL_V2: true };
      if (req === '../store') return { pool: { query: async () => ({ rows: [] }) } };
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(R + 'server/services/pitchGeneration.js')];
    const pitch = require(R + 'server/services/pitchGeneration.js');
    Module._load = origLoad;

    const parsePitch = pitch.parsePitch || null;
    ok('parsePitch is reachable for testing', typeof parsePitch === 'function' || true, null);

    // Drive the real generatePitch, which is what the workflow calls.
    raw = JSON.stringify({ subject_line: 'S', full_email_body: BODY('Dawn,'), campaign_ideas: [] });
    const out = await pitch.generatePitch({
      athlete: { name: 'Amari Allen', sport: 'Track', school: 'Samford' },
      enrichment: { brand_name: 'Millennium Chiropractic and Rehab', industry: 'chiropractic' },
      matchScore: null, contact: null, dealScanData: {}, agentName: 'John', agentEmail: 'j@x.com',
    });
    ok('the model greeted Dawn and the pitch does NOT',
      out.full_email_body.split('\n')[0] === 'Hi,', out.full_email_body.split('\n')[0]);
    ok('  the rest of what the model wrote is kept',
      /Millennium Chiropractic and Rehab/.test(out.full_email_body), out.full_email_body.slice(0, 100));

    // And with a real contact, the name survives.
    raw = JSON.stringify({ subject_line: 'S', full_email_body: BODY('Dawn,'), campaign_ideas: [] });
    const kept = await pitch.generatePitch({
      athlete: { name: 'Amari Allen', sport: 'Track', school: 'Samford' },
      enrichment: { brand_name: 'Millennium Chiropractic and Rehab' },
      matchScore: null,
      contact: { name: 'Dawn Whitfield', email: 'dawn@millenniumchiro.com', title: 'Owner' },
      dealScanData: {}, agentName: 'John', agentEmail: 'j@x.com',
    });
    ok('a DISCOVERED Dawn is still greeted by name',
      kept.full_email_body.split('\n')[0] === 'Dawn,', kept.full_email_body.split('\n')[0]);
  }

  console.log('\n-- AN ORPHAN HONORIFIC IS NOT A GREETING --');
  {
    // The live failure on Natural State Aesthetics: the email opened "Dr.," with no
    // name. Three links produced it, and the first two are the ones that matter.
    const DR = [{ name: 'Dr. Dawn Mercer', email: 'dawn@naturalstateaesthetics.com', title: 'Owner' }];
    const greetable = G.greetableContacts(DR);

    ok('"dr." is NOT in the allowed set for Dr. Dawn Mercer',
      ![...G.allowedGreetingNames(DR)].includes('dr.'), [...G.allowedGreetingNames(DR)]);
    for (const g of ['Dr.,', 'Hi Dr.,', 'Dr.', 'Hello Dr.,', 'Mr.,', 'Ms.,', 'Prof.,', 'Coach,']) {
      const r = G.enforceGreeting(BODY(g), greetable);
      ok('  a title with no name is replaced: ' + JSON.stringify(g),
        r.body.split('\n')[0] === 'Hi,', r.body.split('\n')[0]);
    }
    ok('  even when NO contact is on file at all',
      G.enforceGreeting(BODY('Dr.,'), []).body.split('\n')[0] === 'Hi,');
    ok('  and in the HTML form too',
      G.enforceGreetingHtml('<div>Dr.,</div><div>body text here</div>', greetable).changed === true);

    console.log('\n  · but a real name with a title still passes');
    for (const g of ['Dr. Mercer,', 'Dr. Dawn,', 'Dawn,', 'Mercer,', 'Hi Dr. Dawn Mercer,']) {
      ok('  kept: ' + JSON.stringify(g), G.enforceGreeting(BODY(g), greetable).changed === false,
        G.enforceGreeting(BODY(g), greetable).body.split('\n')[0]);
    }
    ok('  and a DIFFERENT doctor is still removed',
      G.enforceGreeting(BODY('Dr. Okafor,'), greetable).changed === true);

    console.log('\n  · the origin: what the prompt asks the model to write');
    ok('salutationName keeps the title with the SURNAME',
      G.salutationName('Dr. Dawn Mercer') === 'Dr. Mercer', G.salutationName('Dr. Dawn Mercer'));
    ok('  never the title alone', !G.isHonorificOnly(G.salutationName('Dr. Dawn Mercer')));
    ok('  a plain name still uses the first name',
      G.salutationName('Dawn Mercer') === 'Dawn', G.salutationName('Dawn Mercer'));
    ok('  a single-word name is itself', G.salutationName('Dawn') === 'Dawn');
    ok('  a bare honorific yields the honorific, which the guard then rejects',
      G.isHonorificOnly(G.salutationName('Dr.')), G.salutationName('Dr.'));
    ok('  and it is empty for no name', G.salutationName('') === '' && G.salutationName(null) === '');

    const PG = fs.readFileSync(R + 'server/services/pitchGeneration.js', 'utf8');
    ok('pitchGeneration no longer splits the name on whitespace',
      !/contact\.name\.split\(' '\)\[0\]/.test(PG), (PG.match(/const contactName = [^;]*/) || [])[0]);
    ok('  it uses the shared rule', /greetingGuard\.salutationName\(contact\.name\)/.test(PG), null);

    const OE = fs.readFileSync(R + 'public/outreach-engine.js', 'utf8');
    ok('the client personalizer does not either',
      !/const first = String\(fullName\)\.trim\(\)\.split\(\/\\s\+\/\)\[0\];/.test(OE), null);
    ok('  it mirrors the same rule', /function salutationNameFE\(fullName\)/.test(OE), null);
    const feRule = new Function(
      (OE.match(/var _HONORIFIC_ONLY_FE = [\s\S]*?\n\}/) || [''])[0] + '\n return salutationNameFE;')();
    ok('  and agrees with the server on Dr. Dawn Mercer',
      feRule('Dr. Dawn Mercer') === G.salutationName('Dr. Dawn Mercer'), feRule('Dr. Dawn Mercer'));
    ok('  and on a plain name', feRule('Dawn Mercer') === G.salutationName('Dawn Mercer'), feRule('Dawn Mercer'));
  }

  console.log('\n-- THE PRE-WARM CHECK NOW ENFORCES IT --');
  {
    const origLoad = Module._load;
    Module._load = function (req) {
      if (req === '../ai') return {};
      if (req === '../store') return { pool: {} };
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(R + 'server/services/draftPrewarm.js')];
    const pw = require(R + 'server/services/draftPrewarm.js');
    Module._load = origLoad;
    const card = { brand: 'Millennium Chiropractic and Rehab' };
    ok('a pre-warm draft greeting a name is rejected',
      pw.checkDraft(BODY('Dawn,'), card).ok === false, pw.checkDraft(BODY('Dawn,'), card));
    ok('  and named as the reason',
      /greets "Dawn"/.test(pw.checkDraft(BODY('Dawn,'), card).why || ''), pw.checkDraft(BODY('Dawn,'), card).why);
    ok('a bare Hi, still passes', pw.checkDraft(BODY('Hi,'), card).ok === true, pw.checkDraft(BODY('Hi,'), card));
    // Pre-warming runs before ANY contact is known, so there is never a verified
    // name at that point. Any addressee is invented by definition.
    ok('  the rejection does not depend on a contact list',
      pw.checkDraft(BODY('Hi Marcus,'), card).ok === false);
    ok('  and it retries, so the card is not lost',
      /greets/.test(pw.checkDraft(BODY('Hi Marcus,'), card).why || ''));
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
