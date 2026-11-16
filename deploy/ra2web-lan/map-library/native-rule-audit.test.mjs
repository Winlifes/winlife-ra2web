import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {auditNativeRuleReaders,dormantTypeOverrides,cleanDormantOverrides} from './native-rule-audit.mjs';
import {loadNativeResources,parseIniSections,crc32,createGameIndex} from './build-catalog.mjs';

const root=new URL('../../../',import.meta.url),engine=new URL('vendor/ra2web-lan-0.87.3-20261113-workshop8-r1/',root);
const app=await readFile(new URL('js/app.js',engine),'utf8'),native=await loadNativeResources(engine.pathname),audit=auditNativeRuleReaders(app);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const slice=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)+a.length));
const iniSource=slice('class Ni{','var Ve;')+'\n'+slice('class fs{','const oX=');
const context=vm.createContext({},{codeGeneration:{strings:false,wasm:false}});
vm.runInContext('class aX{};'+iniSource+`
const $D={ObjectRulesFactory:class{create(type,section,general,index){return {type,name:section.name,index}}}};
const Ai={ObjectType:{2:'Building'}};
class NativeRegistry {constructor(text){this.ini=new fs(text);this.logger={debug(){}};} ${audit.evidence.registryReader} ${audit.evidence.objectReader}}
globalThis.registry=function(text){const reader=new NativeRegistry(text),types=new Map(),objects=new Map();reader.readObjectTypes('BuildingTypes',types);reader.readObjects(2,types,objects);return [...objects.keys()]};
globalThis.buildTime=function(text){const value={ini:new fs(text).getSection('GACNST')};(function(){${audit.evidence.buildTimeExpression}}).call(value);return value.buildTimeMultiplier};`,context,{timeout:1000});
function runNative(expression,input){context.input=input;try{return vm.runInContext(expression+'(input)',context,{timeout:300});}finally{delete context.input;}}

test('the original registry reader ignores a loose Yuri section and activates it only when registered',()=>{
  const original='[BuildingTypes]\n0=GACNST\n[GACNST]\nName=Allied yard\n[YAYARD]\nName=Dormant Yuri yard\n';
  assert.deepEqual(Array.from(runNative('registry',original)),['GACNST']);
  assert.deepEqual(Array.from(runNative('registry',original.replace('0=GACNST','0=GACNST\n1=YAYARD'))),['GACNST','YAYARD']);
});

test('BuildTimeMultiplier is read by the actual native INI getter, including the fixed-point conversion',()=>{
  assert.equal(runNative('buildTime','[GACNST]\nName=Yard\n'),1);
  assert.equal(runNative('buildTime','[GACNST]\nBuildTimeMultiplier=0.5\n'),0.5);
  assert.equal(runNative('buildTime','[GACNST]\nBuildTimeMultiplier=1.1\n'),Math.trunc(1.1*65536)/65536);
  assert.ok(audit.propertyKeys.has('BUILDTIMEMULTIPLIER'));
});

test('real theater stacks include native bridge and rubble assets from auxiliary archives',()=>{
  assert.equal(native.theaters.TEMPERATE.tiles[822].archive,'temperat.mix');
  assert.equal(native.theaters.SNOW.tiles[782].archive,'snow.mix');
  assert.equal(native.theaters.URBAN.tiles[1018].archive,'urban.mix');
  assert.ok(native.theaters.TEMPERATE.tiles[822].subtiles.every(Boolean));
  assert.equal(native.theaters.SNOW.tiles.find(tile=>tile.file.toLowerCase()==='mslop05.sno').present,false);
  assert.equal(native.activeModAudit.id,'gonghui');
  assert.equal(native.activeModAudit.rulesSha256,'72da41dc7462dcec260e95b6a67d96cde7c3bae1693dc4a6dd5641512c6adf7b');
});

test('registration, placement, prerequisites and transitive references all prevent cleanup',()=>{
  const dormant='[YAYARD]\nTechLevel=11\n[YABRCK]\nPrerequisite=YAYARD\n';
  const isolated={...native,rules:new Map(),activeModRules:new Map(),activeModObjectTypes:[],registries:{Buildings:new Set()}};
  assert.deepEqual([...dormantTypeOverrides(parseIniSections(dormant),isolated)].sort(),['YABRCK','YAYARD']);
  for(const reference of ['[BuildingTypes]\n0=YABRCK','[Structures]\n0=Neutral,YABRCK,256,80,80,0,None','[GACNST]\nPrerequisite=YABRCK','[TaskForce]\n0=2,YABRCK']){
    assert.equal(dormantTypeOverrides(parseIniSections(dormant+reference),isolated).size,0,reference);
  }
  assert.equal(dormantTypeOverrides(parseIniSections(dormant),{...isolated,activeModObjectTypes:['YABRCK']}).size,0);
  assert.equal(dormantTypeOverrides(parseIniSections(dormant),{...isolated,activeModAudit:{complete:false}}).size,0);
  assert.equal(dormantTypeOverrides(parseIniSections('[UnknownYuriType]\nName=Unknown'),isolated).size,0);
});

test('cleanup preserves every byte outside removed sections, duplicate sections, BOM and legacy encoding included',()=>{
  const source=Buffer.concat([Buffer.from([239,187,191]),Buffer.from('[YAYARD]\r\nTechLevel=11\r\n[Basic]\r\nName='),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from('\r\n[YAYARD] ; duplicate\r\nOwner=Yuri\r\n[Map]\r\nTheater=SNOW\r\n')]);
  const text=new TextDecoder('windows-1252').decode(source.subarray(3)),result=cleanDormantOverrides(source,parseIniSections(text),native);
  assert.deepEqual(result.removedSections,['YAYARD']);assert.equal(result.removedSpans.length,2);
  let cursor=0;const expected=[];
  for(const span of result.removedSpans){expected.push(source.subarray(cursor,span.start));assert.equal(sha(source.subarray(span.start,span.end)),span.sha256);cursor=span.end;}
  expected.push(source.subarray(cursor));assert.ok(Buffer.concat(expected).equals(result.bytes));
  assert.ok(result.bytes.includes(Buffer.from([0xd6,0xd0,0xce,0xc4])));assert.ok(result.bytes.subarray(0,3).equals(Buffer.from([239,187,191])));
  assert.equal(result.sha256,sha(result.bytes));assert.equal(result.sourceSha256,sha(source));
  assert.equal(cleanDormantOverrides(result.bytes,parseIniSections(new TextDecoder('windows-1252').decode(result.bytes.subarray(3))),native),null);
});

test('all archived originals and cleaned outputs are checked; previously compatible maps remain available',async()=>{
  const directory=new URL('vendor/platform-map-library-20261113-compat2/',root);
  const read=async name=>JSON.parse(await readFile(new URL(name,directory),'utf8'));
  const catalog=await read('maps/catalog.json'),old=JSON.parse(await readFile(new URL('vendor/platform-map-library-20261112/maps/catalog.json',root),'utf8'));
  assert.equal(catalog.total,594);assert.ok(catalog.compatibleCount>=224);
  for(const map of old.maps.filter(map=>map.compatible))assert.equal(catalog.maps.find(entry=>entry.file===map.file)?.compatible,true,map.file);
  let cleaned=0,playableCleaned=0;
  for(const map of catalog.maps){
    const original=await readFile(new URL('maps/files/'+map.file,directory));assert.equal(sha(original),map.sha256);assert.equal(crc32(original),map.crc32);
    if(!map.cleanedVersion)continue;
    cleaned++;if(map.compatible)playableCleaned++;
    const clean=map.cleanedVersion,bytes=await readFile(new URL('maps/files/'+clean.file,directory));assert.equal(sha(bytes),clean.sha256);assert.equal(crc32(bytes),clean.crc32);
    const report=await read(clean.auditUrl.slice('/maps/'.length).replace(/^/,'maps/'));
    assert.equal(report.originalFile,map.file);assert.equal(report.rescanCompatible,map.compatible);
    const parsed=parseIniSections(new TextDecoder('windows-1252').decode(bytes));for(const name of clean.removedSections)assert.equal(parsed.has(name),false);
  }
  assert.ok(cleaned>250);assert.ok(playableCleaned>=85);
  const index=createGameIndex(catalog);
  for(const map of catalog.maps.filter(map=>map.compatible&&map.cleanedVersion)){
    assert.equal(index.maps.find(entry=>entry.file===map.cleanedVersion.file)?.sha256,map.cleanedVersion.sha256);
    assert.equal(index.maps.some(entry=>entry.file===map.file),false,'Game must receive the cleaned bytes');
  }
});
