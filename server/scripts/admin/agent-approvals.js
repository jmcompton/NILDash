'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/agent-approvals
// One agent's approved emails that never sent (held or stopped), each with
// athlete, business, address and reason. apply=1 releases the ones that can
// send to the normal release queue (paced, daily cap, warm-up, send gate);
// never one with no address, one whose address already got an email, or one
// with a hard compliance rule. status=1 shows what became of the released.
//   /api/admin/scripts/agent-approvals?text=1&agent=<email>[&apply=1|&status=1]
const def = { file: 'scripts/agent-approvals.js', args: (q) => {
  const agent = String(q.agent || '').trim();
  if (!agent || !agent.includes('@')) throw Object.assign(new Error('agent=<email> is required'), { status: 400 });
  const a = ['--agent', agent.slice(0, 200)];
  if (q.apply === '1') a.push('--apply');
  else if (q.status === '1') a.push('--status');
  return a;
} };

module.exports = { name: 'agent-approvals', file: def.file, args: def.args };
