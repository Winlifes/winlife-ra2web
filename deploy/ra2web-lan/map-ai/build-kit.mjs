// Build a portable, dependency-free map authoring kit from the deployed client.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadNativeResources} from '../map-library/build-catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const engine = path.resolve(process.argv[2] || path.join(root, 'vendor/ra2web-lan-0.87.3-20261112-workshop7'));
const out = path.resolve(process.argv[3] || path.join(root, 'vendor/ra2-map-ai-kit-1.0.0-20261113'));
if (fs.existsSync(out)) throw new Error('Build into a new directory: ' + out);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = fs.readFileSync(engine + '/js/app.js', 'utf8');
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b <= a) throw new Error('Native parser signature missing: ' + start);
  return source.slice(a, b);
};
const native = await loadNativeResources(engine);
const structureNames = ['CAOILD', 'CAHOSP', 'CAAIRP', 'CAOUTP'];
const structures = {};
for (const name of structureNames) {
  if (!native.registries.Structures.has(name)) throw new Error('Native structure missing: ' + name);
  const raw = native.art.get(name)?.get('FOUNDATION') || native.rules.get(name)?.get('FOUNDATION');
  if (!/^\d+x\d+$/.test(raw || '')) throw new Error('Unverified foundation: ' + name);
  structures[name] = {foundation: raw.split('x').map(Number)};
}
const snapshot = [
  '// Source excerpts from RA2WEB / Chrono Divide; see SOURCES.json and LICENSE.',
  'class wi {} const aX=wi;',
  between('function wlSpawnCap(', '\n'),
  between('class Ni{', 'var Ve;'),
  between('var Ve;let pt=', 'const y_='),
  between('class fs{', 'const oX='),
  between('class rX{', 'class f_'),
  between('class xTe{', 'class OTe{'),
  'const mu=s=>new Uint8Array(Buffer.from(s,"base64"));',
  'const Wr={None:0,Temperate:1,Urban:2,Snow:4,Lunar:8,Desert:16,NewUrban:32};',
  'class RTe{} class ITe{} class kTe{} class BTe{} class NTe{} class LTe{} class DTe{};',
  'class OTe{read(section){this.initialVeteran=section.getBool("InitialVeteran");return this;}}',
  between('const Xg=class Xg extends fs{', 'Xg.artSectionPrefix='),
  'Xg.artSectionPrefix="ART";',
  'for(const name of ["readLighting","readTagsAndTriggers","readScenarioTeams","readCellTags","readVariableNames"]) Xg.prototype[name]=function(){};',
  `globalThis.inspectNativeMap=function(text){
    const map=new Xg(text);
    return {tiles:map.tiles.map(t=>[t.rx,t.ry,Math.max(0,t.tileNum),t.subTile,t.z]),
      overlays:map.overlays.map(o=>[o.rx,o.ry,o.id,o.value]),
      waypoints:map.waypoints.map(w=>[w.number,w.rx,w.ry]),
      starts:map.startingLocations.map(p=>[p.x,p.y])};
  };`,
].join('\n');
const palettes = Object.fromEntries(['TEMPERATE', 'SNOW'].map(theater => [theater,
  Object.fromEntries([0, 314].map(id => {
    const tile = native.theaters[theater].tiles[id];
    if (!tile?.present) throw new Error('Native tile missing: ' + theater + ':' + id);
    return [id, {file: tile.file, subtiles: tile.subtiles}];
  }))]));
fs.cpSync(path.join(here, 'kit'), out, {recursive: true});
const codec = fs.readFileSync(path.join(here, '../map-editor/map-codec.mjs'));
fs.writeFileSync(out + '/lib/map-codec.mjs', codec);
fs.writeFileSync(out + '/lib/native-reader-source.txt', snapshot);
fs.copyFileSync(engine + '/LICENSE', out + '/LICENSE');
const sources = {
  kitVersion: '1.0.0', target: 'Winlife RA2WEB 0.87.3 with explicit 16-player extension',
  assetVersion: JSON.parse(fs.readFileSync(engine + '/version.json')).assetVersion,
  upstream: 'https://github.com/ra2web/ra2web.github.io/tree/ec91229bf85d637c2388edae31ef1f09805568e8',
  client: {file: 'js/app.js', sha256: sha(source)},
  codec: {source: 'deploy/ra2web-lan/map-editor/map-codec.mjs', sha256: sha(codec)},
  nativeSnapshot: {file: 'lib/native-reader-source.txt', sha256: sha(snapshot),
    coverage: ['native INI parser', 'native LZO/LCW decoders', 'native MapFile tiles/overlays/waypoints/starting locations'],
    excluded: ['lighting execution', 'scenario/trigger execution', 'game simulation', 'rendering', 'unit pathfinding']},
  resources: native.evidence,
  resourceScope: 'Base game-resources plus res/overlay; active MOD execution and its placement/pathfinding rules are not simulated.',
};
fs.writeFileSync(out + '/SOURCES.json', JSON.stringify(sources, null, 2) + '\n');
fs.writeFileSync(out + '/lib/profile.json', JSON.stringify({
  name: 'winlife-flat-land-v1', clientSha256: sha(source), maxBytes: 2 * 1024 * 1024,
  theaters: palettes, allowedOverlayIds: [27, 102], structures,
  trees: [...native.registries.Terrain].filter(name => /^TREE\d{2}$/.test(name)).sort(),
  scope: 'New flat land multiplayer maps. Shore art, ramps, bridges, scripts, rule overrides and full runtime behavior need separate validation.',
}, null, 2) + '\n');
console.log(JSON.stringify({out, version: sources.kitVersion, client: sources.assetVersion, snapshotBytes: Buffer.byteLength(snapshot)}));
