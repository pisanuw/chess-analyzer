# CHANGES

Newest first.

## 2026-09-10 (Opening Clash phase 2: interactive board)

- The clash tree now drives a read-only board: clicking any move shows that position with the last move highlighted, and the board flips to the side you would be playing (white forest orients White, black forest orients Black). The board and forests sit in a grid that collapses to one column on a phone. `scoutView` now returns a `{ destroy }` hook and holds the one Chessground instance in a ref, so the board is torn down on navigation and on every re-render (subject switch, prep-sheet regenerate, promote), with no leaked listeners. Frontend only.

## 2026-09-10 (Opening Clash phase 1: predicted, branching lines vs a scouted opponent)

- New Scouting card, "Opening clash: what they play against you", that crosses the player's own openings with a scouted opponent's whole book and predicts, as an alternating branching tree, how they would meet each line. The player's side comes from his analysed games (`analysis.moves[]`, no re-parse); the opponent's side from parsing every book game's full PGN (the book keeps only 10 SAN plies), weighted with `scoutDossier`'s exact recency scheme so a predicted reply's share reconciles with the repertoire book shown alongside. The tree is a position-keyed forest: transpositions merge on the same 3-field posKey used elsewhere, branching is capped (top 3 opponent replies, min 2 games, depth cap 20), and every node marks per side where a prediction runs out: `not faced` (opponent never reached the position), `book thins out` (too few games), and `your line ends` (the player has no game continuing). The white forest roots at the player's own opening menu; the black forest roots at the opponent's first move (they choose the opening), then the player replies. Verified on the real books: Neeraj 145 nodes, Nikash 49, and Kai's Caro-Kann shows correctly against both opponents' 1.e4.
- `server/clash.js`: `buildKaiIndex` (the player's opening moves by colour and position), `buildOpponentIndex` (parse and weight the book; yields to the event loop as it goes so a long parse never blocks the server), and `assembleClashForest` (the cheap DAG walk with caps and prep-ends). `GET /api/scout/book/:fideId/clash` returns `{ clash }` when the opponent index is cached and fresh, or `{ building, job }` while a new `clash` job rebuilds it. The expensive parse (about 3 seconds for Neeraj's recent games, since games outside the recency window are skipped before parsing) runs once per book import as a background job and is cached in `data/clash.json` (gitignored, like the eval cache and the book blobs); the tree itself assembles in about 1 ms per request. `api.scoutClash`, a lazy "Build opening clash" button that polls the job, and the recursive tree renderer live in `public/views/scout.js`; a small `.clash-tree` / `.chip.warn` block in `style.css`. `test/clash.test.js` (9 tests) covers both forests' root and mover, opponent branching with the min-count floor, both prep-end cases, colour handling when the player is Black, transposition merge, the deviation flag, White-POV evals, and param clamping.

## 2026-09-10 (Plan: Opening Clash, predicted lines vs a scouted opponent)

- Added `PLAN-opening-clash.md`, a detailed implementation plan for BRIEFING next-step 2 (repertoire clash / predicted opening): identify Kai's top openings per colour from his own analysed games, then build an alternating, branching, transposition-merged prediction tree of what a scouted opponent (Neeraj, Nikash) would most likely play against them, extended as deep as real games support and marked per node and per side where preparation ends. No code yet. The plan is grounded in the real data: it records the measured cold-parse cost (about 11.1 seconds for Neeraj's 647 games, so the opponent index is built once as a background job and cached, not parsed per request), Kai's actual opening counts, both opponents' first-move distributions, and that `scoreToCp` is exported from `analyze.js` while `stmSign` is not (a one-line export is a prerequisite for the optional engine phase). Phasing: a data-only core (no engine, no LLM, no board), then an interactive board, then engine-grounded leaf extension, then optional LLM narration. Reuses `scoutDossier` weighting so clash shares reconcile with the prep sheet, and keeps every prompt engine-grounded.

## 2026-09-09 (Scouting: hide "Analyse N recent games" when nothing is queueable)

- The Deep preparation promote button used to always read "Analyse N recent games" and, once every recent game was already imported, would report the confusing "0 queued, N already present". `GET /api/scout/book/:fideId` now returns a `promote` status (total / present / analysed / queueable, computed from the games index against the dossier's analysis subset). The button appears only when something is actually queueable, and its label uses that count ("Analyse N recent games", with "M of total already imported" when partway). When nothing is queueable, the card shows status instead: "All N recent games are analysed", or "M of N analysed, K still processing". After clicking, the view refreshes so the button disappears as the games enter the pipeline.

## 2026-09-09 (Prep sheet: regenerate when the format changed, not only for new games)

- The Regenerate button now also enables when the sheet's format or wording has changed since it was made, even with no new games. `prepSheetVersion()` fingerprints the schema plus `prompts/prep-sheet.md`; the fingerprint is stored on each generated sheet and returned by `GET /api/scout/:subject`. When the stored version differs from the current one (including any sheet made before this field existed, and any sheet made before a later edit to the instructions file), the card shows a "new format available" chip and the button reads "Regenerate (new format)". It stays disabled ("Up to date") only when there are no new games and the format matches. The fingerprint is null on the read-only mirror (the instructions file is not bundled there and it never regenerates), so the check is simply skipped.

## 2026-09-09 (Games list: numbered pages instead of "show more")

- The games list is now paged in fixed chunks of 50: page 1 is games 1-50, page 2 is 51-100, and so on, with a "Showing 51-100 of N" label, ‹ prev / next › arrows, and a windowed set of numbered page buttons (first, last, and a window around the current page, with ellipses so the bar stays short at many pages). "Show all N" still lists everything at once, and "Show in pages" returns to paging. Changing the filter, search, or sort resets to page 1, and the page clamps down if a filter shrinks the set. Frontend only.

## 2026-09-09 (Prep sheet: structured for scanning; instructions in an editable file)

- The prep sheet is no longer four prose blocks. `PREP_SHEET_SCHEMA` is now a `headline` (one-line pull-quote), a fixed-row `profile` table (style, strongest/weakest phase, main errors, time trouble, the same rows for every opponent so two players can be compared side by side), a numbered `exploit_plan` list, an `openings` table (when / you play / why, one row per line), and `watch_fors` cue bullets. The renderer detects the new shape and falls back to the old free-text layout for sheets generated before the change, so nothing already stored breaks.
- The generation instructions (who it is for, grounding rules, style rules, and the field-by-field structure) now live in `server/prompts/prep-sheet.md`, read fresh at generation time by `prepSheetPrompt`. Tune the sheet by editing that file and clicking Regenerate: no code change and no restart. The file is home-machine only (prep sheets are never generated on the read-only hosted mirror), and the read uses `process.cwd()` to stay free of `import.meta`.
- `style.css`: headline pull-quote, numbered-list, and compact in-panel table styles, all inside the dyslexia-friendly `.prep-sheet` reading panel (tables wrap rather than scroll on a phone).

## 2026-09-09 (Scouting: disable a no-op Regenerate; rating trend as a graph)

- The prep-sheet "Regenerate" button is now disabled when a sheet already exists and no games have been analysed since it was made (regenerating would produce the same sheet). It reads "Up to date with all analysed games" in that case, and re-enables as "Regenerate (N new)" once new games finish. Frontend only.
- "Rating over time" in the repertoire book is now a small line graph (reusing the existing `lineChart`) instead of a row of "year: elo" chips. The y-axis is padded around the player's own min/max and snapped to 50s so the trend fills the plot; hovering a point shows the game count for that year.

## 2026-09-09 (Prep sheet: legible, dyslexia-friendly reading panel)

- The scouting prep sheet is the one block a player actually reads at the board, so it now renders in a dedicated reading panel (`.prep-sheet`) tuned for legibility: an open sans-serif stack (Lexend / Atkinson Hyperlegible / Verdana / Arial, falling back to system-ui, no web-font download), 16px text at 1.6 line height with a little letter/word spacing, lines capped near 60-70 characters (`max-width: 62ch`), left aligned (never justified), and a soft low-glare background (cream in light mode, a warm dark surface with off-white text in dark mode). The four inline `<b>label:</b>` runs became block headings (not the uppercase site `h3`), and "Watch for" is now a real bulleted list.
- To back the list, `watch_fors` in `PREP_SHEET_SCHEMA` changed from a prose string to an array of 3-5 short cues; the renderer handles both so already-generated sheets still display. The prep-sheet prompt now asks for short sentences and active voice ("attack the isolated pawn", not "the pawn should be attacked") and to avoid jargon and double negatives, so the copy itself reads plainly.

## 2026-09-09 (Games page controls; hosted mirror bundles scout data)

- Games page: the single "Analyse and explain everything pending" button is split into "Analyze pending" and "Explain pending"; every row has a checkbox with a select-all header and a bulk action bar (Analyze / Explain / Delete, delete confirms); every column header is sortable (dates sort on a numeric key so non-zero-padded PGN dates order right). Frontend only. `analyseAll()` takes an options object so "Analyze pending" queues analysis without explanations.
- Hosted mirror: added `data/scouts/*.json` and `data/players.json` to the function's `included_files` in `netlify.toml`, so a republish surfaces the scout book dossiers and FIDE-id map (previously only `data/games`, patterns, and prepsheets were bundled). The mirror is deployed with `scripts/publish-web.sh` (Netlify CLI, not a git-linked build), so new opponents appear only after `npm run publish-web` re-runs. Note the scout books carry full PGN, so bundling them grows the function; slim to dossier-only if it gets large.

## 2026-09-09 (FIDE ids shown in Scouting; config; first real dossier runs)

- The Scouting view now shows each opponent's FIDE id (linked to their ratings.fide.com profile) and federation in a per-subject header, and the subject list shows the federation as the at-a-glance "linked" signal; the book icon is reserved for opponents that actually have a scouting book (it previously showed for anyone with an id, misleading after bulk linking). Frontend only, no restart needed.
- `scoutAnalyseCount` default raised 30 -> 50 (promote analyses the 50 most recent on-strength games). `downloaded/` is gitignored, and `scouts/` was added to the data-repo ignore list (`ensureDataIgnores`) so the per-opponent book PGN blobs never sync between machines.
- note: first real opponent dossiers were run this session. Harish Neeraj (FIDE 30958130): 50 recent games promoted and analysed across the 22 UWB VPN engines with claude-CLI explanations. Vemparala Nikash (FIDE 30960967): 466-game book imported (current ~2242), 49 recent games promoted. The shared analysis queue was still draining at session end; the server (`npm start`) was left running.
- note: a one-off bulk FIDE resolution linked ~80 players into `data/players.json` (70 unambiguous single-match auto-links, Kai = 39904881, 8 homonyms chosen by matching the opponent's recorded game rating to the closest FIDE candidate). Three held back for a manual pick: Liu Austin, Xiong Michael, Kwiatkowski Maciej. There is no unlink/replace UI yet, so correcting a wrong link means editing `data/players.json`. Also deleted a corrupt own game (6a7c95314964, Pappier vs Kai) whose PGN left queens on the board after a trade.

## 2026-09-09 (opt-in FIDE id lookup from the official rating site)

- A "find FIDE id" action on any unlinked opponent in the Scouting view searches ratings.fide.com by name and returns candidates (name, title, federation, standard rating, id, profile link) to confirm by hand. Picking one records the chosen id against both the local name spelling and FIDE's canonical name in the players map, so a differently-spelled opponent then merges with their scouting book and your games against them. This is the only third party the app contacts besides the claude CLI, strictly on an explicit click, never at import: auto-matching by name is too ambiguous to trust.
- Reverse-engineered the site's own search XHR (`GET incl_search_l.php?search=<name>&simple=1` with `X-Requested-With: XMLHttpRequest`; the columns are id, name, title, wtitle, federation, standard, rapid, blitz). Optional profile verify reads the canonical name off `/profile/<id>`. New `server/fide.js` (pure `parseFideSearchHtml` plus `searchFide`/`fideProfileName`), routes `GET /api/fide/search` and `POST /api/players/link`, a candidate picker in `public/views/scout.js`, and `test/fide.test.js` plus a hermetic link-route test (127 tests pass). Verified live: "Harish, Neeraj" resolves to 30958130 (CM, USA, 2250); searching "Pisan" surfaces Kai at 39904881.

## 2026-09-09 (players map: learn name <-> FIDE id from PGN tags)

- A local `data/players.json` now maps names to FIDE ids, so opponents key on a stable id instead of a drifting name string. Associations are learned only from data already on the machine: FIDE ids that tournament exports put in PGN tags (`WhiteFideId`/`BlackFideId`, matched case- and punctuation-insensitively) and the FIDE id of each scouted book. No network calls: resolving an id for a player who has no tag anywhere is the opt-in FIDE-lookup step, deferred by design (auto-scraping FIDE would break the local-first principle and name search is too ambiguous to trust automatically).
- The game index now carries each side's FIDE id and a scout game's `subjectId`, and the Scouting subjects list keys each opponent by FIDE id when one is known (tag, book, or the players map), merging a book with the own-game opponent it describes into one entry. Verified on real data: Harish Neeraj's 647-game book and Kai's one existing game against him now collapse to a single FIDE-keyed subject. Learned from both imports and a cheap startup backfill (`syncPlayers`, reads the index, no full-file reads). `players.json` syncs between machines (small shared reference data).
- New: `server/players.js` (assoc/lookup/merge/backfill), `fideIdFromHeaders` in `pgn.js`, `getPlayers`/`savePlayers` in `store.js`, `GET /api/players`, startup `syncPlayers` in `serve.js`, `test/players.test.js` plus an import-learns-ids API test (123 tests pass). Known gap: names that differ in spelling only merge when a shared FIDE tag or a manual alias links them; Kai's own tournament PGNs carry no FIDE tags, so the opt-in lookup is the next step to tag the rest.

## 2026-09-09 (scout a specific opponent from a large per-player export: the book tier)

- Preparing against one opponent now starts from their whole game history, not a handful of hand-picked games. A metadb/ChessBase-style export (filename carries the FIDE id, e.g. `HarishNeeraj_FIDE30958130_Total_739_Games_NoBlitz.pgn`) imports into a new compact "book" tier: one file per opponent at `data/scouts/<fideId>.json`, keyed by FIDE id, holding SAN openings, headers, and the full PGN per game, but no engine or LLM work. Instant, and it covers hundreds of games without burying the player's own games or flooding the analysis queue (the main game store stays capped at 500).
- The book yields a recency- and rating-weighted dossier (`server/scoutbook.js`, `scoutDossier`): the opponent's current strength (median of recent rated games), peak, rating trend by year, and their repertoire as White and Black with per-line share, score, and typical opposition. Recency is an exponential decay (half-life ~18 months); games older than 3 years or more than ~200 Elo off current strength are set aside, because they describe a different player. All four knobs are settings (`scoutMaxAgeYears`, `scoutEloBand`, `scoutHalfLifeDays`, `scoutAnalyseCount`).
- Two tiers, so the expensive work stays small: the book is engine-free and whole-history; a "Analyse N recent games" button promotes only the recent, on-strength subset (default 30) into the existing scout pipeline (`POST /api/scout/book/:fideId/promote`), which lights up the error dossier, clock profile, prep-ends, recurring patterns, punish drills, and LLM prep sheet already built for scouting. Promoted games carry `subjectId` (FIDE id) alongside the name, so the existing name-keyed scout machinery is unchanged.
- FIDE id is the stable subject key: the export filename supplies it, and the subject's side within each game is found by exact name match (not substring, which would wrongly catch e.g. "Karthikeyan, Harishkumar" when scouting "Harish, Neeraj"). Chess960 "Freestyle" games and odd PGNs are skipped and counted. Dates are parsed numerically, fixing a non-zero-padded PGN-date sort bug ("2026.9" would have ranked above "2026.10").
- New: `server/scoutbook.js`, store helpers (`getScoutBook`/`saveScoutBook`/`listScoutBooks`, `data/scouts/`), routes `POST /api/scout/import`, `GET /api/scout/book/:fideId`, `POST /api/scout/book/:fideId/promote`, FIDE books folded into `GET /api/scout`, import-card detection of FIDE exports in `public/views/games.js`, a book dossier + promote button in `public/views/scout.js`, and `test/scoutbook.test.js` plus a scout-book API test (118 tests pass). Verified against the real 739-game export: 647 standard games booked, current ~2201, main White weapon the Najdorf (B90), weak as Black in the Sveshnikov (B33, 22%).

## 2026-09-08 (clear the import.meta warning on publish for good)

- The Netlify publish still warned `"import.meta" is not available with the "cjs" output format` even after the function was renamed to `.mjs`: the esbuild bundler emits CJS regardless, and three server files referenced `import.meta.url` (`server/index.js` and `server/store.js` for ROOT, plus the run-directly guard). Removed all three from the bundled graph. ROOT is now `process.cwd()`, which is behavior-preserving: in the CJS bundle `import.meta.url` was already empty, so the code was running the cwd fallback anyway, and every supported entry (npm start, tests, the function) has its working directory at the repo root. The listen bootstrap moved to a new CLI entry `server/serve.js`, so `server/index.js` is now a pure app module (exports `app`, no listen, no import.meta) that the tests and the Netlify function import cleanly. `npm start`/`npm run dev` now run `server/serve.js`. Verified: bundling the function to CJS with esbuild produces zero import.meta warnings.

## 2026-09-08 (Puzzles tab: free-solve positions from your games)

- New Puzzles tab, a free-solve counterpart to Drills. No spaced repetition and no server writes (a plain GET, so it works on the read-only hosted mirror too): find the move, keep a session streak, move on. Three switchable sources: "Decisive tactics" (winning shots from every analysed game, both sides and both your games and opponents'), "Critical moments" (the flagged pool Drills draws from, own games only), and "Missed tactics" (winning tactics you had on the board but did not find, own games only).
- All puzzles are derived from data already stored per move (position, engine best move, MultiPV lines with evals), so there is no new engine or LLM work. Decisive-tactic detection is engine-only: a forced mate, or a clearly winning move (66+ win-% for the mover) that beats the alternatives by 20+ win-% so finding THE move matters, skipping the first few book plies. Correctness reuses the same win-probability acceptance band as Drills (`acceptedLines`, now exported from `server/drills.js`). New `server/puzzles.js`, `public/views/puzzles.js`, `GET /api/puzzles?source=&limit=`, and `test/puzzles.test.js`.

## 2026-09-08 (simpler, mobile-friendly hosted mirror)

- The hosted read-only mirror no longer shows controls that cannot work there. Settings is dropped from the nav and the route redirects to Home (no engine, no LLM, and settings writes are blocked anyway, so the Stockfish path, remote-hosts, "use this machine as an analysis engine too", thresholds, and LLM provider had nowhere to go). The "Generate prep sheet" (scout) and "Synthesize pattern" (report) buttons, which POST to endpoints the mirror blocks with 405, are hidden too and replaced with a short "generated on the home machine" note. Local use is unchanged: everything still appears when not read-only.
- Mobile layout: the top nav wraps instead of overflowing, wide tables (the games list especially) scroll sideways within their card rather than crushing columns or the viewport, inputs use 16px so iOS Safari does not zoom on focus, tiles and the board reflow to one column, and toasts span the width. The board, game, and drill layouts already collapsed to a single column on narrow screens.

## 2026-09-08 (remaining code-review items: pedagogy, robustness, aggregation)

Pedagogy:
- Critical-moment selection gained a contestability floor: a move is only a moment when the mover's win probability before it was at least 15%, so a further loss in an already-lost position is no longer surfaced as a coachable mistake (the winning side is kept: throwing part of a win is a conversion lesson).
- Drill scheduling softened: a lapse drops two ladder rungs instead of resetting to day one, and a correct first-try guess seeds one rung up, not two. A drill missed 3+ times shows a leech hint next to Suspend. Follow-up depth in drills is varied (max or one shorter) so reps train the method, not a fixed move sequence.
- Closed the loops on data that was collected then discarded: quiet-position (decoy) outcomes are persisted and the false-positive rate is reported; drill stats break down by kind (find-best / see-the-threat / punish / opening); the report annotates each focus area with its trend and prefers a worsening one in the daily prescription.
- New Home dashboard (now the default route): drills due with a Start-session button, average accuracy, a day streak, the trend-aware focus area, latest game, and an accuracy sparkline. The report gained a "What's going well" section so it is not only deficits.
- Own-game explanation prompts now include the engine's lines from the position right after the played move, grounding the concrete threat behind a tactics-allowed or defence verdict; the whole-game debrief uses its own system prompt.

Robustness and correctness:
- Engine pool: if every engine dies mid-job with work left, a fresh local engine is spawned once to finish the game rather than aborting it.
- Report aggregation fixes: endgame trouble spots rank by distinct-game recurrence (not raw moment count); first-try guesses fold into drill stats; the recognition-speed median averages the two central values on an even sample; phaseOf no longer misfiles a queenless full-board middlegame as an endgame; a forced mate accepts only other mating moves in drills.
- Eval cache keys on the first four FEN fields (transpositions share entries) and flushes on a debounce plus at job end instead of rewriting the whole map per miss.
- Prompt inputs (PGN headers, opponent names) are whitespace-collapsed and length-capped; manual-explanation fields and the playerNames/remoteHosts arrays are clamped. Batch explanation now bills only usable batches and logs the match rate; the retry backs off longer on a rate/usage limit.
- Frontend: fetch failures surface as a typed "cannot reach the server" with a Retry button; a mid-session 401 no longer renders a dead error card under the login overlay; Analyse/Explain/Import/Analyse-all buttons lock while in flight; charts carry role/aria-label and job/toast regions are aria-live; board.js warns on a FEN/side mismatch; job completions are announced app-wide.

Deferred: a batch path for the manual-LLM paste flow (secondary path; per-moment copy/paste still works), and the fitted per-drill ease model (BRIEFING next step 3; the lapse/seed softening is the groundwork).

## 2026-09-08 (correctness and security fixes from the code review)

- Login throttle now actually binds on the hosted mirror. The per-IP attempt counter keys on the real client (Netlify's `x-nf-client-connection-ip`, else the socket address) instead of the client-supplied `X-Forwarded-For`, whose leftmost hop could be rotated for a fresh bucket per request; and it lives in the shared Supabase store when configured, so the 20-per-hour limit holds across the otherwise memory-isolated serverless instances (in-process fallback locally and whenever the store is unreachable, so a storage hiccup never locks anyone out). A short `APP_PASSWORD` now warns at startup.
- Engine analysis no longer fabricates a 0.00 evaluation when a search returns no score lines. A healthy Stockfish always emits a scored line before `bestmove`, but a remote ssh pipe can drop info lines while still delivering `bestmove`; that empty result was being stored as dead-equal and silently corrupting evalBefore/evalAfter, win-probability loss, ACPL, and judgment for the two straddling moves. The position is now re-searched once and the whole job fails loudly if it still yields nothing, rather than persisting a phantom evaluation.
- PGN import is bounded to 500 games per request, rejected (413) after a cheap split and before the synchronous parse, so a huge paste can no longer block the event loop and flood the one-at-a-time job queue.
- Drills: an off-list guess that needs a quick engine check no longer reveals a provisional "miss" that a fast grade could persist (mis-scheduling the ladder) while the engine was still deciding. The answer is shown in a non-gradeable "checking" state until the paired eval settles, then graded on the real verdict, matching the guess-first flow.
- Guess-the-move: locks the current guess before the first `await` so a rapid second drag cannot double-submit and advance the move pointer twice.

## 2026-09-08 (offload analysis fully to remote engines)

- New "Use this machine as an analysis engine too" switch (Settings, on by default). Turn it off to keep the local machine out of the analysis pool: it only coordinates dispatch and runs the LLM explanations while the remote hosts do all the engine work. It rejoins the pool automatically if no remote host is reachable, so analysis never stalls, and the sparring engine (drills, play-out) is always local so interactive features stay responsive.
- Remote paths that point at a directory now resolve `stockfish` or the first `stockfish*` binary inside it (the official release is named e.g. stockfish-linux-x86-64-universal), so the default `~/stockfish` works against an extracted release directory.

## 2026-09-08 (distributed engine analysis over ssh)

- Analysis positions now fan out across a pool of engines: the local Stockfish plus one per configured remote host, driven over plain ssh (`ssh host stockfish` is itself a UCI engine on stdio, so the remotes need no daemon and no admin access, just a binary and key auth). Work-stealing dispatch: fast machines take more positions, a dying machine's position is re-queued on the survivors, and the last-engine failure fails the job as before. Remote searches run under `nice -n 19` with modest threads since the hosts are shared lab machines.
- New settings: remote hosts list, Stockfish path on the hosts (binary or directory), threads per host; a "Test remote hosts" button probes every host in parallel and reports reachability. When every host is unreachable the job carries a VPN hint (the tunnel being down is likelier than 22 dead machines) and analysis proceeds locally; unreachable hosts get a 5-minute cooldown so they cannot stall each job with fresh probes.
- Engine class accepts a command plus args and keeps the last stderr line for error messages, so transport failures read as "Connection timed out" instead of "process exited". Job progress with a pool counts completed positions (the per-search depth readout only applies to a single engine working front to back) and shows the engine count; the eval cache checks every engine name in the pool on lookup and stores under the analysing engine's name.

## 2026-09-08 (report links into practice, docs)

- Focus-area cards on the report link straight into category rounds ("Drill this"), and drill performance shows the machine count plus a recognition-speed table (median answer time per pattern, once a pattern has 3+ timed reviews).
- README, BRIEFING, and CLAUDE.md updated for the whole 2026-09-08 review batch (shared module, threshold re-scoring, eval cache, batched explanations, drill store upgrades, decoys, opening drills, re-explain, mirror polling, drill protocols, guess the move).

## 2026-09-08 (guess the move for whole games)

- "Guess the move" in the game view: replay an analysed game predicting every one of your own moves. Each guess is scored in win-probability (your game move scores its known loss, stored engine lines score exactly, off-list guesses use the paired quick eval when an engine is present, unscored on the mirror), and the game continues as it actually went after each guess. The recap compares the replay's total loss against what the game itself lost on those moves. Old-school active recall over the whole game, and a second serving of quiet-position detection practice.

## 2026-09-08 (drills match the error being trained)

- Play-out drills: conversion, defence, and endgame-technique drills are now played OUT against the sparring engine (at the player's rating) instead of answered with one move, which cannot train a skill that lives across many moves. Pass = winning chances held within the usual 3-point band (mate/stalemate/draw scored 100/0/50, so defending a lost position to a draw passes); verdict from the full-strength assess endpoint, evals hidden until then. Honest grading applies as usual, and a one-move fallback button remains. Only in normal sessions with a local engine; practice rounds and the mirror keep single-move form.
- Calculation drills walk the engine line deeper (up to 4 follow-up moves instead of 2): the original failure was miscalculating a line, so the drill demands the line.
- Timed mode: drills whose moment was flagged time-pressure (or played under 2 minutes) offer an opt-in 30s countdown; running out counts as a miss. Rehearses deciding fast, which untimed reflection does not.
- A missed drill now shows the synthesized pattern note (rule + triggers) for its pattern right under the verdict: the moment of failure is when the transferable lesson lands.
- Category rounds in the UI: `#/drills?category=...` mirrors pattern lightning rounds; a "Today" line on the Drills page prescribes the heaviest pattern round and top focus-area round from the report.
- Session quality of life: Undo last grade (reverts the review and returns to that drill), Suspend drill on the reveal screen with a Restore-all control on the end-of-queue screen, per-answer time shown on reveal, and the recap includes average answer time.

## 2026-09-08 (frontend platform: mirror polling, PWA, name dialog, guess retry)

- The hosted mirror no longer polls `/api/jobs` every few seconds: jobs live in a function instance's memory, so the answer was guaranteed empty and each poll was a Netlify invocation and phone battery (an open tab was ~17k invocations/day). Polling now starts only when `/api/status` says the backend is writable; on the mirror the drill badge refreshes per navigation instead of on a timer.
- PWA basics: a web manifest and an SVG icon, so the mirror installs to a phone home screen as an app.
- Fixing player names uses a proper dialog (Escape cancels, matches the promotion picker style) instead of three chained `window.prompt` calls.
- Guess-first in the game view: the panel no longer prints the position eval while guessing (knowing "you are much better here" answers half the question; the clock stays, it is context). A missed first attempt now earns exactly one retry with the engine lines still hidden; an off-list retry that the quick eval calls playable settles as revealed. Both attempts are recorded, so the first-try drill boost is unaffected.

## 2026-09-08 (re-explain unhelpful explanations)

- A "not really" vote on an explanation now offers a Re-explain button (game view): `POST /api/games/:id/moments/:ply/reexplain` re-runs the moment with the rejected text quoted in the prompt ("rated NOT helpful ... do not repeat the old wording") and replaces the stored explanation. The vote is cleared so the new text starts unrated, and drills re-sync in case the category changed. Blocked in manual mode and on the read-only mirror (no CLI there); the report's list of unhelpful moments links straight to where the button lives.

## 2026-09-08 (detection training: quiet-position decoys, opening prep drills)

- Decoys: drill sessions (not the badge poll) now mix in quiet positions from the player's own games, roughly 1 per 4 due drills, never first in the queue. A decoy is a position he HANDLED (judgment best) where the stored lines show a real way to go wrong (10+ win-prob spread); it is asked exactly like a normal drill and accepts his actual game move. Every stored drill is a position where an error is known to exist, so the deck alone teaches "there is always something here" and does the hardest real-game skill, spotting the critical moment, for the player; decoys train that detection. They are ephemeral (never stored, never graded into the ladder) and the session recap reports the detection rate separately.
- To keep detection honest, the guessing panel no longer shows the judgment or category chips for plain drills ("blunder" or "tactics-allowed" answers the question before the player does); they appear on reveal. Punish and threat drills keep their framing, which is inherently explicit.
- Opening prep flashcards: the repertoire's "prep ends" deviation (first opening move off the engine list or losing 10+) becomes an `opening`-tier drill when it cost at least 5 win-prob points without reaching the moment threshold. One per game, pruned automatically when a re-analysis moves or heals the deviation. Serves after core drills, before sharpeners.
- Drill reviews now carry the answer time captured in the view (see the drill store entry below).

## 2026-09-08 (drill store: think time, undo, suspend, category rounds, cross-machine history)

- Every drill review now records the time from seeing the position to answering (`ms` in `reviews[]`), plus the ladder position it advanced from. Recognition speed is the real signal of pattern acquisition and the raw material for the planned per-drill ease fit; it cannot be backfilled later.
- Undo (`POST /api/drills/:id/undo`): pops the last review and restores the recorded ladder position, for fat-fingered grades.
- Suspend (`POST /api/drills/:id/suspend`): parks a mis-tagged or resented drill out of every queue while keeping its history; `restore-suspended` brings everything back due. Suspension survives re-syncs.
- Category rounds: `/api/drills?category=...` serves every drill of an error type back to back (due or not), the same blocked-practice semantics as pattern lightning rounds. Report focus areas can now link straight into practice.
- Review history survives a dead machine: every local drill save also mirrors the store to `drills-<hostname>.json`, which the data repo syncs (drills.json itself stays per-machine). Other machines read the mirrors as foreign, read-only history; the report merges them into drill stats (with a machine count) and adds per-pattern median answer speed once a pattern has 3+ timed reviews.
- All drill mutation routes stay writable on the hosted read-only mirror (they are training state, like reviews).

## 2026-09-08 (whole-game explanation batches, CLI retry)

- Explanations for a game's moments now go out as ONE claude CLI call when 2 or more are pending: the shared game context is stated once, each moment keeps its own engine lines, and the reply is an explanations array keyed by ply (`momentsBatchPrompt` / `scoutMomentsBatchPrompt` + `batchExplanationSchema`). A 6-moment game drops from ~7 minutes of sequential calls toward the cost of one. Entries that come back missing or invalid (unknown category, empty fields) fall through to the existing per-moment loop, which is also the retry path if the batch call fails; per-moment writes keep their per-step crash safety.
- Per-moment and summary calls retry once (2s pause) on transient CLI errors instead of failing the whole job at moment 5 of 6.
- prompts.js refactored around shared section builders (`momentSection`, `scoutSection`, `gameLine`); single-moment prompt text is unchanged in substance.

## 2026-09-08 (opening eval cache)

- Engine evaluations of the first 20 positions of each game are cached in `data/evalcache.json`, keyed by engine name, depth, MultiPV, and FEN (capped at 4000 entries, oldest out). Multi-game tournament imports stop re-searching the same repertoire moves at full depth; a changed engine or setting simply misses the cache. Per-machine derived data, ignored by the data repo, safe to delete.

## 2026-09-08 (threshold tuning without re-analysis, snappy quick evals, tmp hygiene)

- Changing the critical-moment threshold now re-scores every analysed game in place: moments are re-derived from the stored per-move analysis (no engine, no LLM), explanations are kept (also for plies that drop out, so lowering the threshold restores them), and status falls back to 'analysed' when a new moment lacks an explanation. Changing either threshold re-syncs drills immediately instead of at the next restart. This unblocks threshold tuning, which previously required force re-analysis and re-bought every explanation.
- Off-list quick evals (`/moments/:ply/eval`) moved from the shared analysis engine to the sparring process, with LimitStrength forced off. On the shared engine a drill answer queued behind a background job's current deep search, and the job then queued behind the answer.
- Leftover atomic-write `*.tmp` files (crash between write and rename) are swept at startup; when `data/` is its own git repo, `*.tmp` and `evalcache.json` are appended to its .gitignore so `push-data`'s `git add -A` can never sync them.
- Settings form ranges now match the server's clamps (depth 4-40, MultiPV up to 6, thresholds 1-100, rating 400-3500), and saving reports how many games were re-scored.

## 2026-09-08 (shared chess-math module)

- New `public/shared.js` holds the helpers that were duplicated between server and frontend with "keep in sync" comments: `winProb`, `WP_ACCEPT`, `formatEval`, `parseTimeControl`, and the time-spent-per-move calculation (previously implemented three separate times in prompts.js, report.js, and charts.js). The server imports the file directly (plain ESM, no browser APIs); `analyze.js` and `pgn.js` re-export so existing imports keep working, and `api.js` re-exports for the views. No behaviour change intended; covered by test/shared.test.js.

## 2026-09-08 (training: threat drills, play-it-out, lightning rounds, question-first, feedback, prep card)

- See-the-threat drills: a tactics-allowed moment now creates a second drill from the position AFTER the mistake, played from the opponent's side (find the punishment you overlooked) but oriented from the player's side of the board, where threats must be spotted. Created once the moment is explained; removed if a re-explanation changes the category.
- Play it out: from any revealed critical moment, finish the position against a strength-limited Stockfish (UCI_Elo, defaults to the opponent's rating, editable 1320-3190). Runs on a separate one-thread engine process so analysis jobs never block a human. Evals stay hidden while playing; "Assess position" gives a full-strength verdict comparing your winning chances now vs at the start. Trains conversion, defence, and endgame technique, which single-move drills cannot.
- Pattern lightning rounds: the report's recurring patterns link to `#/drills?pattern=...`, which serves every drill of that pattern back to back (blocked practice). Practice passes do not advance the spaced-repetition ladder; a miss still resets its drill.
- Question-first hints: from the second review of a drill, the key question is no longer shown automatically; the player is invited to form the question themselves, then compare with the coach's. Generating the question is the transferable habit.
- Explanation feedback: a helpful / not-really vote on every explanation (game view and drills), stored per machine alongside reviews (Supabase on the mirror). The report shows the tallies and lists the moments worth re-explaining, so prompt tuning can follow real use.
- Pre-tournament card: `GET /api/report/card` renders a one-page markdown card (focus areas, synthesized pattern rules, clock line, study list); download button on the Report page.

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
