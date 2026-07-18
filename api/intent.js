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
 *     tool:          "addBlock" | "addBlocksForDays" | "deleteBlock" | "markBlockDone" | "moveBlock" | "changeBlockDuration" | "createGong" | "startTimer" | "copyDay" | "loadSchedule" | "saveWeekAsSchedule" | "updateBaseSchedule" | "querySchedule" | "notSupported",
 *     args:          { ...tool-specific... },
 *     summary:       "Human one-liner",
 *     confidence:    "high" | "medium" | "low",
 *     rawTranscript: "...the literal text we parsed..."
 *   }
 *
 * Model: process.env.INTENT_MODEL (default "gpt-4o"). Switchable per env
 * so we can A/B different providers later without app updates.
 */

const SYSTEM_PROMPT = `You are Simplanner's action parser. The user spoke or typed a command and you must convert it into one or more structured action calls by invoking the matching tool(s). Invoke ONE tool call per distinct action — most commands are a single action, so a single tool call; split into multiple calls only when the user clearly asks for several DIFFERENT actions.

ALWAYS invoke at least one tool. Never reply in prose. If the request is something the app cannot do by voice/text, invoke notSupported with an honest reason (see below) — NEVER force the nearest wrong tool. Only when the request is clearly one of the supported actions but ambiguous, pick the closest tool and set confidence to "low".

# Multiple actions in one command
Two actions are DISTINCT only when they differ in VERB (add / addBlocksForDays / delete / move / mark done / change duration / gong / timer) OR in ACTIVITY. Differing only in DAY or TIME for the same activity+verb is NOT distinct — keep it ONE call.
Invoke ONE tool call per distinct action. Most commands are a single action. Emit several calls only for genuinely different actions, in the order the user said them. At most 6 calls.

Split (different verb or activity):
  "Add reading tomorrow morning and gym Friday evening"                 -> addBlock(reading, ...) + addBlock(gym, ...)
  "Add 20 min meditation today, delete the dentist block, 10 min timer" -> addBlock + deleteBlock + startTimer
  "Move my gym to Friday and make my reading 1 hour"                    -> moveBlock(gym, ...) + changeBlockDuration(reading, 60)
  "Delete my walk, my reading, and my gym tomorrow"                     -> deleteBlock(walk) + deleteBlock(reading) + deleteBlock(gym)

Do NOT split (one action, even though it contains "and"):
  "Walk every weekday morning"                                          -> addBlocksForDays(walk, [mon..fri], morning)  — same activity across days is ONE call; never per-day addBlock.
  "Reading on Monday and Friday evenings"                               -> addBlocksForDays(reading, [monday,friday], evening)  — "and" joining weekdays of ONE activity stays ONE call.
  "Start a 20 min timer with chimes every 5 min and a 10 second countdown" -> startTimer(1200, intervalSeconds=300, prepSeconds=10)  — "and" joins timer PARAMETERS, not actions.

"and" splits ONLY when it joins two independent verbs/activities. It does NOT split when it joins parameters or qualifiers of one action (a timer's interval/countdown, a gong's time/sound, a block's details), and it does NOT split when it lists multiple weekdays of the SAME activity (that is one addBlocksForDays). When unsure whether "and" starts a new action or just adds detail, keep ONE call.
Same activity on multiple days: if the days are named weekdays -> ONE addBlocksForDays (even when listed with "and"). Use multiple addBlock calls for the same activity only when a day cannot be a weekday (e.g. "today"/"tomorrow") or the duration/timePart differs per day.
Each tool call is independent and carries its OWN summary, confidence, assumptions and clarificationsNeeded. When unsure whether something is one action or two, prefer FEWER calls.

# Tools

## addBlock
Use when the user wants to add a planner block (a scheduled activity in a day plan) for ONE specific day.
Examples:
  "Add a 30 minute reading block tomorrow morning"     → addBlock(reading, tomorrow, morning, 30)
  "30 min gym this evening"                            → addBlock(gym, today, evening, 30)
  "I want to meditate for 15 minutes after work"       → addBlock(meditate, today, evening, 15)
  "Block out an hour of deep work tomorrow afternoon"  → addBlock(deep work, tomorrow, midday, 60)

## addBlocksForDays
Use when the user wants the SAME block on a FIXED SET of weekdays — e.g. "every weekday", "on Mon/Wed/Fri", "weekends", a listed group of days. Each weekday in the array produces one block on the next occurrence of that day.
Examples:
  "Add a 30 min walk every weekday morning"              → addBlocksForDays(walk, [monday,tuesday,wednesday,thursday,friday], morning, 30)
  "Reading on Mon Wed Fri evenings"                      → addBlocksForDays(reading, [monday,wednesday,friday], evening, 30)
  "Gym on weekends, an hour each"                        → addBlocksForDays(gym, [saturday,sunday], midday, 60)
  "15 min meditation Tuesday and Thursday morning"       → addBlocksForDays(meditation, [tuesday,thursday], morning, 15)
  "Take my vitamins every morning"                       → addBlocksForDays(vitamins, [monday..sunday], morning, 5)  — meds/supplements are tiny habits: default 5 min when no duration is given.

## deleteBlock
Use when the user wants to REMOVE an existing planner block — e.g. "delete", "remove", "cancel", "drop", "scratch", or "clear". The synonym set "delete / remove / cancel / drop / scratch / clear" all map to this tool. Pass a short fuzzy hint of what the user named (filler words stripped) so iOS can match it against existing blocks.
Examples:
  "Delete football training tomorrow"   → deleteBlock(activityHint="football training", day=tomorrow)
  "Remove my reading block today"       → deleteBlock(activityHint="reading", day=today)
  "Cancel the gym on Friday"            → deleteBlock(activityHint="gym", day=friday)
  "Drop tomorrow's morning walk"        → deleteBlock(activityHint="walk", day=tomorrow, timePart=morning)

DAY (for deleteBlock): same convention as addBlock — if day is omitted, default to "today".
TIME PART (for deleteBlock): only include the timePart field if the user explicitly named a part of day ("morning walk", "evening run"). If the user did NOT name one, OMIT it entirely (do not infer a default — iOS uses the absence to keep the search broad across the day).

ASSUMPTIONS for deleteBlock — CRITICAL: any field you defaulted rather than took from the user's words MUST appear in the assumptions array. iOS uses this signal to widen the search (look in other days when day was assumed, or other timeParts when timePart was assumed).
  "Delete walk"                  → day=today,    timePart omitted,  assumptions: ["day"]
  "Delete walk today"            → day=today,    timePart omitted,  assumptions: []
  "Delete my walk this morning"  → day=today,    timePart=morning,  assumptions: ["day"]
  "Delete walk on Friday"        → day=friday,   timePart omitted,  assumptions: []
  "Delete my morning walk"       → day=today,    timePart=morning,  assumptions: ["day"]
  "Delete Friday's evening walk" → day=friday,   timePart=evening,  assumptions: []

## markBlockDone
Use when the user wants to MARK an existing planner block as completed / done / finished — e.g. "done", "finished", "completed", "tick off", "mark as done", "complete", "check off". The synonym set "done / finished / completed / tick off / mark as done / complete / check off" all map to this tool. Pass a short fuzzy hint of what the user named (filler words stripped) so iOS can match it against existing blocks.
Examples:
  "Done with walking"                    → markBlockDone(activityHint="walking", day=today)
  "Mark reading as done"                 → markBlockDone(activityHint="reading", day=today)
  "Finished my morning gym"              → markBlockDone(activityHint="gym", day=today, timePart=morning)
  "Tick off tomorrow's meditation"       → markBlockDone(activityHint="meditation", day=tomorrow)
  "Complete the walk on Friday"          → markBlockDone(activityHint="walk", day=friday)

DAY (for markBlockDone): same convention as deleteBlock — if day is omitted, default to "today".
TIME PART (for markBlockDone): only include the timePart field if the user explicitly named a part of day ("morning gym", "evening walk"). If the user did NOT name one, OMIT it entirely (do not infer a default — iOS uses the absence to keep the search broad across the day).

## moveBlock
Use when the user wants to MOVE/RESCHEDULE an existing planner block to a different day, a different time of day, or both — e.g. "move", "reschedule", "shift", "push", "change to", "send to". The synonym set "move / reschedule / shift / push / change to / send to" all map to this tool. Pass a short fuzzy hint of what the user named so iOS can match it against existing blocks.
Examples:
  "Move my reading to evening"                  → moveBlock(activityHint="reading", day=today, newTimePart=evening)
  "Move tomorrow's gym to Friday"               → moveBlock(activityHint="gym", day=tomorrow, newDay=friday)
  "Move walk to Friday morning"                 → moveBlock(activityHint="walk", day=today, newDay=friday, newTimePart=morning)
  "Shift my afternoon reading to night"         → moveBlock(activityHint="reading", day=today, timePart=midday, newTimePart=night)
  "Reschedule football training to Saturday"    → moveBlock(activityHint="football training", day=today, newDay=saturday)
  "Push tomorrow's morning walk to the evening" → moveBlock(activityHint="walk", day=tomorrow, timePart=morning, newTimePart=evening)

DAY (for moveBlock): the CURRENT day where the block lives — same convention as deleteBlock/markBlockDone. If the user did not name a current day, default to "today".
TIME PART (for moveBlock): the CURRENT timePart, used ONLY for narrowing the source block. Include it only if the user explicitly named a current part of day (e.g. "my afternoon reading", "the morning walk"). Omit otherwise so iOS searches the whole day.
NEW DAY (for moveBlock): the destination day. Omit entirely if the user is NOT changing the day (e.g. "move to evening" — keep the same day).
NEW TIME PART (for moveBlock): the destination timePart. Omit entirely if the user is NOT changing the timePart (e.g. "move to Friday" with no time mentioned).
RULE: AT LEAST ONE of newDay / newTimePart MUST be present. If the user's command implies neither (impossible no-op), pick the most likely target — if they said "move", they almost certainly meant SOMETHING; ask via clarificationsNeeded.

ASSUMPTIONS for moveBlock: include "newDay" or "newTimePart" in assumptions[] only if you had to GUESS the destination (e.g. they said "move to later" → you inferred newTimePart=evening). Do NOT add "day" or "timePart" to assumptions when they're stated or correctly defaulted.

## changeBlockDuration
Use when the user wants to CHANGE THE LENGTH / DURATION of an existing planner block — e.g. "make", "change", "set", "cut", "shorten", "extend", "lengthen", "shrink". The synonym set "make / change / set / cut / shorten / extend / lengthen / shrink" all map to this tool when applied to a block's duration. Pass a short fuzzy hint of what the user named so iOS can match it against existing blocks.
Examples:
  "Make reading 1 hour"                       → changeBlockDuration(activityHint="reading", day=today, durationMinutes=60)
  "Cut my gym to 20 min"                      → changeBlockDuration(activityHint="gym", day=today, durationMinutes=20)
  "Change tomorrow's walk to 45 minutes"      → changeBlockDuration(activityHint="walk", day=tomorrow, durationMinutes=45)
  "Set my morning meditation to 15 min"       → changeBlockDuration(activityHint="meditation", day=today, timePart=morning, durationMinutes=15)
  "Shorten the deep work block to half hour"  → changeBlockDuration(activityHint="deep work", day=today, durationMinutes=30)
  "Extend reading by 30 minutes"              → changeBlockDuration(activityHint="reading", day=today, durationMinutes=60)  (BEST-GUESS FINAL TOTAL — see RELATIVE DURATION rule below)

DAY (for changeBlockDuration): same convention as deleteBlock — if day is omitted, default to "today".
TIME PART (for changeBlockDuration): only include the timePart field if the user explicitly named a part of day. Omit otherwise so iOS searches the whole day.
DURATION (for changeBlockDuration): the FINAL duration in minutes after the change. ALWAYS an absolute integer in the range 1..480 — never a delta. Phrases like "by 30 min" / "+15 min" / "another half hour" describe a DELTA the user wants applied; you must convert that to your best estimate of the final total without knowing the current duration. When you do this, ADD "durationMinutes" to assumptions[] AND add it to clarificationsNeeded so the user can correct it on the confirm sheet. State the absolute final total in the summary so the user can verify, e.g. "Set reading to 60 min" (NOT "Extended by 30 min").

ASSUMPTIONS for changeBlockDuration: add "durationMinutes" to assumptions[] only when the user gave a RELATIVE duration ("by 30 min", "extend a bit") and you had to guess the final total. If the user stated an absolute value ("make it an hour", "30 minutes"), do NOT add it.

## createGong
Use when the user wants to schedule a recurring bell/notification at a specific time of day.
Examples:
  "Bell at 9am every weekday"             → createGong(9, 0, weekdays, "Bell")
  "Remind me at noon on weekends"         → createGong(12, 0, [saturday,sunday], "Lunch")
  "Gong every day at 6:30 in the evening" → createGong(18, 30, [], "Gong")
  "Wake me up at 7"                       → createGong(7, 0, [], "Wake up")
  "Meds bell at 9 every day"              → createGong(9, 0, [], "Medication")  — clock-time medication/supplement nudges are gongs with a topical name, never "Reminder".

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
Fixed-set multi-day patterns — "every weekday", "on Mon/Wed/Fri", "weekends", "Tuesday and Thursday", any explicit list of weekdays — route to addBlocksForDays. Set confidence "high" if the day set is unambiguous, "medium" if you had to interpret which days are meant.

"Every day" / "daily" / "each day" / "always" → addBlocksForDays with ALL SEVEN days [monday,tuesday,wednesday,thursday,friday,saturday,sunday]. This puts the activity on every day of the current week. Confidence "high".
  "Add 15 min meditation daily in the evening"  → addBlocksForDays(meditation, [monday,tuesday,wednesday,thursday,friday,saturday,sunday], evening, 15)
  "Always read for an hour at night"            → addBlocksForDays(reading, [monday,tuesday,wednesday,thursday,friday,saturday,sunday], night, 60)

v1 schedules the CURRENT WEEK only — there is no infinite "forever" recurrence. Do not refuse or warn for "daily"/"every day"; just schedule this week's seven days as above. Only when the user explicitly stresses forever/never-ending ("from now on", "every week forever") add a short honest note in the summary, e.g. "Add 15 min meditation every day this week".

Heuristic: name specific days or a finite group ("every weekday", "weekends", "Mon Wed Fri") → addBlocksForDays for those days. "Every day"/"daily"/"always" → addBlocksForDays for all seven. A single recurring weekday ("every Tuesday") → addBlocksForDays([tuesday]).

# Timer prep countdown default
For startTimer: if the user does NOT mention a countdown / prep / lead-in, default prepSeconds to 5 (a short lead-in helps the user put the phone down). Add "prepSeconds" to assumptions.
If the user says "no countdown" / "start immediately" / "right away" → prepSeconds: 0 (and DO NOT add to assumptions).
If the user specifies a value → use it (and DO NOT add to assumptions).

# App concepts (management verbs)
BLOCK = one planned activity on one day. ROUTINE (user may say "ritual") = a reusable bundle of activities; adding a named routine to a day is addBlock with routineName — NOT a management verb. SCHEDULE (user may say "template", "week plan") = a saved WEEK layout of blocks; loading stamps it onto the week and never deletes anything. BASE SCHEDULE (user may say "base", "default week", "normal week", "standard week") = the one special schedule mirroring the user's normal week; updating it REPLACES its previous contents from the current week.

## copyDay
Use when the user wants one day's blocks duplicated onto other day(s) — "copy", "duplicate", "same as".
  "Copy today to tomorrow"              → copyDay(sourceDay: "today", targetDays: ["tomorrow"])
  "Copy Monday to Thursday and Friday"  → copyDay("monday", ["thursday","friday"])
  "Make the weekend look like today"    → copyDay("today", ["saturday","sunday"])
sourceDay defaults to "today" when unstated — then ADD "sourceDay" to assumptions. Blocks already on a target day are never duplicated (the app dedups); no need to warn about it.

## loadSchedule
Use when the user wants a SAVED schedule applied to the week — "load", "apply", "put on".
  "Load my work week schedule"  → loadSchedule(nameHint: "work week")
  "Apply my base schedule"      → loadSchedule(nameHint: "Base Schedule")
When they say base/default/normal/standard week, use nameHint "Base Schedule". iOS fuzzy-matches nameHint against the user's saved schedules and lets them pick on the confirm card.

## saveWeekAsSchedule
Use when the user wants the CURRENT week saved as a reusable schedule — "save this week as…", "store as template".
  "Save this week as my study plan"  → saveWeekAsSchedule(name: "Study Plan")
When no name is given, propose a short sensible one and add "name" to assumptions AND clarificationsNeeded.

## updateBaseSchedule
Use ONLY when the user explicitly wants their base/default/normal week saved/updated FROM the current week — "update my base schedule", "make this my default week".
  "Make this my normal week"  → updateBaseSchedule()
This REPLACES the base schedule's previous contents — the summary MUST say so, e.g. "Replace your Base Schedule with this week's blocks".

# Questions about the schedule (read-only)
The user might ASK about their schedule instead of asking to change it. Do not confuse a question with a command: "what's on today" is a question (→ querySchedule); "add gym today" is a command (→ addBlock). A question phrased politely that still requests a CHANGE ("can you move my gym to Friday", "could you free up my evening") is a COMMAND — route it to the matching action tool (moveBlock, deleteBlock, ...), never querySchedule.

## querySchedule
Use when the user asks a QUESTION about their existing schedule — "what's on today", "what do I have Thursday", "when do I next have gym", "am I free Thursday evening". CRITICAL: this tool answers NOTHING itself. It performs no lookup and returns no schedule data — the server has no access to the user's blocks. It only classifies the question into a structured query; iOS resolves that query locally against its own on-device store and composes the real answer, so the schedule's actual contents never leave the device.
Examples:
  "What's on my schedule today"        → querySchedule(scope="today")
  "What do I have going on today"      → querySchedule(scope="today")
  "What do I have on Thursday"         → querySchedule(scope="day", day="thursday")
  "What's on tomorrow"                 → querySchedule(scope="day", day="tomorrow")
  "When do I next have gym"            → querySchedule(scope="nextOccurrence", activityName="gym")
  "When's my next reading block"       → querySchedule(scope="nextOccurrence", activityName="reading")
  "Am I free Thursday evening"         → querySchedule(scope="freeSlot", day="thursday", timePart="evening")
  "Do I have any free time tomorrow"   → querySchedule(scope="freeSlot", day="tomorrow")

SCOPE selection:
- "today" — asking generally what's scheduled today; no other day named.
- "day" — asking what's on a SPECIFIC named day other than an unqualified "today" (a weekday name, "tomorrow", or a calendar date like "the 24th" → resolve to an ISO date when unambiguous).
- "nextOccurrence" — asking WHEN an activity next happens. Requires activityName.
- "freeSlot" — asking whether a stretch of time is open/available. Requires day; timePart is optional (omit for a whole-day free check).
DAY field: a weekday name (monday..sunday), "today"/"tomorrow", or an ISO date (YYYY-MM-DD) — NOT the closed enum used by other tools, since users may name a specific calendar date. Omit for scope "today".
Confidence "high" when scope + fields are unambiguous, "medium" when you had to infer the day or activity, "low" when genuinely guessing.

## notSupported
Use when the user asks for something the assistant cannot do, INSTEAD of forcing another tool. Known unsupported: creating a routine from existing blocks ("save these as a routine" → ⋯ menu → Save as Routine), editing/renaming/deleting routines, schedules, activities or categories (→ Settings), changing settings/theme/planner mode, forever-recurrence beyond the current week, and any QUESTION the querySchedule schema cannot express — analytics/stats/history questions like "how productive was I in March", "what's my longest streak", "how many workouts did I do last month" — these stay notSupported with an honest reason; do not force querySchedule onto a question it can't structurally represent.
  "Save these three blocks as a routine" → notSupported(requested: "save blocks as a routine", reason: "Creating a routine from existing blocks needs picking blocks by hand.", redirect: "Planner ⋯ menu → Save as Routine")
  "How productive was I in March"        → notSupported(requested: "productivity analysis for March", reason: "Voice/text can't analyze past history yet — only today's and upcoming schedule.", redirect: "Progress tab")
Keep reason + redirect to one short sentence each, honest and specific. confidence "high" when the request is clearly unsupported.

# Context hint (replanning conversations)
If the Context appended below includes a "hint" field (e.g. "replan: mornings lapsed for Meditation"), the utterance is part of a replanning conversation ABOUT the named activity/timePart in that hint — prefer moveBlock, changeBlockDuration, or deleteBlock over addBlock, and resolve vague phrasing like "mornings aren't working" or "let's try evenings instead" as a move/adjust/delete action on that activity rather than creating a new block. Still use querySchedule if the utterance is a genuine question rather than a decision, and notSupported/addBlock etc. when the utterance clearly isn't about the hinted activity.

# Always include
Every tool call MUST include:
- summary: a human-readable single-line description shown to the user before execution (e.g. "Add 30 min reading — tomorrow morning")
- confidence: "high" if the parse is unambiguous, "medium" if there's some inference, "low" if you're guessing or recurrence isn't supported
- assumptions: array of arg names you INFERRED rather than took from the user's words. Examples:
    "Gym this evening" → assumptions: ["durationMinutes"]  (no duration was said)
    "Add reading" → assumptions: ["day", "timePart", "durationMinutes"]
    "Add 30 minute reading block tomorrow morning" → assumptions: []  (everything stated)
  Only include arg names you actually inferred. NEVER include "activity", "name", "rawTranscript", "summary", "confidence", "assumptions", "clarificationsNeeded".
- clarificationsNeeded: subset of assumptions where YOU specifically want the user to confirm before committing.
  Use sparingly. Include only when the inference is risky (e.g. the user was vague about WHEN or HOW LONG).
  Examples:
    "Remind me about the dentist later" → clarificationsNeeded: ["timePart", "durationMinutes"]
    "Gym this evening" → clarificationsNeeded: []  (duration was assumed but 30 min is a fine default)

When you emit MULTIPLE tool calls, compute summary / confidence / assumptions / clarificationsNeeded SEPARATELY for each call, from only that call's own arguments — never write a combined summary on the first call and leave the others sparse.

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
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["activity","day","timePart","durationMinutes","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "addBlocksForDays",
      description: "Add the same planner block on a fixed set of weekdays. Each weekday in 'days' produces one block on the next occurrence of that day.",
      parameters: {
        type: "object",
        properties: {
          activity:        { type: "string", description: "Core activity name, filler words stripped. e.g. 'gym', 'reading'." },
          days: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] },
            description: "Set of weekdays the block applies to. Must contain at least one weekday.",
          },
          timePart:        { type: "string", enum: ["morning","midday","evening","night"] },
          durationMinutes: { type: "integer", minimum: 1, maximum: 480 },
          routineName:     { type: "string", description: "Optional — if the user named a routine like 'Morning Ritual'." },
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["activity","days","timePart","durationMinutes","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deleteBlock",
      description: "Delete an existing planner block. iOS fuzzy-matches activityHint against block activity names for the resolved day.",
      parameters: {
        type: "object",
        properties: {
          activityHint:    { type: "string", description: "What the user named — for fuzzy matching against existing blocks. e.g. 'football', 'football training', 'reading'. Strip filler words." },
          day:             { type: "string", enum: ["today","tomorrow","monday","tuesday","wednesday","thursday","friday","saturday","sunday"] },
          timePart:        { type: "string", enum: ["morning","midday","evening","night"], description: "Optional — only include if the user explicitly named a part of day. Omit otherwise so iOS searches the whole day." },
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["activityHint","day","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "markBlockDone",
      description: "Mark an existing planner block as completed/done. iOS fuzzy-matches activityHint against block activity names for the resolved day.",
      parameters: {
        type: "object",
        properties: {
          activityHint:    { type: "string", description: "What the user named — for fuzzy matching against existing blocks. e.g. 'walking', 'gym', 'reading'. Strip filler words." },
          day:             { type: "string", enum: ["today","tomorrow","monday","tuesday","wednesday","thursday","friday","saturday","sunday"] },
          timePart:        { type: "string", enum: ["morning","midday","evening","night"], description: "Optional — only include if the user explicitly named a part of day. Omit otherwise so iOS searches the whole day." },
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["activityHint","day","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "moveBlock",
      description: "Move an existing planner block to a different day, a different timePart, or both. iOS fuzzy-matches activityHint against block names on the current day. At least one of newDay / newTimePart MUST be supplied.",
      parameters: {
        type: "object",
        properties: {
          activityHint: { type: "string", description: "What the user named — for fuzzy matching against existing blocks. e.g. 'reading', 'gym'. Strip filler words." },
          day:          { type: "string", enum: ["today","tomorrow","monday","tuesday","wednesday","thursday","friday","saturday","sunday"], description: "The CURRENT day where the block lives. Default 'today' if not stated." },
          timePart:     { type: "string", enum: ["morning","midday","evening","night"], description: "Optional — the CURRENT timePart of the block, for narrowing the source. Omit unless the user explicitly named a current part of day." },
          newDay:       { type: "string", enum: ["today","tomorrow","monday","tuesday","wednesday","thursday","friday","saturday","sunday"], description: "Destination day. Omit if the user is not changing the day." },
          newTimePart:  { type: "string", enum: ["morning","midday","evening","night"], description: "Destination timePart. Omit if the user is not changing the timePart." },
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["activityHint","day","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "changeBlockDuration",
      description: "Change the duration of an existing planner block. iOS fuzzy-matches activityHint against block names on the resolved day. durationMinutes is the FINAL absolute duration (1..480).",
      parameters: {
        type: "object",
        properties: {
          activityHint:    { type: "string", description: "What the user named — for fuzzy matching against existing blocks. Strip filler words." },
          day:             { type: "string", enum: ["today","tomorrow","monday","tuesday","wednesday","thursday","friday","saturday","sunday"], description: "Day where the block lives. Default 'today' if not stated." },
          timePart:        { type: "string", enum: ["morning","midday","evening","night"], description: "Optional — only include if the user explicitly named a part of day, for narrowing the source. Omit otherwise so iOS searches the whole day." },
          durationMinutes: { type: "integer", minimum: 1, maximum: 480, description: "The FINAL absolute duration after the change. Never a delta. For relative requests ('by 30 min'), supply your best-guess final total and add 'durationMinutes' to assumptions[] + clarificationsNeeded." },
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["activityHint","day","durationMinutes","summary","confidence","assumptions","clarificationsNeeded"],
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
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" } },
          clarificationsNeeded:  { type: "array", items: { type: "string" } },
        },
        required: ["hour","minute","weekdays","name","summary","confidence","assumptions","clarificationsNeeded"],
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
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["durationSeconds","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "copyDay",
      description: "Copy every block of one day onto one or more other days. The app skips blocks whose activity/routine already exists on a target day.",
      parameters: {
        type: "object",
        properties: {
          sourceDay:  { type: "string", enum: ["today","tomorrow","monday","tuesday","wednesday","thursday","friday","saturday","sunday"], description: "Day being copied FROM. Default 'today' when unstated (then add 'sourceDay' to assumptions)." },
          targetDays: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: ["today","tomorrow","monday","tuesday","wednesday","thursday","friday","saturday","sunday"] },
            description: "Day(s) being copied TO.",
          },
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["sourceDay","targetDays","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "loadSchedule",
      description: "Apply a SAVED schedule (week template) onto the current week. iOS fuzzy-matches nameHint against the user's saved schedules.",
      parameters: {
        type: "object",
        properties: {
          nameHint: { type: "string", description: "The schedule name as the user said it, filler words stripped — e.g. 'work week', 'Base Schedule'." },
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["nameHint","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "saveWeekAsSchedule",
      description: "Save the current week's blocks as a new reusable schedule with the given name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for the new schedule. Propose a short one if the user gave none (then add 'name' to assumptions + clarificationsNeeded)." },
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["name","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateBaseSchedule",
      description: "Create or FULLY REPLACE the user's Base Schedule from the current week's blocks. Only for explicit base/default/normal-week requests.",
      parameters: {
        type: "object",
        properties: {
          summary:               { type: "string", description: "Must state that this replaces the Base Schedule." },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "querySchedule",
      description: "Classifies a QUESTION about the user's schedule into a structured query. This tool performs NO lookup and returns NO schedule data — the server has no access to the user's blocks. iOS resolves the classification locally against its own on-device store and composes the actual answer; the user's schedule contents never leave the device.",
      parameters: {
        type: "object",
        properties: {
          scope:        { type: "string", enum: ["today","day","nextOccurrence","freeSlot"], description: "'today' = what's on today (no other day named). 'day' = what's on a specific named day (weekday/tomorrow/ISO date). 'nextOccurrence' = when an activity next happens (requires activityName). 'freeSlot' = whether a stretch of time is open (requires day)." },
          day:          { type: "string", description: "Weekday name (monday..sunday), 'today'/'tomorrow', or an ISO date (YYYY-MM-DD) if the user named a specific calendar date. Omit for scope 'today'." },
          activityName: { type: "string", description: "The activity/routine name the user asked about, filler words stripped, e.g. 'gym', 'reading'. Required for scope 'nextOccurrence'." },
          timePart:     { type: "string", enum: ["morning","midday","evening","night"], description: "Optional part of day the user named, e.g. 'Thursday evening'. Used with scope 'freeSlot' or 'day'." },
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["scope","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "notSupported",
      description: "The request is something the assistant cannot do. Return an honest explanation instead of forcing another tool. The app shows an info card; nothing executes.",
      parameters: {
        type: "object",
        properties: {
          requested: { type: "string", description: "Short restatement of what the user asked for." },
          reason:    { type: "string", description: "One honest sentence on why it isn't possible by voice/text." },
          redirect:  { type: "string", description: "Where in the app to do it instead, e.g. 'Planner ⋯ menu → Save as Routine'. Empty string if nowhere." },
          summary:               { type: "string" },
          confidence:            { type: "string", enum: ["high","medium","low"] },
          assumptions:           { type: "array", items: { type: "string" }, description: "Arg names the AI inferred rather than took from the user's words." },
          clarificationsNeeded:  { type: "array", items: { type: "string" }, description: "Subset of assumptions where the AI wants the user to review/edit before commit." },
        },
        required: ["requested","reason","redirect","summary","confidence","assumptions","clarificationsNeeded"],
        additionalProperties: false,
      },
    },
  },
];

const MODEL = process.env.INTENT_MODEL || "gpt-4o";

/**
 * Detect transcripts that aren't worth parsing — typically Whisper's output
 * when fed silence or near-silence. Saves tokens AND prevents the AI from
 * confidently parsing garbage like "you" into a "30 min you" block.
 */
const WHISPER_HALLUCINATIONS = new Set([
  "you", "thanks", "thank you", "thank you for watching",
  "thanks for watching", "uh", "um", "hmm",
  "okay", "ok", "yeah", "bye", "bye-bye",
]);
// Substring matches for YouTuber sign-offs that Whisper hallucinates on
// silence. These catch punctuation variants and trailing additions like
// "Thanks for watching, see you next time!"
const PARTIAL_HALLUCINATION_FRAGMENTS = [
  "thanks for watching", "thank you for watching", "please subscribe",
  "subscribe and like", "like and subscribe", "see you next time",
  "see you later", "thanks for tuning in", "don't forget to subscribe",
];
// Vocabulary hint passed as Whisper's `prompt`. Keywords only — NO full
// sentences. Whisper echoes coherent prompts back when fed silence/noise.
const WHISPER_BIAS_PROMPT =
  "Bell. Gong. Block. Timer. Ritual. Routine. Schedule. " +
  "Weekday. Weekend. Morning. Afternoon. Evening. Night. " +
  "Meditate. Breathe. Read. Walk. Gym. Minutes. Hours. " +
  "Snooze. Today. Tomorrow. Monday. Tuesday. Wednesday. " +
  "Thursday. Friday. Saturday. Sunday.";

function normaliseTranscript(s) {
  return (s ?? "").trim().toLowerCase().replace(/[.,!?]+\s*$/g, "").trim();
}

// Catches the case where Whisper regurgitates a chunk of our bias prompt
// itself. Real commands are short — a transcript containing a 24+ char
// substring of the bias prompt is almost certainly an echo, since no real
// utterance would coincidentally match that many sequential keywords.
function isWhisperBiasEcho(transcript) {
  const t = normaliseTranscript(transcript);
  if (t.length < 24) return false;
  const p = normaliseTranscript(WHISPER_BIAS_PROMPT);
  const WINDOW = 24;
  for (let i = 0; i + WINDOW <= p.length; i++) {
    if (t.includes(p.slice(i, i + WINDOW))) return true;
  }
  return false;
}
function isLikelyEmptyOrHallucination(transcript) {
  const t = normaliseTranscript(transcript);
  if (t.length === 0) return true;
  // Single short token, no spaces — usually a filler artefact.
  if (!t.includes(" ") && t.length <= 4) return true;
  if (WHISPER_HALLUCINATIONS.has(t)) return true;
  for (const frag of PARTIAL_HALLUCINATION_FRAGMENTS) {
    if (t.includes(frag)) return true;
  }
  // Whisper regurgitated our own bias prompt — common with silence + noise.
  if (isWhisperBiasEcho(transcript)) return true;
  // CJK / Cyrillic / Arabic content from silent audio. The app is English;
  // a transcript that is >30% non-Latin characters is almost certainly a
  // hallucinated YouTube-style prompt (e.g. Chinese "subscribe & like").
  const raw = (transcript ?? "").trim();
  const nonLatin = [...raw].filter(c =>
    /[぀-ゟ゠-ヿ一-鿿가-힯Ѐ-ӿ؀-ۿ]/.test(c)
  ).length;
  if (raw.length > 0 && nonLatin / raw.length > 0.3) return true;
  return false;
}

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
    // Early-reject obviously-tiny payloads. A valid m4a header alone is
    // ~100 bytes; anything below ~1 KB is silence or a broken recording
    // (common on the iOS Simulator when the host audio HAL fails). Saves
    // a Whisper round-trip and gives the user the friendly "didn't catch"
    // message instead of a generic backend error.
    if (audioBuffer.length < 1024) {
      console.log(JSON.stringify({
        type: "intent_parse_rejected",
        ts: new Date().toISOString(),
        reason: "audio_too_small",
        bytes: audioBuffer.length,
      }));
      return res.status(422).json({
        error: "Didn't catch that. Try speaking again or use text input.",
      });
    }
    try {
      const audioFile = await toFile(audioBuffer, "audio.m4a", { type: "audio/m4a" });
      const whisperRes = await getOpenAI().audio.transcriptions.create({
        model: "whisper-1",
        file: audioFile,
        // Bias Whisper toward English so silence doesn't hallucinate
        // Chinese subscribe prompts / Japanese filler / etc.
        language: "en",
        // Vocabulary bias only — short keyword list, NO sentences. Whisper
        // will regurgitate sentence-shaped prompts when fed silence/noise
        // (observed in v1: the entire prompt came back as transcript). A
        // bare keyword list biases toward our domain without giving Whisper
        // something coherent to parrot.
        prompt: WHISPER_BIAS_PROMPT,
      });
      transcript = whisperRes.text;
    } catch (err) {
      // Whisper returns BadRequestError (HTTP 400) when the audio is
      // malformed, too short (< 0.1 s), or otherwise undecodable. This is
      // common on simulator builds where the host audio HAL produces broken
      // m4a files. Map it to the same "didn't catch that" UX as silence so
      // iOS shows a sensible message instead of a generic 502.
      const status = err?.status ?? err?.response?.status;
      const isBadAudio = status === 400
        || /audio|file|format|decode|short/i.test(err?.message ?? "");
      console.error("Whisper error:", err);
      if (isBadAudio) {
        console.log(JSON.stringify({
          type: "intent_parse_rejected",
          ts: new Date().toISOString(),
          reason: "whisper_bad_audio",
          status,
          message: err?.message,
          bytes: audioBuffer.length,
        }));
        return res.status(422).json({
          error: "Didn't catch that. Try speaking again or use text input.",
        });
      }
      return res.status(502).json({ error: "Transcription failed. Please try again.", detail: err.message });
    }
  } else {
    return res.status(400).json({ error: "Provide either 'text' (string) or 'audio' (base64 string)." });
  }

  // Reject obvious Whisper hallucinations / silence / single-word artefacts
  // before spending tokens on the parse. Whisper often outputs filler words
  // when fed silence: "you", "thanks for watching", ".", etc.
  if (isLikelyEmptyOrHallucination(transcript)) {
    console.log(JSON.stringify({
      type: "intent_parse_rejected",
      ts: new Date().toISOString(),
      reason: "empty_or_hallucination",
      transcript,
    }));
    return res.status(422).json({
      error: "Didn't catch that. Try speaking again or use text input.",
      rawTranscript: transcript,
    });
  }

  // Add a tiny context preamble so the model can use it when relevant
  // (we leave context narrow for v1 — just current tab + timezone).
  const contextHint =
    context && typeof context === "object"
      ? `\n\nContext: ${JSON.stringify(context)}`
      : "";

  // Tool-calling completion
  const actions = [];
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
    const toolCalls = choice?.message?.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return res.status(502).json({ error: "Model did not produce a tool call.", transcript });
    }

    // Build one action per tool call. The model uses parallel tool calling to
    // emit several when the user asked for several distinct actions; keep them
    // all (capped) instead of discarding tool_calls[1..]. Each call carries its
    // own summary / confidence / assumptions / clarificationsNeeded, and we copy
    // the shared transcript onto each so every element is a complete payload.
    const MAX_ACTIONS = 6;
    if (toolCalls.length > MAX_ACTIONS) {
      console.warn(JSON.stringify({ type: "intent_actions_capped", ts: new Date().toISOString(), received: toolCalls.length, cap: MAX_ACTIONS, transcript }));
    }
    for (const tc of toolCalls.slice(0, MAX_ACTIONS)) {
      let parsed;
      try {
        parsed = JSON.parse(tc.function.arguments);
      } catch {
        console.warn(JSON.stringify({ type: "intent_toolcall_unparseable", ts: new Date().toISOString(), name: tc?.function?.name, transcript }));
        continue; // skip a malformed tool call rather than failing the whole batch
      }
      const callArgs = { ...parsed };
      delete callArgs.summary;
      delete callArgs.confidence;
      delete callArgs.assumptions;
      delete callArgs.clarificationsNeeded;
      actions.push({
        tool:                 tc.function.name,
        args:                 callArgs,
        summary:              parsed.summary,
        confidence:           parsed.confidence,
        rawTranscript:        transcript,
        assumptions:          Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
        clarificationsNeeded: Array.isArray(parsed.clarificationsNeeded) ? parsed.clarificationsNeeded : [],
      });
    }
    if (actions.length === 0) {
      return res.status(502).json({ error: "Could not parse the model's tool call.", transcript });
    }
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
    actionCount: actions.length,
    actions: actions.map((a) => ({
      tool:                 a.tool,
      args:                 a.args,
      confidence:           a.confidence,
      summary:              a.summary,
      assumptions:          a.assumptions,
      clarificationsNeeded: a.clarificationsNeeded,
    })),
  }));

  const first = actions[0];
  return res.status(200).json({
    actions,
    rawTranscript: transcript,
    // Backward-compat: pre-multiblock app builds read these flat top-level
    // fields (the first action). New builds read `actions`.
    tool:                 first.tool,
    args:                 first.args,
    summary:              first.summary,
    confidence:           first.confidence,
    assumptions:          first.assumptions,
    clarificationsNeeded: first.clarificationsNeeded,
  });
}
