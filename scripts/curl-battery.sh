#!/bin/bash
# /api/intent curl battery — Stage 3 (querySchedule + replan-hint).
#
# Usage:
#   BASE_URL=https://<preview-host> APP_SECRET=... bash scripts/curl-battery.sh
#   BASE_URL=http://localhost:3111  APP_SECRET=... bash scripts/curl-battery.sh   # vercel dev
#
# Optional (Vercel Deployment Protection on preview URLs):
#   BYPASS_TOKEN=... bash scripts/curl-battery.sh
#
# Each case prints the raw tool + key args + confidence for manual eyeballing,
# plus a PASS/FAIL line checked against an `expectTool` (and for a couple of
# cases an `expectNotTool` guard so a misclassification is loud, not silent).
#
# This is a manual-run smoke battery (not CI) — see _ai/MVP_PLUS_PLAN.md
# Stage 3 in the Simplanner repo for the spec this exercises.

set -u

BASE_URL="${BASE_URL:-http://localhost:3111}"
APP_SECRET="${APP_SECRET:-}"
BYPASS_TOKEN="${BYPASS_TOKEN:-}"

if [ -z "$APP_SECRET" ]; then
  echo "Set APP_SECRET (from vercel env pull / vercel env ls)." >&2
  exit 1
fi

URL="${BASE_URL%/}/api/intent"
PASS=0
FAIL=0

# args: name | text | context-json-or-empty | expectTool | expectNotTool-or-empty
run_case() {
  local name="$1" text="$2" context="$3" expect="$4" expectNot="${5:-}"

  local payload
  if [ -n "$context" ]; then
    payload=$(python3 -c "import json,sys; print(json.dumps({'text':sys.argv[1],'source':'text','context':json.loads(sys.argv[2])}))" "$text" "$context")
  else
    payload=$(python3 -c "import json,sys; print(json.dumps({'text':sys.argv[1],'source':'text'}))" "$text")
  fi

  local hdrs=(-H "Authorization: Bearer $APP_SECRET" -H "Content-Type: application/json")
  if [ -n "$BYPASS_TOKEN" ]; then
    hdrs+=(-H "x-vercel-protection-bypass: $BYPASS_TOKEN")
  fi

  local resp code json
  resp=$(curl -s -w "\n%{http_code}" --max-time 35 -X POST "$URL" "${hdrs[@]}" -d "$payload")
  code=$(echo "$resp" | tail -1)
  json=$(echo "$resp" | sed '$d')

  echo ""
  echo "── $name"
  echo "   \"$text\"$( [ -n "$context" ] && echo "  context=$context" )   (HTTP $code)"

  result=$(echo "$json" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except: print('ERROR no-json'); sys.exit()
acts=d.get('actions')
if not acts:
    print('ERROR', d.get('error','no actions')); sys.exit()
for i,a in enumerate(acts,1):
    ar=a.get('args',{})
    print(f'   {i}. {a.get(\"tool\",\"\"):16} {ar}  [{a.get(\"confidence\")}]  summary={a.get(\"summary\")!r}')
tools=[a.get('tool') for a in acts]
print('TOOLS=' + ','.join(tools))
")
  echo "$result" | grep -v '^TOOLS='
  tools_line=$(echo "$result" | grep '^TOOLS=' | cut -d= -f2-)

  local ok=1
  if [[ "$tools_line" != *"$expect"* ]]; then
    ok=0
  fi
  if [ -n "$expectNot" ] && [[ "$tools_line" == *"$expectNot"* ]]; then
    ok=0
  fi

  if [ "$ok" = 1 ]; then
    echo "   PASS (expected '$expect' present$( [ -n "$expectNot" ] && echo ", '$expectNot' absent" ))"
    PASS=$((PASS+1))
  else
    echo "   FAIL — got tools: [$tools_line], expected '$expect'$( [ -n "$expectNot" ] && echo " and NOT '$expectNot'" )"
    FAIL=$((FAIL+1))
  fi
}

echo "Running against $URL"

# ── Regression: a few pre-existing verbs, so a prompt regression shows up here too ──
run_case "regression: addBlock"       "add 30 min reading tomorrow morning"        "" "addBlock"
run_case "regression: deleteBlock"    "delete my gym on friday"                    "" "deleteBlock"
run_case "regression: moveBlock"      "move my reading to evening"                 "" "moveBlock"

# ── New: querySchedule classification (4 required cases) ──
run_case "query: today"               "what's on my schedule today"                "" "querySchedule"
run_case "query: named day"           "what do I have going on Thursday"           "" "querySchedule"
run_case "query: nextOccurrence"      "when do I next have gym"                    "" "querySchedule"
run_case "query: freeSlot"            "am I free Thursday evening"                 "" "querySchedule"

# ── New: must stay notSupported (2 required cases) ──
run_case "notSupported: analytics"    "how productive was I in March"              "" "notSupported"
run_case "notSupported: delete account" "delete my account"                        "" "notSupported"

# ── New: replan-hint context (2 required cases) — expect move/adjust verbs, NOT addBlock ──
run_case "replan-hint: mornings not working" \
  "mornings aren't working" \
  '{"hint":"replan: mornings lapsed for Meditation"}' \
  "moveBlock" "addBlock"

run_case "replan-hint: try evenings instead" \
  "let's try evenings instead" \
  '{"hint":"replan: mornings lapsed for Meditation"}' \
  "moveBlock" "addBlock"

echo ""
echo "════════════════════════════════════"
echo "  $PASS passed, $FAIL failed"
echo "════════════════════════════════════"
[ "$FAIL" -eq 0 ]
