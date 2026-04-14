import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `Extract planner blocks from the transcript. Return valid JSON only — no prose.
Schema: { "blocks": [ { "day": string, "timePart": string, "activityHint": string, "durationMinutes": number|null } ] }
day values: "today" | "tomorrow" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"
timePart values: "morning" | "midday" | "evening" | "night"
Rules:
- If day not mentioned → "today"
- If timePart not mentioned → "morning"
- If duration not mentioned → null
- activityHint: the spoken activity name, lowercase, as heard`;

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth check
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || token !== process.env.APP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Parse body
  const { audio } = req.body ?? {};
  if (!audio || typeof audio !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'audio' field (expected base64 string)" });
  }

  // Decode base64 audio
  let audioBuffer;
  try {
    audioBuffer = Buffer.from(audio, "base64");
  } catch {
    return res.status(400).json({ error: "Failed to decode base64 audio" });
  }

  // Call Whisper
  let transcript;
  try {
    // Vercel serverless: pass buffer as a File-like object
    const audioFile = new File([audioBuffer], "audio.m4a", { type: "audio/m4a" });
    const whisperRes = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: audioFile,
    });
    transcript = whisperRes.text;
  } catch (err) {
    console.error("Whisper error:", err);
    return res.status(502).json({ error: "Whisper transcription failed", detail: err.message });
  }

  // Call GPT-4o-mini for block parsing
  let blocks;
  try {
    const chatRes = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
      temperature: 0,
    });
    const parsed = JSON.parse(chatRes.choices[0].message.content);
    blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
  } catch (err) {
    console.error("GPT parse error:", err);
    return res.status(502).json({ error: "Block parsing failed", detail: err.message });
  }

  return res.status(200).json({ transcript, blocks });
}
