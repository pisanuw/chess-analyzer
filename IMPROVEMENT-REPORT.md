# Improvement report: frontend, backend, and opponent-preparation pedagogy

> **Status (2026-09-12):** implemented. Every numbered recommendation in sections 2, 3, and 4.3 (A to I) shipped in phases on the follow-up branch, each with tests, and is described in CHANGES.md (newest first). One optional item was left as it was and is listed in BRIEFING.md next step 9: the play-out refactor onto `public/playout.js` with a shared `gradeGuess`. The `analysis.moves[]` de-duplication was measured on 2026-09-11 and rejected (see 2.3). Section 4.4 (things not worth doing yet) stands.

Date: 2026-09-11. Scope: every file under `server/`, `public/`, `scripts/`, `netlify/`, and `test/`, plus README, BRIEFING, CLAUDE, CHANGES, and PLAN-opening-clash. `npm test` was run on a clean checkout (`npm ci`): 200 tests, all passing, no engine or claude CLI needed. One finding (the stale-session fallthrough in section 2.1) was reproduced with a script against the real app; everything else is from reading the code.

The report is organised as: a ranked summary, backend, frontend, pedagogy (the part about preparing a player for a new opponent), and a suggested order of work. Each item names the files and lines it refers to so it can be turned into a task without re-reading the codebase.

## 1. Summary: the ten things worth doing first

| # | Item | Area | Why it matters | Effort |
| --- | --- | --- | --- | --- |
| 1 | A signed session for a removed or unknown user id falls through to the default member's data (2.1a) | Backend, security | A former member with a still-valid cookie reads Kai's games, report, and drills | Small |
| 2 | "Prepare for a game" page: opponent + my colour + time control, one screen (4.3 A) | Pedagogy, frontend | Today the prep is spread over four accordions and a separate drills page, none of them colour-aware | Medium |
| 3 | Feed the prep sheet the whole-history book, the clash lines, and the student's own repertoire; key sheets per student (4.3 B) | Pedagogy, backend | The sheet's opening advice is built from 8-ply lines of at most 50 games and cannot say "you play X" | Medium |
| 4 | Colour-split the scout dossier and punish drills (4.3 C) | Pedagogy, backend | Only the opponent's games in the colour I will face matter | Small |
| 5 | Deterministic tendency profile from stored eval curves and the book parse (4.3 D) | Pedagogy, backend | Conversion and defence rates, out-of-book performance, form, and structure habits need no LLM and are better evidence than 50 labelled moments | Medium |
| 6 | Post-game verification: did the predicted line hold, did the opponent err where the sheet said (4.3 F) | Pedagogy, backend | Closes the loop and measures whether the prep is worth the time | Small |
| 7 | Own-game import ignores the member roster: every imported own game becomes Kai's, with Kai's names and rating (2.1b, 2.1c) | Backend, multi-user | Nikash and Neeraj can only get games through book seeding | Small |
| 8 | Report, puzzles, clash, and pattern lookup re-read every game file on every call (2.3) | Backend, performance | Fine at 100 games, painful at 500 across three members | Medium |
| 9 | CI workflow, a frontend smoke test, and a linter (2.4, 3.5) | Platform | 200 server tests but nothing runs them automatically and the UI has no coverage | Small |
| 10 | Confidence rating and explain-back before the reveal; SM-2 ease from the stored review history (4.3 I) | Pedagogy | Calibration and generation are the two cheapest known boosts to retention | Small to medium |

What is already strong and should be protected: every prompt is engine-grounded and the schemas keep the model from inventing moves; the guess-first and question-first flows; quiet-position decoys; play-it-out drills for conversion and defence; punish drills; recency and rating weighting of the opponent's book; honest thin-data markers (raw counts next to every percentage, `nodata` versus `thin` prep ends); stale and "new format" flags on prep sheets; and the everything-runs-locally principle with one opt-in external lookup.

## 2. Backend

### 2.1 Correctness and security

**a. Stale session fallthrough (verified).** `authMiddleware` (`server/auth.js:134-140`) lets any validly signed `sess` cookie through; `currentUser` (`server/auth.js:145-149`) then returns `null` for a user id that is no longer on the roster; `effectiveUser` (`server/index.js:124-129`) treats `null` like the admin branch and returns `DEFAULT_USER`. Reproduced: with `SESSION_SECRET` set, a token for `ghost_user_not_on_roster` gets `200` from `/api/games` (Kai's game listed), `/api/report`, and `/api/drills`. `requireAdmin` and `blockVisitor` are not affected (they check the role), but every member-scoped read and every training write (`guess`, `feedback`, `review`) is. Fix: when `authActive()` and the session's user is not on the roster, respond `401` (clear the cookie) instead of falling through; the cheapest place is `effectiveUser` (throw an error with `status: 401`, which `wrap` already honours) plus the same check at the top of `currentUser` callers that do not go through `effectiveUser` (`/api/games/:id/moments/:ply/eval`, `/api/playout/*`). Add a test in `test/session.test.js` for a signed token with an unknown id.

**b. Own-game import is single-user.** `POST /api/games/import` (`server/index.js:228-263`) detects the colour with the global `settings.playerNames` and saves with `saveGame(game)` so the owner defaults to `kai` (`server/store.js:260-266`). The roster already carries `playerNames` per member (`server/users.js:24-27`) and the seed route knows how to set `owner`. Accept an `owner` field (admin only), resolve the member, use their `playerNames` for colour detection, and pass the owner to `saveGame`. The Games page needs a "For member" select for the admin (3.3).

**c. The coach is told the wrong rating.** `runAnalyse` stamps `g.playerRating = settings.playerRating` (`server/jobs.js:131`) and every prompt uses `settings.playerRating` (`server/jobs.js:184`, `server/index.js:373,465,862,897,973`). For a member's game this is Kai's 2000. The most accurate number is already in the file: the player's own `WhiteElo`/`BlackElo` header for that game; fall back to the roster `rating`, then the setting. The same applies to `scoutSystemPrompt`, where the "student" is whoever is preparing, not the operator.

**d. The opening clash is hard-wired to Kai.** `loadKaiGames()` (`server/clash.js:61-65`) calls `listGames()` with the default user, and both clash routes use it (`server/index.js:829,856`). Nikash opening Neeraj's page sees Kai's openings crossed with Neeraj's book. Thread `effectiveUser(req)` into `loadKaiGames(userId)`, key any forest cache by user, and rename `kai*` identifiers (`buildKaiIndex`, `kaiPrepEnds`, `kaiBranch`, `kaiColorCounts`) to `student*` or `player*` while touching it; the marathon notes deferred this and it is now the most visible multi-user gap.

**e. Ownership is not checked on the quick-eval route.** `/api/games/:id/moments/:ply/eval` (`server/index.js:415-444`) loads the game unscoped. Ids are content hashes, so this is low risk, but it is one line to pass `await effectiveUser(req)` to `getGame`.

**f. Audit log races.** `logEvent` (`server/audit.js:20-30`) is a read-modify-write of the whole log with no serialisation; two admin mutations landing together can drop an event. Reuse the promise-chain pattern from `drills.js` `locked()` or push through `writeJson`'s per-file queue with the read inside the chain.

**g. Prep sheets are global.** `sheets[subject]` (`server/index.js:901-903`) is keyed by opponent name only, and the prompt has no idea who the student is beyond a rating. See 4.3 B for the fix; the storage change is to key by `${subject}|${userId}` or to split the sheet into a shared opponent profile and a per-student plan.

### 2.2 Multi-user seams still open

- Settings are global (`server/store.js:50-73`): `playerNames`, `playerRating`, `momentThreshold`, `drillThreshold`. The marathon decision was "identity, rating, and thresholds become per user"; only identity moved (to the roster). Thresholds can stay global for now, but rating and names should come from the roster (2.1b, 2.1c).
- The admin has no way to pick which member they are viewing: `effectiveUser` honours `?user=<id>` but `public/api.js` never sends it. See 3.3 for the switcher.
- `gamesForSubject` (`server/subjects.js:11-48`) folds every member's own games against a subject into the shared dossier as flipped engine data, and a member with no book is scouted from their own games. Both are decisions, not bugs, but the README should say so plainly: "your per-game accuracy and critical moments against X are visible to everyone preparing for X".
- The Games page shows the Import card to any signed-in user on the local server (`public/views/games.js:19`), who then gets a 403. Gate on `session.user.role`.

### 2.3 Performance and scale

Every game file holds the PGN, `moves[]`, and `analysis.moves[]` (which repeats san, uci, fenBefore, fenAfter, and adds three 8-ply lines per position), so a 40-move game is a few hundred KB. The following read every own game file from disk and parse it, per call:

- `buildReport` (`server/report.js:18-19`): called by `/api/report`, `/api/report/card`, the Home page, the Drills page (the "today" line), `patterns/synthesize`, and, via `gamesForSubject`, every scout dossier.
- `buildRepertoire` (`server/repertoire.js:15-16`), `buildPuzzles` (`server/puzzles.js:90-93`), `loadKaiGames` (`server/clash.js:61-65`), `buildDecoys` (`server/drills.js:486-501`, once per drill session).
- `knownPatterns` (`server/jobs.js:288-301`): full reads of every explained game at the start of every explain job, to collect pattern names.
- `syncAllDrills` at startup (`server/serve.js:20-27`), once per member, each a full pass.

The index cache in `listGames` (`server/store.js:181-205`) keeps the list cheap, but the aggregates above bypass it. Two complementary fixes:

1. Put more into `gameIndexEntry` (`server/store.js:213-244`): per-game pattern and concept names, per-phase stats, and the moment refs (`ply`, `san`, `judgment`, `phase`, `loss`, `category`, `pattern`). `knownPatterns`, most of `buildReport`, `buildRepertoire` (which only needs the first 8 plies plus the deviation ply), and the report's timeline then run off the index with no full reads. The index is rebuilt lazily by mtime, so nothing else changes.
2. Memoise the expensive builders in process, keyed by a fingerprint of the index (`sha1` of sorted `id:mtimeMs:size`) plus the drill store `rev` for the report. A member's report is then computed once per change, not once per page view.

Measured 2026-09-11 and rejected: dropping the duplicated `san/uci/fen*` from `analysis.moves[]` would NOT roughly halve file sizes. Across the live 289 games (51.2 MB), those four fields are 4.3 MB, 8% of raw bytes (about 17% of the compact JSON), so the migration is not worth touching every reader of `analysis.moves`. The bytes actually go to: pretty-printing whitespace 49% (compact would be 25.9 MB), `analysis.moves` 37% (of which the three engine `lines[]` are 15 points), `game.moves` 11%. Compacting the JSON is the only big lever, but it was left alone too: 51 MB is small, and indented files diff line-by-line in the data git repo (small sync deltas) while git packing compresses the whitespace away anyway. Do not re-propose the de-duplication without new numbers.

### 2.4 Structure, duplication, and tooling

- `server/index.js` is 1022 lines and about 45 routes in one file. Split into `server/routes/{auth,games,training,scout,admin}.js`, each exporting `register(app, helpers)` with `wrap`, `effectiveUser`, `requireAdmin`, and `blockVisitor` moved to `server/http.js`. Tests import `app` unchanged.
- Duplicated pure helpers that belong in `public/shared.js` (the sanctioned shared module): `resultScore` (`server/report.js:326` and `server/repertoire.js:53`), `normalizeKey` (`server/report.js:333`, `server/drills.js:541`, inline at `server/index.js:961-962`), the 3-field `posKey` (`server/clash.js:45`, `server/repertoire.js:24`, `server/scoutbook.js:84`), and `fmtLine`/`lichess` (`public/views/scout.js:9-10`, `public/views/repertoire.js:10-12`, `server/clash.js:268`). `clash.js` deliberately copies `scoutDossier`'s `weightOf`; export it from `scoutbook.js` instead, so the two cannot drift.
- `server/analyze.js` `phaseOf` (known limitation) could use the opponent book's ECO plus the deviation ply for "opening" and a material-and-pawn-structure rule for "endgame"; not urgent, but it feeds every phase table.
- `time_pressure` is asked of the model (`server/prompts.js:46`) although the clock and time spent are computed deterministically (`clockText`, `server/prompts.js:172-180`). Compute it (clock under 120 s, or under 10 s spent) and state it as a fact in the prompt; the report's clock statistics then stop depending on the model's mood. Keep a free-text `clock_note` if the nuance is wanted.
- No CI and no linter: there is no `.github/`, no eslint or prettier config. The suite is engine-free and runs in under a minute, so a `test.yml` running `npm ci && npm test` on Node 22 is a five-minute job. A minimal eslint flat config (`no-undef`, `no-unused-vars`, `eqeqeq`) plus a tiny `scripts/check-prose.js` that fails on em dashes in `.md`, prompt, and UI files would enforce two conventions that are currently enforced by memory.
- The legacy password path in `server/auth.js` (`loginRoute`, `legacyOk`, `verify`, `sign`) is documented as transitional; schedule its removal once every member has signed in with Google or a link, and drop `RO_ALLOW`'s `/api/login` with it.
- `POST /api/games/:id/player` re-imports `summarize` dynamically (`server/index.js:296`) although it is already imported at the top (`server/index.js:18`).

### 2.5 Engine and LLM pipeline

- The batch explanation path (`server/jobs.js:193-230`) and the per-moment fallback are solid. Two additions: log the batch prompt token size (it grows with moments and with the 40-pattern library) so a runaway game can be spotted, and cap `plies` per batch at, say, 8 with a second batch for the rest rather than one 240 s + 60 s per moment call.
- `sanitizeExplanation` (`server/jobs.js:147-156`) accepts any `pattern` string; normalise it against `known.patterns` with the same `normalizeKey` the report uses so "Hanging piece after exchange" and "hanging piece after exchanges" aggregate before storage, not only at report time.
- The manual provider (`llmProvider: 'manual'`) has no batch or re-explain (known). Given the CLI is the only real provider, consider retiring manual mode from the UI and keeping it as a `curl`-level escape hatch, which removes two code paths from `game.js`.
- `evalcache` (`server/evalcache.js`) is keyed by engine name, depth, and MultiPV; a depth upgrade invalidates everything. Storing the search depth per entry and accepting entries at or above the requested depth would make a depth bump nearly free for openings.

## 3. Frontend

### 3.1 Architecture

- The frontend rules (vanilla modules, no build step, all backend traffic through `public/api.js`) are followed consistently, `esc()` is applied everywhere user text is interpolated, and every view returns a `destroy` so Chessground listeners do not leak. Good foundations.
- `public/views/game.js` (639 lines) runs three state machines in one closure (`guess`, `playout`, `gtm`) that share `state`, `board`, and `panel`; `public/views/drills.js` (547 lines) runs four (`guessing`, `follow`, `verifying`, `playout`). The play-it-out logic is duplicated nearly line for line between the two (`game.js:259-345`, `drills.js:188-253`), and the guess-verdict logic is written three times (`game.js:452-484`, `drills.js:285-315`, `puzzles.js:77-90`). Extract `public/playout.js` (a small controller: `start(fen, seat, elo)`, `move()`, `assess()`, `render(pane)`) and a pure `gradeGuess(t, uci)` in `public/shared.js` that returns `{ good, rank, wpDiff, text }`; the server can use the same function for `recordGuess`.
- `CATEGORY_LABEL` lives in `views/report.js` and is imported by `home.js`, `scout.js`, and `drills.js`; move it to `public/labels.js` (with `KIND_LABEL` and `JUDGE_MARK`) so views do not import each other.
- Inline styles are pervasive (`style="margin-top: 16px"`, `style="padding:6px 10px; font-size:14px"` on every search box). A dozen utility classes (`.mt-3`, `.gap-2`, `.input-sm`) in `style.css` would remove most of them; `input[type=search]` should join the base input rule at `public/style.css:134`.

### 3.2 The preparation flow as a user experiences it

Preparing for Neeraj as White today means: Players tab, find Neeraj in a row of up to 80 buttons, open four accordions in turn (Preparation sheet, Repertoire book, Opening clash, Deep dossier), mentally discard the half of each that is about Neeraj as White, then go to Puzzles, Drills, and hope his punish drills come up. Section 4.3 A proposes the page that fixes this; the frontend-only pieces are:

- A colour toggle on the dossier (both, as White, as Black) driving the book tables, the clash (show one forest), the deep dossier, and the punish drills once the API supports it (4.3 C).
- A head-to-head block at the top of the dossier: record, the openings played, links to the games (4.3 G).
- The Players list as a table rather than a button row: name, federation, current Elo, games, book, prep status, last played, and a "prepare" action; sortable like the Games list. The green and yellow prep dots survive as a column.
- Print styling for the prep sheet (`@media print` hiding the chrome) and a "copy as markdown" button backed by a `GET /api/scout/:subject/card` twin of `/api/report/card`, so a coach can print or paste it (BRIEFING item 7).
- The clash tree needs a "main line only" toggle and a depth limit for reading on a phone; the full tree is fine on a laptop but unreadable at 400 px. Highlight the tree nodes on the line currently on the board.

### 3.3 Game, drill, and puzzle views

- A SAN text input next to the board (type `Nf3`, Enter) for drills, puzzles, and guess-the-move: faster for a 2000-rated player, works with a keyboard only, and is the accessible alternative to a pointer-only Chessground.
- Keyboard: the game view has arrows, drills have 1/2/3, puzzles have N. Add Space or Enter for "Show answer" and "Next moment", `f` for flip, and print the map in the footer of each panel. The drill "Show answer" is a mouse-only click today.
- Admin "viewing as" switcher in the top-bar menu (admin only): sets a `?user=` that `req()` appends to every call; needed for the admin to check a member's report or to seed and inspect their games. Two small changes: a `session.viewAs` in `api.js` and a menu row in `app.js` `renderWhoami`.
- Charts size themselves once from `clientWidth` (`public/charts.js:30,62,114`) and never re-render on resize or orientation change; a debounced `resize` listener per chart container (or a `ResizeObserver`) fixes the squashed graph after rotating a phone.
- The Home page tells a member with no games to "Import a PGN on the Games page" (`public/views/home.js:31`), which members cannot do; make the copy role-aware and, for members, point at "ask the admin to seed your games".
- The "Guess the move" recap is good. A per-game "what would an opponent prepare against me" card (the member's own scout projection already exists on the Players page) would fit the Report page as "How you look to opponents".

### 3.4 Accessibility, mobile, theming

- Contrast: `.chip.inaccuracy` and `.chip.warn` use a hard-coded `#a06a00` (`public/style.css:163,168`) which fails on the dark surfaces; define `--warning-text` per theme.
- Focus: buttons and chips rely on the browser default outline; add a visible `:focus-visible` ring using `--accent` so keyboard users can see where they are.
- The `<details>` accordions are keyboard-accessible and the toast and jobs areas have `aria-live`, which is good; the board wrapper has no label and no text alternative (the SAN input above doubles as the fix).
- PWA: the manifest and icon are there but there is no service worker. Caching the app shell plus the last `/api/drills?session=1` response would make drills usable in a tournament hall with no signal, which is exactly where a pre-game drill set is wanted (and the mirror is read-mostly, so the risk is low).

### 3.5 Testing the frontend

There are 200 server tests and none for the UI. Chromium and Playwright are available in this environment and the app needs no build step, so a smoke suite is cheap: start `server/serve.js` with a temp `DATA_DIR` seeded from `test/helpers.js` `makeGame` (write two analysed games and a drill store), then assert that Home renders the tiles, the Games list shows the rows, the game view mounts a board and opens a moment, and the Drills page reaches the grading buttons after "Show answer". Ten assertions cover every route and would have caught the kind of regression the accordion and paging changes risked.

## 4. Pedagogy: preparing a player for a new opponent

### 4.1 What the app does today

The pipeline for an opponent is: get their games (a FIDE-id-named export becomes a "book"; a pasted PGN becomes scout games; every opponent from own games is listed automatically), read the instant book dossier (current strength, trend, repertoire by colour with share and score, weighted to recent on-strength games), promote the recent subset for engine and coach analysis (error categories, phases, clock, prep-ends, recurring weaknesses, punish drills), generate the structured prep sheet, and open the opening clash (a transposition-merged tree of the student's openings against the opponent's replies with prep-end markers, optional engine extension and narration). Punish drills enter the spaced-repetition deck, and the game view lets the student guess the punishment in each scouted game.

This is a genuinely strong scouting stack. Its gaps are about assembly and evidence, not about missing data: almost everything below can be built from what is already stored, without a new dependency and without asking the model to evaluate anything.

### 4.2 Where it falls short

1. **No single "next game" view.** Preparation is spread over four accordions and a drills page with no notion of which game is next, in which colour, at what time control.
2. **Not colour-aware.** The book tables and the clash are split by colour; the deep dossier (error types, phases, patterns, clock) and the punish drills are not. Half of every dossier is about the colour the student will not face.
3. **Not student-aware.** Prep sheets are keyed by opponent and the clash is Kai's. In a three-member app "what you should play" cannot be the same sentence for everyone.
4. **The prep sheet sees a thin slice.** `prepSheetPrompt` (`server/prompts.js:325-355`) receives the analysed subset's 8-ply repertoire, categories, phases, patterns, and clock. It does not receive the whole-history book (`scoutDossier.repertoire` with share, score, last date), the clash's predicted lines (`clashPrincipalLines` already exists), the opponent's current Elo and trend, the rating gap, the head-to-head, or the student's own repertoire. Its openings table is therefore guesswork dressed as advice.
5. **Tendencies come only from labelled moments.** The categories are the coach model's labels on at most 50 games. Stronger and cheaper signals sit unused in the data: the per-move win-probability curve of every analysed game, and the full PGN of every book game (already parsed once by the clash job).
6. **No verification.** After the game nobody checks whether the predicted line held or whether the opponent erred where the sheet said. Prediction quality is never measured, so the thresholds cannot be tuned from evidence.
7. **Prep is not rehearsed as prep.** Punish drills are mixed into the general deck by due date; there are no flashcards for the predicted lines and no sparring from the predicted middlegames.
8. **Watch-fors are unverifiable prose.** The sheet's `watch_fors` and `exploit_plan` do not cite the moments or patterns they rest on.
9. **Time control is invisible.** Book records keep `event` but not `TimeControl`; a rapid-heavy export skews the "classical" profile.
10. **No head-to-head.** Previous games against the opponent are folded into the dossier as anonymous engine data instead of being shown as a record with openings and results.

### 4.3 Recommendations

**A. A "Prepare for a game" page** (`#/prep/<fideId>?color=white&tc=classical`). Backend: `GET /api/prep/:fideId?color=&tc=` composes existing builders into one payload: the prep sheet (B), the clash forest for that colour only, the colour-filtered deep dossier (C), the tendency profile (D), the head-to-head (G), form and current Elo, and a prep deck (E). Per-member `data/users/<id>/upcoming.json` stores `{ fideId, name, color, date, timeControl }` entries added from the Players page ("I play them on Saturday as White"). Home then shows "Next: Neeraj, White, Sat 10:00" with a progress line (sheet read, lines rehearsed 4 of 6, drills 8 of 12) and a 20-minute plan: five minutes on the sheet, five on the lines with the board, ten on drills. Everything on the page reads in the student's colour and the opponent's opposite colour, which is the single largest usability win available.

**B. Ground the prep sheet properly and make it per student.** Extend `prepSheetPrompt` with: the top five book lines per colour (share, score, last date, average opponent Elo) from `scoutDossier`; the top six `clashPrincipalLines` for the student's colour with their end reasons and, when extended, the engine eval; current Elo, one-line trend, and form (last ten games); the head-to-head record; and the student's own repertoire lines in that colour from `buildRepertoire({ userId })`. `prepSheetVersion()` already fingerprints the instructions and schema, so every existing sheet correctly shows "new format available". Key sheets by `${subject}|${userId}`, or split into a shared `profile` and a per-student `plan`; the second is cheaper to cache and to publish. Add citations: give every pattern and line an id in the prompt and require `exploit_plan[]`, `openings[]`, and `watch_fors[]` items to carry `evidence: [ids]`; the server keeps only items whose ids exist and the UI links each cue to its games. This is the same trick the clash narration already uses (ids in, prose out) and it turns the sheet from plausible prose into checkable claims.

**C. Colour split everywhere.** `buildReport({ purpose: 'scout', subject, color })` filters `games` by `playerColor`; `/api/scout/:subject?color=`; `buildRepertoire` already keys by colour. `dueDrills` and `visitorDrills` gain `subject` and `color` filters so "punish drills where Neeraj played Black" is one request. In the UI the toggle from 3.2 drives all of it.

**D. A deterministic tendency profile** (new `server/tendencies.js`, pure, no LLM, no engine):
- From the analysed games' stored `wpBefore`/`wpAfter` per move: conversion rate (games where they reached 75 percent win probability: share won), hold rate (games where they fell to 25 percent: share not lost), collapses (from 70 to 30 within ten plies) and comebacks, and the phase in which the evaluation turned. These are the real "conversion" and "defence" numbers and they do not depend on which moments the model labelled.
- From the book parse: `buildOpponentIndex` (`server/clash.js:99-134`) already parses every recent book game and stops at ply 20; walking to the end of each game costs the same 17 ms and yields game length, draw rate by colour, castling side and opposite-side castling frequency, queen-trade ply, first-capture ply, score against higher- and lower-rated opponents (`subjectElo` versus `oppElo`), score when out of their own book (games that left their top lines by ply 8 versus games that stayed in), and form (last ten games, games in the last 90 days). Store these as `features` in the same `data/clash.json` entry, which is already cached per book import and bundled to the mirror.
- Clock behaviour stays limited to analysed games with `%clk` (book exports rarely have clocks); say so in the tile.
Render as a tile row on the dossier and feed the numbers to the sheet (B). "Scores 31 percent when out of book by move 8" and "converted 5 of 11 winning positions" are the sentences a coach actually wants.

**E. A prep deck.** Three drill sources, all engine- or data-grounded:
- Line flashcards (`kind: 'line'`): for each student node along the top principal lines in their colour, "you are here against Neeraj, what do you play?" with the accepted answer being the student's own continuation, or at a prep-end leaf with engine extension, any engine-approved move within `WP_ACCEPT`. The `opening` drill kind (`server/drills.js:69-81`) is the template.
- Colour-filtered punish drills from (C), opening-phase first, ordered by the overlap between the drill position's `posKey` and the clash tree so the student rehearses errors in structures they will actually reach.
- Sparring from predicted middlegames: every prep-end leaf in the clash already carries a FEN; "play it out from here" against the engine at the opponent's `currentElo` reuses `/api/playout/*` unchanged.
Schedule the deck to be due before the game date rather than on the ladder, and mix it into the daily session at a higher ratio in the week before.

**F. Verify after the game.** When an own game against a scouted opponent is imported (`lookupFideId` already links names to ids), walk the clash forest with the game's moves and record on the game `prep: { fideId, leftTreeAtPly, by: 'student' | 'opponent', leavingSan, hadGames }`. Show it in the game Summary tab ("the prediction held for nine plies; Neeraj left it with 6...Bg4, which had no games in his book") and aggregate per opponent ("main line reached in three of four games"). Compare the game's explained categories to the sheet's `main_errors` for a second yes-or-no. This is small, deterministic, and it is the only way to learn whether `oppBranch`, `minShareOpp`, and the recency half-life are right.

**G. Head-to-head.** `gamesForSubject` already finds the student's games against the subject; return them as `headToHead: [{ gameId, date, color, result, eco, line, moments }]` from `/api/scout/:subject` and show the record, the openings that occurred, and links at the top of the dossier, before the sheet.

**H. Time control.** Store `TimeControl` and `Event` in book records (`server/scoutbook.js:66-86`), classify classical, rapid, and blitz (base time plus an event-name fallback), default the dossier and the clash index to classical, and expose the toggle. The current mixed profile is silently wrong for anyone whose export includes online rapid.

**I. Training-science upgrades** (general, but they raise what the student retains from prep):
- Confidence before the reveal (sure, likely, guess) stored in `reviews[]`; the report gets a calibration table and a "sure and wrong" list, which is the highest-value study list a player can have.
- Explain-back: on a miss, one line "what did you miss?" typed before the coach's key question appears, stored with the review; generation before feedback is the best-supported retention effect and it costs a text box.
- Per-drill ease (SM-2 lite) from the stored `reviews[].ms` and correctness, replacing the fixed ladder and its "minus two rungs" lapse rule (BRIEFING item 5; the data is accumulating already).
- Deterministic `time_pressure` (2.4) so the clock statistics in the sheet and the report agree.
- A "guess the opponent's move" mode on scouted games: predict what Neeraj played, scored by whether the guess matched his move (from the book) rather than the engine's. It trains modelling the person, which is what preparation is.

**J. Rating-gap framing.** Include the student's rating (their Elo header in recent games, then the roster) against the opponent's `currentElo` in the prompt, with the opponent's score against higher- and lower-rated players from (D). The sheet can then say "they score 62 percent against players 150 below them and 28 percent against players above: keep the game complex" instead of a style adjective.

### 4.4 Things not worth doing yet

- Online username import (BRIEFING item 4) adds clocks and volume but the FIDE-export path already covers the tournament opponents this app is for; do it after (A) to (F).
- Tablebase checks (BRIEFING item 6) matter for drill correctness in endgames but not for opponent preparation; keep them on the list.
- More narration. The clash notes and the prep sheet are enough prose; the next gains come from evidence and assembly, not from more model output.

## 5. Suggested order of work

1. **Fixes (about a day):** 2.1a stale-session 401 with a test; 2.1b import owner and member names; 2.1c per-game rating in prompts; 2.1d clash per viewer and the `kai` rename; 2.1f audit lock; the CI workflow.
2. **Prep foundations (two to three days):** colour filters (C); head-to-head (G); the eval-curve half of tendencies (D); time control in book records (H).
3. **Prep sheet v2 (one to two days):** grounding inputs and per-student key (B); evidence citations; markdown export and print CSS.
4. **Prepare-for-a-game page and prep deck (three to four days):** upcoming games, the composed endpoint and page (A); line flashcards, filtered punish drills, sparring from leaves (E); the book-parse half of tendencies (D).
5. **Verification loop (one to two days):** prediction hit on import and per-opponent hit rate (F).
6. **Platform (ongoing):** report and index caching (2.3); route split and shared helpers (2.4, 3.1); the Playwright smoke suite (3.5); SM-2 ease, confidence, and explain-back (I); SAN input and keyboard map (3.3); offline drills (3.4).

Each phase leaves `npm test` green and adds a CHANGES entry, per the repo conventions. Items in phases 2 to 5 change no prompt grounding rule: the model still sees only engine lines, real games, and computed numbers, and still never picks or evaluates a move.
