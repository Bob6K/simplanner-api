#!/bin/bash
# S37 STT battery — clip generator.
#
# Synthesizes the 11 curl-battery utterances as spoken audio + a silence
# clip + a noise clip, all as AAC .m4a (the container iOS records). Clips
# land in stt-clips/ (gitignored — regenerate anytime).
#
# TTS source: macOS `say`. OpenAI TTS was considered but the local
# OPENAI_API_KEY is dead (401) and the live key is Vercel-sensitive
# (unpullable) — and `say` voices double as a harsher accent-diversity
# stress test for the STT model anyway. Voices rotate per clip.
#
# Usage:  bash scripts/make-stt-clips.sh

set -eu
cd "$(dirname "$0")/.."
OUT="stt-clips"; mkdir -p "$OUT"

# Diverse English voices; filtered against what this Mac actually has.
WANTED=("Samantha" "Daniel" "Karen" "Moira" "Rishi" "Tessa")
AVAILABLE=()
for v in "${WANTED[@]}"; do
  if say -v '?' | grep -q "^$v "; then AVAILABLE+=("$v"); fi
done
[ ${#AVAILABLE[@]} -gt 0 ] || AVAILABLE=("Samantha")
echo "Voices: ${AVAILABLE[*]}"

RATES=(180 200 220)

# name|voice-pin-or--|spoken text  (keep in sync with scripts/stt-battery.sh)
# Clip 10 is voice-PINNED: gpt-transcribe deterministically hears Moira's
# "Mornings aren't working" as "Mornings and working" (S37 finding —
# whisper-1 got that same clip right; Samantha/Daniel are fine on both
# models). "aren't" flips the meaning, so the two replan clips stay off
# Moira; she keeps accent coverage on the non-critical query clips.
CLIPS=(
  "01-addblock|-|Add a thirty minute reading block tomorrow morning"
  "02-deleteblock|-|Delete my gym on Friday"
  "03-moveblock|-|Move my reading to the evening"
  "04-query-today|-|What's on my schedule today?"
  "05-query-day|-|What do I have going on Thursday?"
  "06-query-next|-|When do I next have gym?"
  "07-query-free|-|Am I free Thursday evening?"
  "08-notsup-analytics|-|How productive was I in March?"
  "09-notsup-account|-|Delete my account"
  "10-replan-mornings|Samantha|Mornings aren't working"
  "11-replan-evenings|Daniel|Let's try evenings instead"
)

i=0
for entry in "${CLIPS[@]}"; do
  name="${entry%%|*}"
  rest="${entry#*|}"
  pin="${rest%%|*}"
  text="${rest#*|}"
  voice="${AVAILABLE[$((i % ${#AVAILABLE[@]}))]}"
  if [ "$pin" != "-" ] && say -v '?' | grep -q "^$pin "; then voice="$pin"; fi
  rate="${RATES[$((i % ${#RATES[@]}))]}"
  i=$((i + 1))

  say -v "$voice" -r "$rate" -o "$OUT/$name.aiff" "$text"
  afconvert -f m4af -d aac "$OUT/$name.aiff" "$OUT/$name.m4a"
  rm "$OUT/$name.aiff"
  echo "  $name.m4a  ($voice @ ${rate}wpm)  \"$text\""
done

# Silence (3 s) and low-level white noise (3 s) — the hallucination-guard
# cases. Written as WAV via python, then AAC'd like the speech clips.
python3 - "$OUT" <<'PY'
import math, random, struct, sys, wave
out = sys.argv[1]
rate = 24000
def write(name, samples):
    with wave.open(f"{out}/{name}.wav", "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", s) for s in samples))
write("12-silence", [0] * (rate * 3))
random.seed(37)
write("13-noise", [int(random.gauss(0, 400)) for _ in range(rate * 3)])
PY
for name in 12-silence 13-noise; do
  afconvert -f m4af -d aac "$OUT/$name.wav" "$OUT/$name.m4a"
  rm "$OUT/$name.wav"
  echo "  $name.m4a"
done

echo "Done → $OUT/"
