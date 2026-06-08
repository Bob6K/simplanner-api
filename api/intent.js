import OpenAI, { toFile } from "openai";

// Lazy-init so a missing OPENAI_API_KEY env var doesn't crash module load
// (which would surface as Vercel FUNCTION_INVOCATION_FAILED 500 on every
// request — including GETs that should return 405 — making it impossible
// to tell from the outside whether the function code is even broken).
let _openai;
function getOpenAI() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set in this environment.");
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

/**
 * /api/intent — universal intent parser for Simplanner's Action Button.
 *
 * Accepts EITHER:
 *   { text: "..." }                            // typed input
 *   { audio: "<base64>" , source: "voice" }    // voice — Whisper first
 *
 * Returns:
 *   {
 *     tool:          "addBlock" | "createGong" | "startTimer",
 *     args:          { ...tool-specific... },
 *     summary:       "Human one-liner",
 *     confidence:    "high" | "medium" | "low",
 *     rawTranscript: "...the literal text we parsed..."
 *   }
 *
 * Model: process.env.INTENT_MODEL (default "gpt-4o"). Switchable per env
 * so we can A/B different providers later without app updates.
 */

const SYSTEM_PROMPT = `You are Simplanner's action parser. The user spoke or typed a command and you must convert it into ONE structured action call by invoking exactly one tool.

ALWAYS invoke a tool. Never reply in prose. If the user's intent maps to multiple actions, pick the single most likely one and set confidence to "medium". If you genuinely cannot tell, still pick the closest tool and set confidence to "low".

# Tools

## addBlock
Use when the user wants to add a planner block (a scheduled activity in a day plan).
Examples:
  "Add a 30 minute reading block tomorrow morning"     → addBlock(reading, tomorrow, morning, 30)
  "30 min gym this evening"                            → addBlock(gym, today, evening, 30)
  "I want to meditate for 15 minutes after work"       → addBlock(meditate, today, evening, 15)
  "Block out an hour of deep work tomorrow afternoon"  → addBlock(deep work, tomorrow, midday, 60)

## createGong
Use when the user wants to schedule a recurring bell/notification at a specific time of day.
Examples:
  "Bell at 9am every weekday"             → createGong(9, 0, weekdays, "Bell")
  "Remind me at noon on weekends"         → createGong(12, 0, [saturday,sunday], "Lunch")
  "Gong every day at 6:30 in the evening" → createGong(18, 30, [], "Gong")
  "Wake me up at 7"                       → createGong(7, 0, [], "Wake up")

NAMING RULE for createGong:
- This app has no "reminders" concept — it has gongs/bells. NEVER name a gong "Reminder".
- If the user says "remind me at X", infer a short topical name from what they're being reminded about. If you can't tell, default to "Gong" (or "Bell" if the user mentioned "bell").
- Examples of good names: "Stand up", "Lunch", "Water", "Walk", "Standup", "Stretch", "Bell", "Gong".

## startTimer
Use when the user wants to start a meditation/focus timer RIGHT NOW.
Examples:
  "Start a 10 minute timer"                                    → startTimer(600)
  "20 minute meditation with chimes every 5 minutes"           → startTimer(1200, intervalSeconds=300)
  "Begin a 15 min timer, give me a 10 second countdown first"  → startTimer(900, prepSeconds=10)
  "5 minute breathing exercise"                                → startTimer(300)

# Smart inference rules

DAY (for addBlock):
- "today" / "this morning" / "tonight" / "later" → "today"
- "tomorrow" → "tomorrow"
- "monday" / "next monday" → "monday"
- if day not mentioned at all → "today"

TIME PART (for addBlock):
- "morning" / "early" / "before noon" / "breakfast" → "morning"
- "afternoon" / "lunch" / "midday" / "noon" → "midday"
- "evening" / "after work" / "after dinner" / "tonight" (early) → "evening"
- "night" / "late" / "before bed" → "night"
- not mentioned → "morning"

DURATION (for addBlock):
- "an hour" / "1 hour" → 60
- "half hour" / "30 min" → 30
- "quick" / "briefly" → 15
- "2 hours" → 120
- not mentioned → 30 (sensible default for a planner block)

GONG TIME parsing (for createGong):
- "9am" → hour=9 minute=0
- "9:30" / "half past 9" / "9:30am" → hour=9 minute=30
- "noon" / "midday" → hour=12 minute=0
- "midnight" → hour=0 minute=0
- 24h preferred — interpret "9pm" as 21

GONG WEEKDAYS (for createGong):
- "every day" / "daily" / not mentioned → empty array []
- "weekdays" / "work days" → ["monday","tuesday","wednesday","thursday","friday"]
- "weekends" → ["saturday","sunday"]
- specific days → use those weekday names lowercased

TIMER duration (for startTimer):
- "5 min" → 300
- "10 minutes" → 600
- "half an hour" → 1800
- "30 seconds" → 30

# Recurring requests
If the user says "every day" / "every evening" / "every Tuesday" / "always X" for an addBlock:
- v1 has no recurring-block tool. Pick the closest single-day instance (today / tomorrow / next match).
- Set confidence: "low" so the iOS app routes the parse into an editable form.
- The summary MUST hint at the limitation, e.g. "Just adds today — recurring not supported yet".

# Always include
Every tool call MUST include:
- summary: a human-readable single-line description shown to the user before execution (e.g. "Add 30 min reading — tomorrow morning")
- confidence: "high" if the parse is unambiguous, "medium" if there's some inference, "low" if you're guessing or recurrence isn't supported

Strip filler words from activity names: "going to the gym" → "gym", "doing some reading" → "reading".`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "addBlock",
      description: "Add a planner block (scheduled activity) to a day plan.",
      parameters: {
        type: "object",
        properties: {
          activity:        { type: "string", description: "Core activity name, filler words stripped. e.g. 'gym', 'reading'." },
          day:             { type: "string", enum: ["today","tomorrow","monday","tuesday","wednesday","thursday","friday","saturday","sunday"] },
          timePart:        { type: "string", enum: ["morning","midday","evening","night"] },
          durationMinutes: { type: "integer", minimum: 1, maximum: 480 },
          routineName:     { type: "string", description: "Optional — if the user named a routine like 'Morning Ritual'." },
          summary:         { type: "string" },
          confidence:      { type: "string", enum: ["high","medium","low"] },
        },
        required: ["activity","day","timePart","durationMinutes","summary","confidence"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "createGong",
      description: "Schedule a recurring gong (bell/notification) at a specific time of day.",
      parameters: {
        type: "object",
        properties: {
          hour:      { type: "integer", minimum: 0, maximum: 23 },
          minute:    { type: "integer", minimum: 0, maximum: 59 },
          weekdays:  {
            type: "array",
            items: { type: "string", enum: ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] },
            description: "Empty array = every day. Otherwise list of weekdays.",
          },
          name:      { type: "string", description: "Short label like 'Bell', 'Morning gong', 'Stand up'." },
          soundId:   { type: "string", enum: ["synth_bell","synth_bowl","synth_ping"], description: "Optional — only set if user explicitly named the sound." },
          pingCount: { type: "integer", minimum: 1, maximum: 3, description: "Optional — number of strikes; default 1." },
          summary:   { type: "string" },
          confidence:{ type: "string", enum: ["high","medium","low"] },
        },
        required: ["hour","minute","weekdays","name","summary","confidence"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "startTimer",
      description: "Start a meditation/focus timer right now.",
      parameters: {
        type: "object",
        properties: {
          durationSeconds: { type: "integer", minimum: 5, maximum: 14400 },
          intervalSeconds: { type: "integer", minimum: 0, description: "0 = no interval chimes." },
          prepSeconds:     { type: "integer", minimum: 0, maximum: 60, description: "Lead-in countdown before the timer starts. 0 = no prep." },
          soundId:         { type: "string", enum: ["synth_bell","synth_bowl","synth_ping"] },
          endSoundId:      { type: "string", enum: ["synth_bell","synth_bowl","synth_ping"] },
          summary:         { type: "string" },
          confidence:      { type: "string", enum: ["high","medium","low"] },
        },
        required: ["durationSeconds","summary","confidence"],
        additionalProperties: false,
      },
    },
  },
];

const MODEL = process.env.INTENT_MODEL || "gpt-4o";

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

  const body = req.body ?? {};
  const { audio, text, source, app, context } = body;

  // Resolve the user's input into a transcript.
  let transcript;
  if (typeof text === "string" && text.trim().length > 0) {
    transcript = text.trim();
  } else if (typeof audio === "string" && audio.length > 0) {
    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audio, "base64");
    } catch {
      return res.status(400).json({ error: "Failed to decode base64 audio" });
    }
    try {
      const audioFile = await toFile(audioBuffer, "audio.m4a", { type: "audio/m4a" });
      const whisperRes = await getOpenAI().audio.transcriptions.create({
        model: "whisper-1",
        file: audioFile,
      });
      transcript = whisperRes.text;
    } catch (err) {
      console.error("Whisper error:", err);
      return res.status(502).json({ error: "Transcription failed. Please try again.", detail: err.message });
    }
  } else {
    return res.status(400).json({ error: "Provide either 'text' (string) or 'audio' (base64 string)." });
  }

  // Add a tiny context preamble so the model can use it when relevant
  // (we leave context narrow for v1 — just current tab + timezone).
  const contextHint =
    context && typeof context === "object"
      ? `\n\nContext: ${JSON.stringify(context)}`
      : "";

  // Tool-calling completion
  let tool, args, summary, confidence;
  try {
    const chatRes = await getOpenAI().chat.completions.create({
      model: MODEL,
      tools: TOOLS,
      tool_choice: "required",
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT + contextHint },
        { role: "user",   content: transcript },
      ],
    });

    const choice = chatRes.choices?.[0];
    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall) {
      return res.status(502).json({ error: "Model did not produce a tool call.", transcript });
    }
    tool = toolCall.function.name;
    const parsed = JSON.parse(toolCall.function.arguments);
    summary    = parsed.summary;
    confidence = parsed.confidence;
    args = { ...parsed };
    delete args.summary;
    delete args.confidence;
  } catch (err) {
    console.error("Intent parse error:", err);
    return res.status(502).json({ error: "Parsing failed. Please try again.", detail: err.message });
  }

  // Structured log — readable by Vercel logs for prompt tuning
  console.log(JSON.stringify({
    type: "intent_parse",
    ts:   new Date().toISOString(),
    source: source ?? (text ? "text" : "voice"),
    app: app ?? "simplanner",
    model: MODEL,
    transcript,
    tool,
    args,
    confidence,
    summary,
  }));

  return res.status(200).json({
    tool,
    args,
    summary,
    confidence,
    rawTranscript: transcript,
  });
}
