/** Original 8v8 battlefield. Bridge IDs/foundations follow the shipped native bridge readers. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import * as codec from '../map-editor/map-codec.mjs';
import {crc32,loadNativeResources,scanMapCompatibility} from './build-catalog.mjs';
import {compileContentReader,fingerprintMap} from './semantic-dedup.mjs';

export const TEAM_MAP_TITLE='Winlife 两岸会战 8v8';
export const TEAM_MAP_ID='winlife-team-river-8v8-v2';
export const TEAM_RIVER_HALF_WIDTH=30;
export const TEAM_BRIDGE_HALF_LENGTH=35;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function createTeamBattleMap(){
  const doc=codec.createMap({width:160,height:144,name:TEAM_MAP_TITLE,author:'Winlife',players:16});
  codec.setIniValue(doc,'TIBTRE01','TiberiumToSpawn',1);
  doc.spawns=[];
  const rows=[46,110,172,236];
  for(let side=0;side<2;side++)for(let number=0;number<8;number++){
    const dx=side?318-(number<4?100:44):(number<4?100:44),dy=rows[number%4];
    const {rx,ry}=codec.displayToCell(doc,dx,dy);
    codec.setSpawn(doc,side*8+number,rx,ry);
  }
  // The river crosses the complete tile rectangle, so vehicles cannot bypass it at an edge.
  for(const tile of doc.tiles)if(Math.abs(tile.dx-159)<=TEAM_RIVER_HALF_WIDTH){tile.tileNum=314;tile.subTile=0;}
  for(const spawn of doc.spawns){
    const {dx,dy}=codec.cellToDisplay(doc,spawn.rx,spawn.ry),side=spawn.number<8?-1:1;
    for(const dyOffset of [-16,16]){
      const mine=codec.displayToCell(doc,dx+side*18,dy+dyOffset);
      for(let x=-3;x<=3;x++)for(let y=-3;y<=3;y++){
        const rx=mine.rx+x,ry=mine.ry+y;
        assert.ok(codec.isPlayableCell(doc,rx,ry));
        codec.setOverlay(doc,rx,ry,codec.OVERLAY_IDS.GEMS,11);
      }
      codec.setTerrain(doc,mine.rx,mine.ry,'TIBTRE01');
      codec.setOverlay(doc,mine.rx,mine.ry,codec.OVERLAY_IDS.EMPTY);
    }
  }
  // Three crossings, each two parallel native wooden bridges (three cells wide each).
  // Native overlay 74 is an intact X bridge, 94 its start, and 92 its end.
  // Map files must store all three rows with OverlayData 0,1,2. The native
  // createInitialMapOverlays loader instantiates row 1, shifted to row 0.
  // These are lane markers in the file, not rendered-frame/head-type values.
  const bridges=[];
  for(const center of [113,151,189])for(const offset of [-3,1]){
    const ry=center+offset,start=center-TEAM_BRIDGE_HALF_LENGTH,end=center+TEAM_BRIDGE_HALF_LENGTH;
    bridges.push({rxStart:start,rxEnd:end,ry,width:3});
    for(let rx=start;rx<=end;rx++)for(let lane=0;lane<3;lane++)codec.setOverlay(doc,rx,ry+lane,rx===start?94:rx===end?92:74,lane);
    codec.addStructure(doc,{owner:'Neutral',name:'CABHUT',health:256,rx:start-1,ry:ry-1,direction:0});
    codec.addStructure(doc,{owner:'Neutral',name:'CABHUT',health:256,rx:end+1,ry:ry+3,direction:0});
  }
  return {doc,bridges};
}

function chunk(type,body){const tag=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(body.length);crc.writeUInt32BE(crc32(Buffer.concat([tag,body])));return Buffer.concat([size,tag,body,crc]);}
const DIGITS=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
export function teamMapPreview(doc,bridges){
  const width=640,height=560,rgb=Buffer.alloc(width*height*3),pixel=(x,y,color)=>{
    if(x<0||y<0||x>=width||y>=height)return;rgb.set(color,(Math.floor(y)*width+Math.floor(x))*3);
  };
  const color=(tile)=>!codec.isPlayableCell(doc,tile.rx,tile.ry)?[18,27,25]:tile.tileNum===314?[29,85,122]:[83,103,54];
  const xy=(rx,ry)=>{const p=codec.cellToDisplay(doc,rx,ry);return{x:Math.round(p.dx*2),y:Math.round(p.dy*1.9)};};
  const cell=(rx,ry,c)=>{const{x,y}=xy(rx,ry);for(let dx=-2;dx<=2;dx++)for(let dy=-1;dy<=1;dy++)pixel(x+dx,y+dy,c);};
  for(const tile of doc.tiles)cell(tile.rx,tile.ry,color(tile));
  for(const item of doc.overlays.values())if(item.id===codec.OVERLAY_IDS.GEMS)cell(item.rx,item.ry,[200,77,231]);
  for(const b of bridges)for(let rx=b.rxStart;rx<=b.rxEnd;rx++)for(let y=0;y<3;y++)cell(rx,b.ry+y,[179,157,107]);
  for(const item of doc.terrain.values())cell(item.rx,item.ry,[255,198,88]);
  for(const item of doc.structures.values())cell(item.rx,item.ry,[190,195,180]);
  for(const spawn of doc.spawns){
    const{x,y}=xy(spawn.rx,spawn.ry),team=spawn.number<8?[43,140,223]:[210,68,58];
    for(let dx=-15;dx<=15;dx++)for(let dy=-15;dy<=15;dy++)if(dx*dx+dy*dy<=225)pixel(x+dx,y+dy,team);
    const digits=String(spawn.number+1),left=x-digits.length*4+1;
    for(let i=0;i<digits.length;i++)for(let row=0;row<5;row++)for(let col=0;col<3;col++)if(DIGITS[+digits[i]][row*3+col]==='1')for(let sx=0;sx<2;sx++)for(let sy=0;sy<2;sy++)pixel(left+i*8+col*2+sx,y-5+row*2+sy,[255,255,238]);
  }
  const header=Buffer.alloc(13),rows=Buffer.alloc((width*3+1)*height);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  for(let y=0;y<height;y++)rows.set(rgb.subarray(y*width*3,(y+1)*width*3),y*(width*3+1)+1);
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
  return {width,height,rgb,png};
}

export function auditTeamMap(doc,bridges){
  assert.equal(doc.spawns.length,16);assert.equal(doc.spawnLimit,16);
  assert.equal(doc.terrain.size,32);assert.equal(doc.structures.size,12);
  const bridgeCells=new Set(),key=(x,y)=>x+','+y;
  for(const b of bridges)for(let rx=b.rxStart;rx<=b.rxEnd;rx++)for(let y=0;y<3;y++){
    const tile=codec.tileAtCell(doc,rx,b.ry+y);assert.ok(tile&&codec.isPlayableCell(doc,tile.rx,tile.ry));bridgeCells.add(key(tile.rx,tile.ry));
    const overlay=doc.overlays.get(tile.ry*512+tile.rx);
    assert.ok(overlay,'Every bridge piece needs all three serialized lane markers');
    assert.equal(overlay.value,y);assert.equal(overlay.id,rx===b.rxStart?94:rx===b.rxEnd?92:74);
  }
  const passable=(x,y)=>{const tile=codec.tileAtCell(doc,x,y);return tile&&codec.isPlayableCell(doc,x,y)&&(tile.tileNum!==314||bridgeCells.has(key(x,y)))&&!doc.terrain.has(y*1000+x)&&![...doc.structures.values()].some(h=>h.rx===x&&h.ry===y);};
  const flood=start=>{const seen=new Set([key(start.rx,start.ry)]),queue=[start];for(let i=0;i<queue.length;i++){const p=queue[i];for(const[x,y]of[[p.rx-1,p.ry],[p.rx+1,p.ry],[p.rx,p.ry-1],[p.rx,p.ry+1]])if(!seen.has(key(x,y))&&passable(x,y)){seen.add(key(x,y));queue.push({rx:x,ry:y});}}return seen;};
  for(let i=0;i<8;i++){
    const a=doc.spawns[i],b=doc.spawns[i+8];assert.equal(a.rx,b.ry);assert.equal(a.ry,b.rx);
    for(let x=-6;x<=6;x++)for(let y=-6;y<=6;y++){
      assert.ok(passable(a.rx+x,a.ry+y),'A start needs clear buildable space');
      assert.ok(passable(b.rx+x,b.ry+y),'B start needs clear buildable space');
      assert.equal(doc.overlays.has((a.ry+y)*512+a.rx+x),false);
      assert.equal(doc.overlays.has((b.ry+y)*512+b.rx+x),false);
    }
  }
  for(const item of doc.overlays.values())if(item.id===codec.OVERLAY_IDS.GEMS){
    const mirror=doc.overlays.get(item.rx*512+item.ry);assert.ok(mirror&&mirror.id===item.id&&mirror.value===item.value,'Mirrored resource quantity');
  }
  const reached=flood(doc.spawns[0]);assert.ok(doc.spawns.every(p=>reached.has(key(p.rx,p.ry))),'All sixteen starts must share a vehicle route');
  const intactSize=reached.size;bridgeCells.clear();const noBridge=flood(doc.spawns[0]);assert.ok(doc.spawns.slice(8).every(p=>!noBridge.has(key(p.rx,p.ry))),'The river must really separate the teams');
  return {spawns:16,leftStartNumbers:[1,2,3,4,5,6,7,8],rightStartNumbers:[9,10,11,12,13,14,15,16],
    dimensions:[160,144],gemCells:[...doc.overlays.values()].filter(i=>i.id===codec.OVERLAY_IDS.GEMS).length,mines:32,minesPerPlayer:2,
    bridgeGroups:3,bridges:6,bridgeWidthCells:3,repairHuts:12,spawnClearRadius:6,
    riverWidthProjectedColumns:2*TEAM_RIVER_HALF_WIDTH+1,previousRiverWidthProjectedColumns:21,
    mirroredStartsAndResources:true,allStartsConnectedWithBridges:true,teamsSeparatedWithoutBridges:true,reachableCells:intactSize,
    pathCheckScope:'Cardinal flat-ground flood with native bridge foundations; actual native movement requires runtime acceptance'};
}

export async function addTeamBattleMap(root){
  const maps=path.join(root,'maps'),load=name=>JSON.parse(fs.readFileSync(path.join(maps,name))),save=(name,data)=>fs.writeFileSync(path.join(maps,name),JSON.stringify(data,null,2)+'\n');
  const {doc,bridges}=createTeamBattleMap(),preview=teamMapPreview(doc,bridges);
  const thumbWidth=preview.width/2,thumbHeight=preview.height/2,thumbnail=Buffer.alloc(thumbWidth*thumbHeight*3);
  for(let y=0;y<thumbHeight;y++)for(let x=0;x<thumbWidth;x++)thumbnail.set(preview.rgb.subarray((2*y*preview.width+2*x)*3,(2*y*preview.width+2*x)*3+3),(y*thumbWidth+x)*3);
  codec.setIniValue(doc,'Preview','Size',`0,0,${thumbWidth},${thumbHeight}`);
  const packed=codec.bytesToBase64(codec.encodePacked(thumbnail));
  for(let i=0;i<packed.length;i+=70)codec.setIniValue(doc,'PreviewPack',String(i/70+1),packed.slice(i,i+70));
  const text=codec.serializeMap(doc),bytes=Buffer.from(text),sha256=sha(bytes),file=`wl_team8v8_${sha256.slice(0,24)}.map`,previewFile=file.replace('.map','.png');
  assert.ok(bytes.length<=2*1024*1024,'Keep the map importable by the existing editor and native transfer');
  const roundTrip=codec.parseMap(text),design=auditTeamMap(roundTrip,bridges);
  const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'))),mods=JSON.parse(fs.readFileSync(path.join(root,'mods.json')));
  const mod=mods.mods.find(item=>item.id===config.forcedModId),modPath=mod?.download?new URL(mod.download,'https://local.invalid/').pathname:'';
  const mirror=modPath&&!modPath.startsWith('/mod/')?{localForcedModArchive:'mod/'+modPath.split('/').at(-1)}:{};
  const native=await loadNativeResources(root,mirror),app=fs.readFileSync(path.join(root,'js/app.js'),'utf8');
  const scan=scanMapCompatibility({text,sourceMap:{source:{kind:'multiplayer_map'}},native,codec});assert.equal(scan.compatible,true,JSON.stringify(scan.reasons));
  const reader=compileContentReader(app),fingerprint=fingerprintMap(text,{reader,native,map:{gameModes:['standard']}});
  const catalog=load('catalog.json'),index=load('game-index.json'),report=load('deduplication-report.json');
  const previousMaps=catalog.maps.filter(m=>m.source==='winlife'&&m.file.startsWith('wl_team8v8_'));
  const previousFiles=new Set(previousMaps.map(m=>m.file));
  assert.ok(!report.maps.some(m=>m.file!==file&&m.fingerprint?.sha256===fingerprint.sha256),'A duplicate map already exists');
  assert.ok(!report.builtinMaps.some(m=>m.fingerprint?.sha256===fingerprint.sha256),'A built-in duplicate already exists');
  const record={file,title:TEAM_MAP_TITLE,originalTitle:TEAM_MAP_TITLE,players:16,author:'Winlife',source:'winlife',sourceLabel:'Winlife 原创',sourcePage:'/map-editor/',theater:'TEMPERATE',
    sha256,bytes:bytes.length,crc32:crc32(bytes),compatible:true,reasons:[],reasonCodes:[],gameModes:['standard'],requiresExtendedClient:true,runtimeVerified:false,
    preview:'/maps/previews/'+previewFile,previewSha256:sha(preview.png),previewFormat:'png',tags:['8v8','团队对战','河流','桥梁','紫矿'],
    designId:TEAM_MAP_ID,resourceType:'gems',regeneratingMines:32,riverWidthProjectedColumns:design.riverWidthProjectedColumns,recommendedTeams:[{team:1,starts:design.leftStartNumbers},{team:2,starts:design.rightStartNumbers}],
    description:'8v8 两队对战：1–8号位在左岸，9–16号位在右岸。三组双桥连接两岸，每个位置两处紫矿与矿井；桥边可用工程师修桥。请在房间自行选定对应起始位置和队伍。',
    deduplication:{version:1,groupId:fingerprint.sha256,representativeFile:file,isRepresentative:true,versionCount:1,categories:fingerprint.categories}};
  fs.writeFileSync(path.join(maps,'files',file),bytes);fs.writeFileSync(path.join(maps,'previews',previewFile),preview.png);
  const old=catalog.maps.find(m=>m.designId===TEAM_MAP_ID);assert.ok(!old||old.file===file,'Publish a new explicit design revision for changed maps');
  catalog.maps=catalog.maps.filter(m=>!previousFiles.has(m.file));catalog.maps.push(record);
  index.maps=index.maps.filter(m=>!previousFiles.has(m.file));index.maps.push(record);
  catalog.total=catalog.maps.length;catalog.compatibleCount=catalog.maps.filter(m=>m.compatible).length;catalog.uniqueTotalCount=catalog.maps.filter(m=>m.deduplication?.isRepresentative!==false).length;catalog.uniqueCompatibleCount=index.maps.length;
  report.maps=report.maps.filter(m=>!previousFiles.has(m.file));report.maps.push({file,comparedFile:file,title:record.title,players:16,compatible:true,fingerprint});
  report.archivedFiles=catalog.maps.length;report.comparedMaps=report.maps.filter(m=>m.fingerprint).length;report.uniqueMaps=catalog.uniqueTotalCount;report.compatibleBefore=catalog.compatibleCount;report.compatibleAfter=index.maps.length;
  save('catalog.json',catalog);save('game-index.json',index);save('deduplication-report.json',report);
  const evidence={verifiedAt:new Date().toISOString(),file,sha256,preview:record.preview,previewSha256:record.previewSha256,design,bridges,nativeReader:reader.evidence,compatibility:scan,
    nativeBridgeIds:{middle:74,start:94,end:92,type:'native wooden low bridge',foundation:[1,3],serializedLaneValues:[0,1,2]},
    previousVersions:previousMaps.map(m=>({file:m.file,sha256:m.sha256,designId:m.designId})),runtimeVerified:false};
  save('team-battle-verification.json',evidence);
  const verification=load('compatibility-verification.json');
  verification.gameIndexCount=index.maps.length;verification.gameIndexBytes=fs.statSync(path.join(maps,'game-index.json')).size;verification.gameIndexSha256=sha(fs.readFileSync(path.join(maps,'game-index.json')));verification.catalogSha256=sha(fs.readFileSync(path.join(maps,'catalog.json')));verification.teamBattleMapVerification='/maps/team-battle-verification.json';
  save('compatibility-verification.json',verification);
  return record;
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname)console.log(JSON.stringify(await addTeamBattleMap(path.resolve(process.argv[2]))));
