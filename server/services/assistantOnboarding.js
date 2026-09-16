'use strict';
// ── THE FIRST-LOGIN ASSISTANT ────────────────────────────────────────────────
//
// An agent with no athletes does not get an empty dashboard. They get the
// assistant, full screen, and it stays until their first athlete exists. This
// is the same assistant (same route, same tools, same knowledge, same
// safety layer in assistantActions); what changes is the opening line, the
// brief that tells the model what to do, and three tools that only make
// sense here: look an athlete up, open the spreadsheet import, finish.
//
// THE OPENING IS A SCRIPT, NOT A MODEL CALL. It is the one message every new
// agent reads, it is fixed by the founder, and it arrives without a round
// trip to the model: the greeting shows the moment the page does.
//
// WHEN IT APPLIES: an agent principal (never an athlete, never an admin
// wandering an empty account) with zero athletes. The count is read from
// the database on every turn, so the moment the first athlete is saved the
// next turn is an ordinary one and the takeover never returns.

const OPENING = `Welcome to NILDash. I'm going to get you set up in the next few minutes. The way this works: you add your athletes, and NILDash researches local businesses near each of them overnight and writes the pitches. You log in, approve what you like, and we send them. That's it.

There are three ways to add your athletes. I can look them up by name and school, you can upload your roster as a spreadsheet, or you can enter them one at a time. Which works best for you?`;

// The three choices, offered as buttons under the opening. Each is sent as
// the agent's own words, so the transcript reads as a conversation and the
// model sees a plain answer.
const CHOICES = [
  { key: 'lookup', label: 'Look them up for me', text: 'Look them up by name and school.' },
  { key: 'import', label: 'Upload a spreadsheet', text: 'I will upload my roster as a spreadsheet.' },
  { key: 'manual', label: 'Enter one at a time', text: 'I will enter them one at a time.' },
];

// What the page shows when the first athlete is in and the agent is done:
// the overnight plan, in the assistant's words, then the dashboard.
function summaryFor(names) {
  const list = (names || []).filter(Boolean);
  const who = !list.length ? 'your athletes'
    : list.length === 1 ? list[0]
    : list.length === 2 ? `${list[0]} and ${list[1]}`
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `Here is what happens next. NILDash is finding local businesses near ${who} right now, and tonight it researches each one, finds the person who can say yes, and writes the pitch. Tomorrow morning you will have pitches waiting on your dashboard. Open each one, edit anything you want, approve the batch, and they go out during the day when the recipient is most likely to read them. Nothing sends until you approve it. That's the whole rhythm: the team works at night, you review in the morning.`;
}

// What the model is told to do, on every onboarding turn. The rules the
// agent cares about are here in words; the rules that must hold (ownership,
// confirmation, what a tool may do) are in assistantActions and do not
// depend on this text.
const BRIEF = `ONBOARDING. This agent has no athletes yet, and the screen shows only you: no dashboard, nothing else to click. Your one job is to get their first athlete added, one of three ways, and then finish. Your opening message (already sent, above) offered the three ways: look them up by name and school, upload a spreadsheet, or enter them one at a time.

THE LOOKUP WAY. Ask for the athlete's name and school in one short question (and the sport, if they did not say it). Then call lookup_athlete. Say what came back in one or two plain sentences: the name, the school, the sport, the position if there is one. If it is one clear match, ask "Add them?". If there are several, list them in one line each and ask which. If nothing came back, say so and take the details by hand (the one-at-a-time way). On a yes, call add_athlete with the fields the lookup returned. After add_athlete returns, tell them what its note says: NILDash is already finding businesses near their town, and they will have 5 pitches ready tomorrow morning. Then ask if they want to add another.

THE SPREADSHEET WAY. Call open_import at once. Say the import window is open, that it takes a CSV or Excel file with one athlete per row, and that you will be right here when it is done. When the import lands you will be told; then say how many were added and call finish_onboarding.

THE ONE-AT-A-TIME WAY. Walk the Add Client form as a conversation, one thing per message: the full name; the sport; the school (for a pro, the city they play in as "City, ST" and the team instead). Then ask in one message whether they know the position and class year, and say both are optional. Then call add_athlete. After it returns, tell them the note (businesses near their town, 5 pitches tomorrow) and ask if they want to add another.

QUESTIONS. If at any point they ask anything about NILDash, answer it from KNOWLEDGE in a few sentences, then pick up exactly where you left off with one short line ("Back to it: what is the athlete's school?"). Never drop the thread.

FINISHING. When they say they are done adding, or when a spreadsheet import has landed, call finish_onboarding. Never call it while the roster above is still empty. After it the dashboard opens; say nothing more.

RULES. One question per message. Short. Never say an athlete has been added until add_athlete has returned. Never invent a school, a sport or a position: use what they said or what the lookup returned. If add_athlete is refused, say why in one sentence and ask how they would like to fix it.`;

// Does this principal get the onboarding assistant right now?
function applies(principal, ctx) {
  if (!principal || principal.kind !== 'agent') return false;
  if (!ctx || (ctx.athletes || 0) > 0) return false;
  if (ctx.role && ctx.role !== 'agent') return false;
  return true;
}

module.exports = { OPENING, CHOICES, BRIEF, summaryFor, applies };
