# Known issues

Things that are worked around rather than fixed. A workaround that nobody wrote
down becomes the architecture by accident, so each entry says what the real
cause is, what the workaround costs, and what removing it would look like.

---

## Draft addressing races the contact ladder

**Status:** worked around at `server/services/homeQueue.js` (`buildHome`, the
"ADDRESS THE DRAFTS BEFORE JUDGING THEM" block).
**Opened:** 2026-08-26.

### What happens

Nineteen of twenty nightly drafts are created with `sent_to_email` NULL. They
then appear on Home as cards with an approve button over an empty recipient.

### Why

Two independent problems, both about ordering, neither of them in the file that
works around them.

**1. The draft reads the cache before the ladder writes it.**

Both jobs are fired back to back after the scan response is sent
(`server/index.js`, `_prewarm.prewarmScan` then `_ladders.prewarmLadders`):

- `draftPrewarm.draftOne` calls `draftAddress.lookupOne` **after** its model
  call, so roughly 5–15 seconds in.
- `ladderPrewarm.warmOne` runs the deep contact lookup, which the file itself
  documents as about **30 seconds**. That deep lookup is the only thing that
  reaches `findSiteEmail`, and `findSiteEmail` is the only thing that writes the
  `brand_evidence_cache` row (lane `siteemail`) that `lookupOne` reads.

So the draft looks for the address about twenty seconds before anything has
written one. It finds nothing, inserts NULL, and never comes back.

**2. Most drafts never get a lookup at all.**

`draftPrewarm.MAX_CARDS` is 12 and `ladderPrewarm.TOP_N` is 3, per lane, and a
single Deal Scan click fires three lanes. So one scan writes up to 36 drafts and
runs 9 deep lookups. Twenty-seven of them never had an address source created
for them under any timing.

### The workaround

`buildHome` calls `draftAddress.attach` for the cards it is about to show. By
the time an agent opens Home the ladder has long since finished, so the row that
was missing at insert is usually present now, and the address gets stamped on.
Cards still without one are withheld with a reason rather than shown.

### What it costs

- **Hunter credits move from approve time to display time.** Verification now
  runs for every athlete whose queue is *viewed*, not only for cards that get
  sent. This is why `verifyBudget.js` exists: 3 credit-consuming lookups per
  athlete per day, logged per lookup in `email_verify_credit_log`. MX is free
  and is not budgeted.
- **Latency on the page.** Bounded by `HOME_ATTACH_DEADLINE_MS` (2500ms), after
  which remaining addresses come back `unknown` and the cards say so.
- **A first-morning slate can still be thin.** The workaround cannot invent an
  address for the 27 of 36 that never had one looked up.

### What the real fix looks like

Any one of these removes the need for the workaround; the first is the smallest:

1. Move `lookupOne` out of `draftOne` and address the draft in a pass that runs
   *after* `prewarmLadders` resolves, rather than concurrently with it.
2. Have `draftOne` trigger the address lookup for its own brand instead of
   reading a cache somebody else may or may not have filled.
3. Raise `TOP_N` to match `MAX_CARDS` so every drafted card has a lookup — the
   most expensive option, and it does not fix the race on its own.

When one of those lands, the `attach` call in `buildHome` becomes a cheap no-op
(it only touches rows where the address is still NULL) and this entry can go.

### Related

- `draftAddress.lookupMany` reads lane `siteemail` only. Address-ladder steps 2
  (Hunter) and 3 (targeted person search) write elsewhere — `personemail` is a
  real lane — so a successful ladder hit is invisible to the draft. Separate
  from the race, and not fixed either.
- `brand_evidence_cache.brand` is `opts.brand || siteRoot`, so a row written
  without a brand keys on a domain and can never join a brand name. The join is
  also exact-on-lowercase, so "Trak Shak" and "Trak Shak Inc" miss each other.
