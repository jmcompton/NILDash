'use strict';
// HOME IS ONE JOB: APPROVE TODAY'S OUTREACH.
//
// Athlete tabs, that athlete's cards, one approve. A card is three lines --
// the business, the person, and one sentence on why this pairing. Everything
// else that used to live on Home moved or went: the shift-report headline,
// coverage counts, the ready-to-send list, the weekly floor, the admin
// dropdown, the fill button. The rule they went by: if an agent who has never
// seen the codebase cannot understand it in three seconds, it does not belong.
//
// ── THE WHY SENTENCE IS DERIVED, NEVER GENERATED ────────────────────────────
//
// There is no model call anywhere in this file, and that is a decision rather
// than an optimisation. Two reasons:
//
//   PAYING TWICE. The reasoning already exists. brand_match_scores.reasoning is
//   why the Scout paired this brand with this athlete; outreach_queue.why is why
//   the card was built; the pitch body is that reasoning already written out for
//   a human. Asking a model to summarise them buys nothing we do not hold.
//
//   DRIFT. A generated summary is a second, independent statement about the
//   pairing. It can disagree with the pitch it sits above -- and the agent
//   approves on the strength of the summary while the business receives the
//   pitch. A derived sentence cannot drift from its source because it IS its
//   source, trimmed.
//
// PREFERENCE ORDER, richest first:
//   1. the pitch's opening line   -- what the business will actually read
//   2. the stored match reasoning -- why the pairing was made
//   3. the card's own `why`       -- why the card was built
// Two and three are combined when neither is substantial alone. Nothing is
// invented: a card with no usable source shows two lines, not a filled-in one.

// Home shows five cards per athlete and no more. The cap of five that already
// existed is on outreach_queue -- the RESEARCH pile -- while drafts live in
// outreach_logs with no cap at all, so a roster nobody worked for a fortnight
// arrived at Home with 14 and 63 cards on two athletes. A page carrying 63
// decisions is not a page carrying one.
const SHOWN_MAX = parseInt(process.env.HOME_CARDS_PER_ATHLETE, 10) || 5;

// OVER-FETCH, WITH A CEILING. The gate below throws cards away -- no address, a
// bounced one, one the verifier called undeliverable -- so fetching exactly five
// would hand back three. Fetching to backfill is right; fetching without a
// ceiling is how one athlete's page starts addressing and verifying a pile of
// sixty. Three slates is the compromise: enough that a normal night still fills
// the page, few enough that the worst case is bounded and knowable.
const FETCH_MAX = Math.min(
  parseInt(process.env.HOME_FETCH_MULTIPLIER, 10) || 3, 6) * SHOWN_MAX;

// A page load, not a batch job. The whole addressing pass gets this long and
// then reports what it has.
const ATTACH_DEADLINE_MS = parseInt(process.env.HOME_ATTACH_DEADLINE_MS, 10) || 2500;

// The same screen the scraper uses, so "a usable address" means one thing in
// this codebase rather than two. Wrapped because siteEmail opens a pg pool at
// require time and a page builder has no business dragging one in on a bad day.
function screen(addr) {
  try {
    return require('./siteEmail').screenEmail(addr, null);
  } catch (e) {
    return { ok: true };   // cannot screen: do not invent a rejection
  }
}

// Three states, three different sentences, and only one of them is entitled to
// say anything about the business's mail server.
function verifyNote(v) {
  if (!v) return 'Not checked yet';
  if (v.result === 'valid') return 'Mailbox confirmed';
  if (v.result === 'unknown' && v.source === 'hunter') {
    return 'Not confirmed — this domain accepts all mail, so no check can tell';
  }
  return 'Not checked yet';
}

const MIN_USEFUL = 40;       // shorter than this says nothing an agent can act on
const MAX_LEN = 220;         // longer than this is not a three-second read

// Openers that are throat-clearing rather than a reason. If the first sentence
// is one of these the next one is taken instead.
const FILLER_RE = /^(hi|hey|hello|dear|good (morning|afternoon|evening))\b|^i hope\b|^hope (you|this)\b|^my name is\b|^i'?m reaching out\b|^just reaching out\b|^i wanted to reach\b/i;

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// Split on sentence ends, but not on the dot in "Liquid I.V." or "Mr. Horn".
function sentences(text) {
  return String(text || '')
    .split(/(?<![A-Z])(?<!\b[A-Z][a-z])(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tidy(s) {
  let out = String(s || '').replace(/\s+/g, ' ').trim();
  if (!out) return null;
  if (out.length > MAX_LEN) {
    // Cut at the last sentence end inside the limit, else the last word. Never
    // mid-word, and never with an ellipsis pretending there is more to read.
    const slice = out.slice(0, MAX_LEN);
    const stop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
    out = stop > MIN_USEFUL ? slice.slice(0, stop + 1) : slice.slice(0, slice.lastIndexOf(' ')) + '…';
  }
  if (!/[.!?…]$/.test(out)) out += '.';
  return out;
}

// The first sentence of the pitch that is actually about the business.
//
// LINES FIRST, THEN SENTENCES. A greeting ends in a COMMA, not a full stop, so
// splitting the pitch on sentence punctuation alone glues "Hi Chris," onto the
// first real sentence -- the whole thing then trips the filler test and a
// perfectly good pitch line falls through to the weaker stored `why`. stripHtml
// already turns each <p> into its own line, which is exactly the boundary a
// greeting sits on.
function fromPitch(bodyHtml) {
  const text = stripHtml(bodyHtml);
  if (!text) return null;
  const units = text.split('\n').flatMap((line) => sentences(line));
  for (const s of units.slice(0, 6)) {
    if (s.length < MIN_USEFUL) continue;
    if (FILLER_RE.test(s)) continue;
    return tidy(s);
  }
  return null;
}

// why + reasoning, whichever carries more. Combined only when neither stands up
// on its own, and only when they are not saying the same thing twice.
function fromStored(why, reasoning) {
  const a = tidy(why), b = tidy(reasoning);
  if (a && b) {
    const overlap = a.toLowerCase().slice(0, 30) === b.toLowerCase().slice(0, 30);
    if (overlap) return a.length >= b.length ? a : b;
    if (Math.max(a.length, b.length) >= MIN_USEFUL * 2) return a.length >= b.length ? a : b;
    return tidy(a.replace(/[.!?]$/, '') + '. ' + b);
  }
  return a || b || null;
}

// { text, from } -- `from` names the source so a bad sentence is traceable to
// the row that produced it rather than guessed at.
function deriveWhy(card) {
  const c = card || {};
  const pitch = fromPitch(c.body_html);
  if (pitch) return { text: pitch, from: 'pitch' };
  const stored = fromStored(c.why, c.reasoning);
  if (stored) return { text: stored, from: c.why && c.reasoning ? 'why+match' : (c.why ? 'why' : 'match') };
  return { text: null, from: null };
}

// ── The payload Home renders ────────────────────────────────────────────────
// One query per concern, no per-card work. Athletes carry their own count so the
// tabs need nothing else; cards are only built for the athlete being shown.
async function buildHome(pool, agentId, opts = {}) {
  // A SWALLOWED QUERY MUST NOT LOOK LIKE AN EMPTY QUEUE. Every read here is
  // wrapped, and a wrapped read that throws returns [] -- which renders as
  // "nothing to approve today", the same thing a genuinely clear morning
  // renders. One typo in a column name and the agent is told there is no work.
  // Errors are collected and returned so the page can say the difference.
  const errs = [];
  const q = async (label, sql, params) => {
    try { return (await pool.query(sql, params)).rows; } catch (e) {
      console.error('[home] ' + label + ': ' + e.message);
      errs.push(label + ': ' + e.message);
      return [];
    }
  };

  const athletes = await q('athletes',
    `SELECT a.id, a.data->>'name' AS name, a.data->>'school' AS school,
            a.data->>'dob' AS dob,
            COUNT(l.id) FILTER (
              WHERE l.status = 'draft' AND l.approved_at IS NULL
                AND l.cadence_stopped_at IS NULL)::int AS pending
       FROM athletes a
       LEFT JOIN outreach_logs l ON l.athlete_id = a.id AND l.agent_id = $1
      WHERE a.agent_id = $1
      GROUP BY a.id, a.data
      ORDER BY a.created_at ASC`, [agentId]);

  const selected = opts.athleteId
    || (athletes.find((a) => a.pending > 0) || athletes[0] || {}).id
    || null;

  let cards = [];
  let pendingTotal = 0;
  if (selected) {
    cards = await q('cards',
      `SELECT l.id, l.brand_name, l.body_html, l.subject,
              l.edited_before_approval,
              l.sent_to_email AS to_email,
              l.athlete_id,
              q.contact_name, q.contact_title, q.why,
              m.reasoning, m.compatibility_score
         FROM outreach_logs l
         LEFT JOIN LATERAL (
           SELECT contact_name, contact_title, why FROM outreach_queue q2
            WHERE q2.athlete_id = l.athlete_id
              AND LOWER(q2.brand_name) = LOWER(l.brand_name)
            ORDER BY q2.created_at DESC LIMIT 1
         ) q ON TRUE
         LEFT JOIN LATERAL (
           SELECT reasoning, compatibility_score FROM brand_match_scores m2
            WHERE m2.agent_id = l.agent_id AND m2.athlete_id = l.athlete_id
              AND LOWER(m2.brand_name) = LOWER(l.brand_name)
            ORDER BY m2.created_at DESC LIMIT 1
         ) m ON TRUE
        WHERE l.agent_id = $1 AND l.athlete_id = $2
          AND l.status = 'draft' AND l.approved_at IS NULL
          AND l.cadence_stopped_at IS NULL
        -- FIVE, HIGHEST FIT FIRST. The cap of five is on outreach_queue, which
        -- is the RESEARCH pile; drafts live in outreach_logs and have no cap at
        -- all, so an athlete nobody worked for a fortnight arrived at Home with
        -- 63 cards. A page with 63 decisions on it is not a page with one.
        -- Ordered by the match score the Scout already computed, then oldest
        -- first so the tie-break is stable and a draft cannot jump the queue by
        -- being rewritten.
        ORDER BY m.compatibility_score DESC NULLS LAST, l.created_at ASC
        LIMIT $3`, [agentId, selected, FETCH_MAX]);
    const t = await q('pending-total',
      `SELECT COUNT(*)::int AS n FROM outreach_logs
        WHERE agent_id = $1 AND athlete_id = $2 AND status = 'draft'
          AND approved_at IS NULL AND cadence_stopped_at IS NULL`, [agentId, selected]);
    pendingTotal = (t[0] && t[0].n) || 0;
  }

  // ── ADDRESS THE DRAFTS BEFORE JUDGING THEM ────────────────────────────────
  //
  // THIS IS A WORKAROUND. It is not the fix, and it should not be allowed to
  // become one by sitting here quietly. See docs/known-issues.md, "Draft
  // addressing races the contact ladder".
  //
  // The root cause is ordering, not this file. draftPrewarm.draftOne calls
  // draftAddress.lookupOne AFTER its model call -- five to fifteen seconds in --
  // while ladderPrewarm.warmOne, the only thing that runs the deep lookup that
  // WRITES the siteemail row that lookupOne reads, takes about thirty. Both are
  // fired at the same moment after the scan response. So the draft reads the
  // cache before the ladder has written to it, and is born with no address. On
  // top of that ladderPrewarm only warms TOP_N = 3 cards per lane while
  // draftPrewarm drafts 12, so nine of every twelve never had an address source
  // created for them at all.
  //
  // Calling attach here papers over both: by the time an agent opens Home the
  // ladder has long since finished, so the row that was missing at insert is
  // usually there now. The real fix is to make the draft wait for, or trigger,
  // its own address lookup -- at which point this call becomes a cheap no-op
  // rather than the thing holding the feature up.
  let verifyBudget = null;
  if (cards.length && selected) {
    try {
      const DA = require('./draftAddress');
      const VB = require('./verifyBudget');
      const res = await DA.attach(pool, {
        agentId,
        ids: cards.map((c) => c.id),
        athleteId: selected,
        budget: VB.PER_ATHLETE_DAY,
        // A PAGE LOAD, NOT A BATCH JOB. Past this the remaining addresses come
        // back `unknown`, which shows the card and marks it unverified. An agent
        // staring at a spinner because a resolver is slow is a worse outcome
        // than a card that says what it does not know.
        deadlineMs: ATTACH_DEADLINE_MS,
      });
      // Surfaced on the payload, not just in a log. An account ceiling that only
      // announces itself in stdout is a ceiling nobody finds out about until the
      // cards quietly stop being verified.
      if (res && res.budget && res.budget.account && res.budget.account.low) {
        verifyBudget = res.budget.account;
      }
      if (res && res.attached) {
        // Re-read only what changed, rather than re-running the whole card query.
        const filled = await q('addressed',
          `SELECT id, sent_to_email FROM outreach_logs WHERE id = ANY($1::text[])`,
          [cards.map((c) => c.id)]);
        const byId = new Map(filled.map((r) => [r.id, r.sent_to_email]));
        for (const c of cards) if (byId.has(c.id)) c.to_email = byId.get(c.id);
      }
    } catch (e) {
      // An addressing pass that could not run must not empty the page. The gate
      // below still holds; the cards simply arrive as they were.
      errs.push('addressing: ' + e.message);
    }
  }

  // ── A KNOWN-BAD ADDRESS NEVER REACHES A CARD ──────────────────────────────
  // Two ways an address is known bad before anybody looks at it:
  //
  //   SUPPRESSED  it bounced. That is not an opinion, it is a fact the mail
  //               server told us. closer.buildBatch checked this and Home did
  //               not, so a bounced address could be approved again -- the
  //               fastest way there is to lose the sending reputation the
  //               40-a-night ceiling exists to protect.
  //   VERIFIED    the verifier said undeliverable. Only a definite NO holds a
  //               card back; accept-all and unknown do not (see below), because
  //               catch-all domains are disproportionately the small local
  //               businesses this product exists to reach.
  //
  // Held back, counted and reported -- never silently dropped. A card that
  // vanishes with no explanation is how a roster quietly stops being worked.
  const withheld = [];
  if (cards.length) {
    const addrs = cards.map((c) => c.to_email).filter(Boolean);
    let suppressed = new Set();
    if (addrs.length) {
      try {
        const suppression = require('./suppression');
        suppressed = await suppression.suppressedSet(pool, addrs);
      } catch (e) { errs.push('suppression: ' + e.message); }
    }
    const verdicts = new Map();
    if (addrs.length) {
      // SOURCE AS WELL AS RESULT. Without it every unchecked address looked
      // identical to a checked catch-all, and the card said so out loud -- "this
      // domain accepts all mail, so no check can tell" -- about businesses
      // nobody had checked. That is an unfounded claim about someone's mail
      // server, and it is the difference between "we asked and could not tell"
      // and "we never asked".
      for (const r of await q('verification',
        `SELECT email, result, source FROM email_verification WHERE email = ANY($1::text[])`,
        [addrs.map((a) => String(a).trim().toLowerCase())])) {
        verdicts.set(r.email, { result: r.result, source: r.source });
      }
    }
    cards = cards.filter((c) => {
      const a = c.to_email ? String(c.to_email).trim().toLowerCase() : null;
      // NO ADDRESS IS NOT A PASS. Both guards below were written `if (a && ...)`
      // to catch a known-BAD address, and a card with NO address fell straight
      // through the middle of them onto the page -- an approve button over an
      // empty recipient. This is the gate that was missing.
      if (!a) {
        withheld.push({ business: c.brand_name, why: 'no email address found for this business yet' });
        return false;
      }
      // Shape, role words and domain match, from the screen the scraper already
      // uses. One definition of "usable address" in the codebase, not two.
      const s = screen(a);
      if (!s.ok) {
        withheld.push({ business: c.brand_name, why: s.reason });
        return false;
      }
      if (suppressed.has(a)) {
        withheld.push({ business: c.brand_name, why: 'this address bounced before' });
        return false;
      }
      if ((verdicts.get(a) || {}).result === 'invalid') {
        withheld.push({ business: c.brand_name, why: 'the address does not accept mail' });
        return false;
      }
      // Everything else rides, carrying what we know about it.
      c._verified = verdicts.get(a) || null;
      return true;
    });
    // BACK DOWN TO THE SLATE. The query over-fetched so the filter could throw
    // work away and still leave five; anything past five waits for tomorrow.
    if (cards.length > SHOWN_MAX) cards = cards.slice(0, SHOWN_MAX);
  }

  // ── WHAT WILL ACTUALLY BE SENT ────────────────────────────────────────────
  // The media kit is appended at APPROVAL by closer.approveBatch, so the card
  // has to know the same answer or the preview shows one email and the business
  // receives another. Same two reads, same rule: the setting is on, and this
  // athlete has a kit built.
  let kitUrl = null;
  if (cards.length && selected) {
    const on = (await q('kit-setting', `SELECT COALESCE(attach_media_kit, false) AS on FROM users WHERE id = $1`, [agentId]))[0];
    if (on && on.on) {
      const k = (await q('kit-slug', `SELECT slug FROM media_kits WHERE athlete_id = $1 AND slug IS NOT NULL LIMIT 1`, [selected]))[0];
      if (k && k.slug) kitUrl = `${process.env.APP_URL || 'https://mynildash.com'}/kit/${k.slug}`;
    }
  }

  const who = athletes.find((a) => a.id === selected) || null;

  // THE ONLY BLOCKING LINE ON THE PAGE, and only when it blocks. The compliance
  // gate needs a date of birth to decide anything, so without one nothing for
  // this athlete can be approved. Named as the thing to fix, not as a status.
  const blocked = !!(who && !who.dob);

  return {
    // The tab count MATCHES THE SCREEN. Showing 63 on a tab that renders five
    // is the same defect as the shift report's two counts of one pile. The true
    // backlog is reported separately, per athlete, and said in words below the
    // name rather than as a second number competing with the first.
    athletes: athletes.map((a) => ({
      id: a.id, name: a.name,
      count: Math.min(a.pending, SHOWN_MAX), pending: a.pending,
    })),
    selected,
    athlete: who ? { id: who.id, name: who.name, school: who.school } : null,
    // Written without a pronoun. We do not hold one for an athlete, and a
    // blocking line on the one page an agent reads every morning is the last
    // place to guess at one.
    blocker: blocked
      ? { text: `${(who.name || 'This athlete').split(' ')[0]} has no date of birth on file, `
          + 'so nothing can be approved yet.', cta: 'Add it', href: '/?view=athletes' }
      : null,
    cards: cards.map((c) => {
      const w = deriveWhy(c);
      return {
        id: c.id,
        business: c.brand_name,
        contact: c.contact_name || null,
        role: c.contact_title || null,
        why: w.text,
        whyFrom: w.from,
        // ── THE EMAIL ITSELF ─────────────────────────────────────────────
        // Collapsed on the card, one click away, because approving something
        // you have not read is not approval. Sent as TEXT PARAGRAPHS rather
        // than the stored HTML: the page never injects markup it did not
        // build, and what a recipient reads is the words anyway.
        to: c.to_email || null,
        subject: c.subject || null,
        body: stripHtml(c.body_html).split('\n').map((s) => s.trim()).filter(Boolean),
        // The same words as one editable string. The card edits TEXT and posts
        // text; the server turns it back into paragraphs, so the page never
        // sends markup that ends up in an email a business reads.
        bodyText: stripHtml(c.body_html).split('\n').map((x) => x.trim()).filter(Boolean).join('\n\n'),
        // Shown on the card so an agent can see at a glance which of these they
        // have already rewritten.
        edited: !!c.edited_before_approval,
        // Shown because approveBatch will append it. If this said "no" and the
        // approval added one, the preview would be a different email.
        mediaKit: kitUrl,
        // PROCEED AND SAY WHAT WE DO NOT KNOW -- the same stance the compliance
        // gate and the domain gate take. 'valid' means a verifier confirmed the
        // mailbox; null or 'unknown' means it could not be confirmed, which for
        // a catch-all domain is the only answer any verifier can give. The card
        // says so and the agent decides. Verified-bad never gets this far.
        verified: (c._verified && c._verified.result) || null,
        // Said once, here, so the page cannot invent its own wording for a
        // state it does not fully understand.
        verifiedNote: verifyNote(c._verified),
      };
    }),
    // Five is the ceiling; this is the pile behind it. Reported so the backlog
    // is visible on the page that can act on it, rather than only in a count
    // that silently grew.
    shown: cards.length, pending: pendingTotal,
    heldBack: Math.max(0, pendingTotal - cards.length - withheld.length),
    // Held back for a REASON, not just over the five-card line.
    withheld,
    // null unless the month's verification share is running out. The page shows
    // it because the alternative is finding out from a support ticket.
    verifyBudget,
    canApprove: !blocked && cards.length > 0,
    // Empty because there is nothing, or empty because a read failed. Never
    // the same thing on the page.
    errors: errs,
  };
}

module.exports = { buildHome, deriveWhy, fromPitch, fromStored, stripHtml, sentences, MAX_LEN, SHOWN_MAX };
