// Shared by the editor and the game's native map list. Maps stay in this
// browser; the existing game protocol transfers a host's custom map to guests.
const DB_NAME = 'winlife-map-workshop';
const db = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('maps', { keyPath: 'file' });
    request.result.createObjectStore('drafts', { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function transact(store, mode, action) {
  const database = await db();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(store, mode);
      let value;
      const request = action(transaction.objectStore(store));
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || new Error('存储已取消'));
    });
  } finally { database.close(); }
}
export const listLocalMaps = () => transact('maps', 'readonly', store => store.getAll());
export const getLocalMap = file => transact('maps', 'readonly', store => store.get(file));
export const saveDraft = text => transact('drafts', 'readwrite', store => store.put({ id: 'latest', text, updatedAt: Date.now() }));
export const readDraft = () => transact('drafts', 'readonly', store => store.get('latest'));
export const removeLocalMap = file => transact('maps', 'readwrite', store => store.delete(file));
export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function saveLocalMap({ text, title, players, theater, author = '', source = '本地创作' }) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('地图超过 2 MB，请缩小地图或减少内容后再加入游戏。');
  const digest = await sha256(bytes), file = `wl_local_${digest.slice(0, 24)}.map`;
  const record = { file, text, title, players, theater, author, source, sha256: digest, bytes: bytes.length, compatible: true, updatedAt: Date.now() };
  await transact('maps', 'readwrite', store => store.put(record));
  return record;
}
let catalogPromise;
let gameIndexPromise;
export function readCatalog() {
  return catalogPromise ??= fetch('/maps/catalog.json', { cache: 'no-cache' }).then(async response => {
    if (!response.ok) throw new Error('暂时无法读取站点地图库。');
    const catalog = await response.json();
    if (!Array.isArray(catalog.maps) || catalog.maps.length > 10000) throw new Error('地图库索引格式错误。');
    return catalog;
  }).catch(error => { catalogPromise = undefined; throw error; });
}
export function readGameIndex() {
  return gameIndexPromise ??= fetch('/maps/game-index.json', { cache: 'no-cache' }).then(async response => {
    if (!response.ok) throw new Error('暂时无法读取游戏地图索引。');
    const index = await response.json();
    if (!Array.isArray(index.maps) || index.maps.length > 10000) throw new Error('地图索引格式错误。');
    return index;
  }).catch(error => { gameIndexPromise = undefined; throw error; });
}
export async function listGameMaps() {
  const results = await Promise.allSettled([readGameIndex(), listLocalMaps()]);
  const maps = results[0].status === 'fulfilled' ? results[0].value.maps.filter(map => map.compatible !== false) : [];
  const local = results[1].status === 'fulfilled' ? results[1].value : [];
  return [...new Map([...maps, ...local].map(map => [map.file, map])).values()];
}
// Collapse only source-verified identical native/community entries in standard
// mode. Keep each native entry available in all its other modes.
export async function deduplicateNativeMaps(nativeList,communityList) {
  const index=await readGameIndex();
  const registered=new Set(communityList.getAll().map(map=>map.fileName.toLowerCase()));
  const replacements=new Map((index.nativeDuplicates||[]).filter(item=>registered.has(item.canonicalFile.toLowerCase())).map(item=>[item.file.toLowerCase(),item]));
  const retained=[],applied=[];
  for(const map of nativeList.getAll()){
    if(!replacements.has(map.fileName.toLowerCase())){retained.push(map);continue;}
    if(map.gameModes.some(mode=>mode.mapFilter==='standard'))applied.push(map.fileName);
    const otherModes=map.gameModes.filter(mode=>mode.mapFilter!=='standard');
    if(otherModes.length){map.gameModes=otherModes;retained.push(map);}
  }
  nativeList.manifests=retained;
  return {standardDuplicatesRemoved:applied.length,nativeFiles:applied};
}
export function registrationText(map) {
  const name = String(map.title || map.file).replace(/[\r\n\[\]]/g, ' ');
  const players = Math.max(2, Math.min(16, Number(map.players) || 2));
  return `[Basic]\nName=${name}\nGameMode=standard\nOfficial=no\nMaxPlayer=${players}\nWinlifeMaxPlayers=${players}\n[Waypoints]\n` +
    Array.from({ length: players }, (_, index) => `${index}=${1010 + index * 1001}`).join('\n');
}
export async function loadGameMap(file) {
  if (!/^wl_[a-z0-9_]+\.map$/.test(file)) throw new Error('地图文件名无效。');
  const local = await getLocalMap(file).catch(() => undefined);
  if (local) return new TextEncoder().encode(local.text);
  const index = await readGameIndex().catch(() => ({ maps: [] }));
  const entry = index.maps.find(map => map.file === file) || (await readCatalog()).maps.flatMap(map => [map,...(map.cleanedVersion?[map.cleanedVersion]:[])]).find(map => map.file === file);
  if (!entry) throw new Error('未找到这张地图。请在编辑器重新保存，或从地图库重新选择。');
  const response = await fetch('/maps/files/' + encodeURIComponent(file));
  if (!response.ok) throw new Error('地图下载失败，请重试。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await sha256(bytes) !== entry.sha256) throw new Error('地图校验失败，请刷新网页后重试。');
  return bytes;
}
