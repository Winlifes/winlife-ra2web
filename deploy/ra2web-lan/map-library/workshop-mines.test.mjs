// Run the released map and original native mine/range/harvest implementations.
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkshopMap} from './add-workshop-maps.mjs';
import {parseMap,serializeMap,getIniValue,OVERLAY_IDS} from '../map-editor/map-codec.mjs';
const require=createRequire(import.meta.url);
const acorn=require('acorn');
const walk=require('acorn-walk');
const bundle=process.env.RA2_CLIENT_BUNDLE;
assert.ok(bundle,'Set RA2_CLIENT_BUNDLE to the candidate app.js');
const source=fs.readFileSync(bundle,'utf8'),nodes=new Map();
walk.simple(acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'}),{
  VariableDeclarator(node){if(node.id.name)nodes.set(node.id.name,node.init);},
  ClassDeclaration(node){nodes.set(node.id.name,node);},
});
const code=name=>{const n=nodes.get(name);assert.ok(n,'Native source '+name);return source.slice(n.start,n.end);};
const gr={Riparius:0,Cruentus:1,Vinifera:2,Aboreus:3,Ore:0,Gems:1},Et={Clear:0,Road:1,Rough:2,Tiberium:3};
const context=vm.createContext({console,gr,Et,N:{Overlay:'overlay'},We:{onTick:'tick'}});
vm.runInContext(`class aX{};${code('Ni')};${code('nA')};${code('fs')};
class Js{constructor(ini){this.ini=ini}parse(){}}
${code('wie')};const TerrainRules=wie;
const Jo={minIdRiparius:102,minIdCruentus:27,minIdVinifera:127,minIdAboreus:147};
const Wm=${code('Vre')};const At=${code('Hie')};const pr=${code('bD')};pr.maxBails=11;
const Mine=${code('ahe')};`,context);
const native=vm.runInContext('({Ini:fs,TerrainRules,Mine,Ore:pr})',context);
function mineRules(type){
  const ini=new native.Ini('[TIBTRE01]\nSpawnsTiberium=yes\nAnimationProbability=.003\n'+(type===undefined?'':'TiberiumToSpawn='+type+'\n'));
  const rules=new native.TerrainRules(ini.getSection('TIBTRE01'));rules.parse();return rules;
}
// Primitive map/world I/O only. Mine timing, tile search order, resource IDs,
// placement checks, harvest amounts and replenishment all run native code.
function world(type=1){
  const tiles=new Map(),objects=new Map(),center={rx:20,ry:20};
  for(let x=-2;x<=2;x++)for(let y=-2;y<=2;y++){
    const tile={rx:20+x,ry:20+y,dx:40+x-y,dy:40+x+y,landType:Et.Clear};tiles.set(tile.rx+','+tile.ry,tile);
  }
  const map={tiles:{getByMapCoords:(x,y)=>tiles.get(x+','+y)},mapBounds:{isWithinBounds:()=>true},getGroundObjectsOnTile:tile=>objects.has(tile)?[objects.get(tile)]:[],getObjectsOnTile:tile=>objects.has(tile)?[objects.get(tile)]:[]};
  const game={map,rules:{getOverlayName:id=>String(id)},createObject:()=>({isOverlay:()=>true,isTiberium:()=>true,isSmudge:()=>false,isUnit:()=>false}),spawnObject(object,tile){object.tile=tile;object.bails=new native.Ore(object,{type:object.overlayId>=27&&object.overlayId<=38?1:0});object.traits={get:()=>object.bails};objects.set(tile,object);tile.landType=Et.Tiberium;}};
  const mine=new native.Mine(mineRules(type));
  const tick=()=>mine.tick({tile:center},game);
  const cycle=()=>{for(let i=0;i<mine.cooldownTicks+2;i++)tick();};
  const harvest=object=>{while(object.bails.getBailCount())object.bails.collectBail();objects.delete(object.tile);object.tile.landType=Et.Clear;};
  return {mine,game,tiles,objects,center,tick,cycle,harvest};
}
test('the actual map keeps sixteen starts and supplies two gem mines per player',()=>{
  const doc=createWorkshopMap(),roundTrip=parseMap(serializeMap(doc));
  assert.equal(roundTrip.spawns.length,16);assert.equal(roundTrip.spawnLimit,16);
  assert.equal(roundTrip.terrain.size,32);assert.equal(roundTrip.overlays.size,767);
  assert.equal(getIniValue(roundTrip,'TIBTRE01','TiberiumToSpawn'),'1');
  for(const item of roundTrip.overlays.values())assert.equal(item.id,OVERLAY_IDS.GEMS);
  for(const spawn of roundTrip.spawns)for(const [x,y]of [[7,4],[-7,-4]]){
    const rx=spawn.rx+x,ry=spawn.ry+y;
    assert.equal(roundTrip.terrain.get(ry*1000+rx)?.name,'TIBTRE01');
    assert.equal(roundTrip.overlays.has(ry*512+rx),false);
  }
  assert.equal(serializeMap(createWorkshopMap()),serializeMap(doc));
});
test('native terrain reader defaults legacy mines to ore and reads the map gem override',()=>{
  assert.equal(mineRules().tiberiumToSpawn,0);assert.equal(mineRules(1).tiberiumToSpawn,1);
  const w=world(undefined);w.mine=new native.Mine(mineRules());
  w.mine.spawnTiberium(w.center,w.game);
  assert.ok([...w.objects.values()].every(o=>o.overlayId>=102&&o.overlayId<=113));
});
test('native mine timing creates purple gems repeatedly after complete depletion',()=>{
  const w=world();for(let i=0;i<w.mine.cooldownTicks+1;i++)w.tick();assert.equal(w.objects.size,0);
  w.tick();assert.equal(w.objects.size,1);
  for(let i=0;i<4;i++){
    const object=[...w.objects.values()][0];assert.ok(object.overlayId>=27&&object.overlayId<=38);assert.equal(object.bails.getTiberiumType(),1);
    w.harvest(object);assert.equal(w.objects.size,0);w.cycle();assert.equal(w.objects.size,1);
  }
});
test('native mines replenish an existing depleted gem field without replacing it with ore',()=>{
  const w=world();
  for(const tile of w.tiles.values())if(tile.rx!==20||tile.ry!==20){const o=w.game.createObject();o.overlayId=27;o.value=9;w.game.spawnObject(o,tile);}
  const before=[...w.objects.values()].reduce((n,o)=>n+o.bails.getBailCount(),0);w.cycle();
  assert.equal(w.objects.size,24);assert.equal([...w.objects.values()].reduce((n,o)=>n+o.bails.getBailCount(),0),before+1);
  assert.ok([...w.objects.values()].every(o=>o.overlayId===27));
});
test('identical native simulation ticks produce identical gem placement and amounts',()=>{
  const a=world(),b=world();for(let i=0;i<4000;i++){a.tick();b.tick();}
  const snapshot=w=>[...w.objects.values()].map(o=>[o.tile.rx,o.tile.ry,o.overlayId,o.value]);
  assert.deepEqual(snapshot(a),snapshot(b));assert.ok(a.objects.size>1);
});
