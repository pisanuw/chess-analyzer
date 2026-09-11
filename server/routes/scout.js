// Opponent scouting: the shared subject list, FIDE ids, book imports and
// promotion, member seeding, the opening clash and its narration, the per-subject
// dossier, and prep sheets (generation and requests).
import crypto from 'node:crypto';
import { parsePgnGames, parseGame, splitPgn, detectPlayerColor } from '../pgn.js';
import { getSettings, listAllGames, getGame, saveGame, getPrepSheets, savePrepSheets, getScoutBook, saveScoutBook, listScoutBooks, getPlayers, getClashStore, getClashNotes, saveClashNotes, DEFAULT_USER } from '../store.js';
import { parseFideFromFilename, buildScoutBook, scoutDossier } from '../scoutbook.js';
import { loadStudentGames, buildStudentIndex, assembleClashForest, extendClashLeaves, clashPrincipalLines } from '../clash.js';
import { assocsFromHeaders, recordAssociations, lookupFideId } from '../players.js';
import { searchFide, fideProfileName } from '../fide.js';
import { enqueue } from '../jobs.js';
import { getEnginePool } from '../enginepool.js';
import { complete } from '../llm.js';
import { buildReport } from '../report.js';
import { buildRepertoire } from '../repertoire.js';
import { subjectFideId, headToHead } from '../subjects.js';
import { scoutSystemPrompt, prepSheetPrompt, prepSheetVersion, clashLinePrompt, clashNarrationVersion, PREP_SHEET_SCHEMA, CLASH_NARRATION_SCHEMA } from '../prompts.js';
import { currentUser, rateLimit } from '../auth.js';
import { sendEmail, adminEmail } from '../email.js';
import { logEvent, eventIp } from '../audit.js';
import { getUser, listMembers } from '../users.js';
import { READONLY, wrap, effectiveUser, requireAdmin, studentRating, dossierOpts } from '../http.js';

const SCOUT_MAX_GAMES = 2000; // book tier: no per-game jobs, but bound the one-shot parse

// Seeded own-game ids are namespaced by member, so a game the shared scouting
// library already holds as a scout copy is never overwritten (both coexist).
const seededOwnGameId = (memberId, gameId) => crypto.createHash('sha1').update(`${memberId}:${gameId}`).digest('hex').slice(0, 12);

// Narration is about the student's own lines, so it is keyed per member; a bare
// fideId key is a note from before multi-user and belongs to the primary member.
const clashNoteKey = (fideId, uid) => (uid === DEFAULT_USER ? fideId : `${uid}:${fideId}`);

// How much of the recent, on-strength analysis subset is already in the pipeline,
// so the UI can hide a promote that would queue nothing. A game is "queueable"
// only if it has PGN and no record yet; games already imported (whatever their
// status) or lacking PGN cannot be newly queued.
async function promoteStatus(book, dossier) {
  const status = new Map((await listAllGames()).map(g => [g.id, g.status]));
  const byId = new Map(book.games.map(g => [g.id, g]));
  let present = 0, analysed = 0, queueable = 0;
  for (const id of dossier.analysisSet) {
    const st = status.get(id);
    if (st) { present++; if (st === 'analysed') analysed++; }
    else if (byId.get(id)?.pgn) queueable++;
  }
  return { total: dossier.analysisSet.length, present, analysed, queueable };
}

export function registerScoutRoutes(app) {
  app.get('/api/scout', wrap(async (req, res) => {
    // Subjects = FIDE book imports, scouted single games, and every opponent from
    // the player's own games. Each is keyed by FIDE id when one is known (from a
    // PGN tag, a book, or the players map), so a book and the own-game opponent it
    // describes merge into one entry even when the engine data came in by name.
    const players = await getPlayers();
    const books = await listScoutBooks();
    const sheets = await getPrepSheets(); // keyed by subject name: lets the UI colour prep readiness
    const norm = s => (s || '').trim().toLowerCase();
    const bookIdByName = new Map(books.map(b => [norm(b.name), b.fideId]));
    const resolve = (name, tagId) => tagId || bookIdByName.get(norm(name)) || lookupFideId(players, name);

    const byKey = new Map();
    const ensure = (name, fideId) => {
      const key = fideId || 'n:' + norm(name);
      let s = byKey.get(key);
      if (!s) { s = { subject: name, fideId: fideId || null, names: new Set(), games: 0, analysed: 0, scoutGames: 0, ownGames: 0, bookGames: 0 }; byKey.set(key, s); }
      s.names.add(name);
      return s;
    };
    const add = (name, analysed, kind, tagId) => {
      if (!name || name === '?') return;
      const s = ensure(name, resolve(name, tagId));
      s.games++;
      if (analysed) s.analysed++;
      s[kind]++;
    };
    const ownerCount = new Map(); // member id -> own-game counts, for their own prep-subject entry
    for (const g of await listAllGames()) { // scouting library is shared: draw opponents from every member's games
      const analysed = g.status === 'analysed' || g.status === 'explained';
      if (g.purpose === 'scout' && g.subject) add(g.subject, analysed, 'scoutGames', g.subjectId);
      else if (g.purpose !== 'scout' && g.playerColor) {
        const oppName = g.playerColor === 'white' ? g.black : g.white;
        add(oppName, analysed, 'ownGames', g.playerColor === 'white' ? g.blackFideId : g.whiteFideId);
        if (g.owner) { const o = ownerCount.get(g.owner) || { games: 0, analysed: 0 }; o.games++; if (analysed) o.analysed++; ownerCount.set(g.owner, o); }
      }
    }
    for (const b of books) {
      const s = ensure(b.name, b.fideId);
      s.subject = b.name; // the book name is the canonical display name
      s.bookGames = b.total || (b.games || []).length;
    }
    // Members are prep subjects too (shared library): everyone can prep against
    // them. Keyed by FIDE id, so a member who also has a book merges into it; a
    // member with no book is scouted from their own games.
    for (const m of await listMembers()) {
      const s = ensure(m.displayName, m.fideId);
      s.member = true;
      const o = ownerCount.get(m.id) || { games: 0, analysed: 0 };
      s.selfGames = o.games;
      s.games = Math.max(s.games, o.games);
      s.analysed = Math.max(s.analysed, o.analysed);
    }
    const subjects = [...byKey.values()].map(s => ({
      ...s, names: undefined, aliases: [...s.names].filter(n => n !== s.subject),
      // Prep-sheet readiness for the UI: the sheet plus the analysed-game count it
      // was built from, so the client can tell fresh (green) from missing/stale (yellow).
      prep: sheets[s.subject] ? { games: sheets[s.subject].games ?? 0, createdAt: sheets[s.subject].createdAt || '' } : null,
    }));
    res.json({ subjects: subjects.sort((a, b) => (b.bookGames + b.games) - (a.bookGames + a.games) || a.subject.localeCompare(b.subject)) });
  }));

  // The learned name <-> FIDE id map. Read-only; associations are learned at
  // import from PGN tags and book imports, and by the opt-in FIDE lookup below.
  app.get('/api/players', wrap(async (req, res) => {
    const map = await getPlayers();
    const players = Object.values(map).sort((a, b) => (a.names[0] || '').localeCompare(b.names[0] || ''));
    res.json({ players });
  }));

  // Opt-in FIDE lookup: an explicit user action searches the official rating site
  // by name and returns candidates to confirm. This is the only third-party call
  // besides the claude CLI, and it never runs automatically.
  app.get('/api/fide/search', wrap(async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'enter at least two characters to search FIDE' });
    res.json(await searchFide(name));
  }));

  // Confirm a match: record the chosen id against the local name (and the FIDE
  // canonical name) so it resolves everywhere afterward. Optionally verify the id
  // against its FIDE profile first.
  app.post('/api/players/link', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const fideId = String(req.body?.fideId || '').trim();
    if (!/^\d{3,}$/.test(fideId)) return res.status(400).json({ error: 'a numeric FIDE id is required' });
    const names = [req.body?.name, req.body?.fideName].filter(n => typeof n === 'string' && n.trim());
    if (!names.length) return res.status(400).json({ error: 'a name to link is required' });
    if (req.body?.verify) {
      const canonical = await fideProfileName(fideId);
      if (!canonical) return res.status(404).json({ error: `no FIDE profile for id ${fideId}` });
      if (!names.some(n => n.trim().toLowerCase() === canonical.toLowerCase())) names.push(canonical);
    }
    const federation = typeof req.body?.federation === 'string' ? req.body.federation : undefined;
    await recordAssociations(names.map(n => ({ fideId, name: n.trim(), federation })));
    res.json({ player: (await getPlayers())[fideId] });
  }));

  // Ingest a large per-opponent export into the book tier: parse every game,
  // derive the recency/rating-weighted dossier, store one compact file. No engine
  // and no LLM here; this is instant and covers the opponent's whole history.
  app.post('/api/scout/import', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const pgn = typeof req.body === 'string' ? req.body : req.body?.pgn;
    if (!pgn || !pgn.trim()) return res.status(400).json({ error: 'No PGN provided' });
    // FIDE id from the body, or parsed from the uploaded filename the client sends.
    const fideId = String(req.body?.fideId || parseFideFromFilename(req.body?.filename) || '').trim();
    if (!/^\d{3,}$/.test(fideId)) return res.status(400).json({ error: 'a numeric FIDE id is required (from the filename, e.g. _FIDE30958130_)' });
    const chunks = splitPgn(pgn);
    if (chunks.length > SCOUT_MAX_GAMES) return res.status(413).json({ error: `too many games in one file (${chunks.length}); the book tier caps at ${SCOUT_MAX_GAMES}` });
    const parsed = parsePgnGames(chunks);
    const ok = parsed.filter(r => r.ok && r.game.moves.length).map(r => r.game);
    const failed = parsed.length - ok.length;
    // Subject name: explicit, else the player present in the most games (a clean
    // per-player export has exactly one).
    let name = String(req.body?.name || '').trim();
    if (!name) {
      const counts = new Map();
      for (const g of ok) for (const n of [g.headers.White, g.headers.Black]) if (n) counts.set(n, (counts.get(n) || 0) + 1);
      name = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    }
    if (!name) return res.status(400).json({ error: 'could not determine the opponent name; pass name explicitly' });
    const aliases = Array.isArray(req.body?.aliases) ? req.body.aliases.slice(0, 10).map(s => String(s).slice(0, 80)) : [];
    const book = buildScoutBook(ok, { fideId, name, aliases });
    if (!book.total) return res.status(400).json({ error: `no games for "${name}" found in the file (check the name matches the PGN headers)` });
    await saveScoutBook(book);
    // The filename FIDE id names the subject; also learn any ids the games' tags carry.
    await recordAssociations([{ fideId, name }, ...ok.flatMap(g => assocsFromHeaders(g.headers))]).catch(() => {});
    const dossier = scoutDossier(book, dossierOpts(await getSettings()));
    // Chess960 ("Freestyle") games and odd PGNs are the usual skips; surface the count.
    res.json({ fideId, name, imported: book.total, skipped: failed, dossier });
  }));

  // The book dossier. ?tc=classical|rapid|blitz keeps one time-control class
  // (default: every game). `features` are the structure habits the clash index
  // harvested from the whole history (null until that index has been built).
  app.get('/api/scout/book/:fideId', wrap(async (req, res) => {
    const book = await getScoutBook(req.params.fideId);
    if (!book) return res.status(404).json({ error: 'no scout book for this FIDE id' });
    const dossier = scoutDossier(book, dossierOpts(await getSettings(), req.query.tc));
    const entry = (await getClashStore())[book.fideId];
    const features = entry && entry.bookImportedAt === book.importedAt ? entry.features || null : null;
    res.json({ fideId: book.fideId, name: book.name, importedAt: book.importedAt, dossier, features, promote: await promoteStatus(book, dossier) });
  }));

  // Promote the recent, on-strength subset into the engine/LLM dossier: create
  // scout game records (matched to the existing name-keyed scout machinery) and
  // queue analysis. This is the only step that needs Stockfish.
  app.post('/api/scout/book/:fideId/promote', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const book = await getScoutBook(req.params.fideId);
    if (!book) return res.status(404).json({ error: 'no scout book for this FIDE id' });
    const settings = await getSettings();
    const dossier = scoutDossier(book, dossierOpts(settings));
    const wanted = new Set(dossier.analysisSet);
    const byId = new Map(book.games.map(g => [g.id, g]));
    const queued = [], already = [];
    for (const id of wanted) {
      const bg = byId.get(id);
      if (!bg?.pgn) continue;
      if (await getGame(id)) { already.push(id); continue; }
      const g = parseGame(bg.pgn);
      const game = {
        id: g.id, headers: g.headers, moves: g.moves, pgn: g.pgn,
        playerColor: detectPlayerColor(g.headers, [book.name, ...(book.aliases || [])]) || bg.color,
        purpose: 'scout', subject: book.name, subjectId: book.fideId,
        status: 'imported', importedAt: new Date().toISOString(),
      };
      await saveGame(game);
      if (game.playerColor) { enqueue('analyse', game.id); queued.push(game.id); }
    }
    res.json({ subject: book.name, fideId: book.fideId, queued: queued.length, already: already.length, analysisSet: dossier.analysisSet.length });
  }));

  // Seed a member's OWN games from their scout book: import the recent, on-strength
  // subset (the same set promote uses) as purpose='own' owned by the member, so the
  // member gets a private report, repertoire, drills, and puzzles from their own
  // play. Needs Stockfish, like promote; body { analyse: false } seeds the records
  // without queueing analysis (a dry run, and how the tests exercise it).
  app.post('/api/users/:id/seed', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const member = await getUser(req.params.id);
    if (!member || member.role !== 'member') return res.status(404).json({ error: 'unknown member' });
    if (!member.fideId) return res.status(400).json({ error: `${member.id} has no FIDE id to seed from` });
    const book = await getScoutBook(member.fideId);
    if (!book) return res.status(404).json({ error: `no scout book for ${member.displayName} (FIDE ${member.fideId}); import it first` });
    const settings = await getSettings();
    const dossier = scoutDossier(book, dossierOpts(settings));
    const byId = new Map(book.games.map(g => [g.id, g]));
    const names = [book.name, ...(book.aliases || []), ...(member.playerNames || [])];
    const seeded = [], queued = [], already = [];
    for (const bookId of dossier.analysisSet) {
      const bg = byId.get(bookId);
      if (!bg?.pgn) continue;
      const g = parseGame(bg.pgn);
      const id = seededOwnGameId(member.id, g.id);
      if (await getGame(id)) { already.push(id); continue; }
      const game = {
        id, headers: g.headers, moves: g.moves, pgn: g.pgn,
        playerColor: detectPlayerColor(g.headers, names) || bg.color,
        purpose: 'own', owner: member.id, seededFrom: { fideId: book.fideId, gameId: g.id },
        status: 'imported', importedAt: new Date().toISOString(),
      };
      await saveGame(game, member.id);
      seeded.push(id);
      if (game.playerColor && req.body?.analyse !== false) { enqueue('analyse', id); queued.push(id); }
    }
    res.json({ member: member.id, fideId: member.fideId, analysisSet: dossier.analysisSet.length, seeded: seeded.length, queued: queued.length, already: already.length });
  }));

  // Opening clash: the predicted, branching, alternating tree of how this opponent
  // would meet the student's own openings. The expensive part (parsing the whole
  // book) is cached per FIDE id and rebuilt as a background job when the book has
  // changed; the tree itself is assembled cheaply here from that cache plus the
  // viewer's analysed games. GET so the read-only hosted mirror can serve a cached
  // forest. Returns { clash } when ready, or { building, job } while the index is
  // (re)built.
  app.get('/api/scout/book/:fideId/clash', wrap(async (req, res) => {
    const book = await getScoutBook(req.params.fideId);
    if (!book) return res.status(404).json({ error: 'no scout book for this FIDE id' });
    const entry = (await getClashStore())[book.fideId];
    if (!entry || entry.bookImportedAt !== book.importedAt) {
      // The read-only mirror ships a pre-built index and cannot parse or run jobs;
      // if it is missing or stale there, say so rather than trying to build.
      if (READONLY) return res.json({ unavailable: true });
      const job = enqueue('clash', 'clash:' + book.fideId);
      return res.json({ building: true, job: { id: job.id, kind: job.kind, gameId: job.gameId } });
    }
    const uid = await effectiveUser(req); // the clash crosses the viewer's own openings with the book
    const student = buildStudentIndex(await loadStudentGames(uid));
    const clash = assembleClashForest({ oppIndex: entry.index, coverage: entry.coverage, student, book, params: req.query });
    // Optional, engine-grounded: fill prep-end leaves with Stockfish's best move
    // (candidate moves from the engine, never a model). Cache-first, so the many
    // shared opening positions are near free. Off on the read-only mirror (no engine).
    if (req.query.extend === '1' && !READONLY) {
      const settings = await getSettings();
      const pool = await getEnginePool(settings);
      if (!pool.engines.length) clash.engineWarning = pool.warning || 'No engine available to extend lines.';
      else { if (pool.warning) clash.engineWarning = pool.warning; await extendClashLeaves(clash, entry.index, settings, pool); }
    }
    clash.narration = (await getClashNotes())[clashNoteKey(book.fideId, uid)] || null;
    clash.narrationVersion = clashNarrationVersion();
    res.json({ clash });
  }));

  // Optional coach narration of the predicted lines: prose only, keyed to line ids
  // the server produced. Engine-grounded (the model never picks or evaluates a
  // move). Home machine only. Requires the clash index to be built first.
  app.post('/api/scout/book/:fideId/clash/narrate', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    if (READONLY) return res.status(403).json({ error: 'narration is generated on the home machine' });
    const book = await getScoutBook(req.params.fideId);
    if (!book) return res.status(404).json({ error: 'no scout book for this FIDE id' });
    const entry = (await getClashStore())[book.fideId];
    if (!entry || entry.bookImportedAt !== book.importedAt) return res.status(409).json({ error: 'build the opening clash first' });
    const uid = await effectiveUser(req);
    const student = buildStudentIndex(await loadStudentGames(uid));
    const clash = assembleClashForest({ oppIndex: entry.index, coverage: entry.coverage, student, book });
    const lines = clashPrincipalLines(clash);
    if (!lines.length) return res.status(400).json({ error: 'no predicted lines to narrate yet' });
    const settings = await getSettings();
    const { output, costUsd, model } = await complete(settings, {
      system: scoutSystemPrompt(await studentRating(req, settings)),
      prompt: clashLinePrompt(book.name, lines),
      schema: CLASH_NARRATION_SCHEMA,
    });
    const noteByIdx = new Map((output.notes || []).map(n => [n.index, n.note]));
    const narration = {
      headline: output.headline,
      lines: lines.map(l => ({ color: l.color, sanLine: l.sanLine, endReason: l.endReason, note: noteByIdx.get(l.idx) || '' })),
      version: clashNarrationVersion(), model, costUsd, createdAt: new Date().toISOString(),
    };
    const store = await getClashNotes();
    store[clashNoteKey(book.fideId, uid)] = narration;
    await saveClashNotes(store);
    res.json({ narration });
  }));

  // The per-subject dossier. ?color=white|black cuts it to the subject's games in
  // that colour (the one the student will face); an unknown subject is a 404, a
  // colour with no games is an empty dossier. headToHead is the viewer's own
  // record against the subject.
  app.get('/api/scout/:subject', wrap(async (req, res) => {
    const subject = req.params.subject;
    const color = ['white', 'black'].includes(req.query.color) ? req.query.color : null;
    const report = await buildReport({ purpose: 'scout', subject, color });
    if (!report.games && !(color && (await buildReport({ purpose: 'scout', subject })).games)) return res.status(404).json({ error: 'no analysed games for this subject' });
    const repertoire = await buildRepertoire({ purpose: 'scout', subject, color });
    const prepSheet = (await getPrepSheets())[subject] || null;
    const fideId = await subjectFideId(subject);
    const h2h = await headToHead(await effectiveUser(req), subject, fideId);
    // The current format fingerprint lets the UI offer a regenerate when the sheet
    // style has changed, not only when new games arrive (null on the hosted mirror).
    res.json({ subject, fideId, color, report, repertoire, headToHead: h2h, prepSheet, prepSheetVersion: prepSheetVersion() });
  }));

  app.post('/api/scout/:subject/prepsheet', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const subject = req.params.subject;
    const report = await buildReport({ purpose: 'scout', subject });
    if (!report.games) return res.status(404).json({ error: 'no analysed games for this subject' });
    const repertoire = await buildRepertoire({ purpose: 'scout', subject });
    const settings = await getSettings();
    const { output, costUsd, model } = await complete(settings, {
      system: scoutSystemPrompt(await studentRating(req, settings)),
      prompt: prepSheetPrompt(subject, report, repertoire),
      schema: PREP_SHEET_SCHEMA,
    });
    const sheets = await getPrepSheets();
    sheets[subject] = { ...output, games: report.games, version: prepSheetVersion(), model, costUsd, createdAt: new Date().toISOString() };
    await savePrepSheets(sheets);
    res.json({ prepSheet: sheets[subject] });
  }));

  // A member or visitor can ask the operator to make a prep sheet: this emails the
  // admin rather than running the LLM (generation stays on the home machine). Not
  // admin-gated (anyone signed in may request); rate-limited to prevent spam.
  app.post('/api/scout/:subject/prepsheet/request', wrap(async (req, res) => {
    if (!(await rateLimit(req))) return res.status(429).json({ error: 'too many requests, try again later' });
    const to = adminEmail();
    if (!to) return res.status(503).json({ error: 'prep-sheet requests are not configured (no admin email)' });
    const subject = req.params.subject;
    const u = await currentUser(req);
    const who = u?.displayName || 'a user';
    try {
      await sendEmail(to, `Prep sheet requested: ${subject}`,
        `${who} requested a preparation sheet for ${subject}.\n\nGenerate it in the app: Players, pick ${subject}, Generate prep sheet, then publish.`);
      logEvent({ action: 'prep sheet requested', detail: subject, userId: u?.id, name: u?.displayName, role: u?.role, ip: eventIp(req) });
      res.json({ ok: true });
    } catch (err) {
      console.error(`prep-sheet request email failed: ${err.message}`);
      res.status(502).json({ error: 'could not send the request' });
    }
  }));

  // Free-form prep-sheet request by FIDE id: the person need not be scouted yet.
  // Emails the admin so they can look the player up, scout them, and build it.
  app.post('/api/prep-request', wrap(async (req, res) => {
    if (!(await rateLimit(req))) return res.status(429).json({ error: 'too many requests, try again later' });
    const to = adminEmail();
    if (!to) return res.status(503).json({ error: 'prep-sheet requests are not configured (no admin email)' });
    const fideId = String(req.body?.fideId || '').trim();
    if (!/^\d{4,12}$/.test(fideId)) return res.status(400).json({ error: 'enter a numeric FIDE id' });
    const u = await currentUser(req);
    const who = u?.displayName || 'a user';
    try {
      await sendEmail(to, `Prep sheet requested: FIDE ${fideId}`,
        `${who} requested a preparation sheet for FIDE id ${fideId}.\n\nProfile: https://ratings.fide.com/profile/${fideId}\n\nScout their games (Players, Scout an opponent), then Generate prep sheet and publish.`);
      logEvent({ action: 'prep sheet requested (FIDE id)', detail: fideId, userId: u?.id, name: u?.displayName, role: u?.role, ip: eventIp(req) });
      res.json({ ok: true });
    } catch (err) {
      console.error(`prep-sheet request email failed: ${err.message}`);
      res.status(502).json({ error: 'could not send the request' });
    }
  }));
}
