'use strict';
// ── A MISSING VALUE DROPS THE LINE. IT NEVER PRINTS THE VARIABLE'S NAME ──────
//
// A DM went to a business reading "https://www.instagram.com/[athlete_handle]".
// The athlete had no handle stored; the writer's output format told the model
// to end with "the Instagram link on its own line" whether or not a link had
// been given, and the model filled the gap with a placeholder.
//
// Nothing in this codebase substitutes template variables into a message, so
// a placeholder in outbound text is always a model filling a gap (or a person
// pasting one into a stored sequence). The rule is the same either way: the
// line that carries it is removed, never sent. This module is the one
// definition of "a placeholder", used by
//   - the pitch writer, on every draft before it is linted (pitchWriter);
//   - the nightly card insert, as a backstop for any other writer (jobs/
//     outreachQueue.insertCard) and the university draft insert (teamScan);
//   - scripts/placeholder-audit.js, over every unsent draft already stored.
//
// WHAT COUNTS
//   [athlete_handle] [Athlete Name] [your name] [Business]   square brackets
//     round a word or two that reads as a slot name (not "[1]", not a markdown link)
//   {{first_name}} {first_name} {{ athlete.name }}          braces
//   <ATHLETE_NAME> <your name>                                 angle-bracket slots
//   ATHLETE_HANDLE, INSERT NAME, [insert link]                  shouted slot names
const SQUARE = /\[(?!\d+\])([A-Za-z][A-Za-z0-9_ .'\/-]{0,40})\](?!\()/;
const BRACES = /\{\{?\s*[A-Za-z_][A-Za-z0-9_. ]{0,40}\s*\}\}?/;
const ANGLE = /<\s*(?:your|athlete|agent|business|brand|owner|first|last|company|school|sport|handle|name|link|insert)[A-Za-z0-9_ ]{0,30}\s*>/i;
const SHOUT = /\b(?:INSERT[ _][A-Z]+|(?:ATHLETE|AGENT|BUSINESS|BRAND|OWNER|SCHOOL|COMPANY|YOUR|FIRST|LAST)_[A-Z_]{2,})\b/;
const PATTERNS = [SQUARE, BRACES, ANGLE, SHOUT];

// Square brackets that are NOT slots: a markdown link "[text](url)" is
// excluded by the lookahead above; "[sic]" and "[1]" are not slot names.
const NOT_A_SLOT = /^(sic|sic\.|citation needed|\d+)$/i;

function find(text) {
  const s = String(text || '');
  const out = [];
  for (const re of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(s))) {
      if (re === SQUARE && NOT_A_SLOT.test(m[1].trim())) continue;
      out.push(m[0]);
    }
  }
  return out;
}
const has = (text) => find(text).length > 0;

// Plain text: every line holding a placeholder goes. Returns the text and
// what was dropped, so a caller can log it and a test can see it.
function dropLines(text) {
  const src = String(text == null ? '' : text);
  if (!has(src)) return { text: src, dropped: [] };
  const dropped = [];
  const kept = src.split('\n').filter((line) => {
    if (has(line)) { dropped.push(line.trim()); return false; }
    return true;
  });
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}

// HTML: the same rule on the block a line lives in (<p>, <div>, <li>, or a
// run between <br>s). A block whose text holds a placeholder is removed.
function dropLinesHtml(html) {
  const src = String(html == null ? '' : html);
  const textOf = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  if (!has(textOf(src))) return { html: src, dropped: [] };
  const dropped = [];
  let out = src.replace(/<(p|div|li)\b[^>]*>[\s\S]*?<\/\1>/gi, (block) => {
    // A block that contains nested blocks is decided by its children.
    if (/<(p|div|li)\b/i.test(block.replace(/^<[^>]*>/, ''))) return block;
    const t = textOf(block);
    if (has(t)) { dropped.push(t.trim()); return ''; }
    return block;
  });
  // What is left outside blocks: split on <br>.
  if (has(textOf(out))) {
    out = out.split(/(<br\s*\/?>)/i).map((seg) => {
      if (/^<br/i.test(seg)) return seg;
      if (has(textOf(seg)) && !/<(p|div|li)\b/i.test(seg)) { dropped.push(textOf(seg).trim()); return ''; }
      return seg;
    }).join('').replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');
  }
  return { html: out, dropped };
}

module.exports = { find, has, dropLines, dropLinesHtml, PATTERNS };
