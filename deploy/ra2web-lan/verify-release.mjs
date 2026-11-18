import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
const root = path.resolve(process.argv[2]);
const read = name => fs.readFileSync(path.join(root, name));
const json = name => JSON.parse(read(name));
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
const sri = bytes => 'sha384-' + hash(bytes, 'sha384', 'base64');
const manifest = json('deployment/files-sha256.json');
for (const [name, entry] of Object.entries(manifest)) {
  const bytes = read(name);
  assert.equal(bytes.length, entry.bytes, name);
  assert.equal(hash(bytes), entry.sha256, name);
}
const version = json('version.json');
for (const [name, entry] of Object.entries(version.files)) {
  const bytes = read(name);
  assert.equal(hash(bytes), entry.sha256, name);
  assert.equal(sri(bytes), entry.integrity, name);
  if (name.startsWith('js/') && name.endsWith('.js')) {
    for (const reference of bytes.toString().matchAll(/[?&]v=([0-9.]+-r[0-9a-f]+-workshop\d+)/g)) {
      assert.equal(reference[1], version.assetVersion, 'Stale module import in ' + name);
    }
  }
}
assert.equal(json('updates.json').version, version.assetVersion.replace(/-r[0-9a-f]+/, ''));
const worker = read('ra2web-sw.js').toString().split('\n')[0];
const config = JSON.parse(worker.slice('const config = '.length, -1));
assert.equal(config.version, version.assetVersion);
for (const [name, integrity] of Object.entries(config.assetIntegrity)) {
  assert.equal(sri(read(name === '/' ? 'index.html' : name.replace(/^\//, ''))), integrity, name);
}
for (const page of ['index.html', 'map-editor/index.html', 'maps/index.html']) {
  for (const tag of read(page).toString().matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const url = tag[0].match(/(?:src|href)="([^"]+)"/)?.[1];
    const integrity = tag[0].match(/integrity="([^"]+)"/)?.[1];
    if (url && integrity && !/^https?:/.test(url)) {
      const file = url.startsWith('/') ? url.slice(1).split('?')[0] : path.posix.join(path.posix.dirname(page), url.split('?')[0]);
      assert.equal(sri(read(file)), integrity, url);
    }
  }
}
let compressed = 0;
for (const name of Object.keys(manifest).filter(name => name.endsWith('.br'))) {
  assert.ok(zlib.brotliDecompressSync(read(name)).equals(read(name.slice(0, -3))), name);
  compressed++;
}
const meta = json('deployment/release.json');
assert.equal(meta.assetVersion, version.assetVersion);
assert.equal(meta.serverVersion, json('deployment/server/package.json').version);
assert.match(meta.serverVersion, /^\d+\.\d+\.\d+$/);
assert.equal(meta.serverSha256, hash(read('deployment/server/server.mjs')));
for (const name of ['catalog.json', 'game-index.json']) {
  const catalog = json('maps/' + name);
  assert.equal(catalog.displayLanguage, 'zh-CN');
  assert.ok(catalog.maps.every(map => /[\u3400-\u9fff]/.test(map.title) && typeof map.originalTitle === 'string'));
}
console.log(JSON.stringify({ files: Object.keys(manifest).length, integrityFiles: Object.keys(version.files).length, compressed, assetVersion: version.assetVersion, serverVersion: meta.serverVersion }));
