"""Reconnect native game sockets and preserve a route for full deterministic replay."""

LEAVE = '''async wlLeaveGame(){/* winlife-intentional-exit */
this.wlLeavingGame=!0;this.ignoringStallClose=!0;
window.winlifeReconnect?.clear(this.localPrefs,eu.StorageKey.LastConnection);
const tasks=[],wol=this.wolService?.getConnection(),room=this.returnTo?.params?.winlifeResume;
if(this.gservCon?.isOpen())tasks.push(this.gservCon.leaveGame());
const channel=room?.gameChannelName??wol?.getCurrentGameChannel?.(),id=this.gservStallRoute?.gameId;
if(wol?.isOpen()&&channel&&id)tasks.push(wol.abandonGame(channel,id));
await Promise.race([Promise.allSettled(tasks),Fl.sleep(2500)])
}'''

RECONNECT = '''async reconnectAfterStall(s){/* winlife-reconnect */
const e=this.gservStallRoute;if(this.wlLeavingGame||this.stallReconnectInFlight||this.isSinglePlayer||!e||!this.game||this.game.status===ak.Ended)return;
const t=this.gameCancellationSource?.token,deadline=Date.now()+90000,ui=window.winlifeReconnect;
const cancel=async()=>{await this.wlLeaveGame();this.gameCancellationSource?.cancel();this.controller?.goToScreen(Jd.ScreenType.MainMenuRoot,{route:this.returnTo??new za.MainMenuRoute(Va.ScreenType.Home)})};
this.stallReconnectInFlight=!0;this.ignoringStallClose=!0;this.pointer.unlock();let error;
try{
for(let attempt=1;Date.now()<deadline;attempt++){
if(t?.isCancelled()||this.wlLeavingGame)return;
ui?.showStatus({attempt,remainingMs:deadline-Date.now(),onCancel:cancel});
try{
this.gservCon.closeForStallReconnect();await Fl.sleep(attempt===1?50:Math.min(4000,attempt*750),t);if(t?.isCancelled()||this.wlLeavingGame)return;
await this.gservCon.connect(e.target,{cancelToken:t});if(t?.isCancelled()||this.wlLeavingGame)return;await this.gservCon.cvers(this.engineVersion);await this.gservCon.login(e.user,e.pass);
if(t?.isCancelled()||this.wlLeavingGame)return;await this.gservCon.joinGame(e.gameId,this.engineVersion,this.engineModHash);
const target=await this.gservCon.resumeStall(s.lastReceivedTurn,s.hasReceivedTurn);
if(t?.isCancelled()||this.wlLeavingGame)return;
this.gservCon.sendPlayerActive(!this.lockstepManager?.passiveMode);
this.gservCon.wlResendPlayerActions();
ui?.showStatus({attempt,remainingMs:deadline-Date.now(),catchingUp:!0,onCancel:cancel});
while(Number.isInteger(target)&&this.lockstepManager&&!this.lockstepManager.passiveMode&&this.lockstepManager.currentNetworkTurn<target&&Date.now()<deadline){if(t?.isCancelled()||this.wlLeavingGame)return;if(!this.gservCon.isOpen())throw new Error("Connection lost during recovery");await Fl.sleep(100,t)}
if(Number.isInteger(target)&&this.lockstepManager&&!this.lockstepManager.passiveMode&&this.lockstepManager.currentNetworkTurn<target)throw new Error("追赶对局进度超时，可刷新页面后重试");
if(this.lockstepManager){this.lockstepManager.handleCommsLag(!1,performance.now());this.lockstepManager.stallReconnectRequested=!1}
return;
}catch(failure){
error=failure;if(t?.isCancelled()||this.wlLeavingGame)return;
if(this.lockstepManager?.errorState)return;
if(failure instanceof pi.GservError&&[pi.GservError.Code.InstanceNonExistent,pi.GservError.Code.InstanceVersMismatch,pi.GservError.Code.InstanceNotAllowed,pi.GservError.Code.BadLogin].includes(failure.code)){ui?.clear(this.localPrefs,eu.StorageKey.LastConnection);break}
}
}
this.ignoringStallClose=!1;if(!t?.isCancelled())this.handleFatalGservClose(error||new Error("重连超时，可刷新页面后重试"));
}finally{ui?.hideStatus();this.ignoringStallClose=!1;this.stallReconnectInFlight=!1}
}'''


def replace(text, before, after):
    if after in text:
        return text
    assert text.count(before) == 1, 'Reconnect anchor changed: ' + before[:100]
    return text.replace(before, after, 1)


def patch_client(text):
    start = text.index('async wlLeaveGame(){') if 'async wlLeaveGame(){' in text else text.index('async reconnectAfterStall(s){')
    end = text.index('handleFatalGservClose(s){', start)
    text = text[:start] + LEAVE + RECONNECT + text[end:]
    text = replace(text,
        'this.lastPerformanceFrameTimestamp=a;let l=this.updateDeltaGameFrames(a);',
        'this.lastPerformanceFrameTimestamp=a;window.winlifeReconnect?.catchUp(this,a);let l=this.updateDeltaGameFrames(a);')
    text = replace(text,
        'if(this.isStarted&&this.paused){let o=this.updateDeltaGameFrames(a);',
        'if(this.isStarted&&this.paused){window.winlifeReconnect?.catchUp(this,a);let o=this.updateDeltaGameFrames(a);')
    close_handler = 'const u=m=>{if(this.wlLeavingGame||this.ignoringStallClose||i.isCancelled()||d)return;if(this.config.stallReconnectEnabled&&this.game&&this.lockstepManager){this.reconnectAfterStall({lastReceivedTurn:this.lockstepManager.receivedNetworkTurn,hasReceivedTurn:this.lockstepManager.hasReceivedTurn});return}d=!0;this.gservCon.onClose.unsubscribe(u);this.handleFatalGservClose(m)};'
    previous_close_handler = close_handler.replace('this.wlLeavingGame||', '')
    if previous_close_handler in text:
        text = text.replace(previous_close_handler, close_handler, 1)
    text = replace(text,
        'const u=m=>{this.ignoringStallClose||i.isCancelled()||d||(d=!0,this.gservCon.onClose.unsubscribe(u),this.handleFatalGservClose(m))};',
        close_handler)
    text = replace(text,
        'sendPlayerActions(e,t){const i=new gy(6);i.writeUint8(ig),i.writeUint8(fAe),i.writeUint32(e),i.writeUint8Array(t),this.con.sendMessage(i.toUint8Array())}',
        'wlResendPlayerActions(){for(const[e,t]of this.wlActionOutbox??[])this.sendPlayerActions(e,t)}sendPlayerActions(e,t){this.wlActionOutbox??=new Map;this.wlActionOutbox.set(e,t.slice());while(this.wlActionOutbox.size>64)this.wlActionOutbox.delete(this.wlActionOutbox.keys().next().value);if(!this.isOpen())return;const i=new gy(6);i.writeUint8(ig),i.writeUint8(fAe),i.writeUint32(e),i.writeUint8Array(t);try{this.con.sendMessage(i.toUint8Array())}catch(error){if(this.isOpen())throw error}}')
    text = replace(text,
        'close(){this.con.onMessage.unsubscribe(this.handleMessage),this.con.close(),this.currentUser=void 0}closeForStallReconnect()',
        'close(){this.wlActionOutbox?.clear();this.con.onMessage.unsubscribe(this.handleMessage),this.con.close(),this.currentUser=void 0}closeForStallReconnect()')
    text = replace(text,
        'wlResendPlayerActions(){',
        'async leaveGame(){await this.con.sendCommand("leavegame",{replyCodes:[720,721],timeout:2})}wlResendPlayerActions(){')
    text = replace(text,
        'throw new Ui("Resume error: "+n,Ui.Code.InstanceAlreadyStarted)}}isOpen()',
        'throw new Ui("Resume error: "+n,Ui.Code.InstanceAlreadyStarted)}return Number(String(r[0].params?.at(-1)??"NaN").replace(/^:/,""))}isOpen()')
    text = replace(text,
        'const R=new WebSocket(e.url);window.winlifeNetwork?.observe(R,e.url);',
        'const R=new WebSocket(window.winlifeReconnect?.transportUrl(e.url)??e.url);window.winlifeNetwork?.observe(R,e.url);')
    text = replace(text,
        'this.localPrefs.setItem(eu.StorageKey.LastConnection,JSON.stringify(g))',
        'this.localPrefs.setItem(eu.StorageKey.LastConnection,JSON.stringify(window.winlifeReconnect?.remember(g,p,this.gameOptsSerializer)??g))')
    text = replace(text,
        'if(!h||h.user!==r)return this.localPrefs.removeItem(eu.StorageKey.LastConnection),void this.controller?.goToScreen(',
        'if(!h||h.user!==r)return void this.controller?.goToScreen(')
    text = replace(text,
        'this.returnTo=s.returnTo,this.isTournament=s.tournament;',
        'this.returnTo=s.returnTo;if(!this.returnTo&&s.winlifeReconnect?.room){const restored=window.winlifeReconnect?.restoreRoom(s,this.gameOptsParser);if(restored)this.returnTo=new za.MainMenuRoute(Va.ScreenType.Lobby,{winlifeResume:restored})}this.isTournament=s.tournament;')
    text = replace(text,
        'this.returnTo=s.returnTo;if(!this.returnTo&&s.winlifeReconnect?.room){',
        'this.wlLeavingGame=!1;this.returnTo=s.returnTo;if(!this.returnTo&&s.winlifeReconnect?.room){')
    text = replace(text,
        'const h=await this.transferAndLoadMapFile(s,a.mapName,a.mapDigest,i);ei(a.gameMode)',
        'const h=await this.transferAndLoadMapFile(s,a.mapName,a.mapDigest,i);if(this.returnTo?.params?.winlifeResume)this.returnTo.params.winlifeResume.currentMapFile=h;ei(a.gameMode)')
    text = replace(text,
        'onGameStart(s,e,t,i,r,n,a){this.initBattleRendering(s,e,t),this.localPrefs.removeItem(eu.StorageKey.LastConnection),',
        'onGameStart(s,e,t,i,r,n,a){this.initBattleRendering(s,e,t),!this.isSinglePlayer&&window.winlifeReconnect?.playing(this.localPrefs,eu.StorageKey.LastConnection),')
    # Remove the record on deliberate quit or completed/defeated games. Leaving
    # a crashed/disconnected screen only detaches its timer, retaining recovery.
    text = replace(text,
        'this.isSinglePlayer||this.sendGameRes(t,{disconnect:!1,desync:!1,quit:!0,finished:!1})',
        'window.winlifeReconnect?.clear(this.localPrefs,eu.StorageKey.LastConnection),this.isSinglePlayer||this.sendGameRes(t,{disconnect:!1,desync:!1,quit:!0,finished:!1})')
    text = replace(text,
        'async onGameEnd(s,e,t,i){',
        'async onGameEnd(s,e,t,i){window.winlifeReconnect?.clear(this.localPrefs,eu.StorageKey.LastConnection);')
    text = replace(text,
        '!i.isObserver&&!this.isSinglePlayer&&!this.lagState&&(r.push(n.create(c1.ActionType.ResignGame)),await new Promise(a=>{this.lockstepManager.onActionsSent.subscribeOnce(()=>a())}))',
        '!this.isSinglePlayer&&await this.wlLeaveGame()')
    text = replace(text,
        'handleFatalGservClose(s){QS("disconnect"),',
        'handleFatalGservClose(s){if(this.wlLeavingGame)return;QS("disconnect"),')
    text = replace(text,
        'async onLeave(){pCe()?.phase!=="score"&&qd("menu"),',
        'async onLeave(){window.winlifeReconnect?.detach();pCe()?.phase!=="score"&&qd("menu"),')
    if 'if(c&&window.winlifeReconnect?.canRecover(c)===!1)' not in text:
        text = replace(text,
            'if(c){const u=await a.confirm(this.strings.get("TS:ReconnectPrompt")',
            'if(c&&window.winlifeReconnect?.canRecover(c)===!1){this.localPrefs.removeItem(Fr.StorageKey.LastConnection);c=void 0}if(c){const u=await a.confirm(this.strings.get("TS:ReconnectPrompt")')
    text = replace(text,
        'a.confirm(this.strings.get("TS:ReconnectPrompt"),this.strings.get("TS:Reconnect"),this.strings.get("GUI:Quit"))',
        'a.confirm("检测到未结束的联机对局。是否继续上一局？刷新恢复需要追赶对局进度。","继续上一局","放弃恢复")')
    text = replace(text,
        'async returnToRoom(e,t){',
        'async restoreGameRoom(e,t){const r=await this.con.sendCommand(`resumeroom ${Ci.escapeChannelName(e)} ${t}`,{replyCodes:[710,711]});if(r[0].code!==710)throw new Error("Room no longer exists");this.currentChannels.add(e);this.currentGameChannel=e}async returnToRoom(e,t){')
    text = replace(text,
        'async restoreGameRoom(e,t){',
        'async abandonGame(e,t){await this.con.sendCommand(`abandongame ${Ci.escapeChannelName(e)} ${t}`,{replyCodes:[712,713],timeout:2})}async restoreGameRoom(e,t){')
    text = replace(text,
        'async wlResumeRoom(state,token){\nif(!this.wolCon.isOpen()',
        'async wlResumeRoom(state,token){\nif(this.wolCon.isOpen()&&!this.wolCon.isInChannel(state.gameChannelName)){try{await this.wolCon.restoreGameRoom(state.gameChannelName,state.gameId)}catch{}}\nif(!this.wolCon.isOpen()')
    for namespace in ['eu', 'Fr']:
        text = text.replace('this.localPrefs.removeItem(' + namespace + '.StorageKey.LastConnection)',
            'window.winlifeReconnect?.clear(this.localPrefs,' + namespace + '.StorageKey.LastConnection)')
    return text
