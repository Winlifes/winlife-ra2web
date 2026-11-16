// Precompress immutable payloads for the ECS bandwidth limit, keeping decoded
// game bytes, CRCs and SRI unchanged. Also replace the upstream promotional news.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const root = path.resolve(process.argv[2]);
const here = path.dirname(fileURLToPath(import.meta.url));
const deployment = path.join(root, 'deployment');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const sri = data => 'sha384-' + crypto.createHash('sha384').update(data).digest('base64');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
fs.copyFileSync(fileURLToPath(import.meta.url), path.join(deployment, 'prepare-static.mjs'));
fs.copyFileSync(path.join(here, 'build-release.py'), path.join(deployment, 'build-public-release.py'));
fs.copyFileSync(path.join(deployment, 'news.html'), path.join(root, 'breaking-news.html'));
json(path.join(root, 'updates.json'), { version: '0.87.3', items: [
  { title: '原版界面', text: '菜单动画、启动背景与国家加载画面采用原版红警素材。' },
  { title: '在线联机', text: '进入联机大厅选择「阿里云 · 公网联机」，登录后建立或加入房间，与朋友一起游戏。' },
] });
const candidates = [
  ...fs.readdirSync(path.join(root, 'game-resources')).filter(n => n.endsWith('.mix')).map(n => 'game-resources/' + n),
  ...fs.readdirSync(path.join(root, 'js')).filter(n => /\.(js|wasm|css)$/.test(n)).map(n => 'js/' + n),
  'style.css',
];
for (const directory of ['map-editor', 'maps']) {
  const folder = path.join(root, directory);
  if (!fs.existsSync(folder)) continue;
  function addFiles(current) {
    for (const item of fs.readdirSync(current, {withFileTypes:true})) {
      const file = path.join(current,item.name);
      if (item.isDirectory()) addFiles(file);
      else if (/\.(map|mjs|js|json|css|html)$/.test(item.name)) candidates.push(path.relative(root,file));
    }
  }
  addFiles(folder);
}
const records = [];
for (const name of candidates) {
  const file = path.join(root, name), decoded = fs.readFileSync(file);
  const encoded = zlib.brotliCompressSync(decoded, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
  if (encoded.length >= decoded.length * 0.95) continue;
  if (!zlib.brotliDecompressSync(encoded).equals(decoded)) throw new Error('Compression round trip: ' + name);
  fs.writeFileSync(file + '.br', encoded);
  records.push({file: name, decodedBytes: decoded.length, encodedBytes: encoded.length, sha256: sha(encoded)});
}
json(path.join(deployment, 'precompression.json'), {encoding: 'br', records});
const versionPath = path.join(root, 'version.json'), version = JSON.parse(fs.readFileSync(versionPath));
for (const [name, entry] of Object.entries(version.files)) {
  const file = path.join(root, name);
  if (fs.existsSync(file)) {
    const data = fs.readFileSync(file);
    Object.assign(entry, {bytes: data.length, sha256: sha(data), integrity: sri(data)});
  }
}
json(versionPath, version);
const manifestPath = path.join(deployment, 'files-sha256.json'), manifest = {};
function walk(folder) {
  for (const item of fs.readdirSync(folder, {withFileTypes: true})) {
    const file = path.join(folder, item.name);
    if (item.isDirectory()) walk(file);
    else if (item.isFile() && file !== manifestPath) {
      const data = fs.readFileSync(file);
      manifest[path.relative(root, file)] = {bytes: data.length, sha256: sha(data)};
    }
  }
}
walk(root); json(manifestPath, manifest);
console.log(JSON.stringify({files: Object.keys(manifest).length, precompressedFiles: records.length,
  decodedBytes: records.reduce((a, r) => a + r.decodedBytes, 0),
  encodedBytes: records.reduce((a, r) => a + r.encodedBytes, 0)}));
