# Overnight briefs

Three scripts that run on your Mac under cron, on your Claude Code subscription, and email you one brief each. Nothing here sends to anyone but you.

| Script | What it does | Subject |
|---|---|---|
| `follow-ups.js` | Sent-mail threads with no reply in 7+ days: who, what it was about, what you said you'd do, how long | `Follow-ups: 4 waiting` |
| `news-watch.js` | Searches the term list, dedupes against the last 30 days, ten lines | `NIL watch: 6 items` |
| `prospecting.js` | LinkedIn connections filtered to agents and NIL people, minus anyone in your sent mail, next 20 researched with an opener each | `Prospects: 20 drafted` |

Every brief is also written to `~/nildash-briefs/YYYY-MM-DD-<name>.md` as the archive, whether or not the email goes out.

## Setup, once

1. **Claude Code signed in on your subscription.** In a terminal: `claude` then `/status` should show your claude.ai account, not an API key. Then `claude -p "say ok" --max-turns 1` should print `ok`.
2. **Config.** `mkdir -p ~/nildash-briefs/inbox` then copy `config.example.json` to `~/nildash-briefs/config.json` and fill in: `resendApiKey` (the same key Railway has), `myAddresses` (every address you send from), and `aboutMe` in your own words. `to` is already `john@comptongroupllc.com`.
3. **Mail.app.** Both accounts must be set up in Mail on that Mac. The first run will ask for Automation permission (System Settings > Privacy & Security > Automation: allow the terminal, and cron, to control Mail). Run `node tools/briefs/follow-ups.js` by hand once so the prompt appears.
4. **LinkedIn CSV.** Drop `Connections.csv` in `~/nildash-briefs/inbox/`. The export lives at LinkedIn > Settings > Data privacy > Get a copy of your data > Connections.
5. **Cron.** `crontab -e`, paste `crontab.example`, fix `NODE` and `REPO`. The times are 5:30, 5:45 and 6:00 local, staggered so the runs never overlap.
6. **Keep the Mac awake at 5:25**, or `sudo pmset repeat wakeorpoweron MTWRFSU 05:25:00`.

## How to be certain the API was not used

Three checks, from cheapest to definitive.

1. **The footer of every brief.** Each email ends with an audit line:

   `auth: inherited API env absent; apiKeyHelper none; claude spawned with no API credential in its environment`

   "inherited API env absent" means cron handed the script no `ANTHROPIC_API_KEY`. If it ever says PRESENT, the cron line lost its `env -u`, and the script still removed the key before spawning claude, so the call was still on the subscription. `apiKeyHelper none` means `~/.claude/settings.json` does not route the CLI to a key. With neither, `claude -p` has exactly one way to authenticate: the session you logged in with.

2. **The CLI itself.** `claude` then `/status` shows which account the CLI is using. Do this once after setup, and again after the first night.

3. **The Console, which is the proof.** Open console.anthropic.com > Usage (or Logs), filter to the day and the key NILDash uses. The overnight window should show zero requests from your Mac; every request there is Railway's. This is the check that does not depend on anything the scripts say about themselves.

For belt and braces on the first night, you can also rotate nothing and simply check the claude.ai usage meter in the morning: the subscription's usage will have moved, the API key's will not.

## Guardrails

- `--max-turns` on every call: 2 for follow-ups (one summarising call), 4 per news term, 5 per prospect. Change them in `config.json` under `maxTurns`.
- A wall-clock kill of 6 minutes per call (`callTimeoutMin`).
- Tools are whitelisted per call: none for follow-ups, `WebSearch`/`WebFetch` for news and prospecting. Nothing can run a shell command or write a file.
- The worst case for a night is bounded: 1 + 7 + 20 calls, each capped in turns and minutes.

## When every mailbox reads zero

```
node tools/briefs/mail-dump.js --probe
```

Four steps, each reported on its own line. Step 1 asks Mail how many accounts it has: that is the Automation permission test. A denial is error -1743, "Not authorized to send Apple events to Mail", and it never comes back as zero. If the terminal was never prompted, it was never asked, and macOS asks on the first Apple event, so a successful step 1 means the permission is granted. Step 2 counts one Sent mailbox per account with no date filter at all. Step 3 reads the first and last message's date singly and says whether it is a real Date. Step 4 is the bulk date read the briefs use, with how many dates came back and how many fall in the last 60 days.

If step 2 is zero on a mailbox you know is full, Mail's scripting view of that mailbox is empty: the account keeps mail on the server only, or Mail has not finished downloading it. Open Mail, select the mailbox, and compare against Mailbox > Get Account Info.

## When follow-ups says 0 threads

Run the mail read on its own, in debug mode:

```
node tools/briefs/mail-dump.js --debug
```

It prints, in order: what osascript returned (length and the first 300 characters, before any parsing), every account Mail knows with its addresses and whether it was read or skipped, every mailbox walked with how it was classified (`sent`, `received`, `ignored`) and how many messages it yielded, and every warning. Read it top to bottom:

- **osascript failed before returning** means Automation permission: System Settings > Privacy & Security > Automation, allow the terminal to control Mail. For cron, the same prompt appears the first time cron runs it; if it never appears, run it once from Terminal.
- **Accounts listed, no mailboxes** means the same permission, partially granted.
- **Mailboxes listed but your Sent folder shows as `ignored`** means it has a name the script does not recognise. Send me the name.
- **Sent shows a count but the brief says 0 threads** means every recipient was one of your own addresses; check `myAddresses`.

**Which accounts are read.** An account is read only if one of its addresses is in `myAddresses`, or its name is in `mailAccounts`. Every other account on the Mac is listed as `SKIPPED` with the reason and is never walked, so someone else's account on a shared machine is never opened. With both lists empty nothing is read at all, and the brief says so. `mailAccounts: []` is fine as long as `myAddresses` holds every address you send from; use `mailAccounts` only for an account whose addresses Mail does not report, using the name exactly as the debug output prints it.

Each mailbox line in the debug output reads `<total> total, <n> in window, <n> read, newest <date>`. If `total` is right but `in window` is 0, the date filter is wrong and `newest` shows why; if `total` is 0 on a mailbox you know is full, Mail is not handing the messages over, which is the Automation permission.

`BRIEFS_DEBUG=1` on any of the three scripts turns the same output on inside a normal run.

## Running by hand

```
node tools/briefs/follow-ups.js
node tools/briefs/news-watch.js
node tools/briefs/prospecting.js
```

Logs are in `~/nildash-briefs/logs/`. State (what has been shown or drafted) is in `~/nildash-briefs/state/`; delete `prospecting-done.json` to start the prospect queue over.
