/* Per-browser identity and recoverable game routes. No game state is invented. */
(() => {
  'use strict';
  const build=document.currentScript?.dataset.version||'',origin=location.origin;
  const recoveryBuilds=new Set([build,...(document.currentScript?.dataset.recoverBuilds||'').split(',').filter(Boolean)]);
  const identityKey='winlife.client-id',epochKey='winlife.page-epoch';
  let identity,epoch;
  try {
    identity=localStorage.getItem(identityKey);
    if(!/^[a-f0-9-]{32,64}$/i.test(identity||'')){identity=crypto.randomUUID();localStorage.setItem(identityKey,identity);}
    epoch=Math.max(Date.now(),(Number(localStorage.getItem(epochKey))||0)+1);localStorage.setItem(epochKey,String(epoch));
  } catch {identity=crypto.randomUUID();epoch=Date.now();}
  let timer,status,progress;
  const hideProgress=()=>{progress?.remove();progress=undefined;};
  const detach=()=>{if(timer!==undefined)clearInterval(timer);timer=undefined;status?.remove();status=undefined;hideProgress();};
  function read(prefs,key){try{return JSON.parse(prefs.getItem(key)||'null');}catch{return null;}}
  function clear(prefs,key){
    const saved=read(prefs,key);
    // An older page must not erase the record written by its replacement.
    if((saved?.winlifeReconnect?.epoch||0)<=epoch)prefs.removeItem(key);
    detach();
  }
  function remember(route,returnTo,serializer){
    let room;
    const state=returnTo?.params?.winlifeResume;
    if(state){
      room={};
      for(const key of ['gameChannelName','hostMode','hostPlayerName','hostIsFreshAccount','hostRoomDesc','isTournament','hostPrivateGame','observerSlotIndex','preferredHostOpts','currentGameServer'])room[key]=state[key];
      room.gameOpts=serializer.serializeOptions(state.gameOpts);room.slotsInfo=state.slotsInfo.map(slot=>({...slot}));
      room.playerHasMapStatus=[...state.playerHasMapStatus];room.gservCandidates=[...state.gservCandidates];
    }else room=route.winlifeReconnect?.room;
    return {...route,winlifeReconnect:{version:1,build,origin,epoch,lastSeenAt:Date.now(),room}};
  }
  function playing(prefs,key){
    detach();
    const touch=()=>{
      const saved=read(prefs,key);
      if(!saved?.winlifeReconnect||saved.winlifeReconnect.epoch>epoch)return detach();
      saved.winlifeReconnect.epoch=epoch;saved.winlifeReconnect.lastSeenAt=Date.now();
      prefs.setItem(key,JSON.stringify(saved));
    };
    touch();timer=setInterval(touch,5000);
  }
  function canRecover(route){
    const meta=route?.winlifeReconnect;
    return meta?.version===1&&recoveryBuilds.has(meta.build)&&meta.origin===origin&&Number.isFinite(meta.lastSeenAt)&&Date.now()-meta.lastSeenAt<330000;
  }
  function restoreRoom(route,parser){
    const state=route.winlifeReconnect?.room;if(!state)return;
    return {...state,gameId:route.gameId,gameOpts:parser.parseOptions(state.gameOpts),playerHasMapStatus:new Map(state.playerHasMapStatus),gservCandidates:new Map(state.gservCandidates)};
  }
  function showStatus({attempt,remainingMs,catchingUp=false,onCancel}){
    hideProgress();
    if(!status){
      status=document.createElement('div');status.id='winlife-reconnect-status';status.setAttribute('role','status');
      Object.assign(status.style,{position:'fixed',zIndex:'100001',left:'50%',top:'24px',transform:'translateX(-50%)',maxWidth:'calc(100vw - 32px)',padding:'16px 20px',background:'#141b20f5',color:'#f0cc83',border:'1px solid #9b8048',borderRadius:'8px',boxShadow:'0 10px 40px #0008',font:'15px/1.6 system-ui,sans-serif',cursor:'default'});
      status.append(document.createElement('span'),document.createElement('button'));document.body.append(status);
      const button=status.lastChild;button.textContent='退出对局';Object.assign(button.style,{marginLeft:'18px',padding:'6px 12px',cursor:'pointer'});
    }
    status.firstChild.textContent=catchingUp?'连接已恢复，正在追赶对局进度…':`连接中断，正在重连（第 ${attempt} 次，剩余 ${Math.max(0,Math.ceil(remainingMs/1000))} 秒）…`;
    status.lastChild.onclick=onCancel;
  }
  function hideStatus(){status?.remove();status=undefined;}
  function catchUp(loop,now){
    const manager=loop.gameTurnMgr;
    // Drive the existing tick method: actions, rate changes, state hashes and
    // after-turn notifications follow precisely the same path as live play.
    if(!loop.options.skipFrames||!Number.isInteger(manager.receivedNetworkTurn)||manager.receivedNetworkTurn-manager.currentNetworkTurn<=2||manager.errorState){hideProgress();return;}
    if(!loop.paused&&!status){
      if(!progress){progress=document.createElement('div');progress.id='winlife-replay-progress';progress.setAttribute('role','status');Object.assign(progress.style,{position:'fixed',zIndex:'100000',left:'50%',top:'24px',transform:'translateX(-50%)',padding:'14px 20px',background:'#141b20f5',color:'#f0cc83',border:'1px solid #9b8048',borderRadius:'8px',font:'15px/1.6 system-ui,sans-serif'});document.body.append(progress);}
      progress.textContent=`正在恢复对局进度… ${manager.currentNetworkTurn} / ${manager.receivedNetworkTurn}`;
    }
    const deadline=performance.now()+8;
    for(let ticks=0;ticks<4096&&manager.currentNetworkTurn<manager.receivedNetworkTurn&&performance.now()<deadline;ticks++){
      const turn=manager.currentNetworkTurn,subTurn=manager.currentSubTurn;
      loop.turnMgrIsWaiting=loop.tickGame(now)===false;
      if(loop.turnMgrIsWaiting||manager.errorState||(manager.currentNetworkTurn===turn&&manager.currentSubTurn===subTurn))break;
    }
    if(manager.receivedNetworkTurn-manager.currentNetworkTurn<=2)hideProgress();
  }
  function transportUrl(value){
    try{const url=new URL(value,location.href);if(!['/wol','/gserv'].includes(url.pathname))return value;url.searchParams.set('winlifeClientId',identity);url.searchParams.set('winlifeEpoch',String(epoch));return url.href;}catch{return value;}
  }
  window.winlifeReconnect={remember,playing,clear,detach,canRecover,restoreRoom,showStatus,hideStatus,transportUrl,catchUp};
})();
