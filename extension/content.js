(() => {
  if (globalThis.__linkedHistoryInstalled) return;
  globalThis.__linkedHistoryInstalled = true;
  const topFrame = window === window.top;
  let enabled = false;
  const clickIntents = new WeakMap();
  let intentSequence = 0;

  function snapshot(navigationType = null) {
    if (topFrame && !/^https?:$/.test(location.protocol)) return null;
    const entry = window.navigation?.currentEntry;
    if (!entry?.key) return null;
    return {
      key: entry.key, url: location.href,
      capturedAt: performance.timeOrigin + performance.now(), navigationType,
      entries: window.navigation.entries().map(item => ({key: item.key, url: item.url})),
    };
  }

  function report(navigationType = null) {
    if (!topFrame) return;
    const value = snapshot(navigationType);
    if (value) chrome.runtime.sendMessage({type: 'snapshot', snapshot: value}).catch(() => {});
  }

  if (topFrame) {
    window.navigation?.addEventListener('currententrychange', event => report(event.navigationType));
    // Cross-document push/replace events are visible before leaving the old page.
    window.navigation?.addEventListener('navigate', event => {
      if (!event.destination.sameDocument) {
        chrome.runtime.sendMessage({type: 'navigation-start', navigationType: event.navigationType,
          key: window.navigation.currentEntry?.key}).catch(() => {});
      }
    });
    window.addEventListener('pageshow', () => report());
    report();
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'get-snapshot') respond(snapshot());
    if (message.type === 'notice' && topFrame) showNotice(message.text);
    if (message.type === 'settings' && typeof message.enabled === 'boolean') enabled = message.enabled;
  });
  chrome.runtime.sendMessage({type: 'settings'}).then(settings => {
    enabled = settings?.enabled === true;
  }).catch(() => {});

  window.addEventListener('keydown', event => {
    if (!event.isTrusted || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const direction = event.code === 'BracketLeft' ? 'back' :
      event.code === 'BracketRight' ? 'forward' : null;
    if (!direction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const fallback = () => history.go(direction === 'back' ? -1 : 1);
    try {
      chrome.runtime.sendMessage({type: 'navigate', direction,
        snapshot: topFrame ? snapshot() : null}).catch(fallback);
    } catch {
      // An old content script can outlive an extension reload. Keep native keys usable.
      fallback();
    }
  }, true);

  function clickedLink(event) {
    if (!enabled || !event.isTrusted || event.defaultPrevented || event.altKey || event.ctrlKey) return;
    const commandClick = event.type === 'click' && event.button === 0 && event.metaKey;
    const middleClick = event.type === 'auxclick' && event.button === 1;
    if (!commandClick && !middleClick) return;
    const link = event.composedPath().find(element =>
      element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement);
    if (!link || link.hasAttribute('download') || !/^https?:/.test(link.href)) return;
    try {
      if (!chrome.runtime.id) return;
    } catch { return; }
    return link;
  }

  // Remember the physical click before site handlers run. A site can stop
  // propagation or open its own tab; the worker then protects that actual tab.
  // This message alone never opens anything, so cancelled clicks stay cancelled.
  function captureLinkedClick(event) {
    const link = clickedLink(event);
    if (!link) return;
    const intentId = `${performance.timeOrigin}:${++intentSequence}`;
    clickIntents.set(event, intentId);
    try {
      chrome.runtime.sendMessage({type: 'link-intent', intentId, url: link.href}).catch(() => {});
    } catch { return; }

    // Observe the propagation boundary after the site's handlers at that target.
    // For stopImmediatePropagation / script-opened tabs the worker is the fallback.
    const targets = event.composedPath().filter(target => target !== window &&
      typeof target.addEventListener === 'function');
    const stopped = next => {
      if (next === event && next.cancelBubble) openLinkedTab(next);
    };
    for (const target of targets) target.addEventListener(event.type, stopped);
    setTimeout(() => {
      for (const target of targets) target.removeEventListener(event.type, stopped);
    }, 0);
  }

  // Commit our local keyboard reader before starting the website navigation.
  // Run after site handlers, retaining their cancellation and updated link URL.
  function openLinkedTab(event) {
    const link = clickedLink(event);
    if (!link) return;
    const url = link.href;
    event.preventDefault();
    const fallback = () => window.open(url, '_blank', 'noopener');
    try {
      chrome.runtime.sendMessage({type: 'open-linked-tab', url, active: event.shiftKey,
        intentId: clickIntents.get(event)})
        .then(response => { if (!response?.ok) fallback(); }).catch(fallback);
    } catch { fallback(); }
  }
  window.addEventListener('click', captureLinkedClick, true);
  window.addEventListener('auxclick', captureLinkedClick, true);
  window.addEventListener('click', openLinkedTab);
  window.addEventListener('auxclick', openLinkedTab);

  function showNotice(text) {
    if (!document.documentElement) return;
    const host = document.createElement('div');
    const shadow = host.attachShadow({mode: 'closed'});
    const box = document.createElement('div');
    box.textContent = text;
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;bottom:24px;right:24px;max-width:360px;' +
      'padding:14px 18px;border-radius:12px;background:#17212f;color:white;' +
      'box-shadow:0 4px 24px #0004;font:14px/1.5 system-ui;z-index:2147483647';
    shadow.append(box);
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 6500);
  }
})();
