// A real committed document keeps receiving keys while the server is pending.
// replace() removes this temporary entry as soon as the website commits.
(() => {
  let url;
  try {
    url = new URL(decodeURIComponent(location.hash.slice(1))).href;
    if (!/^https?:/.test(url)) return;
  } catch { return; }
  let cancelled = false;
  window.navigation?.addEventListener('navigate', () => { cancelled = true; });
  window.addEventListener('pagehide', () => { cancelled = true; });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'get-snapshot') respond(null);
  });
  window.addEventListener('keydown', event => {
    if (!event.isTrusted || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const direction = event.code === 'BracketLeft' ? 'back' :
      event.code === 'BracketRight' ? 'forward' : null;
    if (!direction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    chrome.runtime.sendMessage({type: 'navigate', direction, snapshot: null})
      .catch(() => history.go(direction === 'back' ? -1 : 1));
  }, true);

  // Wait for the worker to bind the new tab to its source before navigating.
  // Chrome's native reopen can also restore this URL after session state clears;
  // it still loads the target, but never invents a missing source relationship.
  chrome.runtime.sendMessage({type: 'loading-ready', url})
    .then(() => { if (!cancelled) location.replace(url); })
    .catch(() => { if (!cancelled) location.replace(url); });
})();
