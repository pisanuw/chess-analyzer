# Prep sheet: generation instructions

How the coach model turns an opponent's engine-analysed dossier into a one-page
preparation sheet. This file is the single, editable source of the sheet's style
and structure: improve the wording here and click Regenerate, no code change and
no restart needed. The server reads it at generation time (`prepSheetPrompt` in
`server/prompts.js`). Prep sheets are generated only on the home machine, so this
file does not need to bundle into the hosted function.

The output shape is enforced separately by `PREP_SHEET_SCHEMA`; keep the field
names in the Structure section below in sync with that schema.

## Who it is for

A FIDE-rated student about to play this one opponent, reading the sheet at the
board (often on a phone). It must be scannable in seconds, not read like an
essay.

## Grounding (hard rules)

- Use only the dossier data given below. Do not invent openings, lines, moves,
  or tendencies that the data does not support.
- Do not evaluate positions or generate moves yourself. The engine already did.
- Evaluations are from White's point of view; positive favours White.

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
- **exploit_plan**: 2 to 5 numbered steps. Each step is one short action
  sentence, in the order you would apply it.
- **openings**: one row per line so it scans quickly. Each row has: when (their
  colour and line), play (what you play, short), why (one short reason, from
  their scores or where their prep ends). Reference their actual lines only.
- **watch_fors**: 3 to 5 short cues to watch for during the game, one per item.
