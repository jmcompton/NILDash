# Overnight briefs

Four scripts that run on your Mac under cron, calling DeepSeek directly on an API key (web search through Brave, Serper or Tavily), and email you one brief each. Nothing here sends to anyone but you.

| Script | What it does | Subject |
|---|---|---|
| `follow-ups.js` | Sent-mail threads with no reply in 7+ days: who, what it was about, what you said you'd do, how long | `Follow-ups: 4 waiting` |
| `news-watch.js` | Searches the term list, dedupes against the last 30 days, ten lines | `NIL watch: 6 items` |
| `prospecting.js` | LinkedIn connections filtered to agents and NIL people, minus anyone in your sent mail, next 20 researched with an opener each; anyone the research finds outside the US or outside US sports, or who gets no opener, is filtered and listed with the reason | `Prospects: 17 drafted, 3 filtered` |
| `strategy-watch.js` | Legislation (S. 4668, agent regulation, NCAA rules), competitors, market signals. **Emails only when something meaningful changed** since its last send; a quiet day sends nothing | `Strategy watch: 3 changes` |

Every brief is also written to `~/nildash-briefs/YYYY-MM-DD-<name>.md` as the archive, whether or not the email goes out. The exception is strategy-watch, which archives only on the days it sends.

## Strategy watch: when it sends

Three searched DeepSeek calls (`maxTurns.strategy` searches each, default 4) look back to the date of the last send, or seven days on the first run. Each item comes back tagged `meaningful` true or false and with a fixed kind (a vote, an amendment, a committee step; a launch, a funding round; a deal, an agency move, a College Sports Commission report). Only meaningful items with a real URL survive, minus anything shown in the last 90 days. Legislation is written as one paragraph of at most 130 words with every source linked; the other two sections are one line per item, six at most each, so the email stays under a page.

If nothing survives, the run writes one log line and sends nothing. When it sends, it writes `strategyWatch.lastSentAt` and the URLs it showed into `~/nildash-briefs/config.json` itself, so the next run looks back only to that date and never repeats an item. `--since YYYY-MM-DD` overrides the look-back, `--no-email --print` shows what it would send, `--force` sends even on a quiet day to test the pipe.

## Setup, once

1. **The keys.** `mkdir -p ~/nildash-briefs/inbox`, copy `config.example.json` to `~/nildash-briefs/config.json`, and set `deepseekApiKey` to a DeepSeek API key (platform.deepseek.com > API keys). If you would rather not keep it in the file, leave it empty and export `DEEPSEEK_API_KEY` in the environment that runs the briefs; the file is read first, the environment second, and with neither a run stops before any call is made and says which to set. News, prospecting and strategy-watch search the web, and DeepSeek has no search of its own, so also set one of `braveSearchApiKey` (api.search.brave.com), `serperApiKey` (serper.dev) or `tavilyApiKey` (tavily.com); follow-ups needs none. Then `node tools/briefs/lib.js --api-test` must print `RESULT: PASS` and name where the key came from, and `--api-test --search` must show a search going through the provider.
2. **Config.** In the same file fill in `resendApiKey` (the same key Railway has), `myAddresses` (every address you send from), and `aboutMe` in your own words. `to` is already `john@comptongroupllc.com`.
3. **Mail.app.** Both accounts must be set up in Mail on that Mac. The first run will ask for Automation permission (System Settings > Privacy & Security > Automation: allow the terminal, and cron, to control Mail). Run `node tools/briefs/follow-ups.js` by hand once so the prompt appears.
4. **LinkedIn CSV.** Upload it at `/admin/connections` on NILDash and it is stored in the database, read by the brief wherever it runs. Prospecting looks at the database first, then `connectionsUrl`, then `connectionsFile`, then `inbox/*.csv`, then `~/nildash-briefs/*.csv` — so dropping `Connections.csv` in `~/nildash-briefs/inbox/` still works on a Mac with no `DATABASE_URL`. The export lives at LinkedIn > Settings > Data privacy > Get a copy of your data > Connections.
5. **launchd, not cron.** `node tools/briefs/launchd.js --install` writes four LaunchAgents (`com.nildash.briefs.<kind>`) that run the briefs at 5:30, 5:45, 6:00 and 6:15 local through `StartCalendarInterval`. cron skips a minute that passes while the Mac is asleep; launchd runs the missed job as soon as the Mac wakes, and folds several missed runs into one. Then `node tools/briefs/launchd.js --remove-cron` takes the old cron lines out (the old crontab is saved under `~/nildash-briefs/logs/`). `--status` shows what is loaded and the last line of each log; the logs are `~/nildash-briefs/logs/launchd-<kind>.log`. `crontab.example` is kept for a machine that has to stay on cron.
6. **Mail.app under launchd.** A launchd job is its own process for Automation permission: run `node tools/briefs/follow-ups.js` once by hand so the Mail prompt appears, and if a launchd run logs `osascript failed`, allow node to control Mail in System Settings > Privacy & Security > Automation.
7. **When a morning's briefs do not arrive**, `bash tools/briefs/why-no-brief.sh` on the Mac prints, top to bottom, whether the Mac was awake at the slots, what is scheduled, what each run logged between 05:20 and 06:30, whether the keys are in place, and the result of one test call. The first block that says the wrong thing is the reason.

## How the briefs call the model

The briefs used to spawn `claude -p`. They now make direct HTTPS calls to DeepSeek's OpenAI-compatible endpoint (`deepseekBaseUrl`, model `deepseekModel`, default `deepseek-v4-flash`) through `server/services/deepseek.js`, the same client the nightly pipeline uses. There is no CLI on the path any more, and no login to expire.

1. **Where the key comes from.** `deepseekApiKey` in `~/nildash-briefs/config.json` first; `DEEPSEEK_API_KEY` in the environment second; with neither, the run fails before any call, with the message `No DeepSeek API key. Set "deepseekApiKey" in ~/nildash-briefs/config.json, or export DEEPSEEK_API_KEY ...`. No key is written anywhere in the repository.

2. **Web search.** DeepSeek's API has no search tool, so a searched call is a function-calling loop (`server/services/webSearchTool.js`): the model asks for `web_search` and `fetch_page`, the searches go to Brave, Serper or Tavily on the key in config.json (`braveSearchApiKey`, `serperApiKey`, `tavilyApiKey`) or the environment (`BRAVE_SEARCH_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY`), and `maxTurns` is the cap on searches per call. A searched brief with no search key fails with a message naming the keys; follow-ups never searches.

3. **The footer of every brief** says which model and key were used, masked, which search door, and what the calls read, wrote, searched and are estimated to have cost:

   `model: DeepSeek deepseek-v4-flash on API key sk-…a1b2 from config.json; web search via brave`
   `DeepSeek calls: 7 (deepseek-v4-flash); turns: 3, 2, ...; tokens in/out: 41200/3900; searches: 14; est $0.0850`

4. **`node tools/briefs/lib.js --api-test`** makes one plain call on the key the briefs use and prints `RESULT: PASS. DeepSeek answers from here on the API key from config.json.`; with `--search` it also runs one searched call and names the provider. Run it from Terminal after setup, and once from cron (paste the line into the crontab for one minute) to see what cron sees. `--claude-test` still exists for the old `claude -p` path and is not used by any brief.

5. **Spend shows at platform.deepseek.com > Usage**, and the search provider's own dashboard shows the queries. The footer's estimate uses the rates in `server/services/aiLedger.js` (`DEEPSEEK_PRICE_IN`, `DEEPSEEK_PRICE_OUT`, `DEEPSEEK_PRICE_CACHE_HIT`, `SEARCH_USD_PER_QUERY` override them).

## Running on Railway

The same four scripts, as one Railway service separate from the NILDash app. The NILDash service, its variables and its deploy are not touched: this is a second service in the same project, built from `tools/briefs/Dockerfile`, run on Railway's cron.

**Why one service and one cron.** Railway gives a service a single cron schedule. The schedule `*/15 10-12 * * *` (UTC) fires every fifteen minutes across the hours that cover 5:30, 5:45, 6:00 and 6:15 Central in both offsets, and `run-slot.js` runs the brief whose Central slot is now, or exits at once. So the four keep their times, daylight saving is handled by the time zone rather than by editing the schedule, and a firing with nothing to do costs seconds.

**Set it up.**

1. Railway > the NILDash project > New > GitHub repo > this repository. Name the service `nildash-briefs`. Leave the root directory at `/`.
2. Service settings > Config-as-code > set the path to `tools/briefs/railway.json`. That file selects the Dockerfile, the start command, the cron schedule and no restarts. Railway reads it on the next deploy.
3. Service settings > Volumes > add a volume mounted at `/data/briefs`. State (what was shown, what was drafted, the last strategy send), the archives and the logs live there. Without it every deploy starts from nothing and the briefs repeat themselves. (The LinkedIn export no longer needs the volume: it is in the database.)
4. Variables: the table below. `BRIEFS_HOME` is already set by the Dockerfile.
5. Deploy. Then run `node tools/briefs/run-slot.js --brief news-watch` from the service's shell (or temporarily set the start command to it) to see one brief go out before the first morning.

**Settings as variables.** Every key of `config.json` has a variable; a variable that is set wins over the file, and there is no file on Railway. Lists are comma-separated or JSON.

| Variable | config.json key | Notes |
|---|---|---|
| `BRIEFS_TO` | `to` | defaults to john@comptongroupllc.com |
| `BRIEFS_FROM` | `from` | defaults to NILDash Briefs <noreply@mynildash.com> |
| `RESEND_API_KEY` | `resendApiKey` | **required**; the same key the app has |
| `DEEPSEEK_API_KEY` | (fallback) | **required** unless `BRIEFS_DEEPSEEK_API_KEY`; the same key the NILDash service has |
| `BRIEFS_DEEPSEEK_API_KEY` | `deepseekApiKey` | optional; wins over `DEEPSEEK_API_KEY` |
| `BRIEFS_DEEPSEEK_MODEL` | `deepseekModel` | `deepseek-v4-flash` |
| `BRIEFS_DEEPSEEK_BASE_URL` | `deepseekBaseUrl` | `https://api.deepseek.com` |
| `BRAVE_SEARCH_API_KEY` / `SERPER_API_KEY` / `TAVILY_API_KEY` | `braveSearchApiKey` / `serperApiKey` / `tavilyApiKey` | **one required** for news, prospecting and strategy-watch; the same key the NILDash service has |
| `ANTHROPIC_API_KEY` / `BRIEFS_ANTHROPIC_API_KEY` | `anthropicApiKey` | no longer used by any brief; only `--claude-test` reads it |
| `BRIEFS_MY_ADDRESSES` | `myAddresses` | **required for follow-ups**; every address you send from |
| `BRIEFS_LOOKBACK_DAYS` | `lookbackDays` | 60 |
| `BRIEFS_SILENT_DAYS` | `silentDays` | 7 |
| `BRIEFS_SKIP_DOMAINS` | `skipDomains` | defaults as before |
| `BRIEFS_NILDASH_USERS` | `nildashUsers` | |
| `BRIEFS_PROSPECT_KEYWORDS` | `prospectKeywords` | |
| `BRIEFS_PROSPECTS_PER_RUN` | `prospectsPerRun` | 20 |
| `BRIEFS_ABOUT_ME` | `aboutMe` | **set it**; the prospect openers read it |
| `BRIEFS_NEWS_TERMS` | `newsTerms` | |
| `BRIEFS_NEWS_LINES` | `newsLines` | 10 |
| `BRIEFS_MAX_TURNS` | `maxTurns` | JSON, e.g. `{"followups":2,"news":4,"prospect":5,"strategy":4}` |
| `BRIEFS_CALL_TIMEOUT_MIN` | `callTimeoutMin` | 6 |
| `BRIEFS_CONFIG_JSON` | (all) | the whole config as one JSON value, if that is easier |
| `BRIEFS_TZ` | | `America/Chicago` |
| `DATABASE_URL` | | **for prospecting**: the same value the NILDash service has. It is how the brief reads the LinkedIn export (below), and it is also the Outlook mail door |
| `BRIEFS_CONNECTIONS_URL` | `connectionsUrl` | fallback only: a direct-download link to the LinkedIn `Connections.csv`, fetched into the volume's inbox each run |
| `BRIEFS_CONNECTIONS_FILE` | `connectionsFile` | fallback only: the path of the LinkedIn CSV when it is not in the inbox, e.g. `~/nildash-briefs/Connections.csv` |

**The LinkedIn export lives in the database.** It used to be a file on one Mac, which is why the prospecting brief could not move off that Mac. Upload it once at **`/admin/connections`** (admin login, dark page, pick the file) and it is stored in `brief_connections`; the brief reads the newest upload wherever it runs, and reports `N connections in Connections.csv (uploaded YYYY-MM-DD)` in its own footer so you can see which copy it used.

Getting the file: LinkedIn > Settings & Privacy > Data privacy > Get a copy of your data > **Connections** (not the full archive). Unzip the emailed download and upload the `Connections.csv` inside. A new upload does not overwrite the old one — the page lists what is stored and lets you delete anything except the copy in use.

`DATABASE_URL` unset, unreachable or the table empty all mean "nothing stored", and the brief falls back to `BRIEFS_CONNECTIONS_URL` and then the filesystem, so the Mac run is unaffected. A database that *fails* is different from one that has nothing in it, and the brief says which in its warnings.

**Run one brief on demand.** From the NILDash app, admin only:

```
/api/admin/scripts/brief?which=news-watch&noEmail=1&text=1
```

`which` is one of the four names. `noEmail=1` archives without sending, `dry=1` (prospecting) counts the queue without spending a model call, `debug=1` adds the trace, `restart=1` re-runs instead of returning the last result, and `text=1` returns plain text instead of JSON. It goes through `run-slot.js --brief`, the same entry point Railway's cron uses, so a brief that works here works there.

This runs **inside the NILDash app service**, not the briefs service, because that is where an HTTP route can live. The brief variables above therefore have to be set on the app service too for the on-demand URL to work — `DEEPSEEK_API_KEY`, a search key and `RESEND_API_KEY` are usually already there; `BRIEFS_TO`, `BRIEFS_MY_ADDRESSES` and `BRIEFS_ABOUT_ME` are not.

**Mail on a server.** Mail.app does not exist on Railway, and the two accounts need two different doors:

| Account | How | Variables |
|---|---|---|
| Gmail | IMAP with a Google **app password** | `BRIEFS_GMAIL_USER` (the address), `BRIEFS_GMAIL_APP_PASSWORD` |
| Outlook | Microsoft Graph, through the mailbox connection the NILDash app holds | `DATABASE_URL`, `EMAIL_ENCRYPTION_KEY` (or `SESSION_SECRET` if that is what the app uses), `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT_ID` if the app sets one: all the same values as the NILDash service |

Why not Gmail OAuth: NILDash's Google consent is `gmail.send` only. Reading needs `gmail.readonly`, a restricted scope Google verifies with a security assessment, and an OAuth app left in testing expires its refresh tokens after seven days. An app password (Google Account > Security > 2-Step Verification > App passwords) is a 16-character secret for this one purpose and does not expire. Why Outlook works: the app's Outlook scopes include `Mail.ReadWrite`, so the refresh token it already stores can read Sent Items and Inbox. Connect the Outlook mailbox in NILDash once, under your own agent login, with the address in `BRIEFS_MY_ADDRESSES`; the briefs read the token with the app's cipher and never write it back. Nothing is read from anyone else's mailbox: only accounts whose address is in `BRIEFS_MY_ADDRESSES` are opened.

`BRIEFS_MAIL_SOURCES` (`mac`, `gmail-imap`, `outlook-graph`) forces the choice; unset, it is Mail.app on macOS and whichever server door has its variables elsewhere. `node tools/briefs/mail-source.js --probe` reads through the chosen doors and prints counts and warnings.

**The Mac keeps working.** Nothing above changes the Mac path: config.json, Mail.app and the crontab behave as before. Once Railway sends the four, remove the Mac crontab lines so each brief arrives once.

## Guardrails

- A search cap on every searched call (`maxTurns`): 4 per news term, 5 per prospect, 4 per strategy-watch search; follow-ups and the strategy paragraph make one plain call each. Change them in `config.json` under `maxTurns`.
- A wall-clock kill of 6 minutes per call (`callTimeoutMin`).
- The model has two functions and nothing else: `web_search` (the provider) and `fetch_page` (one page, text only, capped). Nothing can run a shell command or write a file.
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

On Railway, from the service shell:

```
node tools/briefs/run-slot.js --dry            which brief this minute would run
node tools/briefs/run-slot.js --brief news-watch
node tools/briefs/run-slot.js --all            all four, in order
node tools/briefs/lib.js --api-test             the DeepSeek key, one call
node tools/briefs/lib.js --api-test --search    and one searched call through the provider
node tools/briefs/lib.js --claude-test          the old claude -p path only (anthropicApiKey; fails with "No Anthropic API key" when unset); no brief uses it
node tools/briefs/mail-source.js --probe        the mail doors
```

On the Mac:

```
node tools/briefs/follow-ups.js
node tools/briefs/news-watch.js
node tools/briefs/prospecting.js
node tools/briefs/strategy-watch.js --no-email --print
```

Logs are in `~/nildash-briefs/logs/`. State (what has been shown or drafted) is in `~/nildash-briefs/state/`; delete `prospecting-done.json` to start the prospect queue over.

**Prospecting drafted 0?** Run it with the two flags and read the `[prospecting:debug]` lines:

```
node tools/briefs/prospecting.js --debug --dry
```

`--debug` prints the config it loaded (keys masked), every place it looked for the CSV and what it found there, the header line and the first five rows, the count per keyword, the exclusions (already drafted, already in sent mail, `--exclude`), the next ten in the queue, and a `why 0:` line naming the reason. `--dry` stops there: nothing is researched, drafted, archived or sent. `--no-email` runs the whole thing and writes the archive without sending the email.

**The quality filter.** Each researched person is drafted or filtered. Filtered means the research found them not US-based, or not working in US sports markets, or no opener came back. The brief's subject is `Prospects: N drafted, M filtered`, and a Filtered section lists each with the reason. Filtered people are recorded in `state/prospecting-done.json` with the reason so they are not researched again; a research call that failed outright is not recorded and is retried next run. The batch is still `prospectsPerRun` people researched, so a run with 3 filtered drafts 17.

**Skipping people for one run.** `--exclude "Ann Lee,https://www.linkedin.com/in/bobray"` (or `--exclude=...`, repeatable) skips those connections on that run only, by full name, LinkedIn URL or the handle after `/in/`. Nothing is recorded; they are back in the queue next time. An item that matches nobody in the CSV is reported as a warning.
