import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createMap, parseMap, serializeMap, setOverlay, setTerrain, addStructure, setSpawn, setMetadata, playableBounds, isPlayableCell } from './map-codec.mjs';
import { captureEditorState, restoreEditorState, containsPlayableTile, tileRange, brushLine } from './editor-state.mjs';

test('undo restores exact imported bytes, scripts, ordinary waypoints and all editable layers', () => {
  const doc=createMap({width:32,height:32,name:'Undo fixture',players:4});
  // Unknown sections and non-spawn waypoint data must survive snapshots.
  const original=serializeMap(doc)+'\r\n[WinlifeUnknown]\r\nKeep=original\r\n[Waypoints]\r\n21=34035\r\n';
  const imported=parseMap(original),state=captureEditorState(imported),tile=imported.tiles[800];
  tile.tileNum=314;tile.subTile=3;tile.z=7;
  setOverlay(imported,tile.rx,tile.ry,102,11);setTerrain(imported,tile.rx,tile.ry,'T01');
  addStructure(imported,{name:'CAOILD',rx:tile.rx,ry:tile.ry});setSpawn(imported,0,tile.rx,tile.ry);setMetadata(imported,{name:'Changed'});
  restoreEditorState(imported,state);
  assert.equal(serializeMap(imported),original);
});
test('erase undo also restores hidden overlay payload bytes and snapshots are independent', () => {
  const doc=createMap({width:32,height:32}),tile=doc.tiles[700],key=tile.ry*512+tile.rx;
  setOverlay(doc,tile.rx,tile.ry,102,9);doc._overlayDataBase[key]=6;
  const state=captureEditorState(doc);setOverlay(doc,tile.rx,tile.ry,255);
  assert.equal(doc._overlayDataBase[key],0);restoreEditorState(doc,state);
  assert.equal(doc._overlayDataBase[key],6);assert.equal(doc.overlays.get(key).value,9);
  doc.overlays.get(key).value=1;doc.tiles[0].z=9;assert.equal(state.overlays[0][1].value,9);assert.equal(state.tiles[2],0);
});
test('cached playable rectangle matches native codec checks on every cell', () => {
  const doc=createMap({width:64,height:64});
  for(let i=0;i<doc.tiles.length;i+=17)doc.tiles[i].z=i%15;
  const bounds=playableBounds(doc);
  for(const tile of doc.tiles)assert.equal(containsPlayableTile(bounds,tile),isPlayableCell(doc,tile.rx,tile.ry));
});
test('dirty tile ranges never exclude staggered or elevated intersecting tiles', () => {
  const doc=createMap({width:64,height:64});
  for(let i=0;i<doc.tiles.length;i++)doc.tiles[i].z=(i*17)%15;
  for(let n=0;n<80;n++){
    const rect={x:(n*137)%1600-800,y:(n*113)%1300-100,width:68+(n%8)*12,height:68};
    const range=tileRange(doc,rect,14);
    for(const tile of doc.tiles){const x=(tile.rx-tile.ry)*12,y=(tile.rx+tile.ry)*6-tile.z*6;
      if(x+12>=rect.x&&x-12<=rect.x+rect.width&&y+6>=rect.y&&y-6<=rect.y+rect.height){
        const row=Math.floor(tile.dy/2);assert.ok(tile.dx>=range.minX&&tile.dx<=range.maxX&&row>=range.minRow&&row<=range.maxRow);
      }
    }
  }
});
test('coalesced fast brush motion produces a contiguous line in every direction', () => {
  for(const [x,y]of [[50,27],[-20,8],[2,70],[0,0],[-20,-40]]){
    const line=[...brushLine({rx:0,ry:0},{rx:x,ry:y})];
    assert.deepEqual(line[0],{rx:0,ry:0});assert.deepEqual(line.at(-1),{rx:x,ry:y});
    for(let i=1;i<line.length;i++)assert.equal(Math.max(Math.abs(line[i].rx-line[i-1].rx),Math.abs(line[i].ry-line[i-1].ry)),1);
  }
});
test('actual background encoder preserves edited layers and rejects stale document epochs', async () => {
  const moduleUrl=new URL('./map-worker.mjs',import.meta.url).href;
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:message=>parentPort.postMessage(message)};await import(${JSON.stringify(moduleUrl)});parentPort.on('message',data=>self.onmessage({data}));`)),{type:'module'});
  try{
    const doc=createMap({width:32,height:32,name:'Worker 中文地图',players:4}),seed=serializeMap(doc),tile=doc.tiles[700];
    worker.postMessage({type:'init',epoch:1,text:seed});setOverlay(doc,tile.rx,tile.ry,27,11);
    const expected=serializeMap(doc),state=captureEditorState(doc);
    const response=once(worker,'message');worker.postMessage({type:'encode',epoch:1,id:7,state},[state.tiles.buffer,state.overlayDataBase.buffer]);
    assert.equal(state.tiles.byteLength,0,'buffers transfer instead of copying the tile object graph');
    assert.deepEqual((await response)[0],{id:7,text:expected});
    const rejected=once(worker,'message');worker.postMessage({type:'encode',epoch:0,id:8,state:{}});
    assert.match((await rejected)[0].error,/ready/);
  }finally{await worker.terminate();}
});
