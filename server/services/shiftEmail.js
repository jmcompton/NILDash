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

const KIND_LABEL = { reply: 'Brand replied', approve: 'Waiting on approval', queue: 'Ready to work' };

// Deep links. Each one lands on the screen that resolves the item, not the home
// page -- an email that says "3 replies" and drops you on a dashboard has made
// you do the work twice.
function deepLink(appUrl, item) {
  const base = String(appUrl || 'https://mynildash.com').replace(/\/+$/, '');
  const t = (item && item.target) || {};
  const view = t.view || 'home';
  return base + '/?view=' + encodeURIComponent(view) + (t.id ? '&focus=' + encodeURIComponent(t.id) : '');
}

function renderShiftEmail(report, opts = {}) {
  const appUrl = opts.appUrl || 'https://mynildash.com';
  const name = opts.agentName ? String(opts.agentName).split(/\s+/)[0] : null;
  const r = report || {};
  const needs = (r.needsYou && r.needsYou.items) || [];
  const overflow = (r.needsYou && r.needsYou.overflow) || 0;

  // SUBJECT carries the decision count, because that is what makes an agent open
  // it. "Your NILDash report" is what makes them archive it.
  const subject = needs.length
    ? `${needs.length} thing${needs.length === 1 ? '' : 's'} need you this morning`
    : (r.run && r.run.ran ? 'Your team worked last night — nothing needs you' : 'NILDash: your team has not run yet');

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
  } else {
    parts.push(`<p style="${P}"><b>Your team has not run yet.</b></p>`
      + `<p style="${MUTED};margin-bottom:16px">Add a client and run a Deal Scan to start the overnight run.</p>`);
  }

  // ── 2. NEEDS YOU ─────────────────────────────────────────────────────────
  parts.push(`</td></tr><tr><td style="padding:0 24px">
  <div style="border-top:1px solid #eef1f6;padding-top:16px">
  <p style="margin:0 0 10px;font:600 13px/1 -apple-system,Arial,sans-serif;color:#0f1722;letter-spacing:.02em">NEEDS YOU</p>`);

  if (!needs.length) {
    parts.push(`<p style="${MUTED};padding:6px 0 4px">Nothing needs you right now. No replies waiting, no drafts to approve.</p>`);
  } else {
    for (const it of needs) {
      parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px">
<tr><td style="padding:10px 12px;background:#f8fafc;border:1px solid #e8edf4;border-radius:9px">
  <p style="margin:0 0 2px;font:600 10px/1.4 -apple-system,Arial,sans-serif;color:#6b7c99;letter-spacing:.06em;text-transform:uppercase">${esc(KIND_LABEL[it.kind] || 'Needs a decision')}</p>
  <p style="margin:0 0 ${it.detail ? '2' : '9'}px;font:15px/1.4 -apple-system,Arial,sans-serif;color:#1a2230">${esc(it.line)}</p>
  ${it.detail ? `<p style="${MUTED};font-size:12px;margin-bottom:9px">${esc(it.detail)}</p>` : ''}
  <a href="${esc(deepLink(appUrl, it))}" style="display:inline-block;background:#84CC16;color:#0b0f0a;text-decoration:none;font:600 13px/1 -apple-system,Arial,sans-serif;padding:9px 15px;border-radius:7px">${esc(it.actionLabel || 'Open')}</a>
</td></tr></table>`);
    }
    // Overflow is one line. Never a second list.
    if (overflow > 0) {
      parts.push(`<p style="${MUTED};margin:2px 0 4px">${overflow} more waiting.</p>`);
    }
  }
  parts.push('</div>');

  // ── 3. MOVING ────────────────────────────────────────────────────────────
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
  textLines.push('', 'NEEDS YOU');
  if (!needs.length) textLines.push('  Nothing needs you right now.');
  else {
    for (const it of needs) textLines.push('  - ' + it.line + '  ' + deepLink(appUrl, it));
    if (overflow > 0) textLines.push('  ' + overflow + ' more waiting.');
  }
  if (mv && (mv.earned || mv.inFlight)) {
    textLines.push('', 'MOVING', '  ' + money(mv.earned) + ' earned · ' + money(mv.inFlight) + ' in flight');
  }

  return { subject, html, text: textLines.join('\n') };
}

module.exports = { renderShiftEmail, deepLink, money };
