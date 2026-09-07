# CLAUDE.md

Guidance for Claude Code when working in this repo. Read BRIEFING.md for the current state and next steps.

## What this is

Local web app: Node 20+ (developed on 22) / Express 5 backend, vanilla ES-module frontend (no build step), Stockfish over UCI, explanations through the local `claude` CLI. See README.md.

## Conventions

- Push directly to `main`. Commit messages: a descriptive summary line, body explaining what and why. Run `npm test` before committing.
- No em dashes in prose, UI copy, or prompts. Use commas, colons, or parentheses.
- Keep it a single `npm start` app with no build step. No bundler, no framework, no TypeScript.
- Frontend must keep talking to the backend only through `public/api.js` so a hosted build can swap the backend later.
- LLM calls go through `server/llm.js`. Default provider is the `claude` CLI (`-p --output-format json --tools "" --json-schema ...`). Never add an API-key provider that is on by default; ask first before touching API keys.
- Every prompt sent to the model is engine-grounded: FEN, played move, engine lines with evals. Never ask the model to evaluate positions or generate moves on its own.
- Update CHANGES.md with each meaningful change (newest first). Do not create AI-log.md.
- Test data: `npm run samples` regenerates `samples/sample-games.pgn` with Stockfish. Use `DATA_DIR=/tmp/somewhere npm start` to avoid polluting real data while testing.

## Useful facts

- Stockfish scores in UCI are from the side to move; `server/analyze.js` converts to White's perspective for storage (`evalBefore`, `evalAfter`, `lines[].cp`) and to the mover's perspective for loss/accuracy.
- Win probability and accuracy use lichess's formulas; judgment thresholds are 10/20/30 win-probability points.
- Game id = first 12 hex chars of sha1(White|Black|Date|Round|SAN moves). Re-importing the same game is a no-op.
- Jobs are in-memory (`server/jobs.js`), processed one at a time; game JSON is written after each step so a crash loses at most the current step.
- `data/` is gitignored and holds all user data. It is also its own private git repo (github.com/pisanuw/chess-analyzer-data) for syncing between machines; `drills.json` and `settings.json` are per-machine and excluded there, and `syncAllDrills()` re-derives drills from game files at startup.
- `claude --version` was 2.1.x when this was built; flags used: `-p`, `--output-format json`, `--tools ""`, `--no-session-persistence`, `--system-prompt`, `--json-schema`, `--model`. The parsed result is `structured_output` in the JSON envelope.
