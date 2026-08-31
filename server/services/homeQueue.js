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

// ── TWO TABLES, ONE QUEUE ───────────────────────────────────────────────────
// Home used to read outreach_logs and nothing else, so it showed the 18% of a
// night's work that is emailable and hid the rest. The nightly job writes call
// and DM cards into outreach_queue and has no email branch at all. Which table a
// card came from is not a fact about the agent's morning; it is an accident of
// which code path produced it.
//
// Everything about WHICH cards count, in what order, and which business wins
// when both tables hold one, lives in ./actionable -- shared with the shift
// report so the page and the email cannot print different numbers for one pile.
const A = require('./actionable');

// Home shows five cards per athlete and no more, whatever the channel. The cap
// of five that already existed is on outreach_queue -- the RESEARCH pile --
// while drafts live in outreach_logs with no cap at all, so a roster nobody
// worked for a fortnight arrived at Home with 14 and 63 cards on two athletes.
// A page carrying 63 decisions is not a page carrying one.
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

  const roster = await q('athletes',
    `SELECT a.id, a.data->>'name' AS name, a.data->>'school' AS school,
            a.data->>'dob' AS dob
       FROM athletes a
      WHERE a.agent_id = $1
      ORDER BY a.created_at ASC`, [agentId]);

  // WHICH ATHLETE TO OPEN ON needs the same answer as the tab counts, and the
  // tab counts are no longer a COUNT(*) this file can write: an actionable card
  // is one that passed a channel-aware gate, and the count that ignored that gate
  // was the reason a tab said 63 over a page showing five. This is the one read
  // that decides both -- and the identical read the shift report makes.
  const roll = await A.countActionable(pool, agentId).catch((e) => {
    errs.push('counts: ' + e.message);
    return { total: 0, byChannel: {}, program: 0, perAthlete: new Map(), withheld: [], errors: [] };
  });
  for (const e of (roll.errors || [])) errs.push(e);
  const pendingOf = (id) => (roll.perAthlete.get(id) || {}).total || 0;

  const athletes = roster.map((a) => ({ ...a, pending: pendingOf(a.id) }));

  const selected = opts.athleteId
    || (athletes.find((a) => a.pending > 0) || athletes[0] || {}).id
    || null;

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
  // IT RUNS FIRST, AND ONLY ON EMAIL DRAFTS. Before, because the gate below
  // rejects an addressless draft and attach is what supplies the address; only
  // on email, because a call card never wanted one and spending a verification
  // credit looking for it is spending the account's month on nothing.
  //
  // OLDEST FIRST. The budget is three lookups an athlete a day, so this chooses
  // which drafts get them. Oldest is the same tie-break the ranking uses and the
  // same intent as the starvation promotion: the pile's tail is what goes unseen.
  let verifyBudget = null;
  if (selected) {
    const unaddressed = await q('to-address',
      `SELECT l.id FROM outreach_logs l
        WHERE ${A.EMAIL_WHERE} AND l.athlete_id = $2
          AND (l.sent_to_email IS NULL OR l.sent_to_email = '')
        ORDER BY l.created_at ASC LIMIT $3`, [agentId, selected, FETCH_MAX]);
    if (unaddressed.length) {
      try {
        const DA = require('./draftAddress');
        const VB = require('./verifyBudget');
        const res = await DA.attach(pool, {
          agentId,
          ids: unaddressed.map((r) => r.id),
          athleteId: selected,
          budget: VB.PER_ATHLETE_DAY,
          // A PAGE LOAD, NOT A BATCH JOB. Past this the remaining addresses come
          // back `unknown`, which withholds the card and names it. An agent
          // staring at a spinner because a resolver is slow is a worse outcome
          // than a page that says what it does not know.
          deadlineMs: ATTACH_DEADLINE_MS,
        });
        // Surfaced on the payload, not just in a log. An account ceiling that
        // only announces itself in stdout is a ceiling nobody finds out about
        // until the cards quietly stop being verified.
        const acct = res && res.budget && res.budget.account;
        if (acct && (acct.low || acct.unknown)) verifyBudget = acct;
      } catch (e) {
        // An addressing pass that could not run must not empty the page. The
        // gate still holds; the cards simply arrive as they were.
        errs.push('addressing: ' + e.message);
      }
    }
  }

  // ── THE MIXED QUEUE ───────────────────────────────────────────────────────
  // Loaded AFTER attach, so anything the addressing pass just rescued is read
  // back from the database rather than patched in memory -- which is also what
  // keeps the shift report, reading the same rows a minute later, in agreement.
  let cards = [];
  let withheld = [];
  let pendingTotal = 0;
  if (selected) {
    const got = await A.load(pool, agentId, { athleteId: selected, full: true });
    for (const e of (got.errors || [])) errs.push(e);
    const all = got.byAthlete.get(selected) || [];
    // Already scoped to this athlete by the load, and already carrying a reason
    // per channel rather than one sentence about email addresses.
    withheld = got.withheld || [];
    pendingTotal = all.length;
    // FIVE, BY THE LADDER, WITH TWO HELD FOR EMAIL. See actionable.select.
    cards = A.select(all, { max: SHOWN_MAX });
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
      // deriveWhy reads a card's own vocabulary; the normalised card uses one
      // name per concept across two schemas, so it is handed the three sources
      // by the names it knows.
      const w = deriveWhy({ body_html: c.bodyHtml, why: c.why, reasoning: c.reasoning });
      const card = {
        // NAMESPACED. `email:<uuid>` or `queue:<serial>`, because the two tables
        // have separate id spaces and a bare id in a mixed list cannot say which
        // one it belongs to. See actionable.parseId.
        id: c.id,
        // ON EVERY CARD, not only the ones that are not email. A badge that
        // appears on the exceptions teaches an agent that unbadged means normal;
        // a badge on all three teaches them to read it.
        channel: c.channel,
        business: c.brand_name,
        contact: c.contactName || null,
        role: c.contactTitle || null,
        why: w.text,
        whyFrom: w.from,
        // Why this one outranked the rest, in words. Queue-only: it is evidence
        // of a tie to the school, and it is the most useful line on the card
        // when we hold it.
        sponsorNote: c.sponsorNote || null,
        // Said in words why an owner is only a probable match, rather than
        // leaving the agent to wonder why a confident-looking card ranks low.
        sourceNote: (c.affiliationScope === 'unclear' && c.sourceNote) || null,
      };

      if (c.channel === 'email') {
        // ── THE EMAIL ITSELF ───────────────────────────────────────────────
        // Collapsed on the card, one click away, because approving something
        // you have not read is not approval. Sent as TEXT PARAGRAPHS rather
        // than the stored HTML: the page never injects markup it did not
        // build, and what a recipient reads is the words anyway.
        card.to = c.toEmail || null;
        card.subject = c.subject || null;
        card.body = stripHtml(c.bodyHtml).split('\n').map((s) => s.trim()).filter(Boolean);
        // The same words as one editable string. The card edits TEXT and posts
        // text; the server turns it back into paragraphs, so the page never
        // sends markup that ends up in an email a business reads.
        card.bodyText = card.body.join('\n\n');
        // Shown on the card so an agent can see at a glance which of these they
        // have already rewritten.
        card.edited = !!c.edited;
        // Shown because approveBatch will append it. If this said "no" and the
        // approval added one, the preview would be a different email.
        card.mediaKit = kitUrl;
        // PROCEED AND SAY WHAT WE DO NOT KNOW -- the same stance the compliance
        // gate and the domain gate take. 'valid' means a verifier confirmed the
        // mailbox; null or 'unknown' means it could not be confirmed, which for
        // a catch-all domain is the only answer any verifier can give. The card
        // says so and the agent decides. Verified-bad never gets this far.
        card.verified = (c.verified && c.verified.result) || null;
        // Said once, here, so the page cannot invent its own wording for a
        // state it does not fully understand.
        card.verifiedNote = verifyNote(c.verified);
        // ── THE OTHER WAYS IN, KEPT ON AN EMAIL CARD ──────────────────────
        // A local business with an inbox AND a handle is an email card, because
        // email is the only channel that sends itself. That is a routing choice,
        // not a reason to forget the handle: an address that bounces used to
        // leave the agent with a dead card and no second route.
        card.handle = c.instagram || null;
        card.handleIsBrand = c.instagramScope === 'brand';
        card.phone = c.phone || null;
        card.askFor = c.phoneAskFor || c.contactName || null;
      } else if (c.channel === 'dm') {
        // The message, editable, and the handle the button opens. The same two
        // things the Outreach tab has had all along -- moved here so the agent
        // does not have to know there is a second page.
        card.dmText = c.dmText || '';
        card.handle = c.instagram || null;
        // A brand account is a real channel and it is NOT this storefront. Shown
        // and labelled rather than quietly used as though it were the owner.
        card.handleIsBrand = c.instagramScope === 'brand';
        // NO MEDIA KIT LINE ON A DM. approveBatch appends the kit to body_html
        // and a DM has none; appending it to the message instead would lengthen
        // something the agent is about to paste into a box with a limit.
        card.mediaKit = null;
      } else if (c.channel === 'call') {
        // v1 IS THIN AND SAYS SO. A number, who to ask for, and the reason --
        // no script, because there is no call_script column and nothing writes
        // one. Scoped and deliberately cut rather than faked with a template.
        card.phone = c.phone || null;
        card.askFor = c.phoneAskFor || c.contactName || null;
        card.mediaKit = null;
      }
      return card;
    }),
    // Five is the ceiling; this is the pile behind it. Reported so the backlog
    // is visible on the page that can act on it, rather than only in a count
    // that silently grew.
    shown: cards.length, pending: pendingTotal,
    heldBack: Math.max(0, pendingTotal - cards.length),
    // WHAT THE FIVE ARE MADE OF, so the approve bar can say how many of them it
    // actually acts on. Approving does not clear this page any more: it schedules
    // the email cards and leaves the DM and call cards for the agent to work.
    mix: cards.reduce((m, c) => { m[c.channel] = (m[c.channel] || 0) + 1; return m; },
      { email: 0, dm: 0, call: 0 }),
    // Held back for a REASON, not just over the five-card line.
    withheld,
    // Excluded from this queue, NOT dropped: a programme application is not an
    // approach to a business and has no person on the other end. Counted so the
    // page can point at where they live rather than losing them.
    programs: roll.program || 0,
    // null unless the month's verification share is running out. The page shows
    // it because the alternative is finding out from a support ticket.
    verifyBudget,
    canApprove: !blocked && cards.some((c) => c.channel === 'email'),
    // Empty because there is nothing, or empty because a read failed. Never
    // the same thing on the page.
    errors: errs,
  };
}

module.exports = { buildHome, deriveWhy, fromPitch, fromStored, stripHtml, sentences, MAX_LEN, SHOWN_MAX };
