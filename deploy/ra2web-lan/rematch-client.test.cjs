// Execute the actual prepared client methods, including its real return route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const acorn = require('acorn');
const walk = require('acorn-walk');
const bundle = process.env.RA2_CLIENT_BUNDLE;
assert.ok(bundle, 'Set RA2_CLIENT_BUNDLE');
const source = fs.readFileSync(bundle, 'utf8'), tree = acorn.parse(source, {ecmaVersion:'latest',sourceType:'module'});
const methods=[], functions=new Map(), declarations=new Map(), assignments=[];
walk.full(tree, node => {
  if(node.type==='MethodDefinition')methods.push(node);
  if(node.type==='FunctionDeclaration')functions.set(node.id.name,node);
  if(node.type==='VariableDeclarator'&&node.id.type==='Identifier')declarations.set(node.id.name,node);
  if(node.type==='AssignmentExpression'&&node.left.type==='MemberExpression')assignments.push(node);
});
const raw=node=>source.slice(node.start,node.end);
const unique=name=>{const found=methods.filter(n=>n.key.name===name);assert.equal(found.length,1,name);return raw(found[0]);};
const screens={Lobby:'room',CustomGame:'browser'};
const Runtime = vm.runInNewContext(`(class {${['wlCaptureRoom','wlResumeRoom','wlHandleRoomState'].map(unique).join('\n')}})`, {
  Map,Set,JSON,console,setInterval:()=>12,
  Ks:{ScreenType:screens},es:{LobbyType:{MultiplayerHost:'host',MultiplayerGuest:'guest'}},oa:{OperationCanceledError:class extends Error{}}
});
const plain=x=>JSON.parse(JSON.stringify(x));
function fixture(hostMode=true){
  const x=new Runtime(),calls=[];
  Object.assign(x,{
    hostMode,gameChannelName:'#Actual_room',hostPlayerName:'Alpha',hostRoomDesc:'连战房间',hostIsFreshAccount:false,
    hostPrivateGame:false,isTournament:false,observerSlotIndex:16,currentMapFile:{filename:'unchanged.map'},
    preferredHostOpts:{shortGame:true},currentGameServer:{id:'lan',displayName:'Game-Station'},
    gameOpts:{mapName:'unchanged.map',mapDigest:'same',humanPlayers:[{name:'Alpha',countryId:5,colorId:2,startPos:1,teamId:1},{name:'Bravo',countryId:1,colorId:3,startPos:2,teamId:0}],aiPlayers:[{difficulty:3,countryId:2}]},
    slotsInfo:[{type:'player',name:'Alpha'},{type:'player',name:'Bravo'},{type:'ai',difficulty:3}],
    playerHasMapStatus:new Map([['Alpha',1],['Bravo',1]]),gservCandidates:new Map([['lan',{id:'lan'}]]),playerReadyStatus:new Map([['Bravo',true]]),
    gameOptParser:{parseOptions:JSON.parse},gameOptSerializer:{serializeOptions:JSON.stringify},
    wolCon:{isOpen:()=>true,isInChannel:()=>true,returnToRoom:async(c,g)=>calls.push(['return',c,g]),listUsers:async()=>[{name:'Alpha',ping:5},{name:'Bravo',ping:7}],sendPlayerReady:v=>calls.push(['ready',v])},
    formModel:{},strings:{get:x=>x},messageBoxApi:{show:(...a)=>calls.push(['alert',...a])},
    controller:{toggleSidebarPreview:()=>{},goToScreen:(...a)=>calls.push(['route',...a])},
  });
  for(const name of ['sendGameSlotInfo','sendObserverSlotInfo','sendGameOpts','sendModeMaxSlots','syncSpecialMissionRoom','updateFormModel','initView','updateRanks','updatePings','refreshSidebarButtons'])x[name]=()=>calls.push([name]);
  x.removeHumanPlayer=name=>{x.gameOpts.humanPlayers=x.gameOpts.humanPlayers.filter(p=>p.name!==name);calls.push(['remove',name]);};
  x.updatePlayerPing=(...a)=>calls.push(['ping',...a]);x.updateMapPreview=map=>calls.push(['preview',map.filename]);x.addSystemMessage=t=>calls.push(['message',t]);
  return {x,calls};
}
test('room snapshot keeps country/color/start/team and AI; live match cannot mutate captured settings',()=>{
  const {x}=fixture(),s=x.wlCaptureRoom('first-game');
  assert.equal(s.gameId,'first-game');assert.equal(s.gameChannelName,x.gameChannelName);
  assert.deepEqual(plain(s.gameOpts),plain(x.gameOpts));
  x.gameOpts.humanPlayers[0].countryId=99;x.slotsInfo[0].name='mutated';x.playerHasMapStatus.clear();
  assert.equal(s.gameOpts.humanPlayers[0].countryId,5);assert.equal(s.slotsInfo[0].name,'Alpha');assert.equal(s.playerHasMapStatus.size,2);
});
for(const hostMode of [true,false])test(`fresh ${hostMode?'host':'guest'} lobby restores the actual room and clears readiness`,async()=>{
  const {x}=fixture(hostMode),state=x.wlCaptureRoom('first-game'),fresh=fixture(hostMode);fresh.x.playerReadyStatus.set('OldPlayer',true);
  await fresh.x.wlResumeRoom(state,{throwIfCancelled(){}});
  assert.deepEqual(fresh.calls.find(c=>c[0]==='return'),['return','#Actual_room','first-game']);
  assert.equal(fresh.x.playerReadyStatus.get('Bravo'),false);assert.equal(fresh.x.playerReadyStatus.has('OldPlayer'),false);
  assert.deepEqual(plain(fresh.x.gameOpts),plain(state.gameOpts));
  assert.ok(fresh.calls.some(c=>c[0]==='preview'));assert.equal(fresh.calls.some(c=>c[0]==='ready'&&c[1]===false),!hostMode);
  assert.equal(fresh.x.playerReadyStatus.has('Alpha'),false,'host must not become an unready guest blocking the next game');
  assert.equal(fresh.calls.some(c=>c[0]==='sendGameSlotInfo'),hostMode);
  assert.equal(fresh.x.formModel.lobbyType,hostMode?'host':'guest');
});
test('returning host removes departed participants without resetting other players or AI',async()=>{
  const {x}=fixture(),s=x.wlCaptureRoom('first-game');x.wolCon.listUsers=async()=>[{name:'Alpha'}];
  await x.wlResumeRoom(s,{throwIfCancelled(){}});
  assert.deepEqual(x.gameOpts.humanPlayers.map(p=>p.name),['Alpha']);
  assert.equal(x.gameOpts.humanPlayers[0].teamId,1);assert.equal(x.gameOpts.aiPlayers[0].difficulty,3);
});
test('closed rooms show an explicit fallback and never recreate a room',async()=>{
  const {x,calls}=fixture(),s=x.wlCaptureRoom('first-game');x.wolCon.isInChannel=()=>false;
  await x.wlResumeRoom(s,{throwIfCancelled(){}});
  const alert=calls.find(c=>c[0]==='alert');assert.ok(alert);alert[3]();
  assert.deepEqual(calls.find(c=>c[0]==='route').slice(0,2),['route','browser']);assert.ok(!calls.some(c=>c[0]==='return'));
});
test('returned host can actually start the next match after the guest readies',async()=>{
  const {x}=fixture(),s=x.wlCaptureRoom('first-game');await x.wlResumeRoom(s,{throwIfCancelled(){}});
  const node=methods.find(n=>n.key.name==='refreshSidebarButtons'&&raw(n).includes('this.wlWaiting'));assert.ok(node);
  const Buttons=vm.runInNewContext(`(class {${raw(node)}})`,{Dr:{WolHasMapStatus:{NoMap:0}},tc:()=>false,fe:{OBS_COUNTRY_ID:-3},Ks:{ScreenType:screens},ur:()=>true});
  let buttons,started,requested=false;
  x.wlWaiting=[];x.playerReadyStatus.set('Bravo',true);x.wolCon.getCurrentUser=()=> 'Alpha';
  x.wolCon.startGame=names=>started=names;x.wolCon.sendGameStartRequest=()=>requested=true;
  x.controller.setSidebarButtons=b=>buttons=b;x.refreshSidebarMpText=()=>{};x.meetsMinimumTeams=()=>true;x.clearHostIdleCloseTimer=()=>{};
  Buttons.prototype.refreshSidebarButtons.call(x);assert.equal(buttons[0].disabled,false);buttons[0].onClick();
  assert.equal(requested,false);assert.deepEqual(started,['Alpha','Bravo']);
  x.wlWaiting=['Bravo'];started=undefined;Buttons.prototype.refreshSidebarButtons.call(x);assert.equal(buttons[0].disabled,true);buttons[0].onClick();assert.equal(started,undefined);
});
test('actual game-start handler passes a room route and marks membership for retention',async()=>{
  const handlers=assignments.filter(n=>n.left.property?.name==='handleGameStart'&&raw(n.right).includes('wlCaptureRoom'));
  assert.equal(handlers.length,1);
  const factory=vm.runInNewContext(`(function(){return ${raw(handlers[0].right)}})`,{
    M1:{MainMenuRoute:class{constructor(screenType,params){Object.assign(this,{screenType,params});}}},Ks:{ScreenType:screens},Dr:{WolHasMapStatus:{MapTransfer:2}}
  });
  for(const hostMode of [true,false]){
    const {x}=fixture(hostMode);x.wolCon.getCurrentUser=()=>hostMode?'Alpha':'Bravo';x.lobbyForm={};let args;
    x.rootController={createGame:(...a)=>args=a,joinGame:(...a)=>args=a};
    await factory.call(x)({gameId:'wire-game',timestamp:123,gservUrl:'ws://local/gserv'});
    const route=args.at(-1);assert.equal(route.screenType,'room');assert.equal(route.params.winlifeResume.gameId,'wire-game');assert.equal(x.wlKeepRoom,true);
  }
});
test('retained membership is scoped to entering a match; an explicit lobby exit still leaves',async()=>{
  const m=methods.find(n=>n.key.name==='onLeave'&&raw(n).includes('const wlKeep='));assert.ok(m);
  const C=vm.runInNewContext(`(class {${raw(m)}})`,{clearInterval(){}});
  const event={unsubscribe(){}};
  for(const keep of [true,false]){
    let parts=0;const x=new C();Object.assign(x,{wlKeepRoom:keep,gameChannelName:'#room',wolCon:{isOpen:()=>true,getCurrentUser:()=>true,leaveChannel:()=>parts++,onGameOpt:event,onGameStart:event,onGameServer:event,onLeaveChannel:event,onJoinChannel:event,onChatMessage:event,onClose:event,onPartyUpdate:event},wolService:{onWolConnectionLost:event},disposables:{dispose(){}},playerProfiles:new Map(),gservCandidates:new Map(),clearHostIdleCloseTimer(){},controller:{toggleSidebarPreview(){}},unrender:async()=>{}});
    await x.onLeave();assert.equal(parts,keep?0:1);assert.equal(x.wlKeepRoom,false);
  }
});
test('score page labels the actual return action and routes directly to retained room',()=>{
  const m=methods.find(n=>n.key.name==='initView'&&raw(n).includes('a?.params?.winlifeResume'));assert.ok(m);
  const C=vm.runInNewContext(`(class {${raw(m)}})`);let buttons,route;const stop=new Error('view captured'),x=new C();
  x.strings={get:k=>k};x.controller={setSidebarButtons:b=>buttons=b,showSidebarButtons:()=>{throw stop},goToScreen:(...a)=>route=a};
  const target={screenType:'room',params:{winlifeResume:{gameId:'same-room'}}};
  assert.throws(()=>x.initView({returnTo:target}),e=>e===stop);assert.equal(buttons[0].label,'返回房间');buttons[0].onClick();assert.deepEqual(route,['room',target.params]);
});
test('archived maps have Chinese display names and match their declared SHA256; an optional baseline is preserved',()=>{
  const root=path.resolve(path.dirname(bundle),'..'),catalog=JSON.parse(fs.readFileSync(path.join(root,'maps/catalog.json')));
  assert.ok(catalog.maps.length>0);
  for(const map of catalog.maps){
    assert.match(map.title,/[\u3400-\u9fff]/);assert.equal(typeof map.originalTitle,'string');
    const bytes=fs.readFileSync(path.join(root,'maps/files',map.file));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),map.sha256);
  }
  if(process.env.RA2_PREVIOUS_RELEASE){
    const originals=JSON.parse(fs.readFileSync(path.join(process.env.RA2_PREVIOUS_RELEASE,'maps/catalog.json'))).maps.filter(map=>map.source!=='winlife');
    assert.ok(originals.length>0,'Baseline must contain third-party source maps');
    for(const original of originals){
      const current=catalog.maps.find(map=>map.file===original.file);assert.ok(current,'Original map must remain archived: '+original.file);
      assert.equal(current.sha256,original.sha256);
      assert.equal(current.originalTitle,original.originalTitle||original.title);
    }
  }
});
test('native title rendering translates screenshot names and retains the player count suffix',()=>{
  const Context=vm.createContext({});vm.runInContext(`const wlChineseMapNames=${raw(declarations.get('wlChineseMapNames').init)};${raw(functions.get('wlChineseMapTitle'))};${raw(functions.get('lZ'))};${raw(functions.get('NB'))};function BB(){}function go(x){return x}function kB(x){return x}`,Context);
  const title=vm.runInContext('NB',Context);
  for(const [english,chinese,players]of [['Bonanza','巨富',4],['Bonanza','巨富',16],['Valley of Gems','宝石山谷',4],['Hammer and Sickle','正面冲突',4],['Magma','岩浆',6],['Near Ore Far','咫尺天涯',8],['New Heights','新顶点',2]]){
    // Semantic deduplication adds an explicit version label for distinct namesakes.
    const translated=chinese+'(?:（版本\\d+）)?';
    assert.match(title('unknown.map',english,players,'',false),new RegExp('^'+translated+' \\(2'+(players>2?'-'+players:'')+'\\)$'));
    assert.match(title('unknown.map',english+` (2-${players})`,players,'',false),new RegExp('^'+translated+' \\(2-'+players+'\\)$'));
  }
  assert.equal(title('my.map','我的新地图',4,'',false),'我的新地图 (2-4)');
  assert.equal(title('my.map','Personal custom title',4,'',false),'Personal custom title (2-4)');
});
