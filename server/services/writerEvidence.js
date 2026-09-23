'use strict';
// ── WHAT THE WRITER MAY SAY ABOUT A BUSINESS ────────────────────────────────
//
// Discovery collects marketing-activity evidence per business -- sponsors a
// local team, runs local ads, has done athlete partnerships, runs an active
// promotional feed -- and used it to RANK. The writer never saw it: the queue
// passed siteSummary: null and sponsorsLocal: null, so every pitch was written
// as if we knew nothing about the business.
//
// This is the list the writer is handed. The rule it writes under is narrow:
// it may state exactly ONE of these lines, meaning exactly what the line says,
// and nothing else about the business. With an empty list it says nothing
// about the business at all (pitchWriter.checkEvidence enforces both).
//
// PUBLIC EVIDENCE ONLY. The Scout carries other signals that must never reach
// a message to the business itself:
//   - agent-closed-at-school   the agent's own book ("you have already closed
//                              a deal with them"), worded to the agent
//   - replied-at-school        derived from a connected inbox, which stays
//                              with the agent it came from and is never shown
//   - nilFlags.nilActive       built from OTHER agents' deals
// Only what a search or a public page showed goes in: the scan's evidence line,
// a publicly reported NIL deal, and a programme's own offer page.

const MAX_LINES = 3;
const MAX_LEN = 180;

function clean(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ')
    .replace(/\s*[—–―]\s*/g, ', ')
    .trim()
    .replace(/[.;,\s]+$/, '');
  if (!t) return null;
  // Two words at least: "Sponsors" alone is not a fact anyone can check.
  if (t.split(' ').length < 2) return null;
  const short = t.length > MAX_LEN ? t.slice(0, MAX_LEN).replace(/\s+\S*$/, '') : t;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

function evidenceFor(cand) {
  if (!cand || typeof cand !== 'object') return [];
  const out = [];
  const push = (s) => {
    const c = clean(s);
    if (c && !out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  };
  // 1. What the discovery search actually showed, under 12 words by its own
  //    prompt ("Sponsors Homewood High athletics"). A string only: the national
  //    lanes carry an evidence OBJECT of deals, which is not a sentence.
  push(typeof cand.evidence_text === 'string' ? cand.evidence_text
    : (typeof cand.evidence === 'string' ? cand.evidence : null));
  // 2. A publicly reported NIL deal. The only Scout signal that is public.
  const sig = cand.sponsorSignal;
  if (sig && sig.kind === 'reported-deal-at-school' && sig.detail) push(sig.detail);
  // 3. A programme's own page, summarised when the programme was found.
  if (typeof cand.offerSummary === 'string') push(cand.offerSummary);
  return out.slice(0, MAX_LINES);
}

module.exports = { evidenceFor, clean, MAX_LINES };
