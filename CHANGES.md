# CHANGES

Newest first.

## 2026-09-06

- Engine searches now carry a hard 2-minute movetime cap alongside the depth limit, so one pathological search cannot wedge the queue. If a search still overruns, the wrapper sends `stop`, keeps the depth reached so far, and leaves the engine idle for the next position instead of failing the job; an unresponsive engine process is killed and respawned. Previously a timed-out search kept running inside Stockfish, and the next job could silently receive the old position's bestmove.
- Games list: click the Date column header to toggle newest-first / oldest-first.
- Job list no longer hides the running job when more than 50 jobs are queued: only finished jobs are capped, so the header progress bar stays visible during big batch imports.
- The queue survives restarts: on startup the server re-queues games that were waiting or mid-analysis (and unexplained analysed games when auto-explain is on). Analysis results were already saved per game; now the pending work resumes too.
- Player name setting updated to "Kai Pisan, Pisan" so imported games get the right colour automatically.

## 2026-09-07  v0.1.0

- First working version: PGN import, Stockfish analysis (MultiPV, win-probability judgments, phases, clocks), critical moments, explanations through the `claude` CLI with structured JSON output, game summaries, guess-first moment review, weakness report (by category, phase, colour, trend, patterns, concepts), spaced-repetition drills from own mistakes, settings page, manual copy/paste LLM mode.
- Sample games generator (`scripts/make-samples.js`).
- Docs: README, CLAUDE.md, BRIEFING.md.
