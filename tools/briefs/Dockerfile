# ── THE BRIEFS AS A RAILWAY SERVICE ──────────────────────────────────────────
# A separate service from the NILDash app, built from this file
# (tools/briefs/railway.json points at it), run on Railway's cron. It copies
# only what the briefs need: the package manifest (for resend, imap,
# mailparser, pg, msal and the Graph client), server/services (the Outlook
# provider, the token cipher, and the DeepSeek client and search loop the
# briefs call directly), and tools/briefs itself. No CLI: the briefs make
# HTTPS calls to DeepSeek on DEEPSEEK_API_KEY.
#
# State, archives, logs and the LinkedIn CSV live under BRIEFS_HOME, which
# must be a mounted Railway volume (/data/briefs) or they vanish on redeploy.
FROM node:22-slim

ENV NODE_ENV=production \
    BRIEFS_HOME=/data/briefs \
    HOME=/data/briefs/home

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

COPY server ./server
COPY tools/briefs ./tools/briefs

# One firing = one exit. Railway's cron runs this and waits for it to end.
CMD ["node", "tools/briefs/run-slot.js"]
