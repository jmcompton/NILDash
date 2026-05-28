// server/services/googleCalendar.js
// Google Calendar integration for NILDash.
// Follows the same pattern as server/services/providers/gmail.js.
//
// Required env vars:
//   GOOGLE_CLIENT_ID       — Google Cloud OAuth2 client ID
//   GOOGLE_CLIENT_SECRET   — Google Cloud OAuth2 client secret
//   GOOGLE_REDIRECT_URI    — https://mynildash.com/auth/google/calendar/callback
//
// These are SEPARATE from GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET so that
// Gmail email and Google Calendar can be enabled independently.

'use strict';

let google;
try {
  ({ google } = require('googleapis'));
} catch (e) {
  google = null;
}

// Scopes needed to create/manage events and calendars
const ATHLETE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',           // create calendars + events
  'https://www.googleapis.com/auth/calendar.events',    // create/edit events
  'https://www.googleapis.com/auth/userinfo.email',     // confirm identity
];

const AGENT_SCOPES = [
  'https://www.googleapis.com/auth/calendar',           // subscribe to athlete calendars
  'https://www.googleapis.com/auth/userinfo.email',
];

// ── Availability check ─────────────────────────────────────────────────────

function isAvailable() {
  return !!(
    google &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET
  );
}

// ── OAuth2 client factory ──────────────────────────────────────────────────

function _createClient() {
  if (!google) throw new Error('googleapis package not loaded');
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in environment variables');
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'https://mynildash.com/auth/google/calendar/callback'
  );
}

// ── Auth URL generation ────────────────────────────────────────────────────

/**
 * Generate the Google consent URL for an athlete.
 * state — base64url-encoded JSON with { athleteId, type: 'athlete' }
 */
function getAthleteAuthUrl(state) {
  const client = _createClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',   // always returns a refresh_token
    scope: ATHLETE_SCOPES,
    state,
  });
}

/**
 * Generate the Google consent URL for an agent.
 * state — base64url-encoded JSON with { agentId, type: 'agent' }
 */
function getAgentAuthUrl(state) {
  const client = _createClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: AGENT_SCOPES,
    state,
  });
}

// ── Code exchange ──────────────────────────────────────────────────────────

/**
 * Exchange an authorization code for tokens.
 * Returns the raw tokens object: { access_token, refresh_token, expiry_date, ... }
 */
async function exchangeCode(code) {
  const client = _createClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// ── Authenticated client ───────────────────────────────────────────────────

function _getAuthClient(refreshToken) {
  const client = _createClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// ── Calendar management ────────────────────────────────────────────────────

/**
 * Find or create the "NIL — [Athlete Name]" calendar on the athlete's account.
 * Returns the calendarId string.
 * Safe to call repeatedly — checks for existence before creating.
 */
async function getOrCreateNilCalendar(refreshToken, athleteName) {
  const auth = _getAuthClient(refreshToken);
  const cal  = google.calendar({ version: 'v3', auth });

  const nilCalName = `NIL — ${athleteName}`;

  // Check if it already exists
  const list = await cal.calendarList.list({ maxResults: 250 });
  const found = (list.data.items || []).find(c => c.summary === nilCalName);
  if (found) return found.id;

  // Create it
  const created = await cal.calendars.insert({
    requestBody: {
      summary:     nilCalName,
      description: `NIL brand deliverables for ${athleteName} — managed by NILDash (mynildash.com)`,
      timeZone:    'America/New_York',
    },
  });
  console.log(`[gcal] created NIL calendar "${nilCalName}" id=${created.data.id}`);
  return created.data.id;
}

// ── Event creation ─────────────────────────────────────────────────────────

/**
 * Push a single NILDash calendar event to the athlete's Google Calendar.
 *
 * event shape (from athlete_calendar_events row):
 *   { id, title, event_date, brand, notes }
 *
 * Returns the Google event id (string).
 */
async function createCalendarEvent(refreshToken, calendarId, event) {
  const auth = _getAuthClient(refreshToken);
  const cal  = google.calendar({ version: 'v3', auth });

  // event_date comes back as a Date object from postgres DATE column
  const rawDate = event.event_date instanceof Date
    ? event.event_date.toISOString().split('T')[0]
    : String(event.event_date || '').split('T')[0];

  if (!rawDate) throw new Error('event_date is required');

  const brand = (event.brand || '').trim();
  const title = (event.title || event.deliverable_description || '').trim();
  const timeZone = 'America/New_York';

  // Default noon–1 PM if no time is stored
  const startDT = `${rawDate}T12:00:00`;
  const endDT   = `${rawDate}T13:00:00`;

  // Rich description with emoji formatting
  const descLines = [
    `📅 NIL Deliverable${brand ? ' — ' + brand : ''}`,
    `📝 ${title}`,
  ];
  if (event.notes && event.notes.trim()) {
    descLines.push(`📋 Notes: ${event.notes.trim()}`);
  }
  descLines.push('', 'Managed by NILDash — mynildash.com');

  const gcalEvent = {
    summary:     brand ? `${brand} — ${title}` : title,
    description: descLines.join('\n'),
    start: { dateTime: startDT, timeZone },
    end:   { dateTime: endDT,   timeZone },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 }, // 24 h before
        { method: 'popup', minutes: 60 },        // 1 h before
      ],
    },
  };

  const response = await cal.events.insert({
    calendarId,
    requestBody: gcalEvent,
  });

  return response.data.id;
}

// ── Agent calendar subscription ────────────────────────────────────────────

/**
 * Subscribe an agent to an athlete's NIL calendar.
 * This adds the athlete's calendar to the agent's Google Calendar list.
 * athleteCalendarId — the athlete's google_calendar_id (from DB)
 */
async function subscribeToCalendar(agentRefreshToken, athleteCalendarId) {
  const auth = _getAuthClient(agentRefreshToken);
  const cal  = google.calendar({ version: 'v3', auth });

  // Check if already subscribed
  try {
    await cal.calendarList.get({ calendarId: athleteCalendarId });
    return { alreadySubscribed: true };
  } catch (_) {
    // Not in list — add it
  }

  await cal.calendarList.insert({
    requestBody: { id: athleteCalendarId },
  });
  return { subscribed: true };
}

/**
 * Unsubscribe an agent from an athlete's NIL calendar.
 */
async function unsubscribeFromCalendar(agentRefreshToken, athleteCalendarId) {
  const auth = _getAuthClient(agentRefreshToken);
  const cal  = google.calendar({ version: 'v3', auth });
  await cal.calendarList.delete({ calendarId: athleteCalendarId });
  return { unsubscribed: true };
}

module.exports = {
  isAvailable,
  getAthleteAuthUrl,
  getAgentAuthUrl,
  exchangeCode,
  getOrCreateNilCalendar,
  createCalendarEvent,
  subscribeToCalendar,
  unsubscribeFromCalendar,
};
