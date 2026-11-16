import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createLanServer } from './server.mjs';

async function connect(port, service, { pongDelayMs } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${service}?ra2PageSessionId=fixture&ra2ClientSessionId=fixture&ra2ConnectionAttemptId=fixture`, { autoPong: pongDelayMs === undefined });
  if (pongDelayMs !== undefined) ws.on('ping', data => setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.pong(data); }, pongDelayMs));
  const messages = [], listeners = new Set();
  ws.on('message', (data, binary) => {
    for (const message of binary ? [Buffer.from(data)] : data.toString().split(/\r?\n/).filter(Boolean)) {
      messages.push(message);
      for (const listener of listeners) listener(message);
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, messages, send: line => ws.send(typeof line === 'string' ? line + '\r\n' : line),
    wait(predicate) {
      const present = messages.find(predicate);
      if (present !== undefined) return Promise.resolve(present);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(receive); reject(new Error('Reply timed out')); }, 3000);
        function receive(message) { if (predicate(message)) { clearTimeout(timer); listeners.delete(receive); resolve(message); } }
        listeners.add(receive);
      });
    },
  };
}
const has = text => message => typeof message === 'string' && message.includes(text);
const password = Buffer.from('lan-test-password').toString('base64');
async function wolLogin(port, name, options) {
  const client = await connect(port, 'wol', options);
  client.send('cvers 0.87.3 16640 gserv3'); await client.wait(has(' 700 '));
  client.send('setlocale 21'); await client.wait(has(' 310 '));
  client.send(`pass ${password}\r\nnick ${name}\r\nuser UserName HostName irc.westwood.com :RealName`);
  await client.wait(has(' 376 ')); return client;
}
async function gameLogin(port, name, options) {
  const client = await connect(port, 'gserv', options);
  client.send('cvers 0.87.3 2'); await client.wait(has(' 10 '));
  client.send(`user ${name} ${password}`); await client.wait(has(' 100 ')); return client;
}

async function rematchFixture(context) {
  const server = await createLanServer({ port: 0, nicknameOnly: true }); context.after(() => server.close());
  const host = await wolLogin(server.port, 'RepeatAlpha'), guest = await wolLogin(server.port, 'RepeatBravo');
  const outsider = await wolLogin(server.port, 'RepeatOther'), channel = "#RepeatAlpha's_game";
  host.send(`joingame ${channel} 1 17 45 0 0 0 0`); await host.wait(has(' JOINGAME '));
  guest.send(`joingame ${channel} 0`); await guest.wait(has(' JOINGAME '));
  const settings = '0,0,0,10000,0,1,0,1,1,0,0,0,bWFw,2,1,10,bWFw,hash,1,0,0,1,0';
  const options = `${settings}:RepeatAlpha,0,0,0,-1,0,0,0,RepeatBravo,1,1,1,-1,0,0,0:@:0,-1,-1,-1,-1,`;
  host.send(`gameopt ${channel} :${settings}`); await guest.wait(has(':' + settings));
  host.send(`topic ${channel} :g2hN39,123,0,0,0,bWFw,UmVtYXRjaA==`);
  host.send(`startg ${channel} RepeatAlpha,RepeatBravo`);
  const id = (await host.wait(has(' STARTG '))).match(/ :([a-f0-9-]+) \d+$/)[1];
  const a = await gameLogin(server.port, 'RepeatAlpha'), b = await gameLogin(server.port, 'RepeatBravo');
  a.send(`create ${id} 12345 ${options} 0.87.3 123 0`); await a.wait(has(' 200 '));
  b.send(`join ${id} 0.87.3 123`); await b.wait(has(' 400 '));
  a.send('loaded 100'); b.send('loaded 100'); await a.wait(has(' 700 '));
  return { server, host, guest, outsider, channel, id, a, b, settings };
}

test('match locks every join path; both players return to the same room and start a new match', async context => {
  const { server, host, guest, outsider, channel, id, a, settings } = await rematchFixture(context);
  for (const line of [`joingame ${channel} 0`, `join ${channel}`]) {
    outsider.messages.length = 0; outsider.send(line); await outsider.wait(has(' 478 '));
    assert.equal([...server.rooms.keys()].length, 1);
  }
  outsider.send(`returngame ${channel} ${id}`); await outsider.wait(has(' 711 '));
  guest.send(`returngame ${channel} wrong-session`); await guest.wait(has(' 711 '));
  assert.equal(server.rooms.get(channel).match.returned.size, 0);
  guest.messages.length = 0; host.messages.length = 0;
  guest.send(`returngame ${channel} ${id}`); await guest.wait(has(' 710 '));
  await guest.wait(has(':' + settings));
  const pending = await host.wait(message => typeof message === 'string' && message.includes(':W') && message.includes('RepeatAlpha'));
  assert.deepEqual(JSON.parse(pending.split(':W')[1]).waiting, ['RepeatAlpha']);
  assert.equal(server.rooms.get(channel).started, true);
  assert.ok(guest.messages.some(has('RepeatBravo@lan GAMEOPT')) && guest.messages.some(has(':A0')));
  host.send(`startg ${channel} RepeatAlpha,RepeatBravo`);
  host.send('ping checkpoint'); await host.wait(message => typeof message === 'string' && message.includes('PONG') && message.endsWith(':checkpoint'));
  assert.equal(server.games.size, 1, 'cannot start a second game while somebody has not returned');
  // The remaining match still advances after the other player returns.
  a.send(Buffer.from([2, 1, 0, 0, 0, 0, 1, 0, 0, 0]));
  await a.wait(Buffer.isBuffer);
  host.messages.length = 0; host.send(`returngame ${channel} ${id}`); await host.wait(has(' 710 '));
  await host.wait(message => typeof message === 'string' && message.includes(':W') && JSON.parse(message.split(':W')[1]).waiting.length === 0);
  assert.equal(server.rooms.get(channel).started, false);
  assert.equal(server.rooms.get(channel).options.get('settings'), settings);
  guest.send(`gameopt ${channel} :R5,2,1,1`); await host.wait(has(':R5,2,1,1'));
  outsider.messages.length = 0; outsider.send(`joingame ${channel} 0`); await outsider.wait(has(' JOINGAME '));
  outsider.send(`part ${channel}`); await outsider.wait(has(' PART '));
  host.messages.length = 0; host.send(`startg ${channel} RepeatAlpha,RepeatBravo`);
  const nextId = (await host.wait(has(' STARTG '))).match(/ :([a-f0-9-]+) \d+$/)[1];
  assert.notEqual(nextId, id);
  assert.equal(server.rooms.get(channel).match.id, nextId);
  assert.equal(server.rooms.get(channel).match.returned.size, 0);
  assert.equal(server.rooms.get(channel).started, true);
});

test('departing participant stops blocking rematch; a closed host room cannot be resurrected', async context => {
  const { server, host, guest, channel, id } = await rematchFixture(context);
  host.send(`returngame ${channel} ${id}`); await host.wait(has(' 710 '));
  assert.equal(server.rooms.get(channel).started, true);
  guest.send(`part ${channel}`); await guest.wait(has(' PART '));
  await host.wait(message => typeof message === 'string' && message.includes(':W') && JSON.parse(message.split(':W')[1]).waiting.length === 0);
  assert.equal(server.rooms.get(channel).started, false);
  host.send(`part ${channel}`); await host.wait(has('RepeatAlpha!RepeatAlpha@lan PART'));
  assert.equal(server.rooms.size, 0);
  host.messages.length = 0; host.send(`returngame ${channel} ${id}`); await host.wait(has(' 711 '));
  assert.equal(server.rooms.size, 0);
});

test('idle rooms are destroyed when everyone leaves and when the host disconnects', async context => {
  const server = await createLanServer({ port: 0, nicknameOnly: true }); context.after(() => server.close());
  const host = await wolLogin(server.port, 'EmptyAlpha'), guest = await wolLogin(server.port, 'EmptyBravo');
  const channel = "#EmptyAlpha's_game";
  host.send(`joingame ${channel} 1 17 45 0 0 0 0`); await host.wait(has(' JOINGAME '));
  guest.send(`joingame ${channel} 0`); await guest.wait(has(' JOINGAME '));
  guest.send(`part ${channel}`); await guest.wait(has(' PART '));
  assert.equal(server.rooms.size, 1);
  host.send(`part ${channel}`); await host.wait(has('EmptyAlpha!EmptyAlpha@lan PART'));
  assert.equal(server.rooms.size, 0);
  host.messages.length = 0; host.send(`joingame ${channel} 1 17 45 0 0 0 0`); await host.wait(has(' JOINGAME '));
  guest.messages.length = 0; guest.send(`joingame ${channel} 0`); await guest.wait(has(' JOINGAME '));
  host.ws.close(); await guest.wait(has(' KICK '));
  assert.equal(server.rooms.size, 0);
});

for (const nicknameOnly of [false, true]) test(`WOL/Gserv wire flow broadcasts identical action batches (nicknameOnly=${nicknameOnly})`, async context => {
  const server = await createLanServer({ port: 0, nicknameOnly }); context.after(() => server.close());
  const host = await wolLogin(server.port, 'LanAlpha'), guest = await wolLogin(server.port, 'LanBravo');
  const channel = "#LanAlpha's_game";
  host.send(`joingame ${channel} 1 9 45 0 0 0 0`);
  await host.wait(has(' JOINGAME '));
  assert.match(await host.wait(has(' 353 ')), /@LanAlpha,0,\d+,0/);
  assert.match(await host.wait(has(' GSERV ')), /\/gserv$/);
  host.send(`topic ${channel} :g29N39,123,0,0,0,bWFw,Um9vbQ==`);
  guest.send('list 45 45'); assert.match(await guest.wait(has(' 322 ')), /#LanAlpha's_game 1 9 45/);
  guest.send(`joingame ${channel} 0 `); await guest.wait(has(' JOINGAME '));
  guest.send(`gameopt ${channel} :A1`); assert.match(await host.wait(has('GAMEOPT')), /LanBravo.*:A1$/);
  host.send(`startg ${channel} LanAlpha,LanBravo`);
  const start = await host.wait(has(' STARTG '));
  const id = start.match(/ :([a-f0-9-]+) \d+$/)[1];
  const a = await gameLogin(server.port, 'LanAlpha'), b = await gameLogin(server.port, 'LanBravo');
  const options = '0,0,0,10000,0,1,0,1,1,0,0,0,bWFw,2,1,10,bWFw,hash,1,0,0,1,0:LanAlpha,0,0,0,-1,0,0,0,LanBravo,1,1,1,-1,0,0,0:@:0,-1,-1,-1,-1,';
  a.send(`create ${id} 12345 ${options} 0.87.3 123 0`); await a.wait(has(' 200 '));
  b.send(`join ${id} 0.87.3 123`); await b.wait(has(' 400 '));
  b.send('gameopts'); assert.match(await b.wait(has(' 500 ')), /LanAlpha,0,0,0/);
  a.send('loaded 100'); b.send('loaded 100');
  await a.wait(has(' 802 ')); await a.wait(has(' 700 ')); await b.wait(has(' 700 '));
  const packet = Buffer.from([2, 1, 0, 0, 0, 0, 1, 0, 0, 0]);
  a.send(packet);
  await new Promise(resolve => setTimeout(resolve, 180));
  const stalled = await fetch(`http://127.0.0.1:${server.port}/healthz?network=1&user=LanAlpha`).then(response => response.json());
  assert.equal(stalled.room.phase, 'playing');
  assert.equal(stalled.room.turn, 0);
  assert.equal(stalled.room.players.find(player => player.name === 'LanAlpha').waitingForMs, 0);
  assert.ok(stalled.room.players.find(player => player.name === 'LanBravo').waitingForMs >= 150);
  b.send(packet);
  const first = await a.wait(Buffer.isBuffer), second = await b.wait(Buffer.isBuffer);
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(2), 0);
  assert.equal(first[6], 2);
  assert.equal(first[7], 0); assert.equal(first[14], 1);
  assert.equal(server.games.get(id).turn, 1);
  const recovered = await fetch(`http://127.0.0.1:${server.port}/healthz?network=1&user=LanAlpha`).then(response => response.json());
  assert.deepEqual(recovered.room.recentWait.names, ['LanBravo']);
  assert.ok(recovered.room.recentWait.waitMs >= 150);
});

test('room telemetry measures each socket RTT and native GPING keeps its player association', async context => {
  const server = await createLanServer({ port: 0, nicknameOnly: true, pingIntervalMs: 60 }); context.after(() => server.close());
  const host = await wolLogin(server.port, 'PingAlpha', { pongDelayMs: 60 });
  const guest = await wolLogin(server.port, 'PingBravo', { pongDelayMs: 5 });
  await wolLogin(server.port, 'OutsideRoom');
  const channel = "#PingAlpha's_game";
  host.send(`joingame ${channel} 1 9 45 0 0 0 0`); await host.wait(has(' JOINGAME '));
  guest.send(`joingame ${channel} 0 `); await guest.wait(has(' JOINGAME '));
  let snapshot;
  for (let attempt = 0; attempt < 80; attempt++) {
    snapshot = await fetch(`http://127.0.0.1:${server.port}/healthz?network=1&user=PingAlpha`).then(response => response.json());
    if (snapshot.room.players.every(player => player.rttMs !== null)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(snapshot.room.players.map(player => player.name), ['PingAlpha', 'PingBravo']);
  assert.ok(snapshot.room.players[0].rttMs >= 50, JSON.stringify(snapshot));
  assert.ok(snapshot.room.players[1].rttMs < snapshot.room.players[0].rttMs, JSON.stringify(snapshot));
  host.send(`gping ${channel} lan 36`); guest.send(`gping ${channel} lan 174`);
  await guest.wait(has(' 366 '));
  await new Promise(resolve => setTimeout(resolve, 10));
  host.messages.length = 0;
  host.send(`names ${channel}`);
  const names = await host.wait(has(' 353 '));
  assert.match(names, /@PingAlpha,0,36,0/); assert.match(names, /PingBravo,0,174,0/);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz?network=1&user=OutsideRoom`).then(response => response.json())).room, null);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`).then(response => response.json())).rooms, 1);
});

test('LAN accounts survive restart and reject an incorrect password', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'ra2web-accounts-')); context.after(() => rm(directory, { recursive: true }));
  let server = await createLanServer({ port: 0, dataDir: directory });
  await wolLogin(server.port, 'AccountTest'); await server.close();
  const stored = await readFile(join(directory, 'accounts.json'), 'utf8');
  assert.ok(!stored.includes('lan-test-password')); assert.match(stored, /"salt"/);
  server = await createLanServer({ port: 0, dataDir: directory }); context.after(() => server.close());
  const client = await connect(server.port, 'wol');
  client.send(`pass ${Buffer.from('incorrect-password').toString('base64')}\r\nnick AccountTest\r\nuser x x x :x`);
  await client.wait(has(' 378 '));
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`).then(response => response.json())).users, 0);
});

test('nickname-only access needs no password, reserves online names and stores no account', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'ra2web-guests-')); context.after(() => rm(directory, { recursive: true }));
  const server = await createLanServer({ port: 0, dataDir: directory, nicknameOnly: true }); context.after(() => server.close());
  const first = await connect(server.port, 'wol');
  first.send('nick GuestName\r\nuser x x x :x'); await first.wait(has(' 376 '));
  const duplicate = await connect(server.port, 'wol');
  duplicate.send('nick guestname\r\nuser x x x :x'); await duplicate.wait(has(' 378 '));
  assert.equal(first.ws.readyState, WebSocket.OPEN);
  first.send('ping :still-here'); await first.wait(has('PONG'));
  const game = await connect(server.port, 'gserv'); game.send('user GuestName'); await game.wait(has(' 100 '));
  await assert.rejects(readFile(join(directory, 'accounts.json')), { code: 'ENOENT' });
  await new Promise(resolve => { first.ws.once('close', resolve); first.ws.close(); });
  const returning = await connect(server.port, 'wol');
  returning.send('nick GuestName\r\nuser x x x :x'); await returning.wait(has(' 376 '));
});

test('measured RTT changes are ordered before their action turn and survive full and partial replay', async context => {
  const server = await createLanServer({ port: 0, nicknameOnly: true, pingIntervalMs: 30, networkPolicy: { increaseCooldownMs: 0, decreaseStableMs: 100000 } });
  context.after(() => server.close());
  const host = await wolLogin(server.port, 'AdaptAlpha'), guest = await wolLogin(server.port, 'AdaptBravo');
  const channel = "#AdaptAlpha's_game";
  host.send(`joingame ${channel} 1 9 45 0 0 0 0`); await host.wait(has(' JOINGAME '));
  guest.send(`joingame ${channel} 0 `); await guest.wait(has(' JOINGAME '));
  host.send(`startg ${channel} AdaptAlpha,AdaptBravo`);
  const id = (await host.wait(has(' STARTG '))).match(/ :([a-f0-9-]+) \d+$/)[1];
  const a = await gameLogin(server.port, 'AdaptAlpha'), b = await gameLogin(server.port, 'AdaptBravo', { pongDelayMs: 350 });
  a.send(`create ${id} 12345 0,0,0,10000,0,1,0,1,1,0,0,0,bWFw,2,1,10,bWFw,hash,1,0,0,1,0:AdaptAlpha,0,0,0,-1,0,0,0,AdaptBravo,1,1,1,-1,0,0,0:@:0,-1,-1,-1,-1, 0.87.3 123 0`);
  await a.wait(has(' 200 ')); b.send(`join ${id} 0.87.3 123`); await b.wait(has(' 400 '));
  a.send('loaded 100'); b.send('loaded 100'); await a.wait(has(' 700 '));
  const game = server.games.get(id), initialMs = game.networkRate.currentMs;
  for (let attempt = 0; attempt < 80 && !(game.clients.get('AdaptBravo').rttMs >= 300); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(game.clients.get('AdaptBravo').rttMs >= 300, 'a delayed native pong must drive this test');
  function actions(turn) { const packet = Buffer.from([2, 1, 0, 0, 0, 0, 1, 0, 0, 0]); packet.writeUInt32LE(turn, 2); return packet; }
  for (const turn of [0, 1]) {
    a.send(actions(turn)); b.send(actions(turn));
    await a.wait(message => Buffer.isBuffer(message) && message.readUInt32LE(2) === turn);
  }
  const rateA = await a.wait(has(' 802 * :200,1')), rateB = await b.wait(has(' 802 * :200,1'));
  assert.equal(rateA, rateB);
  const rateIndex = a.messages.indexOf(rateA), packetIndex = a.messages.findIndex(message => Buffer.isBuffer(message) && message.readUInt32LE(2) === 1);
  assert.ok(rateIndex < packetIndex, 'announce N before releasing batch N, for application at N+2');
  assert.equal(game.networkRate.changes.filter(change => change.turnNo === 1).length, 1);
  const closed = new Promise(resolve => b.ws.once('close', resolve)); b.ws.close(); await closed;
  const rejoined = await gameLogin(server.port, 'AdaptBravo'); rejoined.send(`join ${id} 0.87.3 123`); await rejoined.wait(has(' 400 '));
  a.send(actions(2)); await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(!rejoined.messages.some(has(' 802 ')), 'no live timing messages before replay bootstrap');
  rejoined.send('loaded 100');
  await rejoined.wait(message => Buffer.isBuffer(message) && message.readUInt32LE(2) === 1);
  assert.deepEqual(rejoined.messages.filter(has(' 802 ')).map(line => line.match(/:([\d,]+)$/)[1]), [`${initialMs},0`, '200,1']);
  const replayRate = rejoined.messages.findIndex(has(' 802 * :200,1'));
  assert.ok(replayRate < rejoined.messages.findIndex(message => Buffer.isBuffer(message) && message.readUInt32LE(2) === 1));
  rejoined.messages.length = 0; rejoined.send('resume 0');
  await rejoined.wait(message => Buffer.isBuffer(message) && message.readUInt32LE(2) === 1);
  assert.deepEqual(rejoined.messages.filter(has(' 802 ')).map(line => line.match(/:([\d,]+)$/)[1]), ['200,1']);
  assert.deepEqual(rejoined.messages.filter(Buffer.isBuffer).map(packet => packet.readUInt32LE(2)), [1, 2], 'loading peers do not stop live peers; both missing turns must replay');
  const closedAgain = new Promise(resolve => rejoined.ws.once('close', resolve)); rejoined.ws.close(); await closedAgain;
  const partial = await gameLogin(server.port, 'AdaptBravo');
  partial.send(`join ${id} 0.87.3 123`); await partial.wait(has(' 400 '));
  partial.send('resume 0');
  await partial.wait(message => Buffer.isBuffer(message) && message.readUInt32LE(2) === 1);
  assert.deepEqual(partial.messages.filter(has(' 802 ')).map(line => line.match(/:([\d,]+)$/)[1]), ['200,1']);
  assert.equal(partial.messages.some(has(' 700 ')), false, 'partial reconnect keeps the existing simulation');
  assert.equal(game.clients.get('AdaptBravo').loaded, 100);
  const nextTurn = game.turn;
  a.send(actions(nextTurn)); partial.send(actions(nextTurn));
  await partial.wait(message => Buffer.isBuffer(message) && message.readUInt32LE(2) === nextTurn);
  assert.equal(game.clients.get('AdaptBravo').timelineReady, true, 'resume without loaded 100 receives subsequent live batches');
});
