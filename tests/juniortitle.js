'use strict';
// No database needed.
//
//   node tests/juniortitle.js
//
// ── A JUNIOR MANAGER IS NOT THE DECISION MAKER ──────────────────────────────
// Cypress cards named a service manager and an assistant store manager as the
// person who signs. titleProblem refuses them on both sides (campusQuality's
// refusedTitle for universities, the outreach queue for agents).
const path = require('path');
const O = require(path.join(__dirname, '..', 'server/services/ownerNameSearch.js'));
const CQ = require(path.join(__dirname, '..', 'server/services/campusQuality.js'));

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

for (const t of ['Service Manager', 'Assistant Store Manager', 'Assistant Manager', 'Asst. General Manager', 'Co-Manager', 'Shift Lead',
  'Shift Supervisor', 'Office Manager', 'Parts Manager', 'Key Holder', 'Service Advisor', 'Front of House Manager', 'Team Lead', 'Kitchen Manager']) {
  ok(`refused: ${t}`, !!O.titleProblem(t));
}
for (const t of ['Owner', 'Store Manager', 'General Manager', 'Owner & Service Manager', 'Franchisee', 'Marketing Manager', 'Branch Manager',
  'Founder', 'Managing Partner', 'Location Manager', 'General Manager / Office Manager']) {
  ok(`kept: ${t}`, !O.titleProblem(t), O.titleProblem(t));
}
// A NON-MARKETING DEPARTMENT, whatever the seniority word ("Director of
// Housekeeping" passed on "director").
for (const t of ['Director of Housekeeping', 'Executive Housekeeper', 'Executive Chef', 'Director of IT', 'IT Manager', 'HR Director',
  'Director of Human Resources', 'Facilities Director', 'Director of Engineering', 'Front Desk Manager', 'Payroll Manager', 'Director of Guest Services']) {
  ok(`refused (department): ${t}`, !!O.titleProblem(t));
}
for (const t of ['Chef/Owner', 'Owner & Executive Chef', 'Director of Sales & Marketing', 'Sponsorship Coordinator', 'Director of Sales',
  'Director of Operations', 'Community Manager', 'General Manager, Hotel Operations', 'Director of Community Partnerships']) {
  ok(`kept: ${t}`, !O.titleProblem(t), O.titleProblem(t));
}
ok('"it" in lower case is not IT', !O.titleProblem('Owner, and it shows'));
ok('the university list refuses it too', !!CQ.refusedTitle('Assistant Store Manager') && !CQ.refusedTitle('Store Manager'));

console.log(OUT.join('\n'));
console.log(`\n${OUT.length - F}/${OUT.length} passed`);
process.exit(F ? 1 : 0);
