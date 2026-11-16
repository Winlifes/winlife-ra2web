/* Read-only VM checks against the ACTUAL patched client bundle.
 * RA2_CLIENT_BUNDLE=/path/to/client/js/app.js node --test deploy/ra2web-lan/player16-client.test.cjs
 * Optional: RA2_CLIENT_RULES=/absolute/path/res/overlay/rules.ini
 * Parsers are installed by npm ci at the repository root.
 */
const nodeTest = require('node:test');
const { after } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const acorn = require('acorn');
const walk = require('acorn-walk');

const staged = path.resolve(__dirname, '../../vendor/ra2web-lan-0.87.3-20261112-workshop7/js/app.js');
const bundle = process.env.RA2_CLIENT_BUNDLE || (fs.existsSync(staged) ? staged : path.resolve(__dirname, '../../vendor/client/js/app.js'));
const source = fs.readFileSync(bundle, 'utf8');
const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
const classes = new Map(), declarations = new Map(), assignments = new Map(), functions = new Map(), allMethods = [];
walk.fullAncestor(tree, (node, _state, ancestors) => {
  const parent = ancestors.at(-2);
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') declarations.set(node.id.name, node);
  if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') assignments.set(node.left.name, node.right);
  if (node.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, node);
  if (node.type === 'MethodDefinition') allMethods.push(node);
  if (/^Class(?:Expression|Declaration)$/.test(node.type)) {
    if (node.id?.name) classes.set(node.id.name, node);
    if (parent?.type === 'VariableDeclarator') classes.set(parent.id.name, node);
    if (parent?.type === 'AssignmentExpression' && parent.left.type === 'Identifier') classes.set(parent.left.name, node);
  }
});
const raw = node => { assert.ok(node, 'required original source node exists'); return source.slice(node.start, node.end); };
const run = (code, globals = {}) => vm.runInNewContext(code, { console, ...globals }, { timeout: 5000 });
function method(owner, name) {
  const c = classes.get(owner); assert.ok(c, `actual bundle has class/alias ${owner}`);
  const m = c.body.body.find(node => node.key?.name === name || node.key?.value === name);
  assert.ok(m, `actual bundle has ${owner}.${name}`); return raw(m);
}
function uniqueMethod(name) {
  const nodes = allMethods.filter(node => node.key?.name === name);
  assert.equal(nodes.length, 1, `exactly one original method ${name}`); return raw(nodes[0]);
}
function binding(name) { return run(`var ${name};(${raw(declarations.get(name)?.init || assignments.get(name))})`); }
const results = [];
function check(name, fn, { skip } = {}) {
  if (skip) results.push({ name, status: 'skip', reason: skip });
  return nodeTest(name, { skip }, () => {
    try { const detail = fn() || {}; results.push({ name, status: 'pass', ...detail }); }
    catch (error) { results.push({ name, status: 'fail', error: error.stack }); throw error; }
  });
}

// These are actual IniParser, IniSection, IniFile classes from this bundle.
// The sole VirtualFile double is an unused instanceof discriminator; no INI
// parsing, numeric semantics, or manifest behavior is reimplemented here.
const iniContext = vm.createContext({ console });
vm.runInContext(`class aX{};${raw(classes.get('Ni'))};${raw(classes.get('nA'))};${raw(classes.get('fs'))};${raw(functions.get('wlSpawnCap'))};`, iniContext);
const Ini = vm.runInContext('fs', iniContext);
const spawnCap = vm.runInContext('wlSpawnCap', iniContext);
const mapTitle = functions.has('wlMapTitle') ? run(`(${raw(functions.get('wlMapTitle'))})`, { TextDecoder, Uint8Array }) : undefined;
const Manifest = run(`(${raw(classes.get('cZ'))})`, { fs: Ini, wlSpawnCap: spawnCap, wlMapTitle: mapTitle });
const MapReader = run(`(class extends fs {${method('Xg', 'readWaypoints')}${method('Xg', 'readStartingLocations')}})`, { fs: Ini, wlSpawnCap: spawnCap });
const actualColors = binding('mx');
function section(text) { return new Ini(`[Basic]\n${text}`).getSection('Basic'); }
function mapText({ marker = 'WinlifeMaxPlayers=16', keys = Array.from({ length: 16 }, (_, i) => String(i)), coords } = {}) {
  return `[Basic]\nName=Client VM fixture\nGameMode=standard\nOfficial=no\n${marker}\n[Waypoints]\n`
    + keys.map((key, index) => `${key}=${coords?.[index] ?? ((80 + index) * 1000 + 40 + index)}`).join('\n');
}
function manifest(text) { return new Manifest().fromMapFile({ filename: 'wl_vm.map', readAsString: () => text }, [{ mapFilter: 'standard' }]); }
function mapReader(text, { missingTile = -1 } = {}) {
  const reader = new MapReader(text);
  reader.readWaypoints(reader.getOrCreateSection('Waypoints'));
  reader.tiles = reader.waypoints.filter((_, index) => index !== missingTile).map(point => ({ rx: point.rx, ry: point.ry }));
  return reader;
}
const plain = value => JSON.parse(JSON.stringify(value));
const humanPlayers = count => Array.from({ length: count }, (_, index) => ({ name: `Client${index}`, countryId: 0, colorId: -2, startPos: -2, teamId: -2 }));

check('Cached editor map titles decode UTF8 without changing already-Unicode titles', () => {
  const title = 'Winlife 工坊示例', text = mapText().replace('Client VM fixture', title);
  for (const ini of [text, Buffer.from(text, 'utf8').toString('latin1')]) {
    const result = new Manifest().fromMapFile({ filename: 'wl_local_unicode.map', readAsString: () => ini }, [{ mapFilter: 'standard' }]);
    assert.equal(result.uiName, 'NOSTR:' + title);
  }
});

check('Title compatibility keeps ordinary map names and original single-byte names', () => {
  for (const [filename, title] of [['wl_local_latin.map', 'Café'], ['ordinary.map', 'Café'], ['ordinary.map', 'Ã©'], ['wl_local_ascii.map', 'Legacy title']]) {
    const text = mapText().replace('Client VM fixture', title);
    const result = new Manifest().fromMapFile({ filename, readAsString: () => text }, [{ mapFilter: 'standard' }]);
    assert.equal(result.uiName, 'NOSTR:' + title);
  }
  const empty = new Manifest().fromMapFile({ filename: 'wl_local_empty.map', readAsString: () => mapText().replace('Client VM fixture', '') }, [{ mapFilter: 'standard' }]);
  assert.equal(empty.uiName, 'NOSTR:wl_local_empty');
});

check('wlSpawnCap only explicit Winlife metadata expands legacy maps', () => {
  assert.equal(spawnCap(undefined), 8);
  for (const text of ['', 'MaxPlayer=16', 'MaxPlayers=16', 'MaxPlayer=16\nWinlifeMaxPlayers=8']) assert.equal(spawnCap(section(text)), 8);
  for (const capacity of [2, 8, 9, 12, 16]) assert.equal(spawnCap(section(`WinlifeMaxPlayers=${capacity}`)), Math.max(8, capacity));
  for (const invalid of ['0', '1', '-1', '17', '2.5', 'NaN', 'Infinity', 'garbage']) assert.throws(() => spawnCap(section(`WinlifeMaxPlayers=${invalid}`)), /capacity/i);
  return { legacyLimit: 8, expandedLimit: 16 };
});

check('Actual MapManifest sees16 explicit starts and8 legacy starts', () => {
  assert.equal(manifest(mapText()).maxSlots, 16);
  assert.equal(manifest(mapText({ marker: 'MaxPlayer=16' })).maxSlots, 8);
  assert.equal(manifest(mapText({ marker: '' })).maxSlots, 8);
  return { explicit: 16, legacyWithHighWaypoints: 8 };
});

check('MapManifest refuses incomplete declared16 maps instead of advertising smaller capacity', () => {
  assert.throws(() => manifest(mapText({ keys: Array.from({ length: 15 }, (_, index) => String(index)) })), /start|waypoint|capacity|consecutive/i);
});

check('MapManifest rejects numeric-key aliases that could advertise17 slots', () => {
  const keys = [...Array.from({ length: 16 }, (_, index) => String(index)), '00'];
  assert.throws(() => manifest(mapText({ keys })), /start|waypoint|capacity|consecutive|duplicate/i);
});

check('MapManifest validates capacity even when Waypoints section is empty', () => {
  assert.throws(() => manifest(mapText({ marker: 'WinlifeMaxPlayers=17', keys: [] })), /capacity/i);
});

check('Actual MapFile selects16 valid starts without deleting ordinary waypoints', () => {
  const text = mapText({ keys: Array.from({ length: 20 }, (_, index) => String(index)) });
  const reader = mapReader(text), originalWaypoints = plain(reader.waypoints);
  const starts = reader.readStartingLocations(reader.waypoints);
  assert.equal(starts.length, 16); assert.equal(reader.waypoints.length, 20);
  assert.deepEqual(plain(reader.waypoints), originalWaypoints);
  assert.deepEqual(plain(starts[15]), { x: 55, y: 95 });
  return { selected: 16, retainedWaypoints: 20 };
});

check('Legacy Waypoints8..15 remain ordinary waypoint data', () => {
  const reader = mapReader(mapText({ marker: 'MaxPlayer=16' }));
  const starts = reader.readStartingLocations(reader.waypoints);
  assert.equal(starts.length, 8); assert.equal(reader.waypoints.length, 16);
  assert.equal(reader.waypoints[15].number, 15);
  assert.deepEqual(plain(starts[7]), { x: 47, y: 87 });
  return { selected: 8, retained: 16 };
});

check('MapFile rejects missing, duplicate, aliased and nonconsecutive extended start IDs', () => {
  const malformedKeys = [
    Array.from({ length: 15 }, (_, index) => String(index)),
    [...Array.from({ length: 15 }, (_, index) => String(index)), '16'],
    [...Array.from({ length: 16 }, (_, index) => String(index)), '00'],
    [...Array.from({ length: 15 }, (_, index) => String(index)), '0x'],
  ];
  for (const keys of malformedKeys) {
    const reader = mapReader(mapText({ keys }));
    assert.throws(() => reader.readStartingLocations(reader.waypoints), /consecutive|unique|valid|start/i);
  }
  return { rejectedFixtures: malformedKeys.length };
});

check('MapFile rejects duplicate coordinates and starts absent from native tiles', () => {
  const coords = Array.from({ length: 16 }, (_, index) => (80 + index) * 1000 + 40 + index);
  coords[15] = coords[14];
  const duplicate = mapReader(mapText({ coords }));
  assert.throws(() => duplicate.readStartingLocations(duplicate.waypoints), /unique|valid|start/i);
  const missing = mapReader(mapText(), { missingTile: 15 });
  assert.throws(() => missing.readStartingLocations(missing.waypoints), /valid|start/i);
  return { duplicateCoordinates: 'rejected', absentTile: 'rejected' };
});

check('Actual mx contains16 unique names and keeps legacy color IDs stable', () => {
  assert.equal(actualColors.length, 16); assert.equal(new Set(actualColors).size, 16);
  assert.deepEqual([...actualColors].slice(0, 8), ['Gold', 'DarkRed', 'DarkBlue', 'DarkGreen', 'Orange', 'DarkSky', 'Purple', 'Magenta']);
  return { names: [...actualColors] };
});

check('Actual random-color generator allocates16 distinct real color IDs', () => {
  const Gen = run(`(${raw(classes.get('EM'))})`, { mx: actualColors, io: -2, Fs: -3, Xa: -2, Xs: -2, Ss: Boolean });
  for (const random of [low => low, (low, high) => high, (low, high) => Math.floor((low + high) / 2)]) {
    const generator = new Gen({ generateRandomInt: random }), players = humanPlayers(16);
    const colors = generator.generateColors({ humanPlayers: players, aiPlayers: [] });
    assert.deepEqual([...colors.values()].sort((a, b) => a - b), Array.from({ length: 16 }, (_, index) => index));
  }
  return { strategies: 3, distinctColors: 16 };
});

const inferredRules = path.resolve(path.dirname(bundle), '../res/overlay/rules.ini');
const rulesPath = process.env.RA2_CLIENT_RULES || (fs.existsSync(inferredRules) ? inferredRules : undefined);
check('Every actual multiplayer color exists in actual staged native rules', () => {
  const colors = new Ini(fs.readFileSync(rulesPath, 'utf8')).getSection('Colors');
  const Color = run(`(${raw(classes.get('ya'))})`), available = new Map();
  for (const name of actualColors) {
    assert.ok(colors.has(name), `native rules define ${name}`);
    const hsv = [...colors.getNumberArray(name)];
    assert.equal(hsv.length, 3); assert.ok(hsv.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
    available.set(name, Color.fromHsv(...hsv));
  }
  const getColors = run(`({${uniqueMethod('getMultiplayerColors')}}).getMultiplayerColors`, { ZD: { mpAllowedColors: actualColors } });
  const actual = getColors.call({ colors: available });
  assert.equal(actual.size, 16); assert.equal(new Set([...actual.values()].map(color => color.asHex())).size, 16);
  return { rulesPath, colors: actual.size };
}, { skip: !rulesPath && 'Set RA2_CLIENT_RULES when checking an isolated /tmp bundle' });

check('Actual base36 Topic serializer and parser agree for16 and17 participants', () => {
  const globals = { Ub: class { encode(value) { return value; } decode(value) { return value; } }, aS: { encode: value => value }, UA: value => value, zl: { MAX_ROOM_DESC_LEN: 128 }, Ci: { escapeChannelName: value => value }, Cf: value => value, gd: { decode: value => value } };
  const send = run(`({${method('zl', 'sendGameTopic')}}).sendGameTopic`, globals);
  const parse = run(`({${method('dc', 'parseTopic')}}).parseTopic`, globals);
  let combinations = 0, example;
  for (let humans = 0; humans <= 17; humans++) for (let slots = 2; slots <= 17; slots++) {
    let topic;
    send.call({ currentGameChannel: '#audit', con: { sendMessage: line => { topic = line.split(' :')[1]; } } }, humans, slots, 0, 0, true, 'wl_vm.map', 0, '', '');
    assert.equal(parse(topic).maxPlayers, slots);
    if (humans === 16 && slots === 17) { assert.ok(topic.startsWith('gghN39,')); example = topic; }
    combinations++;
  }
  return { combinations, example };
});

check('Native DataStream/turn-action serialization preserves17 different IDs', () => {
  const Stream = run(`var Ve; (${raw(declarations.get('pt').init)})`);
  const Serializer = run(`(class Zg {${['serializePlayerActions', 'serializeAllPlayerActions'].map(name => method('Zg', name)).join('')} static MAX_ACTION_PAYLOAD_SIZE=65536})`, { jTe: Stream });
  const Parser = run(`(class {${['parsePlayerActions', 'parseAllPlayerActions'].map(name => method('dc', name)).join('')}})`, { EJ: Stream });
  const actions = new Map(Array.from({ length: 17 }, (_, index) => [index, [{ id: 11, params: new Uint8Array([index, 1]) }]]));
  const stream = new Stream(); new Serializer().serializeAllPlayerActions(stream, actions);
  const parsed = new Parser().parseAllPlayerActions(new Stream(stream.toUint8Array()));
  assert.equal(parsed.size, 17);
  for (let index = 0; index < 17; index++) assert.deepEqual([...parsed.get(index)[0].params], [index, 1]);
  return { participants: 17, highestId: 16 };
});

const protocolSlot = binding('qt'), occupation = binding('Mn');
function lobbyFixture(observerSlotIndex) {
  const calls = [], slotsInfo = Array.from({ length: 17 }, (_, index) => ({ type: index === observerSlotIndex ? protocolSlot.OpenObserver : protocolSlot.Open }));
  const lobby = { hostMode: true, observerSlotIndex, slotsInfo, gameOpts: { gameMode: 0, aiPlayers: new Array(16).fill(undefined) }, preferredHostOpts: { slotsClosed: new Set(), serialize: () => '' },
    getPlayerSlot: () => ({ occupation: occupation.Open }), gameModes: { getById: () => ({ mpDialogSettings: { mustAlly: false } }) }, localPrefs: { setItem: () => calls.push('persist') } };
  for (const name of ['updateFormModel', 'sendGameSlotInfo', 'sendGameOpts', 'sendModeMaxSlots', 'onHostLobbyRoomActivity']) lobby[name] = () => calls.push(name);
  return { lobby, calls };
}
const changeSlot = run(`({${method('sg', 'changeSlotType')}}).changeSlotType`, { ke: { SlotType: protocolSlot }, es: { SlotOccupation: occupation }, fe: { RANDOM_COUNTRY_ID: -2, RANDOM_COLOR_ID: -2, RANDOM_START_POS: -2, NO_TEAM_ID: -2 }, qs: { StorageKey: { PreferredGameOpts: 'PreferredGameOpts' } } });

check('Dedicated observer row16 and observer-host row0 reject AI conversion', () => {
  for (const observer of [0, 16]) for (const difficulty of [0, 1, 2]) {
    const { lobby, calls } = lobbyFixture(observer), before = plain(lobby.slotsInfo);
    changeSlot.call(lobby, occupation.Occupied, observer, difficulty);
    assert.deepEqual(plain(lobby.slotsInfo), before); assert.equal(lobby.gameOpts.aiPlayers.filter(Boolean).length, 0);
    assert.equal(calls.length, 0);
  }
  return { blockedObserverIndices: [0, 16], difficulties: [0, 1, 2] };
});

check('Ordinary row15 and host-observer row16 still accept valid AI', () => {
  for (const [observer, slot] of [[16, 15], [0, 16]]) {
    const { lobby, calls } = lobbyFixture(observer);
    changeSlot.call(lobby, occupation.Occupied, slot, 0);
    assert.equal(lobby.slotsInfo[slot].type, protocolSlot.Ai);
    assert.equal(lobby.gameOpts.aiPlayers[slot].difficulty, 0);
    assert.ok(calls.includes('sendGameOpts'));
    if (slot === 16) assert.equal(lobby.gameOpts.aiPlayers.length, 17, 'slot-indexed AI array grows for observer host');
  }
  return { acceptedCombatantIndices: [15, 16] };
});

// Exercise the actual wire-message dispatcher, rather than calling its
// numeric observer handler directly: O16 used to be truncated to R[1] === '1'.
const observerDispatchers = [];
walk.simple(tree, { AssignmentExpression(node) {
  if (node.left.type === 'MemberExpression' && node.left.property.name === 'handleGameOpt'
      && raw(node.right).includes('handleGameOptObserver')) observerDispatchers.push(node.right);
} });
assert.equal(observerDispatchers.length, 1);
const bindGameOpt = run(`(function(controller){return(function(){return(${raw(observerDispatchers[0])})}).call(controller)})`);
const observerHandler = run(`({${uniqueMethod('handleGameOptObserver')}}).handleGameOptObserver`);
const sendObserver = run(`({${uniqueMethod('sendObserverSlot')}}).sendObserverSlot`);
function observerMessage(index) {
  let message;
  sendObserver.call({ currentGameChannel: '#audit', gameOpt: (target, opt) => { message = {target, opt, user: 'Host'}; } }, index);
  return message;
}
const uiEnums = { SlotType: binding('Xl'), SlotOccupation: occupation, PlayerStatus: binding('fh'), LobbyType: binding('ho') };
const updateGuestForm = run(`({${method('sg', 'updateFormModel')}}).updateFormModel`, {
  ke: { SlotType: protocolSlot }, es: uiEnums, ei: () => false,
  fe: { RANDOM_COUNTRY_NAME: 'Random', RANDOM_COLOR_NAME: '', RANDOM_START_POS: -2, NO_TEAM_ID: -2, OBS_COUNTRY_NAME: 'Observer' },
});
function guestFixture(capacity = 4) {
  const lobby = {
    hostMode: false, gameChannelName: '#audit', hostPlayerName: 'Host', observerSlotIndex: 16,
    slotsInfo: Array.from({length: 17}, (_, index) => ({type: index === 0 || index === 1 ? protocolSlot.Player : index === 16 ? protocolSlot.OpenObserver : protocolSlot.Open, name: index === 0 ? 'Host' : index === 1 ? 'Guest' : undefined})),
    gameOpts: {maxSlots: capacity, gameMode: 1, humanPlayers: [
      {name: 'Host', countryId: 0, colorId: 0, startPos: 0, teamId: 0},
      {name: 'Guest', countryId: 1, colorId: 1, startPos: 1, teamId: 1},
    ], aiPlayers: []},
    formModel: {playerSlots: [], lobbyType: uiEnums.LobbyType.MultiplayerGuest},
    playerReadyStatus: new Map(), playerProfiles: new Map(), playerPings: [], specialMissionLock: false,
    wolCon: {getCurrentUser: () => 'Guest'}, gameModes: {getById: () => ({mpDialogSettings: {alliesAllowed: true, mustAlly: false}})},
    getCountryNameById: id => 'Country' + id, getColorNameById: id => 'Color' + id,
    getSelectablePlayerColors: () => ['Color0', 'Color1'], getSelectableStartPositions: () => Array.from({length: capacity}, (_, i) => i),
    handleGameOptObserver: observerHandler, updateFormModel: updateGuestForm,
  };
  lobby.handleGameOpt = bindGameOpt(lobby);
  lobby.handleGameOpt(observerMessage(16));
  return lobby;
}
const renderGuestRow = run(`({${uniqueMethod('renderPlayerSlot')}}).renderPlayerSlot`, {
  ae: {default: {createElement: (type, props, ...children) => ({type, props, children}), Fragment: 'fragment'}},
  wt: uiEnums, MP: {NO_TEAM_ID: -2}, AP: {RankIndicator: 'RankIndicator'}, Lne: {PingIndicator: 'PingIndicator'},
  Bne: {CountrySelect: 'country'}, Nne: {ColorSelect: 'color'}, Dne: {StartPosSelect: 'start'}, Fne: {TeamSelect: 'team'},
});
function rowControls(lobby, index) {
  const props = {...lobby.formModel, strings: {get: key => key}};
  const row = renderGuestRow.call({renderPlayerSelect: () => null, renderPlayerStatus: () => null}, props, props.playerSlots[index], index);
  const controls = {};
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['country','color','start','team'].includes(node.type)) controls[node.type] = node.props;
    node.children?.forEach(visit);
  }
  visit(row); return controls;
}

check('Native observer serializer and guest dispatcher preserve every decimal index0..16', () => {
  for (let index = 0; index <= 16; index++) {
    const controller = {hostMode: false, gameChannelName: '#audit', handleGameOptObserver: observerHandler, updateFormModel() {}};
    bindGameOpt(controller)(observerMessage(index));
    assert.equal(controller.observerSlotIndex, index, observerMessage(index).opt);
  }
  return {observerIndices: 17};
});

check('Wire O16 leaves the second player editable on ordinary and extended maps', () => {
  for (const capacity of [2, 4, 8, 16]) {
    const lobby = guestFixture(capacity), controls = rowControls(lobby, 1);
    assert.equal(lobby.formModel.activeSlotIndex, 1);
    assert.equal(lobby.formModel.playerSlots[1].type, uiEnums.SlotType.Player);
    assert.equal(lobby.formModel.playerSlots[16].type, uiEnums.SlotType.Observer);
    for (const name of ['country','color','start','team']) {
      assert.ok(controls[name], `capacity ${capacity}: own ${name} selector exists`);
      assert.equal(!!controls[name].disabled, false, `capacity ${capacity}: own ${name} enabled`);
    }
  }
});

check('Guest ownership, readiness, and host-team restrictions remain enforced', () => {
  const lobby = guestFixture();
  for (const control of Object.values(rowControls(lobby, 0))) assert.equal(!!control.disabled, true, 'another human stays read-only');
  assert.deepEqual(Object.keys(rowControls(lobby, 16)), ['country'], 'actual observer keeps the observer UI');
  lobby.playerReadyStatus.set('Guest', true); lobby.updateFormModel();
  for (const control of Object.values(rowControls(lobby, 1))) assert.equal(!!control.disabled, true, 'ready still locks choices');
  lobby.playerReadyStatus.set('Guest', false); lobby.gameOpts.hostTeams = true; lobby.updateFormModel();
  const controls = rowControls(lobby, 1);
  assert.equal(!!controls.country.disabled, false); assert.equal(!!controls.color.disabled, false);
  assert.equal(!!controls.start.disabled, true); assert.equal(!!controls.team.disabled, true);
});

after(() => {
  const output = process.env.RA2_CLIENT_PROOF || path.resolve(__dirname, 'proof/player16-20261112/client-vm-results.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ bundle: path.resolve(bundle), sha256: crypto.createHash('sha256').update(source).digest('hex'), createdAt: new Date().toISOString(), scope: 'actual patched source functions in VM; no browser render/full simulation claim; event/transport encoders unrelated to capacity are inert doubles', results }, null, 2) + '\n');
  console.log(`Client VM evidence: ${output}; ${results.filter(result => result.status === 'pass').length} passed, ${results.filter(result => result.status === 'fail').length} failed, ${results.filter(result => result.status === 'skip').length} skipped.`);
});
