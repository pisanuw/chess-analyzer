// Local CLI entry point (npm start / npm run dev). Kept separate from
// server/index.js so that file stays a pure app module: index.js is imported by
// the tests and bundled into the Netlify function, neither of which should start
// a listener or reference import.meta (the CJS function bundle leaves it empty).
import { app } from './index.js';
import { sweepTmpFiles, ensureDataIgnores, DATA_DIR } from './store.js';
import { syncAllDrills } from './drills.js';
import { resumeInterrupted } from './jobs.js';

const PORT = Number(process.env.PORT) || 3210;
app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`chess-analyzer running at http://localhost:${PORT}  (data: ${DATA_DIR})`);
  sweepTmpFiles().then(n => { if (n) console.log(`removed ${n} leftover .tmp file${n === 1 ? '' : 's'}`); }).catch(() => {});
  ensureDataIgnores().catch(() => {});
  syncAllDrills().catch(err => console.error(`drill sync failed: ${err.message}`));
  resumeInterrupted().catch(err => console.error(`resume failed: ${err.message}`));
});
