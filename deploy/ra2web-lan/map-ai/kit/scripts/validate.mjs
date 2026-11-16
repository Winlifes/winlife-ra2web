import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseMap, serializeMap, decodePacked, playableBounds, tileAtCell, OVERLAY_IDS} from '../lib/map-codec.mjs';
import {readWithNativeDecoder} from '../lib/native-reader.mjs';
import {profile, sha256, cellKey, parseIniStrict, cliArgs, writeJson} from '../lib/common.mjs';

const allowed = new Set(['BASIC','MAP','LIGHTING','SPECIALFLAGS','WAYPOINTS','TERRAIN','STRUCTURES','ISOMAPPACK5','OVERLAYPACK','OVERLAYDATAPACK']);
const basicKeys = new Set(['NEWINIFORMAT','NAME','AUTHOR','MULTIPLAYERONLY','OFFICIAL','GAMEMODE','MINPLAYER','MAXPLAYER','WINLIFEMAXPLAYERS','TIBERIUMGROWTHENABLED','VEINGROWTHENABLED']);
const sectionKeys={MAP:new Set(['SIZE','LOCALSIZE','THEATER']),LIGHTING:new Set(['AMBIENT','RED','GREEN','BLUE','LEVEL','GROUND']),SPECIALFLAGS:new Set(['INITIALVETERAN'])};
const canonicalInteger = value => /^(?:0|[1-9]\d*)$/.test(value);
const sorted = rows => rows.sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);
function distances(mask, start) {
  const result=new Int32Array(512*512).fill(-1),queue=new Int32Array(mask.length);let head=0,tail=0;
  if(!mask[start])return result;result[start]=0;queue[tail++]=start;
  while(head<tail){const key=queue[head++],x=key%512,y=Math.floor(key/512),next=result[key]+1;
    for(const n of [x>0?key-1:-1,x<511?key+1:-1,y>0?key-512:-1,y<511?key+512:-1])if(n>=0&&mask[n]&&result[n]===-1){result[n]=next;queue[tail++]=n;}}
  return result;
}
function erode(mask, radius) {
  const out=new Uint8Array(mask.length);
  for(let key=0;key<mask.length;key++)if(mask[key]){const x=key%512,y=Math.floor(key/512);let clear=true;
    for(let dy=-radius;dy<=radius&&clear;dy++)for(let dx=-radius;dx<=radius;dx++)if(x+dx<0||x+dx>511||y+dy<0||y+dy>511||!mask[cellKey(x+dx,y+dy)]){clear=false;break;}
    if(clear)out[key]=1;
  }return out;
}

export function validateMap(input, design={}) {
  const bytes=Buffer.isBuffer(input)?input:Buffer.from(input);
  const report={schemaVersion:1,profile:profile.name,mapSha256:sha256(bytes),bytes:bytes.length,status:'fail',staticPassed:false,nativeDecoded:false,
    runtimeVerified:false,runtime:{status:'not-run',note:'Static geometry and native data decoding do not execute the game.'},errors:[],warnings:[],stats:{}};
  const fail=(code,message)=>report.errors.push({code,message});
  try {
    if(bytes.length>profile.maxBytes)throw new Error('Map exceeds the 2 MiB game-transfer limit');
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    const ini=parseIniStrict(text),sections=ini.sections,get=(s,k)=>sections.get(s)?.get(k);
    for(const error of ini.errors)fail('ambiguous-ini',error);
    for(const name of sections.keys())if(!allowed.has(name))fail('outside-profile','Section ['+name+'] needs a separate native audit; preserve the source instead of stripping it');
    for(const key of sections.get('BASIC')?.keys()||[])if(!basicKeys.has(key))fail('outside-profile','Unverified Basic property: '+key);
    for(const[name,keys]of Object.entries(sectionKeys))for(const key of sections.get(name)?.keys()||[])if(!keys.has(key))fail('outside-profile','Unverified '+name+' property: '+key);
    const doc=parseMap(text),n=Number(get('BASIC','MAXPLAYER')),cap=get('BASIC','WINLIFEMAXPLAYERS');
    report.stats={name:doc.metadata.name,theater:doc.metadata.theater,dimensions:[doc.fullSize.width,doc.fullSize.height],players:n,tiles:doc.tiles.length,structures:doc.structures.size,trees:doc.terrain.size};
    if(!Number.isInteger(n)||n<2||n>16)fail('player-count','MaxPlayer must be an integer 2..16');
    if(doc.fullSize.width<32||doc.fullSize.height<32||doc.fullSize.width>160||doc.fullSize.height>160)fail('dimensions','This authoring profile uses width and height 32..160');
    if(doc.fullSize.x!==0||doc.fullSize.y!==0)fail('map-origin','New maps use Size=0,0,width,height');
    if(!profile.theaters[doc.metadata.theater])fail('theater','This profile supports TEMPERATE and SNOW');
    if(get('BASIC','NEWINIFORMAT')!=='4'||get('BASIC','GAMEMODE')!=='standard'||get('BASIC','MULTIPLAYERONLY')?.toLowerCase()!=='yes')fail('map-mode','Use NewINIFormat=4, GameMode=standard and MultiplayerOnly=yes');
    if(get('BASIC','OFFICIAL')?.toLowerCase()!=='no')fail('official-flag','Original generated maps use Official=no');
    for(const key of ['TIBERIUMGROWTHENABLED','VEINGROWTHENABLED'])if(get('BASIC',key)!==undefined&&!['yes','no'].includes(get('BASIC',key).toLowerCase()))fail('boolean-field','Invalid boolean: '+key);
    for(const[key,value]of sections.get('LIGHTING')||[]){const number=Number(value),level=['LEVEL','GROUND'].includes(key);if(!value||!Number.isFinite(number)||number<(level?-1:0)||number>2)fail('lighting','Invalid lighting value: '+key);}
    if(get('SPECIALFLAGS','INITIALVETERAN')!==undefined&&!['yes','no'].includes(get('SPECIALFLAGS','INITIALVETERAN').toLowerCase()))fail('boolean-field','Invalid InitialVeteran');
    if(n>8&&cap!==String(n)||n<=8&&cap!==undefined)fail('extended-player-marker','Maps above 8 need WinlifeMaxPlayers=N; ordinary maps omit it');
    if(!Number.isInteger(Number(get('BASIC','MINPLAYER')))||Number(get('BASIC','MINPLAYER'))<2||Number(get('BASIC','MINPLAYER'))>n)fail('min-players','MinPlayer must be 2..MaxPlayer');
    if(doc.metadata.name==='Untitled map'||!doc.metadata.name.trim())fail('name','Set a real map name');
    for(const warning of doc.warnings)fail('codec-warning',warning);
    const bounds=playableBounds(doc),playable=t=>t&&t.dx>=bounds.x&&t.dx<bounds.x+bounds.width&&t.dy-t.z>=bounds.y&&t.dy-t.z<bounds.y+bounds.height;
    if(bounds.width<=0||bounds.height<=0)fail('local-size','Empty playable LocalSize');
    const encoded=decodePacked([...(sections.get('ISOMAPPACK5')?.values()||[])].join(''),5);
    const expected=(2*doc.fullSize.width-1)*doc.fullSize.height;
    if(encoded.length!==expected*11+4)fail('tile-pack-length','New maps must contain every cell plus the four-byte tile tail');
    const encodedCells=new Set(),view=new DataView(encoded.buffer,encoded.byteOffset,encoded.byteLength);
    for(let i=0;i<Math.min(expected,Math.floor(encoded.length/11));i++){
      const rx=view.getUint16(i*11,true),ry=view.getUint16(i*11+2,true),key=cellKey(rx,ry);
      if(rx>511||ry>511||!tileAtCell(doc,rx,ry))fail('tile-coordinate','Encoded cell outside the real staggered grid: '+rx+','+ry);
      if(encodedCells.has(key))fail('duplicate-tile','Duplicate encoded cell: '+rx+','+ry);encodedCells.add(key);
    }
    const walk=new Uint8Array(512*512),occupied=new Set(),water=new Set(),invalidTiles=new Set();
    for(const tile of doc.tiles){
      const palette=profile.theaters[doc.metadata.theater]?.[tile.tileNum];
      if(!palette?.subtiles[tile.subTile]||tile.z!==0||(tile.tileNum===0&&tile.subTile!==0))invalidTiles.add(tile.tileNum+':'+tile.subTile+':z'+tile.z);
      if(tile.tileNum===314)water.add(cellKey(tile.rx,tile.ry));
      if(playable(tile)&&tile.tileNum===0&&tile.z===0)walk[cellKey(tile.rx,tile.ry)]=1;
    }
    if(invalidTiles.size)fail('terrain-profile','Unverified terrain combinations: '+[...invalidTiles].slice(0,12).join(', '));
    if(water.size)report.warnings.push('Water cells are real native tiles; shore art is not generated and needs in-game visual review.');
    const reserve=(rx,ry,label)=>{const key=cellKey(rx,ry);if(rx<0||rx>511||ry<0||ry>511||!playable(tileAtCell(doc,rx,ry))||water.has(key))fail('object-location',label+' is outside playable land');if(occupied.has(key))fail('object-overlap',label+' overlaps another object');occupied.add(key);walk[key]=0;};
    if((sections.get('TERRAIN')?.size||0)!==doc.terrain.size||(sections.get('STRUCTURES')?.size||0)!==doc.structures.size)fail('object-record','Malformed or aliased object entries were skipped by the codec');
    for(const key of sections.get('TERRAIN')?.keys()||[])if(!canonicalInteger(key))fail('tree-key','Terrain coordinate keys must be canonical decimal integers');
    for(const [key,tree]of doc.terrain){if(!profile.trees.includes(tree.name))fail('tree-type','Unverified terrain object: '+tree.name);if(key!==tree.ry*1000+tree.rx)fail('tree-key','Terrain keys use ry*1000+rx');reserve(tree.rx,tree.ry,tree.name);}
    for(const [id,object]of doc.structures){
      const spec=profile.structures[object.name];
      if(!spec){fail('structure-type','Unverified neutral structure: '+object.name);continue;}
      if(object.owner!=='Neutral'||object.tag!=='None'||!Number.isInteger(object.health)||object.health<1||object.health>256)fail('structure-fields','Use neutral, untagged structures with health 1..256: '+id);
      const fields=object.fields;if(fields.length!==17||fields[7]!=='1'||fields[8]!=='0'||fields.slice(10).some(v=>v!=='0')||!['0','1'].includes(fields[9])||!Number.isInteger(object.direction)||object.direction<0||object.direction>255)fail('structure-fields','Unverified structure CSV flags: '+id);
      for(let y=0;y<spec.foundation[1];y++)for(let x=0;x<spec.foundation[0];x++)reserve(object.rx+x,object.ry+y,object.name);
    }
    const coordinates=new Set(),numbers=new Set(),starts=[...doc.spawns].sort((a,b)=>a.number-b.number);
    for(const [key,value]of sections.get('WAYPOINTS')||[])if(!canonicalInteger(key)||!canonicalInteger(value))fail('waypoint-integer','Waypoint numbers and coordinate values must be canonical nonnegative decimal integers');
    if(starts.length!==n||starts.some((point,index)=>point.number!==index))fail('spawn-sequence','Need consecutive start IDs 0..N-1, with no aliases, omissions or extra starts');
    const clearRadius=design.validation?.baseClearRadius??4;
    if(!Number.isInteger(clearRadius)||clearRadius<3||clearRadius>8)throw new Error('baseClearRadius must be an integer 3..8');
    if(starts.length>16)throw new Error('More than sixteen encoded player starts');
    for(const point of starts){
      const key=cellKey(point.rx,point.ry);if(numbers.has(point.number)||coordinates.has(key))fail('spawn-duplicate','Duplicate player ID or spawn position');numbers.add(point.number);coordinates.add(key);
      if(!playable(tileAtCell(doc,point.rx,point.ry))||!walk[key])fail('spawn-land','Start '+(point.number+1)+' is not on playable clear land');
      let blocked=0;
      for(let y=-clearRadius;y<=clearRadius;y++)for(let x=-clearRadius;x<=clearRadius;x++){
        const rx=point.rx+x,ry=point.ry+y,tile=rx>=0&&ry>=0?tileAtCell(doc,rx,ry):undefined;
        if(!playable(tile)||!walk[cellKey(rx,ry)]||doc.overlays.has(cellKey(rx,ry)))blocked++;
      }
      if(blocked)fail('base-clearance','Start '+(point.number+1)+' has '+blocked+' obstructed cells in its reserved base square');
    }
    if(!!sections.get('OVERLAYPACK')!==!!sections.get('OVERLAYDATAPACK'))fail('overlay-pair','OverlayPack and OverlayDataPack must be present together');
    const resources=[];
    for(const item of doc.overlays.values()){
      if(!profile.allowedOverlayIds.includes(item.id)||!Number.isInteger(item.value)||item.value<0||item.value>11)fail('overlay-profile','Only native ore/gems with value 0..11 belong to this profile');
      if(!playable(tileAtCell(doc,item.rx,item.ry))||water.has(cellKey(item.rx,item.ry))||occupied.has(cellKey(item.rx,item.ry)))fail('resource-location','Resource on water, object or outside playable area');
      if(item.value>0)resources.push(item);
    }
    const fromStarts=starts.map(p=>distances(walk,cellKey(p.rx,p.ry)));
    if(starts.some(p=>fromStarts[0]?.[cellKey(p.rx,p.ry)]<0))fail('land-connectivity','The conservative flat-land graph does not connect all starts');
    const laneWidth=design.validation?.minLaneWidth??3;
    if(![3,5,7].includes(laneWidth))fail('lane-policy','minLaneWidth must be 3, 5 or 7');
    else if(starts.length){const lanes=distances(erode(walk,(laneWidth-1)/2),cellKey(starts[0].rx,starts[0].ry));if(starts.some(p=>lanes[cellKey(p.rx,p.ry)]<0))fail('lane-width-proxy','Not every start is connected after '+laneWidth+'-cell clearance erosion');}
    const radius=design.validation?.homeResourceRadius??18,tolerance=design.validation?.resourceTolerance??0.1;
    if(!Number.isInteger(radius)||radius<8||radius>64||!Number.isFinite(tolerance)||tolerance<0||tolerance>1)throw new Error('Invalid resource validation policy');
    const budgets=starts.map(p=>({player:p.number+1,oreCells:0,gemCells:0,nearestResourceSteps:null}));
    for(const item of resources){const key=cellKey(item.rx,item.ry),steps=fromStarts.map(d=>d[key]);const positive=steps.filter(v=>v>=0),best=positive.length?Math.min(...positive):Infinity;
      for(let i=0;i<steps.length;i++)if(steps[i]>=0&&steps[i]<=radius){if(budgets[i].nearestResourceSteps===null||steps[i]<budgets[i].nearestResourceSteps)budgets[i].nearestResourceSteps=steps[i];if(steps[i]===best)budgets[i][item.id===OVERLAY_IDS.ORE?'oreCells':'gemCells']++;}}
    for(const budget of budgets)if(budget.nearestResourceSteps===null)fail('home-resources','No reachable resource within '+radius+' graph steps of player '+budget.player);
    if(design.validation?.balanced!==false)for(const type of ['oreCells','gemCells']){const values=budgets.map(b=>b[type]),max=Math.max(0,...values),min=Math.min(...values);if(max&&(max-min)/max>tolerance)fail('resource-balance-proxy','Home '+type+' difference exceeds the declared tolerance');}
    report.stats.homeResourceProxy=budgets;report.stats.conservativeLaneWidth=laneWidth;report.stats.baseClearRadius=clearRadius;
    report.warnings.push('Graph routes, base squares and resource-cell counts are design proxies, not the game\'s collision, building placement or economic model.');
    report.warnings.push('Resource profile uses base plus overlay data. Record and test the actual active MOD separately.');
    if(serializeMap(doc)!==text)fail('roundtrip','Unedited parse/serialize changed the delivered map bytes');
    const decoded=readWithNativeDecoder(text);
    const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    if(!equal(sorted(decoded.tiles),sorted(doc.tiles.map(t=>[t.rx,t.ry,Math.max(0,t.tileNum),t.subTile,t.z]))))fail('native-tiles','Original game decoder disagrees with codec tiles');
    if(!equal(sorted(decoded.overlays),sorted(resources.length||doc.overlays.size?[...doc.overlays.values()].map(o=>[o.rx,o.ry,o.id,o.value]):[])))fail('native-overlays','Original game decoder disagrees with codec overlays');
    if(!equal(sorted(decoded.waypoints),sorted(doc.waypoints.map(w=>[w.number,w.rx,w.ry]))))fail('native-waypoints','Original game decoder disagrees with waypoints');
    if(!equal(decoded.starts,starts.map(p=>[p.rx,p.ry])))fail('native-starts','Original game decoder disagrees with multiplayer starts');
    report.nativeDecoded=!report.errors.some(e=>e.code.startsWith('native-'));
  }catch(error){fail('validation-exception',error.message);}
  report.staticPassed=report.errors.length===0;
  report.status=report.staticPassed?'static-pass-runtime-pending':'fail';
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const{positional,options}=cliArgs(process.argv.slice(2));if(!positional[0])throw new Error('Usage: node scripts/validate.mjs FILE.map [--design design.json] [--report static-report.json]');
    const report=validateMap(fs.readFileSync(positional[0]),options.design?JSON.parse(fs.readFileSync(options.design)):{});
    if(options.report)writeJson(options.report,report);console.log(JSON.stringify(report,null,2));if(!report.staticPassed)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
