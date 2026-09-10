# Marathon: multi-user + Google/magic-link auth

- Goal: Convert chess-analyzer from single-user (Kai) to a small allowlisted multi-user app (members: Kai, Nikash, Neeraj; admin: Yusuf) with Google OAuth + magic-link (Resend) login.
- Done when: A logged-in member sees only their own games/report/repertoire/drills/puzzles, can view their own prep sheet + the full shared scouting library, cannot see other members' deep report/repertoire; admin (Yusuf) can manage all users, import, analyse, and edit engine/LLM settings; Google sign-in and magic link both work locally and on the Netlify mirror; `npm test` green with new multi-user isolation tests. Nikash & Neeraj seeded from their scout books.
- Started: 2026-09-10 · Loop: `/loop /marathon <the task text>` (self-paced; each wake schedules the next via ScheduleWakeup) · Branch: `multi-user` (commit per phase, DO NOT push)

## Decisions (do not re-litigate)
- Hosting: Netlify mirror is the multi-user front door (login lives there); the Mac stays the admin/producer that analyses games and publishes per-user data. Netlify + Supabase back the mirror.
- Provisioning: seed Nikash (FIDE 30960967, "Vemparala, Nikash", 466-game book) and Neeraj (FIDE 30958130, "Harish, Neeraj", 647-game book) by analysing a recent subset of their existing scout books (like the scout `promote` step). Kai = FIDE 39904881.
- Prep sheets are effectively GLOBAL: every member sees their own prep sheet + the full scouting library (all ~80 dossiers). So scouting data (scouts/, prepsheets, clash, players map) stays SHARED. Only own-games/report/repertoire/drills/puzzles are per-user PRIVATE. Each member also gets a self prep sheet (opponent-facing projection of their own games).
- Kai treated like any member. Admin (Yusuf) is the only one who imports/analyses/edits engine+LLM settings and manages users.
- Settings split: engine/LLM/host settings stay GLOBAL (admin). player identity/rating/thresholds become PER-USER.
- No new dependencies: hand-roll OAuth2 + magic-link + sessions with node:crypto + fetch (Google/Resend REST), matching existing server/auth.js. No build step, no framework. Frontend talks to backend only via public/api.js.
- Secrets live in .env (local) / Netlify env (hosted), never committed: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, RESEND_API_KEY, AUTH_FROM_EMAIL, SESSION_SECRET, PUBLIC_URL. Member emails via AUTH_EMAIL_<ID> env or data/users.json (not secret; data/ is the private data repo).
- data/ is gitignored in the main repo (separate data repo). Phase commits (code) will NOT include data/. Do not commit the data repo. Roster identity/FIDE mapping lives in code (server/users.js DEFAULT_USERS); emails come from env/data.
- Conventions: no em dashes; run `npm test` before each commit; update CHANGES.md (newest first) each phase.

## Work breakdown (each = one phase = one commit on `multi-user`)
- [x] Phase 1: User registry foundation (server/users.js + tests). Roster + allowlist, inert (no behavior change yet).
- [ ] Phase 2: Per-user data scoping in store.js. Resolve games/drills/report/patterns/per-user-settings under data/users/<id>/; keep shared data (scouts, players, evalcache, clash, global settings) top-level. Migrate existing data -> data/users/kai/. Add userId to all store calls with a safe default. Multi-user isolation tests.
- [ ] Phase 3: Session + identity. Extend server/auth.js: signed session cookie carries userId; middleware resolves req.user from cookie against allowlist; /api/auth/me, /api/auth/logout. Keep APP_PASSWORD path working for transition. Wire req.user -> store userId across routes (server/index.js).
- [ ] Phase 4: Google OAuth flow (hand-rolled). /api/auth/google -> consent; /api/auth/google/callback -> verify id_token, match allowlist, set session. Works in the Netlify function. Tests with a stubbed token verifier.
- [ ] Phase 5: Magic link via Resend. /api/auth/magic/request (signed token, email link via Resend REST) + /api/auth/magic/verify. Allowlist-only, throttled. Tests with a stubbed email transport.
- [ ] Phase 6: Frontend login + per-user views + admin gating. Replace password overlay with a login page (Google button + email field). Nav shows who you are + logout. Hide admin-only UI (import/analyse/settings/user mgmt) for members. Report/repertoire/drills/puzzles = current user; Scouting = full library.
- [ ] Phase 7: Self prep sheet + members in the prep list. Build each member's opponent-facing prep sheet from their own games; expose members alongside scouted opponents; keep each member's deep report/repertoire private.
- [ ] Phase 8: Seed Nikash & Neeraj from scout books. Admin action/script to promote+analyse a recent subset of each member's book as their OWN games (owner=member), producing report/repertoire/drills/puzzles. Run a small validating batch; note remaining as admin engine work.
- [ ] Phase 9: Netlify mirror multi-user + publish pipeline. Function supports the new auth + serves per-user data; publish-web.sh/prebuild bundles per-user data; Supabase drill state namespaced by userId; netlify.toml included_files updated.
- [ ] Phase 10: Docs + cleanup. CLAUDE.md, README, BRIEFING, CHANGES, .env.example with the new vars; final full test pass; verify Done-when conditions.

## Constraints / decisions for a cold wake
- Always read this file + `git log --oneline -15` before doing anything. Trust git + this file over memory.
- Work on branch `multi-user`. Commit code only (data/ is gitignored). Never push.
- Keep each phase bounded and green (`npm test`). If a phase is too big for one wake, split it: check off sub-items in the Log and leave a clear "next" note, still committing a green state.
- Member emails are unknown at build time. Login cannot succeed until the admin fills AUTH_EMAIL_KAI / _NIKASH / _NEERAJ / _YUSUF (or data/users.json). This is a required admin input, not a blocker for building.

## Required admin inputs (surface to user, do not block)
- Member login emails (AUTH_EMAIL_<ID> in .env / Netlify env, or data/users.json).
- Google OAuth app: GOOGLE_CLIENT_ID/SECRET + redirect URI (exact steps to be given in Phase 4).
- Resend: RESEND_API_KEY + a verified AUTH_FROM_EMAIL (user said they will add to .env).
- SESSION_SECRET (random) and PUBLIC_URL (the deployed base URL, for OAuth redirect + magic-link URLs).

## Log
- 2026-09-10 — Set up marathon + branch `multi-user`. Did recon (auth/user/data model), asked 4 clarifying questions (answers recorded under Decisions). Phase 1 done: added server/users.js (roster + allowlist, inert) and test/users.test.js. Next: Phase 2 (per-user data scoping in store.js + migration).
