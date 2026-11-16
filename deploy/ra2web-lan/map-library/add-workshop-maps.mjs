// A reproducible, original 16-player battlefield for the extended client.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMap, serializeMap, parseMap, tileAtCell, isPlayableCell, setOverlay, setTerrain, setIniValue, OVERLAY_IDS } from '../map-editor/map-codec.mjs';
import {renderMapPreview,embedMapPreview} from './map-preview.mjs';

export function createWorkshopMap() {
  const doc = createMap({width:128,height:128,name:'Winlife 16人对战平原',author:'Winlife',players:16,theater:'TEMPERATE'});
  // This map-local terrain override is read by the Winlife mine trait. Other
  // maps omit it and retain the original yellow-ore generation and timing.
  setIniValue(doc,'TIBTRE01','TiberiumToSpawn',1);
  for (const spawn of doc.spawns) {
    for (const [xOffset,yOffset] of [[7,4],[-7,-4]]) {
      for(let x=-2;x<=2;x++)for(let y=-2;y<=2;y++) {
        const rx=spawn.rx+xOffset+x,ry=spawn.ry+yOffset+y;
        if(!tileAtCell(doc,rx,ry)||!isPlayableCell(doc,rx,ry))continue;
        if(doc.spawns.some(other=>Math.abs(other.rx-rx)+Math.abs(other.ry-ry)<6))continue;
        setOverlay(doc,rx,ry,OVERLAY_IDS.GEMS,11);
      }
      const rx=spawn.rx+xOffset,ry=spawn.ry+yOffset;
      if(!isPlayableCell(doc,rx,ry))throw new Error('Mine must stay within the playable map');
      setTerrain(doc,rx,ry,'TIBTRE01');
      // Keep the mine's own ground cell free of a harvestable overlay.
      setOverlay(doc,rx,ry,OVERLAY_IDS.EMPTY);
    }
  }
  return doc;
}

export function addWorkshopMaps(root) {
  const maps = path.join(root, 'maps'), fileDir = path.join(maps, 'files');
  fs.mkdirSync(fileDir, {recursive:true});
  const doc=createWorkshopMap();
  const preview=renderMapPreview(doc);embedMapPreview(doc,preview);
  const text=serializeMap(doc),bytes=Buffer.from(text),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  const file='wl_winlife_'+sha256.slice(0,24)+'.map';
  const verified=parseMap(text);
  if(verified.spawns.length!==16||verified.spawnLimit!==16)throw new Error('Extended battlefield needs sixteen explicit starts');
  fs.writeFileSync(path.join(fileDir,file),bytes);
  const previewFile=file.replace('.map','.png');fs.mkdirSync(path.join(maps,'previews'),{recursive:true});fs.writeFileSync(path.join(maps,'previews',previewFile),preview.png);
  if(verified.terrain.size!==32||[...verified.overlays.values()].some(item=>item.id!==OVERLAY_IDS.GEMS))throw new Error('Expected thirty-two mines and gem-only resource fields');
  const record={file,title:doc.metadata.name,players:16,author:'Winlife',source:'winlife',sourceLabel:'Winlife 原创',sourcePage:'/map-editor/',theater:'TEMPERATE',sha256,bytes:bytes.length,compatible:true,reasons:[],gameModes:['standard'],requiresExtendedClient:true,runtimeVerified:false,resourceType:'gems',regeneratingMines:32,preview:'/maps/previews/'+previewFile,previewSha256:crypto.createHash('sha256').update(preview.png).digest('hex'),previewFormat:'png'};
  for(const name of ['catalog.json','game-index.json']) {
    const target=path.join(maps,name),data=JSON.parse(fs.readFileSync(target));
    // Replace only our generated entry; third-party originals are untouched.
    const existing=data.maps.find(map=>map.source==='winlife'&&map.sha256===record.sha256);
    data.maps=data.maps.filter(map=>!(map.source==='winlife'&&map.file.startsWith('wl_winlife_')));data.maps.push({...record,...(existing?.deduplication?{deduplication:existing.deduplication}:{})});
    data.limits={combatants:16,observers:1};
    if(name==='catalog.json'){data.total=data.maps.length;data.compatibleCount=data.maps.filter(map=>map.compatible).length;data.publicSourceMaps=data.maps.filter(map=>map.source!=='winlife').length;}
    fs.writeFileSync(target,JSON.stringify(data,null,2)+'\n');
  }
  return record;
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname)console.log(JSON.stringify(addWorkshopMaps(path.resolve(process.argv[2]))));
