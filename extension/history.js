// Serializable domain model. Chrome IDs change on session restoration; node IDs do not.
export function emptyState() {
  return {version: 1, enabled: true, nextId: 1, sequence: 0, nodes: {}, notice: null};
}

export class LinkedHistory {
  constructor(state) {
    this.state = state?.version === 1 ? state : emptyState();
  }

  byTab(tabId) {
    return Object.values(this.state.nodes).find(node => node.tabId === tabId);
  }

  ensure(tab, fresh = false) {
    let node = this.byTab(tab.id);
    if (!node) {
      const id = String(this.state.nextId++);
      node = this.state.nodes[id] = {
        id, tabId: tab.id, windowId: tab.windowId, parentId: null,
        fresh, rootKey: null, currentKey: null, capturedAt: 0,
        url: tab.url || tab.pendingUrl || '', entries: [], frames: [], forward: [], closed: null,
      };
    } else if (fresh && !node.closed) {
      // Initialization may have queried a tab just before its onCreated event.
      node.fresh = true;
      if (!node.rootKey && node.currentKey) node.rootKey = node.currentKey;
    }
    return node;
  }

  link(child, parent) {
    if (!child || !parent || child.id === parent.id || child.closed ||
        child.windowId !== parent.windowId || !child.fresh || child.parentId) return;
    // A new linked tab creates a new forward branch, just like a new page.
    parent.forward = [];
    child.parentId = parent.id;
  }

  observe(node, snapshot) {
    if (!node || !snapshot?.key || snapshot.capturedAt < node.capturedAt) return;
    if (node.fresh && !node.rootKey) node.rootKey = snapshot.key;
    if (snapshot.navigationType === 'push' && snapshot.key !== node.currentKey) {
      node.forward = [];
    }
    node.currentKey = snapshot.key;
    node.capturedAt = snapshot.capturedAt;
    node.url = snapshot.url;
    node.entries = snapshot.entries || [];
    if (snapshot.frames) node.frames = snapshot.frames;
  }

  parentForBack(node, uncommitted = false) {
    const parent = this.state.nodes[node?.parentId];
    const atRoot = node?.rootKey && node.currentKey === node.rootKey;
    const beforeFirstEntry = uncommitted && node?.fresh && !node.rootKey && !node.currentKey;
    return (atRoot || beforeFirstEntry) && parent?.tabId != null &&
      parent.windowId === node.windowId ? parent : null;
  }

  forwardAt(node) {
    return node?.forward.filter(edge => edge.anchorKey === node.currentKey &&
      (edge.anchorFrames || []).every(anchor => {
        const frame = (node.frames || []).find(frame => frame.frameId === anchor.frameId ||
          frame.entries.some(entry => entry.key === anchor.key));
        return !frame || frame.key === anchor.key;
      }) &&
      this.state.nodes[edge.childId]?.closed).sort((a, b) => b.sequence - a.sequence)[0];
  }

  beginClose(node, parent, record) {
    node.closed = {...record, parentId: parent.id, anchorKey: parent.currentKey,
      anchorFrames: (parent.frames || []).map(frame => ({frameId: frame.frameId, key: frame.key})), pending: true};
  }

  finishClose(node, sessionId = null) {
    const parent = this.state.nodes[node.closed.parentId];
    node.closed.pending = false;
    node.closed.sessionId = sessionId;
    node.tabId = null;
    if (parent) {
      parent.forward = parent.forward.filter(edge => edge.childId !== node.id);
      parent.forward.push({childId: node.id, anchorKey: node.closed.anchorKey,
        anchorFrames: node.closed.anchorFrames,
        sequence: ++this.state.sequence});
    }
  }

  cancelClose(node) {
    node.closed = null;
  }

  bindRestored(node, tab, fallback = false) {
    const temporary = this.byTab(tab.id);
    if (temporary && temporary !== node) delete this.state.nodes[temporary.id];
    for (const other of Object.values(this.state.nodes)) {
      other.forward = other.forward.filter(edge => edge.childId !== node.id);
    }
    node.tabId = tab.id;
    node.windowId = tab.windowId;
    node.closed = null;
    node.capturedAt = 0;
    if (fallback) {
      node.rootKey = null;
      node.currentKey = null;
      node.entries = [];
      node.frames = [];
      node.forward = [];
    }
  }

  remapRestoredEntries(node, snapshot) {
    // Chromium normally preserves Navigation API keys in PageState. Map the
    // root and same-origin slots too, for versions that regenerate them.
    if (!snapshot?.key || node.currentKey === snapshot.key) return;
    const old = node.entries;
    const current = snapshot.entries || [];
    const replacements = new Map();
    // A site may push entries immediately after restore, before the worker's
    // first snapshot. Do not mistake that later page for the original root.
    if (current.some(entry => entry.key === node.rootKey)) return;
    if (old.length === current.length && old.every((entry, i) => entry.url === current[i].url)) {
      old.forEach((entry, i) => replacements.set(entry.key, current[i].key));
    }
    node.rootKey = replacements.get(node.rootKey) || node.rootKey;
    node.forward.forEach(edge => {edge.anchorKey = replacements.get(edge.anchorKey) || edge.anchorKey;});
  }

  removeManually(node) {
    if (!node) return;
    for (const other of Object.values(this.state.nodes)) {
      if (other.parentId === node.id) other.parentId = null;
      other.forward = other.forward.filter(edge => edge.childId !== node.id);
    }
    delete this.state.nodes[node.id];
  }

  detach(node) {
    if (!node) return;
    node.parentId = null;
    node.forward = [];
    for (const other of Object.values(this.state.nodes)) {
      if (other.parentId === node.id) other.parentId = null;
      other.forward = other.forward.filter(edge => edge.childId !== node.id);
    }
  }

  prune() {
    // Closed nodes only matter while reachable from a live tab's forward chain.
    const keep = new Set();
    const visit = node => {
      if (!node || keep.has(node.id)) return;
      keep.add(node.id);
      node.forward.forEach(edge => visit(this.state.nodes[edge.childId]));
    };
    Object.values(this.state.nodes).filter(node => node.tabId != null).forEach(visit);
    for (const node of Object.values(this.state.nodes)) {
      if (!keep.has(node.id)) delete this.state.nodes[node.id];
    }
  }
}

export function matchClosedSession(beforeIds, sessions, record) {
  const candidates = sessions.filter(session => session.tab &&
    !beforeIds.includes(session.tab.sessionId) && session.tab.url === record.url &&
    session.tab.index === record.index && session.tab.pinned === record.pinned);
  // Never restore an unrelated tab when concurrent closes are ambiguous.
  return candidates.length === 1 ? candidates[0].tab.sessionId : null;
}
