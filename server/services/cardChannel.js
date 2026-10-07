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
//   dm       an Instagram handle and no email: the message and a copy
//            button, the phone beside it if there is one. Done = "mark as sent".
//   call     a phone, no email and no handle: who, the number, the best time
//            to call, three talking points. NO email body. Done = "mark as called".
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

// The channel a card has, from what is on file. Email wins whenever there is
// one; then the Instagram DM; a call only when there is neither.
// DM BEFORE CALL. It was the other way round, and nearly every business on a
// Google listing has a phone, so a handle never made a DM card: Cypress had
// 66 handles on 88 businesses and cardsByChannel.dm was 0 every night. The
// agent side's own route (outreachQueue.channelFor) already put DM first.
function channelOf({ email, phone, instagram, programUrl, social } = {}) {
  if (hasEmail(email)) return 'email';
  if (social || programUrl) return programUrl ? 'program' : null;
  if (hasHandle(instagram)) return 'dm';
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

module.exports = { channelOf, canSend, bestTime, talkingPoints, callText, hasEmail, hasPhone, hasHandle, ACTION };
