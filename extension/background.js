import {LinkedHistory, matchClosedSession} from './history.js';

const STORE = 'linkedHistory';
let model;
let tail = Promise.resolve();
const epochs = new Map();
const expectedActivations = new Set();
const restoredTabs = new Set();
const restoringWindows = new Map();
const normalWindows = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const ready = initialize();

function enqueue(work) {
  const job = tail.then(() => ready).then(work);
  tail = job.catch(error => console.warn('Linked History:', error.message));
  return job;
}

async function save() {
  model.prune();
  await chrome.storage.session.set({[STORE]: model.state});
}

async function normalTab(tab) {
  if (!tab || tab.incognito) return false;
  if (!normalWindows.has(tab.windowId)) {
    const window = await chrome.windows.get(tab.windowId).catch(() => null);
    normalWindows.set(tab.windowId, window?.type === 'normal');
  }
  return normalWindows.get(tab.windowId);
}

async function initialize() {
  const stored = await chrome.storage.session.get(STORE);
  model = new LinkedHistory(stored[STORE]);
  const tabs = await chrome.tabs.query({});
  const live = new Map(tabs.map(tab => [tab.id, tab]));
  for (const node of Object.values(model.state.nodes)) {
    if (node.closed?.pending) {
      if (live.has(node.tabId)) model.cancelClose(node);
      else {
        const sessions = await chrome.sessions.getRecentlyClosed();
        model.finishClose(node, matchClosedSession(node.closed.beforeIds, sessions, node.closed));
      }
    } else if (node.tabId != null && !live.has(node.tabId)) model.removeManually(node);
  }
  for (const tab of tabs) if (await normalTab(tab)) model.ensure(tab);
  await chrome.action.setBadgeText({text: model.state.notice ? '!' : model.state.enabled ? '' : 'OFF'});
  await save();
}

async function getSnapshot(tabId) {
  const value = await chrome.tabs.sendMessage(tabId, {type: 'get-snapshot'}, {frameId: 0}).catch(() => null);
  if (!value) return null;
  const frames = await chrome.webNavigation.getAllFrames({tabId}).catch(() => []) || [];
  value.frames = (await Promise.all(frames.filter(frame => frame.frameId !== 0).map(async frame => {
    const state = await chrome.tabs.sendMessage(tabId, {type: 'get-snapshot'},
      {frameId: frame.frameId}).catch(() => null);
    return state?.key ? {...state, frameId: frame.frameId} : null;
  }))).filter(Boolean);
  return value;
}

function entrySignature(value) {
  return `${value.key || ''}|${(value.frames || []).map(frame => frame.key).sort().join('|')}`;
}

function observe(node, value) {
  if (!value || !node) return;
  if (node.restoring) {
    model.remapRestoredEntries(node, value);
    node.restoring = false;
  }
  const type = value.navigationType ||
    (node.pendingNavigation?.key !== value.key ? node.pendingNavigation?.type : null);
  model.observe(node, {...value, navigationType: type || null});
  node.pendingNavigation = null;
}

async function activate(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    expectedActivations.add(tabId);
    try { await chrome.tabs.update(tabId, {active: true}); }
    catch (error) { expectedActivations.delete(tabId); throw error; }
  }
}

async function waitForEntry(tabId, previousSignature) {
  // tabs.goBack resolves when navigation starts, rather than when it commits.
  for (let attempt = 0; attempt < 45; attempt++) {
    const value = await getSnapshot(tabId);
    if (value?.key && entrySignature(value) !== previousSignature) return value;
    await delay(50);
  }
  return null;
}

async function notice(tabId, text) {
  model.state.notice = text;
  await chrome.action.setBadgeText({text: '!'});
  await chrome.action.setBadgeBackgroundColor({color: '#b45309'});
  if (tabId != null) await chrome.tabs.sendMessage(tabId, {type: 'notice', text}, {frameId: 0}).catch(() => {});
}

async function identifySession(record) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const sessions = await chrome.sessions.getRecentlyClosed();
    const sessionId = matchClosedSession(record.beforeIds, sessions, record);
    if (sessionId) return sessionId;
    await delay(75);
  }
  return null;
}

async function closeToParent(node, parent, tab) {
  const parentTab = await chrome.tabs.get(parent.tabId).catch(() => null);
  if (!parentTab || parentTab.windowId !== tab.windowId) return;
  observe(parent, await getSnapshot(parent.tabId));
  // A protected source page cannot provide a stable restoration anchor.
  if (!parent.currentKey || !/^https?:/.test(parentTab.url || '')) return;
  const sessions = await chrome.sessions.getRecentlyClosed();
  const record = {
    url: tab.url, title: tab.title, index: tab.index, pinned: tab.pinned,
    beforeIds: sessions.flatMap(item => item.tab ? [item.tab.sessionId] : []),
  };
  model.beginClose(node, parent, record);
  // Write the intent before closing, so worker suspension cannot lose the tab.
  await save();
  try {
    await activate(parent.tabId);
    await chrome.tabs.remove(tab.id);
    const stillOpen = await chrome.tabs.get(tab.id).catch(() => null);
    if (stillOpen) {
      model.cancelClose(node);
      await activate(tab.id);
      return;
    }
    model.finishClose(node, await identifySession(record));
  } catch (error) {
    const stillOpen = await chrome.tabs.get(tab.id).catch(() => null);
    if (stillOpen) {
      model.cancelClose(node);
      await activate(tab.id);
    } else {
      model.finishClose(node, await identifySession(record));
    }
    throw error;
  } finally {
    await save();
  }
}

async function placeNextTo(tabId, sourceId) {
  const source = await chrome.tabs.get(sourceId);
  let tab = await chrome.tabs.get(tabId);
  // A child opened by a link is unpinned. Chrome requires all pinned tabs first.
  if (tab.pinned) tab = await chrome.tabs.update(tabId, {pinned: false});
  const tabs = await chrome.tabs.query({windowId: source.windowId});
  const pinnedCount = tabs.filter(item => item.pinned).length;
  // Moving from the left shifts the source one position left.
  const index = Math.max(pinnedCount, source.index +
    (tab.windowId === source.windowId && tab.index < source.index ? 0 : 1));
  if (tab.windowId !== source.windowId || tab.index !== index) {
    await chrome.tabs.move(tabId, {windowId: source.windowId, index});
  }
  await chrome.tabs.update(tabId, {openerTabId: sourceId});
  await activate(tabId);
}

async function restoreChild(parent, edge) {
  const child = model.state.nodes[edge.childId];
  const record = child.closed;
  let tab = null;
  let fallback = false;
  if (record.sessionId) {
    restoringWindows.set(parent.windowId, null);
    try {
      // An exact ID may still be restorable even outside the 25-item query view.
      const session = await chrome.sessions.restore(record.sessionId).catch(() => null);
      tab = session?.tab || null;
      if (tab?.active && restoringWindows.get(parent.windowId) !== tab.id) {
        expectedActivations.add(tab.id);
      }
    } finally {
      restoringWindows.delete(parent.windowId);
    }
  }
  if (!tab) {
    fallback = true;
    const source = await chrome.tabs.get(parent.tabId);
    tab = await chrome.tabs.create({windowId: source.windowId, url: record.url,
      index: source.index + 1, openerTabId: source.id, active: false});
  }
  model.bindRestored(child, tab, fallback);
  child.restoring = !fallback;
  restoredTabs.add(tab.id);
  await save();
  await placeNextTo(tab.id, parent.tabId);
  let value = await getSnapshot(tab.id);
  for (let attempt = 0; !value && attempt < 30; attempt++) {
    await delay(50);
    value = await getSnapshot(tab.id);
  }
  observe(child, value);
  if (fallback) await notice(tab.id,
    'Страница открыта по прежнему адресу. Chrome уже не хранит её внутреннюю историю.');
  await save();
}

async function navigate(windowId, epoch, direction, sourceId) {
  const [tab] = await chrome.tabs.query({active: true, windowId});
  // Activation notifications and content messages can arrive out of order.
  // A key from the still-active source is valid even after its activation event.
  if (epoch !== (epochs.get(windowId) || 0) && tab?.id !== sourceId) return;
  if (!await normalTab(tab) || !/^https?:/.test(tab.url || '')) return;
  const node = model.ensure(tab);
  observe(node, await getSnapshot(tab.id));
  if (!model.state.enabled) {
    await nativeNavigate(tab.id, direction, node);
  } else if (direction === 'back') {
    // A frame can add joint history entries without changing the top-level key.
    // Let Chrome traverse those entries before crossing the tab boundary.
    const moved = await nativeNavigate(tab.id, direction, node);
    if (!moved) {
      // Chrome may evict the oldest native entries from a long-lived tab.
      // Its actual boundary is authoritative even if the original root is gone.
      if (node.parentId && node.currentKey) node.rootKey = node.currentKey;
      const parent = model.parentForBack(node);
      if (parent) await closeToParent(node, parent, tab);
    }
  } else {
    const edge = model.forwardAt(node);
    if (edge) await restoreChild(node, edge);
    else await nativeNavigate(tab.id, direction, node);
  }
  await save();
}

async function nativeNavigate(tabId, direction, node) {
  const previous = entrySignature({key: node.currentKey, frames: node.frames});
  try {
    if (direction === 'back') await chrome.tabs.goBack(tabId);
    else await chrome.tabs.goForward(tabId);
  } catch (error) {
    // The API reports this boundary for both directions. Other failures matter.
    if (error.message === 'Cannot find a next page in history.') return false;
    throw error;
  }
  observe(node, await waitForEntry(tabId, previous));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'status' && !sender.tab) {
    enqueue(() => ({enabled: model.state.enabled, notice: model.state.notice})).then(respond);
    return true;
  }
  if (message.type === 'toggle' && !sender.tab) {
    enqueue(async () => {
      model.state.enabled = !model.state.enabled;
      model.state.notice = null;
      await chrome.action.setBadgeText({text: model.state.enabled ? '' : 'OFF'});
      await save();
      return {enabled: model.state.enabled, notice: null};
    }).then(respond);
    return true;
  }
  if (!sender.tab || sender.tab.incognito) return;
  const sourceId = sender.tab.id;
  const windowId = sender.tab.windowId;
  if (message.type === 'navigate' && ['back', 'forward'].includes(message.direction)) {
    const epoch = epochs.get(windowId) || 0;
    enqueue(() => navigate(windowId, epoch, message.direction, sourceId))
      .then(() => respond({ok: true}))
      .catch(async error => {
        await notice(sourceId, 'Не удалось выполнить переход. Попробуйте ещё раз.');
        await save();
        console.warn('Linked History command:', error.message);
        respond({ok: false});
      });
    return true;
  }
  if (sender.frameId !== 0) return;
  if (message.type === 'snapshot') {
    enqueue(async () => {
      const tab = await chrome.tabs.get(sourceId).catch(() => null);
      if (!await normalTab(tab)) return;
      const node = model.ensure(tab);
      observe(node, message.snapshot);
      await save();
    });
  }
  if (message.type === 'navigation-start') {
    enqueue(() => {
      const node = model.byTab(sourceId);
      if (node && node.currentKey === message.key) {
        node.pendingNavigation = {type: message.navigationType, key: message.key};
      }
    });
  }
});

chrome.tabs.onCreated.addListener(tab => {
  enqueue(async () => {
    if (!await normalTab(tab)) return;
    // openerTabId also appears on unrelated tabs created by browser automation
    // and browser UI. Only onCreatedNavigationTarget proves a link transition.
    model.ensure(tab, true);
    await save();
  });
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(details => {
  enqueue(async () => {
    const tab = await chrome.tabs.get(details.tabId).catch(() => null);
    const parentTab = await chrome.tabs.get(details.sourceTabId).catch(() => null);
    if (!parentTab || !await normalTab(tab)) return;
    model.link(model.ensure(tab, true), model.ensure(parentTab));
    await save();
  });
});

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  enqueue(() => {
    const node = model.byTab(details.tabId);
    if (!node) return;
    if (restoredTabs.delete(details.tabId)) return;
    if (!node.pendingNavigation && node.currentKey && details.transitionType !== 'reload') {
      node.pendingNavigation = {key: node.currentKey,
        type: details.transitionQualifiers.includes('forward_back') ? 'traverse' : 'push'};
    }
  });
});

chrome.tabs.onActivated.addListener(({tabId, windowId}) => {
  if (restoringWindows.has(windowId) && !model?.byTab(tabId)) {
    restoringWindows.set(windowId, tabId);
    return;
  }
  if (!expectedActivations.delete(tabId)) epochs.set(windowId, (epochs.get(windowId) || 0) + 1);
});

chrome.tabs.onRemoved.addListener(tabId => {
  enqueue(async () => {
    const node = model.byTab(tabId);
    if (node && !node.closed?.pending) model.removeManually(node);
    await save();
  });
});

chrome.tabs.onDetached.addListener(tabId => {
  enqueue(async () => {
    model.detach(model.byTab(tabId));
    await save();
  });
});

chrome.tabs.onAttached.addListener((tabId, info) => {
  enqueue(async () => {
    const node = model.byTab(tabId);
    if (node) node.windowId = info.newWindowId;
    await save();
  });
});

chrome.windows.onRemoved.addListener(windowId => {
  normalWindows.delete(windowId);
  epochs.delete(windowId);
});

chrome.runtime.onInstalled.addListener(() => {
  enqueue(async () => {
    // Give existing source tabs a reader without assigning them a false history root.
    for (const tab of await chrome.tabs.query({})) {
      if (/^https?:/.test(tab.url || '') && await normalTab(tab)) {
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true},
          files: ['content.js']}).catch(() => {});
      }
    }
  });
});
