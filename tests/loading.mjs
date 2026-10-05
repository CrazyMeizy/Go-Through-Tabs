import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(resolve(tmpdir(), 'go-through-tabs-loading-'));
const pending = new Map();
const requests = new Map();
const requestHeaders = new Map();
const requestMethods = new Map();
const released = new Set();
const html = pathname => `<!doctype html><title>${pathname}</title><body tabindex="0">
  <a id="child" target="_blank" href="/child">Child</a>
  <a id="next" href="/next">Next</a><p>${pathname}</p></body>`;
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  requests.set(pathname, (requests.get(pathname) || 0) + 1);
  const methods = requestMethods.get(pathname) || [];
  methods.push(request.method);
  requestMethods.set(pathname, methods);
  requestHeaders.set(pathname, {cookie: request.headers.cookie || '', referer: request.headers.referer || ''});
  if (pathname === '/redirect-initial') {
    response.writeHead(302, {Location: '/headers-redirect-target'});
    response.end();
    return;
  }
  if (pathname.startsWith('/headers-') && !released.has(pathname)) {
    pending.set(pathname, response);
    return;
  }
  if (pathname.startsWith('/resource-') && !released.has(pathname)) {
    pending.set(pathname, response);
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  if (pathname === '/blocked-script') {
    response.end(`<!doctype html><title>Blocked parser</title>
      <script src="/resource-script"></script><body>Blocked parser</body>`);
    return;
  }
  if (pathname === '/slow-image') {
    response.end(`${html(pathname)}<img src="/resource-image">`);
    return;
  }
  response.end(html(pathname));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const childBase = `http://localhost:${server.address().port}`;
const installedChrome = process.env.CHROME_EXECUTABLE;
const context = await chromium.launchPersistentContext(profile, {
  ...(installedChrome ? {executablePath: installedChrome} : {channel: 'chromium'}),
  headless: process.env.HEADED !== '1',
  ignoreDefaultArgs: ['--disable-extensions', '--disable-back-forward-cache'],
  args: installedChrome ? ['--enable-unsafe-extension-debugging'] :
    [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`],
});
context.setDefaultTimeout(8000);
if (installedChrome) {
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', {path: resolve(root, 'extension')});
  await cdp.detach();
}
let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;
const read = () => worker.evaluate(async () => (await chrome.storage.session.get('linkedHistory')).linkedHistory || {nodes: {}});
async function until(predicate, description, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}
const tabs = () => worker.evaluate(() => chrome.tabs.query({}));
async function focus(page, id) {
  await page.bringToFront();
  await worker.evaluate(id => chrome.tabs.update(id, {active: true}), id);
}
function release(pathname) {
  released.add(pathname);
  const response = pending.get(pathname);
  pending.delete(pathname);
  if (response && !response.destroyed) {
    response.setHeader('Content-Type', pathname.startsWith('/resource-') ? 'text/javascript' : 'text/html');
    response.end(pathname.startsWith('/resource-') ? '' : html(pathname));
  }
}
async function attachNewChild(pathname, action, destination = pathname) {
  const browserCdp = await context.browser().newBrowserCDPSession();
  const before = new Set((await browserCdp.send('Target.getTargets')).targetInfos.map(target => target.targetId));
  const count = requests.get(pathname) || 0;
  await action();
  await until(() => (requests.get(pathname) || 0) > count, `${pathname} request started`);
  const possibleUrls = new Set([`${childBase}${pathname}`, `${childBase}${destination}`]);
  const tab = await until(async () => (await tabs()).find(tab =>
    possibleUrls.has(tab.url) || possibleUrls.has(tab.pendingUrl)), 'child tab known');
  const target = await until(async () => (await browserCdp.send('Target.getTargets')).targetInfos.find(target => !before.has(target.targetId) && target.type === 'page'), 'child target known');
  const {sessionId} = await browserCdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
  let sequence = 0;
  const replies = new Map();
  browserCdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const request = replies.get(message.id);
    if (!request) return;
    replies.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  async function send(method, params = {}) {
    const id = ++sequence;
    const response = new Promise((resolve, reject) => replies.set(id, {resolve, reject}));
    await browserCdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})});
    return response;
  }
  const child = {
    async key() {
      await send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: '[', code: 'BracketLeft', windowsVirtualKeyCode: 219, modifiers: 4});
      await send('Input.dispatchKeyEvent', {type: 'keyUp', key: '[', code: 'BracketLeft', windowsVirtualKeyCode: 219, modifiers: 4});
    },
    async isClosed() {return !(await tabs()).some(item => item.id === tab.id);},
    async close() {await worker.evaluate(id => chrome.tabs.remove(id), tab.id);},
  };
  await worker.evaluate(id => chrome.tabs.update(id, {active: true}), tab.id);
  await send('Page.bringToFront');
  await until(async () => Object.values((await read()).nodes).some(node => node.tabId === tab.id && node.parentId), 'link known');
  return {child, tab};
}
async function openChild(parent, pathname, method = 'click', linkPathname = pathname) {
  await parent.locator('#child').evaluate((link, {url, method}) => {
    link.href = url;
    link.target = method === 'click' ? '_blank' : '_self';
  }, {url: `${childBase}${linkPathname}`, method});
  return attachNewChild(pathname, () => parent.locator('#child').click({
    noWaitAfter: true,
    ...(method === 'cmd-click' ? {modifiers: ['Meta']} : {}),
    ...(method === 'middle-click' ? {button: 'middle'} : {}),
  }));
}
async function restoreChild(parent, pathname) {
  const parentTab = (await tabs()).find(tab => tab.url === parent.url());
  await focus(parent, parentTab.id);
  return attachNewChild(pathname, () => parent.keyboard.press('Meta+BracketRight'));
}
async function toggleExtension() {
  await worker.evaluate(() => chrome.action.openPopup());
  const cdp = await context.browser().newBrowserCDPSession();
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const target = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url === popupUrl);
  assert.ok(target, 'real action popup exists');
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
  const response = new Promise((resolve, reject) => {
    cdp.on('Target.receivedMessageFromTarget', event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== 1) return;
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  });
  await cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id: 1,
    method: 'Runtime.evaluate', params: {expression: 'chrome.runtime.sendMessage({type:"toggle"})',
      awaitPromise: true, returnByValue: true}})});
  const result = await response;
  assert.equal(result.exceptionDetails, undefined);
  await cdp.send('Target.closeTarget', {targetId: target.targetId});
  await cdp.detach();
  return result.result.value;
}
function passed(name) { console.log(`PASS ${name}`); }

try {
  const parent = await context.newPage();
  await parent.goto(`${base}/parent`);
  await until(async () => Object.values((await read()).nodes).some(node => node.url === parent.url() && node.currentKey), 'parent observed');

  // Hold the main response indefinitely: a passing key must not wait for it.
  {
    const {child, tab} = await openChild(parent, '/headers-child', 'cmd-click');
    const current = await worker.evaluate(id => chrome.tabs.get(id), tab.id);
    assert.equal(current.status, 'loading');
    assert.ok(pending.has('/headers-child'), 'main response has not been sent');
    assert.equal(requests.get('/headers-child'), 1, 'target URL requested only once when opened');
    const firstBackStart = Date.now();
    await child.key();
    await until(() => child.isClosed(), 'uncommitted child closes before receiving response', 1500);
    const firstBackMs = Date.now() - firstBackStart;
    const node = await until(async () => Object.values((await read()).nodes).find(node =>
      node.closed?.url === `${childBase}/headers-child` && !node.closed.pending), 'pending URL saved for restoration');
    const parentTab = (await tabs()).find(tab => tab.url === parent.url());
    assert.equal(parentTab.active, true, 'source is active after early close');
    assert.equal(node.closed.url, `${childBase}/headers-child`);
    // Keep the response blocked through restoration too: restored bridge keys
    // must work before its real page commits, rather than waiting for timeout.
    const restored = await restoreChild(parent, '/headers-child');
    assert.equal(requests.get('/headers-child'), 2, 'restoring makes one new target request');
    assert.equal((await read()).notice, null, 'uncommitted restoration does not claim lost history');
    await until(async () => {
      const items = await tabs();
      const source = items.find(tab => tab.id === parentTab.id);
      const child = items.find(tab => tab.id === restored.tab.id);
      return child?.active && child.index === source.index + 1;
    }, 'restored pending child active and adjacent');
    const restoredBackStart = Date.now();
    await restored.child.key();
    await until(() => restored.child.isClosed(), 'restored pending child closes before first response', 1500);
    const restoredBackMs = Date.now() - restoredBackStart;
    assert.ok(pending.has('/headers-child'), 'restored response is still blocked');
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === `${childBase}/headers-child` && !node.closed.pending), 'repeat close recorded');
    release('/headers-child');
    const loaded = await restoreChild(parent, '/headers-child');
    await until(async () => (await worker.evaluate(id => chrome.tabs.get(id), loaded.tab.id)).status === 'complete', 'restored page finishes loading');
    // The temporary loading document must not become an extra Back step.
    await loaded.child.key();
    await until(() => loaded.child.isClosed(), 'restored child closes at its real first page', 1500);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === `${childBase}/headers-child` && !node.closed.pending), 'loaded child close recorded');
    passed(`Cmd-click child closes before first response and restores the correct URL without a placeholder history step (${firstBackMs} ms first Back; ${restoredBackMs} ms restored Back)`);
  }
  for (const method of ['middle-click']) {
    const pathname = `/headers-${method}`;
    const {child} = await openChild(parent, pathname, method);
    assert.equal(requests.get(pathname), 1, `${method} opens one target request`);
    await child.key();
    await until(() => child.isClosed(), `${method} child closes before first response`, 1500);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === `${childBase}${pathname}` && !node.closed.pending), `${method} close recorded`);
    release(pathname);
    passed(`${method} child closes before first response without issuing duplicate target requests`);
  }
  // Booking and other sites handle clicks on cards before an event bubbles to
  // window. Exercise real trusted clicks, including native and script opening,
  // while the destination's first response remains indefinitely blocked.
  for (const handler of ['stop-propagation', 'stop-immediate', 'site-open', 'site-open-different-url']) {
    const pathname = `/headers-${handler}`;
    const linkPathname = handler === 'site-open-different-url' ? '/unused-site-link-target' : pathname;
    const source = await context.newPage();
    await source.goto(`${base}/source-${handler}`);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.url === source.url() && node.currentKey), `${handler} source observed`);
    await source.locator('#child').evaluate((link, {handler, actualURL}) => {
      const card = document.createElement('div');
      link.replaceWith(card);
      card.append(link);
      const target = handler === 'stop-propagation' ? card : link;
      target.addEventListener('click', event => {
        window.__loadingSiteHandled = true;
        if (handler === 'stop-propagation') event.stopPropagation();
        if (handler === 'stop-immediate') event.stopImmediatePropagation();
        if (handler.startsWith('site-open')) {
          event.preventDefault();
          event.stopPropagation();
          window.open(handler === 'site-open-different-url' ? actualURL : link.href, '_blank', 'noopener');
        }
      });
    }, {handler, actualURL: `${childBase}${pathname}`});
    const {child, tab} = await openChild(source, pathname, 'cmd-click', linkPathname);
    if (handler !== 'stop-propagation') {
      // Native/script fallback first opens the browser's uncommitted blank
      // document, then replaces it with the keyboard reader. The second HTTP
      // request proves the reader started its navigation; neither response is
      // released, so this still tests Back before the first website response.
      await until(() => (requests.get(pathname) || 0) >= 2,
        `${handler} protected target request started`);
    }
    assert.equal(await source.evaluate(() => window.__loadingSiteHandled), true,
      `${handler} site handler received the trusted click`);
    assert.equal((await worker.evaluate(id => chrome.tabs.get(id), tab.id)).status, 'loading');
    assert.ok(pending.has(pathname), `${handler} response remains blocked`);
    if (handler === 'site-open-different-url') assert.equal(requests.get(linkPathname) || 0, 0,
      'only the URL selected by the site is requested');
    const firstRequestCount = requests.get(pathname);
    const started = Date.now();
    await child.key();
    await until(() => child.isClosed(), `${handler} child closes before first response`, 1500);
    const backMs = Date.now() - started;
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === `${childBase}${pathname}` && !node.closed.pending), `${handler} close recorded`);
    const sourceTab = (await tabs()).find(tab => tab.url === source.url());
    assert.equal(sourceTab.active, true, `${handler} Back activates its source`);
    const restored = await restoreChild(source, pathname);
    await restored.child.key();
    await until(() => restored.child.isClosed(), `${handler} restored child closes while response is still blocked`, 1500);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === `${childBase}${pathname}` && !node.closed.pending), `${handler} restored close recorded`);
    assert.ok(pending.has(pathname), `${handler} restoration did not depend on server response`);
    console.log(`OBSERVE ${handler} target requests: ${firstRequestCount} opening; ${requests.get(pathname)} including restoration`);
    release(pathname);
    await source.close();
    passed(`${handler} Cmd-click child closes before first response and restores the correct target (${backMs} ms Back)`);
  }
  {
    const pathname = '/headers-site-open-fragment';
    const destination = `${pathname}#booking-details`;
    const url = `${childBase}${destination}`;
    const source = await context.newPage();
    await source.goto(`${base}/source-site-open-fragment`);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.url === source.url() && node.currentKey), 'fragment source observed');
    await source.locator('#child').evaluate((link, url) => {
      link.href = url;
      link.target = '_self';
      link.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        window.open(link.href, '_blank', 'noopener');
      });
    }, url);
    const {child, tab} = await attachNewChild(pathname, () =>
      source.locator('#child').click({modifiers: ['Meta'], noWaitAfter: true}), destination);
    await until(() => (requests.get(pathname) || 0) >= 2, 'fragment protected target request started');
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.tabId === tab.id && node.loadingURL === url), 'fragment target protected before first response');
    assert.ok(pending.has(pathname), 'fragment target response remains blocked');
    assert.ok(requestMethods.get(pathname).every(method => method === 'GET'), 'fragment target remains a GET');
    await child.key();
    await until(() => child.isClosed(), 'script-opened fragment child closes before first response', 1500);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === url && !node.closed.pending), 'closed target retains fragment');
    const sourceTab = (await tabs()).find(tab => tab.url === source.url());
    await focus(source, sourceTab.id);
    const restored = await attachNewChild(pathname, () =>
      source.keyboard.press('Meta+BracketRight'), destination);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.tabId === restored.tab.id && node.loadingURL === url), 'restored target retains fragment while pending');
    release(pathname);
    await until(async () => {
      const current = await worker.evaluate(id => chrome.tabs.get(id), restored.tab.id);
      return current.status === 'complete' && current.url === url;
    }, 'restored page commits with its original fragment');
    await restored.child.key();
    await until(() => restored.child.isClosed(), 'fragment introduces no placeholder history entry', 1500);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === url && !node.closed.pending), 'loaded fragment close recorded');
    await source.close();
    passed('script-opened GET with a fragment closes before first response and restores the complete URL');
  }
  {
    const pathname = '/headers-posted';
    const source = await context.newPage();
    await source.goto(`${base}/source-posted`);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.url === source.url() && node.currentKey), 'POST source observed');
    await source.locator('#child').evaluate(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const form = document.createElement('form');
        form.method = 'post';
        form.action = link.href;
        form.target = '_blank';
        const input = document.createElement('input');
        input.name = 'booking-fixture';
        input.value = 'preserve-post';
        form.append(input);
        document.body.append(form);
        form.submit();
      });
    });
    const {child, tab} = await openChild(source, pathname, 'cmd-click');
    await new Promise(resolve => setTimeout(resolve, 350));
    const current = await worker.evaluate(id => chrome.tabs.get(id), tab.id);
    const node = Object.values((await read()).nodes).find(node => node.tabId === tab.id);
    assert.equal(current.url, '', 'POST remains a native initial document');
    assert.equal(current.pendingUrl, `${childBase}${pathname}`);
    assert.equal(node.loadingURL, undefined, 'POST is never wrapped in a GET loading document');
    assert.deepEqual(requestMethods.get(pathname), ['POST'], 'only the original POST request is issued');
    assert.ok(pending.has(pathname), 'POST response remains blocked');
    release(pathname);
    await until(async () => (await worker.evaluate(id => chrome.tabs.get(id), tab.id)).status === 'complete', 'POST response commits');
    assert.deepEqual(requestMethods.get(pathname), ['POST'], 'completion does not introduce a GET request');
    await child.close();
    await source.close();
    passed('site-cancelled Cmd-click submitting a POST form stays native and does not replay as GET');
  }
  {
    const pathname = '/headers-consumed-intent';
    const {child} = await openChild(parent, pathname, 'cmd-click');
    await child.key();
    await until(() => child.isClosed(), 'custom Cmd-click closes before unrelated native opening', 1500);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === `${childBase}${pathname}` && !node.closed.pending), 'custom close recorded before native opening');
    // The same URL intentionally reappears immediately. A completed custom
    // open must consume its click intent rather than wrapping this later call.
    const native = await attachNewChild(pathname, () => parent.evaluate(url =>
      window.open(url, '_blank', 'noopener'), `${childBase}${pathname}`));
    await new Promise(resolve => setTimeout(resolve, 250));
    const current = await worker.evaluate(id => chrome.tabs.get(id), native.tab.id);
    const node = Object.values((await read()).nodes).find(node => node.tabId === native.tab.id);
    assert.equal(current.url, '', 'later unrelated window.open remains a native initial document');
    assert.equal(current.pendingUrl, `${childBase}${pathname}`);
    assert.equal(node.loadingURL, undefined, 'consumed click intent cannot wrap a later script opening');
    assert.equal(requests.get(pathname), 2, 'one request per custom and later native opening');
    release(pathname);
    await native.child.close();
    passed('successful custom Cmd-click consumes its intent before a later native window.open of the same URL');
  }
  {
    const pathname = '/headers-cold-worker-site-open';
    const source = await context.newPage();
    await source.goto(`${base}/source-cold-worker-site-open`);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.url === source.url() && node.currentKey), 'cold worker source observed');
    await source.locator('#child').evaluate((link, url) => {
      link.href = url;
      link.target = '_self';
      link.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        window.open(link.href, '_blank', 'noopener');
      });
    }, `${childBase}${pathname}`);
    await worker.evaluate(() => {globalThis.__loadingColdOpenMarker = 'previous scope';});
    const cdp = await context.browser().newBrowserCDPSession();
    const target = (await cdp.send('Target.getTargets')).targetInfos.find(target =>
      target.type === 'service_worker' && target.url === worker.url());
    assert.ok(target, 'worker target exists before cold script opening');
    assert.equal((await cdp.send('Target.closeTarget', {targetId: target.targetId})).success, true);
    await cdp.detach();
    const {child, tab} = await attachNewChild(pathname, async () => {
      await source.locator('#child').click({modifiers: ['Meta'], noWaitAfter: true});
      worker = await until(() => context.serviceWorkers().find(item =>
        item.url().includes(extensionId)), 'worker available after script opening');
    });
    assert.equal(await worker.evaluate(() => globalThis.__loadingColdOpenMarker), undefined,
      'script opening restarted a fresh worker execution scope');
    const sourceNode = Object.values((await read()).nodes).find(node => node.tabId === tab.id);
    assert.equal(sourceNode.loadingURL, `${childBase}${pathname}`);
    assert.ok(pending.has(pathname));
    await until(() => (requests.get(pathname) || 0) >= 2, 'cold worker protected target request started');
    const beforeBackRequests = requests.get(pathname);
    const beforeBack = await worker.evaluate(id => chrome.tabs.get(id), tab.id);
    const beforeBackFrames = await worker.evaluate(tabId =>
      chrome.webNavigation.getAllFrames({tabId}), tab.id);
    await child.key();
    try {
      await until(() => child.isClosed(), 'script-opened child closes after cold worker startup', 1500);
    } catch (error) {
      console.log('DIAGNOSE cold-worker-site-open', JSON.stringify({beforeBack, beforeBackRequests, beforeBackFrames,
        afterBack: await worker.evaluate(id => chrome.tabs.get(id).catch(() => null), tab.id),
        node: (await read()).nodes[sourceNode.id], requests: requests.get(pathname)}));
      throw error;
    }
    const closed = await until(async () => (await read()).nodes[sourceNode.id]?.closed, 'cold script open close recorded');
    assert.equal(closed.url, `${childBase}${pathname}`);
    assert.equal(closed.parentId, sourceNode.parentId);
    console.log(`OBSERVE cold-worker-site-open target requests: ${requests.get(pathname)}`);
    release(pathname);
    await source.close();
    passed('site script opening after a cold worker startup supports Back before first response');
  }
  {
    const pathname = '/redirect-initial';
    const destination = '/headers-redirect-target';
    await parent.locator('#child').evaluate((link, url) => {
      link.href = url;
      link.target = '_self';
    }, `${childBase}${pathname}`);
    const {child, tab} = await attachNewChild(pathname, () =>
      parent.locator('#child').click({modifiers: ['Meta'], noWaitAfter: true}), destination);
    await until(() => pending.has(destination), 'redirect final response held');
    assert.equal((await worker.evaluate(id => chrome.tabs.get(id), tab.id)).status, 'loading');
    await child.key();
    await until(() => child.isClosed(), 'redirected child closes before final response', 1500);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === `${childBase}${pathname}` && !node.closed.pending), 'redirect original target saved');
    const parentTab = (await tabs()).find(tab => tab.url === parent.url());
    await focus(parent, parentTab.id);
    const restored = await attachNewChild(pathname, () =>
      parent.keyboard.press('Meta+BracketRight'), destination);
    assert.equal(requests.get(pathname), 2, 'restoration starts at original redirect URL');
    release(destination);
    await until(async () => {
      const current = await worker.evaluate(id => chrome.tabs.get(id), restored.tab.id);
      return current.status === 'complete' && current.url === `${childBase}${destination}`;
    }, 'restored redirect target finishes at correct destination');
    await restored.child.key();
    await until(() => restored.child.isClosed(), 'redirect introduces no placeholder Back step', 1500);
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === `${childBase}${destination}` && !node.closed.pending), 'loaded redirect close recorded');
    passed('redirected Cmd-click closes before final response and restores without an extra history entry');
  }
  {
    const pathname = '/headers-cancelled';
    await parent.locator('#child').evaluate((link, url) => {
      link.href = url;
      link.target = '_self';
      link.onclick = event => event.preventDefault();
    }, `${childBase}${pathname}`);
    const before = (await tabs()).map(tab => tab.id).sort();
    await parent.locator('#child').click({modifiers: ['Meta'], noWaitAfter: true});
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual((await tabs()).map(tab => tab.id).sort(), before, 'site cancellation prevents new tab');
    assert.equal(requests.get(pathname) || 0, 0, 'site cancellation prevents target request');
    await parent.locator('#child').evaluate(link => {link.onclick = null;});
    passed('site-cancelled Cmd-click does not create a tab or request target');
  }
  {
    const pathname = '/headers-cancelled-stopped';
    await parent.locator('#child').evaluate((link, url) => {
      link.href = url;
      link.target = '_self';
      link.onclick = event => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
    }, `${childBase}${pathname}`);
    const before = (await tabs()).map(tab => tab.id).sort();
    await parent.locator('#child').click({modifiers: ['Meta'], noWaitAfter: true});
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual((await tabs()).map(tab => tab.id).sort(), before, 'stopped site cancellation prevents new tab');
    assert.equal(requests.get(pathname) || 0, 0, 'stopped site cancellation prevents target request');
    await parent.locator('#child').evaluate(link => {link.onclick = null;});
    passed('site-cancelled and propagation-stopped Cmd-click does not create a tab or request target');
  }
  {
    const {child, tab} = await openChild(parent, '/blocked-script');
    await until(() => requests.has('/resource-script'), 'blocking subresource pending');
    assert.equal((await worker.evaluate(id => chrome.tabs.get(id), tab.id)).status, 'loading');
    await child.key();
    await until(() => child.isClosed(), 'child closes while parser is waiting for script', 1500);
    assert.ok(pending.has('/resource-script'), 'subresource never completed before close');
    release('/resource-script');
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === `${childBase}/blocked-script` && !node.closed.pending), 'blocked child close recorded');
    passed('committed child closes while a synchronous script blocks loading');
  }
  {
    const {child, tab} = await openChild(parent, '/slow-image');
    await until(() => requests.has('/resource-image'), 'image subresource pending');
    assert.equal((await worker.evaluate(id => chrome.tabs.get(id), tab.id)).status, 'loading');
    await child.key();
    await until(() => child.isClosed(), 'child closes with unfinished image', 1500);
    assert.ok(pending.has('/resource-image'), 'image never completed before close');
    release('/resource-image');
    await until(async () => Object.values((await read()).nodes).some(node =>
      node.closed?.url === `${childBase}/slow-image` && !node.closed.pending), 'image child close recorded');
    passed('committed child closes while an image remains loading');
  }
  {
    await parent.goto(`${base}/parent-1`);
    await parent.locator('#next').evaluate((link, url) => {link.href = url;}, `${base}/headers-next`);
    await parent.locator('#next').click({noWaitAfter: true});
    await until(() => requests.has('/headers-next'), 'same-tab request pending');
    const tab = (await tabs()).find(tab => tab.url === `${base}/parent-1`);
    assert.equal(tab.status, 'loading');
    await parent.keyboard.press('Meta+BracketLeft');
    await until(() => parent.url() === `${base}/parent`, 'same-tab Back cancels outstanding navigation', 1500);
    assert.equal(parent.isClosed(), false);
    assert.ok(pending.has('/headers-next'), 'pending response did not complete before Back');
    release('/headers-next');
    passed('normal same-tab Back cancels pending navigation and traverses existing history');
  }
  {
    // Keep the source and destination on the same site. A local extension
    // bridge must not silently remove an authenticated Strict cookie.
    await context.addCookies([{name: 'loading-fixture-strict', value: 'known-value',
      url: childBase, sameSite: 'Strict'}]);
    const cookieSource = await context.newPage();
    await cookieSource.goto(`${childBase}/cookie-source`);
    const direct = await openChild(cookieSource, '/cookie-direct');
    const nativeHeaders = requestHeaders.get('/cookie-direct');
    assert.ok(nativeHeaders.cookie.includes('loading-fixture-strict=known-value'), 'native same-site opening sends Strict cookie');
    await direct.child.close();
    const bridge = await openChild(cookieSource, '/headers-cookie-bridge', 'cmd-click');
    const bridgeHeaders = requestHeaders.get('/headers-cookie-bridge');
    assert.equal(bridgeHeaders.cookie, nativeHeaders.cookie, 'bridge preserves same-site Strict cookie');
    passed('same-site Strict cookie preserved by bridge');
    console.log(`OBSERVE native Referer=${nativeHeaders.referer}; bridge Referer=${bridgeHeaders.referer || '(none)'}`);
    release('/headers-cookie-bridge');
    const bridgePage = await until(() => context.pages().find(page => page.url() === `${childBase}/headers-cookie-bridge`), 'bridge target commits');
    assert.equal(await bridgePage.evaluate(() => window.opener), null, 'bridge target has no opener access');
    await bridge.child.close();
  }
  {
    const source = await context.newPage();
    await source.goto(`${base}/closing-source`);
    const sourceTab = (await tabs()).find(tab => tab.url === source.url());
    const {child, tab} = await openChild(source, '/headers-missing-parent', 'cmd-click');
    await source.close();
    await until(async () => !Object.values((await read()).nodes).some(node => node.tabId === sourceTab.id), 'manually closed parent removed');
    await child.key();
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await child.isClosed(), false, 'pending child stays open after source was manually closed');
    assert.ok((await tabs()).some(item => item.id === tab.id));
    release('/headers-missing-parent');
    await child.close();
    passed('pending child is not automatically closed when its source is gone');
  }
  {
    await parent.evaluate(url => {
      const frame = document.createElement('iframe');
      frame.id = 'blocked-reply-fixture';
      frame.src = url;
      document.body.append(frame);
    }, `${base}/source-frame`);
    const parentTab = (await tabs()).find(tab => tab.url === parent.url());
    await until(async () => (await worker.evaluate(tabId => chrome.webNavigation.getAllFrames({tabId}), parentTab.id))
      .some(frame => frame.frameId !== 0 && frame.url === `${base}/source-frame`), 'source iframe is registered');
    const {child} = await openChild(parent, '/headers-unresponsive-frame', 'cmd-click');
    await worker.evaluate(() => {
      globalThis.__loadingTestSendMessage = chrome.tabs.sendMessage;
      globalThis.__loadingTestBlockedCalls = 0;
      chrome.tabs.sendMessage = (...args) => {
        if (args[1]?.type === 'get-snapshot' && args[2]?.frameId !== 0) {
          globalThis.__loadingTestBlockedCalls++;
          return new Promise(() => {});
        }
        return globalThis.__loadingTestSendMessage(...args);
      };
    });
    try {
      const started = Date.now();
      await child.key();
      await until(() => child.isClosed(), 'early Back is not frozen by unresponsive source frame', 1500);
      assert.ok(await worker.evaluate(() => globalThis.__loadingTestBlockedCalls > 0), 'test blocked a real frame snapshot request');
      assert.equal((await tabs()).find(tab => tab.id === parentTab.id).active, true);
      passed(`unresponsive source frame cannot freeze early Back (${Date.now() - started} ms)`);
    } finally {
      await worker.evaluate(() => {
        chrome.tabs.sendMessage = globalThis.__loadingTestSendMessage;
        delete globalThis.__loadingTestSendMessage;
        delete globalThis.__loadingTestBlockedCalls;
      });
      release('/headers-unresponsive-frame');
      await parent.locator('#blocked-reply-fixture').evaluate(frame => frame.remove());
    }
  }
  {
    const pathname = '/headers-worker-restart';
    const {child, tab} = await openChild(parent, pathname, 'cmd-click');
    const node = Object.values((await read()).nodes).find(node => node.tabId === tab.id);
    assert.equal(node.loadingURL, `${childBase}${pathname}`);
    assert.equal(node.currentKey, null, 'pending bridge has no committed website entry');
    const previousWorker = worker;
    // Chrome can retain Playwright's Worker object when its execution scope
    // restarts. A volatile marker proves the scope was actually discarded.
    await worker.evaluate(() => {globalThis.__loadingTestWorkerMarker = 'old worker';});
    const cdp = await context.browser().newBrowserCDPSession();
    const target = (await cdp.send('Target.getTargets')).targetInfos.find(target =>
      target.type === 'service_worker' && target.url === previousWorker.url());
    assert.ok(target, 'worker debugging target exists');
    assert.equal((await cdp.send('Target.closeTarget', {targetId: target.targetId})).success, true);
    await cdp.detach();
    const started = Date.now();
    await child.key();
    worker = await until(() => context.serviceWorkers().find(item =>
      item.url().includes(extensionId)), 'worker available after pending child key');
    assert.equal(await worker.evaluate(() => globalThis.__loadingTestWorkerMarker), undefined, 'new worker execution scope is fresh');
    await until(() => child.isClosed(), 'pending child closes after worker restart', 1500);
    const recovered = await until(async () => (await read()).nodes[node.id]?.closed, 'restart preserves child close record');
    assert.equal(recovered.url, `${childBase}${pathname}`);
    assert.equal(recovered.parentId, node.parentId);
    assert.equal(recovered.uncommitted, true);
    assert.equal(recovered.sessionId, null);
    assert.equal((await tabs()).find(item => item.url === parent.url()).active, true);
    release(pathname);
    passed(`worker restart preserves pending bridge links and URL (${Date.now() - started} ms Back)`);
  }
  {
    const off = await toggleExtension();
    assert.equal(off.enabled, false);
    // The source page was loaded while enabled. Allow the asynchronous settings
    // broadcast to arrive, then verify its live listener follows the OFF state.
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      const pathname = '/headers-extension-off';
      const {child, tab} = await openChild(parent, pathname, 'cmd-click');
      const current = await worker.evaluate(id => chrome.tabs.get(id), tab.id);
      const node = Object.values((await read()).nodes).find(node => node.tabId === tab.id);
      assert.equal(current.url, '', 'OFF uses native initial empty tab, not extension bridge');
      assert.equal(current.pendingUrl, `${childBase}${pathname}`);
      assert.equal(node.loadingURL, undefined);
      assert.equal(requests.get(pathname), 1, 'OFF native Cmd-click requests target once');
      await child.close();
      release(pathname);
    } finally {
      assert.equal((await toggleExtension()).enabled, true);
    }
    passed('OFF broadcast makes existing source Cmd-click open a native pending tab');
  }
} finally {
  for (const pathname of pending.keys()) release(pathname);
  await context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
