export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || token !== process.env.APP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { transcript, original_blocks, confirmed_blocks } = req.body ?? {};

  // Structured log for prompt tuning. NOTE (S38 privacy audit): this
  // endpoint has no call site in the iOS app — it is dead today. It used to
  // log transcripts and block contents verbatim; same LOG_USER_CONTENT gate
  // as /api/intent so it cannot leak user content if it is ever wired up.
  // Consider deleting it outright if it stays unused.
  const logContent = process.env.LOG_USER_CONTENT === "1";
  console.log(JSON.stringify({
    type:             "voice_feedback",
    ts:               new Date().toISOString(),
    transcript:       logContent ? (transcript ?? "") : `[redacted ${(transcript ?? "").length} chars]`,
    originalCount:    (original_blocks  ?? []).length,
    confirmedCount:   (confirmed_blocks ?? []).length,
    original_blocks:  logContent ? (original_blocks  ?? []) : undefined,
    confirmed_blocks: logContent ? (confirmed_blocks ?? []) : undefined,
  }));

  return res.status(200).json({ ok: true });
}
