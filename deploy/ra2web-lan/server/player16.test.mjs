import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { createLanServer } from './server.mjs';

// Independent real-socket acceptance tests. These do not import/mutate the old
// server.test.mjs helpers or patch the production server.
// Run: node --test deploy/ra2web-lan/server/player16.test.mjs
// Also test 16 combatants + 1 observer: RA2_PLAYER16_OBSERVER=1 node --test ...
const withObserver = process.env.RA2_PLAYER16_OBSERVER === '1';
const has = text => message => typeof message === 'string' && message.includes(text);
const password = Buffer.from('player16-test-password').toString('base64');
const BUILD = '0.87.3', MOD_HASH = '123';
let barrierId = 0;

async function connect(port, service) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${service}?ra2PageSessionId=player16-fixture&ra2ClientSessionId=player16-fixture&ra2ConnectionAttemptId=player16-fixture`);
  const messages = [], listeners = new Set();
  ws.on('message', (data, binary) => {
    for (const message of binary ? [Buffer.from(data)] : data.toString().split(/\r?\n/).filter(Boolean)) {
      messages.push(message);
      for (const listener of listeners) listener(message);
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws, messages,
    send(line) { ws.send(typeof line === 'string' ? line + '\r\n' : line); },
    wait(predicate, { after = 0, timeout = 3000 } = {}) {
      const present = messages.slice(after).find(predicate);
      if (present !== undefined) return Promise.resolve(present);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(receive); reject(new Error(`Reply timed out (${service}, after ${after})`)); }, timeout);
        function receive(message) {
          if (predicate(message)) { clearTimeout(timer); listeners.delete(receive); resolve(message); }
        }
        listeners.add(receive);
      });
    },
  };
}

async function request(client, line, predicate) {
  const after = client.messages.length;
  client.send(line);
  return client.wait(predicate, { after });
}

async function barrier(client) {
  const token = `player16-barrier-${barrierId++}`;
  await request(client, `ping :${token}`, message => has('PONG')(message) && message.includes(token));
}

async function wolLogin(port, name) {
  const client = await connect(port, 'wol');
  await request(client, `cvers ${BUILD} 16640 gserv3`, has(' 700 '));
  await request(client, 'setlocale 21', has(' 310 '));
  await request(client, `pass ${password}\r\nnick ${name}\r\nuser UserName HostName irc.westwood.com :RealName`, has(' 376 '));
  return client;
}

async function gameLogin(port, name) {
  const client = await connect(port, 'gserv');
  await request(client, `cvers ${BUILD} 2`, has(' 10 '));
  await request(client, `user ${name} ${password}`, has(' 100 '));
  return client;
}

const fixtureMap = Buffer.from([
  '[Basic]', 'Name=Player16 socket transport fixture', 'NewINIFormat=4',
  'WinlifeMaxPlayers=16', 'MaxPlayer=16', 'GameMode=standard', 'Official=no',
  '[Map]', 'Theater=TEMPERATE', 'Size=0,0,128,128', 'LocalSize=4,4,120,116',
  '[Waypoints]', ...Array.from({ length: 16 }, (_, index) => `${index}=${(40 + index * 3) * 1000 + 80 + index * 2}`), '',
].join('\r\n'));
const mapDigest = createHash('sha1').update(fixtureMap).digest('hex');
const mapName = Buffer.from('player16-fixture.map').toString('base64');

function humanRecords(count, { observerIndex = -1 } = {}) {
  let combatant = 0;
  return Array.from({ length: count }, (_, index) => {
    const observer = index === observerIndex, slot = observer ? -2 : combatant++;
    return { name: `P16User${String(index).padStart(2, '0')}`, countryId: observer ? -3 : 0, colorId: observer ? -2 : slot, startPos: slot, teamId: -2 };
  });
}

function emptyAiSlots(count = 17) { return new Array(count).fill(undefined); }
function aiPlayer(startPos, difficulty = 0) { return { difficulty, countryId: 0, colorId: startPos, startPos, teamId: -2 }; }

function optionsFor(humans, { aiPlayers = emptyAiSlots(), maxSlots = 16, aiWire } = {}) {
  // Settings indices 0..22 match Zg.serializeOptions exactly:
  // 0/1 reserved, 2 inverse speed, 3 credits, 4 units, 5 short game,
  // 6 superweapons, 7 ally build, 8 MCV repacks, 9 crates, 10 gameMode,
  // 11 hostTeams, 12 title, 13 MAP COMBATANT CAPACITY, 14 official,
  // 15 map bytes, 16 map filename, 17 digest, 18 bridges, 19 multi-engineer,
  // 20 no-dog-engineer, 21 instant capture, 22 delayed oils.
  const settings = [0, 0, 0, 10000, 0, 1, 0, 1, 1, 0, 0, 0,
    'UGxheWVyMTY=', maxSlots, 0, fixtureMap.length, mapName, mapDigest, 1, 0, 0, 1, 0];
  // Human stride is EIGHT FIELDS PER RECORD, not a player-count limit.
  const humanWire = humans.map(player => [player.name, player.countryId, player.colorId, player.startPos, player.teamId, 0, 0, 0].join(',')).join(',');
  // AI stride is FIVE FIELDS PER SLOT. countryId=-1 marks an EMPTY slot.
  // difficulty=0 is a valid active AI; every complete AI section ends in ONE
  // extra comma, including the empty section (:@:,).
  const bots = aiWire ?? aiPlayers.map(player => player
    ? [player.difficulty, player.countryId, player.colorId, player.startPos, player.teamId].join(',')
    : '0,-1,-1,-1,-1').join(',');
  return `${settings.join(',')}:${humanWire}:@:${bots},`;
}

async function createRoom(context, humans) {
  const server = await createLanServer({ port: 0, nicknameOnly: true });
  context.after(() => server.close());
  const wol = await Promise.all(humans.map(player => wolLogin(server.port, player.name)));
  const host = wol[0], channel = "#P16User00's_game";
  await request(host, `joingame ${channel} 1 17 45 0 0 0 0`, has(' JOINGAME '));
  await request(host, `mode ${channel} +l 17`, message => has(' MODE ')(message) && message.endsWith('+l 17'));
  // Join sequentially to get useful errors if the server is still limited to9.
  for (const client of wol.slice(1)) await request(client, `joingame ${channel} 0 `, has(' JOINGAME '));
  const names = await request(host, `names ${channel}`, has(' 353 '));
  for (const player of humans) assert.ok(names.includes(`${player.name},`), `NAMES must contain ${player.name}`);
  assert.equal(server.rooms.get(channel).max, 17);
  return { server, humans, wol, host, channel };
}

async function startRoom(room) {
  const after = room.host.messages.length;
  room.host.send(`startg ${room.channel} ${room.humans.map(player => player.name).join(',')}`);
  // STARTG rejection used to be silent. A same-connection PONG is a processing
  // barrier so negative tests do not need arbitrary sleeps or timeouts.
  await barrier(room.host);
  const line = room.host.messages.slice(after).find(has(' STARTG '));
  if (!line) return undefined;
  const start = line.match(/ :([a-f0-9-]+) (\d+)$/);
  const id = start?.[1];
  assert.ok(id, `STARTG has a game identifier: ${line}`);
  room.startTimestamp = Number(start[2]);
  return id;
}

async function createGame(room, options) {
  const id = await startRoom(room);
  assert.ok(id, 'STARTG must accept this participant roster');
  const host = await gameLogin(room.server.port, room.humans[0].name);
  const reply = await request(host, `create ${id} ${room.startTimestamp} ${options} ${BUILD} ${MOD_HASH} 0`, message => typeof message === 'string' && /^:\S+ [24]\d\d /.test(message));
  assert.match(reply, / 200 /, `CREATE must accept valid combatant/observer/AI counts: ${reply}`);
  const clients = [host];
  for (const player of room.humans.slice(1)) {
    const client = await gameLogin(room.server.port, player.name);
    await request(client, `join ${id} ${BUILD} ${MOD_HASH}`, has(' 400 '));
    clients.push(client);
  }
  return { id, clients };
}

async function assertMapTransfer(clients) {
  const compressed = deflateSync(fixtureMap);
  clients[0].send(Buffer.concat([Buffer.from([2, 3]), compressed]));
  await barrier(clients[0]);
  const maps = await Promise.all(clients.map(client => request(client, Buffer.from([2, 4]), packet => Buffer.isBuffer(packet) && packet[0] === 2 && packet[1] === 2)));
  for (const packet of maps) {
    assert.deepEqual(packet.subarray(2), compressed, 'map transport must preserve compressed bytes');
    assert.deepEqual(inflateSync(packet.subarray(2)), fixtureMap);
  }
  return maps.length;
}

function actionPacket(turn) {
  // Native action command: prefix2/type1, uint32 turn, payload actionCount1,
  // actionType0 (NoAction), uint16 payloadSize0.
  const packet = Buffer.from([2, 1, 0, 0, 0, 0, 1, 0, 0, 0]);
  packet.writeUInt32LE(turn, 2);
  return packet;
}

function parseActionBatch(packet) {
  assert.equal(packet[0], 2); assert.equal(packet[1], 1);
  const count = packet[6], entries = [];
  let offset = 7;
  for (let index = 0; index < count; index++) {
    assert.ok(offset + 3 <= packet.length, 'complete player header');
    const id = packet[offset], size = packet.readUInt16LE(offset + 1);
    offset += 3;
    assert.ok(offset + size <= packet.length, 'complete player action payload');
    entries.push({ id, payload: packet.subarray(offset, offset + size) });
    offset += size;
  }
  assert.equal(offset, packet.length, 'no unparsed player records');
  return { turn: packet.readUInt32LE(2), count, entries };
}

async function assertLoadedAndIdenticalTurns(room, id, clients, turns = 3) {
  for (const client of clients) client.send('loaded 100');
  await Promise.all(clients.map(client => client.wait(has(' 700 '))));
  assert.equal(room.server.games.get(id).started, true);
  assert.equal(room.server.games.get(id).players.length, clients.length);
  for (let turn = 0; turn < turns; turn++) {
    const input = actionPacket(turn);
    clients.forEach(client => client.send(input));
    const packets = await Promise.all(clients.map(client => client.wait(packet => Buffer.isBuffer(packet) && packet[1] === 1 && packet.readUInt32LE(2) === turn)));
    for (const packet of packets) assert.deepEqual(packet, packets[0], 'all participants receive identical ordered bytes');
    const batch = parseActionBatch(packets[0]);
    assert.equal(batch.count, clients.length);
    assert.deepEqual(batch.entries.map(entry => entry.id), clients.map((_, index) => index));
    assert.equal(new Set(batch.entries.map(entry => entry.id)).size, clients.length, 'IDs8..16 must not alias0..8');
    for (const entry of batch.entries) assert.deepEqual(entry.payload, input.subarray(6));
  }
  const hash = Buffer.alloc(10); hash[0] = 2; hash[1] = 2;
  hash.writeUInt32LE(turns - 1, 2); hash.writeUInt32LE(0x16abc123, 6);
  clients.forEach(client => client.send(hash));
  await Promise.all(clients.map(barrier));
  const game = room.server.games.get(id);
  assert.equal(game.hashes.get(turns - 1).size, clients.length);
  assert.equal(game.desynced, undefined);
  assert.equal(game.turn, turns);
}

async function assertRejectedBeforeStart(room, options) {
  const id = await startRoom(room);
  if (!id) {
    assert.equal(room.server.games.size, 0, 'rejected STARTG creates no game');
    return;
  }
  const host = await gameLogin(room.server.port, room.humans[0].name);
  const after = host.messages.length;
  host.send(`create ${id} ${room.startTimestamp} ${options} ${BUILD} ${MOD_HASH} 0`);
  await barrier(host);
  const replies = host.messages.slice(after);
  assert.equal(replies.some(has(' 200 ')), false, 'invalid roster must not be accepted by CREATE');
  assert.ok(replies.some(message => typeof message === 'string' && /^:\S+ [45]\d\d /.test(message)), `CREATE rejection must be explicit: ${JSON.stringify(replies)}`);
  assert.equal(room.server.games.get(id)?.started, false);
  assert.ok(!room.server.games.get(id)?.clients.has(room.humans[0].name), 'rejected host must not attach to invalid game');
}

test('16真人真实WOL/Gserv完成Ready、地图传输与16个唯一动作ID', { timeout: 30000 }, async context => {
  const humans = humanRecords(16), room = await createRoom(context, humans);
  room.host.send(`topic ${room.channel} :gghN39,123,0,0,1,${mapName},UGxheWVyMTY=`);
  await barrier(room.host);
  const list = await request(room.wol[1], 'list 45 45', has(' 322 '));
  assert.match(list, /#P16User00's_game 16 17 45/);
  assert.ok(list.includes(':gghN39,'), 'LIST preserves base36 topic capacity h=17');
  room.wol.slice(1).forEach(client => client.send(`gameopt ${room.channel} :A1`));
  await Promise.all(room.wol.slice(1).map(barrier));
  // The server forwards readiness to the host; it does not own the UI ready map.
  await barrier(room.host);
  for (const player of humans.slice(1)) assert.ok(room.host.messages.some(message => has(`:${player.name}!`)(message) && message.endsWith(':A1')), `host sees Ready from ${player.name}`);
  const options = optionsFor(humans), { id, clients } = await createGame(room, options);
  const allOptions = await Promise.all(clients.map(client => request(client, 'gameopts', has(' 500 '))));
  for (const response of allOptions) assert.ok(response.endsWith(`:${options}`), 'every participant sees the full human/AI options');
  assert.equal(await assertMapTransfer(clients), 16, 'all16 clients can retrieve the host map');
  await assertLoadedAndIdenticalTurns(room, id, clients);
});

test('16战斗真人加1观察者保留17个参与者ID且向16个来客传地图', { timeout: 30000, skip: !withObserver && 'Set RA2_PLAYER16_OBSERVER=1 when enabling16+1 policy' }, async context => {
  const humans = humanRecords(17, { observerIndex: 16 }), room = await createRoom(context, humans);
  const { id, clients } = await createGame(room, optionsFor(humans));
  assert.equal(clients.length - 1, 16);
  assert.equal(await assertMapTransfer(clients), 17);
  await assertLoadedAndIdenticalTurns(room, id, clients);
});

test('观察者房主位0加16战斗真人仍保留连续17参与者ID', { timeout: 30000, skip: !withObserver && 'Set RA2_PLAYER16_OBSERVER=1 when enabling16+1 policy' }, async context => {
  const humans = humanRecords(17, { observerIndex: 0 }), room = await createRoom(context, humans);
  const { id, clients } = await createGame(room, optionsFor(humans));
  await assertLoadedAndIdenticalTurns(room, id, clients, 1);
});

test('17名战斗真人必须在STARTG或CREATE被拒绝', { timeout: 30000 }, async context => {
  const humans = humanRecords(17).map(player => ({ ...player, colorId: -2, startPos: -2 }));
  const room = await createRoom(context, humans);
  await assertRejectedBeforeStart(room, optionsFor(humans));
});

test('16真人加difficulty0的有效AI必须拒绝，不能把难度0当空槽', { timeout: 30000 }, async context => {
  const humans = humanRecords(16), room = await createRoom(context, humans);
  const aiPlayers = emptyAiSlots(); aiPlayers[0] = aiPlayer(-2, 0);
  await assertRejectedBeforeStart(room, optionsFor(humans, { aiPlayers }));
});

test('2真人加14AI恰好16参战且17个AI槽尾部逗号正确时接受CREATE', { timeout: 30000 }, async context => {
  const humans = humanRecords(2), room = await createRoom(context, humans), aiPlayers = emptyAiSlots();
  for (let index = 2; index < 16; index++) aiPlayers[index] = aiPlayer(index, index % 5);
  const options = optionsFor(humans, { aiPlayers });
  assert.ok(options.endsWith('0,-1,-1,-1,-1,'));
  const { id, clients } = await createGame(room, options);
  assert.equal(room.server.games.get(id).players.length, 2, 'AI must not become network participants');
  await assertLoadedAndIdenticalTurns(room, id, clients, 1);
});

test('2真人加15AI超过16参战必须拒绝CREATE', { timeout: 30000 }, async context => {
  const humans = humanRecords(2), room = await createRoom(context, humans), aiPlayers = emptyAiSlots();
  for (let index = 1; index < 16; index++) aiPlayers[index] = aiPlayer(-2, 0);
  await assertRejectedBeforeStart(room, optionsFor(humans, { aiPlayers }));
});

test('观察者房主加16AI允许第16索引AI且难度3与4可用', { timeout: 30000 }, async context => {
  const humans = humanRecords(1, { observerIndex: 0 }), room = await createRoom(context, humans), aiPlayers = emptyAiSlots();
  for (let index = 1; index <= 16; index++) aiPlayers[index] = aiPlayer(index - 1, 3 + index % 2);
  const { id, clients } = await createGame(room, optionsFor(humans, { aiPlayers }));
  assert.equal(room.server.games.get(id).combatants, 16);
  assert.equal(room.server.games.get(id).observers, 1);
  assert.equal(clients.length, 1);
});

test('AI尾段缺字段与伪装countryId=-3观察者必须拒绝CREATE', { timeout: 30000 }, async context => {
  for (const aiWire of ['0,0,0,0', '0,-3,-2,-2,-2']) await context.test(aiWire, async child => {
    const humans = humanRecords(2), room = await createRoom(child, humans);
    await assertRejectedBeforeStart(room, optionsFor(humans, { aiWire }));
  });
});

test('超过1观察者的17参与者名单必须拒绝', { timeout: 30000 }, async context => {
  const humans = humanRecords(17, { observerIndex: 16 });
  humans[15].countryId = -3; humans[15].colorId = -2; humans[15].startPos = -2;
  const room = await createRoom(context, humans);
  await assertRejectedBeforeStart(room, optionsFor(humans));
});

test('17座位房间拒绝第18个真人加入', { timeout: 30000 }, async context => {
  const humans = humanRecords(17, { observerIndex: 16 }), room = await createRoom(context, humans);
  const outsider = await wolLogin(room.server.port, 'P16User18');
  const reply = await request(outsider, `joingame ${room.channel} 0 `, has(' 471 '));
  assert.ok(reply.includes('Room full'));
  const names = await request(room.host, `names ${room.channel}`, has(' 353 '));
  assert.ok(!names.includes('P16User18,'));
});
