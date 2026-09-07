# BRIEFING

Current state of chess-analyzer and what to do next. Keep this short and current.

## Status (2026-09-07)

v0.1.0, first working version. Built and tested in a sandbox with Stockfish 17.1 and claude CLI 2.1.263 against three generated sample games; the full pipeline (import, engine analysis, explanations, game summary, report, drills, guess-first UI) works end to end. Not yet run on Yusuf's Mac or with real tournament games.

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
- Drill correctness is "engine best or a top line within 0.30"; no tablebase check for endgames.
- The manual LLM flow works but is clunky (copy prompt, paste JSON).
- No lichess/chess.com import yet (public APIs, no auth needed; was descoped for v1).
- Explanations take about a minute each with the default model; the queue is background but a 6-moment game is 7 minutes.

## Next steps, in order

1. Run on the real machine with real games; tune the threshold and prompt wording from what the son finds useful.
2. Lichess and chess.com username import (both public APIs return PGN with clocks).
3. Opening repertoire view: group games by first 8 to 10 moves, show where results and accuracy drop, so prep targets the actual repertoire.
4. Hosted build: `public/` unchanged, `api.js` swapped for a browser backend (Stockfish WASM worker plus Anthropic API client with a user-pasted key). Ask before adding anything that uses an API key.
5. Export the weakness report as a one-page PDF or markdown for a human coach.
