'use strict';
// ── THE CLOSER ───────────────────────────────────────────────────────────────
//
// It builds the night's email batch, the agent approves it in ONE decision, and
// it releases each message into the send window on its own. The agent never
// picks a send time and never clicks send on an individual message.
//
// WHY BATCH APPROVAL AND NOT PER MESSAGE. Per-message approval is the feature
// that looks careful and is actually the product failing: forty clicks a night
// is not a review, it is data entry, and by message six nobody is reading. One
// decision the agent actually makes beats forty they rubber-stamp.
//
// So: approve all, or uncheck the few that are wrong and approve the rest.
//
// WHAT THIS DOES NOT DO. It does not choose when mail goes out. sendWindow.js
// already answers that -- Tuesday to Thursday, 9:30 to 11:00 in the RECIPIENT's
// timezone, never weekends -- and the agent does not configure it, because a
// business owner reads mail on their clock and not on the agent's.
//
// SCHEDULED IS NOT SENT. Nothing in the codebase ever read scheduled_send_at;
// the column was written and then nothing happened. releaseDue() is the job that
// was missing, and it is the only thing that calls the provider.

const sendGuard = require('./sendGuard');
const PIPE = require('./pipeline');
const suppression = require('./suppression');
const sendWindow = require('./sendWindow');
// Namespaced card ids, so a call or DM card can never be mistaken for a draft.
const A = require('./actionable');

// ── THE CADENCE ──────────────────────────────────────────────────────────────
// One message rarely gets it done, and five is harassment. Three touches over a
// fortnight, each landing in the same window, stopping the moment they answer.
// The gaps widen: someone who ignored two is not going to be won by a third
// arriving the next morning.
const CADENCE = [
  { touch: 1, afterDays: 0 },
  { touch: 2, afterDays: 4 },
  { touch: 3, afterDays: 9 },
];
const MAX_TOUCHES = CADENCE.length;

// Auto mode is not offered until the agent has approved this many pitches
// without editing any of them. Editing is the signal that the writing is not
// yet trusted, and offering autonomy before then is asking for permission we
// have not earned.
const AUTO_MODE_THRESHOLD = 30;

function laneOf(row) { return row && row.lane ? row.lane : 'local'; }

// ── Building tonight's batch ─────────────────────────────────────────────────
// Drafts that are ready to go out: written, addressed, not yet approved, not to
// a suppressed address, and inside the athlete's allocation.
async function buildBatch(pool, agentId, opts = {}) {
  const guard = await sendGuard.status(pool, agentId, opts);
  if (guard.blocked) {
    return { batch: [], budget: guard, blocked: true,
      note: `sending is stopped for today: ${guard.blockedReason}` };
  }
  if (guard.remaining < 1) {
    return { batch: [], budget: guard, blocked: false,
      note: `tonight's ${guard.cap}-email ceiling is already used up` };
  }

  // THE 120 DRAFTS THAT ALREADY EXIST have no address, because the column was
  // never in the INSERT. New drafts are born with one now; this catches the
  // backlog, at batch time, so the pile drains instead of being rewritten.
  // Cheap: it only touches rows where the address is still NULL.
  try {
    const attached = await require('./draftAddress').attach(pool, { agentId, limit: 300 });
    if (attached.attached) {
      console.log(`[closer] attached ${attached.attached} address(es) to drafts that had none`
        + ` (${attached.missing} still have no cached address)`);
    }
  } catch (e) { console.error('[closer] address backfill:', e.message); }

  const alloc = require('./closerAllocator');
  const signals = await alloc.gatherSignals(pool, agentId, opts);
  const plan = alloc.allocate(signals, guard.remaining, opts);
  if (!plan.picks.length) {
    return { batch: [], budget: guard, blocked: false, plan,
      note: plan.note || 'nothing to allocate tonight' };
  }

  const wanted = new Map(plan.picks.map((p) => [p.athleteId, p]));
  // WHAT THE AGENT HAS TO BE ABLE TO READ. The old batch carried a subject and a
  // brand name; an agent approved nineteen messages that went out under their own
  // name having read none of them. The row now carries who it is going to, where
  // they are, and the full body, so the page can show the message itself.
  //
  // lane and the contact name live on outreach_queue (the card the Scout built),
  // the street address on company_enrichment. Both are LEFT JOINs on the brand
  // name: a draft with no matching card still appears, just with less on it.
  const drafts = (await pool.query(
    `SELECT l.id, l.athlete_id, l.brand_name, l.brand_key, l.subject, l.body_html,
            l.sent_to_email, l.email_kind, l.angle, l.angle_key, l.category_key,
            l.touch_no, l.created_at, l.edited_before_approval,
            a.data->>'name' AS athlete_name,
            a.data->>'school' AS school,
            COALESCE(c.email, l.sent_to_email) AS to_email,
            q.lane, q.contact_name, q.contact_title,
            a.data AS athlete_data,
            e.location AS biz_address
       FROM outreach_logs l
       JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN brand_contacts c ON c.id = l.contact_id
       LEFT JOIN company_enrichment e ON e.id = l.enrichment_id
       LEFT JOIN LATERAL (
         SELECT lane, contact_name, contact_title FROM outreach_queue q2
          WHERE q2.athlete_id = l.athlete_id AND LOWER(q2.brand_name) = LOWER(l.brand_name)
          ORDER BY q2.created_at DESC LIMIT 1
       ) q ON TRUE
       -- THE ADDRESS MUST BE FROM THIS ATHLETE'S MARKET, OR THERE IS NO ADDRESS.
       -- This matched on brand name alone and took the most recently refreshed
       -- row, ignoring the region that is part of every places cache key
       -- (placesLookup._key builds "<brand> | <canonicalRegion> | <v>"). The
       -- cache is global, so the row it found could have been written for a
       -- different athlete in a different state -- which is how one shared
       -- Liquid I.V. row printed "Sunnyvale" on cards for Maryland, Connecticut
       -- and Alabama at the same time.
       --
       -- The places fallback is resolved in a SECOND PASS below, not here. It
       -- has to be scoped to the ATHLETE'S OWN market key, and this query spans
       -- many athletes with different markets, so one bound parameter cannot do
       -- it -- and canonicalRegion, which builds the key, is JS. Enrichment
       -- (e.location) is per-draft and stays.
      WHERE l.agent_id = $1
        AND l.status = 'draft'
        AND l.approved_at IS NULL
        AND l.cadence_stopped_at IS NULL
        AND l.athlete_id = ANY($2::text[])
      ORDER BY l.created_at ASC`,
    [agentId, [...wanted.keys()]])).rows;

  // ── THE ADDRESS, FROM THIS ATHLETE'S MARKET ONLY ──────────────────────────
  // The places lane is a GLOBAL cache keyed "<brand> | <canonicalRegion> | <v>".
  // The old join matched on brand name alone and took the most recently
  // refreshed row, so one shared Liquid I.V. row printed "Sunnyvale" on cards
  // for Maryland, Connecticut and Alabama at the same time -- an address from
  // another athlete's market, presented as this business's location.
  //
  // Matched on the brand AND the athlete's own market key now. No row for this
  // brand in this market means no address and no city on the card, which is the
  // honest answer: we have not looked this business up here.
  await attachRegionalAddresses(pool, drafts);

  // ONE QUERY FOR THE BOUNCE LIST, not one per draft.
  const suppressed = await suppression.suppressedSet(pool, drafts.map((d) => d.to_email));

  const batch = [];
  const perAthlete = new Map();
  const dropped = [];
  for (const d of drafts) {
    const cap = wanted.get(d.athlete_id);
    if (!cap) continue;
    const used = perAthlete.get(d.athlete_id) || 0;
    if (used >= cap.count) continue;                       // athlete's allocation is full
    if (batch.length >= guard.remaining) break;            // the agent's ceiling
    const addr = suppression.normalize(d.to_email);
    if (!addr) {
      // Says WHICH kind of nothing this is. "No email address on file" read as a
      // storage bug for weeks when it was in fact two different situations: a
      // business we have never checked, and one we checked and found nothing on.
      dropped.push({ id: d.id, brand: d.brand_name,
        why: 'no email found for this business yet — it stays a DM or call card' });
      continue;
    }
    if (suppressed.has(addr)) {
      dropped.push({ id: d.id, brand: d.brand_name, why: 'that address bounced before' });
      continue;
    }
    perAthlete.set(d.athlete_id, used + 1);
    batch.push({
      id: d.id, athleteId: d.athlete_id, athleteName: d.athlete_name,
      brand: d.brand_name, toEmail: addr, subject: d.subject,
      body: d.body_html, angle: d.angle, touch: d.touch_no || 1,
      why: cap.reason, floor: !!cap.floor,
      lane: laneLabel(d),
      // WHO IT IS ACTUALLY GOING TO. A named contact when we have one, and the
      // honest alternative when we do not -- "the general inbox" is a fact the
      // agent should see before it goes out under their name, not after.
      to: recipientOf(d),
      address: d.biz_address || null,
    });
  }

  // ── GROUPED BY ATHLETE, ORDERED BY URGENCY ───────────────────────────────
  // Nineteen flat rows with the athlete name repeated on every one is a list,
  // not a decision. The name belongs once, at the top of their businesses, with
  // the status line that explains why they are near the top at all.
  //
  // The order is the allocator's, not a second opinion: plan.picks is already
  // sorted by the same score the Closer allocates on, so a reply pending
  // outranks quiet, which outranks the weekly floor.
  const order = plan.picks.map((p) => p.athleteId);
  const groups = [];
  const byAthlete = new Map();
  for (const item of batch) {
    if (!byAthlete.has(item.athleteId)) {
      const pick = wanted.get(item.athleteId) || {};
      const g = {
        athleteId: item.athleteId, name: item.athleteName,
        // The status line is the allocator's own words for why this athlete
        // scored where they did.
        status: pick.reason || null,
        floor: !!pick.floor, score: pick.score || 0,
        items: [],
      };
      byAthlete.set(item.athleteId, g);
      groups.push(g);
    }
    byAthlete.get(item.athleteId).items.push(item);
  }
  groups.sort((a, b) => order.indexOf(a.athleteId) - order.indexOf(b.athleteId));
  for (const g of groups) g.count = g.items.length;

  return {
    batch, groups, dropped, plan, budget: guard, blocked: false,
    // ONE LINE, NOT A PARAGRAPH. The page said "Old Mill Co, Kessler Auto and
    // Hound & Co (that address bounced before)" and trailed off, which named
    // three of forty-five and explained none of them.
    heldBack: summariseDropped(dropped),
    note: batch.length ? null : 'no drafts are ready for the athletes allocated tonight',
  };
}

// local + the town, so "local" is never just a category. DTC and national have
// no city by definition and must not be given one.
// The badge on a card. The lane is READ, never assumed: this used to be
// `(d.lane || 'local')`, which printed "Local" over a national brand whose lane
// was never recorded -- the last of four places that turned an unknown into a
// fact, and the one the agent actually reads.
//
// Legacy rows written before the lane fix still carry NULL, so this has to say
// something. It says it does not know, which is checkable, rather than "Local",
// which is a claim about the world that may be false.
function laneLabel(d) {
  const raw = d && d.lane ? String(d.lane).toLowerCase() : null;
  if (!raw) return 'Lane not recorded';
  if (raw === 'social') return 'DTC';
  if (raw === 'national') return 'National';
  if (raw !== 'local') return raw.charAt(0).toUpperCase() + raw.slice(1);
  // Only a LOCAL card gets a city, and only its own -- see the region-scoped
  // join that produces biz_address. No address means no city, not a borrowed one.
  const city = cityOf(d.biz_address);
  return city ? 'Local · ' + city : 'Local';
}

// Fill d.biz_address from the places cache, matched on brand AND the athlete's
// own market key. Mutates the rows. Enrichment-supplied addresses are left
// alone: those are per-draft and already belong to this business.
//
// One query for the whole batch rather than one per draft, and it asks for the
// exact keys it wants rather than scanning by brand name -- the key IS the
// scope, so an exact-key lookup cannot borrow from another market by accident.
async function attachRegionalAddresses(pool, drafts) {
  const need = drafts.filter((d) => d && !d.biz_address && d.brand_name);
  if (!need.length) return;
  const AR = require('./athleteRecord');
  const { canonicalRegion } = require('./regionKey');
  const marketOf = new Map();                 // athlete_id -> canonical market key
  for (const d of need) {
    if (marketOf.has(d.athlete_id)) continue;
    let key = null;
    try {
      const rec = AR.resolveAthlete(d.athlete_data || { school: d.school });
      key = rec && rec.market ? canonicalRegion(rec.market) : null;
    } catch (_) { key = null; }
    marketOf.set(d.athlete_id, key);
  }
  // "<brand> | <region> | " is the prefix placesLookup._key builds; the version
  // suffix varies, so this matches the prefix and takes the freshest.
  const prefixes = [];
  for (const d of need) {
    const mk = marketOf.get(d.athlete_id);
    if (!mk) continue;
    d._placesPrefix = `${String(d.brand_name).trim().toLowerCase()} | ${String(mk).toLowerCase()} | `;
    prefixes.push(d._placesPrefix);
  }
  if (!prefixes.length) return;
  const rows = (await pool.query(
    `SELECT brand_key, evidence->>'address' AS address
       FROM brand_evidence_cache
      WHERE lane = 'places'
        AND evidence->>'address' IS NOT NULL
        AND LOWER(brand_key) LIKE ANY($1::text[])
      ORDER BY refreshed_at DESC`,
    [prefixes.map((p) => p + '%')])).rows;
  for (const d of need) {
    if (!d._placesPrefix) continue;
    const hit = rows.find((r) => String(r.brand_key).toLowerCase().startsWith(d._placesPrefix));
    if (hit) d.biz_address = hit.address;
    delete d._placesPrefix;
  }
}

function cityOf(address) {
  const s = String(address || '').trim();
  if (!s) return null;
  // "123 Main St, Auburn, AL 36830" -> "Auburn". Returns null rather than a
  // guess when the shape is not one we recognise.
  const m = s.match(/,\s*([^,]+?),\s*[A-Z]{2}\b/);
  return m ? m[1].trim() : null;
}

function recipientOf(d) {
  if (d.contact_name) {
    return { name: d.contact_name, title: d.contact_title || null, kind: 'person' };
  }
  if (d.email_kind === 'corporate') {
    return { name: 'the corporate inbox', title: null, kind: 'corporate' };
  }
  return { name: 'the general inbox', title: null, kind: 'inbox' };
}

// The held-back line. Counts by reason, leads with the biggest, and never names
// individual businesses -- that is what the link is for.
function summariseDropped(dropped) {
  const list = dropped || [];
  if (!list.length) return null;
  const byWhy = {};
  for (const d of list) byWhy[d.why] = (byWhy[d.why] || 0) + 1;
  const top = Object.keys(byWhy).sort((a, b) => byWhy[b] - byWhy[a])[0];
  const noAddress = list.filter((d) => /no email found/.test(d.why)).length;
  if (noAddress) {
    return {
      count: noAddress, total: list.length,
      line: `${noAddress} held back with no email address yet. They stay as DM or call cards.`,
    };
  }
  return { count: byWhy[top], total: list.length,
    line: `${byWhy[top]} held back: ${top}.` };
}

// ── The one decision ─────────────────────────────────────────────────────────
// approve everything in the batch except `skip`. The agent unchecks a few and
// approves the rest; that is the whole interaction.
// ── ONLY EMAIL DRAFTS COME THROUGH HERE ─────────────────────────────────────
//
// Home is a MIXED queue now: five cards an athlete drawn from outreach_logs
// (email drafts) and outreach_queue (call and DM cards). This function approves
// outreach_logs rows and nothing else, and the danger is that it cannot tell.
//
// outreach_logs.id is TEXT; outreach_queue.id is a SERIAL integer; the SELECT
// below matches `l.id = ANY($2::text[])`. Hand it a queue id and one of two
// things happens, both silent: it matches nothing and the card fails to approve
// with no error anywhere, or -- if a draft id ever collides with an integer --
// it approves an UNRELATED draft and a real email goes to a real business.
//
// So ids arrive namespaced (actionable.tagId) and anything not an email draft is
// REJECTED, not filtered. A filtered id is a no-op the caller reads as success;
// a thrown one reaches the agent as a sentence. The only tolerance is for a bare,
// unprefixed id: a page cached before this shipped posts those, and Home has only
// ever shown email drafts to such a page, so a bare id is read as an email draft.
function unwrapEmailIds(ids) {
  return (ids || []).map((raw) => {
    const { ns, rawId } = A.parseId(raw, A.NS.EMAIL);
    if (ns !== A.NS.EMAIL) {
      throw new A.BadId(
        `${raw} is a ${ns} card, not an email draft — it cannot be approved and sent. `
        + 'Call and DM cards are marked done on the card itself.');
    }
    return rawId;
  });
}

async function approveBatch(pool, agentId, opts = {}) {
  // THROWS BEFORE ANY WRITE. Both lists are unwrapped up front so a bad id in
  // the skip list cannot quietly widen what gets approved.
  const skip = new Set(unwrapEmailIds(opts.skip || []).map(String));
  const ids = unwrapEmailIds(opts.ids || []).map(String).filter((id) => !skip.has(id));
  if (!ids.length) return { approved: 0, scheduled: 0, skipped: skip.size, note: 'nothing approved' };
  // Home approves ONE athlete at a time, and the scoping is enforced here rather
  // than trusted from the id list the browser posted. A client that sends
  // somebody else's draft ids gets them filtered out, not approved.
  const athleteId = opts.athleteId ? String(opts.athleteId) : null;

  const guard = await sendGuard.status(pool, agentId, opts);
  if (guard.blocked) return { approved: 0, scheduled: 0, blocked: true, note: guard.blockedReason };

  // Never approve more than the ceiling allows, even if the client posts more.
  const allowed = ids.slice(0, guard.remaining);
  const overflow = ids.length - allowed.length;

  const rows = (await pool.query(
    `SELECT l.id, l.body_html, l.subject, l.athlete_id, l.brand_name,
            -- Carried so the pipeline row records who the email actually went
            -- to, rather than creating a board entry with no contact on it.
            -- sent_to_email is the only recipient column outreach_logs has;
            -- there is no to_email, and selecting one would throw here and take
            -- every approve down with it.
            l.sent_to_email,
            e.location AS biz_address, a.data->>'school' AS school
       FROM outreach_logs l
       JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN company_enrichment e ON e.id = l.enrichment_id
      WHERE l.agent_id = $1 AND l.id = ANY($2::text[])
        AND ($3::text IS NULL OR l.athlete_id = $3)
        AND l.status = 'draft' AND l.approved_at IS NULL
        AND l.cadence_stopped_at IS NULL`,
    [agentId, allowed, athleteId])).rows;

  // ── THE MEDIA KIT IS A SETTING, NOT A DECISION MADE 45 TIMES A MORNING ────
  // It used to be a per-send toggle in the outreach modal that appended a line
  // to the body by hand. Home has no per-card actions, so the choice moved to
  // where a choice like this belongs: once, on the account. Off by default.
  //
  // Appended at APPROVAL, not at draft time, so flipping the setting changes
  // what goes out tonight rather than only what is written from tomorrow.
  let kitByAthlete = null;
  if (rows.length) {
    const on = (await pool.query(
      `SELECT COALESCE(attach_media_kit, false) AS on FROM users WHERE id = $1`, [agentId])
      .catch(() => ({ rows: [] }))).rows[0];
    if (on && on.on) {
      kitByAthlete = new Map();
      const kits = (await pool.query(
        `SELECT athlete_id, slug FROM media_kits
          WHERE athlete_id = ANY($1::text[]) AND slug IS NOT NULL`,
        [Array.from(new Set(rows.map((r) => r.athlete_id)))]).catch(() => ({ rows: [] }))).rows;
      for (const k of kits) kitByAthlete.set(k.athlete_id, k.slug);
    }
  }
  const KIT_BASE = process.env.APP_URL || 'https://mynildash.com';
  const kitLineFor = (r) => {
    if (!kitByAthlete) return null;
    const slug = kitByAthlete.get(r.athlete_id);
    if (!slug) return null;                       // no kit built yet: nothing to attach
    const url = `${KIT_BASE}/kit/${slug}`;
    // Never twice. A draft that already carries the link keeps the one it has.
    if (r.body_html && r.body_html.indexOf(url) !== -1) return null;
    return `<p>Media kit: <a href="${url}">${url}</a></p>`;
  };

  let scheduled = 0;
  const when = [];
  // THE ARITHMETIC HAS TO CLOSE. This reported `approved` and `scheduled` and
  // nothing else, so three populations vanished between what the agent clicked
  // and what went out: ids over the cap (explained by `note`), ids the SELECT
  // filtered away (already approved, cadence-stopped, another athlete's), and
  // rows that got no send slot. An agent approving 64 must never be shown a
  // number that silently accounts for 36 of them.
  const dropped = [];
  const foundIds = new Set(rows.map((r) => String(r.id)));
  for (const id of allowed) {
    if (!foundIds.has(String(id))) {
      dropped.push({ id, why: 'not an approvable draft any more' });
    }
  }
  for (const r of rows) {
    // THE WINDOW IS COMPUTED PER MESSAGE, in the RECIPIENT's timezone, because
    // it is the business owner's Tuesday morning that matters and a roster can
    // span Oregon to New Jersey.
    const slot = sendWindow.nextSendSlot(opts.now || new Date(), {
      businessAddress: r.biz_address, athleteSchoolState: r.school, key: r.id,
    });
    if (!slot) { dropped.push({ id: r.id, brand: r.brand_name, why: 'no send slot in the next window' }); continue; }
    const kit = kitLineFor(r);
    await pool.query(
      `UPDATE outreach_logs
          SET status = 'approved', approved_at = NOW(), approved_by = $2,
              scheduled_send_at = $3, send_timezone = $4,
              body_html = COALESCE($5, body_html), updated_at = NOW()
        WHERE id = $1`,
      [r.id, agentId, slot.at, slot.timezone,
        kit ? String(r.body_html || '') + kit : null]);
    scheduled++;
    when.push({ id: r.id, brand: r.brand_name, at: slot.at, tz: slot.timezone });

    // ── THE QUEUE SLOT THIS DRAFT CAME FROM IS NOW WORKED ────────────────────
    // A nightly email card writes an outreach_logs draft and holds its id
    // (jobs/outreachQueue.insertCard). Approving the draft is the agent acting on
    // that card, so the slot frees the same way marking a DM sent frees one --
    // otherwise an email card would hold its slot forever and the athlete would
    // lose one of five for good.
    //
    // Best-effort: a failure here must not unschedule an email that is already
    // approved. It costs a slot until the next run, and it says so.
    await pool.query(
      `UPDATE outreach_queue
          SET state = 'sent', sent_at = NOW(), sent_via = 'email', updated_at = NOW()
        WHERE outreach_log_id = $1 AND state = 'queued'`, [r.id])
      .catch((e) => console.error('[closer] could not free the queue slot for ' + r.id + ':', e.message));

    // ── AND ONTO THE PIPELINE BOARD ────────────────────────────────────────
    // Approving is the agent acting on the card. It meant the same thing as
    // marking a DM sent and wrote nothing to any deal table, so an agent who
    // approved five drafts opened the Pipeline and found it empty. Forward-only,
    // so approving a follow-up to a brand already in Negotiating leaves it there.
    //
    // Best-effort, like the slot free above: an email that is already scheduled
    // must not be unscheduled because a board write failed. The backfill can
    // recover a missing row; it cannot un-send an email.
    try {
      await PIPE.enterOutreachSent(pool, {
        athleteId: r.athlete_id, agentId,
        brandName: r.brand_name,
        contactEmail: r.sent_to_email || null,
        note: 'Email approved and scheduled',
        source: 'outreach_logs',
      });
    } catch (e) {
      console.error('[closer] pipeline write failed for ' + r.id + ':', e.message);
    }
  }
  // Every id posted lands in exactly one bucket: scheduled, unchecked, over the
  // cap, or dropped with a reason. scheduled + skipped + overflow + dropped
  // equals what came in, and the note says so in words.
  const bits = [];
  if (overflow > 0) {
    bits.push(`${overflow} left for tomorrow: approving them would have gone past tonight's ${guard.cap}-email ceiling`);
  }
  if (dropped.length) {
    const noSlot = dropped.filter((d) => /send slot/.test(d.why)).length;
    if (noSlot) bits.push(`${noSlot} had no send time in the next window and stay as drafts`);
    const stale = dropped.length - noSlot;
    if (stale) bits.push(`${stale} were no longer waiting on approval`);
  }
  return {
    approved: rows.length, scheduled, skipped: skip.size, overflow,
    dropped, requested: ids.length, when,
    note: bits.length
      ? bits.join('. ').replace(/^./, (ch) => ch.toUpperCase()) + '.'
      : null,
  };
}

// ── RELEASE: the job that actually sends ─────────────────────────────────────
// Nothing read scheduled_send_at before this existed. Runs on a tick, sends what
// is due and inside the window, and stops the moment the provider says stop.
// ── THE GATE, in one function ────────────────────────────────────────────────
// Returns { clear } and nothing else matters to the caller. Every branch that is
// not an explicit pass returns clear:false, including the ones that error.
//
// ORDER MATTERS. It reads the RECORD first, not the rules: an agent who
// overrode a hold this morning must not be stopped by the same rule this
// evening, and a hard block must not be walkable by re-running the gate against
// changed data. The record is the decision; evaluate() only creates it.
const RANK = { pass: -1, note: 0, hold: 1, block: 2 };

async function complianceGate(pool, log, opts = {}) {
  const compliance = require('./compliance');

  // 1. Anything already open on this outreach stops it, whatever it is.
  const open = await compliance.openHoldsFor(pool, log.id);
  if (open.length) {
    const blocking = open.find((h) => h.severity === 'block') || open[0];
    return { clear: false, severity: blocking.severity,
      why: `${blocking.rule_label}: ${blocking.reason}` };
  }

  // 2. Evaluate. This cannot throw -- it returns a hold instead -- but the
  //    caller wraps it anyway, because "cannot throw" is a claim about today's
  //    code and the fail-closed guarantee should not depend on it staying true.
  // State rules for this athlete's state, if any have been entered. The table
  // ships empty, so this is normally {} and the gate behaves exactly as it does
  // today -- holding. It is loaded before evaluate() rather than inside it so a
  // lookup failure is visible here and holds, instead of being swallowed.
  const stateRule = {};
  const stateCode = compliance.stateCodeForSchool(log.school);
  if (stateCode) {
    for (const c of compliance.CATEGORIES) {
      const row = await compliance.stateRuleFor(pool, stateCode, c.key);
      if (row) stateRule[c.key] = row;
    }
  }

  let result = await compliance.evaluate(pool, {
    stateRule, stateCode,
    brandName: log.brand_name,
    evidence: log.places_evidence || null,
    dob: log.dob || null,
    // Used only when dob is absent. The agent attests their own client is 18+;
    // a date of birth, when we have one, always wins over it.
    over18: log.over18 === true || log.over18 === 'true' ? true
      : (log.over18 === false || log.over18 === 'false' ? false : undefined),
    // Carried so the gate can tell "this athlete has no birthday on file" from
    // "this athlete does not exist". Different faults, different fixes, and they
    // must not both read as a hold.
    athleteUnreadable: !!log.athlete_missing,
    athleteUnreadableDetail: log.athlete_missing
      ? `outreach_logs row ${log.id} points at athlete_id ${log.athlete_id}, which has no row in athletes`
      : null,
    schoolRestrictions: log.school_restrictions || [],
    athleteName: log.athlete_name || null,
    school: log.school || null,
    now: opts.now,
  });

  if (result.decision === 'pass') return { clear: true };

  // 3. DROP FINDINGS THE AGENT HAS ALREADY DECIDED. An override that the gate
  //    re-derives on the next tick is not an override -- the hold would resolve
  //    and immediately reappear from the same unchanged data, forever. A BLOCK
  //    can never reach here as overridden: overrideHold refuses to resolve one.
  const decided = await compliance.overriddenRulesFor(pool, log.id);
  if (decided.size) {
    result = Object.assign({}, result, {
      findings: result.findings.filter((f) => !decided.has(f.ruleKey)),
    });
    if (!result.findings.length) return { clear: true };
    result.decision = result.findings.reduce(
      (acc, f) => (RANK[f.severity] > RANK[acc] ? f.severity : acc), 'pass');
    if (result.decision === 'pass') return { clear: true };
  }

  // 4. WRITE BEFORE DECIDING. If the record cannot be written the send does not
  //    happen: an unrecorded hold is indistinguishable from no hold at all, and
  //    the record is the whole point.
  await compliance.recordFindings(pool, {
    agentId: log.agent_id, athleteId: log.athlete_id, outreachLogId: log.id,
    brandName: log.brand_name, brandKey: log.brand_key,
    evidence: log.places_evidence || null, dob: log.dob || null,
    schoolRestrictions: log.school_restrictions || [],
    school: log.school || null, stateCode, now: opts.now,
  }, result);

  // A note proceeds. It is on the record and it does not stop anything.
  if (result.decision === 'note') return { clear: true, noted: true };

  const worstFinding = result.findings.find((f) => f.severity === 'block')
    || result.findings.find((f) => f.severity === 'hold');
  return { clear: false, severity: result.decision,
    why: `${worstFinding.ruleLabel}: ${worstFinding.reason}` };
}

async function releaseDue(pool, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const limit = opts.limit || 200;
  const sendFn = opts.send;      // injected: (log) => provider result
  if (typeof sendFn !== 'function') throw new Error('releaseDue needs a send function');

  const due = (await pool.query(
    `SELECT l.*, a.data->>'name' AS athlete_name, e.location AS biz_address,
            a.data->>'school' AS school, a.data->>'dob' AS dob,
            a.data->>'over18' AS over18,
            a.data->'schoolRestrictions' AS school_restrictions,
            -- The Places record for this business, for the compliance gate. Same
            -- join buildBatch already uses for the address; lane='places'
            -- evidence carries types and primaryType.
            -- WHETHER THE ATHLETE ROW EXISTS AT ALL, distinct from whether its
            -- fields are populated. See the LEFT JOIN below.
            (a.id IS NULL) AS athlete_missing,
            (SELECT b.evidence FROM brand_evidence_cache b
              WHERE b.lane = 'places' AND LOWER(b.brand) = LOWER(l.brand_name)
              ORDER BY b.refreshed_at DESC LIMIT 1) AS places_evidence
       FROM outreach_logs l
       -- LEFT JOIN, DELIBERATELY. An inner join makes a draft whose athlete row
       -- is missing DISAPPEAR from this query -- not held, not failed, not
       -- counted: absent. The send loop never sees it and nothing anywhere says
       -- a draft was skipped. If the roster table were empty this query would
       -- return zero rows and the whole send path would look idle and healthy.
       -- A missing athlete has to arrive here so it can be reported as a fault.
       LEFT JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN company_enrichment e ON e.id = l.enrichment_id
      WHERE l.status = 'approved'
        AND l.scheduled_send_at IS NOT NULL
        AND l.scheduled_send_at <= $1
        AND l.cadence_stopped_at IS NULL
      ORDER BY l.scheduled_send_at ASC
      LIMIT $2`, [now, limit])).rows;

  const out = { considered: due.length, sent: 0, held: 0, failed: 0, stoppedAgents: [], detail: [] };
  const blockedAgents = new Set();

  for (const log of due) {
    if (blockedAgents.has(log.agent_id)) { out.held++; continue; }

    // Late guards. All three can have become true since approval: the recipient
    // may have replied, the address may have bounced for another athlete, and
    // the window may have closed while the queue drained.
    if (log.replied_at) {
      await stop(pool, log, 'they replied before this went out');
      out.held++; out.detail.push({ id: log.id, result: 'stopped', why: 'replied first' });
      continue;
    }
    const sup = await suppression.isSuppressed(pool, log.sent_to_email || log.to_email);
    if (sup.suppressed) {
      await stop(pool, log, sup.reason);
      out.held++; out.detail.push({ id: log.id, result: 'stopped', why: sup.reason });
      continue;
    }
    // ── THE COMPLIANCE GATE ──────────────────────────────────────────────
    // BEFORE the reservation, because a held message must not consume the day's
    // allowance. This is the only place the provider is called from, so this is
    // the only place the gate has to be -- and it is a gate, not a warning:
    // nothing below runs unless it returns clear.
    //
    // FAIL CLOSED, TWICE OVER. compliance.evaluate() cannot throw and returns a
    // hold on any internal failure; and this block is itself wrapped, so a
    // failure to REACH it, record it, or read it back still holds. There is no
    // path from "the check errored" to "the email went out".
    let gate;
    try {
      gate = await complianceGate(pool, log, opts);
    } catch (e) {
      console.error(`[closer] compliance gate failed for ${log.id}, holding:`, e.message);
      gate = { clear: false, why: 'the compliance check could not run: ' + e.message, severity: 'hold' };
    }
    if (!gate.clear) {
      out.held++;
      out.compliance = (out.compliance || 0) + 1;
      out.detail.push({ id: log.id, result: 'held', why: gate.why, compliance: gate.severity });
      continue;
    }

    // THE WINDOW COMES AFTER COMPLIANCE. It used to come first, and that meant a
    // hold was not RECORDED until the send window happened to open -- a pitch
    // held on a Friday evening would not reach the agent's report until Monday.
    // Compliance is a fact about the message; the window is only about timing.
    if (!sendWindow.isSendable(now, {
      businessAddress: log.biz_address, athleteSchoolState: log.school,
    })) {
      out.held++; out.detail.push({ id: log.id, result: 'held', why: 'outside the send window' });
      continue;
    }

    // RESERVE BEFORE SENDING. The reservation is the cap.
    const res = await sendGuard.reserve(pool, log.agent_id, opts);
    if (!res.ok) {
      blockedAgents.add(log.agent_id);
      out.held++;
      out.detail.push({ id: log.id, result: 'held', why: res.reason });
      continue;
    }

    const attempt = await sendGuard.sendWithRetry(() => sendFn(log), {
      sleep: opts.sleep, rnd: opts.rnd,
      onQuota: async (c) => {
        // The provider refused on quota. Stop this agent for the rest of the
        // day rather than walking the rest of their batch into the same wall --
        // retrying into a 403 is how a short refusal becomes a long one.
        blockedAgents.add(log.agent_id);
        out.stoppedAgents.push({ agentId: log.agent_id, why: c.detail });
        await sendGuard.blockForDay(pool, log.agent_id, c.detail, opts);
      },
      onRetry: (r) => console.log(`[closer] ${log.id} rate-limited, waiting ${r.waitMs}ms (attempt ${r.attempt})`),
    });

    if (attempt.ok) {
      const r = attempt.result || {};
      await pool.query(
        `UPDATE outreach_logs
            SET status='sent', sent_at=NOW(), email_message_id=$2, message_id=$3,
                reply_to=$4, sent_to_email=$5, send_attempts=$6, send_error=NULL,
                updated_at=NOW()
          WHERE id=$1`,
        [log.id, r.providerMessageId || null, r.messageId || null, r.replyTo || null,
         suppression.normalize(log.sent_to_email || log.to_email), attempt.attempts]);
      out.sent++;
      out.detail.push({ id: log.id, result: 'sent', brand: log.brand_name });
      await scheduleNextTouch(pool, log, opts).catch((e) =>
        console.error('[closer] next touch failed:', e.message));
    } else {
      // THE RESERVATION GOES BACK. A failed send did not consume reputation and
      // must not consume the allowance either.
      await sendGuard.release(pool, log.agent_id, opts);
      out.failed++;
      await pool.query(
        `UPDATE outreach_logs SET send_error=$2, send_attempts=$3, updated_at=NOW() WHERE id=$1`,
        [log.id, String(attempt.detail || attempt.kind).slice(0, 300), attempt.attempts]).catch(() => {});
      if (attempt.kind === 'auth' || attempt.kind === 'quota') blockedAgents.add(log.agent_id);
      out.detail.push({ id: log.id, result: 'failed', why: attempt.detail || attempt.kind });
    }
  }
  return out;
}

async function stop(pool, log, reason) {
  await pool.query(
    `UPDATE outreach_logs SET cadence_stopped_at=NOW(), cadence_stop_reason=$2, updated_at=NOW()
      WHERE id=$1 AND cadence_stopped_at IS NULL`,
    [log.id, String(reason || 'stopped').slice(0, 300)]).catch(() => {});
  await suppression.stopCadence(pool, log, reason).catch(() => {});
}

// ── The next touch ───────────────────────────────────────────────────────────
// Written as a draft at send time so it is visible in tomorrow's batch and the
// agent can uncheck it. NOT auto-sent -- it goes through the same one decision.
async function scheduleNextTouch(pool, log, opts = {}) {
  const touch = Number(log.touch_no || 1);
  if (touch >= MAX_TOUCHES) return null;
  const next = CADENCE.find((c) => c.touch === touch + 1);
  if (!next) return null;

  const root = log.parent_id || log.id;
  const id = `${root}-t${next.touch}`;
  const dueAt = new Date((opts.now ? new Date(opts.now) : new Date()).getTime()
    + next.afterDays * 86400000);

  await pool.query(
    `INSERT INTO outreach_logs
       (id, agent_id, athlete_id, brand_name, brand_key, contact_id, enrichment_id,
        subject, body_html, status, touch_no, parent_id, sent_to_email,
        angle, angle_key, category_key, next_follow_up_at, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13,$14,$15,$16,'closer-cadence')
     ON CONFLICT (id) DO NOTHING`,
    [id, log.agent_id, log.athlete_id, log.brand_name, log.brand_key, log.contact_id,
     log.enrichment_id, followUpSubject(log.subject), null, next.touch, root,
     log.sent_to_email, log.angle, log.angle_key, log.category_key, dueAt]
  ).catch((e) => console.error('[closer] could not queue the next touch:', e.message));
  return { id, touch: next.touch, dueAt };
}

function followUpSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Following up';
  return /^re:/i.test(s) ? s : 'Re: ' + s;
}

// ── Auto mode, earned ────────────────────────────────────────────────────────
// Not offered until the agent has approved AUTO_MODE_THRESHOLD pitches without
// editing any of them. The progress is shown so the offer arrives as something
// they have built up to rather than a checkbox asking for trust on day one.
async function autoModeProgress(pool, agentId) {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS approved,
              COUNT(*) FILTER (WHERE edited_before_approval)::int AS edited
         FROM outreach_logs
        WHERE agent_id = $1 AND approved_at IS NOT NULL`, [agentId]);
    const approved = Number(r.rows[0].approved) || 0;
    const edited = Number(r.rows[0].edited) || 0;
    const clean = approved - edited;
    return {
      approved, edited, clean,
      threshold: AUTO_MODE_THRESHOLD,
      eligible: edited === 0 && approved >= AUTO_MODE_THRESHOLD,
      remaining: Math.max(0, AUTO_MODE_THRESHOLD - clean),
      // An edit is not a permanent disqualification, but it does mean the run of
      // untouched approvals starts again -- that run is the entire evidence.
      note: edited > 0
        ? `${edited} of ${approved} approved pitches were edited first, so the writing is not being trusted unedited yet`
        : null,
    };
  } catch (e) {
    console.error('[closer] autoModeProgress:', e.message);
    return { approved: 0, edited: 0, clean: 0, threshold: AUTO_MODE_THRESHOLD,
      eligible: false, remaining: AUTO_MODE_THRESHOLD, note: null };
  }
}

async function autoModeFor(pool, agentId) {
  try {
    const r = await pool.query(
      `SELECT scope_kind, scope_id FROM agent_auto_mode WHERE agent_id = $1`, [agentId]);
    const athletes = new Set(), lanes = new Set();
    for (const row of r.rows) {
      if (row.scope_kind === 'athlete') athletes.add(row.scope_id);
      else if (row.scope_kind === 'lane') lanes.add(row.scope_id);
    }
    return { athletes, lanes, any: r.rows.length > 0 };
  } catch (_) { return { athletes: new Set(), lanes: new Set(), any: false }; }
}

// Is THIS message covered by auto mode? Never global: an agent who switched one
// athlete on has not switched the roster on.
function isAuto(auto, row) {
  if (!auto || !auto.any) return false;
  if (row.athlete_id && auto.athletes.has(row.athlete_id)) return true;
  return auto.lanes.has(laneOf(row));
}

async function setAutoMode(pool, agentId, { scopeKind, scopeId, enabled }) {
  if (scopeKind !== 'athlete' && scopeKind !== 'lane') {
    return { ok: false, error: 'auto mode is per athlete or per lane, never global' };
  }
  const progress = await autoModeProgress(pool, agentId);
  if (enabled && !progress.eligible) {
    return { ok: false, error: `auto mode unlocks after ${AUTO_MODE_THRESHOLD} approvals with no edits `
      + `(${progress.clean} so far)`, progress };
  }
  if (enabled) {
    await pool.query(
      `INSERT INTO agent_auto_mode (agent_id, scope_kind, scope_id) VALUES ($1,$2,$3)
       ON CONFLICT (agent_id, scope_kind, scope_id) DO NOTHING`, [agentId, scopeKind, scopeId]);
  } else {
    await pool.query(
      `DELETE FROM agent_auto_mode WHERE agent_id=$1 AND scope_kind=$2 AND scope_id=$3`,
      [agentId, scopeKind, scopeId]);
  }
  return { ok: true, progress };
}

module.exports = {
  buildBatch, laneLabel, cityOf, recipientOf, summariseDropped, approveBatch, releaseDue, scheduleNextTouch, stop,
  complianceGate,
  autoModeProgress, autoModeFor, isAuto, setAutoMode, followUpSubject,
  CADENCE, MAX_TOUCHES, AUTO_MODE_THRESHOLD,
};
