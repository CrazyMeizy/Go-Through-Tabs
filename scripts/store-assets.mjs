import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'store/assets');
await mkdir(output, {recursive: true});
const browser = await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {}),
  headless: true,
});
try {
  const page = await browser.newPage({deviceScaleFactor: 1});
  for (const [mode, width, height, file] of [
    ['light', 1280, 800, 'screenshot-light.png'],
    ['dark', 1280, 800, 'screenshot-dark.png'],
    ['small', 440, 280, 'promo-small.png'],
  ]) {
    await page.setViewportSize({width, height});
    const url = new URL('../store/artwork.html', import.meta.url);
    url.searchParams.set('mode', mode);
    await page.goto(url.href);
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await page.screenshot({path: resolve(output, file), animations: 'disabled'});
    console.log(`Created ${file} (${width} × ${height})`);
  }
} finally {
  await browser.close();
}
