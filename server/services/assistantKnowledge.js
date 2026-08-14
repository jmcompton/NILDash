'use strict';
// The assistant's product knowledge.
//
// PLUMBING ONLY RIGHT NOW. The real knowledge base is being written separately and
// will be pasted between the markers below. Until then KNOWLEDGE is deliberately
// near-empty, and the assistant is told in its system prompt that anything not in
// here is something it does not know.
//
// THE POINT OF THE MARKERS. Paste between them and nothing else in this file has to
// change. hasKnowledge() reports whether real content has landed yet, and the route
// logs it on boot, so "the assistant is answering vaguely" has an obvious first
// thing to check.
//
// WHY THIS IS NOT IN THE PROMPT FILE. Keeping it separate means a knowledge edit is
// a one-file diff with no code in it, reviewable by someone who does not read
// JavaScript.

const KNOWLEDGE = `
<!-- PASTE KNOWLEDGE BASE HERE -->

(The NILDash product knowledge base has not been added yet. Nothing about how
NILDash features work should be stated as fact until it is.)

<!-- END KNOWLEDGE BASE -->
`.trim();

// True once real content has replaced the placeholder. Checked by the route so the
// state is visible in the logs rather than inferred from bad answers.
function hasKnowledge() {
  return !/has not been added yet/.test(KNOWLEDGE);
}

module.exports = { KNOWLEDGE, hasKnowledge };
