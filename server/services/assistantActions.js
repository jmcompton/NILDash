'use strict';
// What the assistant is allowed to do, and how it is stopped from doing anything
// else.
//
// THE MODEL PROPOSES, THIS FILE DISPOSES. The model can only emit a tool call whose
// name appears in ACTIONS. An unknown name is dropped and logged, never dispatched.
// There is no dynamic URL, no eval, no "call this endpoint" tool.
//
// THE ASSISTANT ADDS NO NEW WRITE PATH. Every action resolves to a DIRECTIVE that
// the browser performs against an endpoint that already existed and already has its
// own auth, validation, seat limits and rate limiting. Nothing here writes to
// athletes, deals or outreach_logs. The only tables this file touches are the
// assistant's own session and pending-action tables. So the blast radius of a
// confused or manipulated model is bounded by what the agent could already do by
// clicking, not by what SQL a handler happens to contain.
//
// THREE TIERS
//   direct   the browser performs it as soon as the model asks
//   confirm  the model gets a TOKEN, not an action. See below.
//   (absent) billing has no entry at all. It is unreachable rather than blocked.
//
// CONFIRMATION IS STRUCTURAL, NOT A PROMPT RULE. "Only with explicit confirmation"
// written into a system prompt is a suggestion the model can be argued out of, and
// the conversation contains untrusted text (athlete names, business names, scan
// rationales, pasted emails) that could try to do the arguing. So a confirm-tier
// call does NOT return a directive. It mints a single-use, short-TTL token bound to
// the agent, the action and a hash of the exact arguments. The browser renders a
// button stating the literal consequence, and only a SEPARATE request carrying that
// token produces the directive. The model cannot make that request. It can ask the
// human to send an email; it cannot send one.
//
// OWNERSHIP NEVER COMES FROM THE MODEL. agentId is always taken from the session.
// When the model names an athleteId it is verified against that session before
// anything else happens, so "never another agent's data" holds by construction.

const crypto = require('crypto');
const { pool } = require('../store');

// A confirmation the agent does not act on quickly is not a confirmation. Ten
// minutes is long enough to read an email and short enough that a token found later
// in a log is already dead.
const PENDING_TTL_MS = 10 * 60 * 1000;
// One scan per athlete per assistant session. Deal Scan is the expensive direct
// action, 30-60 seconds and real money, so a confused loop must have a ceiling. The
// agent is TOLD when they hit it rather than being silently refused.
const SCANS_PER_ATHLETE_PER_SESSION = 1;

// Spoken names for the view ids, so the assistant says "Opening Deal Scan" rather
// than "Opening deals". Keys must stay in step with open_tab's enum.
const TAB_LABELS = {
  command: 'Command Center', roster: 'My Roster', deals: 'Deal Scan',
  pipeline: 'Deal Pipeline', programs: 'Programs', outreach: 'Brand Outreach',
  'email-inbox': 'Email Inbox', settings: 'Settings',
};

function _str(v, max) {
  const s = (v == null) ? '' : String(v).trim();
  return (s && s.length <= max) ? s : null;
}

// The town a school resolves to, from the same resolver the pipeline uses
// (services/schoolCheck over services/schoolResolver). Null when it does not
// resolve, so the caller says "near their school" rather than guessing.
function _townOf(school) {
  try {
    const { checkSchool } = require('./schoolCheck');
    const r = checkSchool(school || '');
    return (r && r.market) || 'their school';
  } catch (_) { return 'their school'; }
}

// The athlete lookup, replaceable for tests (the real one searches the web).
let _lookupOverride = null;
function _lookupImpl() { return _lookupOverride || require('./athleteLookup'); }
function _setLookupForTests(impl) { _lookupOverride = impl; }

// ── The registry ─────────────────────────────────────────────────────────────
// `input` is the JSON Schema handed to the model. `check` re-validates server side:
// the schema is a hint to the model, never a guarantee about what arrives.
const ACTIONS = {
  // ── add_athlete RUNS ON THE SERVER AND ANSWERS WITH WHAT HAPPENED ─────────
  // It used to hand the browser a directive to POST /api/athletes and tell the
  // model "done" before anything was saved, so a seat limit or a missing
  // school failed where the model could not see it and the agent was told an
  // athlete existed who did not. Now the tool calls the same function the
  // route calls (services/athleteCreate) and returns one of:
  //   { added: true,  id, name, note }                 the row exists
  //   { added: false, needs: 'dob', ask }              a high school athlete: ask
  //                                                    for the date of birth, or
  //                                                    call again with dobUnknown
  //   { added: false, needs: 'duplicate_confirmation', existing, ask }
  //                                                    a same-named athlete is on
  //                                                    the roster: ask, then call
  //                                                    again with confirmDuplicate
  //   { added: false, error }                          the real reason, in words
  // None of these stops the turn: with several athletes in one message the
  // rest are still added and every answer is reported together. The browser
  // is told to reload the roster on a real add.
  add_athlete: {
    tier: 'direct',
    description: 'Add a new athlete to the agent\'s roster. Requires name, sport and school (or, for a pro, the city they play in and the team). Position, class year, hometown and Instagram followers are optional. College, pro and high school athletes are all fine. Returns added:true only once the athlete is saved; otherwise it returns a question to put to the agent (needs: dob or duplicate_confirmation) or the reason it could not be saved.',
    input: {
      type: 'object',
      properties: {
        name:   { type: 'string', description: 'Full name of the athlete' },
        sport:  { type: 'string', description: 'Their sport. Required: it drives fit scoring.' },
        school: { type: 'string', description: 'The school they compete for (college or high school athlete)' },
        position: { type: 'string', description: 'Optional: their position' },
        year: { type: 'string', description: 'Optional: class year, e.g. Freshman, Sophomore, Junior, Senior' },
        hometown: { type: 'string', description: 'Optional: hometown as "City, ST"' },
        instagram: { type: 'integer', description: 'Optional: Instagram follower count' },
        athleteType: { type: 'string', enum: ['college', 'pro'], description: 'college (default, includes high school) or pro' },
        city: { type: 'string', description: 'Pro only: the city they play in, as "City, ST"' },
        team: { type: 'string', description: 'Pro only: the team' },
        dob: { type: 'string', description: 'Date of birth as YYYY-MM-DD. Asked for when the school is a high school; optional otherwise.' },
        dobUnknown: { type: 'boolean', description: 'true when the agent was asked for a high school athlete\'s date of birth and chose to skip it: add them with age unknown.' },
        confirmDuplicate: { type: 'boolean', description: 'true only after the agent was told an athlete with this name is already on the roster and said to add a second one anyway.' },
      },
      required: ['name', 'sport'],
    },
    // Sport is required by the create path and the validation is NOT loosened
    // here: sport drives fit scoring, so an athlete without one scores wrong rather
    // than scoring not at all, which is worse. A school (or a pro's city) is
    // required for the same reason the endpoint requires it: it is the local
    // lane's town, and an athlete without one gets no cards.
    check: (a) => {
      const name = _str(a.name, 120), sport = _str(a.sport, 60), school = _str(a.school, 120);
      const pro = a.athleteType === 'pro';
      const city = _str(a.city, 120), team = _str(a.team, 120);
      if (!name) return { error: 'A full name is needed.' };
      if (!sport) return { error: 'A sport is needed. It drives the fit scoring, so it cannot be left out.' };
      if (!pro && !school) return { error: 'A school is needed. The nightly run uses it to find local businesses.' };
      if (pro && !city) return { error: 'A pro needs the city they play in, as "City, ST". The nightly run finds local businesses there.' };
      const args = { name, sport, athleteType: pro ? 'pro' : 'college' };
      if (pro) { args.city = city; if (team) args.team = team; args.school = ''; }
      else args.school = school;
      const position = _str(a.position, 60), year = _str(a.year, 30), hometown = _str(a.hometown, 120);
      if (position) args.position = position;
      if (year) args.year = year;
      if (hometown) args.hometown = hometown;
      const ig = parseInt(a.instagram, 10);
      if (Number.isFinite(ig) && ig >= 0) args.instagram = ig;
      if (a.dob != null && String(a.dob).trim()) {
        const AC = require('./athleteCreate');
        const dob = AC._validDob(String(a.dob).trim());
        if (!dob) return { error: 'That date of birth did not read as a real past date. Give it as YYYY-MM-DD, or say skip.' };
        args.dob = dob;
      }
      if (a.dobUnknown === true) args.dobUnknown = true;
      if (a.confirmDuplicate === true) args.confirmDuplicate = true;
      return { args };
    },
    run: async (args, ctx) => {
      const AC = require('./athleteCreate');
      const agentId = ctx && ctx.agentId;
      // A high school athlete's age is what the compliance gate needs most, so
      // the date of birth is asked for once. Skipping is allowed and honest:
      // they are added with age unknown, which holds restricted categories.
      if (args.athleteType !== 'pro' && !args.dob && !args.dobUnknown && AC.isHighSchool(args.school)) {
        return { data: { added: false, needs: 'dob', name: args.name, school: args.school,
          ask: `${args.school} looks like a high school. What is ${args.name}'s date of birth? It goes on the record so the compliance gate can rule on age-restricted businesses. If you do not have it, say skip and they are added with age unknown.` } };
      }
      // The roster is checked by name the way the spreadsheet import checks it
      // (case, spacing and punctuation folded). A match is a question, not a
      // refusal: two athletes can share a name.
      if (!args.confirmDuplicate) {
        const dup = await AC.findDuplicate(agentId, args.name);
        if (dup) {
          const where = dup.athlete_type === 'pro' ? (dup.city || 'pro') : (dup.school || 'school unknown');
          return { data: { added: false, needs: 'duplicate_confirmation', existing: { id: dup.id, name: dup.name, sport: dup.sport, school: dup.school, city: dup.city },
            ask: `${dup.name} is already on the roster (${dup.sport || 'sport unknown'}, ${where}). Add a second ${args.name} anyway?` } };
        }
      }
      const user = await require('../store').getUser(agentId);
      if (!user) return { data: { added: false, error: 'Your account could not be read just now. Try again in a moment.' } };
      const body = { name: args.name, sport: args.sport, athleteType: args.athleteType, school: args.school,
        city: args.city, team: args.team, position: args.position, year: args.year, hometown: args.hometown,
        instagram: args.instagram, dob: args.dob };
      let r;
      try { r = await AC.createAthlete(user, body, { allowDuplicate: args.confirmDuplicate === true }); }
      catch (e) {
        console.error(`[assistant] agent=${agentId} add_athlete save failed: ${e.message}`);
        return { data: { added: false, error: 'The save failed on our side (' + e.message + '). Nothing was added. Try again, or add them from the Add Client page.' } };
      }
      if (!r.ok) return { data: { added: false, error: r.error, code: r.code || null } };
      console.log(`[assistant] agent=${agentId} add_athlete saved ${r.athlete.id} (${args.name})${r.created ? '' : ' (already saved a moment ago)'}`);
      return {
        data: { added: true, id: r.athlete.id, name: args.name, note: ACTIONS.add_athlete.say(args) },
        directive: { kind: 'reload_athletes', athleteId: r.athlete.id },
        say: ACTIONS.add_athlete.say(args),
      };
    },
    // The town the local lane will search, named in the note so the assistant
    // can say "already finding businesses near Auburn, AL" rather than "near
    // their school". Resolved the same way the pipeline resolves it; a school
    // that does not resolve gets the honest "near their school". When the
    // on-demand fill is off, the businesses are found tonight, and the note
    // says that instead of claiming work that has not started.
    say: (args) => {
      const AC = require('./athleteCreate');
      const where = args.athleteType === 'pro' ? args.city : _townOf(args.school);
      const head = `Added ${args.name} (${args.sport}, ${args.athleteType === 'pro' ? args.city : args.school}). `;
      const plan = AC.fillOnDemandEnabled()
        ? `NILDash is already finding businesses near ${where}. They will have 5 pitches ready tomorrow morning.`
        : `Their pitches will be ready tomorrow morning: NILDash finds businesses near ${where} tonight.`;
      const age = args.dobUnknown ? ' Age is unknown, so age-restricted businesses are held until a date of birth is on file.' : '';
      return head + plan + age;
    },
  },

  // ── ONBOARDING TOOLS ───────────────────────────────────────────────────────
  // lookup_athlete READS: it runs the same lookup the Add Client form's AI
  // Lookup button runs and hands the candidates to the model, which then asks
  // the agent to confirm before add_athlete is ever called. It creates nothing.
  lookup_athlete: {
    tier: 'direct',
    read: true,
    description: 'Look an athlete up by name and school (and sport if known). Returns up to three candidates with school, sport, position and class year for the agent to confirm. Creates nothing.',
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name' },
        school: { type: 'string', description: 'School, if known' },
        sport: { type: 'string', description: 'Sport, if known' },
        athleteType: { type: 'string', enum: ['college', 'pro'] },
        team: { type: 'string', description: 'Pro only: team, if known' },
        city: { type: 'string', description: 'Pro only: city, if known' },
      },
      required: ['name'],
    },
    check: (a) => {
      const name = _str(a.name, 120);
      if (!name) return { error: 'Whose name should I look up?' };
      return { args: { name, school: _str(a.school, 120) || '', sport: _str(a.sport, 60) || '',
        athleteType: a.athleteType === 'pro' ? 'pro' : 'college', team: _str(a.team, 120) || '', city: _str(a.city, 120) || '' } };
    },
    run: async (args) => {
      const ai = require('../ai');
      const { resolveAthlete } = _lookupImpl();
      const r = await resolveAthlete(ai, args);
      const cands = (r && Array.isArray(r.candidates) ? r.candidates : []).slice(0, 3).map((c) => ({
        name: c.name, school: c.school || null, sport: c.sport || null, position: c.position || null,
        year: c.year || null, hometown: c.hometown || null, instagram: c.instagram || 0,
        athleteType: c.athleteType || args.athleteType, team: c.team || null, city: c.city || null,
        confidence: c.confidence == null ? null : c.confidence, source: c.sourceLabel || null,
      }));
      return { found: cands.length > 0, candidates: cands, note: r && r.searchNote ? String(r.searchNote).slice(0, 300) : null };
    },
  },

  open_import: {
    tier: 'direct',
    description: 'Open the spreadsheet import window, where the agent uploads a CSV or Excel roster. Use it the moment they choose the spreadsheet way.',
    input: { type: 'object', properties: {} },
    check: () => ({ args: {} }),
    directive: () => ({ kind: 'open_import' }),
    say: () => 'The import window is open. Upload a CSV or Excel file with one athlete per row, and I will be right here when it is done.',
  },

  finish_onboarding: {
    tier: 'direct',
    description: 'Finish onboarding once at least one athlete is on the roster: shows the overnight plan and opens the dashboard. Never call it while the roster is empty.',
    input: { type: 'object', properties: {} },
    check: () => ({ args: {} }),
    // Guarded on the real roster, not on the model's belief about it.
    limit: async (session, args, ctx) => {
      const agentId = ctx && ctx.agentId;
      const r = await pool.query('SELECT COUNT(*)::int AS n FROM athletes WHERE agent_id=$1', [agentId]).catch(() => ({ rows: [{ n: 0 }] }));
      if (!(r.rows[0] && r.rows[0].n > 0)) return 'There is no athlete on the roster yet, so there is nothing to finish. Add one first.';
      return null;
    },
    directive: () => ({ kind: 'finish_onboarding' }),
    say: () => 'Opening your dashboard.',
  },

  run_deal_scan: {
    tier: 'direct',
    description: 'Run a Deal Scan for one athlete on the agent\'s roster.',
    // NO LANE ARGUMENT. A scan runs every lane, which is what an agent means when
    // they ask for one, and _dsRunScan never read the lane the assistant passed
    // anyway: it only branches on opts.deepen. Offering an argument the app ignores
    // is worse than not offering it, because the model describes what it thinks it
    // did rather than what happened.
    input: {
      type: 'object',
      properties: {
        athleteId: { type: 'string', description: 'Athlete id from the roster context' },
      },
      required: ['athleteId'],
    },
    ownsAthlete: true,
    check: (a) => {
      const athleteId = _str(a.athleteId, 80);
      if (!athleteId) return { error: 'Which athlete? I need one from the roster.' };
      return { args: { athleteId } };
    },
    // Capped per session, and the cap is reported. Enforced here, before the
    // directive is issued, so the ceiling does not depend on the browser obeying it.
    limit: async (session, args) => {
      const used = (session.scans_run || {})[args.athleteId] || 0;
      if (used >= SCANS_PER_ATHLETE_PER_SESSION) {
        return `I have already run a scan for that athlete in this conversation, so I am not going to run another one. `
          + `Deal Scan takes about a minute and costs money each time. `
          + `If you want a fresh set, use the Refresh button on the Deal Scan tab, or start a new session.`;
      }
      return null;
    },
    onRun: (session, args) => {
      session.scans_run = session.scans_run || {};
      session.scans_run[args.athleteId] = (session.scans_run[args.athleteId] || 0) + 1;
    },
    directive: (args) => ({ kind: 'run_deal_scan', athleteId: args.athleteId }),
    say: () => 'Running the scan now. It takes about a minute.',
  },

  open_tab: {
    tier: 'direct',
    description: 'Open one of the app\'s tabs.',
    // THESE ARE REAL VIEW IDS, checked against id="view-..." in index.html. The old
    // list offered 'dashboard', 'athletes' and 'deal-scan', none of which exist:
    // showView removes 'active' from every view BEFORE looking the new one up, so
    // each of those blanked the entire main content area and then threw on
    // null.classList. Exactly the failure the run_deal_scan hook had, still reachable
    // here because showView(d.tab) is dynamic and no literal-string check catches it.
    input: {
      type: 'object',
      properties: {
        tab: {
          type: 'string',
          enum: ['command', 'roster', 'deals', 'pipeline', 'programs', 'outreach', 'email-inbox', 'settings'],
          description: 'command = Command Center, roster = My Roster, deals = Deal Scan, '
            + 'pipeline = Deal Pipeline, outreach = Brand Outreach',
        },
      },
      required: ['tab'],
    },
    check: (a) => {
      const allowed = ['command', 'roster', 'deals', 'pipeline', 'programs', 'outreach', 'email-inbox', 'settings'];
      if (!allowed.includes(a.tab)) return { error: 'I do not know that tab.' };
      return { args: { tab: a.tab } };
    },
    // The only action with no server side at all, and the only one the client may
    // refuse: it will not navigate away from an outreach draft with unsaved edits.
    directive: (args) => ({ kind: 'open_tab', tab: args.tab }),
    say: (args) => `Opening ${TAB_LABELS[args.tab] || args.tab}.`,
  },

  lookup_program: {
    tier: 'direct',
    description: 'Look up a school\'s program staff in the Programs tab.',
    input: {
      type: 'object',
      properties: {
        school: { type: 'string' },
        sport: { type: 'string', enum: ['football', 'mens_basketball'] },
      },
      required: ['school'],
    },
    check: (a) => {
      const school = _str(a.school, 120);
      if (!school) return { error: 'Which school?' };
      const sport = ['football', 'mens_basketball'].includes(a.sport) ? a.sport : 'football';
      return { args: { school, sport } };
    },
    directive: (args) => ({ kind: 'lookup_program', school: args.school, sport: args.sport }),
    say: (args) => `Looking up ${args.school}.`,
  },

  connect_gmail: {
    tier: 'direct',
    description: 'Start the Gmail connect flow so the agent can send outreach.',
    input: { type: 'object', properties: {} },
    check: () => ({ args: {} }),
    // Starts an OAuth flow. Connects nothing by itself: Google still asks the human.
    directive: () => ({ kind: 'connect_gmail' }),
    say: () => 'Sending you to Google to connect Gmail. You will come straight back.',
  },

  build_media_kit: {
    tier: 'direct',
    description: 'Build the base media kit for one athlete. Not a per-brand variant.',
    input: {
      type: 'object',
      properties: { athleteId: { type: 'string' } },
      required: ['athleteId'],
    },
    ownsAthlete: true,
    check: (a) => {
      const athleteId = _str(a.athleteId, 80);
      if (!athleteId) return { error: 'Which athlete?' };
      return { args: { athleteId } };
    },
    directive: (args) => ({ kind: 'post', url: '/api/agent/athlete-media-kit/' + encodeURIComponent(args.athleteId), body: {}, then: 'media_kit_built' }),
    say: () => 'Building the base media kit.',
  },

  // ── Confirm tier ───────────────────────────────────────────────────────────
  // These never return a directive from the model's call. They return a token and a
  // sentence describing exactly what will happen, and the human presses the button.
  send_outreach: {
    tier: 'confirm',
    description: 'Send an outreach email that is already drafted. Requires the agent to confirm in the chat.',
    input: {
      type: 'object',
      properties: {
        outreachId: { type: 'string', description: 'The draft to send' },
        toEmail: { type: 'string', description: 'Recipient address, exactly as published' },
      },
      required: ['outreachId', 'toEmail'],
    },
    check: (a) => {
      const outreachId = _str(a.outreachId, 80);
      const toEmail = _str(a.toEmail, 200);
      if (!outreachId) return { error: 'Which draft?' };
      if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) return { error: 'That is not a usable email address.' };
      return { args: { outreachId, toEmail: toEmail.toLowerCase() } };
    },
    confirmText: (args) => `Send this email to ${args.toEmail}?`,
    // The card renders the label above the sentence and bolds the subject inside it.
    // The subject is sent SEPARATELY and matched against the escaped sentence client
    // side, so the server never ships markup for the browser to trust.
    confirmLabel: 'Confirm before sending',
    confirmSubject: (args) => args.toEmail,
    confirmButton: 'Send it',
    directive: (args) => ({ kind: 'send_outreach', outreachId: args.outreachId, toEmail: args.toEmail }),
  },

  update_deal: {
    tier: 'confirm',
    description: 'Change a deal\'s stage, including marking it closed. Requires confirmation.',
    input: {
      type: 'object',
      properties: {
        dealId: { type: 'string' },
        stage: { type: 'string', description: 'The new stage, for example Closed' },
      },
      required: ['dealId', 'stage'],
    },
    check: (a) => {
      const dealId = _str(a.dealId, 80), stage = _str(a.stage, 40);
      if (!dealId) return { error: 'Which deal?' };
      if (!stage) return { error: 'Change it to what?' };
      return { args: { dealId, stage } };
    },
    confirmText: (args) => `Change that deal to "${args.stage}"?`,
    confirmLabel: 'Confirm before changing',
    confirmSubject: (args) => args.stage,
    confirmButton: 'Change it',
    directive: (args) => ({ kind: 'update_deal', dealId: args.dealId, stage: args.stage }),
  },

  delete_athlete: {
    tier: 'confirm',
    description: 'Remove an athlete from the roster. Requires confirmation.',
    input: {
      type: 'object',
      properties: { athleteId: { type: 'string' }, name: { type: 'string' } },
      required: ['athleteId'],
    },
    ownsAthlete: true,
    check: (a) => {
      const athleteId = _str(a.athleteId, 80);
      if (!athleteId) return { error: 'Which athlete?' };
      return { args: { athleteId, name: _str(a.name, 120) || null } };
    },
    confirmText: (args) => `Delete ${args.name || 'that athlete'} and everything attached to them? This cannot be undone.`,
    confirmLabel: 'Confirm before deleting',
    confirmSubject: (args) => args.name || null,
    confirmButton: 'Delete',
    directive: (args) => ({ kind: 'delete_athlete', athleteId: args.athleteId }),
  },
};

// BILLING IS ABSENT ON PURPOSE. There is no billing entry, so there is nothing to
// bypass: a model asking to change a plan gets "I cannot do that" from the same
// unknown-tool path that catches a hallucinated name.
const FORBIDDEN_TOPICS = ['billing', 'subscription', 'plan change', 'refund', 'card', 'invoice to us'];

// The tool definitions handed to the model. Confirm-tier actions ARE offered, with
// their description saying plainly that they need confirmation, because hiding them
// would just make the model claim it cannot do things it can ask for.
function toolDefs() {
  return Object.entries(ACTIONS).map(([name, a]) => ({
    name,
    description: a.description + (a.tier === 'confirm' ? ' This asks the agent to confirm before anything happens.' : ''),
    input_schema: a.input,
  }));
}

function isKnownAction(name) { return Object.prototype.hasOwnProperty.call(ACTIONS, name); }

// THE ownership control. An agent owns the athletes on their roster; an athlete
// owns exactly one row -- themselves -- and the check is identity, not a query, so
// there is no filter to get subtly wrong and no way for another id to satisfy it.
//
// A self-managed athlete has agent_id NULL, so running the agent query for an
// athlete principal would never match anything; without this branch the assistant
// would refuse every action she took on her own data.
async function _ownsAthlete(principal, athleteId) {
  if (principal && principal.kind === 'athlete') return String(athleteId) === String(principal.id);
  const agentId = principal && principal.id;
  const r = await pool.query('SELECT 1 FROM athletes WHERE id=$1 AND agent_id=$2', [athleteId, agentId]);
  return r.rowCount > 0;
}

// What an athlete may ask the assistant to do. DEFAULT DENY: anything not named
// here is refused for an athlete even if the model asks for it, so a new action
// added later is closed to athletes until someone decides otherwise.
//
// add_athlete and delete_athlete are absent because an athlete has no roster;
// update_deal is absent because it edits agent-side deal records.
const ATHLETE_ALLOWED_ACTIONS = new Set([
  'run_deal_scan',    // her own scan, scoped by the ownership check above
  'open_tab',         // navigation only
  'lookup_program',   // read-only, keyed by sport and school
  'build_media_kit',  // her own kit
  'send_outreach',    // her own outreach, confirm-tier
  'connect_gmail',    // her own mailbox
]);

/**
 * Resolve one tool call from the model into something the browser may do.
 *
 * Returns one of:
 *   { ok:true,  directive, say }              a direct action, go ahead
 *   { ok:true,  confirm:{token,text,button,label,subject} } confirm, ask the human
 *   { ok:false, message }                     refused, and why, in words for the agent
 *
 * Never throws on bad input: a malformed call is a refusal with a reason, because a
 * thrown error inside a chat turn just looks like the assistant broke.
 */
async function resolveCall(name, rawArgs, ctx) {
  const { agentId, session } = ctx;
  // An older caller that passes no principal is treated as an agent, which is what
  // it was before principals existed. Athlete scope is never assumed by default.
  const principal = ctx.principal || { kind: 'agent', id: agentId };
  if (!isKnownAction(name)) {
    console.warn(`[assistant] ${principal.kind}=${agentId} UNKNOWN action "${name}" dropped`);
    return { ok: false, message: 'That is not something I can do.' };
  }
  // Default deny for athletes, checked before anything else runs.
  if (principal.kind === 'athlete' && !ATHLETE_ALLOWED_ACTIONS.has(name)) {
    console.warn(`[assistant] athlete=${principal.id} action=${name} REFUSED: not available to athletes`);
    return { ok: false, message: 'That is not something I can do from your account.' };
  }
  const action = ACTIONS[name];
  let args0 = (rawArgs && typeof rawArgs === 'object') ? rawArgs : {};

  // AN ATHLETE IS THE SUBJECT, NEVER A PARAMETER. Every ownership-checked action
  // takes an athleteId, and the model was asking "which athlete?" because the tool
  // schema demands one -- a question with exactly one possible answer, put to the
  // person who is that answer.
  //
  // Her id is FORCED here, overwriting anything the model supplied. That is both the
  // fix for the question and a second lock on isolation: even a model that names
  // another athlete's id has it replaced before the ownership check, so the check
  // now has nothing left to catch on this path.
  if (principal.kind === 'athlete' && action.ownsAthlete) {
    if (args0.athleteId && String(args0.athleteId) !== String(principal.id)) {
      console.warn(`[assistant] athlete=${principal.id} action=${name}: model supplied athleteId ${args0.athleteId}, overridden with the caller's own id`);
    }
    args0 = Object.assign({}, args0, { athleteId: principal.id });
  }

  const checked = action.check(args0);
  if (checked.error) return { ok: false, message: checked.error };
  const args = checked.args;

  // Ownership is re-derived from the session, never trusted from the model.
  if (action.ownsAthlete) {
    const owns = await _ownsAthlete(principal, args.athleteId);
    if (!owns) {
      console.warn(`[assistant] ${principal.kind}=${principal.id} action=${name} REFUSED: athlete ${args.athleteId} is not theirs`);
      return { ok: false, message: principal.kind === 'athlete'
        ? 'I can only work with your own account.'
        : 'I cannot find that athlete on your roster.' };
    }
  }

  if (action.limit) {
    const blocked = await action.limit(session, args, { agentId, principal });
    if (blocked) {
      console.log(`[assistant] agent=${agentId} action=${name} hit its session cap`);
      return { ok: false, message: blocked, capped: true };
    }
  }

  // A READ tool answers rather than acts: it runs here, on the server, and
  // its result goes back to the model. No directive, nothing for the browser.
  if (action.read && action.run) {
    try {
      const data = await action.run(args, { agentId, principal });
      console.log(`[assistant] agent=${agentId} read=${name} ok`);
      return { ok: true, data };
    } catch (e) {
      console.warn(`[assistant] agent=${agentId} read=${name} failed: ${e.message}`);
      return { ok: false, message: 'The lookup did not work just now. We can enter the details by hand instead.' };
    }
  }

  // A tool that DOES its work on the server (add_athlete) answers the model
  // with what happened, and may also hand the browser a directive (reload the
  // roster). Its questions and failures are answers too, not refusals, so a
  // message naming several athletes is worked through to the end.
  if (action.run) {
    let r;
    try { r = await action.run(args, { agentId, principal, session }); }
    catch (e) {
      console.warn(`[assistant] agent=${agentId} action=${name} failed: ${e.message}`);
      return { ok: false, message: 'That did not work just now (' + e.message + '). Nothing was changed.' };
    }
    if (r && r.refused) return { ok: false, message: r.refused };
    console.log(`[assistant] agent=${agentId} action=${name} ran`);
    return { ok: true, data: r ? r.data : undefined, directive: (r && r.directive) || null, say: (r && r.say) || null };
  }

  if (action.tier === 'confirm') {
    const token = await mintPending(agentId, session.id, name, args);
    return {
      ok: true,
      confirm: {
        token,
        text: action.confirmText(args),
        button: action.confirmButton || 'Confirm',
        label: action.confirmLabel || 'Confirm before continuing',
        subject: action.confirmSubject ? action.confirmSubject(args) : null,
      },
    };
  }

  if (action.onRun) action.onRun(session, args);
  console.log(`[assistant] agent=${agentId} action=${name} allowed`);
  return { ok: true, directive: action.directive(args), say: action.say ? action.say(args) : null };
}

// ── Pending confirmations ────────────────────────────────────────────────────
function _hash(name, args) {
  return crypto.createHash('sha256').update(name + '|' + JSON.stringify(args)).digest('hex');
}

async function mintPending(agentId, sessionId, name, args) {
  const token = 'pa_' + crypto.randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO assistant_pending_actions (token, agent_id, session_id, action, args, args_hash, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6, NOW() + INTERVAL '10 minutes', NOW())`,
    [token, agentId, sessionId, name, JSON.stringify(args), _hash(name, args)]);
  console.log(`[assistant] agent=${agentId} action=${name} PENDING, awaiting confirmation`);
  return token;
}

/**
 * Redeem a confirmation token. This is the ONLY way a confirm-tier action becomes a
 * directive, and it is reached by a request the browser makes after a human clicks,
 * never by anything the model emits.
 *
 * Single use, agent-scoped, TTL-bounded, and the stored arguments are re-verified
 * against their own hash so a row edited between mint and redeem cannot change what
 * gets done.
 */
// principal is threaded here too. The token row is already bound to the owner id,
// so redemption is scoped correctly either way -- but the ownership RECHECK below
// runs at execution time, and passing a bare id where a principal is expected would
// make principal.kind undefined and send an athlete down the agent query, refusing
// her own confirmed action.
async function redeemPending(agentId, token, principal) {
  principal = principal || { kind: 'agent', id: agentId };
  if (!token || typeof token !== 'string') return { ok: false, message: 'Nothing to confirm.' };
  const r = await pool.query(
    `UPDATE assistant_pending_actions
        SET used = TRUE, used_at = NOW()
      WHERE token = $1 AND agent_id = $2 AND used = FALSE AND expires_at > NOW()
      RETURNING action, args, args_hash`,
    [token, agentId]);
  const row = r.rows[0];
  if (!row) {
    console.warn(`[assistant] agent=${agentId} token redeem FAILED (unknown, used, expired or not theirs)`);
    return { ok: false, message: 'That confirmation has expired or was already used. Ask me again and I will set it up fresh.' };
  }
  const action = ACTIONS[row.action];
  if (!action || action.tier !== 'confirm') {
    return { ok: false, message: 'That is not something I can do.' };
  }
  const args = row.args || {};
  if (_hash(row.action, args) !== row.args_hash) {
    console.error(`[assistant] agent=${agentId} token ${token} args do not match their hash. Refusing.`);
    return { ok: false, message: 'Something about that request changed after you were asked. I have not done it.' };
  }
  // Ownership is checked AGAIN at execution, not only at mint time: the roster can
  // change in the ten minutes a token is alive.
  if (action.ownsAthlete && !(await _ownsAthlete(principal, args.athleteId))) {
    return { ok: false, message: principal.kind === 'athlete'
      ? 'I can only work with your own account.'
      : 'I cannot find that athlete on your roster any more.' };
  }
  console.log(`[assistant] agent=${agentId} action=${row.action} CONFIRMED by the agent, executing`);
  return { ok: true, action: row.action, directive: action.directive(args) };
}

// The onboarding tools are offered only on onboarding turns: an agent with a
// roster has an import button and a dashboard already, and "finish
// onboarding" means nothing to them.
const ONBOARDING_ONLY = new Set(['lookup_athlete', 'open_import', 'finish_onboarding']);
function toolDefsFor(mode) {
  const all = toolDefs();
  return mode === 'onboarding' ? all : all.filter((t) => !ONBOARDING_ONLY.has(t.name));
}

module.exports = {
  ACTIONS, toolDefs, toolDefsFor, ONBOARDING_ONLY, isKnownAction, resolveCall, mintPending, redeemPending,
  FORBIDDEN_TOPICS, PENDING_TTL_MS, SCANS_PER_ATHLETE_PER_SESSION, _setLookupForTests, _townOf,
};
