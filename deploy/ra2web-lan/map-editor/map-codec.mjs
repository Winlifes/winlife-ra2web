/**
 * Dependency-free RA2 / Yuri's Revenge map I/O for the LAN map editor.
 *
 * Format and codec source: the locally distributed Chrono Divide / RA2WEB
 * 0.87.3 client, vendor/ra2web-lan-0.87.3-20261112-net2-r1/js/app.js.
 * Adapted from MapFile (Xg), PackedSection (ay), MiniLzo (rX/qS), and
 * Format80 (xTe), retaining the original LZO literal-store representation.
 * Unlike that client's decoders, these decoders check input, output and
 * lookbehind bounds so malformed imports cannot hang the editor.
 * Terrain constants are verified against this release's original ini.mix,
 * isotemp.mix and isosnow.mix; see codec-proof.json for hashes and evidence.
 * Game assets and the original client remain their respective owners' work.
 *
 * UI coordinates: tiles are ordered in (2 * width - 1) columns × height rows.
 * tileAtDisplay(doc, dx, row) uses that rectangular row, NOT tile.dy.
 * tile.dy is the engine's half-row: 2 * row + (dx & 1).
 * displayToCell(doc, dx, dy) takes the engine half-row and requires matching
 * parity. cellToDisplay returns { dx, dy, row }. For width 64, (64,64) becomes
 * { dx:63, dy:63, row:31 }; tileAtDisplay(doc,63,31) is that same cell.
 *
 * Main API: parseMap(text), serializeMap(document), createMap(options).
 * Edit document.metadata, tiles, spawns, overlays, terrain and structures,
 * or use the mutation helpers below. overlays is Map<ry * 512 + rx, overlay>;
 * terrain is Map<ry * 1000 + rx, terrain>; structures is Map<INI key, object>.
 * Persist local drafts as serializeMap(doc), then restore with parseMap().
 */

export const OVERLAY_IDS = Object.freeze({ EMPTY: 255, ORE: 102, GEMS: 27 });
export const TERRAIN_TILES = Object.freeze({
  TEMPERATE: Object.freeze({ clear: 0, water: 314, waterSubTiles: 4 }),
  SNOW: Object.freeze({ clear: 0, water: 314, waterSubTiles: 4 }),
  URBAN: Object.freeze({ clear: 0, water: 314, waterSubTiles: 4 }),
});
export const OVERLAY_GRID_SIZE = 512;
const OVERLAY_BYTES = OVERLAY_GRID_SIZE ** 2;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const THEATERS = new Set(['TEMPERATE', 'SNOW', 'URBAN', 'DESERT', 'NEWURBAN', 'LUNAR']);

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concatBytes(chunks, length = chunks.reduce((n, chunk) => n + chunk.length, 0)) {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export function base64ToBytes(text) {
  const value = String(text).replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid base64 map pack');
  }
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function bytesToBase64(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return globalThis.btoa(parts.join(''));
}

/** Complete LZO1X decoding, including matches used by third-party maps. */
export function decodeLzo1x(input, outputSize) {
  integer(outputSize, 0, 65535, 'LZO block output size');
  const out = new Uint8Array(outputSize);
  let ip = 0, op = 0;
  const read = () => {
    if (ip >= input.length) throw new Error('Truncated LZO input');
    return input[ip++];
  };
  const literals = count => {
    if (ip + count > input.length) throw new Error('Truncated LZO literal');
    if (op + count > out.length) throw new Error('LZO output overrun');
    out.set(input.subarray(ip, ip + count), op); ip += count; op += count;
  };
  const copy = (position, count) => {
    if (position < 0 || position >= op) throw new Error('Invalid LZO lookbehind');
    if (op + count > out.length) throw new Error('LZO output overrun');
    for (let i = 0; i < count; i++) out[op++] = out[position++];
  };
  const extended = base => {
    let length = base, next;
    while ((next = read()) === 0) length += 255;
    return length + next;
  };
  const finish = () => {
    if (op !== outputSize) throw new Error(`LZO output length ${op} does not match ${outputSize}`);
    if (ip !== input.length) throw new Error('Unexpected bytes after LZO end marker');
    return out;
  };
  const matches = initial => {
    let token = initial;
    for (;;) {
      let position, count;
      if (token >= 64) {
        position = op - 1 - ((token >> 2) & 7) - (read() << 3);
        count = (token >> 5) + 1;
      } else if (token >= 32) {
        count = token & 31;
        if (count === 0) count = extended(31);
        const low = read(), high = read();
        position = op - 1 - (low >> 2) - (high << 6); count += 2;
      } else if (token >= 16) {
        position = op - ((token & 8) << 11);
        count = token & 7;
        if (count === 0) count = extended(7);
        const low = read(), high = read();
        position -= (low >> 2) + (high << 6);
        if (position === op) return true;
        position -= 16384; count += 2;
      } else {
        position = op - 1 - (token >> 2) - (read() << 2); count = 2;
      }
      copy(position, count);
      const trailing = input[ip - 2] & 3;
      if (!trailing) return false;
      literals(trailing); token = read();
    }
  };
  let firstLiteralRun = false;
  if (input[0] > 17) {
    const count = read() - 17;
    literals(count);
    if (count < 4) { if (matches(read())) return finish(); }
    else firstLiteralRun = true;
  }
  for (;;) {
    if (!firstLiteralRun) {
      let token = read();
      if (token >= 16) { if (matches(token)) return finish(); continue; }
      if (token === 0) token = extended(15);
      literals(token + 3);
    }
    firstLiteralRun = false;
    const token = read();
    if (token < 16) {
      const position = op - 2049 - (token >> 2) - (read() << 2);
      copy(position, 3);
      const trailing = input[ip - 2] & 3;
      if (!trailing) continue;
      literals(trailing);
      if (matches(read())) return finish();
    } else if (matches(token)) return finish();
  }
}

/** Same legal literal-store LZO block as the release's qS.compress(). */
export function encodeLzo1xLiteral(input) {
  integer(input.length, 4, 238, 'LZO literal block length');
  const out = new Uint8Array(input.length + 4);
  out[0] = 17 + input.length; out.set(input, 1);
  out.set([17, 0, 0], input.length + 1);
  return out;
}

/** Westwood LCW / Format80: all five command forms, with overlapping copies. */
export function decodeFormat80(input, outputSize) {
  integer(outputSize, 0, 65535, 'Format80 block output size');
  const out = new Uint8Array(outputSize);
  let ip = 0, op = 0;
  const read = () => {
    if (ip >= input.length) throw new Error('Truncated Format80 input');
    return input[ip++];
  };
  const word = () => { const low = read(); return low | read() << 8; };
  const room = count => {
    if (op + count > out.length) throw new Error('Format80 output overrun');
  };
  const copy = (position, count) => {
    if (position < 0 || position >= op) throw new Error('Invalid Format80 lookbehind');
    room(count);
    for (let i = 0; i < count; i++) out[op++] = out[position++];
  };
  for (;;) {
    let token = read();
    if (!(token & 128)) {
      const offset = ((token & 15) << 8) | read();
      copy(op - offset, 3 + ((token & 112) >> 4));
    } else if (!(token & 64)) {
      const count = token & 63;
      if (!count) {
        if (op !== outputSize) throw new Error(`Format80 output length ${op} does not match ${outputSize}`);
        return out;
      }
      room(count);
      if (ip + count > input.length) throw new Error('Truncated Format80 literal');
      out.set(input.subarray(ip, ip + count), op); ip += count; op += count;
    } else if ((token &= 63) === 62) {
      const count = word(), value = read(); room(count);
      out.fill(value, op, op + count); op += count;
    } else if (token === 63) {
      const count = word(), position = word(); copy(position, count);
    } else {
      const position = word(); copy(position, token + 3);
    }
  }
}

/** Literal and repeated-byte commands keep empty overlay packs small. */
export function encodeFormat80(input) {
  const bytes = [];
  let i = 0;
  const runAt = start => {
    let end = start + 1;
    while (end < input.length && end - start < 32767 && input[end] === input[start]) end++;
    return end - start;
  };
  while (i < input.length) {
    const run = runAt(i);
    if (run >= 4) {
      bytes.push(254, run & 255, run >> 8, input[i]); i += run;
    } else {
      const start = i++;
      while (i < input.length && i - start < 63 && runAt(i) < 4) i++;
      bytes.push(128 | (i - start));
      for (let j = start; j < i; j++) bytes.push(input[j]);
    }
  }
  bytes.push(128);
  return Uint8Array.from(bytes);
}

export function decodePacked(input, format = 5, limit = MAX_UNPACKED_BYTES) {
  if (typeof input === 'string') input = base64ToBytes(input);
  if (format !== 5 && format !== 80) throw new Error(`Unsupported map pack format ${format}`);
  let ip = 0, size = 0;
  const chunks = [];
  while (ip < input.length) {
    if (ip + 4 > input.length) throw new Error('Truncated map pack block header');
    const storedSize = input[ip] | input[ip + 1] << 8;
    const rawSize = input[ip + 2] | input[ip + 3] << 8; ip += 4;
    if (!storedSize || !rawSize) {
      if (storedSize !== 0 || rawSize !== 0 || input.subarray(ip).some(v => v !== 0)) {
        throw new Error('Invalid map pack terminator');
      }
      break;
    }
    if (ip + storedSize > input.length) throw new Error('Truncated map pack block');
    if ((size += rawSize) > limit) throw new Error('Map pack exceeds decoded size limit');
    const block = input.subarray(ip, ip + storedSize); ip += storedSize;
    chunks.push(format === 80 ? decodeFormat80(block, rawSize) : decodeLzo1x(block, rawSize));
  }
  return concatBytes(chunks, size);
}

export function encodePacked(input, format = 5) {
  if (format !== 5 && format !== 80) throw new Error(`Unsupported map pack format ${format}`);
  if (format === 5 && input.length > 0 && input.length < 4) {
    throw new Error('A LZO map pack must have at least four bytes');
  }
  const chunks = [];
  for (let ip = 0; ip < input.length;) {
    let rawSize = Math.min(format === 80 ? 8192 : 238, input.length - ip);
    // Do not pad the last block: borrow bytes so the last LZO block has >=4.
    if (format === 5 && input.length - ip > rawSize && input.length - ip - rawSize < 4) {
      rawSize -= 4 - (input.length - ip - rawSize);
    }
    const raw = input.subarray(ip, ip + rawSize); ip += rawSize;
    const stored = format === 80 ? encodeFormat80(raw) : encodeLzo1xLiteral(raw);
    const chunk = new Uint8Array(stored.length + 4);
    chunk.set([stored.length & 255, stored.length >> 8, rawSize & 255, rawSize >> 8]);
    chunk.set(stored, 4); chunks.push(chunk);
  }
  return concatBytes(chunks);
}

// Keep original INI text blocks rather than rebuilding unknown rule/trigger
// sections. Parsing escapes follows the release's nA.unsafe() behavior.
function iniValue(raw) {
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
  let escaped = false, value = '';
  for (const char of raw) {
    if (escaped) { value += '\\;#'.includes(char) ? char : `\\${char}`; escaped = false; }
    else if (char === ';') break;
    else if (char === '\\') escaped = true;
    else value += char;
  }
  return (value + (escaped ? '\\' : '')).trim();
}

function iniEntry(line) {
  if (/^\s*[;#]/.test(line)) return null;
  const match = line.match(/^([^=]+)=(.*)$/);
  return match ? { key: iniValue(match[1]), value: iniValue(match[2]) } : null;
}

function parseIni(text) {
  const newline = text.includes('\r\n') ? '\r\n' : text.includes('\r') && !text.includes('\n') ? '\r' : '\n';
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const blocks = [{ name: null, header: '', lines: [] }];
  let block = blocks[0];
  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]*)\]\s*(?:(?:\/\/|;|#).*)?$/);
    if (match) {
      block = { name: iniValue(match[1]), header: line, lines: [] }; blocks.push(block);
    } else block.lines.push(line);
  }
  return { blocks, newline, bom: text.startsWith('\uFEFF') };
}

function sectionEntries(ini, name) {
  const entries = new Map();
  for (const block of ini.blocks) if (block.name === name) {
    for (const line of block.lines) { const entry = iniEntry(line); if (entry) entries.set(entry.key, entry.value); }
  }
  return entries;
}

function hasSection(ini, name) { return ini.blocks.some(block => block.name === name); }
function readIni(ini, section, key, fallback = '') { return sectionEntries(ini, section).get(key) ?? fallback; }
function safeIni(value) { return String(value).replace(/[\r\n\0]/g, ' ').replace(/\\/g, '\\\\').replace(/;/g, '\\;'); }

function writeIni(ini, name, key, value) {
  let target = ini.blocks.findLast(block => block.name === name);
  if (!target) { target = { name, header: `[${name}]`, lines: [] }; ini.blocks.push(target); }
  let replaced = false;
  for (const block of ini.blocks) if (block.name === name) {
    block.lines = block.lines.flatMap(line => {
      if (iniEntry(line)?.key !== key) return [line];
      if (value === undefined || replaced) return [];
      replaced = true; return [`${key}=${safeIni(value)}`];
    });
  }
  if (!replaced && value !== undefined) {
    let at = target.lines.length;
    while (at > 0 && target.lines[at - 1] === '') at--;
    target.lines.splice(at, 0, `${key}=${safeIni(value)}`);
  }
}

function writePacked(ini, name, bytes, format) {
  const encoded = bytesToBase64(encodePacked(bytes, format));
  const lines = [];
  for (let i = 0; i < encoded.length; i += 70) lines.push(`${i / 70 + 1}=${encoded.slice(i, i + 70)}`);
  const blocks = ini.blocks.filter(block => block.name === name);
  if (!blocks.length) ini.blocks.push({ name, header: `[${name}]`, lines: [...lines, ''] });
  else {
    blocks[0].lines = [...lines, ''];
    ini.blocks = ini.blocks.filter(block => block.name !== name || block === blocks[0]);
  }
}

function packedValues(ini, name) { return [...sectionEntries(ini, name).values()].join(''); }
function rect(raw, label) {
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n))) throw new Error(`Invalid [Map] ${label}`);
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}
function rectString(rectangle) { return [rectangle.x, rectangle.y, rectangle.width, rectangle.height].join(','); }
function validateDimensions(width, height) {
  integer(width, 1, 512, 'Map width'); integer(height, 1, 512, 'Map height');
  if (width + height > 512) throw new Error('Map width + height must not exceed the 512-cell overlay grid');
}

export function displayToCell(doc, dx, dy) {
  if (!Number.isInteger(dx) || !Number.isInteger(dy) || (dx & 1) !== (dy & 1)) return null;
  const width = doc.fullSize.width;
  return { rx: (dx + dy) / 2 + 1, ry: (dy - dx) / 2 + width };
}

export function cellToDisplay(doc, rx, ry) {
  const dx = rx - ry + doc.fullSize.width - 1, dy = rx + ry - doc.fullSize.width - 1;
  return { dx, dy, row: Math.floor(dy / 2) };
}

export function tileAtDisplay(doc, dx, row) {
  if (!Number.isInteger(dx) || !Number.isInteger(row) || dx < 0 || row < 0 || dx >= 2 * doc.fullSize.width - 1 || row >= doc.fullSize.height) return undefined;
  return doc.tiles[row * (2 * doc.fullSize.width - 1) + dx];
}

export function tileAtCell(doc, rx, ry) {
  const { dx, dy, row } = cellToDisplay(doc, rx, ry);
  const tile = tileAtDisplay(doc, dx, row);
  return tile?.dy === dy ? tile : undefined;
}

export function isPlayableCell(doc, rx, ry) {
  const tile = tileAtCell(doc, rx, ry), bounds = playableBounds(doc);
  return !!tile && tile.dx >= bounds.x && tile.dx < bounds.x + bounds.width && tile.dy - tile.z >= bounds.y && tile.dy - tile.z < bounds.y + bounds.height;
}

/** The client's MapBounds.fromMapFile/computeLocalSize buildable rectangle. */
export function playableBounds(doc) {
  const local = doc.localSize, x = Math.max(2, local.x);
  const width = Math.min(doc.fullSize.width - 2 - x, local.width);
  let cutoff = 9;
  // TileCollection.computeCutoffTileHeight samples the final staggered row.
  for (let dx = 1; dx < 2 * doc.fullSize.width - 4; dx += 2) {
    cutoff = Math.max(cutoff, tileAtDisplay(doc, dx, doc.fullSize.height - 1)?.z ?? 0);
  }
  const height = Math.min(2 * (local.height + 5) - 1, 2 * doc.fullSize.height - 2 * (local.y - 3) - cutoff);
  return { x: 2 * x, y: 2 * local.y, width: 2 * width - 2, height: height - 8 };
}

function flatTiles(width, height) {
  const doc = { fullSize: { width, height } }, result = [];
  for (let row = 0; row < height; row++) for (let dx = 0; dx < 2 * width - 1; dx++) {
    const dy = 2 * row + (dx & 1), { rx, ry } = displayToCell(doc, dx, dy);
    result.push({ dx, dy, rx, ry, tileNum: 0, subTile: 0, z: 0, reserved: 0, iceGrowth: 0 });
  }
  return result;
}

function tileBytes(doc) {
  const count = (2 * doc.fullSize.width - 1) * doc.fullSize.height;
  if (doc.tiles.length !== count) throw new Error('Changing dimensions requires creating a new map');
  const tail = doc._tileTail ?? new Uint8Array(4);
  const bytes = new Uint8Array(count * 11 + tail.length), view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index++) {
    const tile = doc.tiles[index], offset = index * 11;
    integer(tile.rx, 0, 65535, 'Tile rx'); integer(tile.ry, 0, 65535, 'Tile ry');
    integer(tile.tileNum, -32768, 32767, 'Tile number'); integer(tile.subTile, 0, 255, 'Subtile'); integer(tile.z, 0, 14, 'Tile elevation');
    view.setUint16(offset, tile.rx, true); view.setUint16(offset + 2, tile.ry, true);
    view.setInt16(offset + 4, tile.tileNum, true); view.setInt16(offset + 6, tile.reserved ?? 0, true);
    bytes[offset + 8] = tile.subTile; bytes[offset + 9] = tile.z; bytes[offset + 10] = tile.iceGrowth ?? 0;
  }
  bytes.set(tail, count * 11);
  return bytes;
}

function overlayBytes(doc) {
  const ids = new Uint8Array(OVERLAY_BYTES).fill(255), data = doc._overlayDataBase?.slice() ?? new Uint8Array(OVERLAY_BYTES);
  for (const [index, overlay] of doc.overlays) {
    integer(index, 0, OVERLAY_BYTES - 1, 'Overlay index');
    integer(overlay.id, 0, 255, 'Overlay id'); integer(overlay.value ?? 0, 0, 255, 'Overlay value');
    const expected = overlay.ry * 512 + overlay.rx;
    if (expected !== index) throw new Error('Overlay coordinates do not match its map key');
    ids[index] = overlay.id; data[index] = overlay.value ?? 0;
  }
  return { ids, data };
}

function parseWaypoints(ini) {
  const waypoints = [];
  for (const [key, raw] of sectionEntries(ini, 'Waypoints')) {
    const number = parseInt(key, 10), value = parseInt(raw, 10);
    if (!Number.isFinite(number) || !Number.isFinite(value)) continue;
    waypoints.push({ number, rx: value % 1000, ry: Math.floor(value / 1000) });
  }
  return waypoints;
}

function editableSnapshot(doc) {
  return {
    metadata: JSON.stringify(doc.metadata), fullSize: rectString(doc.fullSize), localSize: rectString(doc.localSize),
    spawnLimit: doc.spawnLimit, spawns: JSON.stringify(doc.spawns), terrain: JSON.stringify([...doc.terrain]), structures: JSON.stringify([...doc.structures]),
  };
}

export function parseMap(text) {
  if (typeof text !== 'string') throw new TypeError('Map input must be INI text');
  const ini = parseIni(text);
  if (!hasSection(ini, 'Map')) throw new Error('[Map] section not found');
  if (!hasSection(ini, 'IsoMapPack5')) throw new Error('[IsoMapPack5] section not found');
  const fullSize = rect(readIni(ini, 'Map', 'Size'), 'Size');
  validateDimensions(fullSize.width, fullSize.height);
  const localSize = rect(readIni(ini, 'Map', 'LocalSize', `0,0,${fullSize.width},${fullSize.height}`), 'LocalSize');
  const theater = readIni(ini, 'Map', 'Theater').toUpperCase();
  if (!THEATERS.has(theater)) throw new Error(`Unsupported theater ${theater}`);
  const explicitCap = Number(readIni(ini, 'Basic', 'WinlifeMaxPlayers'));
  const spawnLimit = Number.isInteger(explicitCap) && explicitCap >= 9 && explicitCap <= 16 ? explicitCap : 8;
  const waypoints = parseWaypoints(ini), spawns = waypoints.filter(point => point.number >= 0 && point.number < spawnLimit);
  const playerCount = spawns.length || 2;
  const declaredMaxRaw = readIni(ini, 'Basic', 'MaxPlayer');
  const declaredMax = Number(declaredMaxRaw);
  const doc = {
    version: 1,
    metadata: {
      name: readIni(ini, 'Basic', 'Name', 'Untitled map'), author: readIni(ini, 'Basic', 'Author'), theater,
      width: fullSize.width, height: fullSize.height,
      minPlayers: Math.max(1, Math.min(playerCount, Number(readIni(ini, 'Basic', 'MinPlayer', '2')) || 2)),
      maxPlayers: playerCount,
      gameMode: readIni(ini, 'Basic', 'GameMode', 'standard'),
    },
    fullSize, localSize, spawnLimit, tiles: flatTiles(fullSize.width, fullSize.height), spawns, waypoints,
    overlays: new Map(), terrain: new Map(), structures: new Map(), warnings: [], _ini: ini,
  };
  if (declaredMaxRaw && (!Number.isInteger(declaredMax) || declaredMax < 1 || declaredMax > spawnLimit || declaredMax !== spawns.length)) {
    doc.warnings.push(`Basic.MaxPlayer=${declaredMaxRaw} differs from ${spawns.length} real starting locations; the editor uses the starting locations.`);
  }
  if (readIni(ini, 'Basic', 'WinlifeMaxPlayers') && spawnLimit === 8) doc.warnings.push('Invalid WinlifeMaxPlayers marker; treating waypoints 8 and above as ordinary waypoints.');
  if (!spawns.length) doc.warnings.push('This map has no multiplayer starting locations.');
  const count = doc.tiles.length, raw = decodePacked(packedValues(ini, 'IsoMapPack5'), 5);
  if (raw.length < count * 11) doc.warnings.push('IsoMapPack5 has omitted cells; the client fills them with clear ground.');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < Math.min(count, Math.floor(raw.length / 11)); i++) {
    const offset = i * 11, rx = view.getUint16(offset, true), ry = view.getUint16(offset + 2, true);
    const { dx, dy, row } = cellToDisplay(doc, rx, ry);
    if (dx < 0 || dx >= 2 * fullSize.width - 1 || row < 0 || row >= fullSize.height || dy < 0 || dy >= 2 * fullSize.height) continue;
    doc.tiles[row * (2 * fullSize.width - 1) + dx] = {
      dx, dy, rx, ry, tileNum: view.getInt16(offset + 4, true), reserved: view.getInt16(offset + 6, true),
      subTile: raw[offset + 8], z: raw[offset + 9], iceGrowth: raw[offset + 10],
    };
  }
  doc._tileTail = raw.length >= count * 11 ? raw.slice(count * 11) : new Uint8Array(4);
  // Heights outside the editor's ordinary 0..14 range remain readable and
  // unchanged; save only rejects them after a user changes their tile pack.
  doc._tilesOriginal = tileBytesUnchecked(doc);
  let ids = new Uint8Array(OVERLAY_BYTES).fill(255), data = new Uint8Array(OVERLAY_BYTES);
  if (hasSection(ini, 'OverlayPack')) {
    const decoded = decodePacked(packedValues(ini, 'OverlayPack'), 80, OVERLAY_BYTES);
    if (decoded.length !== OVERLAY_BYTES) throw new Error('OverlayPack must contain 512 × 512 bytes');
    ids = decoded;
  }
  if (hasSection(ini, 'OverlayDataPack')) {
    const decoded = decodePacked(packedValues(ini, 'OverlayDataPack'), 80, OVERLAY_BYTES);
    if (decoded.length !== OVERLAY_BYTES) throw new Error('OverlayDataPack must contain 512 × 512 bytes');
    data = decoded;
  }
  for (let index = 0; index < ids.length; index++) if (ids[index] !== 255) {
    doc.overlays.set(index, { id: ids[index], value: data[index], rx: index % 512, ry: Math.floor(index / 512) });
  }
  doc._overlayIdsOriginal = ids; doc._overlayDataOriginal = data; doc._overlayDataBase = data.slice();
  for (const [key, name] of sectionEntries(ini, 'Terrain')) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0) doc.terrain.set(index, { rx: index % 1000, ry: Math.floor(index / 1000), name });
  }
  for (const [key, value] of sectionEntries(ini, 'Structures')) {
    const fields = value.split(',');
    if (fields.length <= 15) continue;
    doc.structures.set(key, { owner: fields[0], name: fields[1], health: Number(fields[2]), rx: Number(fields[3]), ry: Number(fields[4]), direction: Number(fields[5]), tag: fields[6], poweredOn: fields[9] === '1', fields });
  }
  doc._original = editableSnapshot(doc);
  return doc;
}

// Only skip range checks while recording the original pack. Validating an
// unchanged imported tile pack would needlessly reject maps the game accepts.
function tileBytesUnchecked(doc) {
  const tiles = doc.tiles;
  const out = new Uint8Array(tiles.length * 11 + doc._tileTail.length), view = new DataView(out.buffer);
  tiles.forEach((tile, i) => {
    const offset = i * 11;
    integer(tile.rx, 0, 65535, 'Tile rx'); integer(tile.ry, 0, 65535, 'Tile ry');
    integer(tile.tileNum, -32768, 32767, 'Tile number'); integer(tile.reserved ?? 0, -32768, 32767, 'Tile reserved field');
    integer(tile.subTile, 0, 255, 'Subtile'); integer(tile.z, 0, 255, 'Tile elevation'); integer(tile.iceGrowth ?? 0, 0, 255, 'Tile ice growth');
    view.setUint16(offset, tile.rx, true); view.setUint16(offset + 2, tile.ry, true);
    view.setInt16(offset + 4, tile.tileNum, true); view.setInt16(offset + 6, tile.reserved ?? 0, true);
    out[offset + 8] = tile.subTile; out[offset + 9] = tile.z; out[offset + 10] = tile.iceGrowth ?? 0;
  });
  out.set(doc._tileTail, tiles.length * 11); return out;
}

export function serializeMap(doc) {
  validateDimensions(doc.fullSize.width, doc.fullSize.height);
  const ini = { ...doc._ini, blocks: doc._ini.blocks.map(block => ({ ...block, lines: [...block.lines] })) };
  const original = doc._original ?? {};
  const originalMeta = original.metadata ? JSON.parse(original.metadata) : null;
  const maxPlayersChanged = !originalMeta || doc.metadata.maxPlayers !== originalMeta.maxPlayers;
  const spawnLimit = maxPlayersChanged ? (doc.metadata.maxPlayers > 8 ? doc.metadata.maxPlayers : 8) : doc.spawnLimit ?? 8;
  if (JSON.stringify(doc.metadata) !== original.metadata) {
    const meta = doc.metadata;
    integer(meta.minPlayers, 1, 16, 'Minimum players'); integer(meta.maxPlayers, meta.minPlayers, 16, 'Maximum players');
    if (!THEATERS.has(meta.theater.toUpperCase())) throw new Error(`Unsupported theater ${meta.theater}`);
    if (meta.width !== doc.fullSize.width || meta.height !== doc.fullSize.height) throw new Error('Changing dimensions requires creating a new map');
    for (const [key, value] of [['Name', meta.name], ['Author', meta.author], ['MinPlayer', meta.minPlayers], ['MaxPlayer', meta.maxPlayers], ['GameMode', meta.gameMode]]) writeIni(ini, 'Basic', key, value);
    writeIni(ini, 'Map', 'Theater', meta.theater.toUpperCase());
  }
  if (spawnLimit !== original.spawnLimit) writeIni(ini, 'Basic', 'WinlifeMaxPlayers', spawnLimit > 8 ? spawnLimit : undefined);
  if (rectString(doc.fullSize) !== original.fullSize) writeIni(ini, 'Map', 'Size', rectString(doc.fullSize));
  if (rectString(doc.localSize) !== original.localSize) writeIni(ini, 'Map', 'LocalSize', rectString(doc.localSize));
  const tiles = tileBytesUnchecked(doc);
  if (!bytesEqual(tiles, doc._tilesOriginal)) writePacked(ini, 'IsoMapPack5', tileBytes(doc), 5);
  const { ids, data } = overlayBytes(doc);
  const needsOverlayPair = doc.overlays.size > 0 && (!hasSection(ini, 'OverlayPack') || !hasSection(ini, 'OverlayDataPack'));
  if (needsOverlayPair || !bytesEqual(ids, doc._overlayIdsOriginal)) writePacked(ini, 'OverlayPack', ids, 80);
  if (needsOverlayPair || !bytesEqual(data, doc._overlayDataOriginal)) writePacked(ini, 'OverlayDataPack', data, 80);
  if (JSON.stringify(doc.spawns) !== original.spawns || spawnLimit !== original.spawnLimit) {
    const oldSpawns = new Map(JSON.parse(original.spawns ?? '[]').map(spawn => [spawn.number, spawn]));
    // Legacy 8..15 entries are ordinary trigger waypoints. Only overwrite a
    // legacy waypoint if the caller explicitly creates a spawn at that ID.
    const oldLimit = original.spawnLimit ?? 8;
    for (const key of sectionEntries(ini, 'Waypoints').keys()) if (/^\d+$/.test(key) && Number(key) < oldLimit) writeIni(ini, 'Waypoints', key, undefined);
    const seen = new Set();
    for (const spawn of [...doc.spawns].sort((a, b) => a.number - b.number)) {
      integer(spawn.number, 0, 15, 'Spawn number');
      if (spawn.number >= spawnLimit) continue;
      if (seen.has(spawn.number)) throw new Error(`Duplicate spawn number ${spawn.number}`);
      seen.add(spawn.number);
      if (JSON.stringify(spawn) !== JSON.stringify(oldSpawns.get(spawn.number))) ensureMapCell(doc, spawn.rx, spawn.ry);
      writeIni(ini, 'Waypoints', String(spawn.number), spawn.ry * 1000 + spawn.rx);
    }
  }
  if (JSON.stringify([...doc.terrain]) !== original.terrain) {
    const oldTerrain = new Map(JSON.parse(original.terrain ?? '[]'));
    for (const key of oldTerrain.keys()) if (!doc.terrain.has(key)) writeIni(ini, 'Terrain', String(key), undefined);
    for (const [key, terrain] of doc.terrain) {
      if (JSON.stringify(terrain) === JSON.stringify(oldTerrain.get(key))) continue;
      ensureMapCell(doc, terrain.rx, terrain.ry);
      if (key !== terrain.ry * 1000 + terrain.rx) throw new Error('Terrain coordinates do not match its map key');
      writeIni(ini, 'Terrain', String(key), terrain.name);
    }
  }
  if (JSON.stringify([...doc.structures]) !== original.structures) {
    const oldStructures = new Map(JSON.parse(original.structures ?? '[]'));
    for (const key of oldStructures.keys()) if (!doc.structures.has(key)) writeIni(ini, 'Structures', key, undefined);
    for (const [key, object] of doc.structures) {
      if (JSON.stringify(object) === JSON.stringify(oldStructures.get(key))) continue;
      ensureMapCell(doc, object.rx, object.ry);
      const fields = [...(object.fields ?? ['Neutral', '', '256', '0', '0', '0', 'None', '1', '0', '1', '0', '0', '0', '0', '0', '0', '0'])];
      fields[0] = object.owner ?? 'Neutral'; fields[1] = object.name; fields[2] = String(object.health ?? 256);
      fields[3] = String(object.rx); fields[4] = String(object.ry); fields[5] = String(object.direction ?? 0);
      fields[6] = object.tag ?? 'None'; fields[9] = object.poweredOn === false ? '0' : '1';
      writeIni(ini, 'Structures', String(key), fields.join(','));
    }
  }
  const lines = [];
  for (const block of ini.blocks) {
    if (block.name !== null) lines.push(block.header);
    lines.push(...block.lines);
  }
  return (ini.bom ? '\uFEFF' : '') + lines.join(ini.newline);
}

function ensureMapCell(doc, rx, ry) {
  integer(rx, 0, 511, 'Cell rx'); integer(ry, 0, 511, 'Cell ry');
  if (!tileAtCell(doc, rx, ry)) throw new Error(`Cell (${rx},${ry}) is outside the map`);
}

export function setMetadata(doc, values) {
  if ('width' in values && values.width !== doc.fullSize.width || 'height' in values && values.height !== doc.fullSize.height) throw new Error('Changing dimensions requires creating a new map');
  Object.assign(doc.metadata, values);
  if (doc.metadata.theater) doc.metadata.theater = doc.metadata.theater.toUpperCase();
  if ('maxPlayers' in values) {
    integer(values.maxPlayers, 1, 16, 'Maximum players');
    doc.spawnLimit = values.maxPlayers > 8 ? values.maxPlayers : 8;
    if (doc.spawns.some(spawn => spawn.number >= doc.spawnLimit)) doc.spawns = doc.spawns.filter(spawn => spawn.number < doc.spawnLimit);
  }
  return doc;
}

export function getOverlay(doc, rx, ry) { return doc.overlays.get(ry * 512 + rx); }
export function setOverlay(doc, rx, ry, id, value = 0) {
  ensureMapCell(doc, rx, ry); integer(id, 0, 255, 'Overlay id'); integer(value, 0, 255, 'Overlay value');
  const key = ry * 512 + rx;
  if (id === 255) { doc.overlays.delete(key); doc._overlayDataBase[key] = 0; }
  else doc.overlays.set(key, { rx, ry, id, value });
  return doc;
}

export function setSpawn(doc, number, rx, ry) {
  integer(number, 0, 15, 'Spawn number'); ensureMapCell(doc, rx, ry);
  if (number >= (doc.spawnLimit ?? 8)) {
    doc.spawnLimit = number + 1;
    doc.metadata.maxPlayers = Math.max(doc.metadata.maxPlayers, number + 1);
  }
  const existing = doc.spawns.find(point => point.number === number);
  if (existing) Object.assign(existing, { rx, ry }); else doc.spawns.push({ number, rx, ry });
  doc.spawns.sort((a, b) => a.number - b.number);
  return doc;
}
export function removeSpawn(doc, number) { doc.spawns = doc.spawns.filter(point => point.number !== number); return doc; }

export function setTerrain(doc, rx, ry, name) {
  ensureMapCell(doc, rx, ry);
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('Invalid terrain object name');
  doc.terrain.set(ry * 1000 + rx, { rx, ry, name }); return doc;
}
export function removeTerrain(doc, rx, ry) { doc.terrain.delete(ry * 1000 + rx); return doc; }

export function addStructure(doc, object) {
  ensureMapCell(doc, object.rx, object.ry);
  if (!/^[A-Za-z0-9_]+$/.test(object.name)) throw new Error('Invalid structure name');
  let index = 0;
  while (doc.structures.has(String(index))) index++;
  doc.structures.set(String(index), { owner: 'Neutral', health: 256, direction: 0, tag: 'None', poweredOn: true, ...object });
  return String(index);
}
export function removeStructure(doc, key) { doc.structures.delete(String(key)); return doc; }

export function getIniValue(doc, section, key, fallback = '') { return readIni(doc._ini, section, key, fallback); }
export function setIniValue(doc, section, key, value) { writeIni(doc._ini, section, key, value); return doc; }

/** New flat maps use a real clear tile for the selected original theater. */
export function createMap({ width = 64, height = 64, theater = 'TEMPERATE', name = 'Untitled map', author = '', players = 2 } = {}) {
  integer(width, 16, 256, 'Map width'); integer(height, 16, 256, 'Map height'); validateDimensions(width, height);
  integer(players, 2, 16, 'Players'); theater = theater.toUpperCase();
  if (!TERRAIN_TILES[theater]) throw new Error('New maps support TEMPERATE, SNOW and URBAN; other theaters may be imported');
  // Native RA2 LocalSize uses the same width/height scale as Map.Size. The
  // client projects both axes by two and applies its offscreen cutoff.
  const localSize = { x: 2, y: 4, width: width - 4, height: height - 8 };
  const ini = [
    '; Created with the RA2 LAN map editor', '[Basic]', 'NewINIFormat=4', 'Name=Untitled map', 'Author=',
    'MultiplayerOnly=yes', 'Official=no', 'GameMode=standard', 'MinPlayer=2', `MaxPlayer=${players}`,
    ...(players > 8 ? [`WinlifeMaxPlayers=${players}`] : []),
    'TiberiumGrowthEnabled=yes', 'VeinGrowthEnabled=no', '[Map]', `Theater=${theater}`,
    `Size=0,0,${width},${height}`, `LocalSize=${rectString(localSize)}`, '[Lighting]',
    'Ambient=1.000000', 'Red=1.000000', 'Green=1.000000', 'Blue=1.000000', 'Level=0.000000', 'Ground=0.000000',
    '[SpecialFlags]', 'InitialVeteran=no', '[Waypoints]', '[Terrain]', '[Structures]', '',
  ].join('\r\n');
  const doc = {
    version: 1, metadata: { name, author, theater, width, height, minPlayers: 2, maxPlayers: players, gameMode: 'standard' },
    fullSize: { x: 0, y: 0, width, height }, localSize, spawnLimit: players > 8 ? players : 8,
    tiles: flatTiles(width, height), spawns: [], waypoints: [], overlays: new Map(), terrain: new Map(), structures: new Map(), warnings: [],
    _ini: parseIni(ini), _tileTail: new Uint8Array(4), _overlayDataBase: new Uint8Array(OVERLAY_BYTES),
  };
  // Ellipse in the rectangular isometric projection, evenly spaced and
  // snapped to valid staggered cells. Extra slots require the explicitly
  // marked LAN client; ordinary RA2 treats waypoints 8+ as trigger locations.
  for (let number = 0; number < players; number++) {
    const angle = -Math.PI / 2 + number * Math.PI * 2 / players;
    const dx = Math.round(width - 1 + Math.cos(angle) * (width - 8) * 0.72);
    let row = Math.round((height - 1) / 2 + Math.sin(angle) * (height - 10) * 0.34);
    const bounds = playableBounds(doc), parity = dx & 1;
    row = Math.max(Math.ceil((bounds.y - parity) / 2), Math.min(Math.floor((bounds.y + bounds.height - 1 - parity) / 2), row));
    const { rx, ry } = displayToCell(doc, dx, 2 * row + (dx & 1)); setSpawn(doc, number, rx, ry);
  }
  // Force initial packs to be emitted, then return the same normalized model
  // an imported map has (including source snapshots for no-op round trips).
  doc._original = {};
  return parseMap(serializeMap(doc));
}
