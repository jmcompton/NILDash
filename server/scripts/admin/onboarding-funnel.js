'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/onboarding-funnel
// Per agent and in total: created, link sent, first login, mailbox connected,
// address added, first athlete, first card approved, first email sent
// (services/onboardingFunnel). Read-only. agent=<email or id> for one agent.
//   /api/admin/scripts/onboarding-funnel?text=1[&agent=<email or id>]
const def = {
  file: 'scripts/onboarding-funnel.js',
  args: (q) => (q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : []),
};

module.exports = { name: 'onboarding-funnel', file: def.file, args: def.args };
