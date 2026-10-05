(() => {
  if (globalThis.__linkedHistoryInstalled) return;
  globalThis.__linkedHistoryInstalled = true;
  const topFrame = window === window.top;

  function snapshot(navigationType = null) {
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
  });

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
