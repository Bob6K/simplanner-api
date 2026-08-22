#!/bin/bash
# week-scope battery — verifies the `querySchedule(scope="week")` addition (#50)
# and, just as importantly, that adding it did not drag the neighbouring
# questions into it.
#
# Usage:
#   BASE_URL=http://localhost:3111 bash scripts/week-scope-battery.sh          # vercel dev
#   BASE_URL=https://<preview-host> BYPASS_TOKEN=... bash scripts/week-scope-battery.sh
#
# APP_SECRET is read from .env.local unless already exported.
set -u

BASE_URL="${BASE_URL:-http://localhost:3111}"
BYPASS_TOKEN="${BYPASS_TOKEN:-}"
if [ -z "${APP_SECRET:-}" ]; then
  APP_SECRET=$(grep '^APP_SECRET=' "$(dirname "$0")/../.env.local" | cut -d= -f2- | tr -d '"'"'"'')
fi
[ -z "$APP_SECRET" ] && { echo "No APP_SECRET." >&2; exit 1; }

URL="${BASE_URL%/}/api/intent"
PASS=0; FAIL=0

# name | text | context-json ("" for none) | expected tool | expected scope ("" = don't care)
run() {
  local name="$1" text="$2" ctx="$3" wantTool="$4" wantScope="${5:-}"
  local payload
  if [ -n "$ctx" ]; then
    payload=$(python3 -c "import json,sys;print(json.dumps({'text':sys.argv[1],'source':'text','context':json.loads(sys.argv[2])}))" "$text" "$ctx")
  else
    payload=$(python3 -c "import json,sys;print(json.dumps({'text':sys.argv[1],'source':'text'}))" "$text")
  fi
  local hdrs=(-H "Authorization: Bearer $APP_SECRET" -H "Content-Type: application/json")
  [ -n "$BYPASS_TOKEN" ] && hdrs+=(-H "x-vercel-protection-bypass: $BYPASS_TOKEN")

  local json
  json=$(curl -s --max-time 60 -X POST "$URL" "${hdrs[@]}" -d "$payload")
  local line
  line=$(echo "$json" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('PARSE_ERROR|||'); sys.exit()
if 'error' in d:
    e=d['error']; print('API_ERROR|'+str(e if isinstance(e,str) else e.get('message',''))+'||'); sys.exit()
a=(d.get('actions') or [{}])[0]
print('|'.join([str(a.get('tool')), str((a.get('args') or {}).get('scope','')), str(a.get('confidence')), json.dumps(a.get('args'))]))
")
  local tool scope conf args
  IFS='|' read -r tool scope conf args <<< "$line"

  local ok=1
  [ "$tool" != "$wantTool" ] && ok=0
  [ -n "$wantScope" ] && [ "$scope" != "$wantScope" ] && ok=0

  if [ $ok -eq 1 ]; then PASS=$((PASS+1)); printf '  PASS  '; else FAIL=$((FAIL+1)); printf '  FAIL  '; fi
  printf '%-34s -> %s %s (conf=%s)\n' "$name" "$tool" "$args" "$conf"
  [ $ok -eq 0 ] && printf '        expected tool=%s scope=%s\n' "$wantTool" "${wantScope:-any}"
}

echo "== week scope (the new capability) =="
run "explicit: got done this week" "What did I get done this week?"        ""                          querySchedule week
run "explicit: how did my week go" "How did my week go?"                   ""                          querySchedule week
run "explicit: how much this week" "How much did I do this week?"          ""                          querySchedule week

echo
echo "== the Sunday Wrap trigger =="
run "bare look-back + wrap hint"   "How did it go?"                        '{"hint":"weekly review"}'  querySchedule week
run "vague 'what did I do' + hint" "What did I do?"                        '{"hint":"weekly review"}'  querySchedule week

echo
echo "== hint must NOT override an explicit day =="
run "named day beats the hint"     "What do I have on tomorrow?"           '{"hint":"weekly review"}'  querySchedule day
run "today beats the hint"         "What is on today?"                     '{"hint":"weekly review"}'  querySchedule today

echo
echo "== regressions: neighbours must not drift into week =="
run "plain today"                  "What is on today"                      ""                          querySchedule today
run "named day"                    "What do I have on Thursday"            ""                          querySchedule day
run "next occurrence"              "When do I next have gym"               ""                          querySchedule nextOccurrence
run "free slot"                    "Am I free Thursday evening"            ""                          querySchedule freeSlot
run "a COMMAND is not a question"  "Add gym today"                         ""                          addBlock

echo
echo "== out-of-range spans stay notSupported =="
run "last week"                    "How did last week go?"                 ""                          notSupported
run "a named past month"           "How productive was I in March?"        ""                          notSupported
run "longest streak"               "What is my longest streak?"            ""                          notSupported

echo
echo "-- $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
