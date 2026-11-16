/** Run: node --test deploy/ra2web-lan/map-library/native-trigger-check.test.mjs */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectTriggers, nativeTriggerCapabilities } from './native-trigger-check.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const proof = {
  schema: 1, generatedAt: new Date().toISOString(), command: 'node --test deploy/ra2web-lan/map-library/native-trigger-check.test.mjs',
  checker: { path: 'deploy/ra2web-lan/map-library/native-trigger-check.mjs', sha256: sha256(readFileSync(new URL('./native-trigger-check.mjs', import.meta.url))) },
  tests: { passed: [], failed: [] }, capabilities: nativeTriggerCapabilities(),
  scope: 'Read-only native Tags/Triggers/Actions/Events/CellTags/VariableNames parsing and exact executor/condition factory registration in the installed release. Not a complete gameplay or asset-parameter verification.',
  policy: [
    'Unknown enum values and known enum values without a factory handler are separate rejection categories.',
    'cpe and Wf executors require campaign-only scenarioTeamRuntime; those actions are rejected for the multiplayer catalog.',
    'Active TeamTypes and AITriggerTypes remain archive-only; unused script/task-force templates require the exact native reader and no outside reference.',
    'AITriggerTypesEnable without definitions is accepted only when every flag is yes/true/1; source confirms these all-true default flags have no effect.',
    'No original map bytes or scripts are modified by these checks.',
  ],
};
function check(name, fn) {
  test(name, () => {
    try { fn(); proof.tests.passed.push(name); }
    catch (error) { proof.tests.failed.push({ name, error: error.message }); throw error; }
  });
}

function fixture(action = 99, event = 13, extra = '') {
  return `[Basic]\nNewINIFormat=4\n[Tags]\nT0=0,Test tag,R0\n[Triggers]\nR0=Neutral,<none>,Test trigger,0,1,1,1,0\n[Events]\nR0=1,${event},0,100\n[Actions]\nR0=1,${action},0,0,0,0,0,0,A\n[Waypoints]\n0=64064\n${extra}`;
}

check('common native sound and elapsed-time triggers parse with their actual registered handlers', () => {
  const input = fixture(), original = sha256(input), result = inspectTriggers(input);
  assert.equal(result.supported, true); assert.deepEqual(result.reasons, []);
  assert.equal(result.stats.triggers, 1); assert.equal(result.stats.tags, 1); assert.equal(result.stats.actions, 1); assert.equal(result.stats.events, 1);
  assert.ok(result.actionHandlers.some(handler => handler.type === 99 && handler.name === 'PlaySoundFxAt' && handler.constructor === 'a9.PlaySoundFxAtExecutor'));
  assert.ok(result.eventHandlers.some(handler => handler.type === 13 && handler.name === 'ElapsedTime' && handler.constructor === 'B6.ElapsedTimeCondition'));
  assert.equal(sha256(input), original);
  assert.equal(proof.capabilities.registeredActionCount, 103); assert.equal(proof.capabilities.registeredEventCount, 56);
});

check('known enum values without handlers are rejected separately from parser-unknown types', () => {
  const knownAction = inspectTriggers(fixture(145));
  assert.equal(knownAction.supported, false); assert.deepEqual(knownAction.unknownActionTypes, []);
  assert.deepEqual(knownAction.unimplementedActionTypes, [145]);
  const knownEvent = inspectTriggers(fixture(99, 58));
  assert.equal(knownEvent.supported, false); assert.deepEqual(knownEvent.unknownEventTypes, []);
  assert.deepEqual(knownEvent.unimplementedEventTypes, [58]);
  const unknownAction = inspectTriggers(fixture(506));
  assert.equal(unknownAction.supported, false); assert.deepEqual(unknownAction.unknownActionTypes, [506]);
  const unknownEvent = inspectTriggers(fixture(99, 602));
  assert.equal(unknownEvent.supported, false); assert.deepEqual(unknownEvent.unknownEventTypes, [602]);
});

check('campaign-only delegated executors and scenario definitions remain excluded', () => {
  const team = inspectTriggers(fixture(4));
  assert.equal(team.supported, false); assert.deepEqual(team.unimplementedActionTypes, []);
  assert.deepEqual(team.unsupportedMultiplayerActionTypes, [4]);
  const delegated = inspectTriggers(fixture(3));
  assert.equal(delegated.supported, false); assert.deepEqual(delegated.unsupportedMultiplayerActionTypes, [3]);
  for (const name of ['TeamTypes', 'AITriggerTypes']) {
    const result = inspectTriggers(fixture(99, 13, `[${name}]\n0=DynamicId\n[DynamicId]\nName=Unverified definition\n`));
    assert.equal(result.supported, false); assert.ok(result.unsupportedSections.includes(name));
    assert.ok(!result.handledSections.includes('DynamicId'));
  }
});

check('orphan script/task-force templates use the native reader while active or referenced definitions remain excluded',()=>{
  const definitions='[ScriptTypes]\n0=OrphanScript\n[OrphanScript]\nName=Unused editor default\n0=0,1\n1=11,5\n[TaskForces]\n0=OrphanForce\n[OrphanForce]\n0=2,E1\n';
  const orphan=inspectTriggers(fixture(99,13,definitions));
  assert.equal(orphan.supported,true,JSON.stringify(orphan.reasons));
  for(const name of ['ScriptTypes','TaskForces','ORPHANSCRIPT','ORPHANFORCE'])assert.ok(orphan.handledSections.includes(name),name);
  assert.equal(inspectTriggers(fixture(99,13,definitions+'[TeamTypes]\n0=ActiveTeam\n[ActiveTeam]\nScript=OrphanScript\nTaskForce=OrphanForce\n')).supported,false);
  assert.equal(inspectTriggers(fixture(99,13,definitions+'[General]\nUnknownExtension=OrphanForce\n')).supported,false);
  assert.equal(inspectTriggers(fixture(4,13,definitions)).supported,false);
});

check('all-true orphan AI enable defaults are harmless, while explicit false flags stay unverified', () => {
  const harmless = inspectTriggers(fixture(99, 13, '[AITriggerTypesEnable]\nDefaultA=yes\nDefaultB=true\nDefaultC=1\n'));
  assert.equal(harmless.supported, true); assert.equal(harmless.harmlessAiEnableDefaults, true);
  assert.ok(harmless.handledSections.includes('AITriggerTypesEnable'));
  const disabled = inspectTriggers(fixture(99, 13, '[AITriggerTypesEnable]\nDefaultA=no\n'));
  assert.equal(disabled.supported, false); assert.ok(disabled.unsupportedSections.includes('AITriggerTypesEnable'));
  const definition = inspectTriggers(fixture(99, 13, '[AITriggerTypes]\nDefaultA=custom\n[AITriggerTypesEnable]\nDefaultA=yes\n'));
  assert.equal(definition.supported, false); assert.equal(definition.harmlessAiEnableDefaults, false);
});

check('malformed tags, lists, references, variables and attached cycles fail closed', () => {
  assert.equal(inspectTriggers(fixture().replace('T0=0,', 'T0=9,')).supported, false);
  assert.equal(inspectTriggers(fixture().replace('R0=1,99,0,0,0,0,0,0,A', 'R0=2,99,0')).supported, false);
  assert.equal(inspectTriggers(fixture() + '[CellTags]\n64064=MissingTag\n').supported, false);
  assert.equal(inspectTriggers(fixture() + '[VariableNames]\nInvalidNumber=Value,0\n').supported, false);
  assert.equal(inspectTriggers(fixture().replace('R0=Neutral,<none>', 'R0=Neutral,MissingAttached')).supported, false);
  const cycle = fixture().replace('R0=Neutral,<none>', 'R0=Neutral,C0') + '[Triggers]\nC0=Neutral,C1,Cycle A,0,1,1,1,0\nC1=Neutral,C0,Cycle B,0,1,1,1,0\n';
  const before = Date.now(), result = inspectTriggers(cycle);
  assert.equal(result.supported, false); assert.ok(result.parseErrors.some(error => /timed out/.test(error)));
  assert.ok(Date.now() - before < 1500, 'Native parser cycles must be bounded');
  assert.equal(inspectTriggers('[Triggers]\nR0=broken\n', 'invalid app source').supported, false);
});

check('real ordinary multiplayer maps retain their complete supported environmental triggers', () => {
  proof.realFixtures = [];
  for (const name of ['2_impasse.map', '2_across_the_frost.map']) {
    const path = `vendor/platform-maps-20261112/cncnet-yr-client-package/package/Maps/Yuri's Revenge/${name}`;
    const bytes = readFileSync(root + path), result = inspectTriggers(bytes.toString('utf8'));
    assert.equal(result.supported, true, JSON.stringify(result.reasons));
    assert.ok(result.stats.triggers > 0 && result.stats.actions > 0 && result.stats.events > 0);
    proof.realFixtures.push({ path, sha256: sha256(bytes), stats: result.stats, handledSections: result.handledSections, supported: result.supported });
  }
});

check('all 594 original map inputs receive explicit native trigger results without changing their bytes', () => {
  const reportPath = 'vendor/platform-map-library-20261112/compatibility-report.json';
  const scans = JSON.parse(readFileSync(root + reportPath, 'utf8')).scans;
  assert.equal(scans.length, 594);
  const results = [], summary = { total: 0, supported: 0, scriptedMapsSupported: 0, scriptedMaps: 0,
    unknownActionTypes: {}, unknownEventTypes: {}, unimplementedActionTypes: {}, unimplementedEventTypes: {}, campaignOnlyActionTypes: {},
    unsupportedSections: {}, parseErrorMaps: 0, harmlessAiEnableDefaults: 0, commonActionTypes: {}, commonEventTypes: {} };
  const count = (object, values) => { for (const value of values) object[value] = (object[value] ?? 0) + 1; };
  for (const row of scans) {
    const path = 'vendor/platform-maps-20261112/' + row.sourcePath, bytes = readFileSync(root + path), original = sha256(bytes);
    const result = inspectTriggers(bytes.toString('utf8'));
    assert.equal(sha256(bytes), original);
    if (row.sha256) assert.equal(original, row.sha256, row.sourcePath);
    summary.total++; if (result.supported) summary.supported++;
    const containsScript = Object.values(row.scriptedSections ?? {}).some(count => count > 0);
    if (containsScript) { summary.scriptedMaps++; if (result.supported) summary.scriptedMapsSupported++; }
    count(summary.unknownActionTypes, result.unknownActionTypes); count(summary.unknownEventTypes, result.unknownEventTypes);
    count(summary.unimplementedActionTypes, result.unimplementedActionTypes); count(summary.unimplementedEventTypes, result.unimplementedEventTypes);
    count(summary.campaignOnlyActionTypes, result.unsupportedMultiplayerActionTypes); count(summary.unsupportedSections, result.unsupportedSections);
    count(summary.commonActionTypes, result.stats?.actionTypes ?? []); count(summary.commonEventTypes, result.stats?.eventTypes ?? []);
    if (result.parseErrors.length) summary.parseErrorMaps++;
    if (result.harmlessAiEnableDefaults) summary.harmlessAiEnableDefaults++;
    results.push({ sourcePath: row.sourcePath, sha256: original, supported: result.supported, reasons: result.reasons, stats: result.stats,
      unknownActionTypes: result.unknownActionTypes, unknownEventTypes: result.unknownEventTypes,
      unimplementedActionTypes: result.unimplementedActionTypes, unimplementedEventTypes: result.unimplementedEventTypes,
      unsupportedMultiplayerActionTypes: result.unsupportedMultiplayerActionTypes, unsupportedSections: result.unsupportedSections,
      parseErrors: result.parseErrors, harmlessAiEnableDefaults: result.harmlessAiEnableDefaults });
  }
  assert.ok(summary.scriptedMapsSupported > 200, 'A blanket script ban should be replaced by real supported trigger checks');
  proof.census = { summary, maps: results };
});

after(() => {
  proof.status = proof.tests.failed.length ? 'failed' : 'passed';
  writeFileSync(new URL('./native-trigger-proof.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n');
});
