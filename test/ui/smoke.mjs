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
  ['#/report', 'Focus areas'],
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
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('console', msg => { if (msg.type() === 'error') problems.push(`console error on ${page.url()}: ${msg.text()}`); });
page.on('pageerror', err => problems.push(`page error on ${page.url()}: ${err.message}`));
page.on('requestfailed', req => problems.push(`request failed on ${page.url()}: ${req.url()} ${req.failure()?.errorText}`));
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
// Giving up is a miss, so the explain-back line comes before the coach's
// answer and the grade buttons; skipping it reaches "Continue".
await page.getByText('Show answer').first().click({ timeout: 8000 });
await page.locator('#explain-back').waitFor({ timeout: 8000 });
await page.locator('#eb-skip').click({ timeout: 8000 });
await page.getByText('Continue', { exact: false }).first().waitFor({ timeout: 8000 });

await browser.close();
server.kill();
if (problems.length) {
  console.error('UI smoke test found problems:\n' + problems.map(p => '  - ' + p).join('\n'));
  console.error('\nserver log:\n' + serverLog.slice(-2000));
  process.exit(1);
}
console.log(`UI smoke test passed: ${PAGES.length} pages rendered without errors`);
