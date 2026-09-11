# Prep sheet: generation instructions

How the coach model turns an opponent's dossier into a one-page preparation
sheet. This file is the single, editable source of the sheet's style and
structure: improve the wording here and click Regenerate, no code change and
no restart needed. The server reads it at generation time (`prepSheetPrompt` in
`server/prompts.js`). Prep sheets are generated only on the home machine, so this
file does not need to bundle into the hosted function.

The output shape is enforced separately by `PREP_SHEET_SCHEMA`; keep the field
names in the Structure section below in sync with that schema.

## Who it is for

One FIDE-rated student (the sheet says who, with their rating and their own
openings) about to play this one opponent, reading the sheet at the board (often
on a phone). It must be scannable in seconds, not read like an essay.

## Grounding (hard rules)

- Use only the dossier data given below. Do not invent openings, lines, moves,
  or tendencies that the data does not support.
- Do not evaluate positions or generate moves yourself. The engine already did.
- Evaluations are from White's point of view; positive favours White.
- Every fact in the dossier carries an id in brackets, such as [P2] or [L1].
  Every plan step, opening row, and cue must list the ids it rests on in its
  `evidence` field. Cite only ids that appear in the dossier; a claim with no
  supporting id will be marked unsupported on the sheet.
- The dossier has several layers. Prefer the whole-history layers (L book lines,
  F habits, T tendencies) for what the opponent tends to do; the analysed-game
  layers (E, P, R, K) for how they go wrong; the C predicted lines and S
  student lines for what the student should play. Small samples are stated with
  their counts: treat two games as an anecdote, not a tendency.

## Style

- Write short, simple sentences. One idea per sentence.
- Use active voice: "Attack the isolated pawn", not "The pawn should be attacked".
- Plain words. Avoid jargon, double negatives, and filler. No praise.
- Prefer lists and tables to paragraphs. Never write a long block of prose.
- The profile rows are the same for every opponent, so two sheets can be
  compared side by side. Keep each value to a few words.
- Plain punctuation: commas, colons, parentheses. Never use em dashes.

## Structure (fill every field)

- **headline**: one short sentence, the single most useful thing to know before
  the game.
- **profile**: the quick-facts table. A few words per value, grounded in the
  data:
  - style: how they play, e.g. "aggressive, tactical".
  - strongest_phase: opening, middlegame, or endgame, from the phase accuracies.
  - weakest_phase: where they go wrong most, from the phase accuracies.
  - main_errors: their most common error types, from the error-type counts.
  - time_trouble: how they handle the clock, or "no clock data".
- **exploit_plan**: 2 to 5 numbered steps, each `{ step, evidence }`. Each step
  is one short action sentence, in the order you would apply it. Use the rating
  gap and the "against higher / lower rated" habit to set the risk level:
  complicate against an opponent who scores badly under pressure, keep it simple
  against one who overpresses.
- **openings**: one row per line so it scans quickly, each `{ when, play, why,
  evidence }`: when (their colour and line), play (what the student plays,
  short, from the student's own lines or the predicted lines), why (one short
  reason, from their scores, where their prep ends, or the out-of-book habit).
  Reference their actual lines only.
- **watch_fors**: 3 to 5 short cues `{ cue, evidence }` to watch for during the
  game, one per item, each tied to a pattern, habit, or tendency id.
