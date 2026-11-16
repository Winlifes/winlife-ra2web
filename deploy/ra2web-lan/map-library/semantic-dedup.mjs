/** Content comparison for the installed game profile. Does not rewrite maps. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {decodePacked} from '../map-editor/map-codec.mjs';
import {loadNativeResources,parseIniSections,createGameIndex} from './build-catalog.mjs';
import {dormantTypeOverrides,inactiveEditorMetadata} from './native-rule-audit.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>sha(JSON.stringify(value));
const codeSlice=(source,start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0)throw new Error('Native content signature missing: '+start);return source.slice(a,b);};
export const CATEGORIES=['terrain','spawns','resources','objects','rules','scripts'];
const PACKS=new Set(['IsoMapPack5','OverlayPack','OverlayDataPack']);
const OBJECTS=new Set(['Structures','Units','Infantry','Aircraft','Terrain','Smudge']);
const SCRIPT_SECTIONS=new Set(['Tags','Triggers','Events','Actions','CellTags','VariableNames','Variables','LocalVariables','GlobalVariables','TaskForces','ScriptTypes','TeamTypes','AITriggerTypes','AITriggerTypesEnable']);
const TYPE_TABLES=['InfantryTypes','VehicleTypes','AircraftTypes','BuildingTypes','TerrainTypes','SmudgeTypes','OverlayTypes','Animations','Warheads','SuperWeaponTypes','WeaponTypes','VoxelAnims','Particles','ParticleSystems','Countries'];
export function decodeMapBytes(bytes){try{return new TextDecoder('utf8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('windows-1252').decode(bytes);}}

/** Execute original INI and scene readers, with primitive I/O adapters only. */
export function compileContentReader(source){
  const iniCode=codeSlice(source,'class Ni{','var Ve;')+codeSlice(source,'class fs{','const oX=');
  const sceneMethods=codeSlice(source,'readTiles(){const e=this.getSection("IsoMapPack5")','decodePreviewImage(){');
  for(const signature of ['readWaypoints(e){','readStructures(e){','readVehicles(){','readInfantries(){','readAircrafts(){','readTerrains(e){','readOverlays(){','readSmudges(){'])if(!sceneMethods.includes(signature))throw new Error('Missing scene reader '+signature);
  const warnings=[];
  const context=vm.createContext({console:{warn:(...args)=>{if(warnings.length<64)warnings.push(args.join(' '));}},decodeInto:(input,output,format=5)=>{
    const decoded=decodePacked(input,format,32*1024*1024);if(decoded.length>output.length)throw new Error('Native packed output buffer exceeded');output.set(decoded);
  }},{codeGeneration:{strings:false,wasm:false}});
  // pt is a little-endian byte cursor. Record constructors only allocate data;
  // all coordinate, unit-field, waypoint and resource logic below is original.
  vm.runInContext(`class aX{};${iniCode}
class pt{constructor(buffer){this.view=new DataView(buffer);this.at=0;}readUint16(){const n=this.view.getUint16(this.at,true);this.at+=2;return n;}readInt16(){const n=this.view.getInt16(this.at,true);this.at+=2;return n;}readUint8(){return this.view.getUint8(this.at++);}}
const ay={decodeInto},mu=value=>value;
class RTe{};class ITe{};class kTe{};class BTe{};class NTe{};class LTe{};class DTe{};
class NativeContentMap extends fs{${sceneMethods}}
function tree(section){return {name:section.name,entries:[...section.entries],sections:section.getOrderedSections().map(tree)}}
globalThis.read=function(text){
 const map=new NativeContentMap(text),sections=map.getOrderedSections().map(tree),settings=map.getSection('Map');
 if(!settings)throw new Error('Missing native Map section');
 const size=settings.getNumberArray('Size'),local=settings.getNumberArray('LocalSize');
 if(size.length!==4||local.length!==4||!size.every(Number.isInteger)||!local.every(Number.isInteger)||size[2]<1||size[3]<1||size[2]+size[3]>512)throw new Error('Invalid native map dimensions');
 map.fullSize={x:size[0],y:size[1],width:size[2],height:size[3]};
 map.readTiles();map.readWaypoints(map.getOrCreateSection('Waypoints'));map.readStructures(map.getOrCreateSection('Structures'));
 map.readVehicles();map.readInfantries();map.readAircrafts();map.readTerrains(map.getOrCreateSection('Terrain'));map.readOverlays();map.readSmudges();
 const objects={structures:map.structures,vehicles:map.vehicles,infantry:map.infantries,aircraft:map.aircrafts,terrain:map.terrains,smudges:map.smudges};
 return JSON.stringify({sections,size,local,theater:settings.getString('Theater').toUpperCase(),tiles:map.tiles.map(tile=>tile?[tile.rx,tile.ry,tile.tileNum,tile.subTile,tile.z]:null),maxTile:map.maxTileNum,
 waypoints:map.waypoints,overlays:map.overlays.map(item=>[item.rx,item.ry,item.id,item.value]),objects},(key,value)=>typeof value==='number'&&!Number.isFinite(value)?{$invalidNumber:String(value)}:value);
};`,context,{timeout:1000});
  return {evidence:{appSha256:sha(source),iniParserSha256:sha(iniCode),sceneReadersSha256:sha(sceneMethods),usesOriginalSceneReaders:true,boundedPackDecoder:'map-editor/map-codec.mjs'},read(text){
    warnings.length=0;context.input=text;
    try{return {...JSON.parse(vm.runInContext('read(input)',context,{timeout:700})),warnings:[...warnings]};}finally{delete context.input;}
  }};
}

function sortSections(sections){
  // Case-insensitive warhead/projectile fallback selects the first matching
  // section. Preserve order when case-folding produces a collision.
  return new Set(sections.map(item=>item.name.toLowerCase())).size===sections.length?[...sections].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0):sections;
}
function canonicalSection(section,propertySections){
  const entries=propertySections.has(section.name)&&section.entries.every(([key])=>Number.isNaN(Number(key)))?[...section.entries].sort(([a],[b])=>a<b?-1:a>b?1:0):section.entries;
  return [section.name,entries,sortSections(section.sections).map(child=>canonicalSection(child,propertySections))];
}

export function fingerprintMap(text,{reader,native,map={}}){
  const data=reader.read(text),sections=new Map(data.sections.map(item=>[item.name,item]));
  if(data.warnings.length)throw new Error('Native scene warnings require individual review: '+data.warnings.join('; '));
  const ini=parseIniSections(text),dormant=dormantTypeOverrides(ini,native),metadata=inactiveEditorMetadata(ini,native);
  const activeNames=new Set([...Object.values(native.registries).flatMap(items=>[...items]),...(native.activeModObjectTypes||[]),...TYPE_TABLES.flatMap(name=>(sections.get(name)?.entries||[]).map(([,value])=>String(value).toUpperCase()))]);
  const ignored=new Set([...dormant,...metadata]);
  for(const name of ['Preview','PreviewPack','Digest','FinalAlert','FA2SP']){
    if(!sections.has(name)||activeNames.has(name.toUpperCase())||native.rules.has(name.toUpperCase())||native.activeModRules?.has(name.toUpperCase()))continue;
    let referenced=false;
    for(const section of data.sections)if(section.name!==name)for(const[,value]of section.entries)if((String(value).toUpperCase().match(/[A-Z_][A-Z0-9_]*/g)||[]).includes(name.toUpperCase()))referenced=true;
    if(!referenced)ignored.add(name.toUpperCase());
  }
  const propertySections=new Set(['Basic','Map','General','Lighting','SpecialFlags',...activeNames]);
  const scripts=new Set(SCRIPT_SECTIONS);
  for(const table of ['TaskForces','ScriptTypes','TeamTypes'])for(const[,id]of sections.get(table)?.entries||[])if(typeof id==='string')scripts.add(id);
  const rules=[],scriptRules=[];
  for(const original of data.sections){
    if(PACKS.has(original.name)||OBJECTS.has(original.name)||original.name==='Waypoints'||ignored.has(original.name.toUpperCase()))continue;
    const section={...original,entries:original.entries.filter(([key,value])=>original.name==='Basic'?
      !['Name','Author','Official','MinPlayer','MaxPlayer'].includes(key)&&!(key==='GameMode'&&String(value).split(',').map(token=>token.trim()).every(token=>['standard','Battle','RA2 Ladder Maps','YR Ladder Maps','SFJ'].includes(token))):
      original.name==='Map'?!['Size','LocalSize','Theater'].includes(key):true)};
    if(!section.entries.length&&!section.sections.length)continue;
    (scripts.has(original.name)?scriptRules:rules).push(section);
  }
  const rawPlacements=[...OBJECTS].map(name=>{
    const section=sections.get(name);
    // Native object readers ignore list keys, but their iteration order and
    // all serialized fields are retained, including fields for other clients.
    return [name,(section?.entries||[]).map(([key,value])=>name==='Terrain'?[key,value]:value),section?.sections||[]];
  });
  const components={
    terrain:{theater:data.theater,size:data.size,localSize:data.local,tiles:data.tiles,maxTile:data.maxTile},
    spawns:{waypoints:data.waypoints},resources:data.overlays,
    objects:{native:data.objects,serialized:rawPlacements},
    rules:{sections:sortSections(rules).map(section=>canonicalSection(section,propertySections)),sourceKind:map.sourceKind||'multiplayer_map',gameModes:map.gameModes||['standard'],externalRules:(map.modeDependencies||[]).filter(item=>item.requiredForStandard!==false).map(({mode,sha256,requiredForStandard})=>({mode,sha256,requiredForStandard})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))},
    scripts:sortSections(scriptRules).map(section=>canonicalSection(section,new Set())),
  };
  const hashes=Object.fromEntries(CATEGORIES.map(name=>[name,digest(components[name])]));
  return {version:1,sha256:digest(hashes),categories:hashes,ignoredMetadataSections:[...ignored].sort(),stats:{tiles:data.tiles.length,waypoints:data.waypoints.length,overlays:data.overlays.length,objects:Object.fromEntries(Object.entries(data.objects).map(([kind,items])=>[kind,items.length]))}};
}

export async function applySemanticDedup(root,{engine=root,output=join(root,'maps/deduplication-report.json'),builtins=join(ROOT,'vendor/native-map-audit-20261113')}={}){
  root=resolve(root);engine=resolve(engine);
  const [catalog,native,app]=await Promise.all([readFile(join(root,'maps/catalog.json'),'utf8').then(JSON.parse),loadNativeResources(engine),readFile(join(engine,'js/app.js'),'utf8')]);
  let compatibility;
  try{compatibility=JSON.parse(await readFile(join(root,'maps/compatibility-report.json'),'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;compatibility=JSON.parse(await readFile(join(engine,'maps/compatibility-report.json'),'utf8'));}
  const scans=new Map(compatibility.scans.map(scan=>[scan.file,scan]));
  const reader=compileContentReader(app),groups=new Map(),results=[];
  for(const map of catalog.maps){
    delete map.deduplication;
    if(map.baseTitle)map.title=map.baseTitle;
    delete map.variantInfo;
    const file=map.cleanedVersion?.file||map.file,bytes=await readFile(join(root,'maps/files',file));
    if(sha(bytes)!==(map.cleanedVersion?.sha256||map.sha256))throw new Error('Input integrity mismatch: '+file);
    const result={file:map.file,comparedFile:file,title:map.title,players:map.players,compatible:map.compatible};
    try{result.fingerprint=fingerprintMap(decodeMapBytes(bytes),{reader,native,map:{...map,modeDependencies:scans.get(map.file)?.modeDependencies||[]}});const key=result.fingerprint.sha256;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({map,result});}
    catch(error){result.reviewRequired=error.message;}
    results.push(result);
  }
  const merged=[];
  for(const [hash,items]of groups){
    // A passing version always represents an equivalent archived version.
    // Otherwise retain original catalog order for reproducible selection.
    const selected=items.find(item=>item.map.compatible)||items[0];
    for(const item of items)item.map.deduplication={version:1,groupId:hash,representativeFile:selected.map.file,isRepresentative:item===selected,versionCount:items.length,categories:item.result.fingerprint.categories};
    if(items.length>1)merged.push({groupId:hash,representativeFile:selected.map.file,title:selected.map.title,categories:selected.result.fingerprint.categories,members:items.map(({map,result})=>({file:map.file,comparedFile:result.comparedFile,title:map.title,originalTitle:map.originalTitle,players:map.players,source:map.source,sourcePath:map.sourcePath,sha256:map.sha256,compatible:map.compatible}))});
  }
  for(const map of catalog.maps)if(!map.deduplication)map.deduplication={version:1,isRepresentative:true,representativeFile:map.file,versionCount:1,reviewRequired:true};
  const builtinManifest=JSON.parse(await readFile(join(builtins,'manifest.json'),'utf8')),builtinResults=[],nativeDuplicates=[],builtinGroups=[];
  for(const item of builtinManifest.maps){
    const result={file:item.file,players:Number(item.maxPlayers),sourceUrl:item.url||'https://gmap.wangerhuoda.cn/map/'+item.file,sourceManifest:item.manifest,sourceArchive:item.sourceArchive,sha256:item.sha256};
    if(!item.available){builtinResults.push({...result,reviewRequired:item.error||'Native source unavailable'});continue;}
    try{
      const path=resolve(builtins,item.localFile);if(!path.startsWith(resolve(builtins)+'/'))throw new Error('Native map path escapes archive');
      const bytes=await readFile(path);if(sha(bytes)!==item.sha256)throw new Error('Native snapshot integrity mismatch');
      result.fingerprint=fingerprintMap(decodeMapBytes(bytes),{reader,native,map:{sourceKind:'multiplayer_map',gameModes:['standard']}});
    }catch(error){result.reviewRequired=error.message;}
    builtinResults.push(result);
    if(!result.fingerprint)continue;
    const equivalent=groups.get(result.fingerprint.sha256)||[];
    for(const {map}of equivalent){
      if(map.players!==result.players)continue;
      map.deduplication.builtinEquivalent={file:item.file,sha256:item.sha256,players:result.players,suppressedInStandardSelection:map.compatible&&map.deduplication.isRepresentative};
      builtinGroups.push({catalogFile:map.file,canonicalFile:map.cleanedVersion?.file||map.file,title:map.title,nativeFile:item.file,nativeSha256:item.sha256,categories:result.fingerprint.categories,suppressedInStandardSelection:map.deduplication.builtinEquivalent.suppressedInStandardSelection});
      if(map.deduplication.builtinEquivalent.suppressedInStandardSelection)nativeDuplicates.push({file:item.file,canonicalFile:map.cleanedVersion?.file||map.file,title:map.title,players:map.players,nativeSha256:item.sha256,categories:result.fingerprint.categories});
    }
  }
  const byName=new Map();for(const result of results){const key=String(result.title)+'\0'+result.players;if(!byName.has(key))byName.set(key,[]);byName.get(key).push(result);}
  const comparisons=[...byName.values()].filter(items=>items.length>1).map(items=>({title:items[0].title,players:items[0].players,members:items.map(item=>({file:item.file,categories:item.fingerprint?.categories,reviewRequired:item.reviewRequired})),differentCategories:CATEGORIES.filter(name=>new Set(items.map(item=>item.fingerprint?.categories[name]||item.file)).size>1)}));
  const byFile=new Map(catalog.maps.map(map=>[map.file,map]));
  for(const comparison of comparisons){
    const variants=comparison.members.map(item=>byFile.get(item.file)).filter(map=>map.deduplication.isRepresentative);
    if(variants.length<2)continue;
    for(const [index,map]of variants.entries()){
      map.baseTitle=map.title;map.variantInfo={index:index+1,total:variants.length,differentCategories:comparison.differentCategories};
      map.title=map.baseTitle+'（版本'+(index+1)+'）';
    }
  }
  catalog.uniqueTotalCount=catalog.maps.filter(map=>map.deduplication.isRepresentative).length;
  catalog.uniqueCompatibleCount=catalog.maps.filter(map=>map.compatible&&map.deduplication.isRepresentative).length;
  catalog.duplicateCount=catalog.maps.length-catalog.uniqueTotalCount;
  catalog.compatibleDuplicateCount=catalog.compatibleCount-catalog.uniqueCompatibleCount;
  catalog.semanticDeduplication={version:1,reportUrl:'/maps/deduplication-report.json',categories:CATEGORIES,originalFilesPreserved:true,builtinMapsCompared:builtinResults.length,builtinContentMatches:builtinGroups.length,nativeSelectionDuplicatesRemoved:nativeDuplicates.length};
  const report={schemaVersion:1,generatedAt:new Date().toISOString(),archivedFiles:catalog.maps.length,comparedMaps:results.filter(item=>item.fingerprint).length,individualReviewRequired:results.filter(item=>item.reviewRequired).length,
    uniqueMaps:catalog.uniqueTotalCount,duplicateVersions:catalog.duplicateCount,compatibleBefore:catalog.compatibleCount,compatibleAfter:catalog.uniqueCompatibleCount,compatibleVersionsMerged:catalog.compatibleDuplicateCount,
    nativeEvidence:reader.evidence,profile:{nativeResources:native.evidence,activeMod:native.activeModAudit},categories:CATEGORIES,
    builtinContentMatches:builtinGroups.length,nativeSelectionDuplicatesRemoved:nativeDuplicates.length,builtinGroups,builtinMaps:builtinResults,builtinManifests:builtinManifest.manifests,
    policy:['Compare decoded native tiles, all waypoints, resource IDs/amounts, placed objects, rule overrides and scripts separately.','Ignore display title/author/player-count/official metadata, comments, previews, checksums and source-proven dormant/editor sections.','Current standard registration replaces source platform GameMode labels; known ordinary Battle/ladder labels and unused optional platform mode rules do not change standard gameplay. Special missions and required external rules stay distinct.','Preserve spawn numbering, object iteration order, serialized object fields, scripts, registry order and unrecognized configuration.','Merge only when every category is equal, independently of name; preserve every original file and source record.','For identical built-in/community maps, retain the verified community file in standard selection; preserve the built-in entry in its other game modes.','Decode errors or native warnings remain individual versions for review.'],groups:merged,sameNameComparisons:comparisons,maps:results};
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  await writeFile(join(root,'maps/catalog.json'),JSON.stringify(catalog,null,2)+'\n');
  const index=createGameIndex(catalog);index.displayLanguage=catalog.displayLanguage;index.semanticDeduplication=catalog.semanticDeduplication;index.nativeDuplicates=nativeDuplicates;
  // Keep translated original titles in the lightweight selection index.
  for(const item of index.maps){const original=catalog.maps.find(map=>(map.cleanedVersion?.file||map.file)===item.file);if(original?.originalTitle)item.originalTitle=original.originalTitle;}
  await writeFile(join(root,'maps/game-index.json'),JSON.stringify(index,null,2)+'\n');
  return {catalog,report};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=process.argv[2];if(!root)throw new Error('Usage: semantic-dedup.mjs RELEASE_ROOT [ENGINE_ROOT]');
  const {report}=await applySemanticDedup(root,{engine:process.argv[3]||root});
  console.log(JSON.stringify({archivedFiles:report.archivedFiles,uniqueMaps:report.uniqueMaps,duplicateVersions:report.duplicateVersions,compatibleBefore:report.compatibleBefore,compatibleAfter:report.compatibleAfter,individualReviewRequired:report.individualReviewRequired},null,2));
}
