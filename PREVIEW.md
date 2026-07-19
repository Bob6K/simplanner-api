# Preview deployments

## Stage 3 — querySchedule + replan-hint (`feat/query-replan`)

**Preview URL:** https://simplanner-jtnhjno7v-bobwijs-3100s-projects.vercel.app
**Endpoint:** `POST /api/intent`
**Deployed:** 2026-07-18, via `vercel deploy` (no `--prod`) — production is untouched and still points at the pre-Stage-3 `main`.

This deployment sits behind Vercel Deployment Protection (SSO). To call it directly:

```bash
curl -X POST https://simplanner-jtnhjno7v-bobwijs-3100s-projects.vercel.app/api/intent \
  -H "Authorization: Bearer $APP_SECRET" \
  -H "x-vercel-protection-bypass: $VERCEL_BYPASS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"what is on my schedule today","source":"text"}'
```

`APP_SECRET` and the bypass token are the same ones already used by the iOS app / `~/simplanner-test.sh` for previous preview testing — not committed here.

Run the full battery with:

```bash
BASE_URL=https://simplanner-jtnhjno7v-bobwijs-3100s-projects.vercel.app \
BYPASS_TOKEN=<vercel automation bypass secret> \
APP_SECRET=<app secret> \
bash scripts/curl-battery.sh
```

**Do not promote this to production** until iOS ships client-side handling for the `querySchedule` tool (see `Simplanner/_ai/MVP_PLUS_PLAN.md` Stage 4a) — an unhandled tool currently falls back to a generic "couldn't resolve" card on older iOS builds instead of a graceful message.
