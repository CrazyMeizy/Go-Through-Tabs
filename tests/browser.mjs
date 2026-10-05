import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(resolve(tmpdir(), 'linked-history-test-'));
const installedChrome = process.env.CHROME_EXECUTABLE;
const context = await chromium.launchPersistentContext(profile, {
  ...(installedChrome ? {executablePath: installedChrome} : {channel: 'chromium'}),
  headless: process.env.HEADED !== '1',
  ignoreDefaultArgs: ['--disable-extensions', '--disable-back-forward-cache'],
  args: installedChrome ? ['--enable-unsafe-extension-debugging'] :
    [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`],
});
if (installedChrome) {
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', {path: resolve(root, 'extension')});
  await cdp.detach();
}
const errors = [];
context.setDefaultTimeout(12000);
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route('http://*.fixture.test/**', route => route.fulfill({
  contentType: 'text/html', body: `<!doctype html><title>History fixture</title>
  <body tabindex="0" style="min-height:100vh"><a id="child" target="_blank" href="http://b.fixture.test/b0">Child</a>
  <input id="input"><script>window.fixtureState = {untouched: true};</script></body>`,
}));
let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
worker.on('console', message => {
  if (message.type() === 'warning' || message.type() === 'error') {
    errors.push(message.text()); console.error(message.text());
  }
});
const extensionId = new URL(worker.url()).host;
const read = () => worker.evaluate(async () => (await chrome.storage.session.get('linkedHistory')).linkedHistory);
async function until(predicate, description, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${description}\n${JSON.stringify(await read())}`);
}
const tabFor = async page => worker.evaluate(async url =>
  (await chrome.tabs.query({})).find(tab => tab.url === url), page.url());
async function focus(page) {
  await page.bringToFront();
  const tab = await tabFor(page);
  await worker.evaluate(id => chrome.tabs.update(id, {active: true}), tab.id);
  await page.locator('body').click({position: {x: 5, y: 80}});
}
async function key(page, direction, expectedUrl) {
  await page.keyboard.press(`Meta+${direction === 'back' ? 'BracketLeft' : 'BracketRight'}`);
  if (expectedUrl) await until(() => page.url() === expectedUrl, expectedUrl);
  await until(async () => {
    const state = await read();
    const tab = await tabFor(page);
    const node = Object.values(state.nodes).find(node => node.tabId === tab?.id);
    return node?.currentKey === await page.evaluate(() => navigation.currentEntry.key);
  }, 'worker observes entry');
}
async function openChild(parent, url) {
  await parent.locator('#child').evaluate((link, url) => {link.href = url;}, url);
  const promise = context.waitForEvent('page');
  await parent.locator('#child').click();
  const child = await promise;
  await child.waitForURL(url);
  await until(async () => Object.values((await read()).nodes).some(node => node.url === url && node.parentId && node.rootKey), 'linked child ready');
  await focus(child);
  return child;
}
async function restoredPage(parent, url) {
  const promise = context.waitForEvent('page');
  await parent.keyboard.press('Meta+BracketRight');
  const page = await promise.catch(async error => {throw new Error(`${error.message}\n${JSON.stringify(await read())}`);});
  await page.waitForURL(url);
  await until(async () => {
    const tabs = await worker.evaluate(() => chrome.tabs.query({}));
    const source = tabs.find(tab => tab.url === parent.url());
    const child = tabs.find(tab => tab.url === url);
    return child?.active && child.index === source.index + 1;
  }, 'restored adjacent active child');
  return page;
}
function passed(name) {console.log(`PASS ${name}`);}

try {
  const a = await context.newPage();
  await a.goto('http://a.fixture.test/a0');
  await a.goto('http://a.fixture.test/a1');
  await a.goto('http://a.fixture.test/a2');
  await focus(a);
  let b = await openChild(a, 'http://b.fixture.test/b0');
  await b.goto('http://c.fixture.test/b1');
  await until(async () => Object.values((await read()).nodes).some(node => node.url === b.url()), 'cross-origin committed');
  await key(b, 'back', 'http://b.fixture.test/b0');
  const closed = b.waitForEvent('close');
  await b.keyboard.press('Meta+BracketLeft');
  await closed.catch(async error => {throw new Error(`${error.message}\n${JSON.stringify(await read())}`);});
  await until(async () => Object.values((await read()).nodes).some(node => node.closed?.sessionId), 'closed session identified');
  await key(a, 'back', 'http://a.fixture.test/a1');
  await key(a, 'back', 'http://a.fixture.test/a0');
  await key(a, 'forward', 'http://a.fixture.test/a1');
  await key(a, 'forward', 'http://a.fixture.test/a2');
  b = await restoredPage(a, 'http://b.fixture.test/b0');
  await key(b, 'forward', 'http://c.fixture.test/b1');
  passed('A0 → A1 → A2 → B0 → B1 across origins, full session history and adjacency');

  await key(b, 'back', 'http://b.fixture.test/b0');
  let c = await openChild(b, 'http://c.fixture.test/c0');
  let closeEvent = c.waitForEvent('close');
  await c.keyboard.press('Meta+BracketLeft');
  await closeEvent;
  await until(async () => Object.values((await read()).nodes).filter(node => node.closed).length === 1, 'C closed');
  closeEvent = b.waitForEvent('close');
  await b.keyboard.press('Meta+BracketLeft');
  await closeEvent;
  await until(async () => Object.values((await read()).nodes).filter(node => node.closed).length === 2, 'B closed');
  b = await restoredPage(a, 'http://b.fixture.test/b0');
  c = await restoredPage(b, 'http://c.fixture.test/c0');
  passed('A → B → C closes and restores with stable logical IDs');

  await c.evaluate(() => {
    history.replaceState({fixture: 1}, '', location.href);
    history.pushState({fixture: 2}, '', '/c1');
    location.hash = 'section';
  });
  await key(c, 'back', 'http://c.fixture.test/c1');
  assert.deepEqual(await c.evaluate(() => history.state), {fixture: 2});
  await key(c, 'back', 'http://c.fixture.test/c0');
  assert.deepEqual(await c.evaluate(() => history.state), {fixture: 1});
  passed('SPA pushState, replaceState, hash and application state preservation');

  closeEvent = c.waitForEvent('close');
  await c.keyboard.press('Meta+BracketLeft');
  await closeEvent;
  await until(async () => Object.values((await read()).nodes).some(node => node.closed && node.url.endsWith('/c0')), 'C closed again');
  await b.goto('http://b.fixture.test/new-branch');
  await until(async () => Object.values((await read()).nodes).find(node => node.url.endsWith('/new-branch'))?.forward.length === 0, 'new branch cleared');
  const pageCount = context.pages().length;
  await key(b, 'forward');
  assert.equal(context.pages().length, pageCount);
  passed('new navigation invalidates closed forward branch');

  // Distinct entries may have the exact same address.
  c = await openChild(b, 'http://c.fixture.test/duplicate');
  await c.evaluate(() => history.pushState({duplicate: true}, '', location.href));
  const duplicateKey = await c.evaluate(() => navigation.currentEntry.key);
  await c.keyboard.press('Meta+BracketLeft');
  await until(async () => !c.isClosed() && await c.evaluate(() => navigation.currentEntry.key) !== duplicateKey, 'duplicate URL traversed');
  assert.equal(c.isClosed(), false);
  // A key pressed inside a cross-origin frame still navigates its owner tab.
  await c.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.src = 'http://frame.fixture.test/inside';
    document.body.append(frame);
  });
  const frame = await until(() => c.frames().find(frame => frame.url().endsWith('/inside')), 'cross-origin frame');
  await frame.locator('#input').focus();
  await c.keyboard.press('Meta+BracketRight');
  await until(async () => await c.evaluate(() => navigation.currentEntry.key) === duplicateKey, 'forward key from frame');
  await key(c, 'back');
  // Iframe pushState adds a joint native history step while the top key stays at root.
  await frame.evaluate(() => history.pushState({inside: true}, '', '/inside-2'));
  await c.keyboard.press('Meta+BracketLeft');
  await until(() => frame.url().endsWith('/inside'), 'iframe history back preserved');
  assert.equal(c.isClosed(), false);
  closeEvent = c.waitForEvent('close');
  await c.keyboard.press('Meta+BracketLeft');
  await closeEvent;
  await until(async () => Object.values((await read()).nodes).some(node => node.closed?.sessionId), 'duplicate child closed');
  // A later unrelated close must not steal this child's restore operation.
  const unrelated = await context.newPage();
  await unrelated.goto('http://other.fixture.test/unrelated');
  await unrelated.close();
  await focus(b);
  c = await restoredPage(b, 'http://c.fixture.test/duplicate');
  passed('duplicate URLs, iframe keyboard/history and unrelated recently closed tab');

  // A queued sequence can cross a tab close and keep navigating its source.
  await focus(c);
  closeEvent = c.waitForEvent('close');
  await c.keyboard.press('Meta+BracketLeft');
  await closeEvent;
  await until(async () => Object.values((await read()).nodes).some(node => node.closed?.sessionId), 'repeat child closed');
  await b.evaluate(() => {history.pushState(null, '', '/rapid-1'); history.pushState(null, '', '/rapid-2');});
  await b.keyboard.press('Meta+BracketLeft');
  await b.keyboard.press('Meta+BracketLeft');
  await until(() => b.url() === 'http://b.fixture.test/new-branch', 'two rapid backs');
  await b.keyboard.press('Meta+BracketRight');
  await b.keyboard.press('Meta+BracketRight');
  await until(() => b.url() === 'http://b.fixture.test/rapid-2', 'two rapid forwards');
  passed('rapid repeated native traversal without dropped steps');

  await b.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.src = 'http://frame.fixture.test/source-frame';
    document.body.append(frame);
  });
  const sourceFrame = await until(() => b.frames().find(frame => frame.url().endsWith('/source-frame')), 'source frame');
  await sourceFrame.evaluate(() => history.pushState(null, '', '/source-frame-2'));

  c = await openChild(b, 'http://c.fixture.test/fallback');
  closeEvent = c.waitForEvent('close');
  await c.keyboard.press('Meta+BracketLeft');
  await closeEvent;
  await until(async () => Object.values((await read()).nodes).some(node => node.closed?.sessionId), 'fallback session ready');
  await b.keyboard.press('Meta+BracketLeft');
  await until(() => sourceFrame.url().endsWith('/source-frame'), 'source frame back');
  await b.keyboard.press('Meta+BracketRight');
  await until(() => sourceFrame.url().endsWith('/source-frame-2'), 'source frame forward before restoring tab');
  assert.equal(context.pages().some(page => page.url().endsWith('/fallback')), false);
  passed('frame traversal precedes the cross-tab restoration boundary');
  await worker.evaluate(async () => {
    const {linkedHistory} = await chrome.storage.session.get('linkedHistory');
    for (const node of Object.values(linkedHistory.nodes)) if (node.closed) node.closed.sessionId = 'expired';
    await chrome.storage.session.set({linkedHistory});
  });
  // Reloading the worker loads the modified durable state, like browser eviction.
  const cdp = await context.newCDPSession(b);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await b.keyboard.press('Meta+BracketRight');
  worker = await until(async () => context.serviceWorkers().find(item => item.url().includes(extensionId)), 'worker awake');
  c = await until(() => context.pages().find(page => page.url() === 'http://c.fixture.test/fallback'), 'URL fallback page');
  await until(async () => (await read()).notice, 'fallback notice');
  assert.equal(await c.evaluate(() => navigation.canGoBack), false);
  passed('service worker restart and expired-session URL fallback');

  const source = await context.newPage();
  await source.goto('http://source.fixture.test/background-source');
  await focus(source);
  await source.locator('#child').evaluate(link => {
    link.target = '_self'; link.href = 'http://child.fixture.test/background-child';
  });
  const backgroundEvent = context.waitForEvent('page');
  await source.locator('#child').click({modifiers: ['Meta']});
  const background = await backgroundEvent;
  const sourceTab = await tabFor(source);
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), sourceTab.id)).active, true);
  // Chrome may defer loading a newly opened background tab until activation.
  await background.bringToFront();
  await background.waitForURL('http://child.fixture.test/background-child').catch(error => {
    throw new Error(`${error.message}; background URL: ${background.url()}`);
  });
  await until(async () => Object.values((await read()).nodes).some(node => node.url === background.url() && node.parentId), 'background child linked');
  await focus(background);
  await worker.evaluate(id => chrome.tabs.move(id, {index: 0}), sourceTab.id);
  closeEvent = background.waitForEvent('close');
  await background.keyboard.press('Meta+BracketLeft');
  await closeEvent;
  await until(async () => Object.values((await read()).nodes).some(node => node.url.endsWith('/background-child') && node.closed?.sessionId), 'background child session');
  await source.reload();
  await focus(source);
  const backgroundRestored = await restoredPage(source, 'http://child.fixture.test/background-child');
  await source.close();
  await focus(backgroundRestored);
  await key(backgroundRestored, 'back');
  assert.equal(backgroundRestored.isClosed(), false);
  passed('background link, moved source adjacency, source reload and manually closed source safety');

  assert.deepEqual(errors, []);
  console.log('All browser integration scenarios passed.');
} finally {
  await context.close();
  await rm(profile, {recursive: true, force: true});
}
