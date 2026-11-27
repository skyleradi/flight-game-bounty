// Renders a list of scenes to /tmp/cand-<name>.png at the delivery size, one browser per scene
// so a scene that wedges cannot take the batch with it.
// Usage: node tools/render.mjs <scene> [scene...]
import { chromium } from 'playwright';

const scenes = process.argv.slice(2);
const EXEC = '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

for (const scene of scenes) {
  const browser = await chromium.launch({
    executablePath: EXEC,
    args: [
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`http://localhost:8080/?shot=${scene}`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 180000 });
    await page.waitForTimeout(1200);
    const dest = `/tmp/cand-${scene}.png`;
    await page.screenshot({ path: dest, type: 'png' });
    if (errs.length) console.log(scene, 'ERRS', errs.slice(0, 2));
    console.log('wrote', dest);
  } catch (err) {
    console.log(scene, 'FAILED', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
}
