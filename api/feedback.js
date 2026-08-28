// User feedback sink (#56) — the Settings "Send a bug or idea" sheet posts
// here. Replaces the dead voice-feedback endpoint that used to live at this
// path (S38 audit: it had no call site; its comment said to repurpose or
// delete).
//
// The text is DELIBERATE user feedback — the user is writing to the
// developer, the sheet says so — so unlike /api/intent there is no content
// redaction: the whole point is that Bob reads it.
//
// Durability: Vercel logs expire in ~7 days, which is too short for "I read
// every message". When FEEDBACK_GITHUB_TOKEN is set (repo-scope token), each
// report is also filed as a GitHub issue labeled `user-feedback` in
// FEEDBACK_GITHUB_REPO (default Bob6K/Simplanner, private). The log line is
// the fallback if the issue call ever fails.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth — same Bearer APP_SECRET as /api/intent and /api/events
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || token !== process.env.APP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { kind, text, email, appVersion, osVersion, locale } = req.body ?? {};
  const k = ["bug", "feature", "other"].includes(kind) ? kind : "other";
  const t = String(text ?? "").trim().slice(0, 4000);
  if (!t) {
    return res.status(400).json({ error: "text is required" });
  }
  const meta = {
    email:      String(email ?? "").trim().slice(0, 200),
    appVersion: String(appVersion ?? "").slice(0, 40),
    osVersion:  String(osVersion ?? "").slice(0, 40),
    locale:     String(locale ?? "").slice(0, 20),
  };

  console.log(JSON.stringify({
    type: "user_feedback",
    ts:   new Date().toISOString(),
    kind: k,
    text: t,
    ...meta,
  }));

  // Best-effort durable copy — a GitHub API hiccup must not fail the user's
  // send (the log line above already captured it).
  const ghToken = process.env.FEEDBACK_GITHUB_TOKEN;
  if (ghToken) {
    const repo = process.env.FEEDBACK_GITHUB_REPO || "Bob6K/Simplanner";
    const title = `[user-${k}] ${t.slice(0, 60)}${t.length > 60 ? "…" : ""}`;
    const body = [
      t,
      "",
      "---",
      `kind: ${k}`,
      meta.email ? `email: ${meta.email}` : "email: (none)",
      `app: ${meta.appVersion || "?"} · iOS ${meta.osVersion || "?"} · ${meta.locale || "?"}`,
      `received: ${new Date().toISOString()}`,
    ].join("\n");
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ghToken}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "simplanner-api-feedback",
        },
        body: JSON.stringify({ title, body, labels: ["user-feedback", k] }),
      });
      if (!r.ok) {
        console.warn(JSON.stringify({ type: "feedback_github_failed", status: r.status }));
      }
    } catch (err) {
      console.warn(JSON.stringify({ type: "feedback_github_failed", error: String(err).slice(0, 200) }));
    }
  }

  return res.status(200).json({ ok: true });
}
