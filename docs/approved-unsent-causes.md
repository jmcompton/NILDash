# Why approved emails kept not sending

**The rule from now on.** An email an agent approved that has not sent within 2 hours is a fault. It is detected every 10 minutes by `services/sendFaults`. If a row has been stopped for good, it is a fault at once. Each fault produces three things:
- a line at the top of the agent's Home, with the reason in plain words and what to do;
- one email to the agent;
- a line in the admin's morning alert, naming the agent and the count.

The detection does not depend on the reason. Any approved row that has not sent, with no `sent_at`, is caught, including a row with no reason recorded at all. That covers a cause nobody has thought of yet. The one exception: a row with no reason recorded is not counted while the same agent's mailbox has sent in the last 15 minutes, because it is still in line behind a bulk approve.

## Every cause found so far

**1. The send job never ran.**
- What happened: sending only ran when the `CLOSER_RELEASE_ENABLED=1` setting was turned on, and production never turned it on. 41 approved emails sat for days.
- Status: **fixed**. The release queue now always runs, every 5 seconds, and is woken by Approve.
- Test: `closer.js` ("THE RELEASE ACTUALLY SENDS"). A never-picked-up row is now also a fault reported as our fault: `sendfaults.js`.

**2. An age hold outlived the answer.**
- What happened: the agent ticked "18 or over", but the hold filed on the unknown age stayed open forever.
- Status: **fixed**. The hold clears automatically once the age is known.
- Test: `agehold.js`.

**3. A compliance override was re-filed every tick.**
- Status: **fixed**. A decided rule is dropped from the re-check.
- Test: `compliance.js`.

**4. A missing athlete row made the row vanish from the queue.**
- Status: **fixed**: a LEFT JOIN, and the row is held with a reason.
- Test: `sendfaults.js` ("NO ATHLETE ROW"), **added today**.

**5. A double approve cleared the queue's claim.**
- Status: **fixed** in 47bed0f.
- Test: `sendasync.js`.

**6. A follow-up was written with an empty body at send time.**
- Status: **fixed**. Follow-ups are written as drafts and approved like any other email.
- Test: `followups.js`, `prewarm.js`.

**7. A draft with no address was approved.**
- What happened: scan-time drafts written before the contact search finished, AI Outreach drafts that never stored the address, and drafts linked to a card that held the address. They then died at send time with "no address to send to". This was 25 of the 41 rows from 2026-09-23.
- Status: **fixed** in b347f6d. Approve fills in the address on file or refuses up front with the reason. The draft becomes a call or DM card.
- Test: `nosendpath.js`.

**8. The digest's one-tap Approve offered address-less drafts.**
- Status: **fixed** in b347f6d. The digest lists only drafts with an address.
- Test: `nosendpath.js`.

**9. The send path gave up without checking our own address cache.**
- What happened: 3 of the 25 had an address on file (Central City Toyota mmisuraco@, HornsDownShop info@).
- Status: **fixed today**. Approve, the release step and the backlog sweep all read both cache lanes: the website-email cache and the contact-search cache. Bounced and unsubscribed addresses are refused.
- Test: `sendfaults.js`.

**10. A failed read of the bounce list stopped the row for good.**
- What happened: the bounce check fails closed by reporting "suppressed", and a stop is permanent.
- Status: **fixed today**. It now holds the row and checks again.
- Test: `sendfaults.js`.

**11. A stopped row was never told to anyone.**
- What happened: it stayed "approved" and the morning alert re-reported it every morning forever.
- Status: **fixed today**. It is a fault: Home, the agent's email, and the alert. The alert reports it once.
- Test: `sendfaults.js`, `nosendpath.js`.

**12. A disconnected mailbox retried forever.**
- What happened: the reason appeared only on the Home card.
- Status: **reported today**. It is a fault that tells the agent to reconnect, and they are emailed.
- Test: `sendfaults.js`.

**13. The daily ceiling, or a provider quota block for the day.**
- Status: **reported today** as "it goes out automatically".
- Test: `sendfaults.js`, `sendguard.js`, `ceiling.js`.

**14. A provider refusal (any other error), retried on a backoff.**
- Status: **reported today**.
- Test: `sendfaults.js`.

**15. The CAN-SPAM footer address was missing.**
- What happened: every send was held.
- Status: **reported today**, as our fault.
- Test: `sendfaults.js`, `canspam.js`.

**16. A compliance hold, such as no date of birth or an unknown business category.**
- Status: **reported today**, with the fix ("add the date of birth", "open Compliance").
- Test: `sendfaults.js`, `agehold.js`.

**17. A reply, an unsubscribe or a bounce before the send.**
- Status: **reported today**. These are correct stops, now told rather than silent.
- Test: `sendfaults.js`.

## Not fixed

**A. Address-less drafts are still written** at scan time (`draftPrewarm`). They can no longer be approved: Home turns them into call or DM cards, and Approve refuses them. But the writer still creates them. The fix is to write them only after the contact search, and it is not done.

**B. A disconnected mailbox still cannot send.** That is the agent's to fix. It is now said to them, by email and on Home, within 2 hours.

**C. A business with no Places record is held by compliance** until someone confirms what it is. It is reported, with the step to take, but it still needs a person.
