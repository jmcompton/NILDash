'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/disconnect-mailbox
// The free contact steps across a university's named people (the website on
// file for an email, the Instagram handle it links to) and the latest
// night's cards brought up to date. Dry run unless apply=1. Sends nothing.
// A university's duplicate teams ("Swim & Dive" and "Swimming & Diving")
// merged into one: athletes, cards and every team row moved, the duplicate
// deleted. Dry run unless apply=1.
// A mailbox marked disconnected (not deleted): the preflight stops checking
// it and nothing sends from it until the agent reconnects. Dry run unless apply=1.
const def = { file: 'scripts/disconnect-mailbox.js', args: (q) => {
  const e = String(q.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) throw Object.assign(new Error('email= must be an email address'), { status: 400 });
  return ['--email', e].concat(q.apply === '1' ? ['--apply'] : []);
} };

module.exports = { name: 'disconnect-mailbox', file: def.file, args: def.args };
