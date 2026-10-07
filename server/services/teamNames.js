'use strict';
// ── ONE TEAM, ONE NAME ──────────────────────────────────────────────────────
// Cypress's site links the same sport under two codes with two labels ("Men's
// Swim & Dive" and "Men's Swimming & Diving"), and the roster import made a
// team for each: 17 teams for 15, and the duplicates drew real cards. Every
// team name goes through canonicalName before it is stored, and two names
// with the same teamKey are the same team.
//   Swimming & Diving / Swimming and Diving / Swim and Dive / Swim-Dive -> Swim & Dive
//   Track and Field / Track & Field / T&F                              -> Track & Field
//   XC / Cross-Country                                                 -> Cross Country
//   Mens / Men / Men's ; Womens / Women / Women's / Ladies              -> Men's / Women's
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function canonicalName(name) {
  let n = squash(name).replace(/[’‘`]/g, "'");
  n = n.replace(/^(men'?s|mens|men)\b\s*/i, "Men's ").replace(/^(women'?s|womens|women|ladies'?|lady)\b\s*/i, "Women's ");
  n = n.replace(/\bswim(ming)?\s*(&|and|\/|-|\+)\s*div(e|ing)\b/gi, 'Swim & Dive');
  n = n.replace(/\btrack\s*(&|and|\/|-|\+)\s*field\b/gi, 'Track & Field').replace(/\bT\s*&\s*F\b/g, 'Track & Field');
  n = n.replace(/\bcross[\s-]*country\b/gi, 'Cross Country').replace(/\bXC\b/gi, 'Cross Country');
  return squash(n);
}

function teamKey(name) {
  return canonicalName(name).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
}

module.exports = { canonicalName, teamKey };
