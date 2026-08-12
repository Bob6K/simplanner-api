# Preview deployments

## S37 — new model pipeline: gpt-transcribe + gpt-5.4-mini (`feat/model-bakeoff`)

**Preview URL:** https://simplanner-b3ingmazj-bobwijs-3100s-projects.vercel.app
**Endpoint:** `POST /api/intent`
**Deployed:** 2026-08-12, via `vercel deploy -e INTENT_MODEL=gpt-5.4-mini` — production untouched (still whisper-1 + gpt-4o).

The #36 migration build: STT switched to `gpt-transcribe` in code (env-overridable
via `STT_MODEL`, rollback = `STT_MODEL=whisper-1`), intent model set to
`gpt-5.4-mini` as deploy-time env, legacy `/api/voice` DELETED.

Verified on this deployment (2026-08-12):
- Text battery (`scripts/curl-battery.sh`): **11/11**, 21 s.
- STT battery (`scripts/stt-battery.sh`, spoken clips through the full
  voice pipeline): **13/13**, 32 s — incl. silence + noise clips rejected
  422 by the hallucination guards.
- Known STT edge (documented in `scripts/make-stt-clips.sh`): the Moira
  synthetic voice's "Mornings aren't working" transcribes as "Mornings and
  working" on gpt-transcribe (whisper-1 got it); other voices fine on both.

**Next:** Bob device-tests voice against this preview → his GO → set
`INTENT_MODEL=gpt-5.4-mini` in the Production env (STT flips with the merge).

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
