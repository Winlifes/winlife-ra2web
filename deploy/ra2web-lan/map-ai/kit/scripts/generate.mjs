import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMap,serializeMap,playableBounds,tileAtDisplay,tileAtCell,setSpawn,setOverlay,setTerrain,addStructure,OVERLAY_IDS} from '../lib/map-codec.mjs';
import {profile,sha256,safeText,cliArgs,writeJson} from '../lib/common.mjs';
import {validateMap} from './validate.mjs';
import {previewSvg} from './preview.mjs';

export function generateMap(spec){
  if(spec.schemaVersion!==1)throw new Error('Expected design schemaVersion=1');
  const allowed=new Set(['schemaVersion','name','author','intent','width','height','theater','players','spawns','water','homeResources','resourceZones','structures','trees','validation']);
  for(const key of Object.keys(spec))if(!allowed.has(key))throw new Error('Unknown design property: '+key);
  const validationKeys=new Set(['baseClearRadius','minLaneWidth','homeResourceRadius','balanced','resourceTolerance']);
  for(const key of Object.keys(spec.validation||{}))if(!validationKeys.has(key))throw new Error('Unknown validation property: '+key);
  if(spec.validation?.balanced!==undefined&&typeof spec.validation.balanced!=='boolean')throw new Error('balanced must be a boolean');
  function known(object,keys,label){for(const key of Object.keys(object))if(!keys.includes(key))throw new Error('Unknown '+label+' property: '+key);}
  for(const spawn of spec.spawns||[])known(spawn,['position','suggestedTeam'],'spawn');
  for(const zone of spec.water||[])known(zone,['rect'],'water');
  for(const zone of spec.resourceZones||[])known(zone,['position','kind','radius','value'],'resource zone');
  for(const object of [...(spec.trees||[]),...(spec.structures||[])])known(object,['position','type'],'object');
  if(spec.homeResources)known(spec.homeResources,['offsets','radius','value'],'homeResources');
  const name=safeText(spec.name,'name'),author=safeText(spec.author||'Map author','author');
  const doc=createMap({width:spec.width,height:spec.height,theater:spec.theater,name,author,players:spec.players});
  if(!profile.theaters[spec.theater])throw new Error('Use TEMPERATE or SNOW for this profile');
  if(!Array.isArray(spec.spawns)||spec.spawns.length!==spec.players)throw new Error('Provide exactly N spawn objects in intended player order');
  const b=playableBounds(doc),usable=t=>t&&t.dx>=b.x&&t.dx<b.x+b.width&&t.dy>=b.y&&t.dy<b.y+b.height;
  function locate(position){
    if(!Array.isArray(position)||position.length!==2||position.some(v=>!Number.isFinite(v)||v<0||v>1))throw new Error('Positions are [u,v] within 0..1 of the playable projection');
    const dx=Math.round(b.x+position[0]*(b.width-1));let dy=Math.round(b.y+position[1]*(b.height-1));
    if((dx&1)!==(dy&1))dy=dy+1<b.y+b.height?dy+1:dy-1;
    const tile=tileAtDisplay(doc,dx,Math.floor(dy/2));if(!usable(tile))throw new Error('Cannot snap this normalized position to a playable tile');return tile;
  }
  doc.spawns=[];spec.spawns.forEach((spawn,index)=>{const tile=locate(spawn.position);setSpawn(doc,index,tile.rx,tile.ry);});
  const tiles=doc.tiles.filter(usable),clearRadius=spec.validation?.baseClearRadius??4;
  if(!Number.isInteger(clearRadius)||clearRadius<3||clearRadius>8)throw new Error('baseClearRadius must be 3..8');
  const protectedCell=(rx,ry)=>doc.spawns.some(s=>Math.max(Math.abs(s.rx-rx),Math.abs(s.ry-ry))<=clearRadius);
  const normalized=t=>[(t.dx-b.x)/(b.width-1),(t.dy-b.y)/(b.height-1)];
  for(const zone of spec.water||[]){
    if(!Array.isArray(zone.rect)||zone.rect.length!==4||zone.rect.some(v=>!Number.isFinite(v)||v<0||v>1)||zone.rect[0]>=zone.rect[2]||zone.rect[1]>=zone.rect[3])throw new Error('Water rect is [u0,v0,u1,v1] within 0..1');
    for(const t of tiles){const[u,v]=normalized(t);if(u>=zone.rect[0]&&u<=zone.rect[2]&&v>=zone.rect[1]&&v<=zone.rect[3]){if(protectedCell(t.rx,t.ry))throw new Error('Water intersects a reserved base square');t.tileNum=314;t.subTile=(t.rx&1)+2*(t.ry&1);}}
  }
  function resourcePatch(rx,ry,kind,radius,value){
    if(!['ore','gems'].includes(kind)||!Number.isInteger(radius)||radius<1||radius>8||!Number.isInteger(value)||value<1||value>11)throw new Error('Invalid resource patch');
    for(let y=-radius;y<=radius;y++)for(let x=-radius;x<=radius;x++){
      const t=tileAtCell(doc,rx+x,ry+y);
      if(!usable(t)||t.tileNum!==0||protectedCell(t.rx,t.ry)||doc.overlays.has(t.ry*512+t.rx))throw new Error('Resource patch overlaps another patch, water, map edge or a reserved base square');
      setOverlay(doc,t.rx,t.ry,kind==='ore'?OVERLAY_IDS.ORE:OVERLAY_IDS.GEMS,value);
    }
  }
  const home=spec.homeResources||{offsets:[[7,5],[-7,-5]],radius:2,value:11};
  if(!Array.isArray(home.offsets)||!home.offsets.length||home.offsets.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isInteger(v)||Math.abs(v)>32)))throw new Error('Home resource offsets are integer [deltaRx,deltaRy] pairs');
  for(const spawn of doc.spawns)for(const offset of home.offsets)resourcePatch(spawn.rx+offset[0],spawn.ry+offset[1],'ore',home.radius,home.value);
  for(const zone of spec.resourceZones||[]){const t=locate(zone.position);resourcePatch(t.rx,t.ry,zone.kind,zone.radius,zone.value??11);}
  for(const object of spec.trees||[]){if(!profile.trees.includes(object.type))throw new Error('Unverified tree ID: '+object.type);const t=locate(object.position);setTerrain(doc,t.rx,t.ry,object.type);}
  for(const object of spec.structures||[]){if(!profile.structures[object.type])throw new Error('Unverified structure ID: '+object.type);const t=locate(object.position);addStructure(doc,{name:object.type,rx:t.rx,ry:t.ry});}
  return serializeMap(doc);
}

export function runtimeTemplate(mapSha256){
  return {schemaVersion:1,mapSha256,status:'pending',runtimeVerified:false,testedClient:null,testedMod:null,
    checks:Object.fromEntries(['editorImportExport','roomPlayerCount','allSpawnPositions','mcvAndBuildingPlacement','resourceHarvesting','groundRoutes','aiSmoke','twoClientMapTransfer','networkHashes','visualAndPerformance','normalExit'].map(name=>[name,{status:'pending',evidence:[],notes:''}])),
    note:'Fill only after observing the actual game. Static and native decoder tests do not fill these results.'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const{positional,options}=cliArgs(process.argv.slice(2));if(!positional[0]||!options.out)throw new Error('Usage: node scripts/generate.mjs DESIGN.json --out NEW_OUTPUT_DIRECTORY');
    const spec=JSON.parse(fs.readFileSync(positional[0])),out=path.resolve(options.out);if(fs.existsSync(out))throw new Error('Output directory already exists; choose a new one');
    const text=generateMap(spec),bytes=Buffer.from(text),report=validateMap(bytes,spec),filename='wl_ai_'+report.mapSha256.slice(0,24)+'.map';
    fs.mkdirSync(out,{recursive:true});writeJson(out+'/static-report.json',report);writeJson(out+'/design.json',spec);
    if(!report.staticPassed){console.error(JSON.stringify({status:'fail',report:out+'/static-report.json',errors:report.errors},null,2));process.exitCode=1;}
    else{
      fs.writeFileSync(out+'/'+filename,bytes);fs.writeFileSync(out+'/preview.svg',previewSvg(text));writeJson(out+'/runtime-acceptance.json',runtimeTemplate(report.mapSha256));
      console.log(JSON.stringify({status:report.status,map:out+'/'+filename,sha256:sha256(bytes),preview:out+'/preview.svg',staticReport:out+'/static-report.json',runtimeAcceptance:out+'/runtime-acceptance.json'},null,2));
    }
  }catch(error){console.error(error.stack);process.exitCode=1;}
}
