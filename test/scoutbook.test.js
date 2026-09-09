import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFideFromFilename, subjectColorIn, pgnToDate, ageDays, buildScoutBook, scoutDossier } from '../server/scoutbook.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const NOW = new Date('2026-09-09T00:00:00Z');

// Build a synthetic parsed game (the shape parseGame returns). posFen sets the
// placement reached after the opening, so transpositions can be forced to merge.
function makeParsed({ id, white, black, date, result = '1-0', whiteElo, blackElo, eco = '', sans, posFen = '3pos w KQkq', fromStart = true, headers = {} }) {
  const moves = sans.map((san, i) => ({
    ply: i + 1, san,
    fenBefore: i === 0 ? (fromStart ? START : 'qqqqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') : 'mid w - - 0 2',
    fenAfter: i === 7 ? `${posFen} - 0 5` : 'mid w - - 0 2',
  }));
  return { id, moves, pgn: `[White "${white}"]\n[Black "${black}"] ${sans.join(' ')}`, headers: { White: white, Black: black, Date: date, Result: result, WhiteElo: whiteElo, BlackElo: blackElo, ECO: eco, ...headers } };
}

test('parseFideFromFilename pulls the id from a metadb export name', () => {
  assert.equal(parseFideFromFilename('HarishNeeraj_FIDE30958130_Total_739_Games_NoBlitz.pgn'), '30958130');
  assert.equal(parseFideFromFilename('fide-12345.pgn'), '12345');
  assert.equal(parseFideFromFilename('random-games.pgn'), null);
});

test('subjectColorIn matches exactly, not by substring', () => {
  const h = { White: 'Harish, Neeraj', Black: 'Karthikeyan, Harishkumar' };
  assert.equal(subjectColorIn(h, ['Harish, Neeraj']), 'white');
  assert.equal(subjectColorIn(h, ['harish, neeraj']), 'white'); // case-insensitive
  assert.equal(subjectColorIn(h, ['Harish']), null);            // substring must NOT match
  assert.equal(subjectColorIn({ White: 'A', Black: 'B' }, ['C']), null);
});

test('pgnToDate handles non-zero-padded and year-only dates', () => {
  assert.equal(pgnToDate('2026.7.29').toISOString().slice(0, 10), '2026-07-29');
  assert.equal(pgnToDate('2026.07.29').toISOString().slice(0, 10), '2026-07-29');
  assert.equal(pgnToDate('2020').toISOString().slice(0, 10), '2020-01-01');
  assert.equal(pgnToDate('????.??.??'), null);
  assert.ok(ageDays('2025.09.09', NOW) > 360 && ageDays('2025.09.09', NOW) < 370);
});

test('buildScoutBook keeps only the subject games and flags non-standard starts', () => {
  const parsed = [
    makeParsed({ id: 'a', white: 'Harish, Neeraj', black: 'Foo', date: '2026.01.01', whiteElo: 2200, blackElo: 2100, sans: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6'] }),
    makeParsed({ id: 'b', white: 'Bar', black: 'Harish, Neeraj', date: '2026.02.01', whiteElo: 2000, blackElo: 2200, sans: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5', 'cxd5', 'Nxd5'] }),
    makeParsed({ id: 'c', white: 'Someone', black: 'Else', date: '2026.03.01', sans: ['e4', 'e5'] }), // not the subject
    makeParsed({ id: 'd', white: 'Harish, Neeraj', black: 'Chess960', date: '2026.04.01', fromStart: false, sans: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6'] }),
  ];
  const book = buildScoutBook(parsed, { fideId: '30958130', name: 'Harish, Neeraj' }, NOW);
  assert.equal(book.total, 3); // a, b, d (not c)
  const a = book.games.find(g => g.id === 'a');
  assert.equal(a.color, 'white');
  assert.equal(a.subjectElo, 2200);
  assert.equal(a.oppElo, 2100);
  assert.ok(a.posKey, 'standard-start game has a posKey');
  assert.ok(a.pgn.includes('Harish'), 'full pgn is retained for later promotion');
  const d = book.games.find(g => g.id === 'd');
  assert.equal(d.posKey, null, 'non-standard start has no opening posKey');
});

test('scoutDossier: recency weight and the 3-year cutoff', () => {
  const parsed = [
    // recent white Najdorf, twice
    makeParsed({ id: 'r1', white: 'H', black: 'X', date: '2026.08.01', whiteElo: 2200, blackElo: 2150, posFen: 'NAJ w KQkq', sans: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6'] }),
    makeParsed({ id: 'r2', white: 'H', black: 'Y', date: '2026.07.01', whiteElo: 2210, blackElo: 2160, posFen: 'NAJ w KQkq', sans: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6'] }),
    // old line, three games but all > 3 years old -> dropped
    makeParsed({ id: 'o1', white: 'H', black: 'Z', date: '2019.01.01', whiteElo: 1400, blackElo: 1400, posFen: 'OLD w KQkq', sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7'] }),
    makeParsed({ id: 'o2', white: 'H', black: 'Z', date: '2019.02.01', whiteElo: 1400, blackElo: 1400, posFen: 'OLD w KQkq', sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7'] }),
    makeParsed({ id: 'o3', white: 'H', black: 'Z', date: '2019.03.01', whiteElo: 1400, blackElo: 1400, posFen: 'OLD w KQkq', sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7'] }),
  ];
  const book = buildScoutBook(parsed, { fideId: '111', name: 'H' }, NOW);
  const d = scoutDossier(book, { now: NOW, maxAgeYears: 3, eloBand: 200, halfLifeDays: 540, analyseCount: 30 });
  assert.equal(d.coverage.droppedOld, 3, 'the three 2019 games are past the cutoff');
  const white = d.repertoire.filter(r => r.color === 'white');
  assert.equal(white.length, 1, 'only the recent Najdorf survives the age cutoff');
  assert.equal(white[0].line.join(' '), 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6');
  assert.equal(white[0].share, 100);
  assert.equal(d.currentElo, 2205); // median of 2200,2210
});

test('scoutDossier: games far off current strength are dropped from the analysis set', () => {
  const parsed = [
    makeParsed({ id: 'n1', white: 'H', black: 'X', date: '2026.08.01', whiteElo: 2200, blackElo: 2150, posFen: 'A w KQkq', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6'] }),
    makeParsed({ id: 'n2', white: 'H', black: 'Y', date: '2026.06.01', whiteElo: 2190, blackElo: 2140, posFen: 'A w KQkq', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6'] }),
    // recent in time, but from a 1500-rated era: off profile
    makeParsed({ id: 'lo', white: 'H', black: 'Z', date: '2026.05.01', whiteElo: 1500, blackElo: 1480, posFen: 'A w KQkq', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6'] }),
  ];
  const book = buildScoutBook(parsed, { fideId: '222', name: 'H' }, NOW);
  const d = scoutDossier(book, { now: NOW, maxAgeYears: 3, eloBand: 200, halfLifeDays: 540, analyseCount: 30 });
  assert.equal(d.coverage.droppedElo, 1, 'the 1500-era game is off the current-strength band');
  assert.ok(!d.analysisSet.includes('lo'), 'off-profile game is excluded from analysis');
  assert.equal(d.analysisSet.length, 2);
});

test('scoutDossier: analysis set is capped and prefers the most recent games', () => {
  const parsed = [];
  for (let i = 0; i < 40; i++) {
    // Monotonic: g00 newest, each 20 days older, all within the 3-year window.
    const dt = new Date(NOW.getTime() - (i * 20 + 1) * 86400000);
    const date = `${dt.getUTCFullYear()}.${dt.getUTCMonth() + 1}.${dt.getUTCDate()}`;
    parsed.push(makeParsed({ id: 'g' + String(i).padStart(2, '0'), white: 'H', black: 'X' + i, date, whiteElo: 2200, blackElo: 2100, posFen: 'A w KQkq', sans: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6'] }));
  }
  const book = buildScoutBook(parsed, { fideId: '333', name: 'H' }, NOW);
  const d = scoutDossier(book, { now: NOW, maxAgeYears: 3, eloBand: 200, halfLifeDays: 540, analyseCount: 10 });
  assert.equal(d.analysisSet.length, 10, 'capped at analyseCount');
  assert.ok(d.analysisSet.includes('g00'), 'newest game is in the set');
  assert.ok(!d.analysisSet.includes('g39'), 'oldest game is not');
});
