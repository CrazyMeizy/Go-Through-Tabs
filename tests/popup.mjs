import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(resolve(tmpdir(), 'go-through-tabs-popup-'));
const installedChrome = process.env.CHROME_EXECUTABLE;
const context = await chromium.launchPersistentContext(profile, {
  ...(installedChrome ? {executablePath: installedChrome} : {channel: 'chromium'}),
  headless: process.env.HEADED !== '1',
  viewport: {width: 340, height: 700},
  ignoreDefaultArgs: ['--disable-extensions'],
  args: installedChrome ? ['--enable-unsafe-extension-debugging'] :
    [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`],
});
context.setDefaultTimeout(12000);
const errors = [];
const externalRequests = [];
context.on('page', page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url())) externalRequests.push(request.url());
  });
});
const passed = [];
const screenshots = resolve(root, 'screenshots');
await mkdir(screenshots, {recursive: true});

if (installedChrome) {
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', {path: resolve(root, 'extension')});
  await cdp.detach();
}
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;
const popupUrl = `chrome-extension://${extensionId}/popup.html`;
const state = () => worker.evaluate(async () => (await chrome.storage.session.get('linkedHistory')).linkedHistory);
const phase = (page, expected) => page.waitForFunction(value =>
  document.querySelector('#control').dataset.phase === value, expected);
const checked = async (page, expected) => {
  await phase(page, 'ready');
  assert.equal(await page.locator('#toggle').getAttribute('aria-checked'), String(expected));
  assert.equal(await page.locator('#toggle').isEnabled(), true);
};
function pass(name) { passed.push(name); console.log(`PASS ${name}`); }
async function shot(page, name) {
  await page.mouse.move(0, 0);
  await page.locator('body').screenshot({path: resolve(screenshots, `${name}.png`), animations: 'disabled'});
}
async function geometry(page) {
  return page.locator('#toggle').boundingBox();
}
async function noHorizontalOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}
function rgb(value) {
  if (value.startsWith('#')) return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
  return value.match(/[\d.]+/g).slice(0, 3).map(Number);
}
function contrast(a, b) {
  const luminance = value => rgb(value).map(channel => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
async function themeChecks(page, theme) {
  await page.emulateMedia({colorScheme: theme});
  const tokens = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return Object.fromEntries(['background', 'surface', 'text', 'muted', 'accent', 'switch-knob',
      'switch-off', 'warning-background', 'warning-text'].map(key => [key, css.getPropertyValue(`--${key}`).trim()]));
  });
  assert.equal(tokens.background, theme === 'light' ? '#f7f8fa' : '#202328');
  for (const foreground of ['text', 'muted']) {
    for (const background of ['background', 'surface']) assert.ok(contrast(tokens[foreground], tokens[background]) >= 4.5);
  }
  assert.ok(contrast(tokens['warning-text'], tokens['warning-background']) >= 4.5);
  assert.ok(contrast(tokens.accent, tokens.surface) >= 3);
  assert.ok(contrast(tokens['switch-knob'], tokens.accent) >= 3);
  assert.ok(contrast(tokens['switch-knob'], tokens['switch-off']) >= 3);
  await noHorizontalOverflow(page);
}

// Failure scenarios run the same extension document; only its transport is substituted.
async function mockPopup(mode = 'normal', notice = null) {
  const page = await context.newPage();
  await page.addInitScript(({mode, notice}) => {
    const fixture = window.fixture = {mode, notice, enabled: true, calls: [], resolve: null};
    chrome.runtime.sendMessage = ({type}) => {
      fixture.calls.push(type);
      if (fixture.mode === 'reject') return Promise.reject(new Error('Disconnected'));
      if (fixture.mode === 'invalid') return Promise.resolve({});
      if ((fixture.mode === 'slow-status' && type === 'status') ||
          (['slow-toggle', 'late-toggle'].includes(fixture.mode) && type === 'toggle')) {
        return new Promise(resolve => { fixture.resolve = resolve; });
      }
      if (type === 'toggle') { fixture.enabled = !fixture.enabled; fixture.notice = null; }
      return Promise.resolve({enabled: fixture.enabled, notice: fixture.notice});
    };
  }, {mode, notice});
  await page.goto(popupUrl);
  return page;
}

// Chrome puts action popups in a separate browser context, outside Playwright's pages.
// Attach to that real target with CDP instead of changing the worker to accept tab messages.
async function nativePopup() {
  await worker.evaluate(() => chrome.action.openPopup());
  const cdp = await context.browser().newBrowserCDPSession();
  const target = (await cdp.send('Target.getTargets')).targetInfos.find(info => info.url === popupUrl);
  assert.ok(target, 'Chrome opened the action popup');
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
  let sequence = 0;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  async function send(method, params = {}) {
    const id = ++sequence;
    const response = new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
    await cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})});
    return response;
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  }
  async function until(expression) {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Native popup timed out: ${expression}; ${await evaluate('JSON.stringify({phase:document.querySelector("#control").dataset.phase,state:document.querySelector("#control-state").textContent,focus:document.activeElement.id})')}`);
  }
  await send('Page.enable');
  await until("document.querySelector('#control')?.dataset.phase === 'ready'");
  return {
    evaluate, until,
    async key(key, code, windowsVirtualKeyCode) {
      const text = code === 'Enter' ? '\r' : key;
      await send('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode, text, unmodifiedText: text});
      await send('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode});
    },
    async screenshot(theme) {
      await send('Emulation.setEmulatedMedia', {features: [
        {name: 'prefers-color-scheme', value: theme},
        {name: 'prefers-reduced-motion', value: 'reduce'},
      ]});
      await evaluate('document.activeElement.blur()');
      const clip = await evaluate('({x:0,y:0,width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height,scale:1})');
      const {data} = await send('Page.captureScreenshot', {format: 'png', clip, captureBeyondViewport: true});
      await writeFile(resolve(screenshots, `popup-native-${theme}.png`), Buffer.from(data, 'base64'));
    },
    async close() {
      await cdp.send('Target.closeTarget', {targetId: target.targetId});
      await cdp.detach();
    },
  };
}

try {
  const manifest = JSON.parse(await readFile(resolve(root, 'extension/manifest.json')));
  assert.equal(manifest.name, 'Go Through Tabs');
  assert.equal(manifest.version, JSON.parse(await readFile(resolve(root, 'package.json'))).version);
  for (const [size, path] of Object.entries(manifest.icons)) {
    const png = await readFile(resolve(root, 'extension', path));
    assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
  assert.equal(await worker.evaluate(() => chrome.action.getTitle({})), 'Go Through Tabs');
  let native = await nativePopup();
  assert.equal(await native.evaluate("document.querySelector('#toggle').getAttribute('aria-checked')"), 'true');
  assert.equal(await native.evaluate("getComputedStyle(document.querySelector('#connection-error')).display"), 'none');
  assert.equal(await native.evaluate("getComputedStyle(document.querySelector('#notice')).display"), 'none');
  await native.screenshot('light');
  await native.evaluate("document.querySelector('#toggle').focus()");
  await native.key(' ', 'Space', 32);
  await native.until("document.querySelector('#control-state').textContent === 'Отключено'");
  assert.equal((await state()).enabled, false);
  await native.close();
  native = await nativePopup();
  assert.equal(await native.evaluate("document.querySelector('#toggle').getAttribute('aria-checked')"), 'false');
  await native.evaluate("document.querySelector('#toggle').focus()");
  await native.key('Enter', 'Enter', 13);
  await native.until("document.querySelector('#control-state').textContent === 'Включено'");
  assert.equal((await state()).enabled, true);
  await native.screenshot('dark');
  await native.close();
  pass('Real Chrome action popup: metadata, icons, keyboard toggle, reopen and both themes');

  let page = await mockPopup();
  await checked(page, true);
  assert.equal(await page.title(), 'Go Through Tabs');
  assert.equal((await page.locator('body').boundingBox()).width, 340);
  assert.equal(await page.locator('.brand-icon').evaluate(image => image.complete && image.naturalWidth > 0), true);
  assert.ok((await page.locator('#toggle').ariaSnapshot()).includes('Навигация по вкладкам'));
  await themeChecks(page, 'light');
  await shot(page, 'popup-light');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'toggle');
  assert.equal(await page.locator('#toggle').evaluate(element => getComputedStyle(element).outlineWidth), '2px');
  await page.keyboard.press('Space');
  await checked(page, false);
  assert.equal(await page.evaluate(() => fixture.enabled), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'toggle');
  await page.close();
  page = await mockPopup();
  await page.locator('#toggle').click();
  await checked(page, false);
  await page.keyboard.press('Enter');
  await checked(page, true);
  assert.equal(await page.evaluate(() => fixture.enabled), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'SUMMARY');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('details').getAttribute('open'), '');
  assert.equal(await page.locator('.help-copy').isVisible(), true);
  await shot(page, 'popup-help');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('details').getAttribute('open'), null);
  pass('Accessible switch and help: Tab, Space, Enter, focus and disclosure');

  await themeChecks(page, 'dark');
  await page.evaluate(() => document.activeElement.blur());
  await shot(page, 'popup-dark');
  await page.emulateMedia({reducedMotion: 'reduce'});
  assert.equal(await page.locator('.switch-thumb').evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  await page.emulateMedia({forcedColors: 'active'});
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarColor), 'auto');
  assert.equal(await page.locator('.switch-track').evaluate(element => getComputedStyle(element).borderTopWidth), '1px');
  await page.emulateMedia({forcedColors: 'none', reducedMotion: 'no-preference'});
  await page.setViewportSize({width: 280, height: 400});
  await page.locator('summary').click();
  await noHorizontalOverflow(page);
  assert.equal((await page.locator('body').boundingBox()).width, 280);
  await page.locator('.help-copy').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.help-copy').isVisible(), true);
  pass('Light/dark contrast, narrow layout, reduced motion and forced colors');
  await page.close();

  page = await mockPopup('slow-status');
  const loadingGeometry = await geometry(page);
  assert.equal(await page.locator('#toggle').isDisabled(), true);
  assert.equal(await page.locator('#toggle').getAttribute('aria-busy'), 'true');
  await shot(page, 'popup-loading');
  await page.evaluate(() => {fixture.mode = 'normal'; fixture.resolve({enabled: true, notice: null});});
  await checked(page, true);
  assert.deepEqual(await geometry(page), loadingGeometry);
  await page.evaluate(() => { fixture.mode = 'slow-toggle'; document.querySelector('#toggle').click(); });
  await phase(page, 'saving');
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) document.querySelector('#toggle').dispatchEvent(new MouseEvent('click'));
  });
  assert.deepEqual(await page.evaluate(() => fixture.calls), ['status', 'toggle']);
  assert.deepEqual(await geometry(page), loadingGeometry);
  await page.evaluate(() => {fixture.enabled = false; fixture.mode = 'normal'; fixture.resolve({enabled: false, notice: null});});
  await checked(page, false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'toggle');
  pass('Loading and slow toggle preserve geometry and suppress duplicate activation');
  await page.close();

  for (const mode of ['reject', 'invalid']) {
    page = await mockPopup(mode);
    await phase(page, 'error');
    assert.equal(await page.locator('#toggle').isDisabled(), true);
    assert.equal(await page.locator('#connection-error').isVisible(), true);
    if (mode === 'reject') await shot(page, 'popup-error');
    await page.evaluate(() => { fixture.mode = 'normal'; });
    await page.locator('#retry').click();
    await checked(page, true);
    assert.deepEqual(await page.evaluate(() => fixture.calls), ['status', 'status']);
    assert.equal(await page.locator('#connection-error').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'toggle');
    await page.close();
  }
  pass('Disconnected/invalid responses offer read-only recovery and restore focus');

  page = await mockPopup();
  await checked(page, true);
  const readyGeometry = await geometry(page);
  await page.evaluate(() => {fixture.mode = 'late-toggle'; document.querySelector('#toggle').click();});
  await phase(page, 'saving');
  await phase(page, 'error');
  assert.equal(await page.locator('#toggle').isDisabled(), true);
  assert.deepEqual(await geometry(page), readyGeometry);
  await page.evaluate(() => {
    fixture.enabled = false;
    fixture.mode = 'normal';
    fixture.resolve({enabled: false, notice: null});
  });
  // A late completion cannot make the unknown state look confirmed.
  assert.equal(await page.locator('#control').getAttribute('data-phase'), 'error');
  await page.locator('#retry').click();
  await checked(page, false);
  assert.deepEqual(await page.evaluate(() => fixture.calls), ['status', 'toggle', 'status']);
  pass('Timed-out toggle ignores late responses; recovery never repeats a mutation');
  await page.close();

  const note = 'История закрытой вкладки недоступна. Открыта сохранённая страница.';
  page = await mockPopup('normal', note);
  await checked(page, true);
  assert.equal(await page.locator('#notice-text').textContent(), note);
  await themeChecks(page, 'light');
  await shot(page, 'popup-notice');
  const long = `${note} `.repeat(15) + '<img src=x onerror=alert(1)>';
  await page.close();
  page = await mockPopup('normal', long);
  await checked(page, true);
  assert.equal(await page.locator('#notice-text').textContent(), long);
  assert.equal(await page.locator('#notice-text img').count(), 0);
  await noHorizontalOverflow(page);
  assert.equal(await page.locator('#notice-text').evaluate(element => element.scrollHeight > element.clientHeight), true);
  await page.locator('#notice-text').focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.querySelector('#notice-text').scrollTop > 0);
  assert.notEqual(await page.locator('#notice-text').evaluate(element => getComputedStyle(element).scrollbarColor), 'auto');
  await page.locator('#toggle').click();
  await checked(page, false);
  assert.equal(await page.locator('#notice').isVisible(), false);
  pass('Notices wrap safely, remain keyboard-scrollable and clear after toggle');
  await page.close();

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  await writeFile(resolve(root, 'popup-test-results.json'), JSON.stringify({
    browser: context.browser().version(), passed, pageErrors: errors, externalRequests,
    screenshots: ['popup-native-light', 'popup-native-dark', 'popup-light', 'popup-dark', 'popup-help', 'popup-loading', 'popup-error', 'popup-notice'],
  }, null, 2) + '\n');
  console.log(`${passed.length} popup scenario groups passed; screenshots: ${screenshots}`);
} finally {
  await context.close();
  await rm(profile, {recursive: true, force: true});
}
