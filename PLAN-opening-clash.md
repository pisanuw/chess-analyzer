# Plan: Opening Clash (predicted lines vs a scouted opponent)

Status: proposed, not yet built. Owner: home machine (needs Stockfish for the optional engine phase, the claude CLI for the optional narration phase; the data-only core needs neither). This is the concrete design for "Next steps" item 2 in BRIEFING.md (repertoire clash / predicted opening).

## The question this answers

A player preparing for a specific opponent wants to know: "I am likely to open with one of my usual lines. What will this opponent most likely play against it, how far can I trust that prediction, and where does their preparation (or mine) run out?"

Concretely, for Kai versus an already-scouted opponent (Harish Neeraj, FIDE 30958130, 647 booked games; Vemparala Nikash, FIDE 30960967, 466 booked games):

1. Identify Kai's most-played openings, per colour, from his own analysed games.
2. For each, simulate the opponent's most likely replies, weighted by how recent and on-strength their games are (the same weighting the prep sheet already uses).
3. Extend the line as an alternating tree: Kai's move, opponent's reply, Kai's move, and so on, as deep as real games support it.
4. Branch on multiple plausible replies at each opponent decision, capped so it stays readable.
5. Mark, per node and per side, where preparation ends: where Kai leaves his own repertoire, and where the opponent has either no games or too few to trust.

### Worked example (real data, verified 2026-09-10)

Kai's opening counts from his 91 analysed own games:

- As White (45 games): `d4` 26, `c4` 8, `e4` 7, `b3` 3, `Nf3` 1.
- As Black (46 games): `1...c6` (Caro-Kann) 19, `1...Nf6` 13, `1...d5` 7, `1...c5` 4, `1...e6` 2, `1...e5` 1.

Both opponents open mostly `1.e4` as White (Neeraj 246 of ~320 White games, Nikash 159 of ~226). So the single highest-value clash line is Kai's Caro-Kann against their `1.e4`: it is Kai's most-played Black defence and the move they play most often. That subtree will be deep and well supported. By contrast, a Kai sideline such as `1...c5` (4 games) against an opponent line they rarely faced will bottom out in one or two plies. Both outcomes are correct signal; the design surfaces the difference rather than hiding it.

## What already exists and what is genuinely new

Reused as-is:

- `server/repertoire.js` `buildRepertoire({purpose, subject})`: groups analysed games by `colour|posKey` (position after 8 plies, transposition-merged), returns the top line per group with score, accuracy, and a `prepEndsPly`. Good for the top-openings summary; not a branching tree.
- `server/scoutbook.js` `scoutDossier(book, opts)`: recency (half-life 540 days) and rating (band 200, max age 3 years) weighting of an opponent's book into a per-colour repertoire with `share`, `scorePct`, `avgOppElo`. Exports `pgnToDate`, `ageDays`. `resultScore` is re-exported from `server/report.js`.
- `server/pgn.js` `parseGame(pgn)`: returns `{ id, headers, moves[] }` where each move has `{ san, uci, fenBefore, fenAfter }`. This is the only way to get an opponent's moves past ply 10.
- `server/store.js`: `getScoutBook`, `listGames`, `getGame`, `writeJson`, and the `getPrepSheets`/`savePrepSheets` pattern to copy for a new derived store.
- `server/enginepool.js` (`getEnginePool`, `poolAnalyse`), `server/engine.js` `Engine.analyse(fen, {depth, multipv, searchMoves})`, `server/evalcache.js` (`evalCacheKey`, `getCachedEval`, `putCachedEval`, `flushCache`, `CACHE_PLIES = 20`), `server/jobs.js` (`enqueue`, the sequential `pump` loop), and `server/analyze.js` `scoreToCp`.
- Frontend: `public/api.js` (the `api` object, `busy`, `toast`, `esc`), `public/board.js` (`Board` class, `walkSans`, `lineShapes`), `public/shared.js` (`winProb`, `formatEval`, `WP_ACCEPT`), and the rendering idioms in `public/views/scout.js` (`renderDossier`, `bookSection`, module-local `fmtLine`/`lichess`, delegated click wiring).

Genuinely new (the reason this is a feature, not a config change): the existing repertoire and dossier builders stop at 8 to 10 plies and keep only the single most common move order. They cannot express a branching, alternating, deep tree. That requires:

- Walking full move lists: Kai's side from `g.analysis.moves[]` (no re-parse needed, the moves carry `uci`/`san`/`fenAfter`/`evalAfter`), the opponent's side by parsing each book game's stored full `pgn` (the book keeps only 10 SAN plies in `line[]`).
- A position-keyed directed graph so transpositions merge at every ply.
- Per-node, per-side preparation-end detection.

## Data sources and their shapes

- Kai own games: `data/games/<id>.json`. Use `listGames()` filtered to `purpose === 'own'` and `status` analysed or explained, then `getGame(id)`; keep those with `playerColor` and `analysis`. Each `analysis.moves[i]` has `ply, moveNumber, color ('white'|'black'), san, uci, fenBefore, fenAfter, evalBefore, evalAfter (White POV cp), loss, accuracy, judgment, phase, isPlayer, playedRank, lines[]`. This is deep and free (already computed).
- Opponent book: `data/scouts/<fideId>.json` = `{ fideId, name, aliases, games[], total, importedAt }`. Each game: `{ id, date ('2026.7.29', unpadded), event, white, black, result, color (subject colour), subjectElo, oppElo, eco, line (first 10 SAN), pgn (full), posKey (first 3 FEN fields after 8 plies, null if not from the start position), plies }`. The full `pgn` is the deep source; `line`/`posKey` are not enough.

## The clash tree as a position-keyed DAG

Model the tree as a directed graph of positions, not a literal tree, so different move orders that reach the same position collapse into one node. This is the single most important decision (both the independent designs and the review agreed): it bounds the size of the tree and it matches the transposition convention already used in `repertoire.js` and `scoutbook.js`.

- Position key: `posKey(fen) = fen.split(' ').slice(0,3).join(' ')` (placement, side to move, castling). Recompute from parsed FENs; never trust the book's single stored `posKey`, which only exists for the 8-ply position.
- Node key: `` `${sideToMove}|${posKey}` ``.
- A node reached by multiple paths is expanded once. On revisit, reference-link (`transposesTo`) instead of re-expanding. Guard the DFS with a path-visited set to stop repetition cycles.

### Node and edge shape (JSON served to the client)

```
ClashNode = {
  key,                 // 'white|<posKey>'
  side,                // 'white' | 'black' : side to move at this node
  mover,               // 'kai' | 'opponent' : whose repertoire feeds this node's edges
  ply,                 // 0-based depth from the forest root
  fenBefore,           // position at this node (before the edge move)
  edges: ClashEdge[],  // capped, sorted
  kaiPrepEnds,         // true when Kai has no own-game continuation here, or his one
                       //   continuation is a flagged deviation (playedRank == null || loss >= 10)
  oppPrepEnds,         // true when the opponent has no qualifying book reply here
  oppPrepEndsReason,   // 'nodata' (never reached this position) | 'thin' (reached, but all
                       //   replies below the support threshold) | null
  truncated,           // true when expansion stopped on the depth or node cap, not on data
  transposesTo,        // node key when this position was already expanded elsewhere
  engineBest,          // { uci, san, cp } : phase 3 only, engine best at a prep-end leaf
  steer                // { uci, san, cp, oppScorePctAfter } : phase 3 only
}

ClashEdge = {
  san, uci, fenAfter,  // fenAfter drives the board with lastMove = uci
  childKey,            // node key of the resulting position (DAG link)
  count,               // raw number of games supporting this move (always shown)
  weight,              // recency/rating-weighted support (opponent edges; ~count for Kai edges)
  share,               // 0..100 weighted share within this node's kept edges (opponent edges)
  scorePct,            // subject's result % in games playing this move (null when scored == 0)
  avgOppElo,           // opponent edges
  cp,                  // White POV eval (Kai edges: from analysis.moves[].evalAfter;
                       //   engine-extended leaves: scoreToCp(line) * stmSign(stm))
  accuracy,            // Kai edges, from analysis.moves[].accuracy
  lastDate             // opponent edges, most recent game playing this move
}
```

### Forest envelope (route response, under key `clash`)

```
{
  fideId, name,
  builtAt, version, kaiFingerprint, bookImportedAt,
  params: { maxPly, oppBranch, minCountOpp, minShareOpp, kaiBranch, minRootGames, maxNodes },
  kaiColorCounts: { white, black },
  forests: { white: ClashNode|null, black: ClashNode|null },
  nodeCount, truncated,
  coverage: { ownGames: {white, black}, bookGames: {white, black}, bookGamesParsed, bookGamesSkipped },
  engineExtended: false
}
```

## Colour handling (the part most likely to be got wrong)

The two forests are not symmetric, because when Kai is Black the opponent chooses the opening.

- White forest (Kai is White): root is the start position with Kai to move. The first branching is over Kai's own opening menu (`d4`, `c4`, `e4`, ...). The opponent (Black) then replies from their book, and so on.
- Black forest (Kai is Black): root is the start position with the opponent (White) to move. The first branching is over the opponent's move-1 distribution from their book (for both scouted opponents this is dominated by `1.e4`). Kai then replies from his Black games, and so on.

A node is a Kai node when its side to move equals Kai's colour for that forest, otherwise an opponent node. Kai nodes take edges from Kai's own-game index; opponent nodes take edges from the opponent book index. Map FEN side (`fen.split(' ')[1]` is `'w'`/`'b'`) to the `'white'`/`'black'` used by `analysis.moves[].color` consistently. This asymmetry must have direct unit tests (see Testing).

## Weighting (must reconcile with the prep sheet)

The opponent's reply likelihood reuses `scoutDossier`'s scheme exactly, so a share shown in the clash tree agrees with the book repertoire table in the same card:

- `weightOf(game) = age > maxDays ? 0 : (age == null ? 0.25 : 0.5 ** (age / halfLifeDays))`, with `maxAgeYears`, `halfLifeDays` from `dossierOpts(settings)`.
- Note: `scoutDossier` applies only `weightOf` in its repertoire loop; it does not apply the Elo-band filter there. Match that (weight only, no separate Elo-band filter in the clash index) or the numbers will diverge from the table above it.
- `currentElo`: do not reimplement the median-of-recent-12 logic. Call `scoutDossier(book, opts).currentElo` once (cheap, it does no PGN parsing) and reuse it.
- Kai edges are frequency-weighted by raw `count` (his book is small and not time-sensitive), not recency-weighted.
- `resultScore` and `ageDays`/`pgnToDate`: import from `server/scoutbook.js` (re-exported from `report.js`). Do not add a third private copy (`repertoire.js` already has one; leave it).

## Branching and depth caps (tuned to measured support)

Measured on Neeraj: about 100 Black games reach a `1.d4` position; a main line still has roughly 46 games supporting the position at ply 8, thinning to about 7 to 14 by ply 14. Off the main line, support drops to single digits by ply 3 to 4. So the honest usable depth is roughly 6 to 10 plies on main lines and 4 to 6 on sidelines. The caps reflect that; the maximum ply is a safety limit, not an expected depth.

| Cap | Default | Meaning |
| --- | --- | --- |
| `maxPly` | 20 | Hard depth limit (also caps the opponent PGN walk, so midgame positions are never recorded as book theory). Expect most branches to end far sooner on data. |
| `oppBranch` | 3 | Top N opponent replies kept per node, by weight. |
| `minCountOpp` | 2 | Never branch on a single opponent game (raw count, tracked alongside weight). The only reply is kept even at count 1 so the main line does not vanish, but the node is marked `thin`. |
| `minShareOpp` | 8% | Drop replies below this weighted share (unless it is the only reply). |
| `kaiBranch` | 1 | Kai is single-file by default (one repertoire). Optionally 2 when his own games show two roughly equal choices at a node. |
| `minRootGames` | 2 | Ignore one-off opening roots. |
| `maxNodes` | 400 | Global hard cap; on hit, stop expanding and set `truncated`. |

Every percentage in the UI is shown next to its raw count, so a two-game branch reads as thin rather than authoritative.

## Preparation-end semantics (coverage, not just depth)

The review's key correction: "prep ends" conflates two different things, and they must read differently.

- `kaiPrepEnds`: Kai has no own-game continuation at this position, or his single continuation is flagged as a deviation in his analysis (`playedRank == null || loss >= 10` while `phase === 'opening'`, reusing `repertoire.js:34`). Label: "your line ends here" or "you deviated here".
- `oppPrepEnds` with reason `nodata`: the opponent has never reached this position in the book. Label: "opponent has not faced this". This fires the moment Kai plays a line the opponent's own opponents rarely played (for example a Kai sideline they saw twice).
- `oppPrepEnds` with reason `thin`: the opponent reached the position but every reply is below the support threshold. Label: "opponent's book thins out".

Because the two sides run out at different depths, mark per node and per side. Convert ply to move number with `Math.ceil(ply / 2)` (the `scout.js:400` / `repertoire.js:11` convention).

## Cost, caching, and where the work runs

Measured 2026-09-10: parsing all 647 Neeraj PGNs with `parseGame` takes about 11.1 seconds (17 ms per game, average 91 plies), single-threaded and synchronous. Nikash's 466 would be roughly 7 to 8 seconds. This cannot sit in a synchronous GET on the single Node event loop: it would block the server and stall any running analysis job. Caching is therefore part of the core, not an optimisation, and it splits into two stages:

1. Opponent opening index (the expensive stage, book-scoped): parse each book game once, walk it up to `maxPly`, and aggregate, per opponent-to-move position, the weighted move map. Persist to `data/clash/<fideId>.json` (or a single `data/clash-index.json` keyed by fideId), tagged with `bookImportedAt`. Rebuild only when the book is re-imported. This is the only heavy step and it runs as a background job (`kind: 'clash'`, synthetic gameId `clash:<fideId>`), so it queues behind analysis but never blocks a request or the event loop within one.
2. Clash forest assembly (cheap, per request): from the persisted opponent index plus Kai's in-memory `analysis.moves[]` index, walk the DAG and emit the two forests. This is well under 100 ms and can happen in the GET handler. Cache the assembled forest keyed by `fideId + kaiFingerprint + bookImportedAt + paramsKey`, where `kaiFingerprint` is a sha1 of the sorted list of Kai own-game ids plus their `analysedAt`, so it invalidates when Kai analyses new games, and `bookImportedAt` invalidates when the opponent book changes.

The clash store is gitignored (like `evalcache.json` and `scouts/`): add its filename to `ensureDataIgnores()` in `store.js`. Rationale: the book itself does not sync between machines, so a synced clash file could reference a book the other machine lacks. Use `writeJson` for all writes (tmp file plus rename); never `fs.writeFile` a store file directly. Follow the `getPrepSheets`/`savePrepSheets` read-mutate-one-key-write-whole pattern for the new `getClashStore`/`saveClashStore`.

## Backend

New module `server/clash.js`:

- `buildOpponentIndex(book, settings)`: the parse-and-aggregate stage. For each book game whose `posKey` is non-null (skip Chess960/odds/FEN-setup games) and whose `color` matches the needed side, `parseGame(g.pgn)` inside try/catch (a few malformed FIDE PGNs must not abort the build), walk plies up to `maxPly`, and for every position where the subject is to move record `posKey(fenBefore) -> Map(uci -> { san, uci, childFen: fenAfter, count, weight, scoreW, scoredW, oppEloSum, oppEloN, lastTs, lastDate })` using `weightOf` and `resultScore`. Returns the index plus coverage counts. Persisted.
- `buildKaiIndex(kaiGames)`: from each own game's `analysis.moves[]`, at every position where Kai is to move, record `posKey(fenBefore) -> Map(uci -> { san, uci, childFen: fenAfter, count, score, cp: evalAfter, accuracy, deviation })`. In-memory, cheap.
- `assembleClashForest(oppIndex, kaiIndex, opts)`: the DFS with memo, caps, and prep-end marking. Emits the forest envelope. Pure, no engine, no LLM.
- `extendClashLeaves(forest, settings)` (phase 3): mutate prep-end leaves with `engineBest`/`steer`.

New route in `server/index.js`, placed in the scouting section (after the promote route at line 621, before the SPA catch-all at 702), reusing `wrap`:

- `GET /api/scout/book/:fideId/clash` with optional clamped query params (`maxPly`, `oppBranch`, `minShareOpp`, `kaiBranch`), clamped server-side the way `puzzles`/`drills` clamp. Handler: load book (404 if missing) and settings; if the opponent index is fresh, load Kai's games, `assembleClashForest`, cache, and return `{ clash }`; if the index is stale or missing, `enqueue('clash', 'clash:' + fideId)` and return `{ building: true, job }`. GET so the read-only hosted mirror can serve a cached forest.
- Response shape: single named key `{ clash }` (the codebase convention; see `{ report }`, `{ repertoire }`).

New job in `server/jobs.js`: add `else if (job.kind === 'clash') await runClash(job)` in the `pump` loop. `runClash` runs `buildOpponentIndex`, bumping `job.total`/`job.progress` per game parsed and checking `job.cancelled`, then persists the index. The dedup guard on `gameId + kind` makes re-clicking a no-op while it builds.

Prerequisite edit for phase 3 only: `export` `stmSign` from `server/analyze.js` (currently a private const at line 21). `scoreToCp` is already exported.

## Frontend

- `public/api.js`: one line, `scoutClash: (fideId, opts = {}) => req('GET', '/api/scout/book/' + encodeURIComponent(fideId) + '/clash' + qs(opts))`, building the query string the way the drills/puzzles methods do.
- `public/views/scout.js`: append a clash card to the `renderDossier` output right after `bookSection(...)`, gated on `book` being non-null (same gate as `bookSection`, since a clash needs a FIDE-keyed book). Fetch lazily on a "Build opening clash" button (the `deepPrepAction`/`busy` pattern) so an 11-second cold build never runs on page load; if the response is `{ building }`, poll `GET /api/jobs` like the analysis progress indicator and re-fetch when done.
- Rendering: build the two forests as one recursive HTML string (nested `<details>`/`<ul>`, each node an `<li data-fen=... data-uci=...>`), then wire one delegated click listener on the container (the `game.js:169` / `scout.js:263` pattern). Show a colour chip per side, `share%` and raw `count` and `scorePct` on opponent edges, `formatEval(cp)` on Kai edges, and distinct badges for the three prep-end cases. Reuse the module-local `fmtLine`/`lichess` for the SAN path and its lichess explorer link. `esc()` every `san`/name/FEN. Reuse existing CSS (`.card`, `.grid.grid-2`, `.chip.white/.black`, `.muted`, `.board-wrap`); no new framework classes, no build step.
- Board (phase 2): embed a read-only `Board` beside the tree; on a node click, `board.set(fenAfter, { lastMove: uci })`. This requires the one non-additive change to the view: `scoutView` must return `{ destroy() { board?.destroy() } }` so the router (`app.js:36`) tears down Chessground on navigation. Keep the MVP board-free so this change is isolated to its own phase.

## Engine extension (phase 3, optional, engine-grounded)

At a prep-end leaf, generate Kai's candidate moves with chess.js only (`new Chess(fen).moves({ verbose })`), never from the model. Validate the FEN with chess.js before feeding the pool (a bad FEN is misread by `poolAnalyse` as engine death). Probe the eval cache across all `pool.names` with `evalCacheKey(name, depth, multipv, fen)` first (opening leaves are largely already cached from the 190 stored games), search misses via `getEnginePool` plus `poolAnalyse` at `settings.engineDepth`/`engineMultiPv`, `putCachedEval` the results, and `flushCache()` at the end. Convert every eval to White POV with `scoreToCp(line) * stmSign(stm)` before storing. Retry once on empty lines from a remote engine (the `analyze.js:144` gotcha) rather than storing a fabricated 0.

Steering "toward structures the opponent scores badly in": among Kai's engine-approved candidates (loss within `WP_ACCEPT` of the best line, by `winProb` on White-POV cp for Kai's side), prefer the one whose resulting `posKey` the opponent scores worst in, looked up in the opponent index. Require a minimum sample (count at least 4, not 2) before treating a low score as a real weakness, and tie-break to the engine eval. All of this is engine and data grounded; the model is not involved.

Run this as `?extend=1` on the GET for small trees (cache-backed, fast when cached, gated off on the read-only mirror), escalating to a dedicated extend job only if a genuinely novel frontier proves slow.

## LLM narration (phase 4, optional, off by default)

The tree is fully useful without any prose (like the repertoire renders without a prep sheet). If added: `clashLinePrompt(name, forest)` and `CLASH_NARRATION_SCHEMA` in `server/prompts.js` next to `prepSheetPrompt`, plus `clashNarrationVersion()`. Reuse `scoutSystemPrompt(rating)` (its rules already forbid inventing or evaluating moves). Render the already-built tree as text (one line per node: id path, side, move number and SAN, `formatEval(cp)`, "opponent plays this in X% (N games), scores Y%", and an explicit "PREP ENDS" token) with every name through `field()`. The schema exposes no move or eval field, only a prose `note` keyed to node ids already in the prompt, so the model narrates given facts and cannot generate or evaluate a move. Call through `complete(settings, { system, prompt, schema })`, persist `{ output, version, model, costUsd, createdAt }`, gate behind an explicit button, and handle `settings.llmProvider === 'manual'` by surfacing the prompt for copy/paste (as the prep-sheet and re-explain routes do). Do not add an API-key provider (CLAUDE.md: ask first). Narrate per Kai opening rather than the whole forest in one call, to bound prompt size and cost.

## Testing (`test/clash.test.js`, run with `npm test` before committing)

- White forest root is a Kai node (Kai to move at the start position); Black forest root is an opponent node (opponent to move at the start position).
- Kai-as-Black colour handling: the opponent index for the Black forest is built from `color === 'white'` book games; Kai's edges come from his Black games where the mover is Black.
- Transposition merge: two move orders reaching the same position collapse to one node (`transposesTo` set on the second path).
- Prep-end firing: `oppPrepEnds` with reason `nodata` on a position no book game reached; `thin` when reached but under threshold; `kaiPrepEnds` on a Kai node with no continuation and on a flagged deviation.
- Caps: `oppBranch` and `minCountOpp` prune as configured; `maxNodes` sets `truncated`.
- A small end-to-end build from a fixture PGN (a handful of games) asserting the forest shape, so the test does not depend on the private `data/`.

## Phasing (each phase ships something useful)

1. Data-only core (no engine, no LLM, no board, no new dependency). `server/clash.js` (`buildOpponentIndex`, `buildKaiIndex`, `assembleClashForest`), the `clash` index job and persisted index, the assembled-forest cache, `GET /api/scout/book/:fideId/clash`, `api.scoutClash`, and a static nested-tree clash card in the Scouting view with share/count/score and the three prep-end badges. Tests, CHANGES.md, `npm test`. This alone answers the original question: Kai's top openings, predicted opponent replies, deep branching, prep ends marked, honest about thin lines.
2. Interactive board: embed the read-only board and convert `scoutView` to return `{ destroy }`.
3. Engine leaf extension: `extendClashLeaves`, the `stmSign` export, `?extend=1`, steering toward weak structures, gated off on the read-only mirror.
4. Optional LLM narration: schema, prompt, version fingerprint, narration store, a button, manual-provider fallback.

## Risks and mitigations

- Parse cost (measured about 11 seconds for 647 games) blocking the server: mitigated by the two-stage cache and the background index job. The heavy parse is amortised to one build per book import; per-request assembly is cheap.
- Combinatorial explosion: the posKey DAG plus the branch and depth caps keep the node count in the low hundreds. Validate empirically on Neeraj (647) and Nikash (466); expect well under 200 nodes per forest.
- Thin deep branches reading as authoritative: always show raw counts beside percentages, and end branches early with an explicit `thin`/`nodata` marker rather than extrapolating.
- Kai's own repertoire is the real depth bottleneck (45 White / 46 Black games spread over several openings, so many Kai nodes are single-game and end at the first deviation). This is correct signal; the UI must attribute an early leaf to Kai, not to the opponent.
- Board lifecycle leak: embedding Chessground without the `{ destroy }` change leaks listeners on navigation. Keep the board in its own phase so the MVP does not touch the view contract.
- Read-only mirror: the static clash GET works on the mirror from cache, but the phase-3 engine extend must be gated off there (as promote and prep-sheet generation already are).

## Decisions for Yusuf (sensible defaults chosen; change if you disagree)

- White forest root: default is the start position branching over Kai's own opening menu (the "what should I play against this opponent" view). Alternative: pin one Kai opening per opponent.
- Depth and breadth: defaults `oppBranch = 3`, `minCountOpp = 2`, `minShareOpp = 8%`, `maxPly = 20` (a safety limit; real depth is data-driven). Prefer deeper and narrower (for example 2 branches to move 12)?
- Kai branching: default single-file (`kaiBranch = 1`). Branch when his own games show two roughly equal choices at a node?
- Placement: default is a stacked card inside the existing per-opponent Scouting view. Alternative: a top-level "Clash" tab that shows Kai's top openings against all scouted opponents at once.
- Steering (phase 3): actively recommend the move toward the opponent's worst-scoring structure, or just show the objective engine best at prep-end leaves and leave the choice to the player?
