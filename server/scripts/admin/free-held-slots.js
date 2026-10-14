'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/free-held-slots
// One-time, for EMAIL_FIVE_ON (services/freeHeldSlots): retire every queued DM,
// call and unverified email card so the five slots open for verified emails.
// Never a card the agent approved, sent or marked done, or one with a reply.
// DRY RUN unless apply=1. agent=<email or id> limits it to one agent.
//   /api/admin/scripts/free-held-slots?text=1[&apply=1][&agent=<email or id>]
const def = {
  file: 'scripts/free-held-slots.js',
  args: (q) => [...(q.apply === '1' ? ['--apply'] : []),
    ...(q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : [])],
};

module.exports = { name: 'free-held-slots', file: def.file, args: def.args };
