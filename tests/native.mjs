// Keep an isolated installed-Chrome window open for physical macOS key testing.
// Send Cmd+[ / Cmd+] with the native computer-use API; no user profile is used.
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(resolve(tmpdir(), 'linked-history-native-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
});
const cdp = await context.browser().newBrowserCDPSession();
await cdp.send('Extensions.loadUnpacked', {path: resolve(root, 'extension')});
await cdp.detach();
await context.route('http://native.fixture.test/**', route => route.fulfill({
  contentType: 'text/html', body: '<!doctype html><title>Linked History — проверка клавиш</title>' +
    '<body tabindex="0" style="min-height:100vh;font:24px system-ui">' +
    '<h1>Проверка Cmd + [ / ]</h1><a target="_blank" href="http://native.fixture.test/b0">Открыть B</a></body>',
}));
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const read = () => worker.evaluate(async () => (await chrome.storage.session.get('linkedHistory')).linkedHistory);
async function until(predicate, label) {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    if (await predicate()) {console.log(`PASS native ${label}`); return;}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const a = await context.newPage();
  await a.goto('http://native.fixture.test/a0');
  await a.goto('http://native.fixture.test/a1');
  const childEvent = context.waitForEvent('page');
  await a.locator('a').click();
  let b = await childEvent;
  await b.waitForURL('http://native.fixture.test/b0');
  await b.goto('http://native.fixture.test/b1');
  await b.bringToFront();
  await b.locator('h1').click();
  console.log('READY native B1. Press Cmd+[ twice, Cmd+[ once in A, then Cmd+] three times.');
  await until(() => b.url().endsWith('/b0'), 'B1 → B0');
  await until(() => b.isClosed(), 'B closed');
  await until(() => a.url().endsWith('/a0'), 'A1 → A0');
  await until(() => a.url().endsWith('/a1'), 'A0 → A1');
  await until(() => context.pages().some(page => page.url().endsWith('/b0')), 'B restored');
  b = context.pages().find(page => page.url().endsWith('/b0'));
  await until(() => b.url().endsWith('/b1'), 'B0 → B1 after restoration');
  const tabs = await worker.evaluate(() => chrome.tabs.query({}));
  const source = tabs.find(tab => tab.url.endsWith('/a1'));
  const child = tabs.find(tab => tab.url.endsWith('/b1'));
  assert.equal(child.index, source.index + 1);
  assert.equal(child.active, true);
  assert.equal((await read()).notice, null);
  console.log('All physical macOS keys passed in installed Chrome.');
} finally {
  await context.close();
  await rm(profile, {recursive: true, force: true});
}
