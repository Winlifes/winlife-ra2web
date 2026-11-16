import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateMap,runtimeTemplate} from '../scripts/generate.mjs';
import {validateMap} from '../scripts/validate.mjs';
import {previewSvg} from '../scripts/preview.mjs';
import {assessSnapshots} from '../scripts/collect-network.mjs';
import {checkEvidence} from '../scripts/check-evidence.mjs';
import {parseMap,serializeMap,setSpawn,setIniValue,tileAtCell} from '../lib/map-codec.mjs';
import {sha256,writeJson,profile} from '../lib/common.mjs';

const example=name=>JSON.parse(fs.readFileSync(new URL('../examples/'+name+'.json',import.meta.url)));
const two=example('2p-temperate');
for(const name of ['2p-temperate','8p-snow','16p-temperate'])test(name+': deterministic map bytes, real native decoding, pending runtime',()=>{
  const spec=example(name),first=generateMap(spec),second=generateMap(spec),report=validateMap(Buffer.from(first),spec);
  assert.equal(first,second);assert.equal(report.staticPassed,true,JSON.stringify(report.errors));assert.equal(report.nativeDecoded,true);
  assert.equal(report.stats.players,spec.players);assert.equal(parseMap(first).spawns.length,spec.players);
  assert.equal(report.runtimeVerified,false);assert.equal(report.status,'static-pass-runtime-pending');
  assert.equal(report.mapSha256,sha256(Buffer.from(first)));
});

test('duplicate spawn coordinates are rejected',()=>{
  const doc=parseMap(generateMap(two));setSpawn(doc,1,doc.spawns[0].rx,doc.spawns[0].ry);
  const report=validateMap(Buffer.from(serializeMap(doc)),two);assert.equal(report.staticPassed,false);assert.ok(report.errors.some(e=>e.code==='spawn-duplicate'));
});
test('sixteen starts without the explicit capacity marker fail',()=>{
  const text=generateMap(example('16p-temperate')).replace(/^WinlifeMaxPlayers=16\r?\n/m,'');
  const report=validateMap(Buffer.from(text));assert.equal(report.staticPassed,false);assert.ok(report.errors.some(e=>e.code==='extended-player-marker'));
});
test('legacy nonplayer waypoints are preserved and stay nonplayer',()=>{
  const doc=parseMap(generateMap(two));setIniValue(doc,'Waypoints','20',doc.spawns[0].ry*1000+doc.spawns[0].rx);
  const text=serializeMap(doc),report=validateMap(Buffer.from(text),two);
  assert.equal(report.staticPassed,true,JSON.stringify(report.errors));assert.equal(parseMap(text).spawns.length,2);assert.equal(parseMap(text).waypoints.length,3);
});
test('numeric aliases and unsupported rule sections cannot silently pass',()=>{
  const doc=parseMap(generateMap(two));setIniValue(doc,'Waypoints','01',doc.spawns[1].ry*1000+doc.spawns[1].rx);setIniValue(doc,'VehicleTypes','999','MadeUpTank');
  const report=validateMap(Buffer.from(serializeMap(doc)),two);
  assert.equal(report.staticPassed,false);assert.ok(report.errors.some(e=>e.code==='waypoint-integer'));assert.ok(report.errors.some(e=>e.code==='outside-profile'));
});
test('raising a tile is rejected by the flat profile, even when native decoding succeeds',()=>{
  const doc=parseMap(generateMap(two)),p=doc.spawns[0];tileAtCell(doc,p.rx,p.ry).z=1;
  const report=validateMap(Buffer.from(serializeMap(doc)),two);assert.equal(report.staticPassed,false);assert.ok(report.errors.some(e=>e.code==='terrain-profile'));
});
test('closed water barrier fails connectivity and channel clearance',()=>{
  const spec=example('8p-snow');spec.water=[{rect:[0.48,0,0.52,1]}];spec.structures=[];
  const report=validateMap(Buffer.from(generateMap(spec)),spec);assert.equal(report.staticPassed,false);assert.ok(report.errors.some(e=>e.code==='land-connectivity'));
});
test('resources crossing base squares or overlapping another patch fail during generation',()=>{
  const spec=structuredClone(two);spec.homeResources.offsets=[[0,0]];assert.throws(()=>generateMap(spec),/reserved base/);
  spec.homeResources.offsets=[[7,5],[7,5]];assert.throws(()=>generateMap(spec),/overlaps/);
});
test('unknown design keys, tree IDs and unbounded clearance are rejected',()=>{
  assert.throws(()=>generateMap({...two,bridgez:[]}),/Unknown design property/);
  assert.throws(()=>generateMap({...two,trees:[{type:'T01',position:[0.5,0.5]}]}),/tree ID/);
  const doc=generateMap(two),report=validateMap(Buffer.from(doc),{validation:{baseClearRadius:Infinity}});assert.equal(report.staticPassed,false);
  assert.ok(profile.trees.includes('TREE01'));
});
test('transfer size and malformed input fail with bounded errors',()=>{
  assert.equal(validateMap(Buffer.alloc(2*1024*1024+1)).staticPassed,false);
  assert.equal(validateMap(Buffer.from('[Map]\nSize=0,0,64,64\n[IsoMapPack5]\n1=garbage')).staticPassed,false);
});
test('malformed object CSV and nonfinite lighting cannot pass geometry-only native decoding',()=>{
  const doc=parseMap(generateMap(two));setIniValue(doc,'Structures','99','Neutral,CAOILD,256,20');setIniValue(doc,'Lighting','Ambient','NaN');
  const report=validateMap(Buffer.from(serializeMap(doc)),two);assert.equal(report.staticPassed,false);
  assert.ok(report.errors.some(e=>e.code==='object-record'));assert.ok(report.errors.some(e=>e.code==='lighting'));
});
test('SVG is a data schematic and escapes map titles',()=>{
  const spec={...two,name:'<AI & map>'},svg=previewSvg(generateMap(spec));
  assert.ok(svg.includes('&lt;AI &amp; map&gt;'));assert.ok(svg.includes('not an in-game screenshot'));assert.ok(!svg.includes('<AI & map>'));
});

const sample=(turn,hash,other=hash)=>({game:{started:true,turn,players:['Host','Guest'],desynced:false,hashes:[{turn:turn-1,values:[['Host',hash],['Guest',other]]}]}});
test('network evidence requires matching identities, advancing turns and distinct hash samples',()=>{
  const samples=[sample(12,11),sample(24,22),sample(36,33)];
  assert.equal(assessSnapshots(samples,'Host','Guest').status,'pass');
  assert.equal(assessSnapshots([samples[0],samples[0],samples[0]],'Host','Guest').status,'fail');
  assert.equal(assessSnapshots(samples,'Host','Host').status,'fail');
  assert.equal(assessSnapshots([sample(12,11,12),...samples.slice(1)],'Host','Guest').status,'fail');
  const bad=structuredClone(samples);bad[1].game.desynced=true;assert.equal(assessSnapshots(bad,'Host','Guest').status,'fail');
});
test('a generated pending acceptance record never passes evidence checking',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ra2-map-kit-'));
  try{const text=generateMap(two);fs.writeFileSync(dir+'/map.map',text);writeJson(dir+'/runtime.json',runtimeTemplate(sha256(Buffer.from(text))));
    const report=checkEvidence(dir+'/map.map',dir+'/runtime.json');assert.equal(report.runtimeEvidenceComplete,false);assert.ok(report.errors.some(e=>e.includes('allSpawnPositions')));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('evidence checking verifies file content hashes and refuses escaping the delivery directory',()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'ra2-evidence-fixture-')),dir=parent+'/delivery';fs.mkdirSync(dir);
  try{
    const text=generateMap(two),mapSha=sha256(Buffer.from(text)),record=runtimeTemplate(mapSha);fs.writeFileSync(dir+'/map.map',text);
    const fixture=Buffer.from(JSON.stringify({mapSha256:mapSha,result:assessSnapshots([sample(12,1),sample(24,2),sample(36,3)],'Host','Guest'),scope:'Synthetic unit fixture, not actual game evidence'}));
    fs.writeFileSync(dir+'/fixture.json',fixture);record.testedClient='unit-fixture';record.testedMod='unit-fixture';
    for(const check of Object.values(record.checks)){check.status='pass';check.notes='Synthetic completeness-test fixture only';check.evidence=[{path:'fixture.json',sha256:sha256(fixture)}];}
    writeJson(dir+'/runtime.json',record);assert.equal(checkEvidence(dir+'/map.map',dir+'/runtime.json').status,'evidence-complete');
    record.checks.editorImportExport.evidence[0].sha256='0'.repeat(64);writeJson(dir+'/runtime.json',record);assert.equal(checkEvidence(dir+'/map.map',dir+'/runtime.json').runtimeEvidenceComplete,false);
    fs.writeFileSync(parent+'/outside.json',fixture);record.checks.editorImportExport.evidence=[{path:'../outside.json',sha256:sha256(fixture)}];writeJson(dir+'/runtime.json',record);
    assert.ok(checkEvidence(dir+'/map.map',dir+'/runtime.json').errors.some(e=>e.includes('inside the delivery')));
  }finally{fs.rmSync(parent,{recursive:true,force:true});}
});
