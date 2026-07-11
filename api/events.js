// Funnel-event sink (#28). The iOS client batches event names and
// fire-and-forgets them here. No PII, no DB — one structured console.log per
// batch, readable via `vercel logs`, auto-expiring with Vercel's ~7-day log
// retention (matches the published privacy policy).
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth — same Bearer APP_SECRET as /api/intent and /api/feedback
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || token !== process.env.APP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { variant, session, events, debug } = req.body ?? {};
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: "events must be a non-empty array" });
  }

  // Hard cap per batch — backstop against a runaway client loop
  const batch = events.slice(0, 100);

  console.log(JSON.stringify({
    type:    "funnel_events",
    ts:      new Date().toISOString(),
    variant: typeof variant === "string" ? variant.slice(0, 16) : "",
    session: typeof session === "string" ? session.slice(0, 16) : "",
    debug:   debug === true,
    events:  batch.map(e => ({
      name: String(e?.name ?? "").slice(0, 80),
      ts:   typeof e?.ts === "number" ? e.ts : null,
    })),
  }));

  return res.status(200).json({ ok: true, received: batch.length });
}
