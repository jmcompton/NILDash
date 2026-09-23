-- ── WHO WAS SENT A PITCH SIGNED WITH SOMEBODY ELSE'S NAME ─────────────────────
--
-- Read-only. Run against production:
--   psql "$DATABASE_URL" -f scripts/signoff-audit.sql
--
-- Until this fix the pitch writer signed "JohnMark" whenever the agent had no
-- name on file, the manual generator signed "Your Agent", the workflow's email
-- signature read "NIL Agent", and saveUser stored "Agent" or the email's local
-- part for a nameless signup (which then signed pitches as that). This finds
-- every message that actually LEFT -- a sent email, or a DM or call card the
-- agent marked sent -- carrying one of those, and says to whom.
--
-- "JohnMark" is only a stand-in when the sending agent is somebody else, so
-- rows whose own agent is John Mark are excluded.

\echo '== 1. Sent emails carrying a stand-in sign-off =='
SELECT l.sent_at, l.agent_id, u.name AS agent_name_now, u.email AS agent_email,
       l.brand_name, l.sent_to_email AS sent_to,
       CASE
         WHEN l.body_html ~* '(^|[>\s])JohnMark([<\s]|$)' THEN 'JohnMark'
         WHEN l.body_html ~* '(^|[>\s])(Your Agent|NIL Agent)([<\s]|$)' THEN 'Your Agent / NIL Agent'
         WHEN l.body_html ~* '<div>Agent</div>|(^|\n)Agent\s*$' THEN 'Agent'
         ELSE 'email local part'
       END AS signed_as
  FROM outreach_logs l
  LEFT JOIN users u ON u.id = l.agent_id
 WHERE l.sent_at IS NOT NULL
   AND (
         (l.body_html ~* '(^|[>\s])JohnMark([<\s]|$)'
            AND COALESCE(u.name, '') !~* '^\s*john\s*mark')
      OR l.body_html ~* '(^|[>\s])(Your Agent|NIL Agent)([<\s]|$)'
      OR l.body_html ~* '<div>Agent</div>'
      OR (u.name IS NOT NULL AND u.name = split_part(u.email, '@', 1)
            AND l.body_html ILIKE '%' || u.name || '%')
       )
 ORDER BY l.sent_at;

\echo '== 2. DM and call cards marked sent with a stand-in sign-off =='
SELECT q.sent_at, q.sent_via, q.agent_id, u.name AS agent_name_now, u.email AS agent_email,
       q.brand_name, q.instagram AS sent_to_handle, q.phone
  FROM outreach_queue q
  LEFT JOIN users u ON u.id = q.agent_id
 WHERE q.state = 'sent'
   AND (
         (q.dm_text ~* '(^|\s)JohnMark(\s|$)' AND COALESCE(u.name, '') !~* '^\s*john\s*mark')
      OR q.dm_text ~* '(^|\s)(Your Agent|NIL Agent|Agent)\s*$'
      OR (u.name IS NOT NULL AND u.name = split_part(u.email, '@', 1)
            AND q.dm_text ILIKE '%' || u.name || '%')
       )
 ORDER BY q.sent_at;

\echo '== 3. Drafts and queued cards still waiting with a stand-in (not sent; skip or regenerate) =='
SELECT 'email draft' AS kind, l.agent_id, u.name AS agent_name_now, l.brand_name, l.created_at
  FROM outreach_logs l LEFT JOIN users u ON u.id = l.agent_id
 WHERE l.sent_at IS NULL AND l.status = 'draft'
   AND ((l.body_html ~* '(^|[>\s])JohnMark([<\s]|$)' AND COALESCE(u.name, '') !~* '^\s*john\s*mark')
        OR l.body_html ~* '(^|[>\s])(Your Agent|NIL Agent)([<\s]|$)' OR l.body_html ~* '<div>Agent</div>')
UNION ALL
SELECT 'queued ' || q.channel, q.agent_id, u.name, q.brand_name, q.created_at
  FROM outreach_queue q LEFT JOIN users u ON u.id = q.agent_id
 WHERE q.state = 'queued'
   AND ((q.dm_text ~* '(^|\s)JohnMark(\s|$)' AND COALESCE(u.name, '') !~* '^\s*john\s*mark')
        OR q.dm_text ~* '(^|\s)(Your Agent|NIL Agent|Agent)\s*$')
 ORDER BY 5;

\echo '== 4. Agents who will now get NO cards until they add a name =='
SELECT id, email, name, role, created_at
  FROM users
 WHERE role IN ('agent', 'admin') AND archived IS NOT TRUE
   AND (name IS NULL OR btrim(name) = ''
        OR lower(btrim(name)) IN ('agent', 'your agent', 'nil agent', 'an agent', 'the agent', 'user', 'unknown', 'there', 'admin')
        OR name = split_part(email, '@', 1)
        OR name ~ '[@0-9]')
 ORDER BY created_at;
