const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const bundle = process.env.RA2_CLIENT_BUNDLE || path.resolve(__dirname,
  '../../vendor/ra2web-lan-0.87.3-20261112-workshop7/js/app.js');
const source = fs.readFileSync(bundle, 'utf8').match(/^function wlFitLobbySelect\([\s\S]*?\n\}/m)?.[0];
assert.ok(source, 'The real native Select must include room-bound placement');

function fixture({top = 80, bottom = 106, clipTop = 20, clipBottom = 580, scale = 1} = {}) {
  const listeners = new Map();
  const resize = new Map();
  let closed = 0;
  let shift = 0;
  const layer = {style: {}, contains: target => target === layer || target?.parent === layer};
  const form = {
    getBoundingClientRect: () => ({top: clipTop, bottom: clipBottom}),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { assert.equal(listeners.get(name), fn); listeners.delete(name); },
  };
  const control = {
    closest: () => form, querySelector: () => layer, offsetHeight: (bottom - top) / scale,
    getBoundingClientRect: () => ({top: top + shift, bottom: bottom + shift, height: bottom - top}),
  };
  const context = vm.createContext({window: {
    innerHeight: 2000,
    addEventListener: (name, fn) => resize.set(name, fn),
    removeEventListener: (name, fn) => { assert.equal(resize.get(name), fn); resize.delete(name); },
  }});
  vm.runInContext(source, context);
  const cleanup = context.wlFitLobbySelect(control, () => ++closed);
  return {layer, listeners, resize, cleanup, form, closed: () => closed, context, shift: n => shift = n};
}

test('upper room rows open below without clipping', () => {
  const f = fixture();
  assert.deepEqual(f.layer.style, {top: '26px', bottom: 'auto', maxHeight: '240px'});
});

test('lower room rows open above instead of escaping the scrolling panel', () => {
  const f = fixture({top: 500, bottom: 526});
  assert.deepEqual(f.layer.style, {top: 'auto', bottom: '26px', maxHeight: '240px'});
});

test('scaled game UI keeps dropdown dimensions in logical pixels', () => {
  const f = fixture({top: 1000, bottom: 1052, clipTop: 40, clipBottom: 1160, scale: 2});
  assert.deepEqual(f.layer.style, {top: 'auto', bottom: '26px', maxHeight: '240px'});
});

test('limited visible space produces a scrollable dropdown that fits', () => {
  const f = fixture({top: 100, bottom: 126, clipTop: 40, clipBottom: 180});
  assert.equal(f.layer.style.maxHeight, '58px');
  assert.equal(f.layer.style.top, 'auto');
});

test('scroll anchoring keeps a menu open and refits it; leaving the room viewport closes it', () => {
  const f = fixture();
  f.listeners.get('scroll')({target: f.layer});
  f.listeners.get('scroll')({target: {parent: f.layer}});
  assert.equal(f.closed(), 0);
  f.listeners.get('scroll')({target: f.form});
  assert.equal(f.closed(), 0);
  f.shift(420);
  f.listeners.get('scroll')({target: f.form});
  assert.equal(f.layer.style.top, 'auto');
  f.shift(1000);
  f.listeners.get('scroll')({target: f.form});
  assert.equal(f.closed(), 1);
  f.resize.get('resize')();
  assert.equal(f.closed(), 2);
  f.cleanup();
  assert.equal(f.listeners.size + f.resize.size, 0);
});

test('selects outside a room retain the original behavior', () => {
  const f = fixture();
  assert.equal(typeof f.context.wlFitLobbySelect({closest: () => null, querySelector: () => null}, () => {}), 'function');
});
