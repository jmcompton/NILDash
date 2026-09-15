# Overnight briefs

Four scripts that run on your Mac under cron, through `claude -p` on an Anthropic API key, and email you one brief each. Nothing here sends to anyone but you.

| Script | What it does | Subject |
|---|---|---|
| `follow-ups.js` | Sent-mail threads with no reply in 7+ days: who, what it was about, what you said you'd do, how long | `Follow-ups: 4 waiting` |
| `news-watch.js` | Searches the term list, dedupes against the last 30 days, ten lines | `NIL watch: 6 items` |
| `prospecting.js` | LinkedIn connections filtered to agents and NIL people, minus anyone in your sent mail, next 20 researched with an opener each | `Prospects: 20 drafted` |
| `strategy-watch.js` | Legislation (S. 4668, agent regulation, NCAA rules), competitors, market signals. Haiku. **Emails only when something meaningful changed** since its last send; a quiet day sends nothing | `Strategy watch: 3 changes` |

Every brief is also written to `~/nildash-briefs/YYYY-MM-DD-<name>.md` as the archive, whether or not the email goes out. The exception is strategy-watch, which archives only on the days it sends.

## Strategy watch: when it sends

Three Haiku searches (`--model haiku`, `WebSearch`/`WebFetch`, `maxTurns.strategy`, default 4) look back to the date of the last send, or seven days on the first run. Each item comes back tagged `meaningful` true or false and with a fixed kind (a vote, an amendment, a committee step; a launch, a funding round; a deal, an agency move, a College Sports Commission report). Only meaningful items with a real URL survive, minus anything shown in the last 90 days. Legislation is written as one paragraph of at most 130 words with every source linked; the other two sections are one line per item, six at most each, so the email stays under a page.

If nothing survives, the run writes one log line and sends nothing. When it sends, it writes `strategyWatch.lastSentAt` and the URLs it showed into `~/nildash-briefs/config.json` itself, so the next run looks back only to that date and never repeats an item. `--since YYYY-MM-DD` overrides the look-back, `--no-email --print` shows what it would send, `--force` sends even on a quiet day to test the pipe.

## Setup, once

1. **The key.** `mkdir -p ~/nildash-briefs/inbox`, copy `config.example.json` to `~/nildash-briefs/config.json`, and set `anthropicApiKey` to an Anthropic API key (the one Railway uses, or a new one from console.anthropic.com). If you would rather not keep it in the file, leave it empty and export `ANTHROPIC_API_KEY` in the environment that runs the briefs; the file is read first, the environment second, and with neither a run stops before starting claude and says which to set. Then `node tools/briefs/lib.js --claude-test` must print `RESULT: PASS` and name where the key came from.
2. **Config.** In the same file fill in `resendApiKey` (the same key Railway has), `myAddresses` (every address you send from), and `aboutMe` in your own words. `to` is already `john@comptongroupllc.com`.
3. **Mail.app.** Both accounts must be set up in Mail on that Mac. The first run will ask for Automation permission (System Settings > Privacy & Security > Automation: allow the terminal, and cron, to control Mail). Run `node tools/briefs/follow-ups.js` by hand once so the prompt appears.
4. **LinkedIn CSV.** Drop `Connections.csv` in `~/nildash-briefs/inbox/`. The export lives at LinkedIn > Settings > Data privacy > Get a copy of your data > Connections.
5. **Cron.** `crontab -e`, paste `crontab.example`, fix `NODE` and `REPO`. The times are 5:30, 5:45 and 6:00 local, staggered so the runs never overlap.
6. **Keep the Mac awake at 5:25**, or `sudo pmset repeat wakeorpoweron MTWRFSU 05:25:00`.

## How the briefs authenticate

The CLI's own login (the OAuth session from `claude` > sign in) is not used. It expired once and every brief failed with "OAuth access token is invalid", so the briefs run on an API key instead, and the CLI's other credential paths (bearer tokens, Bedrock, Vertex) are removed from the child's environment so the key is the only way it can authenticate.

1. **Where the key comes from.** `anthropicApiKey` in `~/nildash-briefs/config.json` first; `ANTHROPIC_API_KEY` in the environment second; with neither, the run fails before claude is started, with the message `No Anthropic API key. Set "anthropicApiKey" in ~/nildash-briefs/config.json, or export ANTHROPIC_API_KEY ...`. No key is written anywhere in the repository.

2. **The footer of every brief** says which was used, masked:

   `auth: API key sk-ant-…a1b2 from config.json; other credential env absent; apiKeyHelper none`

3. **`node tools/briefs/lib.js --claude-test`** makes the exact spawn the briefs make and prints `RESULT: PASS. claude -p runs from here on the API key from config.json.` Run it from Terminal after setup, and once from cron (paste the line into the crontab for one minute) to see what cron sees. If it says the API refused the key, the key is wrong or revoked; if it says the CLI is still trying its own login, run `claude /logout` once.

4. **Spend shows in the Console.** Every call is a normal API request: console.anthropic.com > Usage shows the overnight window against the key. Haiku for strategy-watch, the default model for the other three.

## Guardrails

- `--max-turns` on every call: 2 for follow-ups (one summarising call), 4 per news term, 5 per prospect, 4 per strategy-watch search plus 1 for its paragraph. Change them in `config.json` under `maxTurns`.
- A wall-clock kill of 6 minutes per call (`callTimeoutMin`).
- Tools are whitelisted per call: none for follow-ups, `WebSearch`/`WebFetch` for news and prospecting. Nothing can run a shell command or write a file.
- The worst case for a night is bounded: 1 + 7 + 20 + 4 calls, each capped in turns and minutes.

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

`BRIEFS_DEBUG=1` on any of the scripts turns the same output on inside a normal run.

## Running by hand

```
node tools/briefs/follow-ups.js
node tools/briefs/news-watch.js
node tools/briefs/prospecting.js
node tools/briefs/strategy-watch.js --no-email --print
```

Logs are in `~/nildash-briefs/logs/`. State (what has been shown or drafted) is in `~/nildash-briefs/state/`; delete `prospecting-done.json` to start the prospect queue over.
