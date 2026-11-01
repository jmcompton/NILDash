'use strict';
// ── THE FIRST EMAIL, WRITTEN FROM THE PLAYBOOK ──────────────────────────────
//
// One short plain-text email from the customer (the IT company) to the person
// found at the business, built on the one specific finding. The same model as
// the NILDash pitch writer (claude-sonnet-4-6). Every email is checked after
// writing: a check that fails falls back to the template, which is plain but
// always true, so a business never gets a made-up claim.

const ai = require('../../ai');
const MODEL = 'claude-sonnet-4-6';

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

function check(email, ctx) {
  const t = `${email.subject || ''}\n${email.body || ''}`;
  const out = [];
  if (!email.subject || !email.body) out.push('missing subject or body');
  if (/[—–]/.test(t)) out.push('long dash');
  if (/!/.test(t)) out.push('exclamation mark');
  if (/\$\s?\d/.test(t)) out.push('names a price');
  if (/\b(hacked|breached|compromised|were attacked|spoofed you)\b/i.test(t)) out.push('claims they were hacked');
  if (/\b(scanned|penetration|pen test|tested your)\b/i.test(t)) out.push('claims a scan');
  if (/\bAI\b|artificial intelligence/.test(t)) out.push('mentions AI');
  if (/\[[^\]]+\]/.test(t)) out.push('left a blank');
  if (words(email.body) > 130) out.push('over 130 words');
  if (ctx && ctx.domain && !t.toLowerCase().includes(ctx.domain.toLowerCase())) out.push('does not name their domain');
  return out;
}

function template(ctx) {
  const first = ctx.person && ctx.person.first ? ctx.person.first : 'there';
  const body = `Hi ${first},\n\n${ctx.finding.problems[0]}\n\nThis came from your public DNS records, which anyone can look up. It is usually a quick fix, and it matters for a ${String(ctx.category || 'business').toLowerCase()} because fake email that looks like it came from you is how a lot of invoice and patient-data scams start.\n\nWould a 10 minute call this week be worth it? I can walk you through it.\n\n${ctx.sender.name}\n${ctx.sender.company}`;
  return { subject: `Quick note about email at ${ctx.domain}`, body, source: 'template' };
}

function prompt(ctx, playbook) {
  return `Write one cold email from ${ctx.sender.name} at ${ctx.sender.company} (${playbook.label}: ${playbook.sells}${ctx.sender.about ? '; ' + ctx.sender.about : ''}) to ${ctx.person ? `${ctx.person.first} ${ctx.person.last}`.trim() + (ctx.person.title ? `, ${ctx.person.title}` : '') : 'the owner'} at ${ctx.business} (${ctx.category}, ${ctx.address || ctx.area}).

What we found in ${ctx.domain}'s public DNS records:
${ctx.finding.problems.map((p) => '- ' + p).join('\n')}
Their email runs on: ${ctx.finding.mail || 'unknown'}.

The offer: ${playbook.pitch.offer}.
The angle: ${playbook.pitch.angle}

Rules:
${playbook.pitch.rules.map((r) => '- ' + r).join('\n')}
- Name their domain (${ctx.domain}) once.
- Plain words. Under 110 words. No exclamation marks, no long dashes, no brackets or blanks, never mention AI.
- Sign off with: ${ctx.sender.name}, ${ctx.sender.company}.

Return ONLY JSON: {"subject": "...", "body": "..."}`;
}

async function write(ctx, playbook, deps = {}) {
  const call = deps.oneShot || ai.oneShot;
  try {
    const raw = await call(prompt(ctx, playbook), 'You write short, specific, honest cold emails for small business owners.', 700, MODEL, { prose: true });
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    const email = m ? JSON.parse(m[0]) : null;
    if (email) {
      email.body = String(email.body || '').replace(/[—–]/g, ',').trim();
      email.subject = String(email.subject || '').replace(/[—–]/g, ',').trim();
      const problems = check(email, ctx);
      if (!problems.length) return { ...email, source: 'writer' };
      return { ...template(ctx), rejected: problems };
    }
  } catch (e) {
    return { ...template(ctx), rejected: ['writer failed: ' + e.message] };
  }
  return { ...template(ctx), rejected: ['writer returned no JSON'] };
}

module.exports = { write, check, template, prompt, MODEL };
