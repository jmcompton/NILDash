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
// greetingGuard: name + email is NOT enough to greet someone by first name.
// The headline assertion is the exact fbf5865 case, run end to end through the
// shipped enforceGreeting rather than by inspecting the predicate.
const G = require(REPO + 'server/services/greetingGuard.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

// What the pipeline does: greetableContacts([contact]) -> enforceGreeting(body, greetable)
const ship = (contact, body) => {
  const greetable = G.greetableContacts([contact]);
  const r = G.enforceGreeting(body, greetable);
  return { greetable: greetable.length, kept: !r.changed, body: r.body, removed: r.removedName };
};

// ── THE fbf5865 CASE, exactly as recorded in the removal commit ─────────────
const HUNTER = {
  name: 'Dana Kessler',
  email: 'dana.kessler@example.com',
  title: 'Company contact (not confirmed owner)',
  source: 'hunter',
};
let r = ship(HUNTER, 'Dana,\n\nI represent a softball player at Auburn.');
ok('fbf5865: name + email + "Company contact (not confirmed owner)" -> NOT greetable', r.greetable === 0, r.greetable);
ok('fbf5865: the greeting is SUPPRESSED', r.kept === false, r);
ok('fbf5865: rewritten to "Hi,"', /^Hi,/.test(r.body), r.body.split('\n')[0]);
ok('fbf5865: and it reports whose name it removed', r.removed === 'Dana', r.removed);
ok('fbf5865: the body is otherwise untouched', /I represent a softball player at Auburn\./.test(r.body));
// The trap that makes ordering load-bearing: that title CONTAINS the word "owner".
ok('the placeholder is caught even though it contains "owner"', G.hasRoleTitle('Company contact (not confirmed owner)') === false);
ok('  a whitelist-first implementation would have passed it', /owner/i.test(HUNTER.title));

// ── the old rule really was name+email, and really is gone ─────────────────
ok('name + email alone is no longer sufficient',
  G.greetableContacts([{ name: 'Dana Kessler', email: 'd@x.com' }]).length === 0);

// ── real role titles STILL greet ───────────────────────────────────────────
const REAL = ['Owner', 'Co-Owner', 'Proprietor', 'Founder', 'CEO', 'President',
  'General Manager', 'Manager', 'Marketing Director', 'Marketing Manager',
  'Bookkeeper', 'Accountant', 'Office Manager', 'Head Chef', 'Managing Partner',
  'Brand Partnerships', 'Director of Operations', 'Franchisee', 'VP of Marketing',
  'Dentist', 'Attorney', 'Realtor', 'Barber', 'Head Trainer'];
for (const t of REAL) {
  const g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: t }, 'Dana,\n\nHello.');
  ok(`role title "${t}" still greets by first name`, g.greetable === 1 && g.kept === true, g);
}

// ── placeholders and absences never greet ──────────────────────────────────
const FAKE = [
  ['Company contact (not confirmed owner)', 'the fbf5865 string'],
  ['Business contact', 'generic company contact'],
  ['Primary contact', 'generic'],
  ['General inbox (no named contact)', 'a mailbox, not a person'],
  ['Generic inbox (no named contact)', 'contactDiscovery row 164'],
  ['Named mailbox', 'contactLadder row 313'],
  ['Business line', 'contactDiscovery row 161'],
  ['Contact form', 'contactLadder row 358'],
  ['No contact found yet', 'contactLadder row 388'],
  ['Staff', 'a role that is not a decision maker and names no job'],
  ['Team member', 'same'],
  ['Unknown', 'explicitly unknown'],
  ['Possible owner', 'hedged'],
  ['Owner (unconfirmed)', 'a real role word plus an explicit denial'],
  ['Unverified manager', 'same shape, different word'],
  ['Marketing / Partnerships', 'contactDiscovery fabricates this when the model gave no title'],
];
for (const [t, why] of FAKE) {
  const g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: t }, 'Dana,\n\nHello.');
  ok(`"${t}" does NOT greet (${why})`, g.greetable === 0 && g.kept === false, g);
}
for (const t of [null, undefined, '', '   ']) {
  const g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: t }, 'Dana,\n\nHello.');
  ok(`an absent title (${JSON.stringify(t)}) does NOT greet`, g.greetable === 0 && g.kept === false, g);
}

// ── the structured denials ─────────────────────────────────────────────────
let g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: 'Owner', affiliationScope: 'unclear' }, 'Dana,\n\nHi.');
ok('affiliationScope "unclear" blocks even a real Owner title', g.greetable === 0 && g.kept === false, g);
g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: 'Owner', affiliationScope: 'this-location' }, 'Dana,\n\nHi.');
ok('  scope "this-location" greets', g.greetable === 1 && g.kept === true, g);
g = ship({ name: 'Michael Skipworth', email: 'm@x.com', title: 'CEO', affiliationScope: 'parent-or-brand' }, 'Michael,\n\nHi.');
ok('  scope "parent-or-brand" still greets — a real person, verified, just at HQ', g.greetable === 1, g);

g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: 'Owner', emailKind: 'pattern' }, 'Dana,\n\nHi.');
ok('a pattern-matched address blocks the greeting', g.greetable === 0 && g.kept === false, g);
g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: 'Owner', emailKind: 'published' }, 'Dana,\n\nHi.');
ok('  a published address greets', g.greetable === 1 && g.kept === true, g);

// The discovery prompt is allowed to INFER info@theirdomain.com at confidence 0.4.
g = ship({ name: 'Dana Kessler', email: 'info@x.com', title: 'Owner', source: 'ai_inference', confidence_score: 0.4 }, 'Dana,\n\nHi.');
ok('an ai_inference contact does NOT greet', g.greetable === 0 && g.kept === false, g);
g = ship({ name: 'Dana Kessler', email: 'info@x.com', title: 'Owner', source: 'company_website', confidence_score: 0.4 }, 'Dana,\n\nHi.');
ok('an inferred-format address (0.4) does NOT greet', g.greetable === 0 && g.kept === false, g);
g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: 'Owner', source: 'company_website', confidence_score: 0.85 }, 'Dana,\n\nHi.');
ok('  a real address found on their site (0.85) greets', g.greetable === 1 && g.kept === true, g);
g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: 'Owner', source: 'company_website', confidence_score: '0.85' }, 'Dana,\n\nHi.');
ok('  confidence arriving as a NUMERIC string still greets', g.greetable === 1 && g.kept === true, g);
g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: 'Owner', source: 'company_website', confidence_score: '0.40' }, 'Dana,\n\nHi.');
ok('  and a numeric string below the bar does not', g.greetable === 0, g);

// A legacy row carrying none of the new fields behaves as before.
g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: 'Owner' }, 'Dana,\n\nHi.');
ok('a legacy row with a real title and no new fields still greets', g.greetable === 1 && g.kept === true, g);

// ── nothing else regressed ─────────────────────────────────────────────────
g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: 'Owner' }, 'Hi,\n\nNo name here.');
ok('a body that greets nobody is left alone', g.kept === true, g);
g = ship({ name: 'Dana Kessler', email: 'd@x.com', title: 'Owner' }, 'Dawn,\n\nWrong person.');
ok('a name that is NOT the contact is still suppressed', g.kept === false && g.removed === 'Dawn', g);
g = ship({ name: 'Dr. Dawn Mercer', email: 'd@x.com', title: 'Chiropractor' }, 'Dr. Dawn,\n\nHi.');
ok('the honorific case still works', g.kept === true, g);
g = ship({ name: 'Dr. Dawn Mercer', email: 'd@x.com', title: 'Chiropractor' }, 'Dr.,\n\nHi.');
ok('a bare honorific is still suppressed', g.kept === false, g);
ok('enforceGreeting with NO greetable contacts suppresses any name',
  G.enforceGreeting('Dana,\n\nHi.', []).changed === true);
ok('allowedGreetingNames is unchanged',
  G.allowedGreetingNames([{ name: 'Dana Kessler' }]).has('dana'));
ok('salutationName is unchanged', G.salutationName('Dr. Dawn Mercer') === 'Dr. Mercer');

// HTML path uses the same greetable list.
const gh = G.enforceGreetingHtml('<div>Dana,</div><div>Body.</div>', G.greetableContacts([HUNTER]));
ok('the HTML path suppresses the fbf5865 case too', gh.changed === true && /Hi,/.test(gh.html), gh);

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
