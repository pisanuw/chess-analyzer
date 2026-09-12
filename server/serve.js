// Local CLI entry point (npm start / npm run dev). Kept separate from
// server/index.js so that file stays a pure app module: index.js is imported by
// the tests and bundled into the Netlify function, neither of which should start
// a listener or reference import.meta (the CJS function bundle leaves it empty).
import { app } from './index.js';
import { sweepTmpFiles, ensureDataIgnores, migrateLegacyUserData, DATA_DIR, DEFAULT_USER } from './store.js';
import { syncAllDrills } from './drills.js';
import { listMembers } from './users.js';
import { syncPlayers } from './players.js';
import { resumeInterrupted, prebuildClashes } from './jobs.js';

// Local runs read .env from the repo root, so the visitor allowlist, admin
// email, and provider keys documented in .env.example work without exporting
// them by hand (the Netlify function gets its environment from the dashboard,
// and tests import index.js, which skips this). Shell-exported variables win
// over the file. Config is read at call time everywhere (the one module-scope
// read, DATA_DIR, is a deliberate command-line-only override), so loading
// after the imports is safe.
try { process.loadEnvFile('.env'); } catch { /* no .env: a bare open run */ }

const PORT = Number(process.env.PORT) || 3210;
app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`chess-analyzer running at http://localhost:${PORT}  (data: ${DATA_DIR})`);
  sweepTmpFiles().then(n => { if (n) console.log(`removed ${n} leftover .tmp file${n === 1 ? '' : 's'}`); }).catch(() => {});
  ensureDataIgnores().catch(() => {});
  // Move the original single user's per-machine files into data/users/<default>/
  // (idempotent), then rebuild every member's drill ladder from the games they
  // can see (their own + the shared scout library).
  migrateLegacyUserData()
    .then(async moved => {
      if (moved.length) console.log(`migrated ${moved.length} legacy file${moved.length === 1 ? '' : 's'} to data/users/${DEFAULT_USER}/`);
      for (const u of await listMembers()) {
        await syncAllDrills(u.id).catch(err => console.error(`drill sync failed for ${u.id}: ${err.message}`));
      }
    })
    .catch(err => console.error(`user data migration/drill sync failed: ${err.message}`));
  syncPlayers().then(n => { if (n) console.log(`players map: learned ${n} name/FIDE-id association${n === 1 ? '' : 's'}`); }).catch(err => console.error(`players sync failed: ${err.message}`));
  resumeInterrupted().catch(err => console.error(`resume failed: ${err.message}`));
  prebuildClashes().then(n => { if (n) console.log(`pre-building opening clashes for ${n} opponent${n === 1 ? '' : 's'}`); }).catch(err => console.error(`clash pre-build failed: ${err.message}`));
});
