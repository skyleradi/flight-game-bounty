#!/usr/bin/env node
// Render a candidate scene to a PNG for inspection (no JPEG, no gate coupling).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const scenes = process.argv.slice(2);
const W = 1280;
const H = 720;
const DIR = '/tmp/cand';
mkdirSync(DIR, { recursive: true });

if (scenes.length === 0) scenes.push('air');

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
  ],
});

const q = Number(process.env.SS || 1);
for (const scene of scenes) {
  const page = await browser.newPage({ viewport: { width: W * q, height: H * q } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  try {
    await page.goto(`http://localhost:8080/?shot=${scene}`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 180000 });
    await page.waitForTimeout(900);
    const png = `${DIR}/${scene}.png`;
    await page.screenshot({ path: png, type: 'png' });
    console.log(`${scene.padEnd(14)} OK -> ${png}${errs.length ? `  ERR ${errs[0].slice(0, 120)}` : ''}`);
  } catch (e) {
    console.log(`${scene.padEnd(14)} FAILED ${e.message.slice(0, 120)}`);
  } finally {
    await page.close();
  }
}
await browser.close();
