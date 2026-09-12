// Prep sheet v2: numbered evidence in the prompt, server-side validation of the
// cited ids, per-student storage with the shared fallbacks, and the markdown card.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const { prepContext, prepSheetPrompt, prepSheetEvidence, PREP_SHEET_SCHEMA } = await import('../server/prompts.js');
const { sheetKey, readSheet, validateSheet, buildScoutCard } = await import('../server/prepsheet.js');
const { savePrepSheets } = await import('../server/store.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const report = {
  games: 3,
  byCategory: { calculation: { count: 3, weight: 6, moments: [{ gameId: 'aaaaaaaaaa01', ply: 1 }] } },
  byPhase: { opening: { accuracy: 90, momentsPer100: 1 }, middlegame: { accuracy: 80, momentsPer100: 5 }, endgame: { accuracy: 70, momentsPer100: 9 } },
  patterns: [{ pattern: 'Passive rook', count: 2, moments: [{ gameId: 'aaaaaaaaaa01', ply: 1 }] }],
  timeManagement: null,
  tendencies: { games: 3, conversion: { reached: 2, won: 1, drawn: 0, rate: 50 }, hold: { reached: 1, saved: 0, rate: 0 }, collapses: 1, comebacks: 0, turnPhase: { opening: 0, middlegame: 3, endgame: 0, none: 0 }, drawRate: 0, avgMoves: 40 },
};
const repertoire = [{ color: 'white', line: ['e4', 'e5'], eco: 'C20', count: 3, scorePct: 33, prepEndsPly: 9 }];
const extra = {
  book: { currentElo: 2150, peakElo: 2200, eloTrend: [{ year: 2023, elo: 1950, games: 20 }, { year: 2024, elo: 2150, games: 25 }], results: { white: { recentScorePct: 55 }, black: { recentScorePct: 45 } }, repertoire: [{ color: 'white', line: ['e4', 'c5'], eco: 'B20', share: 60, count: 30, scorePct: 58, avgOppElo: 2050, lastDate: '2026.05.01' }] },
  features: { games: 50, form: { games: 10, scorePct: 60, recentGames: 4, days: 90 }, vsHigher: { games: 14, scorePct: 28 }, vsLower: { games: 21, scorePct: 62 }, inBook: { games: 40, scorePct: 55 }, outOfBook: { games: 10, scorePct: 30 }, castling: { white: { short: 40, long: 2, none: 8 }, black: { short: 30, long: 0, none: 5 } }, oppositeCastlingPct: 9, queenTrade: { pct: 34, medianMove: 22 }, drawRate: { white: 20, black: 25 } },
  clashLines: [{ idx: 0, color: 'black', sanLine: '1.e4 c6 2.d4 d5', endReason: 'the opponent has never faced this position', endEval: 20 }],
  headToHead: { games: [{ gameId: 'aaaaaaaaaa01', date: '2026.03.01', color: 'white', result: '1-0', line: ['e4', 'e5'], accuracy: 91, moments: 1 }], record: { games: 1, wins: 1, draws: 0, losses: 0, scorePct: 100 } },
  student: {
    name: 'Kai', rating: 2000, repertoire: [{ color: 'black', line: ['e4', 'c6'], eco: 'B12', count: 19, scorePct: 55 }],
    weaknesses: { games: 5, byCategory: { conversion: { count: 4, weight: 8 } }, byPhase: { endgame: { accuracy: 62, moments: 4 } } },
  },
};

test('prepContext numbers every fact and maps each id to its text and link', () => {
  const { body, evidence } = prepContext('Karpov, A', report, repertoire, extra);
  for (const id of ['E1', 'P1', 'R1', 'L1', 'C1', 'T1', 'F1', 'H1', 'S1', 'S2', 'S3', 'S4']) {
    assert.ok(body.includes(`[${id}]`), `${id} appears in the prompt body`);
    assert.ok(evidence[id]?.text, `${id} is in the evidence map`);
  }
  assert.equal(evidence.P1.link, '#/game/aaaaaaaaaa01/1', 'a pattern links to its first moment');
  assert.equal(evidence.H1.link, '#/game/aaaaaaaaaa01');
  assert.ok(body.includes('Karpov, A is 150 above'), 'the rating gap is stated');
  assert.ok(body.includes('60% of their white games'), 'book shares are stated');
  assert.ok(body.includes('the prediction ends because the opponent has never faced this position'));
  assert.ok(body.includes('gained about 200 rating points'), 'the rating trend is cited (F id)');
  assert.ok(body.includes('weaker guide than usual'), 'a large trend flags reduced predictiveness');
  assert.ok(body.includes('conversion: 4 moments in their own games'), "the student's own weakness is cited (S id), not just the opponent's");
  assert.ok(body.includes('weakest in the endgame: accuracy 62%'));
  assert.ok(!body.includes('—'), 'no em dashes');
});

test('prepSheetPrompt still works with only the analysed subset, and the schema demands evidence', () => {
  const p = prepSheetPrompt('Karpov, A', report, repertoire);
  assert.ok(p.includes('[E1] calculation: 3 moments'));
  assert.ok(p.includes('cite') && p.includes('evidence'));
  assert.ok(!p.includes('Habits over their whole history'), 'sections with no data are omitted');
  assert.deepEqual(PREP_SHEET_SCHEMA.properties.exploit_plan.items.required, ['step', 'evidence']);
  assert.deepEqual(PREP_SHEET_SCHEMA.properties.watch_fors.items.required, ['cue', 'evidence']);
  assert.ok(PREP_SHEET_SCHEMA.properties.openings.items.required.includes('evidence'));
  assert.deepEqual(PREP_SHEET_SCHEMA.properties.structures.items.required, ['structure', 'plan', 'evidence']);
  assert.deepEqual(PREP_SHEET_SCHEMA.properties.matchup_risks.items.required, ['risk', 'evidence']);
  // Both are optional (omittable when the data behind them is missing), unlike
  // the always-required fields: forcing them would mean fabricating content.
  assert.ok(!PREP_SHEET_SCHEMA.required.includes('structures'));
  assert.ok(!PREP_SHEET_SCHEMA.required.includes('matchup_risks'));
  const ev = prepSheetEvidence('Karpov, A', report, repertoire);
  assert.ok(ev.E1 && !ev.L1);
});

test('prepSheetPrompt reweights the plan toward complicating or safety when the student has a specific need', () => {
  const balanced = prepSheetPrompt('Karpov, A', report, repertoire);
  assert.ok(!balanced.includes('NEEDS A WIN') && !balanced.includes('ACCEPTABLE OR PREFERRED'), 'no preference: no framing added');
  const win = prepSheetPrompt('Karpov, A', report, repertoire, { need: 'win' });
  assert.ok(win.includes('NEEDS A WIN') && win.includes('complicating'));
  const draw = prepSheetPrompt('Karpov, A', report, repertoire, { need: 'draw' });
  assert.ok(draw.includes('ACCEPTABLE OR PREFERRED') && draw.includes('safety'));
  assert.ok(!prepSheetPrompt('Karpov, A', report, repertoire, { need: 'nonsense' }).includes('NEEDS A WIN'), 'an unrecognised need is ignored, not treated as a preference');
});

test('validateSheet keeps only issued ids, flags uncited items, and tolerates plain strings', () => {
  const evidence = { E1: { text: 'x' }, P1: { text: 'y' }, F1: { text: 'z' }, S1: { text: 'w' } };
  const out = validateSheet({
    headline: 'h', profile: { style: 's' },
    exploit_plan: [{ step: 'Attack', evidence: ['P1', 'Z9', 'P1'] }, { step: 'Trade', evidence: [] }, 'Just a string'],
    structures: [{ structure: 'castles queenside', plan: 'race the queenside pawns', evidence: ['F1'] }],
    openings: [{ when: 'w', play: 'p', why: 'y', evidence: ['E1'] }],
    watch_fors: [{ cue: 'c', evidence: ['nope'] }],
    matchup_risks: [{ risk: 'you convert poorly and they grind', evidence: ['S1', 'F1'] }],
  }, evidence);
  assert.deepEqual(out.exploit_plan[0], { step: 'Attack', evidence: ['P1'], unsupported: false });
  assert.equal(out.exploit_plan[1].unsupported, true);
  assert.deepEqual(out.exploit_plan[2], { step: 'Just a string', evidence: [], unsupported: true });
  assert.equal(out.openings[0].unsupported, false);
  assert.equal(out.watch_fors[0].unsupported, true, 'an unknown id is dropped and leaves the cue unsupported');
  assert.deepEqual(out.structures[0], { structure: 'castles queenside', plan: 'race the queenside pawns', evidence: ['F1'], unsupported: false });
  assert.deepEqual(out.matchup_risks[0], { risk: 'you convert poorly and they grind', evidence: ['S1', 'F1'], unsupported: false });
});

test('sheets are per student, with the primary member and legacy sheets as shared fallbacks', () => {
  const sheets = { 'Foe': { headline: 'legacy' }, 'kai|Foe': { headline: 'kai' }, 'nikash|Foe': { headline: 'nikash' } };
  assert.equal(readSheet(sheets, 'nikash', 'Foe').headline, 'nikash');
  assert.equal(readSheet(sheets, 'neeraj', 'Foe').headline, 'kai', 'no own sheet: the primary member\'s is shared reading');
  assert.equal(readSheet({ 'Foe': { headline: 'legacy' } }, 'neeraj', 'Foe').headline, 'legacy');
  assert.equal(readSheet({}, 'kai', 'Foe'), null);
  assert.equal(sheetKey('kai', 'Foe'), 'kai|Foe');
});

test('the markdown card renders a v2 sheet with evidence footnotes, and the route serves it', async () => {
  const sheet = {
    headline: 'Trade queens early.', profile: { style: 'solid', strongest_phase: 'opening', weakest_phase: 'endgame', main_errors: 'endgame technique', time_trouble: 'no clock data' },
    exploit_plan: [{ step: 'Reach an endgame', evidence: ['T1'] }],
    structures: [{ structure: 'castles queenside as White about 40% of the time', plan: 'race the queenside pawns', evidence: ['F2'] }],
    openings: [{ when: 'As White in the Sicilian', play: 'Caro-Kann instead', why: 'they score 30% out of book', evidence: ['F3'] }],
    watch_fors: [{ cue: 'Passive rook', evidence: ['P1'] }, { cue: 'Unfounded', evidence: [], unsupported: true }],
    matchup_risks: [{ risk: 'you convert winning positions poorly and they grind on', evidence: ['S1', 'T1'] }],
    evidence: { T1: { text: 'converted 1 of 2' }, F2: { text: 'castles queenside 40% of the time' }, F3: { text: 'scores 30% out of book' }, P1: { text: '"Passive rook" (2x)' }, S1: { text: 'converts poorly' } },
    games: 3, createdAt: '2026-09-11T00:00:00Z',
  };
  const md = buildScoutCard('Karpov, A', sheet, { record: { games: 1, wins: 1, draws: 0, losses: 0, scorePct: 100 } });
  assert.match(md, /^# Preparation sheet: Karpov, A/);
  assert.match(md, /Head to head: 1 game, 1W 0D 0L \(100%\)/);
  assert.match(md, /1\. Reach an endgame \[T1\]/);
  assert.match(md, /## Structures and plans[\s\S]*castles queenside as White about 40% of the time: race the queenside pawns \[F2\]/);
  assert.match(md, /\| As White in the Sicilian \| Caro-Kann instead \| they score 30% out of book \[F3\] \|/);
  assert.match(md, /- Unfounded \[unsupported\]/);
  assert.match(md, /## Matchup risks[\s\S]*you convert winning positions poorly and they grind on \[S1, T1\]/);
  assert.match(md, /## Evidence[\s\S]*- P1: "Passive rook" \(2x\)/);
  assert.ok(!md.includes('—'));

  writeGame(process.env.DATA_DIR, makeGame({ id: 'bbbbbbbbbb01', purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 35 }] }));
  assert.equal((await fetch(base + '/api/scout/' + encodeURIComponent('Karpov, A') + '/card')).status, 404, 'no sheet yet');
  await savePrepSheets({ 'kai|Karpov, A': sheet });
  const r = await fetch(base + '/api/scout/' + encodeURIComponent('Karpov, A') + '/card');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /markdown/);
  assert.match(await r.text(), /Trade queens early/);
  // The dossier serves the per-student sheet too.
  const d = await (await fetch(base + '/api/scout/' + encodeURIComponent('Karpov, A'))).json();
  assert.equal(d.prepSheet.headline, 'Trade queens early.');
});
