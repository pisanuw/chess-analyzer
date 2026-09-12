# Chess Analyzer

Status: v0.2.x, in active daily use; analysis pipeline, drills, reports, family sync, opponent scouting, and the Prepare-for-a-game flow all working end to end. Multi-user (three members, an admin, visitors) with a read-only hosted mirror.

A local web app for a serious club player (built for a FIDE ~2000 player): Stockfish finds the moments where a game went wrong, a coach model explains why in terms the player can act on, and the results accumulate into a weakness profile and a drill deck built from the player's own mistakes.

Everything runs on your machine. Games stay in a local `data/` folder. The only thing that leaves is the text of each critical moment, sent to the `claude` CLI (your Claude subscription, no API key).

## What it does

1. **Import** tournament games as PGN (paste or upload, multi-game files supported). The player's colour is detected from the configured name.
2. **Engine analysis**: every position is evaluated by Stockfish (MultiPV 3, configurable depth). Each move gets a win-probability loss, an accuracy score, and a judgment (inaccuracy / mistake / blunder, lichess thresholds). Player moves over the threshold become **critical moments**.
3. **Explanations**: for each critical moment the model is given the FEN, the move played, the engine's top lines with evaluations, the phase, and the clock (if the PGN has `%clk` comments). It returns a structured verdict: a reusable pattern name (folded onto the existing library's spelling), an error category, a one-paragraph explanation, and the question the player should have asked before moving. Time pressure is stamped from the clock (under two minutes left, or ten seconds or less spent), not asked of the model. The prompt is engine-grounded: the model is told to reason only from the given lines, never to invent variations.
4. **Guess first**: in the game view, a critical moment opens as a puzzle. Play your move on the board (evals hidden, one retry on a miss), then see the engine lines and the explanation. **Guess the move** extends this to the whole game: predict every one of your moves, scored in win-probability, with a recap against what the game actually lost.
5. **Weakness report**: across all analysed games, moments by error category (weighted by severity), by phase, by colour, accuracy over time, recurring pattern names, and concepts to study. Explanations can be rated helpful or not (the report lists the duds), and the report exports a one-page pre-tournament card in markdown.
6. **Drills**: mistakes and blunders become spaced-repetition positions (1, 3, 7, 14, 30, 60 day ladder, stretched or shortened per drill by an ease fitted from grades, answer speed, and stated confidence). Before the answer shows you say how sure you were (the report keeps a calibration table and a "sure and wrong" list), and on a miss you write one line on what you missed before the coach's explanation appears. Moves can be typed in algebraic notation as well as dragged. Correct means the engine's best move or any move within 3 win-probability points of it (strict in balanced positions, forgiving in already-decided ones); off-list answers get a paired same-depth engine check. The protocol matches the error: conversion, defence, and endgame-technique drills are played out against a strength-limited engine (hold your winning chances to pass), calculation drills demand the line several moves deep, and time-pressure moments offer a timed mode. Tactics-allowed mistakes get a second "see the threat" drill, opening "prep ends" deviations become flashcards, and sessions mix in quiet-position decoys from your own games so detection is trained, not just solution. Recurring patterns and error categories can be drilled back to back in practice rounds (extra reps that leave the review schedule alone); reviews record answer time, grades can be undone, and any drill can be suspended. Drills work offline (a tournament hall): a service worker keeps the app and the last deck, and grades made without a connection are queued on the device and synced, in order, when it returns.
7. **Opponent scouting**: import an opponent's games ("Scout an opponent" on the import card, or a FIDE-named export for a whole-history book) to get a per-opponent dossier, cut to the colour they will have against you: their error types, phases, clock behaviour, repertoire with "prep ends" markers, structure habits from their whole book (castling, queen trades, form, score against higher- and lower-rated players), eval-curve tendencies (conversion, defence, collapses), recurring weaknesses, your head-to-head record, the predicted opening clash between your lines and theirs, and a prep sheet from the coach model in which every claim cites the evidence it rests on. Their mistakes become "punish" drills; "Guess their move" on a scouted game trains predicting the person rather than the engine. Scout games never mix into your own weakness report or drills.
8. **Play it out**: any critical moment can be finished against a strength-limited Stockfish (defaults to the opponent's rating) to train conversion and defence; evals stay hidden while you play, and the engine gives a full-strength verdict on demand.
9. **Prepare for a game**: one page per opponent and colour (`#/prep/<name>?color=black`) composes everything a player needs before one game: a plan with progress, the prep sheet, the head-to-head, the opponent's lines and habits in that colour, the predicted lines with a board, and a prep deck (line flashcards along the predicted lines, their punish drills, sparring from where the prediction runs out). Upcoming games are tracked on the Home page. After the game, the game view reports whether the prediction held and where the line was left, and the head-to-head keeps a running prediction hit rate.

## Requirements

- Node 20+
- Stockfish: `brew install stockfish` (macOS) or `apt install stockfish`. Any UCI binary works; set the path in Settings if it is not on the usual paths.
- `claude` CLI (Claude Code) logged in, for explanations. Or set the LLM provider to *manual* and copy/paste prompts.

## Run

```bash
npm install
npm start          # http://localhost:3210
```

`PORT`, `DATA_DIR`, and `STOCKFISH_PATH` environment variables override the defaults. The server binds to localhost only. `npm start` also loads `.env` from the repo root if present (see `.env.example`) for the optional login, allowlist, and email settings; variables exported in the shell win over the file.

First run: open Settings, set the player's name as it appears in tournament PGNs (surname is enough), check the engine path, save. Then import a PGN on the Games page. Analysis runs in the background; the header shows progress.

## Users and login

The app serves a small allowlist of members plus an admin. Each member sees only their own games, report, repertoire, drills, and puzzles; everyone shares the scouting library and can prep against each other, but a member's deep report and repertoire stay private to them. The admin (the operator) imports games, runs analysis, and manages settings.

Login is off until configured, so a plain `npm start` runs open locally with you as admin (the original single-user behavior). To turn it on, set `SESSION_SECRET` and each member's `AUTH_EMAIL_<ID>`, then enable **Google sign-in** (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) and/or **magic-link email** (`RESEND_API_KEY`, `AUTH_FROM_EMAIL`). All of these are documented in `.env.example`. A member's own games are built from their scouting book with `curl -X POST http://localhost:3210/api/users/<id>/seed` (needs Stockfish).

## Cost and speed

Engine analysis at depth 18 with MultiPV 3 takes roughly 1 to 3 minutes per game on an Apple Silicon Mac; repeated opening positions come from a local eval cache. A game's critical moments are explained in one batched `claude` call when possible (falling back to about a minute per moment individually), so a five-moment game usually explains in a fraction of the old five-plus minutes, all in the background. Set the model to `haiku` in Settings for faster, shallower explanations. Explanations rated "not really" can be re-explained with one click.

## Sample data

`samples/sample-games.pgn` holds three games generated by a weak Stockfish playing a stronger one (`npm run samples` regenerates them). They are for trying the app, not for study.

## Layout

```
server/        Express API, engine wrapper, analysis, prompts, LLM provider, report, drills
public/        Static frontend (vanilla JS modules, chessground board, hand-rolled SVG charts)
scripts/       make-samples.js, check-prose.js (no em dashes), prebuild-clashes.js, publish-web.sh
samples/       sample PGN
test/          unit and API tests (npm test); test/ui/ is the headless-Chromium smoke test (npm run test:ui)
data/          created at runtime (gitignored): settings.json, users/<id>/drills.json, games/<id>.json
```

Development: `npm run lint` (eslint plus the prose check) and `npm test` before every commit; `npm run test:ui` opens every page in headless Chromium against a fixture data directory and drives the drills, deck, and Players flows (CI runs all three).

## Sharing games and drills between machines

`data/` can be its own private git repo (it is gitignored by this repo, so a nested repo is fine). Game files, analysis, and explanations sync through git; `drills.json` and `settings.json` are per-machine (see `data/.gitignore`), and each machine derives its own drill ladder from the synced games at startup, so drill review history stays local and never conflicts. Each machine also mirrors its drill store to `drills-<hostname>.json`, which DOES sync: other machines read those mirrors as read-only history, so review stats survive a dead laptop and merge in the report.

On the machine that analyses (needs Stockfish and the claude CLI):

    npm run push-data     # commit and push new games, analysis, explanations

On any other machine (needs only Node and git, no Stockfish, no claude CLI):

    git clone <this repo> && cd chess-analyzer && npm ci
    git clone git@github.com:<you>/chess-analyzer-data.git data
    npm run sync          # pull latest data, then start the app

Keep imports and analysis on the analysing machine; other clones view games, read explanations, and do drills.

## Hosted version (read-only mirror)

The app deploys to Netlify as a read-only mirror: static frontend plus the same Express app as one serverless function, game data bundled into each deploy, per-member drill/guess state in a Supabase table (`chess_kv`, key `drills:<id>`) since functions have no disk. Analysis never runs on the web; games are imported and analysed locally, then:

    npm run publish-web   # push data repo, sync each member's hosted drills, deploy to Netlify

Deploy secrets live in `.env.web` (gitignored): `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. The function's runtime auth/config (`SESSION_SECRET`, `PUBLIC_URL`, `AUTH_EMAIL_<member>`, and the Google/Resend keys, or the legacy `APP_PASSWORD`) is set in the Netlify dashboard, not in this file; `READONLY_DATA=1` blocks game mutations while keeping drills and guessing writable, and `DATA_DIR=data` points at the bundled files. Locally none of these are set, so nothing changes. See `.env.example` for the full list.
