import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),acorn=require('acorn'),walk=require('acorn-walk');
const helper=fs.readFileSync(new URL('./reconnect-ui.js',import.meta.url),'utf8');
const source=fs.readFileSync(process.env.RA2_CLIENT_BUNDLE,'utf8');
const methods=new Map();walk.simple(acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'}),{MethodDefinition(n){const key=n.key?.name,body=source.slice(n.start,n.end);if(key&&['reconnectAfterStall','wlLeaveGame','leaveGame','sendPlayerActions','wlResendPlayerActions','resumeStall','closeForStallReconnect','handleCommsLag'].includes(key)||key==='initGameMenuEvents'&&body.includes('this.wlLeaveGame()'))methods.set(key,body);}});
const own=(value,key)=>JSON.parse(value.get(key)||'null');
function helperFixture(storage=new Map(),build='test-build',recoverBuilds=''){
  let now=1000,perf=0,interval;const body={children:[],append(e){this.children.push(e);}};
  const element=()=>({style:{},children:[],setAttribute(){},append(...items){this.children.push(...items);},get firstChild(){return this.children[0]},get lastChild(){return this.children.at(-1)},remove(){this.removed=true;}});
  const context={window:{},document:{currentScript:{dataset:{version:build,recoverBuilds}},createElement:element,body},location:{origin:'https://test.invalid',href:'https://test.invalid/'},URL,performance:{now:()=>perf},
    crypto:{randomUUID:()=> '12345678-1234-1234-1234-123456789abc'},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    Date:{now:()=>now},setInterval:fn=>{interval=fn;return 1},clearInterval:()=>{interval=undefined}};
  vm.runInNewContext(helper,context);
  const prefs={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  return {api:context.window.winlifeReconnect,prefs,body,storage,spend(ms){perf+=ms;},perf:()=>perf,step(ms){now+=ms;interval?.();}};
}
test('route persistence retains the original room and native serialized options across a new page',()=>{
  const f=helperFixture(),state={gameChannelName:'#room',hostMode:true,gameOpts:{value:1},slotsInfo:[{name:'A'}],playerHasMapStatus:new Map([['A',true]]),gservCandidates:new Map([['lan',{id:'lan'}]])};
  const route=f.api.remember({gameId:'match',playerName:'A'},{params:{winlifeResume:state}},{serializeOptions:opts=>JSON.stringify(opts)});
  f.prefs.setItem('last',JSON.stringify(route));f.api.playing(f.prefs,'last');f.step(6000);assert.equal(own(f.storage,'last').winlifeReconnect.lastSeenAt,7000);
  const page=helperFixture(f.storage);assert.equal(page.api.canRecover(own(f.storage,'last')),true);
  const room=page.api.restoreRoom(own(f.storage,'last'),{parseOptions:JSON.parse});assert.equal(room.gameId,'match');assert.equal(room.playerHasMapStatus.get('A'),true);assert.equal(room.gameOpts.value,1);
});
test('expired, foreign-origin and incompatible-build routes are rejected',()=>{
  const f=helperFixture(),route=f.api.remember({gameId:'match'},null,{});assert.equal(f.api.canRecover(route),true);
  assert.equal(f.api.canRecover({...route,winlifeReconnect:{...route.winlifeReconnect,origin:'https://other.invalid'}}),false);
  assert.equal(helperFixture(f.storage,'new-build').api.canRecover(route),false);f.step(330001);assert.equal(f.api.canRecover(route),false);
});
test('only an explicitly compatible client build can restore the previous build route',()=>{
  const previous=helperFixture(new Map(),'previous'),route=previous.api.remember({gameId:'match'},null,{});
  assert.equal(helperFixture(previous.storage,'current','previous').api.canRecover(route),true);
  assert.equal(helperFixture(previous.storage,'current','other').api.canRecover(route),false);
});
test('old page timers and terminal cleanup cannot overwrite or remove a newer page recovery record',()=>{
  const f=helperFixture();f.prefs.setItem('last',JSON.stringify(f.api.remember({gameId:'match'},null,{})));f.api.playing(f.prefs,'last');
  const newer=helperFixture(f.storage);newer.prefs.setItem('last',JSON.stringify(newer.api.remember(own(f.storage,'last'),null,{})));
  const snapshot=f.storage.get('last');f.step(10000);f.api.clear(f.prefs,'last');assert.equal(f.storage.get('last'),snapshot);
  newer.api.clear(newer.prefs,'last');assert.equal(f.storage.has('last'),false);
});
test('socket identity is stable for a browser, advances by page, and leaves unrelated URLs alone',()=>{
  const storage=new Map(),a=helperFixture(storage),b=helperFixture(storage);
  const x=new URL(a.api.transportUrl('wss://test.invalid/gserv')),y=new URL(b.api.transportUrl('wss://test.invalid/wol'));
  assert.equal(x.searchParams.get('winlifeClientId'),y.searchParams.get('winlifeClientId'));assert.ok(Number(y.searchParams.get('winlifeEpoch'))>Number(x.searchParams.get('winlifeEpoch')));
  assert.equal(a.api.transportUrl('wss://other.invalid/else'),'wss://other.invalid/else');
});
class PacketWriter{constructor(){this.data=[]}writeUint8(v){this.data.push(v)}writeUint32(v){this.data.push(v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255)}writeUint8Array(v){this.data.push(...v)}toUint8Array(){return Uint8Array.from(this.data)}}
function comms(){
  const Type=vm.runInNewContext('(class{'+[...methods].filter(([k])=>k!=='reconnectAfterStall').map(([,v])=>v).join('')+'})',{gy:PacketWriter,ig:2,fAe:1,py:400,rAe:301,Ui:class extends Error{static Code={InstanceAlreadyStarted:8}}});
  const sent=[];let open=false;const p=new Type();p.isOpen=()=>open;p.con={sendMessage:bytes=>sent.push(bytes),close(){open=false}};return {p,sent,setOpen:v=>{open=v}};
}
test('the actual native sender journals unsent commands and resends their exact turn/payload once connected',()=>{
  const f=comms(),data=Uint8Array.from([1,0,0,0]);f.p.sendPlayerActions(7,data);data[0]=99;assert.equal(f.sent.length,0);
  f.setOpen(true);f.p.wlResendPlayerActions();assert.deepEqual([...f.sent[0]],[2,1,7,0,0,0,1,0,0,0]);
  for(let i=8;i<100;i++)f.p.sendPlayerActions(i,Uint8Array.from([0]));assert.equal(f.p.wlActionOutbox.size,64);
});
test('native resume reads the server catch-up target and rejects a refused resume',async()=>{
  const f=comms();f.p.con.sendCommand=async command=>{assert.equal(command,'resume 12');return [{code:400,params:['A',':31']}]};assert.equal(await f.p.resumeStall(12,true),31);
  f.p.con.sendCommand=async()=>[{code:301,params:['A',':Expired']}];await assert.rejects(()=>f.p.resumeStall(12,true),/Resume error/);
});
function controller({failures=0,terminal=false,cancel=false,passive=false}={}){
  let now=0,attempts=0,resends=0,fatal=0,cleared=0,status=0,cancelled=false;
  class GservError extends Error{static Code={InstanceNonExistent:5,InstanceVersMismatch:9,InstanceNotAllowed:7,BadLogin:1};constructor(){super('expired');this.code=5;}}
  const ui={showStatus(){status++},hideStatus(){status=0},clear(){cleared++}};
  const Type=vm.runInNewContext('(class{'+methods.get('wlLeaveGame')+methods.get('reconnectAfterStall')+'})',{Date:{now:()=>now},performance:{now:()=>now},window:{winlifeReconnect:ui},ak:{Ended:2},eu:{StorageKey:{LastConnection:'last'}},Fl:{sleep:async ms=>{now+=ms;if(cancel){cancelled=true;throw Error('cancel')}}},pi:{GservError},Jd:{},za:{},Va:{}});
  const Lag=vm.runInNewContext('(class{'+methods.get('handleCommsLag')+'})',{}),manager=new Lag();Object.assign(manager,{currentNetworkTurn:passive?1:50,passiveMode:passive,stallReconnectRequested:true,commsLagStartTime:1,commsLagStartTurn:1,commsLagStartReceivedTurn:0,reportLockstepWaitEnd(){},updateLagState(value){this.lagState=value}});
  const c=new Type();Object.assign(c,{exitRequests:[],gservStallRoute:{target:'server',gameId:'match',user:'A',pass:'pass'},game:{status:1},gameCancellationSource:{token:{isCancelled:()=>cancelled}},pointer:{unlock(){}},lockstepManager:manager,handleFatalGservClose(){fatal++},gservCon:{async leaveGame(){c.exitRequests.push('leavegame')},closeForStallReconnect(){},async connect(){attempts++;if(terminal)throw new GservError();if(attempts<=failures)throw Error('offline')},async cvers(){},async login(){},async joinGame(){},async resumeStall(){return 20},sendPlayerActive(value){c.sentActive=value},wlResendPlayerActions(){resends++},isOpen(){return true}}});
  return {c,stats:()=>({attempts,resends,fatal,cleared,status})};
}
test('native reconnect retries offline attempts, resends pending inputs and permits later disconnections',async()=>{
  const f=controller({failures:2});await f.c.reconnectAfterStall({lastReceivedTurn:10,hasReceivedTurn:true});assert.deepEqual(f.stats(),{attempts:3,resends:1,fatal:0,cleared:0,status:0});assert.equal(f.c.lockstepManager.stallReconnectRequested,false);
  assert.equal(f.c.sentActive,true);assert.equal(f.c.lockstepManager.commsLagStartTime,undefined);
  await f.c.reconnectAfterStall({lastReceivedTurn:20,hasReceivedTurn:true});assert.equal(f.stats().resends,2);assert.equal(f.c.stallReconnectInFlight,false);
});
test('a background page stays passive after resume and stale lag cannot cause immediate reconnect storms',async()=>{
  const f=controller({passive:true});await f.c.reconnectAfterStall({lastReceivedTurn:0,hasReceivedTurn:true});
  assert.equal(f.c.sentActive,false);assert.equal(f.c.lockstepManager.commsLagStartTime,undefined);assert.equal(f.c.lockstepManager.lagState,false);assert.equal(f.stats().fatal,0);assert.equal(f.stats().attempts,1);
});
test('expired matches stop retrying and cancelled screens cannot reopen a connection',async()=>{
  const expired=controller({terminal:true});await expired.c.reconnectAfterStall({});assert.deepEqual(expired.stats(),{attempts:1,resends:0,fatal:1,cleared:1,status:0});
  const cancelled=controller({cancel:true});await cancelled.c.reconnectAfterStall({});assert.deepEqual(cancelled.stats(),{attempts:0,resends:0,fatal:0,cleared:0,status:0});
});

test('intentional exit sends both available exit paths and prevents every later reconnect attempt',async()=>{
  const f=controller();
  f.c.returnTo={params:{winlifeResume:{gameChannelName:'#room'}}};
  f.c.wolService={getConnection:()=>({isOpen:()=>true,async abandonGame(channel,id){f.c.exitRequests.push([channel,id])}})};
  await f.c.wlLeaveGame();
  assert.equal(f.c.wlLeavingGame,true);assert.equal(f.stats().cleared,1);
  assert.deepEqual(f.c.exitRequests,['leavegame',['#room','match']]);
  await f.c.reconnectAfterStall({});assert.equal(f.stats().attempts,0);assert.equal(f.stats().resends,0);
});

test('quitting during an in-flight reconnect cannot re-enable the departed player',async()=>{
  const f=controller();let joined=0;
  f.c.gservCon.connect=async()=>f.c.wlLeaveGame();f.c.gservCon.joinGame=async()=>{joined++};
  await f.c.reconnectAfterStall({});
  assert.equal(joined,0);assert.equal(f.c.sentActive,undefined);assert.equal(f.stats().resends,0);assert.equal(f.stats().fatal,0);
  assert.equal(f.c.stallReconnectInFlight,false);
});

test('the real quit menu works while stalled without waiting for a simulation turn',async()=>{
  let quit,exits=0,cleared=0,navigated;
  const Type=vm.runInNewContext('(class{'+methods.get('wlLeaveGame')+methods.get('initGameMenuEvents')+'})',{
    window:{winlifeReconnect:{clear(){cleared++}}},eu:{StorageKey:{LastConnection:'last'}},QS(){},qd(){},
    Fl:{sleep:async()=>{}},Jd:{ScreenType:{MainMenuRoot:1}},Va:{ScreenType:{Home:2}},za:{MainMenuRoute:class{}},t1:()=>true
  });
  const controller=new Type(),room={params:{winlifeResume:{gameChannelName:'#room'}}};
  Object.assign(controller,{returnTo:room,isSinglePlayer:false,lagState:true,gservStallRoute:{gameId:'match'},
    controller:{goToScreen(screen,params){navigated=params.route}},pointer:{lock(){},setVisible(){}},playerUi:{dispose(){}},
    gservCon:{isOpen:()=>true,async leaveGame(){exits++},onClose:{unsubscribe(){}},close(){}},
    gameCancellationSource:{cancel(){}},gameTurnMgr:{dispose(){}},sendGameRes(){},logGame(){},
    lockstepManager:{onActionsSent:{subscribeOnce(){throw Error('must not wait for blocked turns')}}}});
  const menu={onOpen:{subscribe(){}},onQuit:{subscribe(fn){quit=fn}},onObserve:{subscribe(){}},onCancel:{subscribe(){}}};
  controller.initGameMenuEvents(menu,{play(){}},{gameOpts:{}},{isObserver:false},{push(){throw Error('must use the acknowledged exit protocol')}},{});
  await quit();assert.equal(exits,1);assert.ok(cleared>=1);assert.equal(navigated,room);assert.equal(controller.wlLeavingGame,true);
});

const ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'});
let turnClass,animationClass,roundRate;
walk.simple(ast,{ClassExpression(node){if(node.id?.name==='zw')turnClass=node;},ClassDeclaration(node){if(node.id?.name==='yEe')animationClass=node;},FunctionDeclaration(node){if(node.id?.name==='zCe')roundRate=source.slice(node.start,node.end);}});
function nativeReplayFixture(){
  const f=helperFixture(),events=[],hashes=[];
  const selected=['doGameTurn','canAdvanceNetworkTurn','setRate','updateRate','handleCommsLag'];
  const actualMethods=turnClass.body.body.filter(node=>selected.includes(node.key?.name)).map(node=>source.slice(node.start,node.end)).join('');
  const Manager=vm.runInNewContext(roundRate+';(class zw{static PREFERRED_HASH_CHECK_MILLIS=1000;'+actualMethods+'})',{ak:{Ended:2},JCe:64});
  const manager=new Manager(),state={tick:0,value:1};
  Object.assign(manager,{game:{status:1,currentTick:0,update(){f.spend(1);state.tick++;state.value=(Math.imul(state.value,33)+state.tick)>>>0;this.currentTick++;},getHash(){return state.value;}},
    errorState:false,passiveMode:false,currentNetworkTurn:0,currentSubTurn:0,receivedNetworkTurn:40,gameTurnMillis:1000/60,queuedRateChanges:[],receivedActions:new Map(),gameStateHashHistory:[],
    debug(){},handleCommsLag(){},sendActions(){},processActions(actions){for(const value of actions)state.value=(Math.imul(state.value,17)+value)>>>0;events.push([...actions]);},
    _onActionsProcessed:{dispatch(){}},gservCon:{sendGameStateHash(turn,hash){hashes.push([turn,hash]);}}});
  for(let turn=0;turn<=40;turn++)manager.receivedActions.set(turn,[turn*3+1]);
  manager.setRate({rate:60,turnNo:0});manager.setRate({rate:133,turnNo:9});manager.setRate({rate:83,turnNo:23});
  const tick=animationClass.body.body.find(node=>node.key?.name==='tickGame');
  const Animation=vm.runInNewContext('(class{'+source.slice(tick.start,tick.end)+'})',{J:{beginTurnSample(){},begin(){},increment(){},finishTurnSample(){return{};}}});
  const loop=new Animation();let notifications=0;Object.assign(loop,{options:{skipFrames:true,onAfterTurn(){notifications++;}},gameTurnMgr:manager,paused:false});
  return {f,loop,manager,snapshot:()=>({state,events,hashes,notifications,currentNetworkTurn:manager.currentNetworkTurn,currentSubTurn:manager.currentSubTurn,rate:manager.networkTurnMillis})};
}
test('bounded catch-up runs the real native tick path with identical actions, dynamic rates, hashes and after-turn notifications',()=>{
  const live=nativeReplayFixture(),fast=nativeReplayFixture();
  while(live.manager.currentNetworkTurn<40)live.loop.tickGame(1000);
  let frames=0;
  while(fast.manager.currentNetworkTurn<40){
    const before=fast.f.perf();fast.f.api.catchUp(fast.loop,1000);frames++;
    assert.ok(fast.f.perf()-before<=8,'replay must yield for rendering and UI input');assert.ok(frames<500);
    // The last two buffered turns use the normal live animation path.
    if(fast.manager.receivedNetworkTurn-fast.manager.currentNetworkTurn<=2)while(fast.manager.currentNetworkTurn<40)fast.loop.tickGame(1000);
  }
  assert.ok(frames>1);assert.deepEqual(fast.snapshot(),live.snapshot());
});
test('catch-up stops on a missing authoritative batch and cannot invent simulation ticks',()=>{
  const f=nativeReplayFixture();f.manager.receivedActions.delete(0);f.manager.handleCommsLag=()=>{};
  f.f.api.catchUp(f.loop,1000);f.f.api.catchUp(f.loop,1000);
  while(f.manager.currentNetworkTurn<2)f.f.api.catchUp(f.loop,1000);
  const before=f.snapshot().state.tick;f.f.api.catchUp(f.loop,1000);
  assert.equal(f.loop.turnMgrIsWaiting,true);assert.equal(f.manager.currentNetworkTurn,2);assert.equal(f.snapshot().state.tick,before);
});
