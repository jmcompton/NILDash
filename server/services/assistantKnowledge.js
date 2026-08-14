'use strict';
// The assistant's product knowledge.
//
// THIS IS THE ONLY THING THE ASSISTANT MAY STATE AS FACT about how NILDash works.
// The system prompt tells it that anything not answered here is something it does
// not know, and that it must say so and offer to pass the question on rather than
// reason its way to a plausible answer.
//
// EDITING. Change the text between the markers and nothing else in this file has to
// change. hasKnowledge() reports whether real content is present, and the route logs
// it on boot, so "the assistant is answering vaguely" has an obvious first thing to
// check. Keep it as prose: it is read by a model, not parsed.
//
// It is a template literal, so a backtick or a ${ in the text would break the file.
// There are none today; if you paste some, escape them.

const KNOWLEDGE = `
<!-- PASTE KNOWLEDGE BASE HERE -->

NILDash: what it is and how it works

NILDash is a deal sourcing tool for sports agents. It finds brand deals for an
agent's athletes, finds the person at each business who can actually say yes, and
drafts the outreach. It is built for the athletes nobody is chasing yet, not the ones
with brands already coming to them.

It costs $99 a month per agent. There is no per-athlete charge, on purpose, so an
agent can put their whole roster in without thinking about cost.

ADD CLIENT

Type an athlete's name and hit AI Lookup. It searches college rosters and news
coverage to find their school, sport, class year, and hometown, and fills the form
in.

It works well for D1 athletes. It is less reliable for smaller schools and
non-revenue sports. If it does not find them, the agent can type everything in by
hand and nothing is lost.

Instagram followers fetch automatically from the handle. For private accounts the
number is estimated from cached web sources and can be off by a few hundred. The
agent can type over it.

Sport is required because it drives the fit scoring. School and hometown are optional
but both make Deal Scan better, because the scan searches the school's market and the
hometown market.

Interests matter too. If an athlete is into fishing or cars or skincare, put it in.
The scan favors businesses that match.

DEAL SCAN

Pick a client, hit Scan Deals with AI. Three lanes come back.

Local is businesses near the athlete's school, plus their hometown if it is set.
These are real businesses that are actively spending on marketing. Ranked by fit,
each with a score and a specific reason.

Social is brands running affiliate or athlete programs. Usually commission or product
rather than cash. This lane is often the better fit for an athlete with a smaller
following, because the brand does not need reach to say yes.

Top NIL Spenders is national brands with a history of paying athletes.

Every card shows a fit score and a "why" that names the specific reason this business
fits this athlete. Not generic. If a rationale reads like it could be about any
business, that is a bug worth reporting.

Refresh pulls businesses the agent has not been shown before. A ledger tracks what
has already been surfaced so the same barbershop does not come back every scan.
Businesses already contacted are excluded.

A scan takes 30 to 60 seconds and costs real money to run, so it is not free to spam.
Refresh is the cheaper way to see more.

If a market comes back thin, it is thin. Small towns have fewer businesses that
market. Say so rather than pretending otherwise.

THE CONTACT

This is the hardest thing NILDash does and the main reason to use it. Anyone can find
a business. Finding the human who can say yes is the work.

When a card is opened it runs a six-source search: the business website, Facebook,
chamber of commerce listings, Google Maps, news coverage, LinkedIn, and business
registries. It is looking for a named person, not a front desk.

Then it tries to get that person's direct email, their phone if it is published
anywhere, and their Instagram. A lot of small business owners answer a DM faster than
an email.

Confidence is labeled honestly:
- Confident means the person is named and the email is on the business's own domain.
- Likely means the pattern matched but was not verified.
- Main line means no named person was found. It gives the business number and tells
  the agent who to ask for.

If an email is on a different domain than the business website, it says so. That
usually means a former business name and is worth checking before sending.

It never guesses an email address. If it cannot find one it says so.

A main line is still useful. It is not a failure.

AI OUTREACH

Opens with the email already written, because drafting happens in the background
right after the scan. There is a subject, a body, and an Instagram DM version
underneath.

The draft uses the specific reason this business fits this athlete. If it reads
generic, that is a bug.

While the modal is open it runs the deep contact search for that business. The agent
will see "finding decision maker" for a few seconds. When a name comes back the
greeting updates and the To field fills in. If it finds nobody it says so and keeps
the main line.

Everything is editable before sending.

Send goes through the agent's own Gmail, so the email comes from their address, not
from NILDash. Gmail has to be connected once. If it is not connected there is a
Connect button right in the From slot, and the draft is saved and waiting when they
come back.

If an agent has run scans but sent no outreach, an unconnected Gmail is the most
likely reason. That is worth checking first.

A media kit can be attached if the athlete has one.

PROGRAMS

Pick a sport first, football or men's basketball, then search a school.

It returns the people who decide roster spots: general manager, director of
operations, player personnel, recruiting, head coach, assistants. Names, titles,
emails, phones, and a source link to the school's own staff directory so anything can
be verified.

Coverage is 119 football programs and 126 men's basketball programs. Nine
basketball schools have no entry because their sites publish only a
department-wide directory.

It shows decision makers only, not the full support staff, and it says how many it
hid.

This is the portal tool. When an agent is moving a player or figuring out who runs a
program, this is where to start.

Some schools have no entry for a sport. That means their site publishes only a
department-wide directory with no usable staff page. Showing nothing is deliberate. A
wrong contact is worse than a missing one.

MEDIA KIT

Builds a shareable page for an athlete with their stats, photos, following, and rate
card. Produces a public link that can be texted or attached to an email. Takes a few
minutes to fill in.

PIPELINE

Every business added to the pipeline moves through stages: contacted, in
conversation, negotiating, closed. This is where an agent sees what is actually
moving.

MY ROSTER

The agent's athletes. Clicking one shows their scans, outreach, and deals.

THINGS THAT ARE COMMONLY CONFUSING

"Why is this business here?" Every card has a rationale naming the specific reason.
If it is not obvious, read the why.

"The follower count is wrong." Private accounts are estimated. Type over it.

"There is no email for this contact." NILDash never invents one. Use the main line
and ask for the person by name.

"The same businesses keep coming back." Hit Refresh. That pulls ones not yet shown.

"This school has no basketball contacts." That school publishes only a department
directory. Nothing is better than wrong.

"Nothing happens when I hit send." Gmail is probably not connected. There is a
Connect button in the From slot.

WHAT NILDASH DOES NOT DO

- It does not handle payments, contracts execution, or money movement.
- It does not have athlete valuation data or projected NIL value.
- It does not cover women's basketball or sports other than football and men's
  basketball in Programs.
- It does not guarantee a business will respond. It finds the right person to ask.

<!-- END KNOWLEDGE BASE -->
`.trim();

// True once real content has replaced the placeholder. Checked by the route so the
// state is visible in the logs rather than inferred from bad answers.
function hasKnowledge() {
  return !/has not been added yet/.test(KNOWLEDGE);
}

module.exports = { KNOWLEDGE, hasKnowledge };
