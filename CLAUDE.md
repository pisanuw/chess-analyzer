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
- `data/` is gitignored and holds all user data. It is also its own private git repo (github.com/pisanuw/chess-analyzer-data) for syncing between machines; `drills.json` and `settings.json` are per-machine and excluded there, and `syncAllDrills()` re-derives drills from game files at startup. Each machine mirrors its drill store to `drills-<hostname>.json`, which DOES sync (read-only history merged into report stats); `evalcache.json` and `*.tmp` never sync.
- Pure chess-math helpers shared by server and frontend live in `public/shared.js` (the server imports the file directly); do not re-duplicate winProb, WP_ACCEPT, formatEval, or the time-spent calculation.
- `claude --version` was 2.1.x when this was built; flags used: `-p`, `--output-format json`, `--tools ""`, `--no-session-persistence`, `--system-prompt`, `--json-schema`, `--model`. The parsed result is `structured_output` in the JSON envelope.

## Multi-user and auth

- Members are Kai, Nikash, Neeraj (role `member`); Yusuf is `admin`. The roster lives in code (`server/users.js` `DEFAULT_USERS`: id, displayName, role, fideId, player-name substrings); login emails (the allowlist) come from `AUTH_EMAIL_<ID>` env vars or `data/users.json`, never hard-coded. All auth/config vars are documented in `.env.example`.
- Auth is active only when `SESSION_SECRET` (or the legacy `APP_PASSWORD`) is set; a bare local run stays open with the operator acting as admin. A signed `sess` cookie carries the member id (`server/auth.js`). Sign-in is Google OAuth (`server/googleauth.js`, hand-rolled code flow) and magic link via Resend (`server/magiclink.js`), both allowlist-only and exempt from the auth and read-only gates. `GET /api/auth/me` returns the current user plus which providers are configured; `currentUser(req)` resolves identity.
- Per-user data: own games carry an `owner` field and sit alongside shared scout games in `data/games/` (ownership is a field, NOT a per-user directory), so `listGames(userId)` filters own games by owner while scout games stay shared to everyone; `listAllGames()` (or userId `'*'`) is the admin/global view. Drills and pattern notes are per-member under `data/users/<id>/` (and Supabase key `drills:<id>` on the mirror). In routes, `effectiveUser(req)` scopes the per-user views (a member sees only their own; an admin may target any member with `?user=<id>`), and `requireAdmin(req, res)` gates management routes (import, analyse, delete, settings, scout import/promote, seeding). The deep report and repertoire stay private; a member's opponent-facing prep sheet is the scout view of their own games (carries no drills/feedback), and every member appears in the shared scouting list.
- Seed a member's own games from their scout book with `POST /api/users/:id/seed` (admin, needs Stockfish): it imports the book's recent on-strength subset as the member's own games under member-namespaced ids (so the shared scout copy is never clobbered), then queues analysis.
- The admin manages the roster from the Admin page (`#/admin`, admin + producer only): `addVisitor`/`addMember`/`removeRosterEntry` in `server/users.js` write `data/users.json` (merged into the roster by `getUsers`, bundled to the mirror on publish). Admin-added visitor ids are `v_<email>`, players `p_<email>`; built-ins and env visitors are listed but not editable there. Player-name substrings are semicolon-separated (PGN names contain commas).
- Activity log: `server/audit.js` records sign-ins (with client IP), logout, and every admin mutation (logged centrally in `requireAdmin`, non-GET only) to Supabase `audit` on the mirror or `data/audit.json` locally. Admin views it at `#/log` (`GET /api/audit`). Unauthorized visitors can ask to be added via the sign-in screen's "Request access" form (`POST /api/auth/request-access`, public, emails `adminEmail()`).
