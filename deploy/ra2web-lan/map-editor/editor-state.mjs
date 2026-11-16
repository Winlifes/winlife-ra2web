// Editing snapshots contain only mutable fields. Original INI/script/packed
// bytes remain on the document and are still preserved by the map codec.
export function captureEditorState(doc) {
  const tiles = new Int16Array(doc.tiles.length * 3);
  for (let i = 0; i < doc.tiles.length; i++) {
    const tile = doc.tiles[i], offset = i * 3;
    tiles[offset] = tile.tileNum; tiles[offset + 1] = tile.subTile; tiles[offset + 2] = tile.z;
  }
  return {
    metadata: { ...doc.metadata }, spawnLimit: doc.spawnLimit, tiles,
    spawns: doc.spawns.map(item => ({ ...item })), waypoints: doc.waypoints.map(item => ({ ...item })),
    overlays: [...doc.overlays].map(([key, item]) => [key, { ...item }]),
    terrain: [...doc.terrain].map(([key, item]) => [key, { ...item }]),
    structures: [...doc.structures].map(([key, item]) => [key, { ...item, ...(item.fields ? { fields: [...item.fields] } : {}) }]),
    overlayDataBase: doc._overlayDataBase.slice(),
  };
}
export function restoreEditorState(doc, state) {
  if (state.tiles.length !== doc.tiles.length * 3) throw new Error('Snapshot belongs to another map size');
  doc.metadata = { ...state.metadata }; doc.spawnLimit = state.spawnLimit;
  for (let i = 0; i < doc.tiles.length; i++) {
    const tile = doc.tiles[i], offset = i * 3;
    tile.tileNum = state.tiles[offset]; tile.subTile = state.tiles[offset + 1]; tile.z = state.tiles[offset + 2];
  }
  doc.spawns = state.spawns.map(item => ({ ...item })); doc.waypoints = state.waypoints.map(item => ({ ...item }));
  doc.overlays = new Map(state.overlays.map(([key, item]) => [key, { ...item }]));
  doc.terrain = new Map(state.terrain.map(([key, item]) => [key, { ...item }]));
  doc.structures = new Map(state.structures.map(([key, item]) => [key, { ...item, ...(item.fields ? { fields: [...item.fields] } : {}) }]));
  doc._overlayDataBase = state.overlayDataBase.slice();
  return doc;
}
export function containsPlayableTile(bounds, tile) {
  return !!tile && tile.dx >= bounds.x && tile.dx < bounds.x + bounds.width && tile.dy - tile.z >= bounds.y && tile.dy - tile.z < bounds.y + bounds.height;
}
// Conservative candidate rows/columns for a world-space dirty rectangle.
// Staggered rows and elevated tiles are included before the exact pixel test.
export function tileRange(doc, rect, maxHeight, tileWidth = 24, tileHeight = 12, elevation = 6) {
  const width = doc.fullSize.width, halfW = tileWidth / 2, halfH = tileHeight / 2;
  return {
    minX: Math.max(0, Math.floor((rect.x - halfW) / halfW + width - 1) - 1),
    maxX: Math.min(2 * width - 2, Math.ceil((rect.x + rect.width + halfW) / halfW + width - 1) + 1),
    minRow: Math.max(0, Math.floor((rect.y - halfH - (width + 2) * halfH) / tileHeight) - 1),
    maxRow: Math.min(doc.fullSize.height - 1, Math.ceil((rect.y + rect.height + halfH - (width + 1) * halfH + maxHeight * elevation) / tileHeight) + 1),
  };
}
export function* brushLine(from, to) {
  let x = from.rx, y = from.ry;
  const dx = Math.abs(to.rx - x), sx = x < to.rx ? 1 : -1, dy = -Math.abs(to.ry - y), sy = y < to.ry ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    yield { rx: x, ry: y };
    if (x === to.rx && y === to.ry) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
}
