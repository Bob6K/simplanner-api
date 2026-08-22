# Deploying simplanner-api

The repo that serves `https://simplanner-api.vercel.app/api/intent` (+ `/api/events`).
Prod is promoted **manually from the CLI** — pushing a branch does *not* deploy
(verified S49: a push produced no new deployment).

## The loop (the #50 pattern — use it for every prompt/schema change)

```
vercel deploy --yes                 # → preview URL
BASE_URL=https://<preview-host> BYPASS_TOKEN=<see below> \
  bash scripts/week-scope-battery.sh          # or curl-battery.sh
# all green?
vercel deploy --prod --yes          # promotes + aliases simplanner-api.vercel.app
BASE_URL=https://simplanner-api.vercel.app bash scripts/week-scope-battery.sh
```

Keep `main` fast-forwarded to whatever prod runs (done S50; before that prod
had run from feature branches since S33 and `main` was six commits stale).

## Environments — the S49/S50 gotchas, so nobody re-learns them

- **Preview URLs are behind Vercel SSO** ("Protected deployment", 401). The
  door is **Protection Bypass for Automation** — the secret named **"CC
  Bypass"** (Settings → Deployment Protection). Send it as the
  `x-vercel-protection-bypass` header. Its VALUE is visible **only in the
  dashboard** (eye icon) — `vercel env ls` doesn't list it and `vercel env
  pull` doesn't fetch it. The prod alias has no SSO wall; the app-level
  `APP_SECRET` Bearer check is the real guard everywhere.
- **`OPENAI_API_KEY` exists for Production + Preview only.** Vercel refuses
  sensitive env vars in Development, so **`vercel dev` has no key** unless
  you export one into the shell first (`set -a; source .env.local; set +a` —
  and note `vercel dev` does NOT read `.env.local` into functions by itself).
- `.env.local` is a **snapshot** (`vercel env pull`), and it goes stale: the
  key in it 401'd in S49 while prod's copy worked fine. When local calls fail,
  test the key directly against `api.openai.com` before blaming the code.
- `SYSTEM_PROMPT` in `api/intent.js` is a **template literal** — a backtick
  in prompt text breaks module parsing entirely (found S49, would have 500'd
  prod). Parse-check before deploying:
  `node --input-type=module -e "await import('./api/intent.js')"`.
- `LOG_USER_CONTENT=1` makes logs verbatim (transcripts, block names).
  Default off = lengths only. The privacy policy states the default — don't
  flip it in prod casually.

## Batteries

- `scripts/week-scope-battery.sh` — 15 cases: the week scope, the Sunday Wrap
  hint, hint-vs-explicit-day precedence, all neighbour scopes, notSupported
  spans. Exits non-zero on any failure.
- `scripts/curl-battery.sh` — the older, broader smoke set.

Both read `APP_SECRET` from `.env.local` if not exported.
