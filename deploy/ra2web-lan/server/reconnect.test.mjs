import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createLanServer} from './server.mjs';
const password=Buffer.from('reconnect-test-password').toString('base64');
const has=text=>message=>typeof message==='string'&&message.includes(text);
async function peer(port,service,{key,epoch=1,autoPong=true}={}){
  const query=key?'?winlifeClientId='+key+'&winlifeEpoch='+epoch:'';
  const ws=new WebSocket(`ws://127.0.0.1:${port}/${service}${query}`,{autoPong});
  const messages=[],listeners=new Set();
  ws.on('message',(bytes,binary)=>{for(const message of binary?[Buffer.from(bytes)]:bytes.toString().split(/\r?\n/).filter(Boolean)){messages.push(message);for(const listener of [...listeners])listener(message);}});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const wait=(predicate,after=0,timeout=5000)=>{
    const present=messages.slice(after).find(predicate);if(present!==undefined)return Promise.resolve(present);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{listeners.delete(receive);reject(new Error('Reply timeout '+service));},timeout);
      const receive=message=>{if(predicate(message)){clearTimeout(timer);listeners.delete(receive);resolve(message);}};listeners.add(receive);});
  };
  const send=message=>ws.send(typeof message==='string'?message+'\r\n':message);
  return {ws,messages,send,wait,request(message,predicate){const after=messages.length;send(message);return wait(predicate,after);}};
}
async function login(port,service,name,options){
  const p=await peer(port,service,options);
  if(service==='wol')await p.request(`pass ${password}\r\nnick ${name}\r\nuser User Host irc :Name`,has(' 376 '));
  else await p.request(`user ${name} ${password}`,has(' 100 '));return p;
}
const close=p=>new Promise(resolve=>{if(p.ws.readyState===WebSocket.CLOSED)return resolve();p.ws.once('close',resolve);p.ws.terminate();});
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(predicate(),'condition timed out');};
const actions=turn=>{const packet=Buffer.from([2,1,0,0,0,0,0]);packet.writeUInt32LE(turn,2);return packet;};
async function fixture(t,options={}){
  const {loadingOnly=false,observerB=false,...serverOptions}=options;
  const server=await createLanServer({port:0,nicknameOnly:true,...serverOptions});t.after(()=>server.close());
  const identityA={key:'a'.repeat(32),epoch:1},identityB={key:'b'.repeat(32),epoch:1};
  const host=await login(server.port,'wol','RecoverAlpha',identityA),guest=await login(server.port,'wol','RecoverBravo',identityB),channel="#RecoverAlpha's_game";
  await host.request(`joingame ${channel} 1 17 45 0 0 0 0`,has(' JOINGAME '));await guest.request(`joingame ${channel} 0`,has(' JOINGAME '));
  const started=await host.request(`startg ${channel} RecoverAlpha,RecoverBravo`,has(' STARTG '));const id=started.match(/ :([a-f0-9-]+) \d+$/)[1];
  const a=await login(server.port,'gserv','RecoverAlpha',identityA),b=await login(server.port,'gserv','RecoverBravo',identityB);
  let optionsWire='0,0,0,10000,0,1,0,1,1,0,0,0,bWFw,2,1,10,bWFw,hash,1,0,0,1,0:RecoverAlpha,0,0,0,-1,0,0,0,RecoverBravo,1,1,1,-1,0,0,0:@:0,-1,-1,-1,-1,';
  if(observerB)optionsWire=optionsWire.replace('RecoverBravo,1,1,1','RecoverBravo,-3,1,1').replace('@:0,-1,-1,-1,-1,','@:0,0,0,0,-1,');
  await a.request(`create ${id} 12345 ${optionsWire} 0.87.3 123 0`,has(' 200 '));await b.request(`join ${id} 0.87.3 123`,has(' 400 '));
  if(!loadingOnly){
    a.send('loaded 100');b.send('loaded 100');await a.wait(has(' 700 '));
    a.send(actions(0));b.send(actions(0));await a.wait(m=>Buffer.isBuffer(m)&&m.readUInt32LE(2)===0);
  }
  return {server,host,guest,a,b,id,channel,game:server.games.get(id),identityA,identityB};
}
test('all game sockets may disappear and a fresh page can reload the same timeline within the grace period',async t=>{
  const f=await fixture(t);await Promise.all([close(f.a),close(f.b)]);await until(()=>f.game.disconnectedAt!==undefined);
  assert.equal(f.server.games.get(f.id),f.game);
  const page=await login(f.server.port,'gserv','RecoverAlpha',{...f.identityA,epoch:2});
  await page.request(`join ${f.id} 0.87.3 123`,has(' 400 '));await page.request('loaded 100',has(' 700 '));
  const packet=await page.wait(Buffer.isBuffer);assert.deepEqual(packet,f.game.history[0]);
  await until(()=>f.game.clients.get('RecoverAlpha').timelineReady);assert.equal(f.game.disconnectedAt,undefined);
});
test('a host network loss preserves the active room and only a participant can restore it',async t=>{
  const f=await fixture(t);await close(f.host);await until(()=>f.server.rooms.get(f.channel)?.disconnected?.has('RecoverAlpha'));
  const host=await login(f.server.port,'wol','RecoverAlpha',{...f.identityA,epoch:2});
  await host.request(`resumeroom ${f.channel} ${f.id}`,has(' 710 '));assert.equal(f.server.rooms.get(f.channel).host,'RecoverAlpha');
  const other=await login(f.server.port,'wol','RecoverOther',{key:'c'.repeat(32)});
  await other.request(`resumeroom ${f.channel} ${f.id}`,has(' 711 '));
  await host.request(`part ${f.channel}`,has(' PART '));assert.equal(f.server.rooms.has(f.channel),false);
});
test('an empty disconnected game and room expire after their configured recovery window',async t=>{
  const f=await fixture(t,{pingIntervalMs:10,reconnectGraceMs:80});await Promise.all([close(f.host),close(f.guest),close(f.a),close(f.b)]);
  await until(()=>f.game.disconnectedAt!==undefined);assert.ok(f.server.games.has(f.id));
  await until(()=>!f.server.games.has(f.id));assert.equal(f.server.rooms.has(f.channel),false);
});
test('a newer page can replace its own stale sockets while old pages and other browsers cannot steal the match',async t=>{
  const f=await fixture(t),fresh={...f.identityA,epoch:2};
  const nextHost=await login(f.server.port,'wol','RecoverAlpha',fresh);await until(()=>f.host.ws.readyState===WebSocket.CLOSED);
  const stale=await peer(f.server.port,'wol',f.identityA);
  await stale.request(`pass ${password}\r\nnick RecoverAlpha\r\nuser User Host irc :Name`,has(' 378 '));
  const stranger=await peer(f.server.port,'wol',{key:'c'.repeat(32),epoch:99});
  await stranger.request(`pass ${password}\r\nnick RecoverAlpha\r\nuser User Host irc :Name`,has(' 378 '));
  const nextGame=await login(f.server.port,'gserv','RecoverAlpha',fresh);await nextGame.request(`join ${f.id} 0.87.3 123`,has(' 400 '));
  const staleGame=await login(f.server.port,'gserv','RecoverAlpha',f.identityA);
  await staleGame.request(`join ${f.id} 0.87.3 123`,has(' 402 '));
  assert.equal(f.game.clients.get('RecoverAlpha').ws.readyState,WebSocket.OPEN);assert.ok(nextHost.ws.readyState===WebSocket.OPEN);
});
test('long history replays with backpressure and keeps rate notifications ahead of their batches',async t=>{
  const f=await fixture(t);await close(f.b);
  f.game.history=[];
  for(let turn=0;turn<1200;turn++){const packet=Buffer.alloc(8192,7);packet[0]=2;packet[1]=1;packet.writeUInt32LE(turn,2);f.game.history.push(packet);}
  f.game.turn=1200;f.game.networkRate.changes.push({turnNo:600,rateMs:200,reason:'fixture'});
  const fresh=await login(f.server.port,'gserv','RecoverBravo',{...f.identityB,epoch:2});await fresh.request(`join ${f.id} 0.87.3 123`,has(' 400 '));
  fresh.send('loaded 100');await fresh.wait(m=>Buffer.isBuffer(m)&&m.readUInt32LE(2)===1199,0,10000);
  const batches=fresh.messages.filter(Buffer.isBuffer);assert.equal(batches.length,1200);assert.equal(fresh.ws.readyState,WebSocket.OPEN);
  for(let turn=0;turn<1200;turn++)assert.deepEqual(batches[turn],f.game.history[turn]);
  assert.ok(fresh.messages.findIndex(has(' 802 * :200,600'))<fresh.messages.findIndex(m=>Buffer.isBuffer(m)&&m.readUInt32LE(2)===600));
});
test('heartbeat removes an unresponsive socket so a network ghost cannot reserve a nickname forever',async t=>{
  const server=await createLanServer({port:0,nicknameOnly:true,pingIntervalMs:10,heartbeatTimeoutMs:50});t.after(()=>server.close());
  const ghost=await login(server.port,'wol','RecoverGhost',{autoPong:false});await until(()=>ghost.ws.readyState===WebSocket.CLOSED);
  const replacement=await login(server.port,'wol','RecoverGhost');assert.equal(replacement.ws.readyState,WebSocket.OPEN);
});

function payloads(packet){
  const result=new Map();let offset=7;
  for(let i=0;i<packet[6];i++){
    const id=packet[offset],size=packet.readUInt16LE(offset+1);offset+=3;
    result.set(id,packet.subarray(offset,offset+size));offset+=size;
  }
  assert.equal(offset,packet.length);return result;
}
const batch=turn=>message=>Buffer.isBuffer(message)&&message.readUInt32LE(2)===turn;

test('returning to the room publishes one deterministic resignation and rejects a late reconnect',async t=>{
  const f=await fixture(t);
  await f.guest.request(`returngame ${f.channel} ${f.id}`,has(' 710 '));
  const first=await f.a.request(actions(1),batch(1));
  assert.deepEqual([...payloads(first).get(1)],[1,3,0,0],'the departed combatant must resign in the shared timeline');
  const late=await login(f.server.port,'gserv','RecoverBravo',{...f.identityB,epoch:2});
  const refused=await late.request(`join ${f.id} 0.87.3 123`,message=>has(' 402 ')(message)||has(' 400 ')(message));
  assert.ok(has(' 402 ')(refused),'a returned player must not reclaim a slot and block the next turn');
  await f.guest.request(`returngame ${f.channel} ${f.id}`,has(' 710 '));
  assert.deepEqual([...payloads(await f.a.request(actions(2),batch(2))).get(1)],[0],'a repeated return must not resign twice');
  const replay=await login(f.server.port,'gserv','RecoverAlpha',{...f.identityA,epoch:2});
  await replay.request(`join ${f.id} 0.87.3 123`,has(' 400 '));
  await replay.request('resume none',has(' 400 '));
  assert.deepEqual(await replay.wait(batch(1)),first,'fresh-page recovery must replay the identical resignation');
});

test('an intentional room exit during a stall releases the next turn without waiting for the quitter to send',async t=>{
  const f=await fixture(t);
  f.a.send(actions(1));await until(()=>f.game.pending.get(1)?.has('RecoverAlpha'));
  await f.guest.request(`abandongame ${f.channel} ${f.id}`,message=>has(' 712 ')(message)||has(' 421 ')(message));
  const packet=await f.a.wait(batch(1));
  assert.deepEqual([...payloads(packet).get(1)],[1,3,0,0]);
  assert.equal(f.server.rooms.get(f.channel).started,true,'the remaining match must stay locked');
  assert.equal(f.server.rooms.get(f.channel).match.returned.has('RecoverBravo'),false,'abandonment is separate from re-entering the room');
  await f.guest.request(`returngame ${f.channel} ${f.id}`,has(' 710 '));
  assert.deepEqual([...payloads(await f.a.request(actions(2),batch(2))).get(1)],[0]);
});

test('an explicit game-socket exit also works without the lobby connection',async t=>{
  const f=await fixture(t);await close(f.guest);
  f.a.send(actions(1));await until(()=>f.game.pending.get(1)?.has('RecoverAlpha'));
  await f.b.request('leavegame',has(' 720 '));
  assert.deepEqual([...payloads(await f.a.wait(batch(1))).get(1)],[1,3,0,0]);
  const late=await login(f.server.port,'gserv','RecoverBravo',{...f.identityB,epoch:2});
  await late.request(`join ${f.id} 0.87.3 123`,has(' 402 '));
});

test('a genuine transient disconnect remains recoverable and never injects a resignation',async t=>{
  const f=await fixture(t);await close(f.b);
  const packet=await f.a.request(actions(1),batch(1));assert.deepEqual([...payloads(packet).get(1)],[0]);
  const reconnect=await login(f.server.port,'gserv','RecoverBravo',{...f.identityB,epoch:2});
  await reconnect.request(`join ${f.id} 0.87.3 123`,has(' 400 '));
  await reconnect.request('resume 1',has(' 400 '));
  f.a.send(actions(2));reconnect.send(actions(2));
  assert.deepEqual([...payloads(await f.a.wait(batch(2))).get(1)],[0]);
  assert.equal(f.game.departed?.has('RecoverBravo')??false,false);
});

test('an exit while loading does not hold the other player at the loading barrier',async t=>{
  const f=await fixture(t,{loadingOnly:true});
  await f.guest.request(`returngame ${f.channel} ${f.id}`,has(' 710 '));
  await f.a.request('loaded 100',has(' 700 '));
  assert.deepEqual([...payloads(await f.a.request(actions(0),batch(0))).get(1)],[1,3,0,0]);
});

test('a resignation already published by the native client is never injected again',async t=>{
  const f=await fixture(t),resign=Buffer.concat([actions(1).subarray(0,6),Buffer.from([1,3,0,0])]);
  f.a.send(actions(1));f.b.send(resign);
  assert.deepEqual([...payloads(await f.a.wait(batch(1))).get(1)],[1,3,0,0]);
  await f.guest.request(`returngame ${f.channel} ${f.id}`,has(' 710 '));
  assert.deepEqual([...payloads(await f.a.request(actions(2),batch(2))).get(1)],[0]);
});

test('a departing observer releases its slot without producing a combatant resignation',async t=>{
  const f=await fixture(t,{observerB:true});
  await f.guest.request(`returngame ${f.channel} ${f.id}`,has(' 710 '));
  assert.deepEqual([...payloads(await f.a.request(actions(1),batch(1))).get(1)],[0]);
  assert.equal(f.game.resigned.has('RecoverBravo'),false);
});
