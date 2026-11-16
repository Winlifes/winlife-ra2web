/** Run: node --test deploy/ra2web-lan/map-editor/map-codec.test.mjs */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import {
  createMap, parseMap, serializeMap, setOverlay, getOverlay, setSpawn, removeSpawn,
  setTerrain, removeTerrain, addStructure, removeStructure, setMetadata,
  getIniValue, setIniValue, tileAtCell, tileAtDisplay, displayToCell, cellToDisplay,
  playableBounds, isPlayableCell, encodePacked, decodePacked, encodeFormat80,
  decodeFormat80, encodeLzo1xLiteral, decodeLzo1x, base64ToBytes, bytesToBase64,
  OVERLAY_IDS, TERRAIN_TILES,
} from './map-codec.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const relClient = 'vendor/ra2web-lan-0.87.3-20261112-net2-r1/js/app.js';
const source = readFileSync(root + relClient, 'utf8');
const fixtureDirectory = "vendor/platform-maps-20261112/cncnet-yr-client-package/package/Maps/Yuri's Revenge/";
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const proof = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  command: 'node --test deploy/ra2web-lan/map-editor/map-codec.test.mjs',
  sources: {
    codec: { path: 'deploy/ra2web-lan/map-editor/map-codec.mjs', sha256: sha256(readFileSync(new URL('./map-codec.mjs', import.meta.url))) },
    tests: { path: 'deploy/ra2web-lan/map-editor/map-codec.test.mjs', sha256: sha256(readFileSync(fileURLToPath(import.meta.url))) },
    client: { path: relClient, sha256: sha256(source), classes: ['MapFile/Xg', 'MiniLzo/rX/qS', 'Format80/xTe', 'PackedSection/ay', 'IniFile/fs/nA/Ni'] },
    rules: { path: 'vendor/ra2web-lan-0.87.3-20261112-net2-r1/res/overlay/rules.ini' },
  },
  fixtures: [],
  tests: { passed: [], failed: [] },
  limitations: [
    'Engine integration executes the release MapFile.fromString/readTiles/readOverlays, not a complete rendered game.',
    'Only unrelated lighting/scenario parsing is stubbed in the engine harness; both original compression decoders and original INI parser execute unchanged.',
    'The original client reads eight multiplayer slots; extended slots require an explicitly marked compatible LAN client.',
    'Water painting writes real water cells but does not automatically generate shore pieces or playable ramps.',
    'Imported rule overrides, triggers and object names are preserved; compatibility of those game rules is audited by the separate map catalog.',
  ],
};

function check(name, fn) {
  return test(name, async () => {
    try { await fn(); proof.tests.passed.push(name); }
    catch (error) { proof.tests.failed.push({ name, error: error.message }); throw error; }
  });
}

function between(start, end) {
  const at = source.indexOf(start), until = source.indexOf(end, at);
  assert.ok(at >= 0 && until > at, `Client source signature ${start}`);
  return source.slice(at, until);
}

// Execute the installed client's actual INI, LZO, LCW and MapFile source.
// No editor codec is used by this independent engine data-path check.
const sandbox = vm.createContext({ console, Uint8Array, Uint32Array, Int8Array, Int16Array, Int32Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, Buffer });
const harnessSource = [
  'class wi {} const aX=wi;',
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
  // These do not participate in the independent tile, overlay, waypoint,
  // object or INI checks and require the full game's scenario rule enums.
  'for(const name of ["readLighting","readTagsAndTriggers","readScenarioTeams","readCellTags","readVariableNames"]) Xg.prototype[name]=function(){};',
  'globalThis.EngineMap=Xg; globalThis.EnginePacked=ay; globalThis.EngineLzo=qS; globalThis.EngineFormat80=xTe;',
].join('\n');
vm.runInContext(harnessSource, sandbox, { timeout: 5000 });
const EngineMap = sandbox.EngineMap;

const tileShape = tile => [tile.rx, tile.ry, Math.max(0, tile.tileNum), tile.subTile, tile.z];
const overlayShape = overlay => [overlay.rx, overlay.ry, overlay.id, overlay.value];
const sortOverlay = values => values.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
function compareEngine(text, doc = parseMap(text)) {
  const engine = new EngineMap(text);
  assert.deepEqual(Array.from(engine.tiles, tileShape), doc.tiles.map(tileShape), 'Client tile data must match');
  const expected = [...doc.overlays.values()].filter(item => tileAtCell(doc, item.rx, item.ry)).map(overlayShape);
  assert.deepEqual(sortOverlay(Array.from(engine.overlays, overlayShape)), sortOverlay(expected), 'Client overlay data must match');
  const sortedWaypoints = list => list.sort((a, b) => a[0] - b[0]);
  assert.deepEqual(sortedWaypoints(Array.from(engine.waypoints, item => [item.number, item.rx, item.ry])), sortedWaypoints(doc.waypoints.map(item => [item.number, item.rx, item.ry])));
  return engine;
}

function rawSection(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.match(new RegExp(`^\\[${escaped}\\][^]*?(?=^\\[|$(?![^]))`, 'm'))?.[0];
}
function omitSection(text, name) { return text.replace(rawSection(text, name) ?? '\0\0\0', ''); }

check('real TEMPERATE and SNOW maps preserve all INI and match the release parser', () => {
  for (const name of ['2_impasse.map', '2_landmarks.map']) {
    const relative = fixtureDirectory + name, bytes = readFileSync(root + relative), text = bytes.toString('utf8');
    const doc = parseMap(text), engine = compareEngine(text, doc);
    const serialized = serializeMap(doc);
    assert.equal(serialized, text, 'A no-op import/export must be byte-for-byte identical');
    assert.ok(doc.tiles.length > 10000 && doc.overlays.size > 100 && doc.terrain.size > 100 && doc.structures.size > 10);
    assert.deepEqual(parseMap(serialized).metadata, doc.metadata);
    proof.fixtures.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes), theater: doc.metadata.theater,
      width: doc.fullSize.width, height: doc.fullSize.height, tileCount: doc.tiles.length, overlayCount: doc.overlays.size,
      terrainCount: doc.terrain.size, structureCount: doc.structures.size, releaseStartingLocations: engine.startingLocations.length,
      noOpByteIdentical: true, independentReleaseParserMatched: true });
  }
});

check('edits reencode real foreign compressed maps without losing triggers or unknown fields', () => {
  const fixture = readFileSync(root + fixtureDirectory + '2_impasse.map', 'utf8');
  const extra = '\n[EditorUnknown]\nKeep=semi\\;colon\\\\slash ; preserve this exact comment\n0=arbitrary,1,2,3\n\n[Actions]\n01000000=1,7,0,0,0,0,0,0,A\n\n[Triggers]\n01000000=Neutral,<none>,Keep trigger,0,1,1,1,0\n';
  const input = fixture + extra, doc = parseMap(input);
  const center = tileAtDisplay(doc, 100, 45), beside = tileAtDisplay(doc, 102, 45);
  center.tileNum = TERRAIN_TILES.TEMPERATE.water; center.subTile = (center.rx & 1) + 2 * (center.ry & 1); center.z = 0;
  beside.z = 3;
  setOverlay(doc, center.rx, center.ry, OVERLAY_IDS.GEMS, 11);
  setOverlay(doc, beside.rx, beside.ry, OVERLAY_IDS.ORE, 11);
  setSpawn(doc, 0, beside.rx, beside.ry); setMetadata(doc, { name: 'Codec test; edited', author: 'Local editor' });
  const output = serializeMap(doc), next = parseMap(output);
  assert.equal(next.metadata.name, 'Codec test; edited');
  assert.equal(tileAtCell(next, center.rx, center.ry).tileNum, 314);
  assert.equal(tileAtCell(next, beside.rx, beside.ry).z, 3);
  assert.equal(getOverlay(next, center.rx, center.ry).id, 27);
  assert.equal(getOverlay(next, beside.rx, beside.ry).value, 11);
  assert.deepEqual(next.spawns.find(point => point.number === 0), { number: 0, rx: beside.rx, ry: beside.ry });
  for (const section of ['EditorUnknown', 'Actions', 'Triggers', 'CAAIRP', 'CAOILD', 'Units', 'Infantry', 'ScriptTypes']) {
    assert.equal(rawSection(output, section), rawSection(input, section), `Preserve [${section}]`);
  }
  compareEngine(output, next);
  proof.editedForeignMap = { bytes: Buffer.byteLength(output), independentReleaseParserMatched: true, preservedSections: ['EditorUnknown', 'Actions', 'Triggers', 'CAAIRP', 'CAOILD', 'Units', 'Infantry', 'ScriptTypes'] };
});

check('flat grass and snow maps include valid packs, playable spawns and independent release decoding', () => {
  proof.generatedMaps = [];
  for (const theater of ['TEMPERATE', 'SNOW']) {
    const doc = createMap({ width: 64, height: 64, theater, name: `Codec ${theater}`, players: 8 });
    assert.equal(doc.tiles.length, 127 * 64);
    assert.equal(doc.overlays.size, 0);
    assert.ok(doc.tiles.every(tile => tile.tileNum === 0 && tile.subTile === 0 && tile.z === 0));
    assert.equal(new Set(doc.spawns.map(point => point.ry * 1000 + point.rx)).size, 8);
    assert.ok(doc.spawns.every(point => isPlayableCell(doc, point.rx, point.ry)));
    assert.deepEqual(playableBounds(doc), { x: 4, y: 8, width: 118, height: 109 });
    assert.deepEqual(displayToCell(doc, 63, 63), { rx: 64, ry: 64 });
    assert.deepEqual(cellToDisplay(doc, 64, 64), { dx: 63, dy: 63, row: 31 });
    assert.equal(tileAtDisplay(doc, 63, 31), tileAtCell(doc, 64, 64));
    assert.equal(displayToCell(doc, 63, 64), null);
    const output = serializeMap(doc), engine = compareEngine(output);
    assert.equal(engine.startingLocations.length, 8);
    assert.ok(Buffer.byteLength(output) < 150000, 'Empty overlay RLE must not inflate a new map');
    proof.generatedMaps.push({ theater, width: 64, height: 64, bytes: Buffer.byteLength(output), sha256: sha256(output), releaseStartingLocations: engine.startingLocations.length, independentReleaseParserMatched: true });
  }
  const smallest = createMap({ width: 16, height: 16, players: 16 });
  assert.ok(smallest.spawns.every(point => isPlayableCell(smallest, point.rx, point.ry)));
  assert.equal(new Set(smallest.spawns.map(point => point.ry * 1000 + point.rx)).size, 16);
});

check('legacy waypoints 8 and 9 survive spawn editing and untrusted MaxPlayer metadata', () => {
  let input = serializeMap(createMap({ players: 2 }));
  const doc = parseMap(input);
  const first = tileAtDisplay(doc, 50, 22), second = tileAtDisplay(doc, 60, 28);
  setIniValue(doc, 'Waypoints', '8', first.ry * 1000 + first.rx);
  setIniValue(doc, 'Waypoints', '9', second.ry * 1000 + second.rx);
  setIniValue(doc, 'Basic', 'MaxPlayer', '21');
  input = serializeMap(doc);
  const imported = parseMap(input);
  assert.equal(imported.spawnLimit, 8); assert.equal(imported.spawns.length, 2); assert.equal(imported.metadata.maxPlayers, 2);
  assert.ok(imported.warnings.some(warning => warning.includes('MaxPlayer=21')));
  assert.equal(imported.waypoints.length, 4);
  setSpawn(imported, 0, first.rx, first.ry); removeSpawn(imported, 1);
  const output = serializeMap(imported), result = parseMap(output);
  assert.equal(getIniValue(result, 'Waypoints', '8'), String(first.ry * 1000 + first.rx));
  assert.equal(getIniValue(result, 'Waypoints', '9'), String(second.ry * 1000 + second.rx));
  assert.equal(result.spawns.length, 1); assert.equal(result.waypoints.length, 3);
  assert.equal(getIniValue(result, 'Basic', 'WinlifeMaxPlayers'), '');
});

check('explicit extended spawn caps preserve waypoints beyond their exact cap', () => {
  const extended = createMap({ players: 12 });
  assert.equal(extended.spawnLimit, 12); assert.equal(extended.spawns.length, 12);
  assert.equal(getIniValue(extended, 'Basic', 'WinlifeMaxPlayers'), '12');
  const point = tileAtDisplay(extended, 52, 29);
  setIniValue(extended, 'Waypoints', '12', point.ry * 1000 + point.rx);
  setIniValue(extended, 'Waypoints', '15', point.ry * 1000 + point.rx);
  const restored = parseMap(serializeMap(extended));
  assert.equal(restored.spawns.length, 12); assert.equal(restored.waypoints.length, 14);
  removeSpawn(restored, 11);
  const edited = parseMap(serializeMap(restored));
  assert.equal(getIniValue(edited, 'Waypoints', '12'), String(point.ry * 1000 + point.rx));
  assert.equal(getIniValue(edited, 'Waypoints', '15'), String(point.ry * 1000 + point.rx));
  const unmarked = createMap({ players: 2 });
  setMetadata(unmarked, { maxPlayers: 10 });
  setSpawn(unmarked, 8, point.rx, point.ry);
  assert.equal(getIniValue(parseMap(serializeMap(unmarked)), 'Basic', 'WinlifeMaxPlayers'), '10');
});

check('resource data, trees, neutral structures and unknown CSV columns survive edits', () => {
  const doc = createMap({ players: 2 }), a = tileAtDisplay(doc, 60, 28), b = tileAtDisplay(doc, 62, 28);
  setOverlay(doc, a.rx, a.ry, OVERLAY_IDS.ORE, 11);
  setTerrain(doc, b.rx, b.ry, 'T01');
  const structureKey = addStructure(doc, { rx: a.rx + 2, ry: a.ry + 2, name: 'CAOILD' });
  let output = serializeMap(doc), next = parseMap(output);
  const object = next.structures.get(structureKey);
  assert.equal(object.name, 'CAOILD'); assert.equal(object.owner, 'Neutral'); assert.equal(object.fields.length, 17);
  object.fields.push('retained-future-column'); object.health = 128;
  output = serializeMap(next); next = parseMap(output);
  assert.equal(next.structures.get(structureKey).fields[17], 'retained-future-column');
  assert.equal(next.structures.get(structureKey).health, 128);
  assert.equal(next.terrain.get(b.ry * 1000 + b.rx).name, 'T01');
  compareEngine(output, next);
  setOverlay(next, a.rx, a.ry, 255); removeTerrain(next, b.rx, b.ry); removeStructure(next, structureKey);
  const empty = parseMap(serializeMap(next));
  assert.equal(empty.overlays.size, 0); assert.equal(empty.terrain.size, 0); assert.equal(empty.structures.size, 0);
  const data = decodePacked(rawSection(serializeMap(next), 'OverlayDataPack').split(/\r?\n/).slice(1).filter(line => /^\d+=/.test(line)).map(line => line.slice(line.indexOf('=') + 1)).join(''), 80);
  assert.equal(data[a.ry * 512 + a.rx], 0);
});

check('adding an overlay to a map with no overlay sections emits both required packs', () => {
  let text = serializeMap(createMap()); text = omitSection(omitSection(text, 'OverlayPack'), 'OverlayDataPack');
  const doc = parseMap(text), center = tileAtDisplay(doc, 63, 31);
  setOverlay(doc, center.rx, center.ry, OVERLAY_IDS.GEMS);
  const out = serializeMap(doc);
  assert.ok(rawSection(out, 'OverlayPack') && rawSection(out, 'OverlayDataPack'));
  const game = compareEngine(out);
  assert.equal(game.overlays.length, 1); assert.equal(game.overlays[0].id, 27);
});

check('LZO literal storage and Format80 cover chunk boundaries and original engine decoders', () => {
  let state = 0x12345678;
  const random = size => Uint8Array.from({ length: size }, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state & 255; });
  for (const length of [4, 5, 237, 238, 239, 240, 241, 242, 476, 477, 8192, 8193, 65536]) {
    const bytes = random(length), packed = encodePacked(bytes);
    assert.deepEqual(decodePacked(packed), bytes);
    assert.deepEqual(new Uint8Array(sandbox.EnginePacked.decode(packed, length)), bytes);
    const lcw = encodePacked(bytes, 80);
    assert.deepEqual(decodePacked(lcw, 80), bytes);
    assert.deepEqual(new Uint8Array(sandbox.EnginePacked.decode(lcw, length, 80)), bytes);
  }
  const commands = Uint8Array.from([0x83, 65, 66, 67, 0x00, 3, 0xc0, 0, 0, 0xfe, 4, 0, 90, 0xff, 5, 0, 3, 0, 0x80]);
  const expected = new TextEncoder().encode('ABCABCABCZZZZABCAB');
  assert.deepEqual(decodeFormat80(commands, expected.length), expected);
  assert.deepEqual(new Uint8Array(sandbox.EngineFormat80.decode(commands, expected.length)), expected);
  const repeat = new Uint8Array(8192).fill(255), compressed = encodeFormat80(repeat);
  assert.ok(compressed.length < 10);
  assert.deepEqual(decodeFormat80(compressed, repeat.length), repeat);
  const sample = random(238), literal = encodeLzo1xLiteral(sample);
  assert.deepEqual(decodeLzo1x(literal, sample.length), sample);
  assert.deepEqual(new Uint8Array(sandbox.EngineLzo.decompress(literal, sample.length)), sample);
  assert.deepEqual(base64ToBytes(bytesToBase64(sample)), sample);
});

check('malformed imports and invalid mutations fail with bounded errors', () => {
  for (const input of [new Uint8Array(), Uint8Array.from([0]), Uint8Array.from([17, 1]), Uint8Array.from([18, 1, 1, 255, 17, 0, 0])]) {
    assert.throws(() => decodeLzo1x(input, 10));
  }
  assert.throws(() => decodeFormat80(Uint8Array.from([0, 1, 128]), 3), /lookbehind/);
  assert.throws(() => decodeFormat80(Uint8Array.from([254, 255, 255, 0, 128]), 8), /overrun/);
  assert.throws(() => decodePacked(Uint8Array.from([255, 255, 0, 1])));
  assert.throws(() => base64ToBytes('not*a*map'));
  assert.throws(() => parseMap('[Basic]\nName=Bad'));
  assert.throws(() => createMap({ width: 500 }));
  const doc = createMap();
  assert.throws(() => setSpawn(doc, 16, 50, 50));
  assert.throws(() => setSpawn(doc, 0, 0, 0), /outside/);
  assert.throws(() => setOverlay(doc, 50, 50, 300));
  doc.tiles[0].tileNum = 65536; assert.throws(() => serializeMap(doc), /Tile number/);
});

// Original Westwood MIX v2 CRC and headers, verified in this workspace by
// deploy/ra2-web/build-zh-language.py. No assets are written or redistributed.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function mixEntry(archive, name) {
  const bytes = readFileSync(root + 'vendor/ra2web-lan-resources/' + archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x10000, 'Expected unencrypted original checksum MIX');
  const count = view.getUint16(4, true), base = 10 + count * 12;
  const encoded = [...new TextEncoder().encode(name.toUpperCase())], remain = encoded.length & 3;
  if (remain) { const pad = encoded[encoded.length & ~3]; encoded.push(remain); for (let i = 0; i < 3 - remain; i++) encoded.push(pad); }
  const id = crc32(encoded);
  for (let i = 0; i < count; i++) if (view.getUint32(10 + i * 12, true) === id) {
    const offset = view.getUint32(14 + i * 12, true), length = view.getUint32(18 + i * 12, true);
    return { bytes: bytes.subarray(base + offset, base + offset + length), archiveSha256: sha256(bytes) };
  }
  throw new Error(`${name} missing from ${archive}`);
}
function nativeIni(text) {
  const sections = new Map(); let current;
  for (let line of text.split(/\r?\n/)) {
    line = line.split(';')[0].trim();
    if (line.startsWith('[') && line.endsWith(']')) { current = new Map(); sections.set(line.slice(1, -1), current); }
    else if (current && line.includes('=')) { const equals = line.indexOf('='); current.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim()); }
  }
  return sections;
}
function inspectTmp(entry) {
  const bytes = entry.bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getInt32(0, true), height = view.getInt32(4, true);
  const subTiles = [];
  for (let i = 0; i < width * height; i++) {
    const offset = view.getUint32(16 + i * 4, true);
    subTiles.push({ index: i, height: bytes[offset + 40], terrainType: bytes[offset + 41], rampType: bytes[offset + 42] });
  }
  return { sha256: sha256(bytes), width, height, blockWidth: view.getInt32(8, true), blockHeight: view.getInt32(12, true), subTiles };
}

check('terrain and resource constants match original runtime INI and actual TMP asset headers', () => {
  proof.nativeTerrain = {};
  for (const [theater, iniName, archive, ext] of [['TEMPERATE', 'temperat.ini', 'isotemp.mix', 'tem'], ['SNOW', 'snow.ini', 'isosnow.mix', 'sno'], ['URBAN', 'urban.ini', 'isourb.mix', 'urb']]) {
    const iniEntry = mixEntry('ini.mix', iniName), ini = nativeIni(iniEntry.bytes.toString('latin1'));
    assert.equal(ini.get('General').get('ClearTile'), '0');
    const waterSet = Number(ini.get('General').get('WaterSet')); let start = 0;
    for (let i = 0; i < waterSet; i++) start += Number(ini.get('TileSet' + String(i).padStart(4, '0')).get('TilesInSet'));
    assert.equal(start, TERRAIN_TILES[theater].water);
    const clearEntry = mixEntry(archive, `clear01.${ext}`), waterEntry = mixEntry(archive, `water01.${ext}`);
    const clear = inspectTmp(clearEntry), water = inspectTmp(waterEntry);
    assert.equal(clear.width * clear.height, 1); assert.equal(clear.subTiles[0].terrainType, 13); assert.equal(clear.subTiles[0].height, 0);
    assert.equal(water.width * water.height, 4); assert.ok(water.subTiles.every(sub => sub.terrainType === 9 && sub.height === 0 && sub.rampType === 0));
    proof.nativeTerrain[theater] = { ini: iniName, iniSha256: sha256(iniEntry.bytes), iniArchiveSha256: iniEntry.archiveSha256,
      clearTile: 0, waterSet, waterTile: start, waterTilesInSet: Number(ini.get('TileSet0021').get('TilesInSet')),
      assetArchive: archive, assetArchiveSha256: waterEntry.archiveSha256, clear, water };
  }
  const rules = readFileSync(root + proof.sources.rules.path);
  proof.sources.rules.sha256 = sha256(rules);
  const registered = [...new Set(nativeIni(rules.toString('utf8')).get('OverlayTypes').values())];
  assert.equal(registered.indexOf('TIB01'), OVERLAY_IDS.ORE);
  assert.equal(registered.indexOf('GEM01'), OVERLAY_IDS.GEMS);
  assert.ok(source.includes('fl.minIdRiparius=102') && source.includes('fl.minIdCruentus=27'));
  assert.ok(source.includes('getBailCount(){return this.gameObject.value+1}') && source.includes('bD.maxBails=11'));
  proof.overlay = { oreId: 102, oreName: 'TIB01', gemsId: 27, gemsName: 'GEM01', emptyId: 255, fullResourceDataValue: 11,
    numbering: 'zero-based unique declaration order, not the numeric INI key', source: proof.sources.rules.path };
});

after(() => {
  proof.status = proof.tests.failed.length ? 'failed' : 'passed';
  writeFileSync(new URL('./codec-proof.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n');
});
