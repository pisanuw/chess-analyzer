// Render public/icon.svg to the PNG sizes a home-screen install needs: iOS
// ignores an SVG apple-touch-icon (the installed app gets a screenshot tile)
// and Android's install prompt wants 192 and 512 px PNGs in the manifest. The
// PNGs are committed, so this only needs re-running when the SVG changes:
//   node scripts/make-icons.js   (uses the Playwright Chromium; CHROMIUM_PATH overrides)
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SIZES = { 'icon-180.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };
const svg = readFileSync('public/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  for (const [file, size] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    writeFileSync(`public/${file}`, await page.locator('svg').screenshot({ omitBackground: true, type: 'png' }));
    await page.close();
    console.log(`wrote public/${file} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
