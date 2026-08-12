#!/bin/bash
# S36 model bake-off — deploy-per-model PREVIEW variant.
#
# Local `vercel dev` was a dead end (the sensitive OPENAI_API_KEY can't be
# pulled), so each candidate gets its own preview deployment with
# INTENT_MODEL (and, for xAI, INTENT_BASE_URL/INTENT_API_KEY) passed as
# deploy-time env; previews inherit the working OPENAI_API_KEY from the
# Preview environment. The curl battery then runs against each preview.
#
# Usage:  bash scripts/bakeoff.sh
#         MODELS="grok-4.3|xai" bash scripts/bakeoff.sh
#
# Needs: .env.local (APP_SECRET + XAI_API_KEY), the protection-bypass token
# in ~/simplanner-test.sh, and a logged-in vercel CLI.

set -u
cd "$(dirname "$0")/.."

OUT="bakeoff-results"; mkdir -p "$OUT"
ENVFILE=".env.local"

TOKEN=$(grep -o 'x-vercel-protection-bypass: [A-Za-z0-9]*' ~/simplanner-test.sh | head -1 | awk '{print $2}')
APP_SECRET=$(grep -o '^APP_SECRET="[^"]*"' "$ENVFILE" | cut -d'"' -f2)
XAI_KEY=$(grep -o '^XAI_API_KEY="[^"]*"' "$ENVFILE" | cut -d'"' -f2)
[ -n "$TOKEN" ] && [ -n "$APP_SECRET" ] || { echo "Missing bypass token or APP_SECRET."; exit 1; }

DEFAULT_MATRIX="gpt-4o|openai gpt-5.4-mini|openai gpt-5.4-nano|openai grok-4.3|xai grok-4.5|xai"
MATRIX="${MODELS:-$DEFAULT_MATRIX}"

SUMMARY=""
for entry in $MATRIX; do
  model="${entry%%|*}"
  provider="${entry##*|}"

  args=(-e INTENT_MODEL="$model")
  if [ "$provider" = "xai" ]; then
    args+=(-e INTENT_BASE_URL="https://api.x.ai/v1" -e INTENT_API_KEY="$XAI_KEY")
  fi

  echo "── deploying $model ($provider)…"
  vercel deploy "${args[@]}" > "$OUT/$model.deploy.json" 2> "$OUT/$model.deploy.err"
  URL=$(jq -r '.deployment.url // empty' < "$OUT/$model.deploy.json")
  if [ -z "$URL" ]; then
    echo "   deploy FAILED (see $OUT/$model.deploy.err)"
    SUMMARY="$SUMMARY\n$model: DEPLOY-FAILED"
    continue
  fi

  start=$(date +%s)
  BASE_URL="https://${URL#https://}" BYPASS_TOKEN="$TOKEN" APP_SECRET="$APP_SECRET" \
    bash scripts/curl-battery.sh > "$OUT/$model.log" 2>&1
  secs=$(( $(date +%s) - start ))

  line=$(grep -E "passed, .* failed" "$OUT/$model.log" | tail -1 | xargs)
  SUMMARY="$SUMMARY\n$model: ${line:-NO-RESULT} (${secs}s for 11 calls)"
  echo "   $model → ${line:-NO-RESULT} (${secs}s)"
done

echo ""
echo "════════ BAKE-OFF SUMMARY ════════"
printf "%b\n" "$SUMMARY"
echo "Per-case logs: $OUT/<model>.log"
