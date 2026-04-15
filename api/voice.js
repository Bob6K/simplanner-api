import OpenAI, { toFile } from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a smart planner assistant. Extract ALL scheduling intents from the transcript. Return valid JSON only — no prose, no markdown, no code fences.

Schema: { "blocks": [ { "day": string, "timePart": string, "activityHint": string, "durationMinutes": number|null, "iconHint": string } ] }

day values: "today" | "tomorrow" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"
timePart values: "morning" | "midday" | "evening" | "night"
iconHint: a VALID iOS 17 SF Symbol name. Use ONLY names from this verified list — never invent names:
  Sports/fitness: figure.run, figure.walk, figure.hiking, figure.pool.swim, figure.tennis, figure.basketball, figure.soccer, figure.skiing.downhill, figure.golf, figure.rowing, figure.surfing, figure.martial.arts, figure.strengthtraining.traditional, figure.mind.and.body, figure.cooldown, figure.dance, bicycle, dumbbell, sportscourt.fill, heart.fill
  Work/mind: briefcase.fill, laptopcomputer, brain, pencil, envelope.fill, person.2.fill, chart.bar.fill, text.document
  Lifestyle: flame.fill, fork.knife, cup.and.saucer.fill, cart.fill, tv.fill, music.note, gamecontroller.fill, camera.fill, bed.double.fill, sparkles, book.fill, paintbrush.fill
  When unsure: use sportscourt.fill for sports, figure.walk for movement, sparkles for lifestyle/wellness, briefcase.fill for work

Smart inference rules:
DAY — "this morning/afternoon/tonight" → "today" | "next Monday" → "monday" | day not mentioned → "today"
TIME — "morning/early/breakfast" → "morning" | "afternoon/lunch/noon/midday" → "midday" | "evening/after work/after dinner" → "evening" | "night/tonight/before bed/late" → "night" | not mentioned → "morning"
DURATION — "an hour/1 hour" → 60 | "half hour/30 min" → 30 | "45 min" → 45 | "quick/briefly/short" → 15 | "2 hours" → 120 | "all morning/afternoon" → 90 | not mentioned → null
MULTIPLE — "gym and reading" or "gym then reading" → two separate blocks, one per activity
ACTIVITY — extract the core activity name, strip filler words like "going to", "doing some", "a bit of", "heading to". Examples: "going to the gym" → "gym", "doing some reading" → "reading", "heading to the office" → "office", "morning run" → "morning run", "team meeting" → "team meeting"`;

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

  // Parse body
  const { audio } = req.body ?? {};
  if (!audio || typeof audio !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'audio' field (expected base64 string)" });
  }

  // Decode audio
  let audioBuffer;
  try {
    audioBuffer = Buffer.from(audio, "base64");
  } catch {
    return res.status(400).json({ error: "Failed to decode base64 audio" });
  }

  // Whisper transcription
  let transcript;
  try {
    // toFile is the SDK-recommended way to pass a buffer — works on Node 18 + 20
    const audioFile = await toFile(audioBuffer, "audio.m4a", { type: "audio/m4a" });
    const whisperRes = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: audioFile,
    });
    transcript = whisperRes.text;
  } catch (err) {
    console.error("Whisper error:", err);
    return res.status(502).json({ error: "Transcription failed. Please try again.", detail: err.message });
  }

  // GPT-4o-mini block parsing
  let blocks;
  try {
    const chatRes = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: transcript },
      ],
      temperature: 0,
    });
    const parsed = JSON.parse(chatRes.choices[0].message.content);
    blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
  } catch (err) {
    console.error("GPT parse error:", err);
    return res.status(502).json({ error: "Parsing failed. Please try again.", detail: err.message });
  }

  // Structured log — readable by `vercel logs` for prompt tuning
  console.log(JSON.stringify({
    type: "voice_parse",
    ts:   new Date().toISOString(),
    transcript,
    blocks
  }));

  return res.status(200).json({ transcript, blocks });
}
