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

---

## The morning queue has no score that spans its two tables

**Status:** designed around, in `server/services/actionable.js`.
**Opened:** 2026-08-26.

### What happens

Home is one queue built from two tables — `outreach_logs` email drafts and
`outreach_queue` call and DM cards. Ordering them together needs one comparable
ranking, and the obvious candidate does not work.

`brand_match_scores` **has no `brand_key` column at all.** Every reader joins it
on `athlete_id` plus an exact lowercase `brand_name` — the same name-only
matching that `brandIdentity.js` replaced everywhere else, and which collapsed
0 of 9 realistic variant pairs when it was measured. Measured in production, it
reaches **2 of 49** non-programme queue cards (4%). Email drafts, written after
a scan, mostly do carry a score.

So `ORDER BY compatibility_score DESC NULLS LAST` over the union puts nearly
every email above nearly every call and DM card, and quietly rebuilds the
single-channel page the mixed queue exists to replace. **The score is not used.**

### What is used instead

A four-rung ladder, every rung of which means the same thing on both tables:

1. **Starved** — older than the promotion age (7 days; 6 for email drafts,
   because `DRAFT_EXPIRY_DAYS` deletes them at 7 and a card promoted on the
   morning it is expired was never really promoted).
2. **Reach** — how likely this card is to reach a human, scored per channel: a
   confirmed mailbox, a storefront handle, a number with a name to ask for.
3. **A stated reason** — binary. Scoring the *quality* of a reason would have to
   weigh a sponsor note against a pitch opener, and sponsor notes exist only on
   queue cards, so any such scale is a channel preference in disguise.
4. **Oldest first**, then the id. `created_at` is the only column that is
   literally the same on both tables.

Plus a floor of two email slots in every five, because an email is the only card
that sends itself and at an 18% email share a pure ranking yields an all-DM page.

### The weak spot

Cross-table deduplication can only ever fire on the **weakest** basis.
`outreach_logs` has no `brand_key` column, so an email draft's identity is its
normalised name (plus a `dom:` key when the joined `company_enrichment` row
happens to carry a website). A queue card carries a real `place:` or `dom:` key.
The two therefore overlap on `name:` and nothing else — which is why every
cross-table collapse logs `key=(no key)` on the winning side. That is not log
noise; it is the finding.

### What the real fix looks like

Give `outreach_logs` a `brand_key` written at draft time from
`brandIdentity.identityOf`, and give `brand_match_scores` the same. Both make the
collapse certain rather than probable, and the second would restore a genuinely
shared score to rung 2 of the ladder.

---

## Programme cards are excluded from Home, not solved

**Status:** deliberate, v1.
**Opened:** 2026-08-26.

72 of 121 queued cards in production are `channel='program'` — applications to a
brand's athlete programme, with no person on the other end. They are excluded
from the mixed Home queue because "five cards for this athlete" would otherwise
mean two different kinds of work. They still render on the Outreach tab and are
counted separately in the shift report, so they are excluded rather than lost —
but 60% of a night's output currently has no place on the page an agent opens
every morning. That is a product decision waiting to be made, not a bug.

---

## Call cards have no script

**Status:** cut from v1, deliberately.
**Opened:** 2026-08-26.

A call card on Home shows a number, who to ask for, and the reason — and nothing
else. There is no `call_script` column on `outreach_queue` and nothing writes
one; `dm_text` is only written when the nightly job marks a card `dmable`
(`server/jobs/outreachQueue.js`). A templated script would be a sentence we
invented, presented as something the product prepared, so none is shown. The fix
is a column plus a generation arm in the nightly job alongside the DM arm, and a
backfill decision for the call cards already queued.
