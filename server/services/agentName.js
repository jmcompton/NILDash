'use strict';
// ── THE NAME A PITCH IS SIGNED WITH ─────────────────────────────────────────
//
// A pitch goes out under the agent's own name. When that name was missing, the
// writer signed it "JohnMark" -- a real person, and not this agent -- and the
// other writers signed "Your Agent", "NIL Agent" or "an agent". A card with no
// named recipient is not written; a card with no named sender is not written
// either. This is the one place that decides whether we hold a name.
//
// NOT A NAME:
//   - empty, or whitespace
//   - a stand-in some earlier code wrote in place of one ("Agent", "Your Agent")
//   - the email's local part, which saveUser used to store for a nameless
//     signup ("jmcompton04" for jmcompton04@gmail.com)
//   - anything with an @ or a digit in it, which is an address or a handle
//
// Returns the cleaned name, or null. null means: do not write the card.

const PLACEHOLDERS = new Set([
  'agent', 'your agent', 'nil agent', 'an agent', 'the agent', 'user', 'unknown', 'there', 'admin',
]);

const NO_AGENT_NAME_REASON =
  'no agent name on file, so nothing can be signed; add your name in Settings and the next run writes these cards';

function cleanName(raw, email) {
  const name = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!name) return null;
  if (PLACEHOLDERS.has(name.toLowerCase())) return null;
  if (/[@\d]/.test(name)) return null;
  const local = String(email || '').split('@')[0].trim();
  if (local && name === local) return null;
  return name;
}

// A NAME AS PEOPLE WRITE IT. users.name is whatever was typed at signup, and
// "john compton" went out on media kits, in the app's greeting and under
// pitches. A word typed all in lowercase gets its first letter capitalized
// (each part of a hyphenated or apostrophe name too); a word with any capital
// in it is left exactly as typed, so "JohnMark", "McNeill" and "DeAndre" stay.
function properCase(name) {
  return String(name == null ? '' : name).split(' ').map((w) => (
    w && w === w.toLowerCase() ? w.replace(/(^|[-'])([a-z])/g, (m, p, c) => p + c.toUpperCase()) : w
  )).join(' ');
}

// The whole name, for a signature line or a contract party.
function agentFullName(user) {
  if (!user) return null;
  const n = cleanName(user.name, user.email);
  return n ? properCase(n) : null;
}

// THE NAME ON SCREEN: the sign-off first name when the agent set one
// ("JohnMark"), then the rest of their name, properly cased. Used by the
// app's greeting and sidebar and by the media kit's "from" line. Nothing is
// written back: users.name stays as typed.
function displayName(user) {
  if (!user) return null;
  const full = agentFullName(user);
  const raw = String((user.sign_first_name != null ? user.sign_first_name : user.signFirstName) || '').replace(/\s+/g, ' ').trim();
  const first = raw && raw.length <= 40 && !/[^A-Za-z .'-]/.test(raw) ? properCase(raw) : null;
  if (!full) return first;
  if (!first) return full;
  const parts = full.split(' ');
  parts[0] = first;
  return parts.join(' ');
}

// The first name, for the sign-off.
function agentFirstName(user) {
  const n = agentFullName(user);
  return n ? n.split(' ')[0] : null;
}

// ── THE NAME A PITCH IS SIGNED WITH (AGENT_SETUP_ON) ───────────────────────
// The agent's own "First name for sign-offs" (Settings, users.sign_first_name),
// exactly as typed -- "JohnMark" stays "JohnMark" -- when it is set and
// AGENT_SETUP_ON is on. Otherwise, and for anything that is not a name, the
// first word of their name, as before. Only pitches use it (the nightly
// writer, follow-ups, the outreach pitch); a greeting TO the agent keeps
// agentFirstName.
function signOffSetting(user) {
  if (process.env.AGENT_SETUP_ON !== '1' || !user) return null;
  const raw = String((user.sign_first_name != null ? user.sign_first_name : user.signFirstName) || '').replace(/\s+/g, ' ').trim();
  // Only a name: letters, spaces, apostrophes, dots, hyphens. Anything else
  // (an address, a number) is not used rather than "cleaned" into one.
  if (!raw || raw.length > 40 || /[^A-Za-z .'-]/.test(raw)) return null;
  return cleanName(raw, user.email);
}
function pitchSignOffName(user) {
  return signOffSetting(user) || agentFirstName(user);
}

// For a caller that holds only a string (the writer's ctx.agentFirstName).
function firstNameOrNull(raw) {
  const n = cleanName(raw, null);
  return n ? properCase(n).split(' ')[0] : null;
}

module.exports = { agentFullName, agentFirstName, firstNameOrNull, pitchSignOffName, signOffSetting, displayName, properCase, NO_AGENT_NAME_REASON, PLACEHOLDERS };
