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

function _str(v, max) {
  const s = (v == null) ? '' : String(v).trim();
  return (s && s.length <= max) ? s : null;
}

// ── The registry ─────────────────────────────────────────────────────────────
// `input` is the JSON Schema handed to the model. `check` re-validates server side:
// the schema is a hint to the model, never a guarantee about what arrives.
const ACTIONS = {
  add_athlete: {
    tier: 'direct',
    description: 'Add a new athlete to the agent\'s roster. Requires name, sport and school.',
    input: {
      type: 'object',
      properties: {
        name:   { type: 'string', description: 'Full name of the athlete' },
        sport:  { type: 'string', description: 'Their sport. Required: it drives fit scoring.' },
        school: { type: 'string', description: 'The school they compete for' },
      },
      required: ['name', 'sport', 'school'],
    },
    // Sport is required by POST /api/athletes and the validation is NOT loosened
    // here: sport drives fit scoring, so an athlete without one scores wrong rather
    // than scoring not at all, which is worse.
    check: (a) => {
      const name = _str(a.name, 120), sport = _str(a.sport, 60), school = _str(a.school, 120);
      if (!name) return { error: 'A full name is needed.' };
      if (!sport) return { error: 'A sport is needed. It drives the fit scoring, so it cannot be left out.' };
      if (!school) return { error: 'A school is needed.' };
      return { args: { name, sport, school } };
    },
    directive: (args) => ({ kind: 'post', url: '/api/athletes', body: args, then: 'reload_athletes' }),
    say: (args) => `Adding ${args.name} (${args.sport}, ${args.school}).`,
  },

  run_deal_scan: {
    tier: 'direct',
    description: 'Run a Deal Scan for one athlete on the agent\'s roster.',
    input: {
      type: 'object',
      properties: {
        athleteId: { type: 'string', description: 'Athlete id from the roster context' },
        lane: { type: 'string', enum: ['local', 'topnil', 'social'], description: 'Defaults to local' },
      },
      required: ['athleteId'],
    },
    ownsAthlete: true,
    check: (a) => {
      const athleteId = _str(a.athleteId, 80);
      if (!athleteId) return { error: 'Which athlete? I need one from the roster.' };
      const lane = ['local', 'topnil', 'social'].includes(a.lane) ? a.lane : 'local';
      return { args: { athleteId, lane } };
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
    directive: (args) => ({ kind: 'run_deal_scan', athleteId: args.athleteId, lane: args.lane }),
    say: () => 'Running the scan now. It takes about a minute.',
  },

  open_tab: {
    tier: 'direct',
    description: 'Open one of the app\'s tabs.',
    input: {
      type: 'object',
      properties: {
        tab: { type: 'string', enum: ['dashboard', 'athletes', 'deal-scan', 'programs', 'deals', 'email-inbox', 'settings'] },
      },
      required: ['tab'],
    },
    check: (a) => {
      const allowed = ['dashboard', 'athletes', 'deal-scan', 'programs', 'deals', 'email-inbox', 'settings'];
      if (!allowed.includes(a.tab)) return { error: 'I do not know that tab.' };
      return { args: { tab: a.tab } };
    },
    // The only action with no server side at all, and the only one the client may
    // refuse: it will not navigate away from an outreach draft with unsaved edits.
    directive: (args) => ({ kind: 'open_tab', tab: args.tab }),
    say: (args) => `Opening ${args.tab.replace(/-/g, ' ')}.`,
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

async function _ownsAthlete(agentId, athleteId) {
  const r = await pool.query('SELECT 1 FROM athletes WHERE id=$1 AND agent_id=$2', [athleteId, agentId]);
  return r.rowCount > 0;
}

/**
 * Resolve one tool call from the model into something the browser may do.
 *
 * Returns one of:
 *   { ok:true,  directive, say }              a direct action, go ahead
 *   { ok:true,  confirm:{token,text,button} } a confirm action, ask the human
 *   { ok:false, message }                     refused, and why, in words for the agent
 *
 * Never throws on bad input: a malformed call is a refusal with a reason, because a
 * thrown error inside a chat turn just looks like the assistant broke.
 */
async function resolveCall(name, rawArgs, ctx) {
  const { agentId, session } = ctx;
  if (!isKnownAction(name)) {
    console.warn(`[assistant] agent=${agentId} UNKNOWN action "${name}" dropped`);
    return { ok: false, message: 'That is not something I can do.' };
  }
  const action = ACTIONS[name];
  const args0 = (rawArgs && typeof rawArgs === 'object') ? rawArgs : {};

  const checked = action.check(args0);
  if (checked.error) return { ok: false, message: checked.error };
  const args = checked.args;

  // Ownership is re-derived from the session, never trusted from the model.
  if (action.ownsAthlete) {
    const owns = await _ownsAthlete(agentId, args.athleteId);
    if (!owns) {
      console.warn(`[assistant] agent=${agentId} action=${name} REFUSED: athlete ${args.athleteId} is not theirs`);
      return { ok: false, message: 'I cannot find that athlete on your roster.' };
    }
  }

  if (action.limit) {
    const blocked = await action.limit(session, args);
    if (blocked) {
      console.log(`[assistant] agent=${agentId} action=${name} hit its session cap`);
      return { ok: false, message: blocked, capped: true };
    }
  }

  if (action.tier === 'confirm') {
    const token = await mintPending(agentId, session.id, name, args);
    return {
      ok: true,
      confirm: { token, text: action.confirmText(args), button: action.confirmButton || 'Confirm' },
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
async function redeemPending(agentId, token) {
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
  if (action.ownsAthlete && !(await _ownsAthlete(agentId, args.athleteId))) {
    return { ok: false, message: 'I cannot find that athlete on your roster any more.' };
  }
  console.log(`[assistant] agent=${agentId} action=${row.action} CONFIRMED by the agent, executing`);
  return { ok: true, action: row.action, directive: action.directive(args) };
}

module.exports = {
  ACTIONS, toolDefs, isKnownAction, resolveCall, mintPending, redeemPending,
  FORBIDDEN_TOPICS, PENDING_TTL_MS, SCANS_PER_ATHLETE_PER_SESSION,
};
