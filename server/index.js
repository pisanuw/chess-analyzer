// Express app: static frontend + JSON API. Runs locally; nothing leaves the
// machine except claude CLI calls. Middleware and static serving live here; the
// routes are grouped by concern under server/routes/.
import express from 'express';
import path from 'node:path';
import { authMiddleware, knownSessionMiddleware } from './auth.js';
import { READONLY } from './http.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGameRoutes } from './routes/games.js';
import { registerTrainingRoutes } from './routes/training.js';
import { registerScoutRoutes } from './routes/scout.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPrepRoutes } from './routes/prep.js';

// Repo root = the working directory for every supported entry (npm start via
// server/serve.js, tests, and the bundled Netlify function). Using cwd keeps
// this file free of import.meta, which the CJS function bundle leaves empty and
// warns about. On the hosted mirror ROOT is unused: the CDN serves the static
// assets and DATA_DIR comes from the environment.
const ROOT = process.cwd();
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.text({ limit: '20mb', type: ['application/x-chess-pgn', 'text/plain'] }));

app.use(authMiddleware);
app.use(knownSessionMiddleware);
registerAuthRoutes(app); // before the read-only gate: sign-in and access requests happen on the mirror

// Read-only mirror (hosted copy): game data is managed on the analysing machine
// and published; only training state (drill reviews, guesses) is writable.
const RO_ALLOW = [/^\/api\/login$/, /^\/api\/drills\/decoy$/, /^\/api\/drills\/restore-suspended$/, /^\/api\/drills\/[^/]+\/(review|suspend|undo)$/, /^\/api\/games\/[a-f0-9]{12}\/moments\/\d+\/(guess|eval|feedback)$/, /^\/api\/prep\/mark$/, /^\/api\/upcoming(\/[^/]+)?$/];
app.use((req, res, next) => {
  if (!READONLY || req.method === 'GET' || RO_ALLOW.some(re => re.test(req.path))) return next();
  res.status(405).json({ error: 'read-only mirror: manage games on the analysing machine, then publish' });
});

app.use('/vendor/chessground', express.static(path.join(ROOT, 'node_modules/chessground/dist')));
app.use('/vendor/chessground/assets', express.static(path.join(ROOT, 'node_modules/chessground/assets')));
app.use('/vendor/chess.js', express.static(path.join(ROOT, 'node_modules/chess.js/dist/esm')));
app.use(express.static(path.join(ROOT, 'public')));

registerGameRoutes(app);
registerTrainingRoutes(app);
registerScoutRoutes(app);
registerPrepRoutes(app);
registerAdminRoutes(app);

app.get(/^\/(?!api|vendor).*/, (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

// This module only builds the app: tests import { app } and listen on an
// ephemeral port, and the Netlify function wraps it with serverless-http. The
// local server is started by server/serve.js (npm start), which owns the
// listen and the once-at-boot housekeeping.
export { app };
