import test from 'node:test';
import assert from 'node:assert/strict';
import {LinkedHistory, matchClosedSession} from '../extension/history.js';

const tab = (id, windowId = 1) => ({id, windowId, url: `https://fixture.test/${id}`});
let time = 1;
const page = (key, navigationType = null) => ({key, navigationType, url: 'https://fixture.test/same',
  capturedAt: time++, entries: []});
function family() {
  const model = new LinkedHistory();
  const a = model.ensure(tab(1));
  const b = model.ensure(tab(2), true);
  model.observe(a, page('a2'));
  model.link(b, a);
  model.observe(b, page('b0'));
  return {model, a, b};
}
function close(model, node, parent, sessionId = 'session') {
  model.beginClose(node, parent, {url: node.url, beforeIds: [], index: 1, pinned: false});
  model.finishClose(node, sessionId);
}

test('B closes only at its root; A traverses back and returns before B restoration', () => {
  const {model, a, b} = family();
  model.observe(b, page('b1', 'push'));
  assert.equal(model.parentForBack(b), null);
  model.observe(b, page('b0', 'traverse'));
  assert.equal(model.parentForBack(b), a);
  close(model, b, a);
  model.observe(a, page('a1', 'traverse'));
  assert.equal(model.forwardAt(a), undefined);
  model.observe(a, page('a0', 'traverse'));
  model.observe(a, page('a1', 'traverse'));
  assert.equal(model.forwardAt(a), undefined);
  model.observe(a, page('a2', 'traverse'));
  assert.equal(model.forwardAt(a).childId, b.id);
  model.bindRestored(b, tab(20));
  assert.equal(model.byTab(20), b);
  assert.equal(model.forwardAt(a), undefined);
  assert.equal(model.parentForBack(b), a);
});

test('A → B → C survives serialized worker state and changed Chrome tab IDs', () => {
  const {model, a, b} = family();
  const c = model.ensure(tab(3), true);
  model.link(c, b);
  model.observe(c, page('c0'));
  close(model, c, b, 'c-session');
  close(model, b, a, 'b-session');
  const restarted = new LinkedHistory(JSON.parse(JSON.stringify(model.state)));
  const ra = restarted.state.nodes[a.id];
  const rb = restarted.state.nodes[b.id];
  const rc = restarted.state.nodes[c.id];
  assert.equal(restarted.forwardAt(ra).childId, rb.id);
  restarted.bindRestored(rb, tab(200));
  assert.equal(restarted.forwardAt(rb).childId, rc.id);
  restarted.bindRestored(rc, tab(300));
  assert.equal(restarted.parentForBack(rc), rb);
  assert.equal(restarted.parentForBack(rb), ra);
});

test('new navigation discards closed forward branches; replace/reload/traverse preserve them', () => {
  const {model, a, b} = family();
  close(model, b, a);
  model.observe(a, page('a2', 'replace'));
  model.observe(a, page('a2', 'reload'));
  assert.equal(model.forwardAt(a).childId, b.id);
  model.observe(a, page('a1', 'traverse'));
  model.observe(a, page('a-new', 'push'));
  assert.equal(a.forward.length, 0);
  model.prune();
  assert.equal(model.state.nodes[b.id], undefined);
});

test('equal URLs are distinguished by history entry key', () => {
  const {model, a, b} = family();
  close(model, b, a);
  model.observe(a, page('another-a2', 'traverse'));
  assert.equal(model.forwardAt(a), undefined);
  model.observe(a, page('a2', 'traverse'));
  assert.equal(model.forwardAt(a).childId, b.id);
});

test('source frame history must return to its anchor before restoring a child', () => {
  const {model, a, b} = family();
  a.frames = [{frameId: 7, key: 'frame-2', entries: [{key: 'frame-1'}, {key: 'frame-2'}]}];
  close(model, b, a);
  a.frames[0].key = 'frame-1';
  assert.equal(model.forwardAt(a), undefined);
  a.frames[0].key = 'frame-2';
  assert.equal(model.forwardAt(a).childId, b.id);
  // Session restoration can replace frame IDs but preserves entry keys.
  a.frames[0].frameId = 70;
  a.frames[0].key = 'frame-1';
  assert.equal(model.forwardAt(a), undefined);
});

test('cancelled close leaves both tabs live and no forward edge', () => {
  const {model, a, b} = family();
  model.beginClose(b, a, {url: b.url});
  model.cancelClose(b);
  assert.equal(b.tabId, 2);
  assert.equal(model.forwardAt(a), undefined);
});

test('latest closed child wins at an anchor, without replacing another session', () => {
  const {model, a, b} = family();
  const c = model.ensure(tab(3), true);
  model.link(c, a);
  model.observe(c, page('c0'));
  close(model, b, a, 'b');
  close(model, c, a, 'c');
  assert.equal(model.forwardAt(a).childId, c.id);
  model.bindRestored(c, tab(30));
  assert.equal(model.forwardAt(a).childId, b.id);
});

test('manually closing or moving the source prevents closing the child', () => {
  for (const action of ['removeManually', 'detach']) {
    const {model, a, b} = family();
    model[action](a);
    assert.equal(model.parentForBack(b), null);
  }
  const {model, a, b} = family();
  a.windowId = 9;
  assert.equal(model.parentForBack(b), null);
});

test('pre-existing unrelated tabs never acquire a false root; stale events are ignored', () => {
  const model = new LinkedHistory();
  const node = model.ensure(tab(1));
  const current = page('new');
  model.observe(node, current);
  model.observe(node, {...page('old'), capturedAt: current.capturedAt - 1});
  assert.equal(node.currentKey, 'new');
  assert.equal(node.rootKey, null);
});

test('fallback restoration resets inaccessible history and remains linked to the source', () => {
  const {model, a, b} = family();
  close(model, b, a);
  model.bindRestored(b, tab(20), true);
  model.observe(b, page('fresh-root'));
  assert.equal(b.rootKey, 'fresh-root');
  assert.equal(model.parentForBack(b), a);
});

test('regenerated same-origin keys are remapped by ordered slots, even with duplicate URLs', () => {
  const {model, a, b} = family();
  b.entries = [{key: 'b0', url: 'same'}, {key: 'b1', url: 'same'}];
  b.forward = [{anchorKey: 'b1', childId: 'x', sequence: 1}];
  model.remapRestoredEntries(b, {key: 'new-b0', entries:
    [{key: 'new-b0', url: 'same'}, {key: 'new-b1', url: 'same'}]});
  assert.equal(b.rootKey, 'new-b0');
  assert.equal(b.forward[0].anchorKey, 'new-b1');
});

test('a push immediately after restoration must not change the known root', () => {
  const {model, b} = family();
  model.remapRestoredEntries(b, {key: 'b2', entries:
    [{key: 'b0', url: 'root'}, {key: 'b1', url: 'one'}, {key: 'b2', url: 'two'}]});
  assert.equal(b.rootKey, 'b0');
});

test('only an unambiguous newly closed matching session is selected', () => {
  const record = {url: 'https://fixture.test/b', index: 2, pinned: false};
  const session = id => ({tab: {...record, sessionId: id}});
  assert.equal(matchClosedSession(['old'], [session('old'), session('new')], record), 'new');
  assert.equal(matchClosedSession([], [session('a'), session('b')], record), null);
  assert.equal(matchClosedSession([], [{window: {sessionId: 'window'}}], record), null);
  assert.equal(matchClosedSession([], [{tab: {...record, url: 'other', sessionId: 'other'}}], record), null);
});
