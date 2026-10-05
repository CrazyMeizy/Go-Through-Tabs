import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = fileURLToPath(new URL('../extension/icons/', import.meta.url));
const svg = await readFile(`${directory}linked-tabs.svg`);
const browser = await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {}),
  headless: true,
});
try {
  const page = await browser.newPage({deviceScaleFactor: 1});
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({width: size, height: size});
    await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="data:image/svg+xml;base64,${svg.toString('base64')}">`);
    await page.locator('img').evaluate(image => image.decode());
    await page.screenshot({path: `${directory}icon-${size}.png`, omitBackground: true});
    console.log(`Created icon-${size}.png`);
  }
} finally {
  await browser.close();
}
