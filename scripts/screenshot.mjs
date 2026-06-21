// scripts/screenshot.mjs — drive LaunchSim in a headless browser and capture
// screenshots at key moments (pad, max Q, orbit). Loads index.html via file://
// (no server needed) since the app uses plain <script> tags.
//
// Usage:  node scripts/screenshot.mjs [--headed]
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'screenshots');
const indexUrl = pathToFileURL(join(root, 'index.html')).href;
const headed = process.argv.includes('--headed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read a telemetry value by its label (the <dd> after the matching <dt>).
async function readout(page, label) {
  return page.evaluate((lbl) => {
    const dt = [...document.querySelectorAll('#readouts dt')].find((n) => n.textContent === lbl);
    return dt ? dt.nextElementSibling.textContent : null;
  }, label);
}
const status = (page) => page.$eval('#status', (n) => n.textContent);

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(indexUrl);
await page.waitForSelector('#launchBtn');
await sleep(300);

await page.screenshot({ path: join(outDir, '01-pad.png') });
console.log('captured  01-pad.png        —', await status(page));

// Slow the sim a touch so the script reliably catches each phase on screen.
await page.fill('#warp', '8');
await page.click('#launchBtn');

let gotMaxQ = false;
let gotOrbit = false;
const start = Date.now();
while (Date.now() - start < 120000 && !gotOrbit) {
  const st = await status(page);
  if (!gotMaxQ && /MAX Q/i.test(st)) {
    await page.screenshot({ path: join(outDir, '02-maxq.png') });
    console.log('captured  02-maxq.png       —', st, '| q =', await readout(page, 'Dyn. pressure'));
    gotMaxQ = true;
  }
  if (/orbit/i.test(st)) {
    await page.screenshot({ path: join(outDir, '03-orbit.png') });
    const peri = await readout(page, 'Periapsis');
    const apo = await readout(page, 'Apoapsis');
    console.log('captured  03-orbit.png      —', st, '| peri', peri, '| apo', apo);
    gotOrbit = true;
  }
  if (/Crashed/i.test(st)) {
    console.log('mission ended in a crash:', st);
    break;
  }
  await sleep(120);
}

if (!gotMaxQ) console.log('warning: never observed a MAX Q event');
if (!gotOrbit) console.log('warning: never reached orbit');

await browser.close();
console.log('done. screenshots in', outDir);
