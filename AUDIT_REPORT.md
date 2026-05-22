# NILDash Agent Side Audit Report

**Date:** 2026-05-21  
**Auditor:** Full-stack QA pass — all agent-side routes, frontend pages, and data isolation  
**Scope:** Agent side only. University side untouched.

---

## Bugs Fixed

### CRITICAL — Security / Auth Bugs

1. **DELETE /api/athletes/:id — agents could not delete their own athletes**  
   `athlete.agent_id` was used but `store.getAthlete()` returns `agentId` (camelCase). The check `undefined !== userId` was always true, causing 403 for all non-admin agents.  
   **Fix:** `athlete.agentId !== req.session.userId`

2. **PATCH /api/athletes/:id/note — agents could never save notes**  
   Same camelCase bug: `athlete.agent_id` was always undefined.  
   **Fix:** `athlete.agentId !== req.session.userId`

3. **PUT /api/athletes/:id — no ownership check at all**  
   Any authenticated user could overwrite any athlete's profile.  
   **Fix:** Added ownership check using `existing.agentId` before update.

4. **DELETE /api/deals/:id — anyone could delete any deal**  
   `deal.agent_id` was used but `store.getDeal()` returns `agentId`. The condition `!isAdmin && deal.agent_id && ...` short-circuited on undefined (falsy), skipping the check entirely.  
   **Fix:** `deal.agentId !== req.session.userId`

5. **PATCH /api/deals/:id — no ownership check**  
   Any authenticated user could update any deal's stage, value, or status.  
   **Fix:** Added ownership check using `existing.agentId`.

6. **GET /api/athletes/:id/deals — no ownership check**  
   Any logged-in user could fetch deal data for any athlete ID.  
   **Fix:** Verify caller is agent who owns the athlete, the athlete themselves, or admin.

7. **POST /api/athletes/:id/deals — no athlete ownership check**  
   Any agent could create deals against any athlete, not just their own.  
   **Fix:** Added `athlete.agentId !== req.session.userId` guard.

### HIGH — Correctness Bugs

8. **GET /api/athletes — athlete-role users got wrong data**  
   For non-agent users, code called `getAthletesByAgent(user.id)` which looks up athletes by `agent_id`. Athlete users' `user.id` is never an `agent_id`, so athletes always received an empty array instead of their own profile.  
   **Fix:** Athlete users now fetch their own profile via `user.athlete_id`.

9. **GET /api/agent/calendar — stale source exclusion filters**  
   The athlete dropdown for the calendar still had `AND (data->>'source' IS DISTINCT FROM 'espn_import') AND (data->>'source' IS DISTINCT FROM 'university_import')`. After university isolation, these filters are structurally unnecessary and potentially hide edge-case records.  
   **Fix:** Removed stale filters — isolation is now structural via `university_athletes` table.

---

## Improvements Made

### Rate Calculator (flagged by Brad Hutchinson at UGA)
- Already had full transparency layer: rate drivers, limitations, market confidence, reliability score, pricing strategy, momentum signal, comparable market note, "How this estimate was built" panel, and comp data from closed deals.
- All fields verified flowing correctly from backend to frontend.
- No changes needed — transparency layer is complete and rendering.

### Team Match
- Verified prompt includes real 2024-26 portal benchmarks, collective budget data, position scarcity multipliers, realistic school tier anchors, high-school guard rails.
- Frontend renders fit scores, NIL ranges, roster need, collective deal history, trajectory note, portal comps, and negotiation playbook builder.

### AI Lookup (Add Client page)
- Already fixed in previous session: uses `web_search_20250305` tool with `claude-sonnet-4-20250514`.
- Source URLs, confidence badges (BEST MATCH / POSSIBLE MATCH / LOW CONFIDENCE), and low-confidence warnings all rendering.

### Data Isolation — Verified Clean
- `university_athletes` table is fully separate from `athletes` (agent) table.
- Migration 007 backfilled and removed any university-imported athletes from the agent table.
- Startup isolation check logs any remaining `university_id`-stamped rows in agent table.
- All university routes use `university_athletes` exclusively — confirmed via grep.
- Agent routes (`store.js`, calendar, PDF scanner, contracts, deliverables) use `athletes` exclusively.

---

## Features Added

### CSV Export
- **My Roster** — Export button added. Downloads name, sport, position, school, tier, Instagram, TikTok, engagement, year, stats, notes.
- **Deal Pipeline** — Export button added. Downloads athlete, brand, campaign, stage, deal value, offered value, created date.
- **Commission Tracker** — Export button added. Downloads athlete, brand, campaign, stage, deal value, commission amount, status.
- All exports are client-side (no backend needed), instant download.

### Roster Data Quality / Profile Completeness
- Dashboard now shows a **Roster Data Quality** bar with % of fields filled across all athlete profiles.
- Color-coded: green (80%+), amber (50–79%), red (<50%).
- Lists top 3 missing fields by athlete count with "Fix in Roster →" link.
- Updates automatically when athletes are loaded.

---

## Still Needs Attention

1. **Email inbox (email.js)** — IMAP/Gmail OAuth integration. Complex provider-specific code outside the audit scope. Verify email connection tokens are working in production.

2. **Athlete portal invite flow** — Invite tokens expire in 7 days. If an agent generates a token and the athlete doesn't accept within 7 days, the link breaks with no re-send mechanism. Consider adding a "Resend invite" button that regenerates the token.

3. **store.js `automation_scheduler_log` schema** — `store.js`'s `CREATE TABLE IF NOT EXISTS` for this table uses wrong columns (`job_type`, `status`) vs. migration 004's correct schema (`event_type`, `universities_processed`, etc.). On fresh databases, whichever runs first wins. Migration files run alphabetically after `store.init()` starts, creating a potential race. This only affects the university scheduler (not agent side).

4. **`/api/pitch-data/:athleteId` — no auth** — The pitch deck endpoint is intentionally public (shareable links), but returns social data and NIL scores. Consider adding a visibility flag or expiry mechanism similar to athlete reports.

5. **`/api/reports/generate` — no rate limit** — Report generation calls Claude without the `aiLimiter`. Low risk but could be abused.

---

## Data Isolation Status

**CONFIRMED CLEAN** — university athletes are fully isolated in the `university_athletes` table. No university-imported athletes in the agent `athletes` table after migration 007. Startup isolation check will log any future contamination.
