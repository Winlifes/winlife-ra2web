import http from 'node:http';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { NetworkRateController } from './network-rate.mjs';

const deriveKey = promisify(scrypt);
const SERVER = 'RA2WEB-LAN';
const MAX_COMBATANTS = 16;
const MAX_PARTICIPANTS = 17; // 16 combatants and one dedicated observer.
const MAX_ROOMS = 8;
const NAME = /^[A-Za-z0-9_-]{2,15}$/;
const PREFIX = 2;
const SERVER_VERSION = '0.7.1';

function parseLine(line) {
  const separator = line.indexOf(' :');
  const head = separator < 0 ? line : line.slice(0, separator);
  const [command, ...args] = head.trim().split(/ +/);
  return { command: command.toLowerCase(), args, trailing: separator < 0 ? undefined : line.slice(separator + 2) };
}

function validateActions(payload) {
  if (!payload.length || payload.length > 65535) return false;
  let offset = 1;
  for (let index = 0; index < payload[0]; index++) {
    if (offset + 3 > payload.length) return false;
    const size = payload.readUInt16LE(offset + 1);
    offset += 3 + size;
    if (offset > payload.length) return false;
  }
  return offset === payload.length;
}

function containsResignation(payload) {
  // Native ActionType.ResignGame is action 3 with no parameters.
  for (let index = 0, offset = 1; index < payload[0]; index++) {
    const size = payload.readUInt16LE(offset + 1);
    if (payload[offset] === 3 && size === 0) return true;
    offset += 3 + size;
  }
  return false;
}

export async function createLanServer({ port = 18600, host = '127.0.0.1', origin = 'https://lan-game.example.com', dataDir, nicknameOnly = false, pingIntervalMs = 2000, heartbeatTimeoutMs = 15000, reconnectGraceMs = 300000, networkPolicy = {}, log = () => {} } = {}) {
  const timingPolicy = new NetworkRateController([], { ...networkPolicy, now: performance.now() }).policy;
  const users = new Map();
  const wolUsers = new Map();
  const rooms = new Map();
  const games = new Map();
  const connections = new Set();
  const reconnectEpochs = new Map();
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let eventLoopDelayMs = 0;
  function probe(client) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (client.probe && now - client.probe.sentAt < 6000) return;
    const token = randomBytes(8).toString('hex');
    client.probe = { token, sentAt: now };
    client.ws.ping(token);
  }
  const probeTimer = setInterval(() => {
    eventLoopDelayMs = Math.max(0, Math.round(loopDelay.max / 1e6));
    loopDelay.reset();
    for (const client of connections) {
      if (client.authenticated && performance.now() - (client.lastPongAt ?? client.authenticatedAt) > heartbeatTimeoutMs) client.ws.terminate();
      else probe(client);
    }
    const now = Date.now();
    for (const [id, game] of games) if (game.disconnectedAt !== undefined && now - game.disconnectedAt >= reconnectGraceMs) {
      games.delete(id);
      const room = rooms.get(game.room);
      if (room?.match?.id === id) {
        if (!members(game.room).length) rooms.delete(game.room);
        else { room.match.returned = new Set(room.match.participants); publishRoomState(game.room); }
      }
      log({ event: 'game_recovery_expired', game: id });
    }
  }, pingIntervalMs);
  probeTimer.unref();
  function latency(client, now = performance.now()) {
    const fresh = client?.lastPongAt !== undefined && now - client.lastPongAt < 6000;
    return {
      rttMs: fresh ? client.rttMs : null,
      jitterMs: fresh ? client.jitterMs : null,
      sampleAgeMs: client?.lastPongAt === undefined ? null : Math.round(now - client.lastPongAt),
    };
  }
  function networkSnapshot(name) {
    const now = performance.now();
    const user = [...wolUsers.values()].find(client => client.nick.toLowerCase() === name.toLowerCase());
    const game = [...games.values()].find(game => [...game.clients.values()].some(client => client.nick.toLowerCase() === name.toLowerCase() && client.active && client.ws.readyState === WebSocket.OPEN));
    let room;
    if (game) {
      const pending = game.pending.get(game.turn);
      const waitMs = game.started ? Math.max(0, Math.round(now - game.lastTurnAt)) : 0;
      room = { id: game.id, phase: game.started ? 'playing' : 'loading', turn: game.turn,
        networkTurnMs: game.networkRate?.currentMs ?? null, inputBufferTurns: 2,
        networkRateChanges: game.networkRate?.changes.slice(-4) || [],
        recentWait: game.lastWait && Date.now() - game.lastWait.at < 10000 ? game.lastWait : null,
        players: game.players.map(player => {
        const client = game.clients.get(player.name);
        const connected = client?.ws.readyState === WebSocket.OPEN;
        const fallback = wolUsers.get(player.name);
        return { name: player.name, connected, active: !!client?.active, ...latency(connected ? client : fallback, now),
          waitingForMs: game.started && connected && client.active && !pending?.has(player.name) ? waitMs : 0,
          lastCommandAgeMs: client?.lastCommandAt === undefined ? null : Math.round(now - client.lastCommandAt) };
      }) };
    } else if (user) {
      const channel = [...user.channels].find(channel => rooms.has(channel));
      if (channel) room = { id: channel, phase: 'room', players: members(channel).map(client => ({ name: client.nick, connected: client.ws.readyState === WebSocket.OPEN, active: true, ...latency(client, now), waitingForMs: 0 })) };
    }
    return { ok: true, serverTime: Date.now(), updateIntervalMs: 2000, eventLoopDelayMs, room: room || null };
  }
  if (dataDir) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
      for (const [name, value] of Object.entries(JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8')))) users.set(name, value);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let saveChain = Promise.resolve();
  function saveUsers() {
    if (!dataDir) return Promise.resolve();
    saveChain = saveChain.then(async () => {
      const temporary = join(dataDir, 'accounts.json.tmp');
      await writeFile(temporary, JSON.stringify(Object.fromEntries(users), null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, join(dataDir, 'accounts.json'));
    });
    return saveChain;
  }
  async function authenticate(name, password, create = false) {
    if (nicknameOnly) return NAME.test(name || '');
    if (!NAME.test(name) || typeof password !== 'string' || password.length < 8 || password.length > 128) return false;
    const key = name.toLowerCase();
    let account = users.get(key);
    if (!account) {
      if (!create) return false;
      const salt = randomBytes(16).toString('hex');
      account = { name, salt, hash: (await deriveKey(password, salt, 32)).toString('hex') };
      users.set(key, account);
      await saveUsers();
    }
    const actual = await deriveKey(password, account.salt, 32);
    return timingSafeEqual(actual, Buffer.from(account.hash, 'hex'));
  }
  function send(client, message) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > 4 * 1024 * 1024) { client.ws.close(1013, 'Client receive buffer exceeded'); return; }
    client.ws.send(typeof message === 'string' ? message + '\r\n' : message);
  }
  function reply(client, code, tail = ':OK') { send(client, `:${SERVER} ${code} ${client.nick || '*'} ${tail}`); }
  function userPrefix(client) { return `:${client.nick}!${client.nick}@lan`; }
  function members(channel) { return [...wolUsers.values()].filter(client => client.channels.has(channel)); }
  function broadcast(channel, line, except) { for (const client of members(channel)) if (client !== except) send(client, line); }
  function names(client, channel) {
    const room = rooms.get(channel);
    const entries = members(channel).map(member => `${room?.host === member.nick ? '@' : ''}${member.nick},0,${performance.now() - member.gservPingAt < 6000 ? member.gservPingMs : latency(member).rttMs ?? 0},0`).join(' ');
    reply(client, 353, `= ${channel} :${entries}`);
    reply(client, 366, `${channel} :End of NAMES`);
  }
  function publishNames(channel) { for (const member of members(channel)) names(member, channel); }
  function publishRoomState(channel) {
    const room = rooms.get(channel);
    if (!room?.match) return;
    const present = new Set(members(channel).map(member => member.nick));
    const waiting = room.match.participants.filter(name => present.has(name) && !room.match.returned.has(name));
    room.started = waiting.length > 0;
    broadcast(channel, `:${SERVER}!${SERVER}@lan GAMEOPT ${channel} :W${JSON.stringify({ gameId: room.match.id, waiting })}`);
  }
  function sendGameServer(client, channel) { send(client, `:${SERVER} GSERV ${channel} :lan Game-Station ${origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/gserv`); }
  function leave(client, channel) {
    if (!client.channels.has(channel)) return;
    const room = rooms.get(channel);
    if (room?.match) departGame(games.get(room.match.id), client.nick);
    broadcast(channel, `${userPrefix(client)} PART ${channel} :Leaving`);
    client.channels.delete(channel);
    if (room?.host === client.nick) {
      for (const member of members(channel)) {
        send(member, `${userPrefix(client)} KICK ${channel} ${member.nick} :Host left`);
        member.channels.delete(channel);
      }
      rooms.delete(channel);
    } else { publishNames(channel); publishRoomState(channel); }
  }
  function joinChannel(client, channel, game = false) {
    const room = rooms.get(channel);
    room?.disconnected?.delete(client.nick);
    client.channels.add(channel);
    const line = game
      ? `${userPrefix(client)} JOINGAME 1 0 0 0 0 1 0 :${channel}`
      : `${userPrefix(client)} JOIN :0,1,${room?.host === client.nick ? 1 : 0},0 ${channel}`;
    broadcast(channel, line);
    publishNames(channel);
    if (game) {
      sendGameServer(client, channel);
      for (const [kind, opt] of room.options) if (kind !== 'P') send(client, `:${room.host}!${room.host}@lan GAMEOPT ${channel} :${opt}`);
    }
  }
  function loadInfo(game) {
    return game.players.map(player => {
      const client = game.clients.get(player.name);
      return `${player.name},${client?.ws.readyState === WebSocket.OPEN ? 1 : 0},${client?.loaded || 0},1,120000`;
    }).join(',');
  }
  function gameBroadcast(game, message) { for (const client of game.clients.values()) send(client, message); }
  function timelineBroadcast(game, message) {
    for (const client of game.clients.values()) if (client.timelineReady) send(client, message);
  }
  function networkPlayers(game, now) {
    const fresh = client => client?.lastPongAt !== undefined && now - client.lastPongAt < timingPolicy.freshSampleMs;
    return game.players.filter(player => {
      const client = game.clients.get(player.name);
      return client?.active && client.ws.readyState === WebSocket.OPEN;
    }).flatMap(player => {
      const gameClient = game.clients.get(player.name), lobbyClient = wolUsers.get(player.name);
      const measured = [gameClient, lobbyClient].filter(fresh);
      return measured.length ? measured.map(client => ({ samples: client.rttSamples || [], jitterMs: client.jitterMs || 0 })) : [{ samples: [], jitterMs: 0 }];
    });
  }
  function rateMessage(change) { return `:${SERVER} 802 * :${change.rateMs},${change.turnNo}`; }
  async function replayTimeline(client, game, after = -1) {
    // Await each write: long matches must not overflow the live socket's
    // buffer limit. The dynamic history/rate tail stays ordered while other
    // players continue submitting turns during recovery.
    const write = message => new Promise(resolve => {
      if (client.ws.readyState !== WebSocket.OPEN || game.clients.get(client.nick) !== client) return resolve(false);
      client.ws.send(typeof message === 'string' ? message + '\r\n' : message, error => resolve(!error));
    });
    const changes = new Map(); let nextChange = 0;
    for (let index = Math.max(0, after + 1); index < game.history.length; index++) {
      while (nextChange < game.networkRate.changes.length) {
        const change = game.networkRate.changes[nextChange++];
        if (change.turnNo > 0) changes.set(change.turnNo, change);
      }
      const packet = game.history[index], turn = packet.readUInt32LE(2);
      if (changes.has(turn) && !await write(rateMessage(changes.get(turn)))) return false;
      if (!await write(packet)) return false;
    }
    return client.ws.readyState === WebSocket.OPEN && game.clients.get(client.nick) === client;
  }
  function startIfReady(game) {
    if (game.started || !game.players.every(player => game.departed.has(player.name) || (game.clients.get(player.name)?.loaded || 0) >= 100)) return;
    game.started = true;
    game.startedAt = Date.now();
    game.lastTurnAt = performance.now();
    game.networkRate = new NetworkRateController(networkPlayers(game, game.lastTurnAt), { ...timingPolicy, now: game.lastTurnAt });
    for (const client of game.clients.values()) if (!game.departed.has(client.nick)) { client.timelineReady = true; client.resumed = true; }
    timelineBroadcast(game, rateMessage(game.networkRate.changes[0]));
    gameBroadcast(game, `:${SERVER} 700 * :Start`);
    log({ event: 'game_started', game: game.id, players: game.players.map(player => player.name), networkTurnMs: game.networkRate.currentMs, inputBufferTurns: 2 });
  }
  function flushTurns(game) {
    if (!game.started) return;
    for (let count = 0; count < 20; count++) {
      const actions = game.pending.get(game.turn) || new Map();
      const active = game.players.filter(player => {
        const client = game.clients.get(player.name);
        return !game.departed.has(player.name) && client?.active && client.ws.readyState === WebSocket.OPEN;
      });
      if (!active.length || active.some(player => !actions.has(player.name))) return;
      const now = performance.now(), waitMs = Math.round(now - game.lastTurnAt);
      if (waitMs >= 150) {
        const arrivals = game.arrivals.get(game.turn);
        const latest = Math.max(...active.map(player => arrivals?.get(player.name) || 0));
        const names = active.filter(player => (arrivals?.get(player.name) || 0) >= latest - 20).map(player => player.name);
        game.lastWait = { at: Date.now(), waitMs, names };
        if (!game.lastWaitLogAt || now - game.lastWaitLogAt >= 5000) {
          log({ event: 'turn_wait', game: game.id, turn: game.turn, waitMs, waitingFor: names });
          game.lastWaitLogAt = now;
        }
      }
      const parts = [];
      const header = Buffer.alloc(7);
      header[0] = PREFIX; header[1] = 1; header.writeUInt32LE(game.turn, 2); header[6] = game.players.length;
      parts.push(header);
      for (const player of game.players) {
        let payload = actions.get(player.name) || Buffer.from([0]);
        if (game.departed.has(player.name)) {
          payload = !player.observer && !game.resigned.has(player.name) ? Buffer.from([1, 3, 0, 0]) : Buffer.from([0]);
        }
        if (!player.observer && containsResignation(payload)) game.resigned.add(player.name);
        const playerHeader = Buffer.alloc(3);
        playerHeader[0] = player.id; playerHeader.writeUInt16LE(payload.length, 1);
        parts.push(playerHeader, payload);
      }
      const packet = Buffer.concat(parts);
      const change = game.networkRate.advance(networkPlayers(game, now), game.turn, now);
      if (change) {
        timelineBroadcast(game, rateMessage(change));
        log({ event: 'network_rate_changed', game: game.id, ...change, appliesAtTurn: change.turnNo + 2 });
      }
      game.history.push(packet);
      game.pending.delete(game.turn);
      game.arrivals.delete(game.turn);
      game.turn++;
      game.lastTurnAt = performance.now();
      timelineBroadcast(game, packet);
    }
  }
  function departGame(game, name) {
    if (!game || !game.expected.includes(name) || game.departed.has(name)) return;
    game.departed.add(name);
    game.reconnectLeases?.delete(name);
    rooms.get(game.room)?.disconnected?.delete(name);
    const client = game.clients.get(name);
    if (client) { client.active = false; client.timelineReady = false; }
    // Only unpublished turns may change. The canonical resignation enters
    // the next shared batch once, so live play and a full replay agree.
    for (const actions of game.pending.values()) actions.delete(name);
    log({ event: 'game_player_left', game: game.id, user: name, turn: game.turn });
    if (game.players) {
      startIfReady(game);
      flushTurns(game);
    }
  }
  async function wolCommand(client, line) {
    const { command, args, trailing } = parseLine(line);
    if (!['pass', 'apgar', 'privmsg', 'page', 'notice'].includes(command)) {
      const safeArgs = command === 'joingame'
        ? args.map((value, index) => index === (args.length >= 8 ? 8 : 2) ? '<redacted>' : value)
        : command === 'join' ? args.slice(0, 1) : args;
      log({ service: 'wol', command, args: safeArgs, user: client.nick });
    }
    if (command === 'ping') return send(client, `:${SERVER} PONG ${SERVER} :${trailing ?? args.join(' ')}`);
    if (command === 'pong') return;
    if (command === 'cvers') return reply(client, 700, ':0.87.3');
    if (command === 'setlocale') return reply(client, 310);
    if (command === 'getlocale') return reply(client, 309, `${client.nick} :locale\`21`);
    if (command === 'pass') { client.password = Buffer.from(args[0] || '', 'base64').toString('utf8'); return; }
    if (command === 'nick') { if (NAME.test(args[0] || '')) client.nick = args[0]; return; }
    if (command === 'user') {
      if (!await authenticate(client.nick || '', client.password, true)) return reply(client, 378, `${client.nick || '*'} :Nickname or password invalid`);
      const previous = nicknameOnly
        ? [...wolUsers.values()].find(member => member.nick.toLowerCase() === client.nick.toLowerCase() && member.ws.readyState === WebSocket.OPEN)
        : wolUsers.get(client.nick);
      const sameBrowser = previous?.resumeKey && previous.resumeKey === client.resumeKey && client.resumeEpoch >= previous.resumeEpoch;
      const epoch = reconnectEpochs.get(client.nick.toLowerCase());
      if (epoch && client.resumeKey && epoch.key === client.resumeKey && client.resumeEpoch < epoch.value) return reply(client, 378, `${client.nick} :A newer page has resumed this nickname`);
      if (nicknameOnly && previous && previous !== client && !sameBrowser) return reply(client, 378, `${client.nick} :Nickname already in use`);
      if (previous && previous !== client) previous.ws.close(1000, 'Replaced by new login');
      wolUsers.set(client.nick, client); client.authenticated = true; client.authenticatedAt = performance.now(); client.password = undefined;
      if (client.resumeKey) reconnectEpochs.set(client.nick.toLowerCase(), {key:client.resumeKey,value:client.resumeEpoch});
      probe(client);
      reply(client, 375, ':- RA2WEB LAN'); reply(client, 372, ':- Game workstation local multiplayer'); reply(client, 376, ':End of MOTD');
      return;
    }
    if (!client.authenticated) return reply(client, 378, ':Login required');
    if (command === 'join') {
      if (rooms.has(args[0])) return reply(client, 478, `${args[0]} :Use JOINGAME for game rooms`);
      return joinChannel(client, args[0]);
    }
    if (command === 'names') return names(client, args[0]);
    if (command === 'part') return leave(client, args[0]);
    if (command === 'resumeroom') {
      const channel = args[0], room = rooms.get(channel);
      if (!room?.match || room.match.id !== args[1] || !room.match.participants.includes(client.nick)) return reply(client, 711, `${channel} :Room session has changed`);
      if (games.get(room.match.id)?.departed.has(client.nick) || room.match.returned.has(client.nick)) return reply(client, 711, `${channel} :Already left this match`);
      if (!client.channels.has(channel)) joinChannel(client, channel, true);
      return reply(client, 710, `${channel} :Room restored`);
    }
    if (command === 'returngame') {
      const channel = args[0], room = rooms.get(channel);
      if (!room || !client.channels.has(channel) || wolUsers.get(client.nick) !== client) return reply(client, 711, `${channel} :Room no longer exists`);
      if (!room.match || room.match.id !== args[1] || !room.match.participants.includes(client.nick)) return reply(client, 711, `${channel} :Room session has changed`);
      // A return is explicit; a transient game socket disconnect must not
      // reopen the room or let a second match start during recovery.
      const game = games.get(room.match.id);
      departGame(game, client.nick);
      game?.clients.get(client.nick)?.ws.close(1000, 'Returned to room');
      room.match.returned.add(client.nick);
      if (room.match.participants.every(name => room.match.returned.has(name))) games.delete(room.match.id);
      reply(client, 710, `${channel} :Returned to room`);
      sendGameServer(client, channel);
      if (client.nick !== room.host) for (const [kind, opt] of room.options) {
        if (!['P', 'A', 'W'].includes(kind)) send(client, `:${room.host}!${room.host}@lan GAMEOPT ${channel} :${opt}`);
      }
      for (const member of members(channel)) if (member.nick !== room.host) broadcast(channel, `${userPrefix(member)} GAMEOPT ${channel} :A0`);
      publishNames(channel); publishRoomState(channel);
      return;
    }
    if (command === 'abandongame') {
      const game = games.get(args[1]);
      if (!game || game.room !== args[0] || !game.expected.includes(client.nick) || wolUsers.get(client.nick) !== client) return reply(client, 713, ':Match no longer available');
      departGame(game, client.nick);
      game.clients.get(client.nick)?.ws.close(1000, 'Left match');
      return reply(client, 712, ':Left match');
    }
    if (command === 'quit') { client.intentionalQuit = true; client.ws.close(1000, 'Quit'); return; }
    if (command === 'list') {
      reply(client, 321, 'Channel Users :Topic');
      for (const [channel, room] of rooms) if (room.topic && !room.started) {
        reply(client, 322, `${channel} ${members(channel).length} ${room.max} 45 0 0 1 ${room.password ? 384 : 0}::${room.topic} 0`);
      }
      return reply(client, 323, ':End of LIST');
    }
    if (command === 'joingame') {
      const channel = args[0];
      if (!channel?.startsWith('#') || channel.length > 128) return reply(client, 400, ':Invalid room');
      let room = rooms.get(channel);
      if (args.length >= 8) {
        if (room || rooms.size >= MAX_ROOMS) return reply(client, 400, ':Room already exists or server is full');
        const requested = Number(args[2]);
        const capacity = Number.isInteger(requested) ? Math.min(MAX_PARTICIPANTS, Math.max(2, requested)) : MAX_PARTICIPANTS;
        room = { host: client.nick, max: capacity, password: args[8] || '', topic: '', options: new Map(), started: false };
        rooms.set(channel, room);
      } else {
        const lease = room?.match && games.get(room.match.id)?.reconnectLeases?.get(client.nick);
        const recovering = room?.match?.participants.includes(client.nick) && !games.get(room.match.id)?.departed.has(client.nick) && (room.disconnected?.has(client.nick) || (lease && lease.key === client.resumeKey && client.resumeEpoch >= lease.epoch));
        if (!room || (room.started && !recovering)) return reply(client, 478, `${channel} :Room closed`);
        if (room.password && room.password !== (args[2] || '')) return reply(client, 475, `${channel} :Incorrect room password`);
        if (members(channel).length >= room.max) return reply(client, 471, `${channel} :Room full`);
      }
      return joinChannel(client, channel, true);
    }
    if (command === 'topic') {
      const room = rooms.get(args[0]);
      if (room?.host === client.nick) room.topic = trailing || '';
      return;
    }
    if (command === 'gameopt') {
      const target = args[0], opt = trailing || '';
      if (!opt || opt.length > 65535 || opt[0] === 'W') return;
      if (target?.startsWith('#') && client.channels.has(target)) {
        const room = rooms.get(target);
        if (room?.host === client.nick) room.options.set(/^[\d-]/.test(opt) ? 'settings' : opt[0], opt);
        broadcast(target, `${userPrefix(client)} GAMEOPT ${target} :${opt}`, client);
      } else {
        const recipient = wolUsers.get(target);
        if (recipient && [...client.channels].some(channel => recipient.channels.has(channel))) send(recipient, `${userPrefix(client)} GAMEOPT ${target} :${opt}`);
      }
      return;
    }
    if (command === 'mode') {
      const room = rooms.get(args[0]);
      if (room?.host === client.nick && args[1] === '+l') {
        const requested = Number(args[2]);
        room.max = Number.isInteger(requested) ? Math.min(MAX_PARTICIPANTS, Math.max(2, requested)) : MAX_PARTICIPANTS;
        broadcast(args[0], `${userPrefix(client)} MODE ${args[0]} +l ${room.max}`);
      }
      return;
    }
    if (command === 'gping') {
      const ping = Number(args[2]);
      if (rooms.has(args[0]) && client.channels.has(args[0]) && args[1] === 'lan' && Number.isFinite(ping) && ping >= 0 && ping <= 10000) {
        client.gservPingMs = Math.max(1, Math.round(ping)); client.gservPingAt = performance.now();
      }
      return;
    }
    if (command === 'startg') {
      const room = rooms.get(args[0]);
      if (!room || room.host !== client.nick || room.started) return;
      const participants = (args[1] || '').split(',').filter(Boolean);
      if (participants.length < 1 || participants.length > MAX_PARTICIPANTS || new Set(participants).size !== participants.length || participants.some(name => !members(args[0]).some(member => member.nick === name))) return;
      const id = randomUUID();
      const game = { id, room: args[0], host: room.host, expected: participants, timestamp: Date.now(), clients: new Map(), pending: new Map(), arrivals: new Map(), history: [], hashes: new Map(), departed: new Set(), resigned: new Set(), turn: 0, started: false };
      games.set(id, game); room.started = true;
      room.match = { id, participants: [...participants], returned: new Set() };
      room.options.delete('A');
      broadcast(args[0], `:${SERVER} STARTG ${args[0]} :${origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/gserv :${id} ${game.timestamp}`);
      return;
    }
    if (command === 'kick') {
      const room = rooms.get(args[0]);
      if (room?.host === client.nick) for (const name of (args[1] || '').split(',')) {
        const recipient = wolUsers.get(name);
        if (recipient?.channels.has(args[0])) {
          broadcast(args[0], `${userPrefix(client)} KICK ${args[0]} ${name} :Kicked`);
          recipient.channels.delete(args[0]);
          publishRoomState(args[0]);
        }
      }
    }
  }
  async function gservCommand(client, line) {
    const { command, args, trailing } = parseLine(line);
    if (command !== 'user') log({ service: 'gserv', command, args: command === 'create' ? [args[0], args[1], '<game-options>', ...args.slice(3)] : args, user: client.nick });
    if (command === 'ping') return send(client, `:${SERVER} PONG ${SERVER} :${trailing ?? args.join(' ')}`);
    if (command === 'pong') return;
    if (command === 'cvers') return reply(client, 10);
    if (command === 'user') {
      const [name, password] = args;
      if (!await authenticate(name || '', Buffer.from(password || '', 'base64').toString('utf8'))) return reply(client, 103, ':Bad login');
      client.nick = name; client.authenticated = true; client.authenticatedAt = performance.now(); probe(client); return reply(client, 100);
    }
    if (!client.authenticated) return reply(client, 103, ':Login required');
    if (command === 'create') {
      const game = games.get(args[0]);
      if (!game || game.host !== client.nick) return reply(client, 401, ':Game not found');
      if (game.options) return reply(client, 201, ':Already created');
      const sections = (args[2] || '').split(':'), settings = sections[0]?.split(',') || [];
      const humans = sections[1]?.split(',') || [], aiText = sections[3] || '';
      if (sections.length !== 4 || sections[2] !== '@' || humans.length % 8 || (aiText && !aiText.endsWith(','))) return reply(client, 402, ':Invalid player setup');
      const ai = aiText ? aiText.slice(0, -1).split(',') : [];
      if (ai.length % 5 || ai.length / 5 > MAX_PARTICIPANTS) return reply(client, 402, ':Invalid AI setup');
      const players = [];
      for (let index = 0; index < humans.length; index += 8) {
        const countryId = Number(humans[index + 1]);
        if (!Number.isInteger(countryId) || countryId < -3) return reply(client, 402, ':Invalid player country');
        players.push({ id: index / 8, name: humans[index], observer: countryId === -3 });
      }
      if (players.length !== game.expected.length || players.length > MAX_PARTICIPANTS || new Set(players.map(player => player.name)).size !== players.length || players.some(player => !game.expected.includes(player.name))) return reply(client, 402, ':Unexpected player list');
      const observers = players.filter(player => player.observer).length;
      const observerHost = players[0]?.name === game.host && players[0]?.observer;
      let bots = 0;
      for (let index = 0; index < ai.length; index += 5) {
        const row = ai.slice(index, index + 5).map(Number), country = row[1];
        if (row.some(value => !Number.isInteger(value)) || country < -2) return reply(client, 402, ':Invalid AI country');
        if (country !== -1) {
          if ((index / 5 >= MAX_COMBATANTS && !observerHost) || row[0] < 0 || row[0] > 4) return reply(client, 402, ':Invalid AI slot');
          bots++;
        }
      }
      const combatants = players.length - observers + bots, slots = Number(settings[13]);
      if (observers > 1 || combatants < 2 || combatants > MAX_COMBATANTS || !Number.isInteger(slots) || slots < combatants || slots > MAX_COMBATANTS) return reply(client, 402, ':At most 16 combatants and one observer are supported');
      game.options = args[2]; game.version = args[3]; game.modHash = args[4]; game.players = players;
      game.combatants = combatants; game.observers = observers;
      attachGame(client, game); return reply(client, 200);
    }
    if (command === 'join') {
      const game = games.get(args[0]);
      if (!game?.options) return reply(client, 401, ':Game not created yet');
      if (!game.players.some(player => player.name === client.nick)) return reply(client, 402, ':Not a participant');
      if (game.departed.has(client.nick)) return reply(client, 402, ':Already left this match');
      if (game.version !== args[1] || game.modHash !== args[2]) return reply(client, 406, ':Version mismatch');
      const lease = game.reconnectLeases?.get(client.nick);
      if (lease && (client.resumeKey !== lease.key || client.resumeEpoch < lease.epoch)) return reply(client, 402, ':This game was resumed by another page');
      attachGame(client, game); return reply(client, 400);
    }
    const game = client.game;
    if (!game) return reply(client, 401, ':Join a game first');
    if (game.clients.get(client.nick) !== client) return reply(client, 402, ':Replaced by another connection');
    if (command === 'leavegame') {
      departGame(game, client.nick);
      reply(client, 720, ':Left match');
      client.ws.close(1000, 'Left match');
      return;
    }
    if (game.departed.has(client.nick)) return reply(client, 402, ':Already left this match');
    if (command === 'gameopts') return reply(client, 500, ':' + game.options);
    if (command === 'loadinfo') return reply(client, 600, ':' + loadInfo(game));
    if (command === 'loaded') {
      client.loaded = Math.max(client.loaded, Math.min(100, Number(args[0]) || 0));
      gameBroadcast(game, `:${SERVER} 600 * :${loadInfo(game)}`);
      if (client.loaded === 100 && game.started && !client.resumed) {
        client.resumed = true;
        send(client, rateMessage(game.networkRate.changes[0])); send(client, `:${SERVER} 700 * :Start`);
        if (!await replayTimeline(client, game)) return;
        client.timelineReady = true; client.active = true; flushTurns(game);
      } else startIfReady(game);
      return;
    }
    if (command === 'active') { client.active = args[0] === '1'; return flushTurns(game); }
    if (command === 'resume') {
      if (!game.started) return reply(client, 301, ':Not started');
      const after = args[0] === 'none' ? -1 : Number(args[0]);
      if (!Number.isInteger(after) || after < -1) return reply(client, 301, ':Invalid resume turn');
      reply(client, 400, ':' + (game.turn - 1));
      if (!await replayTimeline(client, game, after)) return;
      // A stall reconnect retains its simulation and sends resume directly,
      // without loaded 100. Re-enable the live stream only after replay.
      client.resumed = true; client.loaded = 100; client.timelineReady = true; client.active = true;
      gameBroadcast(game, `:${SERVER} 600 * :${loadInfo(game)}`);
      flushTurns(game);
      return;
    }
    if (command === 'privmsg') return gameBroadcast(game, `:${client.nick} PRIVMSG ${args[0]} :${trailing || ''}`);
    if (command === 'taunt') return gameBroadcast(game, `:${client.nick} 803 * :${Number(args[0]) || 0}`);
  }
  function attachGame(client, game) {
    const previous = game.clients.get(client.nick);
    if (previous && previous !== client) previous.ws.close(1000, 'Replaced by reconnect');
    client.game = game; client.active = !game.started; client.loaded = 0; client.resumed = false; client.timelineReady = false;
    game.clients.set(client.nick, client);
    delete game.disconnectedAt;
    if (client.resumeKey) {
      game.reconnectLeases ??= new Map();
      game.reconnectLeases.set(client.nick, {key:client.resumeKey,epoch:client.resumeEpoch});
    }
  }
  function binaryCommand(client, data) {
    const game = client.game;
    if (!client.authenticated || !game || game.departed.has(client.nick) || game.clients.get(client.nick) !== client || data[0] !== PREFIX || data.length < 2) return;
    if (data[1] === 1) {
      if (!game.started || data.length < 7) return;
      const turn = data.readUInt32LE(2), payload = data.subarray(6);
      if (!validateActions(payload) || turn < game.turn || turn > game.turn + 10) return;
      const actions = game.pending.get(turn) || new Map();
      if (!actions.has(client.nick)) {
        actions.set(client.nick, Buffer.from(payload));
        const arrivals = game.arrivals.get(turn) || new Map();
        arrivals.set(client.nick, performance.now()); game.arrivals.set(turn, arrivals);
      }
      client.lastCommandAt = performance.now();
      game.pending.set(turn, actions); flushTurns(game);
    } else if (data[1] === 2 && data.length === 10) {
      const turn = data.readUInt32LE(2), hash = data.readUInt32LE(6);
      // A fresh page replays old ticks; don't evict current comparison hashes
      // with a second, obsolete stream from the start of a long match.
      if (game.hashes.size >= 120 && !game.hashes.has(turn) && turn < Math.min(...game.hashes.keys())) return;
      const hashes = game.hashes.get(turn) || new Map();
      hashes.set(client.nick, hash); game.hashes.set(turn, hashes);
      if (new Set(hashes.values()).size > 1 && !game.desynced) {
        game.desynced = true;
        log({ event: 'desync', game: game.id, turn, hashes: [...hashes] });
        gameBroadcast(game, `:${SERVER} 801 * :Game state hash mismatch at turn ${turn}`);
      }
      if (game.hashes.size > 120) game.hashes.delete(game.hashes.keys().next().value);
    } else if (data[1] === 3 && client.nick === game.host && !game.started && data.length <= 2 * 1024 * 1024 + 2) game.mapData = Buffer.from(data.subarray(2));
    else if (data[1] === 4 && game.mapData) send(client, Buffer.concat([Buffer.from([PREFIX, 2]), game.mapData]));
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const query = new URL(request.url, 'http://localhost').searchParams;
      if (pathname === '/healthz' && query.get('network') === '1') return response.end(JSON.stringify(networkSnapshot(query.get('user') || '')));
      if (pathname === '/healthz') return response.end(JSON.stringify({ ok: true, serverVersion: SERVER_VERSION, limits: { combatants: MAX_COMBATANTS, observers: 1, participants: MAX_PARTICIPANTS }, networkPolicy: { mode: 'adaptive-two-turn', ...timingPolicy }, nicknameOnly, users: wolUsers.size, rooms: rooms.size, games: [...games.values()].map(game => ({ id: game.id, started: game.started, turn: game.turn, players: game.expected, combatants: game.combatants, observers: game.observers, desynced: !!game.desynced, networkTurnMs: game.networkRate?.currentMs ?? null, networkRateChanges: game.networkRate?.changes.slice(-4) || [], hashes: [...game.hashes].slice(-2).map(([turn, entries]) => ({ turn, values: [...entries] })) })) }));
      if (pathname === '/register' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error('Request too large'); }
        const input = JSON.parse(body);
        if (users.has(String(input.user).toLowerCase())) return response.end(JSON.stringify({ error: 'Nickname already registered' }));
        const ok = await authenticate(input.user, input.pass, true);
        return response.end(JSON.stringify(ok ? { ok: true } : { error: 'Use a 2–15 character ASCII nickname and an 8–128 character password' }));
      }
      response.statusCode = 404; response.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error.message })); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 + 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!['/wol', '/gserv'].includes(pathname) || (request.headers.origin && request.headers.origin !== origin)) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      const query = new URL(request.url, 'http://localhost').searchParams;
      const key = query.get('winlifeClientId'), epoch = Number(query.get('winlifeEpoch'));
      const client = { ws, service: pathname.slice(1), channels: new Set(), authenticated: false, buffer: '', chain: Promise.resolve(),
        resumeKey: /^[a-f0-9-]{32,64}$/i.test(key || '') ? key : undefined,
        resumeEpoch: Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0 };
      connections.add(client);
      ws.on('pong', data => {
        if (!client.probe || data.toString() !== client.probe.token) return;
        const now = performance.now(), rtt = Math.max(1, Math.round(now - client.probe.sentAt));
        client.jitterMs = client.rttMs === undefined ? 0 : Math.round((client.jitterMs || 0) * 0.75 + Math.abs(rtt - client.rttMs) * 0.25);
        client.rttMs = rtt; client.lastPongAt = now; client.probe = undefined;
        client.rttSamples ??= [];
        client.rttSamples.push({ rttMs: rtt, at: now });
        client.rttSamples = client.rttSamples.filter(sample => now - sample.at <= timingPolicy.sampleWindowMs).slice(-60);
      });
      ws.on('error', error => log({ event: 'socket_error', message: error.message }));
      ws.on('message', (data, isBinary) => {
        client.chain = client.chain.then(async () => {
          if (isBinary && data[0] === PREFIX) return binaryCommand(client, data);
          client.buffer += data.toString();
          if (client.buffer.length > 131072) { ws.close(1009, 'Message too large'); return; }
          let index;
          while ((index = client.buffer.indexOf('\n')) >= 0) {
            const line = client.buffer.slice(0, index).replace(/\r$/, ''); client.buffer = client.buffer.slice(index + 1);
            if (line) await (client.service === 'wol' ? wolCommand(client, line) : gservCommand(client, line));
          }
        }).catch(error => { log({ event: 'protocol_error', service: client.service, message: error.message }); ws.close(1011, 'Protocol error'); });
      });
      ws.on('close', () => {
        connections.delete(client);
        if (client.service === 'wol') {
          if (wolUsers.get(client.nick) === client) wolUsers.delete(client.nick);
          for (const channel of [...client.channels]) {
            const room = rooms.get(channel);
            if (!client.intentionalQuit && room?.match && games.has(room.match.id) && !room.match.returned.has(client.nick)) {
              room.disconnected ??= new Map(); room.disconnected.set(client.nick, Date.now());
              client.channels.delete(channel); publishNames(channel);
            } else leave(client, channel);
          }
        } else if (client.game?.clients.get(client.nick) === client) {
          client.active = false;
          gameBroadcast(client.game, `:${SERVER} 804 * :${client.nick}`);
          flushTurns(client.game);
          if (![...client.game.clients.values()].some(member => member.ws.readyState === WebSocket.OPEN)) client.game.disconnectedAt = Date.now();
        }
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, games, rooms, port: server.address().port, async close() {
    clearInterval(probeTimer); loopDelay.disable();
    for (const client of connections) client.ws.terminate();
    wss.close(); await new Promise(resolve => server.close(resolve)); await saveChain;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const instance = await createLanServer({ port: Number(process.env.PORT || 18600), host: process.env.HOST || '127.0.0.1', origin: process.env.ORIGIN || 'http://localhost:8080', dataDir: process.env.DATA_DIR, nicknameOnly: process.env.NICKNAME_ONLY !== '0', networkPolicy: { minMs: Number(process.env.RA2_NETWORK_MIN_MS || 60), maxMs: Number(process.env.RA2_NETWORK_MAX_MS || 200), fallbackMs: Number(process.env.RA2_NETWORK_FALLBACK_MS || 133) }, log: entry => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry })) });
  console.log(JSON.stringify({ event: 'listening', host: process.env.HOST || '127.0.0.1', port: instance.port }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => instance.close().then(() => process.exit(0)));
}
