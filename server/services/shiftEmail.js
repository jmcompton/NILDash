'use strict';
// ── THE DAILY REPORT, AS AN EMAIL ────────────────────────────────────────────
// Built from the SAME buildShiftReport output the page renders, so the two
// cannot drift: same sentence, same five items in the same order, same buttons.
// The buttons are deep links into the app rather than a "log in to see" nudge --
// an agent reading this on a phone at 7am should be one tap from the reply.
//
// Table layout and inline styles on purpose. This is email: no flexbox, no
// grid, no external stylesheet, no dark-mode media query worth trusting.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return '$' + Math.round(n).toLocaleString();
}

const KIND_LABEL = { reply: 'Brand replied', approve: 'Waiting on approval', queue: 'Ready to work',
  compliance: 'On hold' };

// The queue block's heading. "Ready to work" sitting under a headline that says
// the run found nothing reads as a contradiction, because on a quiet night every
// one of those cards is carryover. When none of them came from last night the
// heading says so, and the line beneath carries the split.
function queueLabel(it) {
  if (!it || it.kind !== 'queue') return null;
  const fresh = Number(it.fresh) || 0;
  const carried = Number(it.carried) || 0;
  if (!fresh && carried) return 'Waiting from earlier runs';
  if (fresh && carried) return 'Ready to work — some carried over';
  return 'Ready to work';
}

// Deep links. Each one lands on the screen that resolves the item, not the home
// page -- an email that says "3 replies" and drops you on a dashboard has made
// you do the work twice.
function deepLink(appUrl, item) {
  const base = String(appUrl || 'https://mynildash.com').replace(/\/+$/, '');
  const t = (item && item.target) || {};
  const view = t.view || 'home';
  return base + '/?view=' + encodeURIComponent(view) + (t.id ? '&focus=' + encodeURIComponent(t.id) : '');
}

// ── THE SUBJECT ──────────────────────────────────────────────────────────────
// It says what happened, not how many rows are on a list. "1 thing need you this
// morning" was both ungrammatical and uninformative: it counted the internal
// item array, so a brand replying and five queue cards sitting there read
// identically. The order below is the order the work matters in -- a reply
// outranks everything, because someone is waiting on an answer.
function nameOnly(line) {
  // "Ourisman Chevrolet of Bowie replied about Kaden House" -> the brand.
  const m = String(line || '').match(/^(.*?) replied\b/);
  return m ? m[1] : null;
}
function buildSubject(r, replies, waiting) {
  // A stopped pitch outranks a reply. A reply is an opportunity going cold; a
  // hold is work that cannot move until a person acts, and it is the one thing
  // in this email nobody else will chase.
  const holds = (r.needsYou && r.needsYou.items || []).filter((it) => it.kind === 'compliance');
  if (holds.length) {
    const blocked = holds.filter((h) => h.severity === 'block').length;
    if (holds.length === 1) {
      const h = holds[0];
      return (blocked ? 'Cannot send: ' : 'On hold: ') + String(h.line || 'a pitch is on hold');
    }
    return `${holds.length} pitches on hold` + (blocked ? ` — ${blocked} cannot be sent` : '');
  }
  if (replies.length === 1) {
    const brand = nameOnly(replies[0].line);
    const head = brand ? `${brand} replied` : 'A brand replied';
    return waiting ? `${head} — and ${waiting} pitch${waiting === 1 ? '' : 'es'} ready` : head;
  }
  if (replies.length > 1) return `${replies.length} brands replied`;
  if (waiting) return `${waiting} pitch${waiting === 1 ? '' : 'es'} ready to send`;
  const queued = (r.needsYou && r.needsYou.items || []).find((it) => it.kind === 'queue');
  // THE SUBJECT STAYS ON THE BACKLOG. A stale pile is worth a nudge on the
  // quietest morning, which is exactly when nothing new arrived to nudge about.
  // `total` is the real count; `count` is capped at ITEM_MAX for display, so
  // reading that here made the subject understate a backlog over ten.
  if (queued) {
    const n = Number(queued.total) || Number(queued.count) || 0;
    return `${n} outreach card${n === 1 ? '' : 's'} ready to work`;
  }
  if (!(r.run && r.run.ran)) return 'NILDash: your team has not run yet';
  return 'Your team worked last night — nothing needs you';
}

function renderShiftEmail(report, opts = {}) {
  const appUrl = opts.appUrl || 'https://mynildash.com';
  const name = opts.agentName ? String(opts.agentName).split(/\s+/)[0] : null;
  const r = report || {};
  const allItems = (r.needsYou && r.needsYou.items) || [];
  const overflow = (r.needsYou && r.needsYou.overflow) || 0;
  // Replies get their own block at the top, so they are pulled OUT of the list
  // rather than rendered twice. A reply is a human sitting in an inbox waiting
  // on an answer; it was previously just another card in a stack of three, and
  // an agent skimming on a phone would never have seen it.
  const replies = allItems.filter((it) => it.kind === 'reply');
  // Holds keep their place in the NEEDS YOU list rather than getting a block of
  // their own: unlike a reply, a hold is already stopped, so it is not losing
  // anything by being read second. It carries its rule and its reason inline,
  // and a block says it cannot be overridden.
  const holds = allItems.filter((it) => it.kind === 'compliance');
  const closer = r.closer || {};
  const waiting = Number(closer.pendingApproval) || 0;
  const forWhom = Array.isArray(closer.byAthlete) ? closer.byAthlete : [];
  // The approve item and the Ready to send block are the same pile of drafts.
  // Printing both gave the email two different counts of one thing -- "10
  // pitches ready for you" above "14 pitches waiting on your approval" -- which
  // is the drift this whole pass exists to remove. Ready to send owns it,
  // because it is the one that names who they are for.
  const needs = allItems.filter((it) =>
    it.kind !== 'reply' && !(waiting > 0 && it.kind === 'approve'));

  const subject = buildSubject(r, replies, waiting);

  const P = 'margin:0 0 12px;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#1a2230';
  const MUTED = 'margin:0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#6b7c99';

  const parts = [];
  parts.push(`<div style="background:#f4f6fa;padding:22px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e8f0;border-radius:12px">
<tr><td style="padding:22px 24px 4px">`);

  if (name) parts.push(`<p style="${MUTED};margin-bottom:10px">Good morning, ${esc(name)}.</p>`);

  // ── 1. ONE SENTENCE ──────────────────────────────────────────────────────
  if (r.run && r.run.ran) {
    parts.push(`<p style="${P};font-size:17px;line-height:1.5;color:#0f1722"><b>${esc(r.sentence)}</b></p>`);
    if (r.coverage && r.coverage.line) {
      parts.push(`<p style="${MUTED};margin-bottom:16px">${esc(r.coverage.line)} · `
        + `<a href="${esc(appUrl)}/?view=shift-detail" style="color:#3f7d1f">See the detail</a></p>`);
    }
    // A partial night, said out loud. The report is a live count and the run can
    // still be writing when this goes out; without this line the numbers above
    // would quietly disagree with the page an hour later.
    if (r.run.inProgress) {
      parts.push(`<p style="${MUTED};margin-bottom:16px">Last night's run was still going when this was sent, `
        + `so there may be more by the time you open it.</p>`);
    }
  } else {
    parts.push(`<p style="${P}"><b>Your team has not run yet.</b></p>`
      + `<p style="${MUTED};margin-bottom:16px">Add a client and run a Deal Scan to start the overnight run.</p>`);
  }

  parts.push(`</td></tr><tr><td style="padding:0 24px">`);

  // ── 2. A BRAND REPLIED ───────────────────────────────────────────────────
  // Above everything, in its own colour, one block per reply. This is the most
  // important thing that can appear in this email and it used to be buried in
  // the NEEDS YOU stack -- or, when other items outranked it on the page, an
  // agent reading only the email would never learn it had happened at all.
  if (replies.length) {
    parts.push(`<div style="border-top:1px solid #eef1f6;padding-top:16px;margin-bottom:4px">
  <p style="margin:0 0 10px;font:600 13px/1 -apple-system,Arial,sans-serif;color:#3f7d1f;letter-spacing:.02em">${replies.length === 1 ? 'A BRAND REPLIED' : replies.length + ' BRANDS REPLIED'}</p>`);
    for (const it of replies) {
      parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px">
<tr><td style="padding:12px 14px;background:#f3f8ec;border:1px solid #d6e6bf;border-radius:9px">
  <p style="margin:0 0 9px;font:600 16px/1.4 -apple-system,Arial,sans-serif;color:#1a2230">${esc(it.line)}</p>
  <a href="${esc(deepLink(appUrl, it))}" style="display:inline-block;background:#84CC16;color:#0b0f0a;text-decoration:none;font:600 13px/1 -apple-system,Arial,sans-serif;padding:9px 15px;border-radius:7px">${esc(it.actionLabel || 'Read and reply')}</a>
</td></tr></table>`);
    }
    parts.push('</div>');
  }

  // ── 3. NEEDS YOU ─────────────────────────────────────────────────────────
  parts.push(`<div style="border-top:1px solid #eef1f6;padding-top:16px">
  <p style="margin:0 0 10px;font:600 13px/1 -apple-system,Arial,sans-serif;color:#0f1722;letter-spacing:.02em">NEEDS YOU</p>`);

  if (!needs.length) {
    // "No replies waiting" must not be printed above a block that just showed
    // one. The reply block owns that half of the sentence now.
    parts.push(`<p style="${MUTED};padding:6px 0 4px">${replies.length
      ? 'Nothing else needs you. No drafts to approve, no cards waiting.'
      : 'Nothing needs you right now. No replies waiting, no drafts to approve.'}</p>`);
  } else {
    for (const it of needs) {
      parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px">
<tr><td style="padding:10px 12px;background:#f8fafc;border:1px solid #e8edf4;border-radius:9px">
  <p style="margin:0 0 2px;font:600 10px/1.4 -apple-system,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${it.kind === 'compliance' ? (it.severity === 'block' ? '#b91c1c' : '#b45309') : '#6b7c99'}">${esc(it.kind === 'compliance' && it.severity === 'block' ? 'Cannot send' : (queueLabel(it) || KIND_LABEL[it.kind] || 'Needs a decision'))}</p>
  <p style="margin:0 0 ${(it.detail || it.reason) ? '2' : '9'}px;font:15px/1.4 -apple-system,Arial,sans-serif;color:#1a2230">${esc(it.line)}</p>
  ${it.detail ? `<p style="${MUTED};font-size:12px;margin-bottom:${it.reason ? '2' : '9'}px">${esc(it.detail)}</p>` : ''}
  ${it.reason ? `<p style="${MUTED};font-size:12px;margin-bottom:9px">${esc(it.reason)}</p>` : ''}
  <a href="${esc(deepLink(appUrl, it))}" style="display:inline-block;background:#84CC16;color:#0b0f0a;text-decoration:none;font:600 13px/1 -apple-system,Arial,sans-serif;padding:9px 15px;border-radius:7px">${esc(it.actionLabel || 'Open')}</a>
</td></tr></table>`);
    }
    // Overflow is one line. Never a second list.
    if (overflow > 0) {
      parts.push(`<p style="${MUTED};margin:2px 0 4px">${overflow} more waiting.</p>`);
    }
  }
  parts.push('</div>');

  // ── 4. READY TO SEND ─────────────────────────────────────────────────────
  // The email's only action used to be "Open queue", which told the agent
  // nothing about what was actually waiting under their name. This carries the
  // page's grouping: athlete, how many, and the first businesses by name. Not
  // the message bodies -- those cannot be approved or edited from an inbox, and
  // ten of them would bury everything above. One button, one decision, same as
  // the page: approval is per batch and never per message.
  if (waiting > 0) {
    const capNote = closer.budget && closer.budget.blocked
      ? esc(closer.line || '')
      : (closer.budget
        ? `${closer.budget.used} of ${closer.budget.cap} emails used today. DMs and calls are not affected by this.`
        : '');
    parts.push(`<div style="border-top:1px solid #eef1f6;margin-top:18px;padding-top:16px">
  <p style="margin:0 0 4px;font:600 13px/1 -apple-system,Arial,sans-serif;color:#0f1722;letter-spacing:.02em">READY TO SEND</p>
  <p style="${MUTED};margin-bottom:12px">${waiting} pitch${waiting === 1 ? '' : 'es'} waiting on your approval${forWhom.length ? ` across ${forWhom.length} athlete${forWhom.length === 1 ? '' : 's'}` : ''}.</p>`);

    for (const g of forWhom.slice(0, 6)) {
      const brands = (g.brands || []).map(esc).join(', ');
      const more = Math.max(0, g.count - (g.brands || []).length);
      parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px">
<tr><td style="padding:9px 12px;background:#f8fafc;border:1px solid #e8edf4;border-radius:9px">
  <p style="margin:0 0 2px;font:600 14px/1.4 -apple-system,Arial,sans-serif;color:#1a2230">${esc(g.name)} · ${g.count} pitch${g.count === 1 ? '' : 'es'}</p>
  <p style="${MUTED};font-size:12px">${brands}${more > 0 ? ` and ${more} more` : ''}</p>
</td></tr></table>`);
    }
    if (forWhom.length > 6) {
      parts.push(`<p style="${MUTED};margin:2px 0 10px">and ${forWhom.length - 6} more athlete${forWhom.length - 6 === 1 ? '' : 's'}.</p>`);
    }
    parts.push(`<a href="${esc(appUrl)}/?view=home#ready-to-send" style="display:inline-block;background:#84CC16;color:#0b0f0a;text-decoration:none;font:600 13px/1 -apple-system,Arial,sans-serif;padding:10px 16px;border-radius:7px;margin-top:2px">Read them and approve</a>
  <p style="${MUTED};font-size:12px;margin-top:9px">You do not pick the time. Approved pitches go out when the recipient is most likely to read them. ${capNote}</p>
</div>`);
  }

  // ── 5. MOVING ────────────────────────────────────────────────────────────
  const mv = r.moving;
  if (mv && (mv.earned || mv.inFlight)) {
    parts.push(`<div style="border-top:1px solid #eef1f6;margin-top:18px;padding-top:16px">
  <p style="margin:0 0 10px;font:600 13px/1 -apple-system,Arial,sans-serif;color:#0f1722;letter-spacing:.02em">MOVING</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="50%" style="padding-right:8px">
      <p style="margin:0;font:700 22px/1.1 -apple-system,Arial,sans-serif;color:#0f1722">${esc(money(mv.earned))}</p>
      <p style="${MUTED};font-size:12px">earned by your athletes</p></td>
    <td width="50%" style="padding-left:8px">
      <p style="margin:0;font:700 22px/1.1 -apple-system,Arial,sans-serif;color:#0f1722">${esc(money(mv.inFlight))}</p>
      <p style="${MUTED};font-size:12px">in flight across ${esc(mv.inFlightCount)} deal${mv.inFlightCount === 1 ? '' : 's'}</p></td>
  </tr></table></div>`);
  }

  // ── 5b. ATHLETES THE RUN CRASHED ON ──────────────────────────────────────
  // Above the fold-ish and in red, because this is not a status line: it is work
  // that did not happen for a named client, and the agent would otherwise find
  // out by noticing an empty section days later.
  const ft = r.faults;
  if (ft && ft.line) {
    parts.push(`<div style="border-top:1px solid #eef1f6;margin-top:18px;padding-top:16px">
  <p style="margin:0;font:600 13px/1.5 -apple-system,Arial,sans-serif;color:#b23c17">${esc(ft.line)}</p>
  <p style="${MUTED};font-size:12px;margin-top:6px">Nothing was retried — the rest of the roster ran
  normally. ${esc(ft.count === 1 ? 'This athlete' : 'These athletes')} will be picked up on the next run.</p>
  </div>`);
  }

  // ── 6. WHAT EXPIRED ──────────────────────────────────────────────────────
  // NOTHING DISAPPEARS SILENTLY. Drafts nobody sent expire after a week, and an
  // agent who watched a pile of pitches shrink with no explanation would
  // reasonably assume the product lost them. Says what went, why, and that the
  // text is still there -- expiry is a status change, not a delete.
  const da = r.draftAudit;
  if (da && da.expiredRecent > 0) {
    parts.push(`<div style="border-top:1px solid #eef1f6;margin-top:18px;padding-top:16px">
  <p style="${MUTED};font-size:12px;margin:0">${esc(da.expiredRecent)} draft${da.expiredRecent === 1 ? '' : 's'}
  expired in the last day after ${esc(da.expiryDays)} days with no send. Nothing was deleted — they are still
  readable in Outreach.</p></div>`);
  }

  // ── THE VERIFICATION BUDGET, WHEN IT IS NEARLY GONE ──────────────────────
  // Amber rather than muted: this is not a status line, it is a thing that needs
  // a decision -- raise the Hunter plan, lower the per-athlete number, or accept
  // more unverified cards. Silent while the month is healthy.
  const vb = r.verifyBudget;
  if (vb && vb.line) {
    // A FAULT READS DIFFERENTLY FROM A BILL. `unknown` means the credit log could
    // not be read, so nothing has been spent and no month has run out -- the old
    // code had no such state and rendered that case as an exhausted budget in
    // red, which is a number an agent would reasonably have acted on.
    parts.push(`<div style="border-top:1px solid #eef1f6;margin-top:18px;padding-top:16px">
  <p style="margin:0;font:600 12px/1.5 -apple-system,Arial,sans-serif;color:${vb.unknown || vb.exhausted ? '#b23c17' : '#8a6d1f'}">
  ${esc(vb.line)}</p>
  <p style="${MUTED};font-size:11px;margin-top:6px">${vb.unknown
    ? 'Nothing has been spent. Address finding is unaffected.'
    : 'Address finding is unaffected — ' + esc(vb.ladderReserve) + ' lookups a month are held back for it.'}</p></div>`);
  }

  parts.push(`</td></tr>
<tr><td style="padding:18px 24px 22px">
  <p style="${MUTED};font-size:11px;border-top:1px solid #eef1f6;padding-top:14px">
    NILDash · <a href="${esc(appUrl)}/?view=settings" style="color:#6b7c99">Change when this arrives</a>
  </p>
</td></tr></table></div>`);

  const html = parts.join('\n');

  // Plain text alternative, because a report that only renders in HTML is a
  // report some agents never read.
  const textLines = [];
  if (r.run && r.run.ran) {
    textLines.push(r.sentence);
    if (r.coverage && r.coverage.line) textLines.push(r.coverage.line);
  } else textLines.push('Your team has not run yet.');
  if (r.run && r.run.ran && r.run.inProgress) {
    textLines.push("Last night's run was still going when this was sent.");
  }
  if (replies.length) {
    textLines.push('', replies.length === 1 ? 'A BRAND REPLIED' : replies.length + ' BRANDS REPLIED');
    for (const it of replies) textLines.push('  - ' + it.line + '  ' + deepLink(appUrl, it));
  }
  textLines.push('', 'NEEDS YOU');
  if (!needs.length) {
    textLines.push(replies.length ? '  Nothing else needs you.' : '  Nothing needs you right now.');
  } else {
    for (const it of needs) {
      textLines.push('  - ' + (it.kind === 'compliance' && it.severity === 'block' ? 'CANNOT SEND: ' : '')
        + it.line + '  ' + deepLink(appUrl, it));
      if (it.reason) textLines.push('      ' + it.reason);
    }
    if (overflow > 0) textLines.push('  ' + overflow + ' more waiting.');
  }
  if (waiting > 0) {
    textLines.push('', 'READY TO SEND',
      '  ' + waiting + ' pitch' + (waiting === 1 ? '' : 'es') + ' waiting on your approval.');
    for (const g of forWhom.slice(0, 6)) {
      const more = Math.max(0, g.count - (g.brands || []).length);
      textLines.push('  - ' + g.name + ' · ' + g.count + ' pitch' + (g.count === 1 ? '' : 'es')
        + ((g.brands || []).length ? ': ' + g.brands.join(', ') + (more > 0 ? ' and ' + more + ' more' : '') : ''));
    }
    if (forWhom.length > 6) textLines.push('  and ' + (forWhom.length - 6) + ' more athletes.');
    textLines.push('  ' + String(appUrl).replace(/\/+$/, '') + '/?view=home#ready-to-send');
  }
  if (mv && (mv.earned || mv.inFlight)) {
    textLines.push('', 'MOVING', '  ' + money(mv.earned) + ' earned · ' + money(mv.inFlight) + ' in flight');
  }
  if (ft && ft.line) textLines.push('', '  ' + ft.line,
    '  Nothing was retried; the rest of the roster ran normally.');
  if (vb && vb.line) textLines.push('', '  ' + vb.line);
  if (da && da.expiredRecent > 0) {
    textLines.push('', '  ' + da.expiredRecent + ' draft' + (da.expiredRecent === 1 ? '' : 's')
      + ' expired in the last day after ' + da.expiryDays + ' days with no send.'
      + ' Nothing was deleted — they are still readable in Outreach.');
  }

  return { subject, html, text: textLines.join('\n') };
}

module.exports = { renderShiftEmail, deepLink, money };
