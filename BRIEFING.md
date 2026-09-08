# BRIEFING

Current state of chess-analyzer and what to do next. Keep this short and current.

## Status (2026-09-07)

v0.1.x, in daily use on Yusuf's Mac with Kai's real tournament games. Since v0.1.0: robustness pass (engine crash-proofing, job/HTTP write safety, corrupt-file tolerance), restart-resuming queue with live depth progress, family sync via the private chess-analyzer-data repo (drills and settings stay per machine), training upgrades (same-session drill retries, honest grading, sharpener tier, multi-move drills, guess seeding, off-list engine evals, per-category trends, time management, pattern synthesis, repertoire view), opponent scouting (dossiers, punish drills, exploitation explanations, prep sheets, opponents auto-derived from own games), editable player names, and a 64-test suite (`npm test`). Latest round (2026-09-08): fairness fixes (paired same-depth quick evals, win-probability acceptance), game index cache, hosted CAS writes, see-the-threat drills, play-it-out sparring vs a limited engine, pattern lightning rounds, question-first hints, explanation feedback, pre-tournament card, repertoire transposition merging, time-spent strip on the eval graph.

## Purpose

Help a FIDE ~2000 player (Yusuf's son) improve: the engine finds the critical moments, the model explains them and classifies the error, and the classifications accumulate into a weakness profile plus drills from his own games. See README.md for the feature list.

## Decisions

- Local app, `claude` CLI for explanations (no API key, no per-token cost). Frontend kept static so a hosted Netlify build with Stockfish WASM plus an API-key client can be added later without rewriting views.
- Vanilla JS, no build step. chessground for the board, chess.js for rules, hand-rolled SVG charts.
- Error categories (fixed enum in `server/prompts.js`): tactics-allowed, tactics-missed, calculation, positional, opening, endgame-technique, conversion, defence. Time pressure is a separate boolean, not a category.
- Pattern names are free text but the prompt lists the player's existing pattern names so the model reuses them; the report aggregates by normalised name.
- Critical moment threshold default 12 win-probability points (between inaccuracy and mistake). Drill threshold 20.

## Known limitations

- One engine process, one job at a time. Fine for a few games per week.
- Phase classification is a material/move-number heuristic (`phaseOf` in analyze.js).
- Drill correctness is "engine best or within 3 win-probability points"; no tablebase check for endgames.
- The manual LLM flow works but is clunky (copy prompt, paste JSON).
- No lichess/chess.com import yet (public APIs, no auth needed; was descoped for v1).
- Explanations take about a minute each with the default model; the queue is background but a 6-moment game is 7 minutes.

## Next steps, in order

1. Tune thresholds and prompt wording from what Kai finds useful in real use.
2. Lichess and chess.com username import (both public APIs return PGN with clocks).
3. Per-drill ease (SM-2/FSRS-lite) fitted from the stored `reviews[]` history, replacing the fixed ladder; wait until a few weeks of review data exists.
4. Tablebase check for 7-man-or-fewer drill positions so endgame correctness means "keeps the theoretical result", not "within 30cp" (needs the lichess tablebase API or local syzygy files; weigh against the everything-runs-locally principle).
5. Export a scouting prep sheet as one-page markdown for a human coach (the weakness-report card exists: `/api/report/card`, button on the Report page).
6. Hosted build: `public/` unchanged, `api.js` swapped for a browser backend (Stockfish WASM worker plus Anthropic API client with a user-pasted key). Ask before adding anything that uses an API key.
