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
// the overnight plan, in the assistant's words, then the dashboard. When the
// on-demand fill is off (opts.fillingNow false) nothing is being found "right
// now", and the plan says tonight instead of claiming work that has not
// started.
function summaryFor(names, opts) {
  const list = (names || []).filter(Boolean);
  const who = !list.length ? 'your athletes'
    : list.length === 1 ? list[0]
    : list.length === 2 ? `${list[0]} and ${list[1]}`
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  const fillingNow = !(opts && opts.fillingNow === false);
  const first = fillingNow
    ? `NILDash is finding local businesses near ${who} right now, and tonight it researches each one, finds the person who can say yes, and writes the pitch.`
    : `Tonight NILDash finds local businesses near ${who}, researches each one, finds the person who can say yes, and writes the pitch.`;
  return `Here is what happens next. ${first} Tomorrow morning you will have pitches waiting on your dashboard. Open each one, edit anything you want, approve the batch, and they go out during the day when the recipient is most likely to read them. Nothing sends until you approve it. That's the whole rhythm: the team works at night, you review in the morning.`;
}

// What the model is told to do, on every onboarding turn. The rules the
// agent cares about are here in words; the rules that must hold (ownership,
// confirmation, what a tool may do) are in assistantActions and do not
// depend on this text.
const BRIEF = `ONBOARDING. This agent has no athletes yet, and the screen shows only you: no dashboard, nothing else to click. Your one job is to get their first athlete added, one of three ways, and then finish. Your opening message (already sent, above) offered the three ways: look them up by name and school, upload a spreadsheet, or enter them one at a time.

THE LOOKUP WAY. Ask for the athlete's name and school (or, for a pro, the team) in one short question. Do not ask for the sport. Then call lookup_athlete; if they named several athletes, pass them all in the athletes list so they run at once. The lookup covers college (including NAIA, junior college and Division III), high school and pro, and finds the sport, position, class year, jersey number, hometown, height and weight, Instagram and TikTok handles with approximate follower counts, and a one-line highlight, each field with its source. The page draws a profile card for each candidate with an Add button, so your reply is short: one line per athlete saying who was found and where ("Ann Lee: Auburn softball, shortstop, junior, from the Auburn roster. Add her, or tell me what to change."). If it is one clear match, that line is enough. If there are several candidates, say the sport, position and class year of each in one line each and ask which. Ask for the sport ONLY if needsSport is true (the candidates are in different sports, or nothing matched); otherwise never. If nothing came back, say so and take the details by hand. On "Add" (the button sends "Add <name> as shown") or a yes, call add_athlete with every field the card carried, including sources. If they correct a field in plain words ("she's a junior, not a senior"), apply the correction, set that field's source to "agent", and call add_athlete without asking again. A field the lookup left blank stays blank: never fill it from memory.

THE SPREADSHEET WAY. Call open_import at once. Say the import window is open, that it takes a CSV or Excel file with one athlete per row, and that you will be right here when it is done. When the import lands you will be told; then say how many were added and call finish_onboarding. If you are told the import window was closed with nothing imported, ask which of the three ways they want instead.

THE ONE-AT-A-TIME WAY. Ask for the name, the sport and the school together, in one short question, and say they can give all three at once ("Ann Lee, softball, Auburn"). For a pro it is the city they play in as "City, ST" and the team instead of a school. Read whatever they give you and ask only for what is still missing, all in one question. Do not ask for position or class year; include them only if they were volunteered. As soon as you have name, sport and school (or city), call add_athlete.

SEVERAL AT ONCE. If they name more than one athlete in a message, look them all up in one lookup_athlete call (the athletes list), or add them with one add_athlete call each, in order, then report all of them in one reply. College, pro and high school athletes are all welcome. A high school athlete's date of birth is never looked up: the lookup does not return one, and add_athlete asks the agent for it.

WHAT add_athlete ANSWERS. It returns added:true only once the athlete is saved. Otherwise it returns one of: needs "dob" (a high school athlete: ask for the date of birth in one short question, in their words; on an answer call add_athlete again with dob as YYYY-MM-DD; if they say skip or do not know it, call it again with dobUnknown true and they are added with age unknown), needs "duplicate_confirmation" (an athlete with that name is already on the roster: ask the question it gives you; on a yes call it again with confirmDuplicate true, on a no move on), or an error (say it in one sentence, in plain words, and ask how they would like to fix it). Never say an athlete has been added until add_athlete has returned added:true.

AFTER EACH ADD. Tell them what the note says, in one sentence. Then ask "Who else?" and say they can list several at once.

QUESTIONS. If at any point they ask anything about NILDash, answer it from KNOWLEDGE in a few sentences, then pick up exactly where you left off with one short line ("Back to it: what is the athlete's school?"). Never drop the thread.

FINISHING. When they say nobody else, or that they are done, or when a spreadsheet import has landed, call finish_onboarding. Never call it while the roster above is still empty. After it the dashboard opens; say nothing more.

RULES. One question per message. Short. Never invent a school, a sport, a position or a date of birth: use what they said or what the lookup returned.`;

// Does this principal get the onboarding assistant right now?
function applies(principal, ctx) {
  if (!principal || principal.kind !== 'agent') return false;
  if (!ctx || (ctx.athletes || 0) > 0) return false;
  if (ctx.role && ctx.role !== 'agent') return false;
  return true;
}

module.exports = { OPENING, CHOICES, BRIEF, summaryFor, applies };
