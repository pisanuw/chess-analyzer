# Code Improve Report — chess-analyzer

_Generated 2026-09-06. Report-only: no files were modified._

## Summary

- Scope: 21 source files reviewed (server/ 10, public/ 10, scripts/ 1)
- Review findings: 31 (3 high / 12 medium / 16 low), confidence-filtered at 70+
- Simplification proposals: 24 (behavior-preserving)
- Audits run: history-and-presentation (detect-only), light secrets scan (clean). Skipped as not applicable: repo-artifacts (nothing generated is tracked), ci-gates (no tests exist yet), fail-closed-security (no auth/crypto/user-URL fetching; localhost-only app)
- Action required: none urgent. Biggest code risk is job-vs-HTTP concurrency on game files; biggest crash risk is the unhandled engine spawn error. package.json declares MIT with no LICENSE file.
- Bonus section at the end: product ideas for making the app train the player more effectively (explicitly requested; grounded in the current code).

## Review findings

### High

- `server/jobs.js:107-121` — race/lost-update: runAnalyse/runExplain hold an in-memory game copy across minutes of awaits and repeatedly `saveGame()` it; any concurrent HTTP save of the same game (colour change at `server/index.js:87-108`, manual explanation PUT at `server/index.js:144-156`) is silently overwritten by the job's stale whole-object write (90)
- `server/engine.js:36` — crash: the spawned engine process has no `'error'` listener, so a missing/invalid stockfish binary (or bad `settings.enginePath`) emits an unhandled `'error'` event and crashes the entire server (90)
- `server/index.js:81-85` — race/data-integrity: DELETE of a game during a running analyse/explain job is undone — the job's later `saveGame()` recreates the game file and `syncDrillsForGame()` recreates its drills (85)

### Medium

- `server/engine.js:6-21` — findStockfish treats the bare `'stockfish'` candidate as always present, so it can never return null: `/api/status` reports engineOk=true even with no engine installed, and the "Stockfish not found" message is unreachable, leaving the unhandled-spawn-crash above as the actual failure mode (85)
- `server/store.js:29-36` — readJson only tolerates ENOENT; one corrupt/truncated game JSON makes `listGames` reject, permanently breaking /api/games, /api/report, analyse-all, and resumeInterrupted until the file is hand-deleted (80)
- `server/engine.js:130` — getEngine reuse check compares only path and threads, never hash; changing engineHash in settings silently has no effect until the engine restarts for another reason (80)
- `server/index.js:114-115` — force re-analyse while an analyse job for that game is running: enqueue dedup returns the running job, so the wiped analysis is restored from the job's stale memory and the forced re-analysis never happens (78)
- `server/store.js:38-43` — concurrent `saveGame()` calls for the same id share one tmp path; interleaved writes can publish spliced JSON via rename, and the losing rename throws (reachable: explain-job per-moment saves vs HTTP PUT explanation) (72)
- `server/drills.js:12-71` — drills.json read-modify-write from jobs, the delete route, and the review route can interleave across awaits; a review can be lost or deleted drills resurrected by a stale write (72)
- `server/engine.js:47,64-74` — engine process exit does not reject in-flight command() promises; a dead engine mid-search stalls the job for the full timeout before failing (72)
- `public/board.js:43` — Board never calls chessground's `destroy()`; each board binds document/window listeners that are never unbound — one set accumulates per game-view visit and per drill shown (88)
- `public/app.js:29` — route() has no navigation token: on fast navigation a slow async view resolves after a newer one started, overwrites the new view's DOM, and its destroy() is never called, leaking the old view's keydown and jobEvents listeners (85)
- `public/views/drills.js:95` — grading has no in-flight guard: rapid 1/2/3 keypresses review the same drill twice, and after the queue empties keypresses keep re-grading the final drill from the "Nothing due" screen, corrupting its spaced-repetition ladder (85)
- `public/views/drills.js:19` — server caps due drills at 20 but the view never refetches: with more than 20 due it says "Nothing due right now" while the nav badge still shows remaining drills (80)
- `public/views/settings.js:49` — save posts raw input values ignoring min/max; a cleared number field is stored as 0, and momentThreshold/drillThreshold use `??` so 0 sticks — every player move becomes a critical moment and a drill (one LLM call each) on the next analysis (75)

### Low

- `server/jobs.js:9,26` — jobs Map is never pruned; finished job objects accumulate for the life of the process (72)
- `server/jobs.js:50` — pump() skips status 'cancelled' but nothing ever sets it and no cancel endpoint exists; dead code (80)
- `server/prompts.js:66` — `const after = m.lines.length ? '' : ''` yields '' on both branches and is interpolated pointlessly at line 81 (85)
- `server/analyze.js:71` — terminalCp calls isThreefoldRepetition() on a Chess built from a bare FEN, which has no history and can never report a repetition (78)
- `server/pgn.js:41,51` — clock comments are keyed by FEN in a Map, so when a position repeats the earlier occurrence gets the later occurrence's clock, feeding wrong time data to the time_pressure signal (73)
- `server/index.js:43-45` — numeric settings are Number()-coerced with no NaN/range check; NaN serializes to null, and zero/negative depth/multipv/thresholds are accepted (70)
- `server/report.js:79-80` — scorePct divides by all games including result '*' ones, so unknown-result games count as losses (73)
- `server/index.js:124-131` — analyse-all enqueues explain jobs without the manual-provider guard that resumeInterrupted applies, producing guaranteed-to-fail jobs in manual mode (70)
- `scripts/make-samples.js:41-43` — final `else result = '1/2-1/2'` makes '*' unreachable, so games cut off by the ply cap are mislabelled as draws (72)
- `public/views/games.js:75` — setPlayer and analyse-all click handlers lack the try/catch that sibling actions have; failures are unhandled rejections with no toast (78)
- `public/views/game.js:314` — jobEvents 'finished' handlers call rerender()/refresh() with no catch; if the refetch fails the view silently stays stale (75)
- `public/views/game.js:61` — evaltext else branch is a nested conditional whose both arms are ''; dead code obscuring "blank when unanalysed" (82)
- `public/charts.js:138` — fmt() is a copy of api.js formatEval minus its null guard; import formatEval instead (80)
- `public/app.js:58` — dynamic `import('./api.js')` just to reach toast, though api.js is statically imported at the top of the same file (75)
- `public/board.js:19` — applyMove hardcodes promotion 'q'; an underpromotion best move can never be entered and is judged "not among the engine's top lines" (70)
- `public/views/report.js:83` — accuracy trend hardcodes yMin 50; a game below 50% accuracy plots below the x-axis and over the date labels (70)

## Simplification proposals

All behavior-preserving; apply selectively.

Server:

- `server/prompts.js:66` — delete the dead `const after = ... ? '' : ''` line and its `${after}` reference at line 81 (both ternary branches identical)
- `server/analyze.js:99` — extract a `stmSign(stm)` helper; the `stm === 'white' ? 1 : -1` conversion repeats 5 times
- `server/analyze.js:150` — extract the acpl/accuracy reduce pair shared by byPhase and the top-level summary
- `server/report.js:12` — build byPhase/byColor initial objects from a loop over keys instead of copy-pasted literals
- `server/prompts.js:61` — extract the move-list formatter `(white ? "N." : "") + san` used 4 times into one helper
- `scripts/make-samples.js:40` — collapse the result if/else chain; the draw check plus trailing else are redundant (also see the review finding: the '*' case is currently unreachable)
- `server/index.js:43` — drive numeric-settings coercion from a `NUMERIC_SETTINGS` constant next to DEFAULT_SETTINGS instead of a duplicated key list
- `server/index.js:114` — extract the repeated analysis-reset block (`analysis=null; explanations={}; gameSummary=null; status=...`) shared with the player-change path
- `server/jobs.js:22` — share one isActive predicate between enqueue's dup scan and listJobs
- `server/store.js:92` — name the `/^[a-f0-9]{12}$/` id check (used in getGame and deleteGame) as isValidId

Frontend:

- `public/charts.js:138` — delete local fmt, import formatEval from api.js
- `public/app.js:58` — add toast to the existing static api.js import; drop the dynamic import
- `public/views/game.js:330` — move the mid-file `import { Chess }` to the top with the other imports
- `public/views/game.js:331` — replace sanToUci/uciLine with the san-walk already in board.js (applyMove/walkLine)
- `public/api.js:43` — share one movePrefix helper for the "N." / "N..." prefix duplicated in charts.js, report.js (x2), and moveLabel
- `public/board.js:62` — `movableFor && movableFor === turn` → `movableFor === turn`
- `public/views/drills.js:57` — extract the duplicated fetch-game-then-rerender block into a loadGame() helper
- `public/views/game.js:88` — the setPlayer/analyse/explain action dispatch is near-identical in game.js and games.js; extract a shared handler
- `public/views/games.js:37` — fold the sort+conditional-reverse into a single comparator that flips sign by sortAsc
- `public/views/game.js:61` — replace the dead nested ternary with plain '' (same as review finding)
- `public/views/game.js:215` — build the move-number prefix directly instead of moveLabel().replace(san,'')
- `public/charts.js:129` — one shared "is flagged judgment" predicate instead of two inconsistent encodings
- `public/views/report.js:64` — a catLabel(c) wrapper for the `CATEGORY_LABEL[k] || k` fallback repeated at 4 sites
- `public/app.js:51` — split the dense one-line polling render into a labelled template

## Audit findings

### history-and-presentation (detect-only)

README verification: every checkable claim matched the code (scripts, port, env overrides, engine defaults, formulas, thresholds, drill ladder, clock parsing, manual mode, layout, no-CDN claim). No dishonest claims found.

- package.json declares `"license": "MIT"` but there is no LICENSE file — add one or drop the field
- First commit "start" squashes 30 files / 3,586 lines with a bare message; unrecoverable, just commit descriptively going forward (the second commit already is)
- CHANGES.md: the "2026-09-07 v0.1.0" entry is future-dated and now sits below the 2026-09-06 entry, violating "newest first" — fix the v0.1.0 date
- BRIEFING.md status header has the same future date (2026-09-07)
- package.json: author is "" and keywords is [] — fill or delete
- CLAUDE.md says "Node 22" while README/engines say Node 20+ — align ("Node 20+, developed on 22")
- README has no status line; add one sentence (v0.1.0, first working version) so it's skimmable
- When online: set the GitHub repo description/topics (`gh repo edit`)

### Secrets scan (light, read-only)

No tracked .env/.key/.pem/.gpg/keyring/AI-log files; no credential-shaped strings found. Nothing to act on.

## Suggested order of work

1. **Engine crash-proofing** (small): add a `proc.on('error')` handler in engine.js and make findStockfish actually verify the bare `'stockfish'` candidate (e.g. spawnSync `which`), so a missing engine is a clean API error instead of a server crash. Also reject in-flight commands on process exit and include hash in the getEngine reuse check.
2. **Job-vs-HTTP write conflicts** (medium): the three HIGH findings share one root cause — jobs hold a stale game object and last-write-wins. Cheapest fix in this codebase's style: re-fetch the game just before each saveGame in jobs and merge job-owned fields onto it, plus a "deleted?" check; and make force-reanalyse cancel/ignore the running job.
3. **Corrupt-file tolerance** (small): in listGames, skip-and-warn unreadable game files instead of rejecting everything.
4. **Frontend lifecycle** (small-medium): expose and call chessground destroy() from Board; add a navigation token to route(); guard drill grading against double-submits and refetch when the 20-drill batch empties.
5. **Settings validation** (small): clamp numeric settings server-side; reject NaN.
6. **Housekeeping** (tiny): LICENSE file, CHANGES/BRIEFING dates, package.json author/keywords, the dead-code deletions from the simplifier list.

## Helping the player improve (product ideas)

How the training loop works today, in one paragraph: every position is engine-scored (depth 18, MultiPV 3); a player move losing ≥12 win-probability points is a "moment"; moments losing ≥20 become drills on a fixed 1/3/7/14/30/60-day ladder; the LLM explains each moment (pattern, category, time-pressure flag, explanation, key question, concept) and the report aggregates categories/phases/patterns into a weakness profile. Guess-first review exists but its results are discarded; clocks are stored per move but only surfaced as a boolean.

Ranked ideas, each grounded in data the app already stores:

**High value, small effort**
- Retry failed drills in the same session instead of tomorrow; only advance the ladder after a same-day pass (drills.js sets step=0 → due tomorrow today)
- Enforce grading honesty: hide Good/Easy when the auto-check already said the answer was wrong (the verdict is computed before grading and then ignored)
- Drill-performance panel in the report: success rate by phase (and category, once copied onto drills) from the already-stored reviews[] history — direct evidence a weakness is or isn't shrinking
- Near-miss "sharpening" deck: 12-20-loss moments as a lower-priority drill pool (only the drillThreshold filter excludes them)
- Copy category+pattern onto drill records so the player can drill a chosen focus area ("today: conversion")

**High value, medium effort**
- Persist guess-first attempts and seed drills from them: a correct first-try guess starts the drill ladder higher; a miss creates a drill even below threshold (the verdict in game.js is currently thrown away)
- Multi-move drills: after the right first move, auto-play the opponent's PV reply and ask for the follow-up — the 8-ply PVs are already stored per drill
- Evaluate off-list guesses with a quick server engine call instead of "not among the engine's top lines" (engine.js already analyses on demand)
- Time-management analysis: parse TimeControl + per-move clock deltas into seconds-spent; correlate loss with time spent and remaining ("blunders with >5 min on the clock" vs "under 2 min"); today only an LLM boolean uses clocks
- Per-category trend with sample-size guards: rolling last-10-games weight vs prior — the current "focus areas" are lifetime cumulative and can never shrink even as the player improves
- Opening repertoire view (already planned in BRIEFING): group by first 8-10 plies/ECO with per-line score, accuracy, and first-deviation ply; a "where prep ends" marker per game (earliest opening ply with playedRank null or meaningful loss) falls out of stored data
- Pattern-library study page: for each pattern with 2+ instances, one LLM call synthesizing a transferable rule and trigger cues from all its instances, replacing N one-off paragraphs

**Medium value**
- Replace the fixed ladder with per-item ease (SM-2/FSRS-lite) fitted from the stored review history (M)
- Deterministic time-pressure input: compute time-spent/remaining and put both in the moment prompt instead of one "clock after move" line (S)
- Endgame study pack: bucket endgame moments/drills by material signature from the FEN ("R+4P vs R+3P") and list recurring endgame types (S)
- Show the stored key_question as a pre-move hint on 2nd+ drill reviews — train the thinking habit, not the memorized answer (S)
- Tablebase check for ≤7-man drill positions so endgame correctness means "keeps the theoretical result", not "within 30cp" (L; BRIEFING flags this exact limitation)
- Shuffle the due-drill queue so consecutive drills aren't from the same game (S); pass known concepts to the LLM like known patterns so "concepts to study" aggregate instead of fragmenting (S)
