#!/bin/bash
# /api/intent STT battery — S37 (whisper-1 → gpt-transcribe migration).
#
# Posts the stt-clips/ audio clips (generate first: scripts/make-stt-clips.sh)
# through the FULL voice pipeline (STT → hallucination guards → intent parse)
# and checks the resolved tool per clip — same expectations as the text
# battery (curl-battery.sh), plus silence/noise clips that must be REJECTED
# by the guards with HTTP 422.
#
# Usage:
#   BASE_URL=https://<preview-host> APP_SECRET=... BYPASS_TOKEN=... \
#     bash scripts/stt-battery.sh
#
# Prints each clip's rawTranscript for manual WER eyeballing.

set -u
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-}"
APP_SECRET="${APP_SECRET:-}"
BYPASS_TOKEN="${BYPASS_TOKEN:-}"
[ -n "$BASE_URL" ] && [ -n "$APP_SECRET" ] || { echo "Set BASE_URL and APP_SECRET." >&2; exit 1; }
[ -d stt-clips ] || { echo "No stt-clips/ — run scripts/make-stt-clips.sh first." >&2; exit 1; }

URL="${BASE_URL%/}/api/intent"
PASS=0
FAIL=0

# clip|context-json-or-empty|expectTool-or-REJECT422|expectNotTool-or-empty
CASES=(
  "01-addblock||addBlock|"
  "02-deleteblock||deleteBlock|"
  "03-moveblock||moveBlock|"
  "04-query-today||querySchedule|"
  "05-query-day||querySchedule|"
  "06-query-next||querySchedule|"
  "07-query-free||querySchedule|"
  "08-notsup-analytics||notSupported|"
  "09-notsup-account||notSupported|"
  "10-replan-mornings|{\"hint\":\"replan: mornings lapsed for Meditation\"}|moveBlock|addBlock"
  "11-replan-evenings|{\"hint\":\"replan: mornings lapsed for Meditation\"}|moveBlock|addBlock"
  "12-silence||REJECT422|"
  "13-noise||REJECT422|"
)

for entry in "${CASES[@]}"; do
  IFS='|' read -r clip context expect expectNot <<< "$entry"
  file="stt-clips/$clip.m4a"
  [ -f "$file" ] || { echo "── $clip  MISSING ($file)"; FAIL=$((FAIL+1)); continue; }

  b64=$(base64 -i "$file" | tr -d '\n')
  payload=$(python3 -c "
import json, sys
p = {'audio': sys.argv[1], 'source': 'voice'}
if sys.argv[2]:
    p['context'] = json.loads(sys.argv[2])
print(json.dumps(p))" "$b64" "$context")

  hdrs=(-H "Authorization: Bearer $APP_SECRET" -H "Content-Type: application/json")
  [ -n "$BYPASS_TOKEN" ] && hdrs+=(-H "x-vercel-protection-bypass: $BYPASS_TOKEN")

  resp=$(curl -s -w "\n%{http_code}" --max-time 60 -X POST "$URL" "${hdrs[@]}" -d "$payload")
  code=$(echo "$resp" | tail -1)
  json=$(echo "$resp" | sed '$d')

  echo ""
  echo "── $clip$( [ -n "$context" ] && echo "  context=$context" )   (HTTP $code)"

  if [ "$expect" = "REJECT422" ]; then
    transcript=$(echo "$json" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except: d={}
print(d.get('rawTranscript',''))")
    echo "   guard transcript: ${transcript:-<none>}"
    if [ "$code" = "422" ]; then
      echo "   PASS (guard rejected with 422)"
      PASS=$((PASS+1))
    else
      echo "   FAIL — expected 422 rejection, got HTTP $code: $(echo "$json" | head -c 300)"
      FAIL=$((FAIL+1))
    fi
    continue
  fi

  result=$(echo "$json" | python3 -c "
import json, sys
try: d = json.load(sys.stdin)
except: print('ERROR no-json'); sys.exit()
print('   transcript: ' + repr(d.get('rawTranscript')))
acts = d.get('actions')
if not acts:
    print('ERROR', d.get('error', 'no actions')); sys.exit()
for i, a in enumerate(acts, 1):
    print(f'   {i}. {a.get(\"tool\",\"\"):16} {a.get(\"args\",{})}  [{a.get(\"confidence\")}]')
print('TOOLS=' + ','.join(a.get('tool') for a in acts))
")
  echo "$result" | grep -v '^TOOLS='
  tools_line=$(echo "$result" | grep '^TOOLS=' | cut -d= -f2-)

  ok=1
  [[ "$tools_line" != *"$expect"* ]] && ok=0
  [ -n "$expectNot" ] && [[ "$tools_line" == *"$expectNot"* ]] && ok=0

  if [ "$ok" = 1 ]; then
    echo "   PASS (expected '$expect' present$( [ -n "$expectNot" ] && echo ", '$expectNot' absent" ))"
    PASS=$((PASS+1))
  else
    echo "   FAIL — got tools: [$tools_line], expected '$expect'$( [ -n "$expectNot" ] && echo " and NOT '$expectNot'" )"
    FAIL=$((FAIL+1))
  fi
done

echo ""
echo "════════════════════════════════════"
echo "  $PASS passed, $FAIL failed"
echo "════════════════════════════════════"
[ "$FAIL" -eq 0 ]
