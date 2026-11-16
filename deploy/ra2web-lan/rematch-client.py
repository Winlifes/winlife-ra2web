"""Retain the actual WOL room across matches; restore a fresh lobby view."""


def once(text, before, after):
    assert text.count(before) == 1, f"Rematch anchor ({text.count(before)}): {before[:100]}"
    return text.replace(before, after, 1)


METHODS = '''wlCaptureRoom(gameId){
const keys=["gameChannelName","hostMode","hostPlayerName","hostIsFreshAccount","hostRoomDesc","isTournament","hostPrivateGame","observerSlotIndex","currentMapFile","preferredHostOpts","currentGameServer"];
const state={gameId};for(const key of keys)state[key]=this[key];
state.gameOpts=this.gameOptParser.parseOptions(this.gameOptSerializer.serializeOptions(this.gameOpts));
state.slotsInfo=this.slotsInfo.map(slot=>({...slot}));
state.playerHasMapStatus=new Map(this.playerHasMapStatus);state.gservCandidates=new Map(this.gservCandidates);
return state}
async wlResumeRoom(state,token){
if(!this.wolCon.isOpen()||!this.wolCon.isInChannel(state.gameChannelName)){
this.messageBoxApi.show("原房间已关闭，请重新建立或加入房间。",this.strings.get("GUI:Ok"),()=>this.controller?.goToScreen(Ks.ScreenType.CustomGame,{}));return}
const keys=["gameChannelName","hostMode","hostPlayerName","hostIsFreshAccount","hostRoomDesc","isTournament","hostPrivateGame","observerSlotIndex","currentMapFile","preferredHostOpts","currentGameServer","gameOpts","slotsInfo"];
for(const key of keys)this[key]=state[key];
this.playerHasMapStatus=new Map(state.playerHasMapStatus);this.gservCandidates=new Map(state.gservCandidates);
this.playerReadyStatus.clear();for(const player of this.gameOpts.humanPlayers)if(player.name!==this.hostPlayerName)this.playerReadyStatus.set(player.name,!1);
this.wlWaiting=state.gameOpts.humanPlayers.map(player=>player.name);
this.formModel.lobbyType=this.hostMode?es.LobbyType.MultiplayerHost:es.LobbyType.MultiplayerGuest;
this.formModel.activeSlotIndex=this.hostMode?(this.observerSlotIndex===0?-1:0):-1;
this.formModel.channels=[this.gameChannelName];this.formModel.selectedGameServer=this.currentGameServer?.displayName||this.currentGameServer?.id;
this.title=this.strings.get(this.hostMode?"GUI:HostScreen":"GUI:JoinScreen");
try{
await this.wolCon.returnToRoom(this.gameChannelName,state.gameId);token.throwIfCancelled();
const users=await this.wolCon.listUsers(this.gameChannelName);token.throwIfCancelled();
if(this.hostMode){
const present=new Set(users.map(user=>user.name));
for(const player of [...this.gameOpts.humanPlayers])if(!present.has(player.name))this.removeHumanPlayer(player.name);
this.sendGameSlotInfo();this.sendObserverSlotInfo();this.sendGameOpts();this.sendModeMaxSlots();
this.hostOptsIntervalId=setInterval(()=>{this.wolCon.isOpen()&&this.gameChannelName&&(this.sendGameOpts(),this.updatePings())},5e3)
}
for(const user of users)this.updatePlayerPing(user.name,user.ping);
this.syncSpecialMissionRoom();this.updateFormModel();this.controller.toggleSidebarPreview(!0);
if(this.currentMapFile)this.updateMapPreview(this.currentMapFile);
this.initView();this.updateRanks();if(!this.hostMode)this.wolCon.sendPlayerReady(!1);
this.addSystemMessage("已返回原房间，地图和玩家设置已保留。请重新准备。")
}catch(error){if(!(error instanceof oa.OperationCanceledError))this.messageBoxApi.show("原房间已关闭或连接已失效，请重新加入。",this.strings.get("GUI:Ok"),()=>this.controller?.goToScreen(Ks.ScreenType.CustomGame,{}))}}
wlHandleRoomState(text){
let state;try{state=JSON.parse(text)}catch{return}
if(!Array.isArray(state.waiting)||state.waiting.some(name=>typeof name!=="string"))return;
this.wlWaiting=state.waiting;this.refreshSidebarButtons()
}
'''


def patch_client(text):
    if 'wlCaptureRoom(gameId)' in text:
        start = text.index('wlCaptureRoom(gameId)')
        end = text.index('async onEnter(s){if(this.wolCon.getCurrentUser()){', start)
        return text[:start] + METHODS + text[end:]
    text = once(text, 'leaveAllChannels(){for(const e of this.getCurrentChannels())this.leaveChannel(e)}',
        'async returnToRoom(e,t){const r=await this.con.sendCommand(`returngame ${Ci.escapeChannelName(e)} ${t}`,{replyCodes:[710,711]});if(r[0].code!==710)throw new Error("Room no longer exists")}leaveAllChannels(){for(const e of this.getCurrentChannels())this.leaveChannel(e)}')
    text = once(text,
        'B=new M1.MainMenuRoute(Ks.ScreenType.Login,{afterLogin:U=>new M1.MainMenuRoute(Ks.ScreenType.CustomGame,{messages:U})});this.lobbyForm||',
        'B=new M1.MainMenuRoute(Ks.ScreenType.Lobby,{winlifeResume:this.wlCaptureRoom(_.gameId)});this.wlKeepRoom=!0;this.lobbyForm||')
    text = once(text, 's.create===!0?(this.hostMode=!0,this.title=this.strings.get("GUI:HostScreen"),this.createGame(t)):',
        's.winlifeResume?await this.wlResumeRoom(s.winlifeResume,t):s.create===!0?(this.hostMode=!0,this.title=this.strings.get("GUI:HostScreen"),this.createGame(t)):')
    text = once(text, 'async onLeave(){this.wolCon.isOpen()&&this.wolCon.getCurrentUser()&&this.gameChannelName&&this.wolCon.leaveChannel(this.gameChannelName),',
        'async onLeave(){const wlKeep=this.wlKeepRoom;this.wlKeepRoom=!1;!wlKeep&&this.wolCon.isOpen()&&this.wolCon.getCurrentUser()&&this.gameChannelName&&this.wolCon.leaveChannel(this.gameChannelName),')
    text = once(text, 'let R=_.opt,k=R[0];if(this.hostMode){',
        'let R=_.opt,k=R[0];if(k==="W"){this.wlHandleRoomState(R.slice(1));return}if(this.hostMode){')
    text = once(text, 'async onEnter(s){if(this.wolCon.getCurrentUser()){',
        METHODS + 'async onEnter(s){if(this.wolCon.getCurrentUser()){this.wlWaiting=[];')
    text = once(text, 'label:s.get("GUI:StartGame"),tooltip:s.get("STT:HostButtonGo"),disabled:!1,onClick:()=>{if(!this.wolCon.isOpen())return;',
        'label:s.get("GUI:StartGame"),tooltip:this.wlWaiting?.length?"等待其他玩家返回房间":s.get("STT:HostButtonGo"),disabled:!!this.wlWaiting?.length,onClick:()=>{if(!this.wolCon.isOpen()||this.wlWaiting?.length)return;')
    text = once(text, 'refreshSidebarMpText(){this.gameOpts?this.controller.setSidebarMpContent({text:',
        'refreshSidebarMpText(){this.gameOpts?this.controller.setSidebarMpContent({text:(this.wlWaiting?.length?"等待返回："+this.wlWaiting.join("、")+"\\n\\n":"")+')
    text = once(text, 'initView({game:e,localPlayer:t,isQuit:i,singlePlayer:r,tournament:n,returnTo:a}){this.controller.setSidebarButtons([{label:this.strings.get("GUI:Continue"),',
        'initView({game:e,localPlayer:t,isQuit:i,singlePlayer:r,tournament:n,returnTo:a}){this.controller.setSidebarButtons([{label:a?.params?.winlifeResume?"返回房间":this.strings.get("GUI:Continue"),')
    return text
