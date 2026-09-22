# NILDash — NIL Intelligence Platform

AI-powered NIL deal intelligence for sports agents and athletes.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Add environment variables
Create a `.env` file:
```
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE
SESSION_SECRET=any-random-string-here
BUSINESS_MAILING_ADDRESS=Your Company LLC, 123 Main St, City, ST 00000
PORT=3000
```

`BUSINESS_MAILING_ADDRESS` is REQUIRED before any outreach can be sent. It is
printed in the footer of every email that goes to a business, because CAN-SPAM
(15 U.S.C. 7704(a)(5)) requires a valid physical mailing address in every
commercial message. When it is unset, outreach refuses to send rather than
sending an unlawful message — the nightly release logs the reason once and
sends nothing, and a manual Send answers with the same sentence. Notices to
your own agents (digests, password resets) are unaffected either way.

### 3. Run locally
```bash
npm start
```

Open http://localhost:3000

## Deploy to Railway

1. Push this repo to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Select this repo
4. Add environment variables in Railway dashboard:
   - `ANTHROPIC_API_KEY`
   - `SESSION_SECRET`
   - `BUSINESS_MAILING_ADDRESS` — required before outreach sends (see above)
5. Deploy — Railway gives you a live URL automatically

## Connect your domain (mynildash.com)

1. In Railway: go to your project → Settings → Domains → Add Custom Domain
2. Type: `mynildash.com`
3. Railway gives you DNS records to add
4. Go to Namecheap → Manage mynildash.com → Advanced DNS
5. Add the records Railway gave you
6. Wait 10-30 minutes → your site is live at mynildash.com

## Features

- Agent and Athlete accounts
- AI Command Center — ask anything about your client
- Deal Scan — AI-ranked brand opportunities  
- Rate Calculator — what to charge with full math
- Negotiation Intel — word-for-word playbooks
- Deal Pipeline — track all deals across your roster
