// Exercise the actual bundled loader with independent storage boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const acorn = require('acorn');
const walk = require('acorn-walk');
const source = fs.readFileSync(process.env.RA2_CLIENT_BUNDLE, 'utf8');
const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
let loader;
walk.simple(tree, { ClassExpression(node) {
  if (node.body.body.some(m => m.key?.name === 'load' && source.slice(m.start, m.end).includes('wl.loadGameMap(e)'))) loader = node;
}});
assert.ok(loader, 'actual MapFileLoader exists in the candidate');
// Replace only the actual storage boundary, including content-hashed releases.
const storeImports=[];
walk.simple(loader,{AwaitExpression(node){
  const item=node.argument;
  if(item.type==='ImportExpression' && typeof item.source.value==='string' && /^\/map-editor\/map-store(?:-[0-9a-f]{16})?\.mjs(?:\?v=workshop1)?$/.test(item.source.value))storeImports.push(node);
}});
assert.equal(storeImports.length,1,'Exactly one known map-store import must exist');
const storeImport=storeImports[0];
const code = (source.slice(loader.start, storeImport.start)+'wlStore'+source.slice(storeImport.end, loader.end))
  .replaceAll('import.meta.url', '"https://test.invalid/app.js"');
class MissingFile extends Error {}
function fixture({ loadGameMap, openFile, loadBinary }) {
  const Loader = vm.runInNewContext(`(${code})`, {
    wlStore: { loadGameMap }, AZ: () => false, nZ: name => [name], Hi: MissingFile,
    tv: file => file, wi: { fromBytes: (bytes, filename) => ({ bytes, filename }) }, console,
  });
  return new Loader({ loadBinary }, { openFileWithRfs: openFile });
}
test('editor host loads its browser-local bytes', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const loader = fixture({ loadGameMap: async () => bytes, openFile: async () => { throw new Error('unexpected native cache'); } });
  const file = await loader.load('wl_local_abc.map');
  assert.equal(file.bytes, bytes);
});
test('guest can reuse a received editor map from the native game cache', async () => {
  const received = { filename: 'wl_local_abc.map', bytes: new Uint8Array([4, 5, 6]) };
  const loader = fixture({ loadGameMap: async () => { throw new MissingFile('not in editor IndexedDB'); }, openFile: async name => {
    assert.equal(name, received.filename); return received;
  }, loadBinary: async () => { throw new Error('a cached map must not require HTTP'); } });
  assert.equal(await loader.load(received.filename), received);
});
test('unknown local map keeps the original missing-file failure', async () => {
  const unavailable = new MissingFile('not downloaded');
  const loader = fixture({ loadGameMap: async () => { throw unavailable; }, openFile: async () => { throw unavailable; }, loadBinary: async () => { throw unavailable; } });
  await assert.rejects(loader.load('wl_local_abc.map'), error => error === unavailable);
});
test('catalog integrity failures cannot fall back to an unverified cached map', async () => {
  const corrupt = new Error('catalog SHA-256 mismatch');
  const loader = fixture({ loadGameMap: async () => { throw corrupt; }, openFile: async () => { throw new Error('unexpected cache bypass'); } });
  await assert.rejects(loader.load('wl_cncnet_abc.map'), error => error === corrupt);
});
