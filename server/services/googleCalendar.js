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

// Declared Google-verification scopes ONLY. Full 'auth/calendar' was dropped:
// it is broader than declared and lets code manage calendar lists/ACLs and
// create calendars — none of which is allowed under calendar.events. Event
// create/read/update on the user's own calendars works fine under calendar.events.
const ATHLETE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',    // create/edit events on the user's calendars
  'https://www.googleapis.com/auth/userinfo.email',     // confirm identity
];

const AGENT_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

// ── Availability check ─────────────────────────────────────────────────────

// Resolve credentials — GOOGLE_CLIENT_ID takes priority; falls back to the
// GMAIL credentials from the same Google Cloud project so that Calendar works
// with the existing OAuth setup without separate credentials.
function _clientId()     { return process.env.GOOGLE_CLIENT_ID     || process.env.GMAIL_CLIENT_ID; }
function _clientSecret() { return process.env.GOOGLE_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET; }
function _redirectUri()  {
  return process.env.GOOGLE_REDIRECT_URI || 'https://mynildash.com/auth/google/calendar/callback';
}

function isAvailable() {
  return !!(google && _clientId() && _clientSecret());
}

// ── OAuth2 client factory ──────────────────────────────────────────────────

function _createClient() {
  if (!google) throw new Error('googleapis package not loaded');
  const clientId     = _clientId();
  const clientSecret = _clientSecret();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google Calendar credentials not configured. Set GOOGLE_CLIENT_ID and ' +
      'GOOGLE_CLIENT_SECRET (or GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET) in environment variables.'
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, _redirectUri());
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
// SCOPE NOTE (calendar.events): creating a dedicated "NIL — [Name]" calendar
// uses calendars.insert + calendarList.list, which require the full 'calendar'
// scope. Under the declared calendar.events scope we can only create/edit events
// on the user's existing calendars, so events are written to 'primary'. The
// dedicated-calendar feature is disabled until a future full-scope verification;
// the original body is preserved below (commented) so it can be restored.
async function getOrCreateNilCalendar(_refreshToken, _athleteName) {
  return 'primary';
  /* Requires full 'calendar' scope — disabled under calendar.events:
  const auth = _getAuthClient(refreshToken);
  const cal  = google.calendar({ version: 'v3', auth });
  const nilCalName = `NIL — ${athleteName}`;
  const list = await cal.calendarList.list({ maxResults: 250 });
  const found = (list.data.items || []).find(c => c.summary === nilCalName);
  if (found) return found.id;
  const created = await cal.calendars.insert({
    requestBody: {
      summary:     nilCalName,
      description: `NIL brand deliverables for ${athleteName} — managed by NILDash (mynildash.com)`,
      timeZone:    'America/New_York',
    },
  });
  console.log(`[gcal] created NIL calendar "${nilCalName}" id=${created.data.id}`);
  return created.data.id;
  */
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
// SCOPE NOTE: calendarList.* requires the full 'calendar' scope, NOT available
// under the declared calendar.events scope. Callers (agent subscribe routes)
// short-circuit before invoking this, so it is not reachable at runtime until a
// future full-scope verification. Kept for that eventual restoration.
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
