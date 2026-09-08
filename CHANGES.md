# CHANGES

Newest first.

## 2026-09-07 (frontend: promotion picker, clocks in drills, time strip, recap, repertoire transpositions)

- Promotions get a click overlay (queen, rook, bishop, knight; keys q/r/b/n, Escape cancels) instead of a window.prompt; a dismissed pick re-sets the board.
- Drills show the clock from the game ("clock in the game: 1:40"): the time situation is part of the position. Drill records carry the mistake's clock; existing drills pick it up on the next startup sync.
- The eval graph grows a time-spent strip under the win-probability line when the PGN has clocks (bar height = think time; tooltip shows seconds), making the long-think-then-blunder and time-trouble-collapse patterns visible at a glance.
- Finishing the due queue shows a session recap: answers, correct rate, and what was missed on the first try, grouped by error type.
- The repertoire groups by the position after 8 plies instead of the move string, so transpositions merge; the most common move order is shown with an "N orders" chip, and every line links to the lichess analysis board for explorer study. Scout dossier repertoires get the same treatment.
- Games list has a free-text filter (players, event, subject) next to the scout chips.
- Editing names and synthesizing a pattern re-render the view instead of reloading the whole app.

## 2026-09-07 (backend: fair quick evals, win-probability acceptance, index cache, hosted CAS)

- Quick evals of off-list guesses now search the guess and the stored best move together (UCI searchmoves, one search, same depth), instead of judging a depth-12 eval of the guess against the stored depth-18 lines. The endpoint also returns the difference in win-probability points.
- Drill and guess acceptance moved from a fixed 30cp band to 3 win-probability points, the same currency as judgments and thresholds: strict in balanced positions, forgiving in already-decided ones. An off-list drill answer within the band now counts as correct (the paired search makes that verdict trustworthy).
- The games index is cached per file (mtime+size): listGames no longer re-parses every full game file, including all engine lines, on every poll and report. Our own writes invalidate explicitly; git-synced files fall through the cache via their new mtimes.
- Hosted drill writes are compare-and-swap on a revision counter inside the Supabase row; a lost race re-reads and reapplies the mutation instead of silently overwriting another function instance's write (the in-process lock never covered concurrent instances).

## 2026-09-07 (guess recording waits for the quick eval)

- Off-list guesses in the game view were recorded as incorrect immediately, while the quick engine eval was still running; a guess the eval then called "Playable" had already seeded its drill at step 0 as a wrong answer. The attempt is now recorded after the eval resolves (immediately for moves the stored lines already cover).

## 2026-09-07 (hosted read-only mirror on Netlify)

- The app now deploys to Netlify as a password-protected mirror for Kai (https://chess-analyzer-app.netlify.app): static frontend on the CDN, the same Express app as one serverless function, game data bundled into each deploy, drill/guess state in Supabase (one jsonb row, table chess_kv) behind the existing drill mutation lock.
- New server/auth.js: single-password login (APP_PASSWORD env), constant-time compare, HMAC-signed 90-day cookie, per-IP attempt limiting, Bearer support for scripts. Inactive when the env var is unset, so local use is unchanged. Frontend shows a login overlay on any 401.
- Read-only mode (READONLY_DATA env): every non-GET game route returns 405 except login, drill reviews, guesses, and quick evals; settings are forced to manual/no-auto-explain; the UI hides import, analyse, delete, colour, and name controls and explains the mirror.
- Publishing: `npm run publish-web` pushes the data repo, derives the hosted drill store from local games (Supabase-backed syncAllDrills), assembles web-dist (public/ plus vendored chessground and chess.js), and deploys via netlify-cli. Secrets in gitignored .env.web.
- store.js drill IO routes to Supabase when SUPABASE_URL is set; module roots tolerate CJS bundling (import.meta.url absent in the function bundle).

## 2026-09-07 (editable names, and the rest of the code-improve report)

- Player names on a game can be edited (✎ names in the game view, `POST /api/games/:id/names`): fixes wrong or inconsistent PGN spellings so colour detection and scouting dossiers match; drill labels refresh; the game id stays as imported so re-imports still dedupe.
- Concurrency: writes to the same data file are serialized with unique tmp paths, and all drill-store mutations run through one lock, so a review can no longer be lost to a concurrent sync or delete.
- Fixes from the review backlog: clocks stay per-move when a position repeats (order-based matching instead of FEN-keyed); score percentages exclude unknown results instead of counting them as losses; analyse-all no longer queues guaranteed-to-fail explain jobs in manual mode; sample games cut off by the ply cap keep "*"; finished jobs are pruned so the map cannot grow forever; the impossible threefold check on a bare FEN is gone; setPlayer/analyse-all/job-refresh handlers surface errors instead of silently rejecting; promotions ask which piece instead of forcing a queen; the accuracy trend no longer clips games below 50%.
- Training touches: due drills from the same game are spread apart; the model is given the player's existing concept names so study topics aggregate; from the second review a drill shows its key question before the move; explanation prompts state deterministic time-spent per move; the report buckets recurring endgame trouble by material signature.
- Simplification pass across server and views (shared helpers for move prefixes, SAN lines, side signs, averages, id checks; game.js line walking now uses board.js walkSans; dead code removed).
- Housekeeping: README status line, CLAUDE.md version and commit conventions, GitHub repo description and topics. CODE-IMPROVE-REPORT.md is fully implemented and removed; the few deliberately deferred ideas (per-drill ease, tablebase checks) moved to BRIEFING.md next steps.

## 2026-09-07 (scouting includes opponents from your own games)

- Every opponent from the player's own analysed games now appears in Scouting automatically: their side of each game is flipped on the fly from stored per-move analysis (both colours are already engine-evaluated), so no re-analysis is needed. Dossiers merge these with any scout-imported games of the same name. Own games contribute engine data (their mistakes, accuracy, phases, clocks, repertoire); error categories and patterns still come from explained scout imports. No punish drills are created from own games: a missed punishment is already one of the player's own drills.

## 2026-09-07 (scout name autocomplete)

- The "Scout an opponent" name field autocompletes: suggestions come from the pasted PGN's White/Black headers (most frequent name first, which in a multi-game file is the subject), known scout subjects, and past opponents; the player's own names are excluded. Switching to scout mode with a PGN pasted prefills the best candidate.

## 2026-09-07 (opponent scouting, phase 3: exploitation explanations and prep sheets)

- Scout games get their own explanation prompts: what the subject's move gets wrong and, concretely, how to punish it, including the engine lines from AFTER the mistake; the key question becomes the cue that signals the weakness is in play. Same schema shape as regular explanations, so storage, game view, and drills display them unchanged. The manual copy/paste prompt endpoint serves the scout framing too.
- Scout game summaries describe how the subject played and what to exploit.
- Preparation sheets: one LLM call over the whole dossier (categories, phases, patterns, repertoire with prep-end markers, clock behaviour) produces overview, game plan, openings advice, and watch-fors. Stored in data/prepsheets.json (synced through the data repo), generated or refreshed from the Scouting view.

## 2026-09-07 (opponent scouting, phase 2: punish drills and flipped guess flow)

- Scout games now generate "punish" drills: the position AFTER the subject's mistake with the student to move, answers checked against the next ply's already-stored engine lines (no extra engine work). Labeled "punish · vs subject" in the drills view, same ladder, tiers, and follow-ups; a mistake on a game's final move makes no drill.
- The game view's guess-first flow flips for scout games: "Karpov played 24.Ne5?, a mistake. Find the punishment." The board orients to the student's side, the guess plays in the post-mistake position, off-list guesses use the quick engine eval one ply later, and correct first-try punishments start the drill up the ladder.

## 2026-09-07 (opponent scouting, phase 1: tagging and dossier)

- Games carry a purpose ("own" or "scout") and, for scouting, a subject: the opponent being studied. Import offers "Scout an opponent" with a name field; colour detection matches the subject instead of the player. Existing games are untouched (absent purpose = own).
- Scout games are firewalled out of the player's weakness report, repertoire, drill deck, guess seeding, and pattern library, so opponents' mistakes can never pollute Kai's profile. Each scouted subject gets their own pattern library.
- New Scouting view: per-opponent dossier reusing the report machinery, phrased for preparation: their error types and phases, their clock behaviour, their repertoire with "prep ends" markers, and their recurring patterns, all linking into the games.
- Games list gains filter chips (My games / per-subject) and a scout badge.

## 2026-09-07 (training effectiveness: high-value items from CODE-IMPROVE-REPORT)

- Drills: a missed drill comes back at the end of the same session (ladder advances only after a same-day pass); wrong answers can only be graded Again; near-miss moments (below the mistake threshold) become lower-priority "sharpener" drills served after the core deck; drills carry the moment's category and pattern (chips in the drill view, copied when explanations finish).
- Multi-move drills: after a correct first move the opponent's reply from the engine line is played automatically and you must find the follow-up, up to two moves deep.
- Guess-first attempts in the game view are recorded (per machine, alongside drill state): a correct first-try guess starts that drill at step 2 of the ladder instead of tomorrow, and a missed guess creates a drill even below the drill threshold.
- Off-list guesses get a real answer: a quick engine probe (depth 12, 2s cap) evaluates moves outside the stored MultiPV lines in both the game view and drills, instead of "not among the engine's top lines".
- Report: "Are the weaknesses shrinking?" per-category trend (recent games vs earlier, shown from 8 games); time management from PGN clocks (mistakes with over 5 minutes left, moments under 2 minutes, moves after 10 seconds of thought or less, think-time on errors vs other moves); drill performance by phase and category from local review history; pattern study notes, one LLM-synthesized transferable lesson per recurring pattern.
- New Repertoire view: analysed games grouped by colour and first 8 plies with score, accuracy, and a "prep ends" marker (first opening move off the engine's list or losing 10+ win-probability points), linking straight to that move.
- Test suite: `npm test` (node:test, no new dependencies) covers analysis math, PGN parsing, drill scheduling and seeding, report aggregation, and the HTTP API (25 tests). server/index.js now exports the app and only listens when run directly.

## 2026-09-06 (live progress detail)

- The header progress now shows movement within a position, not just per position: "Analysing 130/134 · depth 14/18" with the bar filling fractionally as the engine deepens, and "Explaining 3/7 · 42s" with elapsed seconds on the current LLM call. At depth 18 a position takes 10-15 seconds, which used to look like a stall between ticks.

## 2026-09-06 (family sync via private data repo)

- `data/` is now its own private git repo (github.com/pisanuw/chess-analyzer-data) so games, analysis, and explanations can be shared with anyone who has repo access, with no hosting and no API keys. `drills.json` and `settings.json` stay per-machine (data/.gitignore): each clone derives its drill ladder from the synced games at startup (`syncAllDrills()`, which also prunes drills for deleted games), so review history is local and can never conflict.
- New npm scripts: `push-data` (commit and push data; run on the analysing machine), `pull-data`, and `sync` (pull then start; the one command for a viewing machine).
- Games view warnings for missing Stockfish and claude CLI now appear only when there is pending work that needs them, so a view-and-drill clone is not nagged about tools it does not need.
- README documents the two-machine setup.

## 2026-09-06 (robustness pass, items 1-6 of CODE-IMPROVE-REPORT)

- Engine: a missing or broken Stockfish binary now surfaces as a clean API error instead of crashing the server (spawn 'error' handler, findStockfish verifies bare command names on PATH); a dead engine process fails in-flight searches immediately instead of waiting out the timeout; changing engineHash now restarts the engine like threads changes do.
- Jobs no longer save a stale whole-game copy held across minutes of awaits: every write re-reads the game and applies only the job's fields, so colour changes and manual explanations made mid-job survive. Deleting a game or forcing re-analysis cancels its jobs; a cancelled job stops at its next checkpoint and writes nothing, so deleted games stay deleted and force actually re-runs.
- One corrupt game file no longer breaks the games list, report, and resume; it is skipped with a warning.
- Frontend: boards now release chessground's document listeners (destroy on view change and per drill); fast navigation can no longer let a slow view clobber a newer one; drill grading ignores double-clicks and stray keypresses after the queue empties, and fetches the next batch when more than 20 drills are due.
- Settings: numeric fields are validated server-side (non-numbers rejected, out-of-range clamped), so a cleared threshold field can no longer turn every move into a drill.
- Housekeeping: MIT LICENSE file added (package.json already declared MIT), author and keywords filled in, v0.1.0 dates in CHANGES/BRIEFING corrected to 2026-09-06, dead code removed (unused prompt variable, dead ternary in game view, duplicate eval formatter in charts, needless dynamic import in app.js).

## 2026-09-06

- Engine searches now carry a hard 2-minute movetime cap alongside the depth limit, so one pathological search cannot wedge the queue. If a search still overruns, the wrapper sends `stop`, keeps the depth reached so far, and leaves the engine idle for the next position instead of failing the job; an unresponsive engine process is killed and respawned. Previously a timed-out search kept running inside Stockfish, and the next job could silently receive the old position's bestmove.
- Games list: click the Date column header to toggle newest-first / oldest-first.
- Job list no longer hides the running job when more than 50 jobs are queued: only finished jobs are capped, so the header progress bar stays visible during big batch imports.
- The queue survives restarts: on startup the server re-queues games that were waiting or mid-analysis (and unexplained analysed games when auto-explain is on). Analysis results were already saved per game; now the pending work resumes too.
- Player name setting updated to "Kai Pisan, Pisan" so imported games get the right colour automatically.

## 2026-09-06  v0.1.0

- First working version: PGN import, Stockfish analysis (MultiPV, win-probability judgments, phases, clocks), critical moments, explanations through the `claude` CLI with structured JSON output, game summaries, guess-first moment review, weakness report (by category, phase, colour, trend, patterns, concepts), spaced-repetition drills from own mistakes, settings page, manual copy/paste LLM mode.
- Sample games generator (`scripts/make-samples.js`).
- Docs: README, CLAUDE.md, BRIEFING.md.
