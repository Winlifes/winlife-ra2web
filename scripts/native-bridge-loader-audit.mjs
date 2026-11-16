/** Regression through the real map-overlay loader, not directly spawned bridge fixtures. */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {parseMap,isPlayableCell} from '../deploy/ra2web-lan/map-editor/map-codec.mjs';
import {loadNativeResources} from '../deploy/ra2web-lan/map-library/build-catalog.mjs';
import {compileContentReader} from '../deploy/ra2web-lan/map-library/semantic-dedup.mjs';
const require=createRequire(import.meta.url),acorn=require('acorn'),walk=require('acorn-walk');
const root=process.argv[2],oldRoot=process.argv[3];
if(!root||!oldRoot)throw new Error('Usage: node scripts/native-bridge-loader-audit.mjs FIXED_RELEASE PREVIOUS_RELEASE');
const source=fs.readFileSync(root+'/js/app.js','utf8'),nodes=new Map(),classes=new Map();let loader;
walk.full(acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'}),n=>{
  if(n.type==='VariableDeclarator'&&n.id.name)nodes.set(n.id.name,n.init);
  if(n.type==='ClassDeclaration'){nodes.set(n.id.name,n);classes.set(n.id.name,n);}
  if(n.type==='MethodDefinition'&&n.key.name==='createInitialMapOverlays')loader=source.slice(n.start,n.end);
});
const code=name=>{const n=nodes.get(name);assert.ok(n,name);return source.slice(n.start,n.end);};
const methods=classes.get('xce').body.body.filter(m=>['isBridge','isXBridge','isHighBridge','isLowBridge','isBridgePlaceholder','getFoundation','getLandType'].includes(m.key.name)).map(m=>source.slice(m.start,m.end)).join('\n');
const constants=source.slice(nodes.get('To').end).match(/^;((?:To\.[\w]+=[^;]+;)+)/)[1];
const native=await loadNativeResources(root),reader=compileContentReader(source),warnings=[];
const context=vm.createContext({console:{warn:(...s)=>warnings.push(s.join(' '))}});
vm.runInContext(`const zi=(v,min,max)=>v>=min&&v<=max;
const Pn={NotBridge:0,Concrete:1,Wood:2},Et={Clear:0,Road:1};
const Yt={BottomLeft:5,BottomRight:7};
class pe{constructor(x,y){this.x=x;this.y=y}clone(){return new pe(this.x,this.y)}sub(v){this.x-=v.x;this.y-=v.y;return this}add(v){this.x+=v.x;this.y+=v.y;return this}}
const To=${code('To')};${constants}const Ei=To,At=${code('Hie')},pC=${code('tde')};
const NativeManager=${code('sO')};class NativeOverlay{${methods}}
const rs={ObjectType:{Overlay:'overlay'}},bg={BridgeOverlayTypes:Ei},fj={BridgeHeadType:{None:0}};
class NativeLoader{${loader}};globalThis.native={NativeManager,NativeOverlay,NativeLoader,Ei};`,context);
const {NativeManager,NativeOverlay,NativeLoader,Ei}=context.native;
function inspect(release){
  warnings.length=0;
  const metadata=JSON.parse(fs.readFileSync(release+'/maps/team-battle-verification.json'));
  const text=fs.readFileSync(release+'/maps/files/'+metadata.file,'utf8'),doc=parseMap(text),decoded=reader.read(text);
  assert.deepEqual(decoded.warnings,[]);
  const tiles=new Map(doc.tiles.map((tile,id)=>[tile.rx+','+tile.ry,{...tile,id}]));
  const directions=[[-1,-1],[-1,0],[0,-1],[-1,1],[1,-1],[0,1],[1,1],[1,0]];
  const tileCollection={getByMapCoords:(x,y)=>tiles.get(x+','+y),getAllBridgeSetTiles:()=>[],getNeighbourTile(tile,direction){const[x,y]=directions[direction];return this.getByMapCoords(tile.rx+x,tile.ry+y);}};
  const listeners=new Set(),occupancy=new Map();
  const objects=tile=>[...(occupancy.get(tile.rx+','+tile.ry)||[])];
  const tileOccupation={onChange:{subscribe:cb=>listeners.add(cb),unsubscribe:cb=>listeners.delete(cb)},getBridgeOnTile:tile=>objects(tile).find(o=>o.isBridge()),getGroundObjectsOnTile:objects};
  const tileSets={isHighBridgeBoundaryTile:()=>false,isHighBridgeMiddleTile:()=>false};
  const rules={getOverlayName:id=>native.overlays[id]};
  const manager=new NativeManager(tileSets,tileCollection,tileOccupation,{isWithinBounds:t=>isPlayableCell(doc,t.rx,t.ry)},rules);
  const game=Object.assign(new NativeLoader(),{rules,map:{tiles:tileCollection,bridges:manager,getObjectsOnTile:objects},
    validateMapObjectRulesAndArt:name=>native.rules.has(name)&&native.art.has(name),
    createObject(type,name){
      const rule=native.rules.get(name);assert.ok(rule);assert.equal(rule.get('LAND'),'Road');
      return Object.assign(new NativeOverlay(),{type,name,value:0,position:{tileElevation:0},rules:{land:1,tiberium:false},bridgeTrait:{},isTiberium:()=>false,isOverlay:()=>true,healthTrait:{health:100},dispose(){this.disposed=true;}});
    },
    spawnObject(obj,tile){
      obj.tile=tile;const shape=obj.getFoundation();
      for(let x=0;x<shape.width;x++)for(let y=0;y<shape.height;y++){
        const cell=tileCollection.getByMapCoords(tile.rx+x,tile.ry+y);assert.ok(cell);
        const key=cell.rx+','+cell.ry;if(!occupancy.has(key))occupancy.set(key,new Set());
        if(obj.isBridge())assert.ok(!objects(cell).some(o=>o.isBridge()),'Bridge foundation collision');
        occupancy.get(key).add(obj);if(obj.isBridge())cell.onBridgeLandType=obj.getLandType();
      }
      for(const cb of listeners)cb({object:obj,type:'added'});
    }
  });
  const bridgeInput=decoded.overlays.filter(([, ,id])=>Ei.isLowBridge(id)).map(([rx,ry,id,value])=>({rx,ry,id,value}));
  game.createInitialMapOverlays(bridgeInput,false);
  const heads=[...manager.pieces].filter(p=>p.headType!==0);
  const specs=new Map();
  for(const hut of doc.structures.values()){
    const spec=manager.findClosestBridgeSpec(tileCollection.getByMapCoords(hut.rx,hut.ry));
    if(spec)specs.set(spec.start.id+':'+spec.end.id,spec);
  }
  const summary={file:metadata.file,sha256:metadata.sha256,serializedBridgeCells:bridgeInput.length,
    laneValues:[...new Set(bridgeInput.map(o=>o.value))].sort((a,b)=>a-b),nativeBridgePieces:manager.pieces.size,
    nativeHeads:heads.length,nativeBridgeSpecs:specs.size,initializedBridgeSpecs:[...specs.values()].map(s=>({start:[s.start.rx,s.start.ry],end:[s.end.rx,s.end.ry],isXBridge:s.isXBridge,isHigh:s.isHigh})),warnings:[...warnings]};
  return{summary,manager,doc,tiles,tileOccupation};
}
const previous=inspect(oldRoot);assert.equal(previous.summary.nativeBridgePieces,0,'Reproduce the reported missing bridge');
const fixed=inspect(root);
assert.deepEqual(fixed.summary.laneValues,[0,1,2]);
assert.equal(fixed.summary.nativeBridgeSpecs,6);assert.equal(fixed.summary.nativeHeads,12);
assert.equal(fixed.summary.nativeBridgePieces,fixed.summary.serializedBridgeCells/3);
assert.deepEqual(fixed.summary.warnings,[]);
for(const spec of fixed.summary.initializedBridgeSpecs)assert.equal(spec.end[0]-spec.start[0],70);
const result={verifiedAt:new Date().toISOString(),usesActualNativeCreateInitialMapOverlays:true,
  nativeLoaderSha256:createHash('sha256').update(loader).digest('hex'),
  primitiveAdapters:['tile lookup and bounds','object allocation/occupation events','native rule/art lookup','2D vector'],
  previous:previous.summary,fixed:fixed.summary,missingBridgeReproduced:true,
  scope:'Actual native deserialization and bridge spawn/link/repair-association path; visual/vehicle acceptance recorded separately'};
fs.mkdirSync(new URL('../artifacts/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('../artifacts/native-loader-verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
