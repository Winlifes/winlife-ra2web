import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {compileContentReader,fingerprintMap,applySemanticDedup,CATEGORIES,decodeMapBytes} from './semantic-dedup.mjs';
import {loadNativeResources} from './build-catalog.mjs';
import {createMap,serializeMap,setOverlay,OVERLAY_IDS,decodePacked,encodeLzo1xLiteral,bytesToBase64} from '../map-editor/map-codec.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url)),engine=join(root,'vendor/ra2web-lan-0.87.3-20261113-workshop8-r4');
const app=await readFile(join(engine,'js/app.js'),'utf8'),native=await loadNativeResources(engine),reader=compileContentReader(app);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inspect=(text,map={})=>fingerprintMap(text,{reader,native,map});
function fixture(change=()=>{}){const doc=createMap({width:32,height:32,name:'Dedup fixture',author:'Tester',players:2,theater:'TEMPERATE'});setOverlay(doc,32,32,OVERLAY_IDS.ORE,6);change(doc);return serializeMap(doc);}

test('display names, author, comments and preview bytes do not split identical battlefields',()=>{
  const a=fixture(),b=a.replace('Dedup fixture','Another display name').replace('Tester','Another author')+'\r\n; An extra comment\r\n[Preview]\r\nSize=0,0,10,10\r\n[PreviewPack]\r\n1=not-a-gameplay-layer\r\n';
  assert.equal(inspect(a).sha256,inspect(b).sha256);
  assert.equal(inspect(a+'[Basic]\nOfficial=yes\nMaxPlayer=8\nMinPlayer=3\n').sha256,inspect(a).sha256);
});

test('different LZO compression, pack line wrapping and newline style preserve native terrain equality',()=>{
  const a=fixture(),match=a.match(/\[IsoMapPack5\][\s\S]*?(?=\n\[|$)/),encoded=match[0].split(/\r?\n/).slice(1).filter(line=>/^\d+=/.test(line)).map(line=>line.slice(line.indexOf('=')+1)).join('');
  const raw=decodePacked(encoded),parts=[];
  for(let at=0;at<raw.length;at+=128){const chunk=raw.slice(at,at+128),stored=encodeLzo1xLiteral(chunk);parts.push(Uint8Array.from([stored.length&255,stored.length>>8,chunk.length&255,chunk.length>>8]),stored);}
  const output=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;for(const part of parts){output.set(part,offset);offset+=part.length;}
  const base64=bytesToBase64(output),lines=[];for(let at=0;at<base64.length;at+=91)lines.push((at/91+1)+'='+base64.slice(at,at+91));
  const b=a.replace(match[0],'[IsoMapPack5]\n'+lines.join('\n')+'\n').replace(/\r\n/g,'\n');
  assert.notEqual(sha(a),sha(b));assert.equal(inspect(a).sha256,inspect(b).sha256);
});

test('one tile, height, subtile, spawn coordinate or waypoint number change stays distinct',()=>{
  const a=inspect(fixture());
  for(const change of [doc=>doc.tiles[100].tileNum=314,doc=>doc.tiles[100].z=1,doc=>doc.tiles[100].subTile=1])assert.notEqual(inspect(fixture(change)).categories.terrain,a.categories.terrain);
  const text=fixture(),spawn=text.match(/\[Waypoints\][\s\S]*?\b0=(\d+)/);
  assert.notEqual(inspect(text.replace('0='+spawn[1],'0='+(Number(spawn[1])+1))).categories.spawns,a.categories.spawns);
  assert.notEqual(inspect(text+'[Waypoints]\n8=32032\n').categories.spawns,a.categories.spawns,'Mission waypoints above the player slots must be compared');
  assert.notEqual(inspect(text.replace('0='+spawn[1],'7='+spawn[1])).categories.spawns,a.categories.spawns);
});

test('one resource amount, overlay ID or position change stays distinct',()=>{
  const a=inspect(fixture());
  for(const change of [doc=>setOverlay(doc,32,32,OVERLAY_IDS.ORE,7),doc=>setOverlay(doc,32,32,OVERLAY_IDS.GEMS,6),doc=>setOverlay(doc,33,32,OVERLAY_IDS.ORE,6)])assert.notEqual(inspect(fixture(change)).categories.resources,a.categories.resources);
});

test('unit health, owner, facing, veterancy, mission, flags and creation order are compared',()=>{
  const fields=['Neutral','MTNK','256','32','32','0','Guard','None','0','-1','0','0','0','0'];
  const withUnit=items=>fixture()+'[Units]\nA='+items.join(',')+'\n';
  const a=inspect(withUnit(fields));
  for(const [index,value]of [[0,'Americans'],[2,'128'],[3,'33'],[5,'64'],[6,'Hunt'],[8,'1'],[10,'1'],[12,'1']]){const changed=[...fields];changed[index]=value;assert.notEqual(inspect(withUnit(changed)).categories.objects,a.categories.objects,'Field '+index);}
  const b=[...fields];b[1]='HTNK';
  assert.notEqual(inspect(fixture()+'[Units]\nA='+fields.join(',')+'\nB='+b.join(',')+'\n').categories.objects,inspect(fixture()+'[Units]\nA='+b.join(',')+'\nB='+fields.join(',')+'\n').categories.objects);
});

test('rule overrides, registry order, unknown keys, special missions and scripts remain significant',()=>{
  const text=fixture();
  assert.notEqual(inspect(text+'[GACNST]\nBuildTimeMultiplier=0.5\n').categories.rules,inspect(text+'[GACNST]\nBuildTimeMultiplier=1\n').categories.rules);
  assert.notEqual(inspect(text+'[BuildingTypes]\n0=GACNST\n1=NACNST\n').categories.rules,inspect(text+'[BuildingTypes]\n0=NACNST\n1=GACNST\n').categories.rules);
  assert.notEqual(inspect(text+'[UnknownExtension]\nUnrecognized=1\n').sha256,inspect(text+'[UnknownExtension]\nUnrecognized=2\n').sha256);
  assert.notEqual(inspect(text.replace('GameMode=standard','GameMode=specialmission')).sha256,inspect(text).sha256);
  assert.notEqual(inspect(text+'[Actions]\nX=1,99,0,0,0,0,0,0,A\n').categories.scripts,inspect(text+'[Actions]\nX=1,113,0,0,0,0,0,0,A\n').categories.scripts);
  assert.notEqual(inspect(text+'[Basic]\nTiberiumGrowthEnabled=no\n').sha256,inspect(text+'[Basic]\nTiberiumGrowthEnabled=yes\n').sha256);
});

test('only unused source-mode rules are ignored; required external rules remain different',()=>{
  const text=fixture(),a=inspect(text),dependency={mode:'Battle',sha256:'a',requiredForStandard:false};
  assert.equal(inspect(text,{modeDependencies:[dependency]}).sha256,a.sha256);
  assert.notEqual(inspect(text,{modeDependencies:[{...dependency,requiredForStandard:true}]}).categories.rules,a.categories.rules);
});

test('INI case collisions and unsafe native input cannot accidentally merge',()=>{
  const text=fixture();
  assert.notEqual(inspect(text+'[Example]\nStrength=1\n[example]\nStrength=2\n').sha256,inspect(text+'[example]\nStrength=2\n[Example]\nStrength=1\n').sha256);
  assert.throws(()=>inspect(text.replace('Size=0,0,32,32','Size=0,0,999999,999999')),/dimensions/);
  assert.throws(()=>inspect(text+'[Infantry]\n0=\n'),/review/);
});

test('merge retains every source, prefers a passing representative and labels differing versions',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'ra2-content-dedup-'));
  try{
    await mkdir(join(temporary,'maps/files'),{recursive:true});await mkdir(join(temporary,'builtins'));
    const texts=[fixture(),fixture().replace('Dedup fixture','An alias'),fixture(doc=>setOverlay(doc,32,32,OVERLAY_IDS.ORE,7))];
    const maps=texts.map((text,i)=>({file:'wl_test_'+i+'.map',title:'测试地图',players:2,compatible:i>0,sourceKind:'multiplayer_map',gameModes:['standard'],sha256:sha(text),bytes:Buffer.byteLength(text)}));
    for(const [i,map]of maps.entries())await writeFile(join(temporary,'maps/files',map.file),texts[i]);
    await writeFile(join(temporary,'maps/catalog.json'),JSON.stringify({schemaVersion:1,total:3,compatibleCount:2,displayLanguage:'zh-CN',maps}));
    await writeFile(join(temporary,'builtins/manifest.json'),JSON.stringify({maps:[],manifests:[]}));
    const {catalog,report}=await applySemanticDedup(temporary,{engine,builtins:join(temporary,'builtins')});
    assert.equal(catalog.uniqueTotalCount,2);assert.equal(report.duplicateVersions,1);
    assert.equal(catalog.maps[0].deduplication.representativeFile,maps[1].file);assert.equal(catalog.maps[0].deduplication.isRepresentative,false);
    assert.equal(catalog.maps[1].variantInfo.total,2);assert.ok(catalog.maps[1].variantInfo.differentCategories.includes('resources'));
    const index=JSON.parse(await readFile(join(temporary,'maps/game-index.json'),'utf8'));assert.equal(index.maps.length,2);
    for(const [i,map]of maps.entries())assert.equal((await readFile(join(temporary,'maps/files',map.file),'utf8')),texts[i]);
  }finally{await rm(temporary,{recursive:true,force:true});}
});

test('runtime merge removes only verified standard entries and preserves all other modes',async()=>{
  const prior=globalThis.fetch;
  const definition={maps:[],nativeDuplicates:[{file:'same.map',canonicalFile:'wl_test.map'},{file:'multi.map',canonicalFile:'wl_test.map'},{file:'missing.map',canonicalFile:'wl_missing.map'}]};
  globalThis.fetch=async()=>new Response(JSON.stringify(definition));
  try{
    const {deduplicateNativeMaps}=await import('../map-editor/map-store.mjs?dedup-test');
    const standard={mapFilter:'standard'},meat={mapFilter:'meatgrind'},other={fileName:'unrelated.map',gameModes:[standard]};
    const list={manifests:[{fileName:'SAME.MAP',gameModes:[standard]},{fileName:'multi.map',gameModes:[standard,meat]},other,{fileName:'missing.map',gameModes:[standard]}],getAll(){return this.manifests;}};
    await deduplicateNativeMaps(list,{getAll:()=>[{fileName:'wl_test.map'}]});
    assert.equal(list.manifests.length,3);assert.equal(list.manifests[0].fileName,'multi.map');assert.deepEqual(list.manifests[0].gameModes,[meat]);assert.equal(list.manifests[1],other);assert.equal(list.manifests[2].fileName,'missing.map');
  }finally{globalThis.fetch=prior;}
});

test('published comparison matches all six categories and retains every distinct same-name version',async()=>{
  const report=JSON.parse(await readFile(join(root,'vendor/platform-map-library-20261113-dedup1/maps/deduplication-report.json'),'utf8'));
  assert.equal(report.archivedFiles,595);assert.equal(report.comparedMaps,595);assert.equal(report.builtinMaps.length,186);assert.equal(report.builtinContentMatches,40);assert.equal(report.nativeSelectionDuplicatesRemoved,31);
  const sources=new Map(report.maps.map(map=>[map.file,map]));const builtins=new Map(report.builtinMaps.map(map=>[map.file,map]));
  for(const group of report.builtinGroups)for(const category of CATEGORIES)assert.equal(sources.get(group.catalogFile).fingerprint.categories[category],builtins.get(group.nativeFile).fingerprint.categories[category]);
  assert.ok(report.sameNameComparisons.some(group=>group.differentCategories.includes('scripts')));
  assert.ok(report.sameNameComparisons.some(group=>group.differentCategories.includes('resources')));
});
