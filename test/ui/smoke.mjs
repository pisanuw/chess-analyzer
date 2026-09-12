// Browser smoke test: start the app on a fixture data dir, open every page in
// headless Chromium, and fail on any console error, page error, or failed
// request. Run with `npm run test:ui` (needs Chromium: `npx playwright install
// chromium` once, or PLAYWRIGHT_BROWSERS_PATH / a pre-installed browser).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { seedFixture } from './fixture.js';

const dir = seedFixture();
const port = 3400 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['server/serve.js'], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(base + '/api/status')).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 100));
}

const PAGES = [
  ['#/home', 'Next game'],
  ['#/games', 'Import PGN'],
  ['#/game/f1f1f1f1f101', 'Critical moments'],
  // Not "Focus areas": the pre-tournament card's markdown repeats that heading
  // inside its (closed) accordion, and getByText().first() would wait on the
  // hidden copy. This title exists once, on an always-visible summary.
  ['#/report', 'Accuracy by game'],
  ['#/scout', 'Players'],
  ['#/scout/' + encodeURIComponent('Karpov, A'), 'Head to head'],
  ['#/prep/' + encodeURIComponent('Karpov, A') + '?color=black', 'Prep deck'],
  ['#/drills', 'Drills'],
  ['#/drills?subject=' + encodeURIComponent('Karpov, A') + '&color=white', 'Prep round'],
  ['#/puzzles', 'Puzzles'],
  ['#/settings', 'Stockfish path'],
  ['#/admin', 'Roster'],
  ['#/log', 'Activity log'],
];

const problems = [];
let ignoreRequestFailures = false; // set around the deliberate offline-simulation block below
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('console', msg => { if (msg.type() === 'error' && !ignoreRequestFailures) problems.push(`console error on ${page.url()}: ${msg.text()}`); });
page.on('pageerror', err => problems.push(`page error on ${page.url()}: ${err.message}`));
page.on('requestfailed', req => { if (!ignoreRequestFailures) problems.push(`request failed on ${page.url()}: ${req.url()} ${req.failure()?.errorText}`); });
page.on('response', res => { if (res.status() >= 500) problems.push(`HTTP ${res.status()} on ${page.url()}: ${res.url()}`); });

await page.goto(base + '/');
for (const [hash, expectText] of PAGES) {
  await page.evaluate(h => { location.hash = h; }, hash);
  try {
    await page.getByText(expectText, { exact: false }).first().waitFor({ timeout: 8000 });
  } catch {
    problems.push(`${hash}: expected text "${expectText}" not found; body starts: ${(await page.locator('#app').innerText()).slice(0, 200).replace(/\s+/g, ' ')}`);
  }
}

// A few interactions: the deck on the Prepare page reveals an answer and moves on;
// the Players colour cut re-renders; the game view opens a moment.
await page.evaluate(() => { location.hash = '#/prep/' + encodeURIComponent('Karpov, A') + '?color=black'; });
await page.getByText('Show answer').first().click({ timeout: 8000 });
await page.getByText('Next', { exact: false }).first().click({ timeout: 8000 });
await page.evaluate(() => { location.hash = '#/scout/' + encodeURIComponent('Karpov, A'); });
await page.getByText('As White', { exact: true }).first().click({ timeout: 8000 });
await page.getByText('Showing Karpov, A as white', { exact: false }).first().waitFor({ timeout: 8000 });
await page.evaluate(() => { location.hash = '#/game/f1f1f1f1f101'; });
await page.locator('.moment').first().click({ timeout: 8000 });
await page.getByText('Find the best move', { exact: false }).first().waitFor({ timeout: 8000 });
// Players: the list is a sortable table.
await page.evaluate(() => { location.hash = '#/scout'; });
await page.locator('th[data-sort="name"]').first().click({ timeout: 8000 });
await page.locator('tr[data-subject]').first().waitFor({ timeout: 8000 });
// Drills: a move typed into the box under the board plays (the fixture's drills
// start from the initial position, best move d4), the confidence question comes
// before the reveal, and a correct answer reaches the grade buttons.
await page.evaluate(() => { location.hash = '#/drills'; });
const san = page.locator('.san-input input').first();
await san.waitFor({ timeout: 8000 });
const blackToMove = (await page.locator('#dpanel').innerText()).includes('Black to move');
await san.fill(blackToMove ? 'e5' : 'd4'); // the fixture's best move for either side
await san.press('Enter');
await page.getByText('How sure are you?', { exact: false }).first().waitFor({ timeout: 8000 });
await page.keyboard.press('1');
await page.locator('#stopfollow').click({ timeout: 8000 }); // the follow-up along the engine line: show it
await page.getByText('How well did you know it?', { exact: false }).first().waitFor({ timeout: 8000 });
await page.keyboard.press('2');
// Undo last grade: reverts to the same drill, back to a fresh guess (not the
// confidence step, which isn't part of the saved review), rather than just
// hiding the button. Proceed by giving up on it (below) instead of retyping
// the move: that exercises the same drill's miss path just as well and avoids
// a race against the freshly (re)mounted board's own input element.
await page.locator('#undo-last:not([hidden])').waitFor({ timeout: 8000 });
await page.locator('#undo-last').click({ timeout: 8000 });
await page.getByText('Find the best move', { exact: false }).first().waitFor({ timeout: 8000 });
// Giving up is a miss, so the explain-back line comes before the coach's
// answer and the grade buttons; skipping it reaches "Continue".
await page.getByText('Show answer').first().click({ timeout: 8000 });
await page.locator('#explain-back').waitFor({ timeout: 8000 });
await page.locator('#eb-skip').click({ timeout: 8000 });
await page.getByText('Continue', { exact: false }).first().waitFor({ timeout: 8000 });
// Suspend: parks the drill instead of grading it.
await page.locator('button[data-suspend]').first().click({ timeout: 8000 });
await page.getByText('Drill suspended', { exact: false }).first().waitFor({ timeout: 8000 });

// PGN import: paste a small game (auto-analyse off, no engine in this test).
await page.evaluate(() => { location.hash = '#/games'; });
await page.locator('#pgn').waitFor({ timeout: 8000 });
await page.locator('#auto').uncheck();
await page.locator('#pgn').fill('[Event "Test"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n');
await page.locator('#import').click({ timeout: 8000 });
await page.getByText('Imported 1', { exact: false }).first().waitFor({ timeout: 8000 });

// Responsive: a landscape phone (short and wide, under the 900px breakpoint)
// keeps the board and panel side by side instead of stacking them, so the
// guess/grade buttons stay on screen after every move.
await page.evaluate(() => { location.hash = '#/game/f1f1f1f1f101'; });
await page.getByText('Critical moments', { exact: false }).first().waitFor({ timeout: 8000 });
await page.setViewportSize({ width: 800, height: 420 });
const columns = await page.locator('.game-layout').evaluate(el => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
if (columns < 2) problems.push(`landscape-phone viewport (800x420): .game-layout has ${columns} grid column(s), expected 2 side by side`);
await page.setViewportSize({ width: 1200, height: 900 });

// Offline mid-render: a deeper request failing (not the page's first request)
// should surface "Cannot reach the server", not render as if the opponent had
// no data. Only the dossier's own calls are aborted; the page shell is already
// loaded, so this exercises exactly the fetch calls inside renderDossier.
ignoreRequestFailures = true;
await page.route('**/api/scout/**', route => route.abort());
await page.route('**/api/games', route => route.abort());
await page.evaluate(() => { location.hash = '#/scout/' + encodeURIComponent('Karpov, A'); });
await page.getByText('Cannot reach the server', { exact: false }).first().waitFor({ timeout: 8000 });
await page.unroute('**/api/scout/**');
await page.unroute('**/api/games');
ignoreRequestFailures = false;

await browser.close();
server.kill();
if (problems.length) {
  console.error('UI smoke test found problems:\n' + problems.map(p => '  - ' + p).join('\n'));
  console.error('\nserver log:\n' + serverLog.slice(-2000));
  process.exit(1);
}
console.log(`UI smoke test passed: ${PAGES.length} pages rendered without errors`);
