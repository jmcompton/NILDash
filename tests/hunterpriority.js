'use strict';
// ── HUNTER_PRIORITY_AGENTS: listed agents reach tonight's Hunter credits first ──
// Pure: no database, no network.
const path = require('path');
const HPr = require(path.join(__dirname, '..', 'server', 'services', 'hunterPriority'));
let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (info ? ' ' + JSON.stringify(info) : '')); } };

const agents = [
  { id: 'u1', name: 'Early Signup', email: 'early@x.test' },
  { id: 'u2', name: 'Pat  Paying', email: 'pat@pay.test' },
  { id: 'u3', name: 'Other Agent', email: 'other@x.test' },
  { id: 'u4', name: 'Greg Partner', email: 'greg@partner.test' },
];
const list = HPr.priorityList('pat@pay.test, greg partner , nobody@x.test');
ok('the list is read case-insensitively, trimmed, spaces collapsed', JSON.stringify(list) === JSON.stringify(['pat@pay.test', 'greg partner', 'nobody@x.test']), list);
const s = HPr.split(agents, list);
ok('listed agents run first, in list order, by email or full name', s.first.map((a) => a.id).join() === 'u2,u4', s.first.map((a) => a.id));
ok('everyone else keeps signup order after them', s.rest.map((a) => a.id).join() === 'u1,u3', s.rest.map((a) => a.id));
ok('a name matches the whole name, not part of it', HPr.rankOf({ name: 'Greg Partnership' }, ['greg partner']) === -1);
ok('extra spaces and case in the stored name still match', HPr.rankOf({ name: '  PAT paying ' }, ['pat paying']) === 0);
const none = HPr.split(agents, HPr.priorityList(''));
ok('unset: nobody is first and the order is unchanged', none.first.length === 0 && none.rest.map((a) => a.id).join() === 'u1,u2,u3,u4');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
