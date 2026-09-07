# CHANGES

Newest first.

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
