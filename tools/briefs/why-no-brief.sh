#!/bin/bash
# ── WHY DID THIS MORNING'S BRIEFS NOT ARRIVE? ────────────────────────────────
#
#   bash tools/briefs/why-no-brief.sh [YYYY-MM-DD]      default: today
#
# Run on the Mac that runs the briefs. Prints, in order, everything that
# decides whether a brief went out: whether the Mac was awake at the four
# slots, what cron (or launchd) is set to run, what each run logged between
# 05:20 and 06:30 on that day, the keys the briefs would find, and the last
# thing each brief's own log says. Read top to bottom; the first block that
# says the wrong thing is the reason.

DAY="${1:-$(date +%Y-%m-%d)}"
BRIEFS="$HOME/nildash-briefs"
LOGS="$BRIEFS/logs"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

hr() { printf '\n== %s ==\n' "$1"; }

hr "1. Was the Mac awake at 05:30-06:15 on $DAY? (pmset log: sleep and wake around the slots)"
pmset -g log 2>/dev/null | grep "$DAY" | grep -Ei "sleep|wake|darkwake" | grep -E " 0[4-7]:" | tail -30 || echo "(pmset gave nothing for $DAY)"
echo "-- scheduled wake:"
pmset -g sched 2>/dev/null || echo "(none)"

hr "2. What is scheduled"
echo "-- crontab:"
crontab -l 2>/dev/null | grep -E "briefs|NODE=|REPO=|PATH=" || echo "(no brief lines in the crontab)"
echo "-- launchd agents:"
ls "$HOME/Library/LaunchAgents" 2>/dev/null | grep nildash || echo "(no com.nildash.briefs.* agents)"
for k in follow-ups news-watch prospecting strategy-watch; do
  launchctl print "gui/$(id -u)/com.nildash.briefs.$k" 2>/dev/null | grep -E "state =|last exit code" | sed "s/^/   $k: /"
done

hr "3. What the runs logged between 05:20 and 06:30 on $DAY"
for f in "$LOGS/cron.log" "$LOGS"/launchd-*.log; do
  [ -f "$f" ] || continue
  echo "-- $f"
  grep -E "^\[?$DAY[ T]0(5:[2-5][0-9]|6:[0-2][0-9])" "$f" 2>/dev/null | tail -40 || true
done
echo "-- each brief's own log, lines from $DAY:"
for k in follow-ups news-watch prospecting strategy-watch; do
  f="$LOGS/$k.log"
  echo "   [$k]"
  if [ -f "$f" ]; then grep "$DAY" "$f" | tail -8 | sed 's/^/     /' || true; [ -z "$(grep "$DAY" "$f")" ] && echo "     (nothing logged on $DAY: the run never started)"; else echo "     (no $k.log at all)"; fi
done

hr "4. Would a run find its keys? (masked)"
if [ -f "$BRIEFS/config.json" ]; then
  node -e '
    const c = require(process.argv[1]);
    const m = (v) => v ? String(v).slice(0, 4) + "..." + String(v).slice(-4) : "(empty)";
    console.log("   deepseekApiKey   " + m(c.deepseekApiKey) + (c.deepseekApiKey ? "" : "  <- every brief needs this (or DEEPSEEK_API_KEY in the environment cron/launchd sees)"));
    console.log("   resendApiKey     " + m(c.resendApiKey) + (c.resendApiKey ? "" : "  <- no email can be sent without it"));
    console.log("   search key       " + (c.serperApiKey ? "serper " + m(c.serperApiKey) : c.braveSearchApiKey ? "brave " + m(c.braveSearchApiKey) : c.tavilyApiKey ? "tavily " + m(c.tavilyApiKey) : "(none)  <- news, prospecting and strategy-watch stop without one; follow-ups does not need it"));
    console.log("   to               " + (c.to || "(empty)"));
    console.log("   from             " + (c.from || "(empty)"));
  ' "$BRIEFS/config.json"
else
  echo "   $BRIEFS/config.json is MISSING: every run stops before any call"
fi
echo "-- environment cron would see (only what is exported here, not cron's):"
echo "   DEEPSEEK_API_KEY $([ -n "$DEEPSEEK_API_KEY" ] && echo set || echo unset)   RESEND_API_KEY $([ -n "$RESEND_API_KEY" ] && echo set || echo unset)"

hr "5. Does the checkout run at all from here?"
echo "-- node: $(which node) $(node -v 2>/dev/null)"
echo "-- repo: $REPO  ($(cd "$REPO" && git log --oneline -1 2>/dev/null))"
[ -d "$REPO/node_modules/resend" ] && echo "-- resend package: present" || echo "-- resend package: MISSING (run npm install in $REPO; sendBrief throws without it)"
echo "-- api test (one plain DeepSeek call on the briefs' key):"
(cd "$REPO" && node tools/briefs/lib.js --api-test 2>&1 | tail -3)

hr "What to do next"
cat <<'EOF'
  - Nothing in block 3 for the day and block 1 shows sleep across 05:30: the Mac was asleep and cron skipped
    the minute. Switch to launchd, which fires the missed run on wake:
        node tools/briefs/launchd.js --install && node tools/briefs/launchd.js --remove-cron
  - "No DeepSeek API key" / "no Resend key" in block 3 or a blank in block 4: fill ~/nildash-briefs/config.json.
  - "osascript failed" in follow-ups.log: System Settings > Privacy & Security > Automation, allow node
    (and Terminal) to control Mail; then run the brief once by hand.
  - "EMAIL FAILED" in a brief's log: the brief ran and the archive is complete; the Resend send failed and the
    line says why (a wrong key, an unverified from domain).
  - To send the follow-ups brief now and confirm delivery:
        node tools/briefs/follow-ups.js && tail -3 ~/nildash-briefs/logs/follow-ups.log
EOF
