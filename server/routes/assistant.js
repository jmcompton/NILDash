'use strict';
// /api/assistant/*
//
// Four endpoints:
//   POST /session   open or resume a session, get the greeting and the auto-open decision
//   POST /message   one conversational turn, tools ENABLED
//   POST /confirm   redeem a confirmation token. The only way a confirm-tier action runs.
//   POST /dismiss   the agent closed the bubble without replying
//
// THE GREETING TURN HAS NO TOOLS. It is the one message the agent did not ask for, so
// it must not be able to do anything. It can still OFFER, and the prompt says so
// explicitly, because a greeting that cannot offer is a dead end: the agent says yes
// and the next turn has tools.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../store');
const ai = require('../ai');
const actions = require('../services/assistantActions');
const ctxSvc = require('../services/assistantContext');
const { systemPrompt } = require('../services/assistantPrompt');
const { hasKnowledge } = require('../services/assistantKnowledge');

const MODEL = 'claude-sonnet-4-6';   // Sonnet, named. Never Opus.
const TURN_TIMEOUT_MS = 45000;
const MAX_HISTORY = 20;              // messages replayed into a turn
const MAX_INPUT_CHARS = 4000;

console.log(`[assistant] knowledge base: ${hasKnowledge() ? 'loaded' : 'EMPTY (placeholder only)'}`);

function requireAgent(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
router.use(requireAgent);

// ── Session state ────────────────────────────────────────────────────────────
async function loadSession(agentId, sessionId) {
  if (sessionId) {
    const r = await pool.query(
      'SELECT * FROM assistant_sessions WHERE id=$1 AND agent_id=$2', [sessionId, agentId]);
    if (r.rows[0]) return r.rows[0];
  }
  const id = 'as_' + crypto.randomBytes(12).toString('hex');
  const r = await pool.query(
    `INSERT INTO assistant_sessions (id, agent_id) VALUES ($1,$2) RETURNING *`, [id, agentId]);
  return r.rows[0];
}

async function saveSession(s) {
  await pool.query(
    `UPDATE assistant_sessions SET suppressed=$2::jsonb, scans_run=$3::jsonb, replied=$4, updated_at=NOW() WHERE id=$1`,
    [s.id, JSON.stringify(s.suppressed || []), JSON.stringify(s.scans_run || {}), !!s.replied]);
}

async function history(sessionId) {
  const r = await pool.query(
    `SELECT role, content FROM assistant_messages WHERE session_id=$1 ORDER BY id DESC LIMIT $2`,
    [sessionId, MAX_HISTORY]);
  return r.rows.reverse()
    .filter((m) => m.content && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}

async function record(sessionId, agentId, role, content) {
  if (!content || !String(content).trim()) return;
  await pool.query(
    'INSERT INTO assistant_messages (session_id, agent_id, role, content) VALUES ($1,$2,$3,$4)',
    [sessionId, agentId, role, String(content).slice(0, 8000)]).catch(() => {});
}

// ── The turn ─────────────────────────────────────────────────────────────────
// `msgs` is the session transcript. Pass it when the caller has ALREADY read it, so
// the same query is not run twice for one request; omit it and this reads it itself.
async function runTurn({ agentId, session, ctx, state, userText, toolsEnabled, msgs: preMsgs }) {
  const brief = ctxSvc.STATE_BRIEFS[state] || ctxSvc.STATE_BRIEFS.returning;
  const suppressed = Array.isArray(session.suppressed) ? session.suppressed : [];

  // NEVER-NAG, ENFORCED BY OMISSION. If this state's suggestion has already been
  // offered and ignored, the instruction to make it is removed from the prompt
  // entirely. The model is not asked to refrain; it is not told to do it.
  const alreadyOffered = brief.suggestionKey && suppressed.includes(brief.suggestionKey);
  const effectiveBrief = alreadyOffered
    ? 'They have already been offered the obvious next step in this conversation and did not take it. '
      + 'Do NOT offer it again. Answer only what they asked.'
    : brief.brief;

  const system = systemPrompt({
    contextBlock: ctxSvc.contextBlock(ctx, state),
    brief: effectiveBrief,
    suppressed,
    toolsEnabled,
  });

  // sliced, because the next line pushes onto it and the caller's array is not ours.
  const msgs = preMsgs ? preMsgs.slice() : await history(session.id);
  if (userText) msgs.push({ role: 'user', content: userText });
  if (!msgs.length) {
    // The greeting: nothing has been said yet, so give the model an explicit opening
    // instruction rather than an empty conversation.
    msgs.push({ role: 'user', content: '(The agent has just opened NILDash. Greet them according to the situation above.)' });
  }

  const directives = [];
  const confirms = [];
  const notes = [];

  const out = await ai.toolLoop({
    system,
    messages: msgs,
    tools: toolsEnabled ? actions.toolDefs() : [],
    model: MODEL,
    maxTokens: 900,
    maxRounds: 3,
    timeoutMs: TURN_TIMEOUT_MS,
    runTool: async (name, input) => {
      const res = await actions.resolveCall(name, input, { agentId, session });
      if (!res.ok) {
        // A refusal is reported back to the model so it can explain it in its own
        // words, and it ends the turn: letting it retry invites another route.
        notes.push(res.message);
        return { result: { refused: true, reason: res.message }, stop: true, isError: false };
      }
      if (res.confirm) {
        confirms.push(res.confirm);
        return { result: { pending: true, asked: res.confirm.text }, stop: true };
      }
      directives.push(res.directive);
      return { result: { done: true, note: res.say || 'done' } };
    },
  });

  let text = (out.text || '').trim();
  // Never leave the bubble blank. A turn that produced only an action or only a
  // refusal still has to say something.
  if (!text) {
    if (confirms.length) text = confirms[0].text;
    else if (notes.length) text = notes[0];
    else if (directives.length) text = 'Done.';
    else text = 'I did not get that. Say it another way?';
  }

  // The suggestion for this state has now been made. It goes on the suppressed list
  // whether or not they take it; taking it makes the state change anyway.
  if (!alreadyOffered && brief.suggestionKey && !suppressed.includes(brief.suggestionKey)) {
    session.suppressed = suppressed.concat([brief.suggestionKey]);
  }
  return { text, directives, confirms, exhausted: !!out.exhausted };
}

// ── POST /session ────────────────────────────────────────────────────────────
router.post('/session', async (req, res) => {
  try {
    const agentId = req.session.userId;
    const tAll = Date.now();

    // THREE INDEPENDENT READS, AT ONCE. These were four sequential awaits, and every
    // one of them was latency the agent watched a blank corner for. Only history()
    // genuinely depends on another (it needs the session id), so it stays behind.
    const [session, ctx, u] = await Promise.all([
      loadSession(agentId, req.body && req.body.sessionId),
      ctxSvc.readContext(agentId),
      pool.query(
        'SELECT COALESCE(assistant_dismissals,0) AS d, COALESCE(assistant_autoopen_off,false) AS off FROM users WHERE id=$1',
        [agentId]),
    ]);
    const tDb = Date.now() - tAll;
    const state = ctxSvc.routeState(ctx);
    const autoOpen = !(u.rows[0] && u.rows[0].off);

    // Resuming: no new greeting, just the transcript.
    const tH = Date.now();
    const existing = await history(session.id);
    const tHist = Date.now() - tH;
    if (existing.length) {
      return res.json({
        sessionId: session.id, state, autoOpen,
        messages: existing, resumed: true,
        context: { athletes: ctx.athletes, scans: ctx.scans, sent: ctx.sent, gmailConnected: ctx.gmailConnected },
      });
    }

    // `existing` is handed straight to runTurn, which used to call history() again
    // for the same session id and throw the first answer away.
    const tM = Date.now();
    const turn = await runTurn({
      agentId, session, ctx, state, userText: null, toolsEnabled: false, msgs: existing,
    });
    const tModel = Date.now() - tM;
    await record(session.id, agentId, 'assistant', turn.text);
    await saveSession(session);
    console.log(`[assistant] agent=${agentId} session=${session.id} greeting state=${state} autoOpen=${autoOpen}`);
    // THE SPLIT, MEASURED. db is the three parallel reads (ctx is the slowest of the
    // three, shown separately); model is the Sonnet call. If model dominates, the
    // next lever is a shorter prompt, not more database work.
    console.log(`[assistant] TIMING /session agent=${agentId} db=${tDb}ms (ctx=${ctx._ms}ms) `
      + `history=${tHist}ms model=${tModel}ms total=${Date.now() - tAll}ms`);
    res.json({
      sessionId: session.id, state, autoOpen, resumed: false,
      messages: [{ role: 'assistant', content: turn.text }],
      context: { athletes: ctx.athletes, scans: ctx.scans, sent: ctx.sent, gmailConnected: ctx.gmailConnected },
    });
  } catch (e) {
    console.error('[assistant/session]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /message ────────────────────────────────────────────────────────────
router.post('/message', async (req, res) => {
  try {
    const agentId = req.session.userId;
    const text = String((req.body && req.body.text) || '').trim().slice(0, MAX_INPUT_CHARS);
    if (!text) return res.status(400).json({ error: 'Say something.' });
    // Same three-at-once as /session. A reply costs the agent this wait too.
    // They replied, so the dismissal streak resets. Two dismissals IN A ROW without
    // replying is what turns auto-open off; a reply breaks the row.
    const tAll = Date.now();
    const [session, ctx] = await Promise.all([
      loadSession(agentId, req.body && req.body.sessionId),
      ctxSvc.readContext(agentId),
      pool.query('UPDATE users SET assistant_dismissals = 0 WHERE id=$1', [agentId]).catch(() => {}),
    ]);
    const tDb = Date.now() - tAll;
    session.replied = true;
    const state = ctxSvc.routeState(ctx);

    // Written BEFORE the turn, because runTurn reads the transcript back and this
    // message has to be in it.
    await record(session.id, agentId, 'user', text);

    const tM = Date.now();
    const turn = await runTurn({ agentId, session, ctx, state, userText: text, toolsEnabled: true });
    const tModel = Date.now() - tM;
    console.log(`[assistant] TIMING /message agent=${agentId} db=${tDb}ms (ctx=${ctx._ms}ms) `
      + `model=${tModel}ms total=${Date.now() - tAll}ms`);
    await record(session.id, agentId, 'assistant', turn.text);
    await saveSession(session);

    res.json({
      sessionId: session.id,
      reply: turn.text,
      directives: turn.directives,
      confirms: turn.confirms,
    });
  } catch (e) {
    console.error('[assistant/message]', e.message);
    res.status(500).json({ error: 'Something went wrong on my side. Try again?' });
  }
});

// ── POST /confirm ────────────────────────────────────────────────────────────
// The ONLY path from a confirm-tier action to a directive, and it is reached by a
// request the browser makes after a human clicks. The model cannot make it.
router.post('/confirm', async (req, res) => {
  try {
    const agentId = req.session.userId;
    const out = await actions.redeemPending(agentId, req.body && req.body.token);
    if (!out.ok) return res.status(400).json({ error: out.message });
    const sessionId = (req.body && req.body.sessionId) || null;
    if (sessionId) await record(sessionId, agentId, 'user', '(confirmed: ' + out.action + ')');
    res.json({ ok: true, action: out.action, directive: out.directive });
  } catch (e) {
    console.error('[assistant/confirm]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /dismiss ────────────────────────────────────────────────────────────
// Closed without replying. Two in a row and auto-open is off for this agent for good.
router.post('/dismiss', async (req, res) => {
  try {
    const agentId = req.session.userId;
    const r = await pool.query(
      `UPDATE users SET assistant_dismissals = COALESCE(assistant_dismissals,0) + 1,
                        assistant_autoopen_off = (COALESCE(assistant_dismissals,0) + 1) >= 2
       WHERE id=$1 RETURNING assistant_dismissals AS d, assistant_autoopen_off AS off`, [agentId]);
    const row = r.rows[0] || {};
    if (row.off) console.log(`[assistant] agent=${agentId} dismissed twice in a row, auto-open OFF for good`);
    res.json({ ok: true, dismissals: row.d || 0, autoOpenOff: !!row.off });
  } catch (e) {
    console.error('[assistant/dismiss]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
