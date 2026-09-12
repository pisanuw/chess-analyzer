# Marathon: implement IMPROVEMENT-REPORT.md (round 2)

- Goal: implement every item of IMPROVEMENT-REPORT.md (33 items: 11 frontend, 11 backend, 11 pedagogy), one commit per item (or per tightly coupled pair), each with tests, lint, and a CHANGES.md entry, pushed after every commit.
- Branch: `claude/wizardly-cori-1onxby` (push after each commit; a 2-hour recurring wake resumes from this file if the session dies).
- Done when: every box below is checked, `npm run lint`, `npm test`, and `npm run test:ui` pass, README/CLAUDE.md/BRIEFING.md describe the new behaviour, and the report's status note says what shipped.

## Rules for a cold wake
- Read this file and `git log --oneline -15` before doing anything. Trust git and this file over memory.
- Conventions (CLAUDE.md): no em dashes anywhere; no build step, no framework; frontend talks to the backend only through `public/api.js`; every prompt stays engine-grounded; CHANGES.md newest first; never import `server/serve.js` in a test.
- Tests use temp DATA_DIR (`test/helpers.js`). The fake engine is `test/fixtures/fake-stockfish.mjs`, the fake claude is `test/fixtures/claude`.
- Item numbers below refer to IMPROVEMENT-REPORT.md sections (F = Frontend, B = Backend, P = Pedagogy).

## Checklist (in order)

### Phase A: confirmed bugs
- [x] P1 deviation flashcards: repair cards from `ownLines` (student analysis) at a flagged node, `buildLineRepairs` list on the Prepare page; test.
- [x] B1+B2 drill sync owner: `PUT /api/settings` loops members; colour and name routes pass `game.owner`; test in session.test.js.
- [ ] B3 date key: `pgnDateKey` in `public/shared.js`, used by store.js, report.js, repertoire.js, subjects.js, games.js; test with unpadded dates.

### Phase B: small frontend
- [ ] F1 offline Prepare page: sw.js prefix matches for /api/prep/, /api/upcoming, /api/scout/; prep marks queued offline like reviews; tests.
- [ ] F5 PNG icons (apple-touch-icon 180, manifest 192/512).
- [ ] F3 theme control on the Settings page (and reachable without auth).
- [ ] F6 pause job/badge polling and pollClash when the tab is hidden.
- [ ] F8 replace location.reload() with a re-render (prep.js upcoming add/remove, scout.js FIDE link).
- [ ] F11 a11y: readiness dot text, aria-pressed on toggles.
- [ ] F4 pointer-event tooltips with tap-to-pin in charts.js.

### Phase C: backend
- [ ] B10 clash index: fix stale comment; mainLines on the same recency+Elo filter.
- [ ] B6 memoise the "others" forest in predictionFor.
- [ ] B7 prep marks in their own KV key / file (`prep:<id>`), not the drills row.
- [ ] B8 route hygiene: jobs filtered/gated, dataDir admin-only, playout rate-limited, one-time magic links.
- [ ] B9 sparring engine: a second process for quick evals (pool of two).
- [ ] B5 startup resume only for interrupted work (explainStartedAt), not the whole backlog.
- [ ] B4 llm job lane: prepsheet, narrate, patterns as jobs; routes enqueue; Admin card queues server-side.
- [ ] B11 tests: repeatedDeviations/prediction summary, sw.js unit test.

### Phase D: pedagogy data
- [ ] P4 likelihood on line cards and C facts; deck sorted by likelihood; predictability tile.
- [ ] F2 deck order: likelihood order, misses first on repeat.
- [ ] P5 endgame profile from the book (materialSignature at first endgame ply) as F facts and a tile.
- [ ] P6 how they lose: resistance plies, collapse share of losses, loss vs win length as T facts.
- [ ] P10 time-control cut for the analysed subset (buildReport/buildRepertoire/dueDrills honour tc).

### Phase E: pedagogy features
- [ ] P2 book-driven sparring partner (`mode: 'book'` on /api/playout/move), Prepare page toggle, book-vs-engine labels.
- [ ] P11 clock-aware sparring (budget from pacing curve) on the book sparring mode.
- [ ] P3 rating-band prep for an opponent with no data (upcoming gains rating; /api/prep falls back); username-keyed books (lichess:/chesscom: keys, import route).
- [ ] P7 days-to-go deck plan on Home and Prepare.
- [ ] F10 Home lists every upcoming game within 7 days with deck progress.
- [ ] P8 sheet quiz (deterministic from the structured sheet), recorded as a prep mark.
- [ ] P9 post-game prep debrief (deck positions reached), stored on the game, shown in head-to-head, cited as an H fact.

### Phase F: structure, tests, docs
- [ ] F7 extract the clash renderer to public/clashview.js.
- [ ] F9 smoke test: fake engine for play-out, playout drills, off-list quick eval, clash extend; open the clash card.
- [ ] Docs: README, CLAUDE.md, BRIEFING.md; IMPROVEMENT-REPORT.md status note; final lint/test/test:ui.

## Log
- 2026-09-12 marathon started; cron wake every 2 hours (13 */2 * * *) resumes from this file.
