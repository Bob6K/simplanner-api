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

  // Structured log — readable by `vercel logs` for prompt tuning
  console.log(JSON.stringify({
    type:             "voice_feedback",
    ts:               new Date().toISOString(),
    transcript:       transcript       ?? "",
    original_blocks:  original_blocks  ?? [],
    confirmed_blocks: confirmed_blocks ?? [],
  }));

  return res.status(200).json({ ok: true });
}
