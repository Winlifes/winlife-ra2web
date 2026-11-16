#!/usr/bin/env node
/**
 * Build a bounded, attributed map archive and a conservative native-map index.
 * Originals are copied byte for byte; map-codec is used only for reading.
 * Run from any directory: node deploy/ra2web-lan/map-library/build-catalog.mjs
 * Optional: --input <source-directory> --output <artifact-directory>
 *           --engine <unpacked-native-release-directory>
 */
import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditNativeRuleReaders, dormantTypeOverrides, inactiveEditorMetadata, cleanDormantOverrides, readRootZipEntry } from './native-rule-audit.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), '../../..');
const DEFAULT_SOURCE = join(ROOT, 'vendor/platform-maps-20261112');
const DEFAULT_OUTPUT = join(ROOT, 'vendor/platform-map-library-20261112');
const DEFAULT_ENGINE = join(ROOT, 'vendor/ra2web-lan-0.87.3-20261112-net2-r1');
const CODEC = resolve(dirname(SCRIPT), '../map-editor/map-codec.mjs');
const TRIGGER_CHECK = join(dirname(SCRIPT), 'native-trigger-check.mjs');
const THEATERS = {
  TEMPERATE: { ini: 'temperat.ini', iso: 'isotemp.mix', archives: ['isotemp.mix','temperat.mix','tem.mix'], extension: 'tem' },
  SNOW: { ini: 'snow.ini', iso: 'isosnow.mix', archives: ['isosnow.mix','snow.mix','sno.mix'], extension: 'sno' },
  URBAN: { ini: 'urban.ini', iso: 'isourb.mix', archives: ['isourb.mix','urb.mix','urban.mix'], extension: 'urb' },
};
const REGISTRIES = {
  Infantry: 'InfantryTypes', Units: 'VehicleTypes', Aircraft: 'AircraftTypes',
  Structures: 'BuildingTypes', Terrain: 'TerrainTypes', Smudge: 'SmudgeTypes',
};
const TYPE_TABLES = [...Object.values(REGISTRIES), 'OverlayTypes', 'Animations',
  'Warheads', 'SuperWeaponTypes', 'WeaponTypes', 'VoxelAnims', 'Particles', 'ParticleSystems'];
const MAP_SECTIONS = new Set([
  'BASIC', 'MAP', 'ISOMAPPACK5', 'OVERLAYPACK', 'OVERLAYDATAPACK', 'PREVIEW', 'PREVIEWPACK',
  'WAYPOINTS', 'TERRAIN', 'SMUDGE', 'STRUCTURES', 'UNITS', 'INFANTRY', 'AIRCRAFT',
  'LIGHTING', 'SPECIALFLAGS', 'DIGEST', 'HEADER', 'RANKING', 'HOUSES', 'COUNTRIES',
  'TAGS', 'TRIGGERS', 'ACTIONS', 'EVENTS', 'CELLTAGS', 'VARIABLENAMES', 'VARIABLES',
  'LOCALVARIABLES', 'GLOBALVARIABLES', 'TASKFORCES', 'SCRIPTTYPES', 'TEAMTYPES',
  'AITRIGGERTYPES', 'AITRIGGERTYPESENABLE', 'TUBES', 'TUBE', 'TUTORIAL',
  'FORCEDOPTIONS', 'MULTIPLAYERDIALOGSETTINGS', 'FINALALERT', 'FA2SP',
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = path => path.split(sep).join('/');
const describePath = path => slash(relative(ROOT, path));
const sorted = values => [...new Set(values)].sort();
const hex32 = value => (value >>> 0).toString(16).padStart(8, '0');

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function mixId(name) {
  const bytes = Buffer.from(name.toUpperCase(), 'ascii'), remainder = bytes.length & 3;
  if (!remainder) return crc32(bytes);
  return crc32(Buffer.concat([bytes, Buffer.from([remainder]),
    Buffer.alloc(3 - remainder, bytes[bytes.length & ~3])]));
}
function readMix(bytes, label) {
  if (bytes.length < 6) throw new Error(`Truncated MIX: ${label}`);
  const flags = bytes.readUInt32LE(0);
  const header = (flags & ~0x30000) === 0 ? 4 : 0;
  if (header && flags & 0x20000) throw new Error(`Encrypted native MIX is unsupported: ${label}`);
  const count = bytes.readUInt16LE(header), body = header + 6 + count * 12;
  if (body > bytes.length) throw new Error(`Invalid MIX index: ${label}`);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const at = header + 6 + i * 12, hash = bytes.readUInt32LE(at);
    const offset = bytes.readUInt32LE(at + 4), size = bytes.readUInt32LE(at + 8);
    if (body + offset + size > bytes.length) throw new Error(`MIX entry exceeds archive: ${label}`);
    entries.set(hash, bytes.subarray(body + offset, body + offset + size));
  }
  return { get: name => entries.get(mixId(name)), count: entries.size };
}
function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}
function entry(line) {
  if (/^\s*[;#]/.test(line)) return null;
  const match = line.match(/^([^=]+)=(.*)$/);
  if (!match) return null;
  const clean = raw => {
    raw = raw.trim();
    if (raw.length > 1 && ['"', "'"].includes(raw[0]) && raw.at(-1) === raw[0]) return raw.slice(1, -1);
    let escaped = false, result = '';
    for (const char of raw) {
      if (escaped) { result += '\\;#'.includes(char) ? char : `\\${char}`; escaped = false; }
      else if (char === ';') break;
      else if (char === '\\') escaped = true;
      else result += char;
    }
    return (result + (escaped ? '\\' : '')).trim();
  };
  return [clean(match[1]).toUpperCase(), clean(match[2])];
}
export function parseIniSections(text) {
  const sections = new Map();
  let current;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*(?:(?:\/\/|;|#).*)?$/);
    if (match) {
      const name = match[1].trim().toUpperCase();
      if (!sections.has(name)) sections.set(name, new Map());
      current = sections.get(name);
    } else if (current) {
      const pair = entry(line);
      if (pair) current.set(...pair);
    }
  }
  return sections;
}
const section = (ini, name) => ini.get(name.toUpperCase()) ?? new Map();
const value = (ini, name, key, fallback = '') => section(ini, name).get(key.toUpperCase()) ?? fallback;
function mergeIni(base, overlay) {
  const merged = new Map([...base].map(([name, values]) => [name, new Map(values)]));
  for (const [name, values] of overlay) {
    if (!merged.has(name)) merged.set(name, new Map());
    for (const [key, val] of values) merged.get(name).set(key, val);
  }
  return merged;
}
function confined(root, path) {
  const target = resolve(root, path), rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(target) === resolve(root)) throw new Error(`Source path escapes its root: ${path}`);
  return target;
}
async function jsonWrite(path, object) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(object, null, 2) + '\n');
  await rename(temporary, path);
}
function fileEvidence(path, bytes) {
  return { path: describePath(path), bytes: bytes.length, sha256: sha256(bytes) };
}

export async function loadNativeResources(engine = DEFAULT_ENGINE, {localForcedModArchive} = {}) {
  const resourceRoot = join(engine, 'game-resources'), overlayRoot = join(engine, 'res/overlay');
  const paths = [join(resourceRoot, 'ini.mix'), join(overlayRoot, 'rules.ini'), join(overlayRoot, 'art.ini'),
    ...Object.values(THEATERS).flatMap(theater => theater.archives.map(name => join(resourceRoot, name)))];
  const payloads = await Promise.all(paths.map(path => readFile(path)));
  const evidence = payloads.map((bytes, i) => fileEvidence(paths[i], bytes));
  const iniMix = readMix(payloads[0], 'ini.mix');
  const getIni = name => {
    const bytes = iniMix.get(name);
    if (!bytes) throw new Error(`Native ini.mix is missing ${name}`);
    evidence.push({ container: describePath(paths[0]), entry: name, bytes: bytes.length, sha256: sha256(bytes) });
    return parseIniSections(decodeText(bytes));
  };
  const rules = mergeIni(getIni('rules.ini'), parseIniSections(decodeText(payloads[1])));
  const art = mergeIni(getIni('art.ini'), parseIniSections(decodeText(payloads[2])));
  const registries = Object.fromEntries(Object.entries(REGISTRIES).map(([kind, name]) =>
    [kind, new Set([...section(rules, name).values()].map(name => name.toUpperCase()))]));
  const overlays = [...section(rules, 'OverlayTypes').values()].map(name => name.toUpperCase());
  const theaters = {};
  let archiveNumber = 3;
  for (const [name, spec] of Object.entries(THEATERS)) {
    const ini = getIni(spec.ini), archives = spec.archives.map(file => ({name:file,archive:readMix(payloads[archiveNumber++],file)}));
    const tiles = [];
    for (let set = 0; ; set++) {
      const setName = `TILESET${String(set).padStart(4, '0')}`;
      if (!ini.has(setName)) break;
      const count = Number(value(ini, setName, 'TilesInSet', '0'));
      if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error(`Invalid native tile count: ${name} ${setName}`);
      const prefix = value(ini, setName, 'FileName');
      for (let index = 1; index <= count; index++) {
        const file = `${prefix}${String(index).padStart(2, '0')}.${spec.extension}`;
        const source = archives.map(source=>({...source,bytes:source.archive.get(file)})).find(source=>source.bytes);
        const bytes = source?.bytes, tile = { id: tiles.length, set, file, present: !!bytes, ...(source?{archive:source.name}:{}) };
        if (bytes) {
          if (bytes.length < 16) throw new Error(`Truncated native TMP ${file}`);
          tile.width = bytes.readInt32LE(0); tile.height = bytes.readInt32LE(4);
          const slots = tile.width * tile.height;
          if (tile.width < 1 || tile.height < 1 || slots > 1024 || 16 + slots * 4 > bytes.length) throw new Error(`Invalid native TMP ${file}`);
          tile.subtiles = Array.from({ length: slots }, (_, i) => {
            const offset = bytes.readUInt32LE(16 + i * 4);
            return offset > 0 && offset + 43 <= bytes.length;
          });
        }
        tiles.push(tile);
      }
    }
    if (!tiles.length || !tiles[0].present) throw new Error(`Native clear tile missing for ${name}`);
    theaters[name] = { tiles, maxTile: tiles.length - 1, presentTiles: tiles.filter(tile => tile.present).length,
      missingTileIds: tiles.filter(tile => !tile.present).map(tile => tile.id), ini: spec.ini, archive: spec.iso, archives: spec.archives };
  }
  const ruleKeys = new Set([...rules.values()].flatMap(entries => [...entries.keys()]));
  const appPath=join(engine,'js/app.js'),appBytes=await readFile(appPath),reader=auditNativeRuleReaders(appBytes.toString('utf8'));
  evidence.push(fileEvidence(appPath,appBytes));
  for(const key of reader.propertyKeys)ruleKeys.add(key);
  let activeModRules=new Map(),activeModObjectTypes=[],activeModAudit={complete:true,id:null};
  const configPath=join(engine,'config.json'),config=JSON.parse(await readFile(configPath,'utf8'));
  if(config.forcedModId){
    const mods=JSON.parse(await readFile(join(engine,'mods.json'),'utf8')),mod=mods.mods.find(mod=>mod.id===config.forcedModId);
    if(!mod?.download)throw new Error('Cannot audit forced mod '+config.forcedModId);
    const pathname=new URL(mod.download,'https://local.invalid/').pathname;
    if(!localForcedModArchive&&(!pathname.startsWith('/mod/')||!pathname.endsWith('.zip')))throw new Error('Forced mod must be a packaged local ZIP');
    const localPath=localForcedModArchive??decodeURIComponent(pathname.slice(1));
    if(localForcedModArchive&&localPath!=='mod/'+pathname.split('/').at(-1))throw new Error('Forced mod mirror must match its advertised filename');
    const file=confined(engine,localPath),bytes=await readFile(file),iniBytes=readRootZipEntry(bytes,'rules.ini',crc32);
    activeModRules=parseIniSections(decodeText(iniBytes));
    activeModObjectTypes=sorted(TYPE_TABLES.flatMap(name=>[...section(activeModRules,name).values()]).filter(Boolean));
    activeModAudit={complete:true,id:config.forcedModId,archive:fileEvidence(file,bytes),rulesSha256:sha256(iniBytes)};
  }
  return { rules, art, ruleKeys, registries, overlays, theaters, evidence, ruleReaderEvidence:reader.evidence,activeModRules,activeModObjectTypes,activeModAudit };
}

function mapObjects(ini) {
  const objects = {};
  for (const kind of Object.keys(REGISTRIES)) {
    objects[kind] = [];
    for (const [key, raw] of section(ini, kind)) {
      const fields = raw.split(',').map(part => part.trim());
      if (kind === 'Terrain') objects[kind].push({ key, id: fields[0].toUpperCase(), rx: Number(key) % 1000, ry: Math.floor(Number(key) / 1000) });
      else if (kind === 'Smudge') objects[kind].push({ key, id: fields[0].toUpperCase(), rx: Number(fields[1]), ry: Number(fields[2]) });
      else objects[kind].push({ key, id: (fields[1] ?? '').toUpperCase(), rx: Number(fields[3]), ry: Number(fields[4]) });
    }
  }
  return objects;
}
function modeNeedsAdditionalRules(text) {
  const ini = parseIniSections(text);
  return [...ini].some(([name, entries]) => [...entries].some(([key]) => name !== 'SETTINGS' || key !== 'RA2MODE'));
}

function inspectionIsClear(result) {
  const failureFields = ['unknownActionTypes', 'unknownEventTypes', 'unknownActions', 'unknownEvents',
    'unimplementedActionTypes', 'unimplementedEventTypes', 'unsupportedMultiplayerActionTypes',
    'unsupportedMultiplayerEventTypes', 'parseErrors', 'unsupportedSections'];
  return result?.supported === true && failureFields.every(key => {
    const field = result[key];
    return field == null || (Array.isArray(field) ? field.length === 0 : field instanceof Set ? field.size === 0 : false);
  });
}

export function createGameIndex(catalog) {
  return { schemaVersion: catalog.schemaVersion, limits: catalog.limits,
    maps: catalog.maps.filter(map => map.compatible && map.deduplication?.isRepresentative !== false).map(map => ({...Object.fromEntries(
      ['file', 'title', 'originalTitle', 'baseTitle', 'variantInfo', 'players', 'theater', 'author', 'source', 'sourceLabel', 'sha256', 'bytes']
        .map(key => [key, map[key]])),...(map.cleanedVersion?{file:map.cleanedVersion.file,sha256:map.cleanedVersion.sha256,bytes:map.cleanedVersion.bytes,originalFile:map.file,removedSections:map.cleanedVersion.removedSections}:{} )})) };
}

export function scanMapCompatibility({ text, sourceMap, native, codec, modeDependencies = [], triggerInspection = null }) {
  const ini = parseIniSections(text), reasons = new Map(), warnings = [];
  const fail = (code, message) => { if (!reasons.has(code)) reasons.set(code, message); };
  const scan = { checkVersion: 2, sourceKind: sourceMap.source.kind, gameModesNormalizedForIndex: ['standard'],
    scriptedSections: {}, objectTypes: {}, unknownObjectTypes: {}, invalidObjectCoordinates: [],
    registryOverrides: {}, unsupportedRuleProperties: {}, unknownSections: [], modeDependencies,
    spawns: [], invalidSpawns: [], duplicateSpawnNumbers: [], duplicateSpawnCoordinates: [],
    tile: {}, overlay: {}, codecWarnings: [], dormantTypeOverrides:[], editorMetadataSections:[] };
  if (sourceMap.source.kind !== 'multiplayer_map') fail('campaign_map', '战役地图需要专用任务入口');
  const theater = value(ini, 'Map', 'Theater').toUpperCase();
  if (!native.theaters[theater]) fail('unsupported_theater', `当前引擎缺少 ${theater || '未知'} 剧场资源`);
  for (const name of ['Tags', 'Triggers', 'Actions', 'Events', 'CellTags', 'VariableNames',
    'TaskForces', 'ScriptTypes', 'TeamTypes', 'AITriggerTypes', 'AITriggerTypesEnable']) {
    const count = section(ini, name).size;
    if (count) scan.scriptedSections[name] = count;
  }
  const triggerHandled = new Set((triggerInspection?.handledSections ?? []).map(name => name.toUpperCase()));
  const unhandledScriptSections = Object.keys(scan.scriptedSections).filter(name => !triggerHandled.has(name.toUpperCase()));
  const triggerGatePassed = inspectionIsClear(triggerInspection) && unhandledScriptSections.length === 0;
  scan.nativeTriggerInspection = triggerInspection ? { ...triggerInspection, gatePassed: triggerGatePassed, unhandledScriptSections } : null;
  if (Object.keys(scan.scriptedSections).length && !triggerGatePassed) fail('scripted_map', '包含尚未完成兼容验证的任务或防守脚本');
  for (const table of TYPE_TABLES) {
    if (section(ini, table).size) scan.registryOverrides[table] = [...section(ini, table).values()];
  }
  if (Object.keys(scan.registryOverrides).length) fail('type_registry_override', '地图重写了单位、建筑或其他类型注册表');
  if (section(ini, 'ForcedOptions').size || section(ini, 'MultiplayerDialogSettings').size) {
    fail('client_forced_options', '依赖来源平台的强制房间设置');
  }
  if (modeDependencies.some(dependency => dependency.requiredForStandard !== false)) fail('external_mode_rules', '依赖来源平台额外的游戏模式规则');
  const optionalModeRules = modeDependencies.filter(dependency => dependency.requiredForStandard === false);
  if (optionalModeRules.length) warnings.push('Source platform has optional mode/balance rules; this index registers the raw map with the current standard rules.');
  if (/^\s*(?:\$INCLUDE|#INCLUDE|INCLUDE)\s*=/im.test(text)) fail('external_include', '地图引用了未归档的外部配置');
  const objects = mapObjects(ini);
  for (const [kind, list] of Object.entries(objects)) {
    const ids = sorted(list.map(object => object.id)); scan.objectTypes[kind] = ids;
    const unknown = ids.filter(id => !native.registries[kind].has(id));
    if (unknown.length) scan.unknownObjectTypes[kind] = unknown;
  }
  if (Object.keys(scan.unknownObjectTypes).length) fail('unknown_placed_object', '放置了当前 RA2 资源没有注册的对象');
  // House sections share names with country rules, but IQ/Allies/Credits/etc.
  // are ordinary scenario-house fields rather than extension properties.
  const houseSections = new Set([...section(ini, 'Houses').values(), ...section(ini, 'Countries').values()]
    .map(name => name.trim().toUpperCase()));
  scan.houseSections = sorted(houseSections);
  const dormant=dormantTypeOverrides(ini,native);scan.dormantTypeOverrides=sorted(dormant);
  const editorMetadata=inactiveEditorMetadata(ini,native);scan.editorMetadataSections=sorted(editorMetadata);
  for (const [name, entries] of ini) {
    if (!entries.size || MAP_SECTIONS.has(name) || triggerHandled.has(name) || houseSections.has(name) || dormant.has(name) || editorMetadata.has(name)
      || TYPE_TABLES.some(table => table.toUpperCase() === name) || /^MULTI\d+$/.test(name)) continue;
    const baseline = native.rules.get(name);
    if (baseline) {
      // RA2 object properties are inherited across types; absence from this
      // particular baseline object is not evidence that the key is an extension.
      const unknownKeys = [...entries.keys()].filter(key => !native.ruleKeys.has(key));
      if (unknownKeys.length) scan.unsupportedRuleProperties[name] = unknownKeys;
      if (entries.has('IMAGE')) {
        const image = entries.get('IMAGE').toUpperCase();
        if (!native.art.has(image) && !native.rules.has(image)) fail('unknown_image_override', '地图指定了当前资源没有收录的图像');
      }
    } else scan.unknownSections.push(name);
  }
  if (Object.keys(scan.unsupportedRuleProperties).length) fail('unverified_rule_properties', '包含未在当前原生规则中出现的覆盖属性');
  if (scan.unknownSections.length) fail('unverified_custom_sections', '包含尚未核实的自定义配置段');
  let doc;
  try { doc = codec.parseMap(text); }
  catch (error) { fail('map_decode_failed', `地图解析失败：${error.message}`); scan.decodeError = error.message; }
  if (doc) {
    scan.codecWarnings = doc.warnings;
    const numbers = new Set(), coordinates = new Set();
    for (const point of doc.waypoints.filter(point => Number.isInteger(point.number) && point.number >= 0 && point.number <= 7).sort((a, b) => a.number - b.number)) {
      if (numbers.has(point.number)) { scan.duplicateSpawnNumbers.push(point.number); continue; }
      numbers.add(point.number);
      if (!Number.isInteger(point.rx) || !Number.isInteger(point.ry) || !codec.isPlayableCell(doc, point.rx, point.ry)) {
        scan.invalidSpawns.push(point); continue;
      }
      const key = `${point.rx},${point.ry}`;
      if (coordinates.has(key)) { scan.duplicateSpawnCoordinates.push(point); continue; }
      coordinates.add(key); scan.spawns.push(point);
    }
    if (scan.spawns.length < 2) fail('insufficient_valid_spawns', '有效的 0–7 号出生点少于两个');
    if (scan.invalidSpawns.length || scan.duplicateSpawnNumbers.length || scan.duplicateSpawnCoordinates.length) fail('invalid_spawns', '出生点存在越界或重复位置');
    for (const [kind, list] of Object.entries(objects)) for (const object of list) {
      if (!Number.isInteger(object.rx) || !Number.isInteger(object.ry) || !codec.tileAtCell(doc, object.rx, object.ry)) scan.invalidObjectCoordinates.push({ kind, ...object });
    }
    if (scan.invalidObjectCoordinates.length) fail('invalid_object_coordinates', '地图对象坐标不在有效地图范围内');
    const theaterRules = native.theaters[theater], badTileIds = new Set(), missingTileIds = new Set(), badSubtiles = new Set();
    let highestTile = 0, negativeTileCount = 0, highestElevation = 0;
    for (const tile of doc.tiles) {
      const number = Math.max(0, tile.tileNum); highestTile = Math.max(highestTile, number); highestElevation = Math.max(highestElevation, tile.z);
      if (tile.tileNum < 0) negativeTileCount++;
      if (!theaterRules) continue;
      const nativeTile = theaterRules.tiles[number];
      if (!nativeTile) badTileIds.add(number);
      else if (!nativeTile.present) missingTileIds.add(number);
      else if (!nativeTile.subtiles[tile.subTile]) badSubtiles.add(`${number}:${tile.subTile}`);
    }
    // Xg records the maximum even for encoded cells it later discards as
    // outside the map rectangle, so include that maximum in the range gate.
    const packedTiles = codec.decodePacked([...section(ini, 'IsoMapPack5').values()].join(''), 5);
    const packedView = new DataView(packedTiles.buffer, packedTiles.byteOffset, packedTiles.byteLength);
    let encodedMaxTile = 0;
    for (let i = 0; i < Math.min(doc.tiles.length, Math.floor(packedTiles.length / 11)); i++) {
      const id = Math.max(0, packedView.getInt16(i * 11 + 4, true));
      encodedMaxTile = Math.max(encodedMaxTile, id);
      if (theaterRules && id > theaterRules.maxTile) badTileIds.add(id);
    }
    scan.tile = { count: doc.tiles.length, maxTile: highestTile, encodedMaxTile, nativeMaxTile: theaterRules?.maxTile ?? null,
      negativeTileCount, negativeTileBehavior: 'Native Xg.readTiles clamps negative tile IDs to 0; original bytes remain unchanged.',
      highestElevation, outOfRangeIds: sorted(badTileIds), missingNativeFileIds: sorted(missingTileIds), invalidSubtiles: sorted(badSubtiles) };
    if (badTileIds.size) fail('tile_out_of_range', '地图瓦片编号超出当前剧场资源范围');
    if (missingTileIds.size) fail('tile_resource_missing', '地图使用了当前资源中不存在的瓦片文件');
    if (badSubtiles.size) fail('subtile_unavailable', '地图使用了不存在的瓦片子块');
    if (highestElevation > 14) fail('unverified_elevation', '地图高度超出当前已验证的编辑范围');
    const badOverlayIds = new Set(), onMapOverlayIds = new Set();
    let onMapOverlays = 0, offMapOverlays = 0;
    for (const overlay of doc.overlays.values()) {
      if (!codec.tileAtCell(doc, overlay.rx, overlay.ry)) { offMapOverlays++; continue; }
      onMapOverlays++; onMapOverlayIds.add(overlay.id);
      if (!native.overlays[overlay.id]) badOverlayIds.add(overlay.id);
    }
    scan.overlay = { count: onMapOverlays, ignoredOutsideMap: offMapOverlays, ids: sorted(onMapOverlayIds),
      nativeCount: native.overlays.length, nativeMaxId: native.overlays.length - 1, invalidIds: sorted(badOverlayIds) };
    if (badOverlayIds.size) fail('overlay_out_of_range', '地图覆盖物编号超出当前 RA2 资源范围');
    if (onMapOverlays && (!section(ini, 'OverlayPack').size || !section(ini, 'OverlayDataPack').size)) fail('incomplete_overlay_pair', '覆盖物图层缺少配对数据');
    if (doc.warnings.length) warnings.push(...doc.warnings);
  }
  scan.players = scan.spawns.length;
  scan.compatible = reasons.size === 0;
  scan.reasonCodes = [...reasons.keys()]; scan.reasons = [...reasons.values()]; scan.warnings = warnings;
  return scan;
}

export async function buildCatalog({ input = DEFAULT_SOURCE, output = DEFAULT_OUTPUT, engine = DEFAULT_ENGINE } = {}) {
  input = resolve(input); output = resolve(output); engine = resolve(engine);
  const [manifestBytes, channelsBytes, codecBytes, native] = await Promise.all([
    readFile(join(input, 'manifest.json')), readFile(join(input, 'source-channels.json')), readFile(CODEC), loadNativeResources(engine),
  ]);
  const manifest = JSON.parse(manifestBytes), channels = JSON.parse(channelsBytes), codecHash = sha256(codecBytes);
  if (!Array.isArray(manifest.maps) || !manifest.maps.length || manifest.maps.length > 10000) throw new Error('Invalid source map manifest');
  const codec = await import(pathToFileURL(CODEC).href + `?source=${codecHash}`);
  let triggerInspector = null, triggerSource = null;
  const triggerEvidence = { enabled: false, path: describePath(TRIGGER_CHECK) };
  try {
    const [helperBytes, appBytes] = await Promise.all([readFile(TRIGGER_CHECK), readFile(join(engine, 'js/app.js'))]);
    const helperHash = sha256(helperBytes), helper = await import(pathToFileURL(TRIGGER_CHECK).href + `?source=${helperHash}`);
    if (typeof helper.inspectTriggers !== 'function') throw new Error('native-trigger-check does not export inspectTriggers');
    triggerInspector = helper.inspectTriggers; triggerSource = appBytes.toString('utf8');
    Object.assign(triggerEvidence, { enabled: true, sha256: helperHash, engineSource: fileEvidence(join(engine, 'js/app.js'), appBytes) });
  } catch (error) {
    triggerEvidence.reason = error.code === 'ENOENT' ? 'Native trigger checker not present; nonempty scripts remain archived.' : error.message;
  }
  const generatedAt = new Date().toISOString(), maps = [], scans = [], files = new Set();
  await Promise.all([mkdir(join(output, 'maps/files'), { recursive: true }), mkdir(join(output, 'maps/previews'), { recursive: true })]);
  for (const sourceMap of manifest.maps) {
    const sourcePath = confined(input, sourceMap.relative_path), bytes = await readFile(sourcePath), digest = sha256(bytes);
    if (digest !== sourceMap.sha256 || bytes.length !== sourceMap.size_bytes) throw new Error(`Source integrity mismatch: ${sourceMap.relative_path}`);
    const source = sourceMap.source.platform === 'CnCNet' ? 'cncnet' : 'xwis-ziip';
    const slug = source.replace(/-/g, '_'), file = `wl_${slug}_${digest.slice(0, 24)}.map`;
    if (files.has(file) || !/^wl_[a-z0-9_]+\.map$/.test(file)) throw new Error(`Duplicate or invalid output file: ${file}`);
    files.add(file);
    await writeFile(join(output, 'maps/files', file), bytes);
    let preview = null, previewSha256 = null, previewFormat = null;
    if (sourceMap.preview_relative_path) {
      const png = await readFile(confined(input, sourceMap.preview_relative_path));
      previewFormat = png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
        : png[0] === 255 && png[1] === 216 && png[2] === 255 ? 'jpg' : null;
      if (!previewFormat) throw new Error(`Unsupported source preview signature: ${sourceMap.preview_relative_path}`);
      const previewName = file.replace(/\.map$/, `.${previewFormat}`);
      await writeFile(join(output, 'maps/previews', previewName), png);
      preview = `/maps/previews/${previewName}`; previewSha256 = sha256(png);
    }
    const modeDependencies = [];
    for (const dependency of sourceMap.compatibility_evidence?.map_code_dependencies ?? []) {
      const data = await readFile(confined(input, dependency.map_code_ini));
      if (modeNeedsAdditionalRules(decodeText(data))) modeDependencies.push({ mode: dependency.game_mode,
        sourcePath: dependency.map_code_ini, bytes: data.length, sha256: sha256(data),
        requiredForStandard: /^(?:Blitz(?: 2v2)?|Survival|Mod Maps)$/i.test(dependency.game_mode) });
    }
    const text = decodeText(bytes);
    let triggerInspection = null;
    if (triggerInspector) {
      try { triggerInspection = await triggerInspector(text, triggerSource); }
      catch (error) { triggerInspection = { supported: false, parseErrors: [error.message], handledSections: [] }; }
    }
    const scan = scanMapCompatibility({ text, sourceMap, native, codec, modeDependencies, triggerInspection });
    const cleanup=cleanDormantOverrides(bytes,parseIniSections(text),native);
    let cleanedVersion=null;
    if(cleanup){
      const cleanedText=decodeText(cleanup.bytes),cleanIni=parseIniSections(cleanedText),originalIni=parseIniSections(text);
      for(const removed of cleanup.removedSections)originalIni.delete(removed);
      const entries=ini=>[...ini].map(([name,values])=>[name,[...values]]);
      if(JSON.stringify(entries(originalIni))!==JSON.stringify(entries(cleanIni)))throw new Error('Cleanup changed unrelated map sections: '+file);
      // Rescan the actual bytes which players will receive, including the
      // original native trigger parser, rather than copying an approval flag.
      const cleanedScan=scanMapCompatibility({text:cleanedText,sourceMap,native,codec,modeDependencies,triggerInspection:triggerInspector?.(cleanedText,triggerSource)});
      if(JSON.stringify(cleanedScan.reasonCodes)!==JSON.stringify(scan.reasonCodes)||JSON.stringify(cleanedScan.tile)!==JSON.stringify(scan.tile)||JSON.stringify(cleanedScan.spawns)!==JSON.stringify(scan.spawns)||JSON.stringify(cleanedScan.objectTypes)!==JSON.stringify(scan.objectTypes))throw new Error('Cleanup changed map behavior or compatibility: '+file);
      const cleanedFile=`wl_clean_${digest.slice(0,12)}_${cleanup.sha256.slice(0,12)}.map`;
      if(files.has(cleanedFile))throw new Error('Duplicate cleaned map filename');
      files.add(cleanedFile);
      await writeFile(join(output,'maps/files',cleanedFile),cleanup.bytes);
      const auditName=cleanedFile.replace(/\.map$/,'.json');
      cleanedVersion={file:cleanedFile,sha256:cleanup.sha256,bytes:cleanup.bytes.length,crc32:crc32(cleanup.bytes),removedSections:cleanup.removedSections,method:cleanup.method,auditUrl:'/maps/cleanup/'+auditName};
      await jsonWrite(join(output,'maps/cleanup',auditName),{schemaVersion:1,originalFile:file,originalSha256:digest,cleanedVersion,removedSpans:cleanup.removedSpans,originalBytesPreserved:true,unremovedSectionsByteIdentical:true,rescanCompatible:cleanedScan.compatible,reasonCodes:cleanedScan.reasonCodes});
    }
    const checksum = crc32(bytes);
    const record = { file, title: sourceMap.name, players: scan.players, declaredPlayers: sourceMap.max_players,
      author: sourceMap.author || sourceMap.source.author || 'Unknown', source,
      sourceLabel: source === 'cncnet' ? 'CnCNet 官方地图包' : 'XWIS 作者地图包',
      sourcePage: sourceMap.source.source_page || sourceMap.source.repository,
      sourceUrl: sourceMap.source.original_download_url, sourcePath: sourceMap.source.source_path || sourceMap.source.archive_member,
      sourceCommit: sourceMap.source.commit || null, originalFilename: sourceMap.filename,
      sourceKind: sourceMap.source.kind, sourceGameVersion: sourceMap.game_version,
      theater: sourceMap.theater, sha256: digest, bytes: bytes.length, crc32: checksum, crc32Hex: hex32(checksum),
      preview, previewSha256, previewFormat, previewOriginalPath: sourceMap.preview_relative_path,
      previewBytesPreserved: !!preview, compatible: scan.compatible, reasons: scan.reasons, reasonCodes: scan.reasonCodes,
      gameModes: ['standard'], originalGameModes: sourceMap.game_modes,
      compatibility: 'conservative-static-scan', compatibilityCheckVersion:2, runtimeVerified: false,
      dormantTypeOverrides:scan.dormantTypeOverrides, editorMetadataSections:scan.editorMetadataSections,cleanedVersion };
    maps.push(record); scans.push({ file, sha256: digest, sourcePath: sourceMap.relative_path, ...scan });
  }
  if (sha256(await readFile(CODEC)) !== codecHash) throw new Error('map-codec changed during the build; rerun with the stable codec');
  if (triggerEvidence.enabled && sha256(await readFile(TRIGGER_CHECK)) !== triggerEvidence.sha256) throw new Error('native-trigger-check changed during the build; rerun with the stable checker');
  const compatibleCount = maps.filter(map => map.compatible).length;
  const catalog = { schemaVersion: 1, generatedAt, total: maps.length, compatibleCount,
    limits: { combatants: 16 }, maps };
  const gameIndex = createGameIndex(catalog);
  const reasonCounts = {};
  for (const scan of scans) for (const code of scan.reasonCodes) reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
  const theaterSummary = Object.fromEntries(Object.entries(native.theaters).map(([name, theater]) => [name,
    { maxTile: theater.maxTile, tileCount: theater.tiles.length, presentTiles: theater.presentTiles,
      missingTileIds: theater.missingTileIds, ini: theater.ini, archive: theater.archive, archives:theater.archives }]));
  const report = { schemaVersion: 1, generatedAt, total: maps.length, compatibleCount, archiveOnlyCount: maps.length - compatibleCount,
    reasonCounts, nativeResources: native.evidence, codec: { path: describePath(CODEC), sha256: codecHash }, nativeTriggerChecker: triggerEvidence,
    nativeRuleAudit:native.ruleReaderEvidence,activeModAudit:native.activeModAudit,
    nativeTheaters: theaterSummary, nativeOverlayCount: native.overlays.length, nativeOverlays: native.overlays,
    nativeObjectCounts: Object.fromEntries(Object.entries(native.registries).map(([name, ids]) => [name, ids.size])),
    checksumDefinition: 'crc32 is unsigned IEEE CRC-32 of the original map bytes, identical to zlib.crc32; it is not a claim about a multiplayer protocol checksum.',
    playerDefinition: 'Only unique, in-bounds and playable legacy Waypoints 0 through 7 are counted. Official MaxPlayers is retained for audit and is never used for registration.',
    policy: ['Archive every source map byte for byte, regardless of compatibility.',
      'Allow only TEMPERATE, SNOW and URBAN with real native TMP files and valid subtiles.',
      'Allow scripts only when the exact native parser/handler checker reports full support, no unknown or unimplemented IDs, no parse errors, and every script section handled. Otherwise archive them.',
      'Reject custom registries, unknown placed IDs, unverified rule properties/sections, and required external client mode rules.',
      'Use the complete three-archive native theater stack, including bridge and rubble TMP assets in the auxiliary theater MIX.',
      'Accept additional rule properties only when the shipped native object INI reader contains a literal getter.',
      'Preserve every original map. For known cross-game overrides unregistered in base/forced mod/map and unreachable from any retained section, publish a separately hashed cleaned version; the game uses it after a second complete scan.',
      'Native Xg.readOverlays only consumes cells in the map rectangle; off-map overlay bytes are recorded and ignored.',
      'compatible means this conservative static scan passed; no source map is claimed to have passed a runtime match.',
      'limits.combatants=16 is index metadata requested for the pending engine build, not a deployment or runtime verification.'],
    limitations: ['No complete script interpreter compatibility is claimed; native handler presence is static evidence, not a complete scenario outcome test.', 'Native registry presence does not prove every gameplay behavior.',
      'Overlay frame data and gameplay balance require runtime checking.'], scans };
  const sources = { schemaVersion: 1, generatedAt, sourceManifest: fileEvidence(join(input, 'manifest.json'), manifestBytes),
    sourceChannels: channels, sourceMapCount: maps.length, archivedMapBytes: maps.reduce((sum, map) => sum + map.bytes, 0),
    originalBytesPreserved: true, uniqueSha256Count: new Set(maps.map(map => map.sha256)).size,
    cleanedMapCount:maps.filter(map=>map.cleanedVersion).length,compatibleCleanedMapCount:maps.filter(map=>map.compatible&&map.cleanedVersion).length,
    previewCount: maps.filter(map => map.preview).length, sourceLicense: 'sources/cncnet-package-LICENSE.md',
    attribution: 'Map author, platform, original source/download URLs, source paths, commits, hashes and file names are retained in maps/catalog.json. Per-map license grants were not separately verified.' };
  await mkdir(join(output, 'sources'), { recursive: true });
  await copyFile(join(input, 'cncnet-yr-client-package/package/LICENSE.md'), join(output, sources.sourceLicense));
  await jsonWrite(join(output, 'maps/catalog.json'), catalog);
  await jsonWrite(join(output, 'maps/game-index.json'), gameIndex);
  await jsonWrite(join(output, 'compatibility-report.json'), report);
  await jsonWrite(join(output, 'sources.json'), sources);
  const copiedFailures = [];
  for (const map of maps) {
    const bytes = await readFile(join(output, 'maps/files', map.file));
    if (sha256(bytes) !== map.sha256 || bytes.length !== map.bytes || crc32(bytes) !== map.crc32) copiedFailures.push(map.file);
    if(map.cleanedVersion){const clean=map.cleanedVersion,data=await readFile(join(output,'maps/files',clean.file));if(sha256(data)!==clean.sha256||data.length!==clean.bytes||crc32(data)!==clean.crc32)copiedFailures.push(clean.file);}
  }
  if (copiedFailures.length) throw new Error(`Archive integrity failed for ${copiedFailures.length} maps`);
  await jsonWrite(join(output, 'verification.json'), { generatedAt, archiveFilesChecked: maps.length,
    originalBytesVerified: maps.length, crc32FilesChecked: maps.length, uniqueFilenames: files.size, fileNameWhitelistPassed: true,
    catalogCompatibleCountMatches: catalog.maps.filter(map => map.compatible).length === compatibleCount,
    gameIndexCount: gameIndex.maps.length, gameIndexBytes: (await readFile(join(output, 'maps/game-index.json'))).length,
    gameIndexOnlyCompatible: gameIndex.maps.every(map => maps.some(original => (original.cleanedVersion?.file??original.file) === map.file && original.compatible)),
    cleanedMapsVerified:sources.cleanedMapCount,compatibleCleanedMapCount:sources.compatibleCleanedMapCount,
    gameIndexSha256: sha256(await readFile(join(output, 'maps/game-index.json'))),
    previewCount: sources.previewCount, catalogSha256: sha256(await readFile(join(output, 'maps/catalog.json'))),
    productionDeployed: false });
  console.log(JSON.stringify({ output: describePath(output), total: maps.length, compatibleCount,
    archiveOnlyCount: maps.length - compatibleCount, previews: sources.previewCount, reasonCounts }, null, 2));
  return { catalog, report, sources };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = { '--input': 'input', '--output': 'output', '--engine': 'engine' }[process.argv[i]];
    if (!key || !process.argv[i + 1]) throw new Error('Usage: build-catalog.mjs [--input DIR] [--output DIR] [--engine DIR]');
    options[key] = process.argv[i + 1];
  }
  await buildCatalog(options);
}
