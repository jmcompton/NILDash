'use strict';
// ── A CARD CANNOT EXIST WITHOUT A WAY TO REACH SOMEONE ──────────────────────
//
// The builder used to write a full email for a contact that had only a phone
// number or an Instagram handle, Approve accepted it, and the sender then had
// nothing to send to: the row died with "no address to send to" and nobody was
// told (41 approved-unsent rows from 2026-09-23, 25 of them that). The rule,
// for the agent side and the university side alike:
//
//   email    an email address on file. The only card that is an email.
//   call     a phone and no email: who, the number, the best time to call,
//            three talking points. NO email body. Done = "mark as called".
//   dm       an Instagram handle and nothing else: the message and a copy
//            button. Done = "mark as sent".
//   (The university side puts dm before call: campusChannelOf below.)
//   program  a brand's athlete-program page (the social rung): the message,
//            a copy button, the page. Done = "mark as applied".
//   null     no way to reach anyone: no card at all.
//
// Approve means SEND only for an email card, and is refused up front, with
// the reason, for anything else (canSend below), never accepted and failed later.

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
function hasEmail(v) { return EMAIL_RE.test(String(v || '').trim()); }
function hasPhone(v) { return String(v || '').replace(/\D/g, '').length >= 7; }
function hasHandle(v) { return /^@?[a-z0-9._]{2,30}$/i.test(String(v || '').trim()); }

// The channel a card has, from what is on file. Email wins whenever there is one.
// THE AGENT SIDE'S ORDER, unchanged: email, then call, then DM. (The agent
// night picks its own cards' channel in outreachQueue.channelFor; this is the
// order its conversions use: draftChannel.convert, approvedBacklog.)
function channelOf({ email, phone, instagram, programUrl, social } = {}) {
  if (hasEmail(email)) return 'email';
  if (social || programUrl) return programUrl ? 'program' : null;
  if (hasPhone(phone)) return 'call';
  if (hasHandle(instagram)) return 'dm';
  return null;
}

// ── THE UNIVERSITY SIDE: DM BEFORE CALL, never to a brand-wide account ──────
// channelOf put the phone first, and nearly every business on a Google
// listing has a phone, so a handle never made a DM card: Cypress had 66
// handles on 88 businesses and cardsByChannel.dm was 0 every night. The
// university callers (the night, the portal, the status count, the on-demand
// pitch, campusReach) use this order: email, then DM, then call.
//
// A BRAND-WIDE HANDLE IS NOT A ROUTE TO THIS LOCATION: the agent night's rule
// (outreachQueue.channelFor, instagramLookup.handleVerdict), ported. A store
// whose name carries its town and whose handle does not ("85°C Bakery Cafe
// Cypress" and @85cbakerycafe) is a chain location linking to the corporate
// account; a team never DMs it. scope 'brand' from a lookup says the same.
function campusHandle({ instagram, instagramScope, brand, city } = {}) {
  if (!hasHandle(instagram)) return null;
  if (instagramScope === 'brand') return null;
  const h = String(instagram).trim().replace(/^@/, '');
  if (brand) {
    const v = require('./instagramLookup').handleVerdict(h.toLowerCase(), brand, city || '');
    if (v === 'brand') return null;
  }
  return h;
}
function campusChannelOf({ email, phone, instagram, instagramScope, programUrl, social, brand, city } = {}) {
  if (hasEmail(email)) return 'email';
  if (social || programUrl) return programUrl ? 'program' : null;
  if (campusHandle({ instagram, instagramScope, brand, city })) return 'dm';
  if (hasPhone(phone)) return 'call';
  return null;
}

// What "approve" does for each, and whether it can send. Used by every approve.
const ACTION = { email: 'send', call: 'mark called', dm: 'mark sent', program: 'mark applied' };
function canSend(card) {
  const ch = card.channel || channelOf(card);
  if (ch === 'email') return { ok: true, channel: ch };
  if (!ch) return { ok: false, channel: null, why: 'There is no email address, phone or Instagram for this contact, so there is nothing to send and no one to call.' };
  return { ok: false, channel: ch,
    why: ch === 'call' ? 'This is a call card: there is no email address for this contact, so nothing can be sent. Call the number and mark it called.'
      : ch === 'dm' ? 'This is a DM card: there is no email address for this contact, only Instagram. Copy the message, send it as a DM, and mark it sent.'
        : 'This is a program card: the brand takes applications on its program page, not by email. Apply there and mark it applied.' };
}

// ── WHEN TO CALL ────────────────────────────────────────────────────────────
// By the kind of business (campusQuality buckets, or a category / Google type).
// When the owner is in and not in the middle of the rush.
const BEST_TIME = [
  [/restaurant|food|meal|taqueria|pizza|burger|grill|diner|coffee|cafe|smoothie|juice|boba|tea|bakery|dessert|ice cream|donut/, 'Weekdays 2 to 4 pm, between the lunch and dinner rush'],
  [/barber|salon|hair|nail|beauty|spa|tattoo/, 'Tuesday to Thursday, 10 to 11 am, before the chairs fill'],
  [/gym|fitness|yoga|pilates|martial|boxing|crossfit|training/, 'Weekdays 10 to 11:30 am, after the morning classes'],
  [/sports medicine|physio|physical therap|chiro|massage/, 'Weekdays 8 to 9 am, before the first patients, or 12 to 1 pm'],
  [/dentist|dental|orthodont|medical|clinic|doctor|urgent|health/, 'Weekdays 8 to 9 am, before the first patients, or 12 to 1 pm'],
  [/auto|car|dealer|tire|repair|wash|detail/, 'Weekdays 9 to 11 am'],
  [/real estate|insurance|bank|credit union|finance|mortgage|law|account/, 'Weekdays 9 to 11 am'],
  [/apparel|clothing|shoe|sporting|retail|store|shop|florist|gift|jewel|pet|book/, 'Weekdays 10 to 11 am, just after opening'],
];
function bestTime(kind) {
  const s = String(kind || '').toLowerCase().replace(/_/g, ' ');
  for (const [re, t] of BEST_TIME) if (re.test(s)) return t;
  return 'Weekdays 10 to 11:30 am or 2 to 4 pm';
}

// ── THREE TALKING POINTS, FROM WHAT IS KNOWN, NOTHING INVENTED ──────────────
// who: who is calling and for whom ("Xavier Ruiz, Cypress College Athletics")
// subject: what the call is about ("the Women's Basketball program", or the athlete)
// why: why this business (the card's own reason), miles: distance if known
// ask: what to ask for
function talkingPoints({ who, subject, business, why, miles, ask }) {
  const near = Number.isFinite(Number(miles)) && miles !== null ? ` You are ${Number(miles) < 1 ? 'under a mile' : `about ${Math.round(Number(miles) * 10) / 10} miles`} from us.` : '';
  return [
    `Who you are: ${who || 'the athletic department'}, calling about ${subject}.`,
    `Why ${business}: ${why ? String(why).replace(/\s+/g, ' ').trim().replace(/\.?$/, '.') : 'a local business near our fans.'}${near}`,
    `The ask: ${ask || `would ${business} like to back ${subject} as a local partner this season? If yes, set a 15-minute meeting; if this is not the right person, ask who decides on marketing.`}`,
  ];
}
function callText({ contactName, phone, best, points }) {
  return [`Call ${contactName || 'the owner'}${phone ? ` at ${phone}` : ''}.`, best ? `Best time: ${best}.` : null, '',
    ...points.map((p, i) => `${i + 1}. ${p}`)].filter((x) => x !== null).join('\n');
}

module.exports = { channelOf, campusChannelOf, campusHandle, canSend, bestTime, talkingPoints, callText, hasEmail, hasPhone, hasHandle, ACTION };
