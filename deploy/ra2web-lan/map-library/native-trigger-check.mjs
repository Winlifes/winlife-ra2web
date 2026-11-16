/**
 * Read-only trigger compatibility checker for the exact shipped LAN client.
 *
 * Runs its original nA/Ni/fs INI parser, ATe TagReader, PTe TriggerReader and
 * MapFile.readTagsAndTriggers method in a bounded VM. Parser enum recognition
 * is checked separately from actual TriggerExecutorFactory / ConditionFactory
 * registrations; a known but unimplemented enum value is NOT compatible.
 * No map text, script, object, rule or trigger is rewritten by this module.
 *
 * inspectTriggers(mapText, appSource?) is synchronous. The optional second
 * argument may be app.js source text or {appSource}; unrelated source-map
 * metadata objects are accepted and use the installed default client.
 *
 * This is a Node build-time checker, not a browser dependency. Active scenario
 * teams and AI trigger definitions remain unverified. Orphan script/task-force
 * templates are parsed with the original reader and accepted only when no
 * team/AI trigger or external reference can activate them. Resource/object compatibility
 * and complete gameplay validation belong to the map catalog / runtime tests.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const DEFAULT_APP = new URL('../../../vendor/ra2web-lan-0.87.3-20261112-net2-r1/js/app.js', import.meta.url);
const HANDLED = ['Tags', 'Triggers', 'Actions', 'Events', 'CellTags', 'VariableNames'];
const UNVERIFIED = ['TaskForces', 'ScriptTypes', 'TeamTypes', 'AITriggerTypes', 'AITriggerTypesEnable'];
const cache = new Map();
let defaultApp;
let recent;
const hash = text => createHash('sha256').update(text).digest('hex');

function slice(source, start, end) {
  const from = source.indexOf(start), until = source.indexOf(end, from + start.length);
  if (from < 0 || until < 0) throw new Error(`Native trigger source signature missing: ${start}`);
  return source.slice(from, until);
}
function enumCode(source, name) {
  const start = source.indexOf(`var ${name}=`), end = source.indexOf(';', start);
  if (start < 0 || end < 0 || end - start > 20000) throw new Error(`Native enum missing: ${name}`);
  return source.slice(start, end + 1);
}
function factory(source, start, end, enumName) {
  const code = slice(source, start, end);
  if (!code.includes('default:throw new Error(')) throw new Error(`Native factory has no rejecting default: ${start}`);
  const handlers = new Map();
  // Consecutive case labels share the next concrete return/new expression.
  for (const match of code.matchAll(/((?:case [A-Za-z0-9_$]+\.Trigger(?:Action|Event)Type\.[A-Za-z0-9_$]+:)+)return new ([A-Za-z0-9_$.]+)\(/g)) {
    for (const label of match[1].matchAll(/\.Trigger(?:Action|Event)Type\.([A-Za-z0-9_$]+):/g)) {
      if (enumName[label[1]] === undefined) throw new Error(`Factory case has unknown enum ${label[1]}`);
      handlers.set(enumName[label[1]], { name: label[1], constructor: match[2] });
    }
  }
  const cases = [...code.matchAll(/case [A-Za-z0-9_$]+\.Trigger(?:Action|Event)Type\.([A-Za-z0-9_$]+):/g)];
  if (cases.length !== handlers.size) {
    // Duplicate aliases are not present in the installed factory. Fail closed
    // if an upgrade changes its structure instead of inferring a numeric range.
    throw new Error(`Cannot account for all native factory cases: ${start}`);
  }
  return { handlers, code, sha256: hash(code) };
}

function compile(appSource) {
  if (recent?.source === appSource) return recent.native;
  const sha256 = hash(appSource);
  if (cache.has(sha256)) { const native = cache.get(sha256); recent = { source: appSource, native }; return native; }
  const warnings = [];
  const context = vm.createContext({ console: { warn: (...args) => { if (warnings.length < 512) warnings.push(args.join(' ')); } } }, { codeGeneration: { strings: false, wasm: false } });
  const enums = [enumCode(appSource, 'rO'), enumCode(appSource, 'si'), enumCode(appSource, 'ii')].join('\n');
  const tagReader = slice(appSource, 'class ATe{', 'const Gr=N;');
  const mapMethod = slice(appSource, 'readTagsAndTriggers(){', 'readCellTags(');
  const cellAndVariableMethods = slice(appSource, 'readCellTags(e){', 'readScenarioTeams(){');
  const cellReader = slice(appSource, 'class MTe{', 'class ATe{');
  const variableClass = slice(appSource, 'class Jv{', 'const mme=');
  const scenarioMethods = slice(appSource, 'readScenarioTeams(){', 'readTiles(){');
  const scenarioEnums = enumCode(appSource,'lr');
  if(!scenarioEnums.includes('He='))throw new Error('Native scenario script enum changed');
  const unloadPolicy=slice(appSource,'function Dj(s){','function Xme(');
  const iniCode = slice(appSource, 'class Ni{', 'var Ve;') + '\n' + slice(appSource, 'class fs{', 'const oX=');
  const program = [
    'class aX{};', enums, scenarioEnums, unloadPolicy, iniCode, cellReader, tagReader, variableClass,
    `class NativeTriggerMap extends fs { ${mapMethod} ${cellAndVariableMethods} ${scenarioMethods} }`,
    'globalThis.nativeEnums={actions:si,events:ii,tags:rO};',
    `globalThis.runNative=function(text){
      const map=new NativeTriggerMap(text);
      map.readTagsAndTriggers();
      map.readCellTags(map.getSection('Basic')?.getNumber('NewINIFormat')??4);
      map.readVariableNames();
      const sections={};
      for(const section of map.getOrderedSections()) sections[section.name]=Array.from(section.entries);
      const reader=new PTe();
      const parsedActions=reader.readActions(map.getOrCreateSection('Actions')).actions;
      const parsedEvents=reader.readEvents(map.getOrCreateSection('Events')).events;
      let orphanScenarioParse=null;
      if(!map.getSection('TeamTypes')?.entries.size&&!map.getSection('AITriggerTypes')?.entries.size){
        map.scenarioScripts=new Map();map.scenarioTaskForces=new Map();map.scenarioTeams=new Map();map.scenarioAiTriggers=new Map();
        map.readScenarioTeams();
        orphanScenarioParse={scripts:[...map.scenarioScripts],taskForces:[...map.scenarioTaskForces],teams:map.scenarioTeams.size,aiTriggers:map.scenarioAiTriggers.size};
      }
      return {tags:map.tags,triggers:map.triggers,cellTags:map.cellTags,variables:[...map.variables],unknownActionTypes:[...map.unknownActionTypes],unknownEventTypes:[...map.unknownEventTypes],
        parsedActions:Array.from(parsedActions),parsedEvents:Array.from(parsedEvents),sections,orphanScenarioParse};
    };`,
  ].join('\n');
  vm.runInContext(program, context, { timeout: 1000 });
  const actionFactory = factory(appSource, 'UF=class{create(s,e){', ';const xpe=', context.nativeEnums.actions);
  const eventFactory = factory(appSource, 'p6=class{create(s,e){', ';const gme=', context.nativeEnums.events);
  // The shared action executor delegates to real scenario methods, so verify
  // its own exact switch covers every action its factory routes to that class.
  const delegated = slice(appSource, 'class cpe extends Ae{', 'class ');
  const teamExecutor = slice(appSource, 'class Wf extends Ae{', 'class cpe extends Ae{');
  const scenarioRuntimeCreation = 'return de.scenarioTeamRuntime=new JPe(de,F),de.traits.add(de.scenarioTeamRuntime),de}const Ps=EM.factory';
  if (!appSource.includes(scenarioRuntimeCreation) || !delegated.includes('const t=e.scenarioTeamRuntime;if(!t)return;') || !teamExecutor.includes('const i=e.scenarioTeamRuntime;if(i)')) {
    throw new Error('Native multiplayer scenario executor behavior changed; re-audit is required');
  }
  const scenarioReader = slice(appSource, 'readScenarioTeams(){', 'readListedSectionIds(e){');
  if (!scenarioReader.includes('const e=this.getSection("AITriggerTypes"),t=this.getSection("AITriggerTypesEnable");for(const[i,r]of e?.entries??[])')) {
    throw new Error('Native AI enable-only behavior changed; re-audit is required');
  }
  const delegatedNames = new Set([...delegated.matchAll(/case si\.([A-Za-z0-9_$]+):/g)].map(match => match[1]));
  for (const handler of actionFactory.handlers.values()) if (handler.constructor === 'cpe' && !delegatedNames.has(handler.name)) {
    throw new Error(`Delegated action has no native executor case: ${handler.name}`);
  }
  const compiled = { context, warnings, enums: context.nativeEnums, actionFactory, eventFactory,
    evidence: { appSha256: sha256, parserSha256: hash(tagReader), mapMethodSha256: hash(mapMethod), iniParserSha256: hash(iniCode), cellAndVariableReaderSha256: hash(cellReader + variableClass + cellAndVariableMethods),
      actionFactorySha256: actionFactory.sha256, eventFactorySha256: eventFactory.sha256,
      registeredActionCount: actionFactory.handlers.size, registeredEventCount: eventFactory.handlers.size,
      delegatedActionSha256: hash(delegated), teamExecutorSha256: hash(teamExecutor), scenarioReaderSha256: hash(scenarioReader),
      scenarioRuntimeCreationSha256: hash(scenarioRuntimeCreation), scenarioMethodsSha256:hash(scenarioMethods+scenarioEnums+unloadPolicy) } };
  // Callers generally scan one build. Bound memory if several versions are
  // compared in the same long-lived process.
  if (cache.size >= 4) cache.delete(cache.keys().next().value);
  cache.set(sha256, compiled); recent = { source: appSource, native: compiled }; return compiled;
}

function section(data, name) { return new Map(data.sections[name] ?? []); }
function numericTypes(groups) { return [...new Set(groups.flatMap(([, entries]) => entries.map(entry => entry.type)))].sort((a, b) => a - b); }
function orphanScenarioSections(data,unsupportedActions) {
  if(!data.orphanScenarioParse||unsupportedActions.length)return [];
  const tables=['TaskForces','ScriptTypes'],ids=new Set(tables.flatMap(name=>[...section(data,name).values()].map(id=>id.toUpperCase())));
  if(!ids.size)return [];
  const group=new Set([...tables.map(name=>name.toUpperCase()),...ids]);
  // Even an unimplemented/other map field referencing a definition keeps it
  // excluded. Never infer that an active team can be safely removed.
  for(const[name,entries]of Object.entries(data.sections))if(!group.has(name.toUpperCase()))for(const[,raw]of entries){
    if((String(raw).toUpperCase().match(/[A-Z0-9_-]+/g)||[]).some(token=>ids.has(token)))return [];
  }
  return [...tables.filter(name=>section(data,name).size),...ids];
}
function validateRecords(data) {
  const errors = [];
  for (const [id, raw] of section(data, 'Tags')) {
    const fields = raw.split(',');
    if (fields.length < 3 || ![0, 1, 2].includes(Number(fields[0]))) errors.push(`Malformed tag ${id}`);
  }
  const triggers = section(data, 'Triggers');
  for (const [id, raw] of triggers) if (raw.split(',').length < 8) errors.push(`Malformed trigger ${id}`);
  for (const [id, raw] of section(data, 'Actions')) {
    const fields = raw.split(','), count = Number(fields.shift());
    if (!Number.isInteger(count) || count < 0 || fields.length < count * 8) errors.push(`Malformed action list ${id}`);
    else if (count > 0 && !triggers.has(id)) errors.push(`Actions refer to missing trigger ${id}`);
  }
  for (const [id, raw] of section(data, 'Events')) {
    const fields = raw.split(','), count = Number(fields.shift());
    let offset = 0;
    if (!Number.isInteger(count) || count < 0) { errors.push(`Malformed event list ${id}`); continue; }
    for (let i = 0; i < count; i++) {
      if (offset + 3 > fields.length) { errors.push(`Malformed event list ${id}`); break; }
      const argumentType = Number(fields[offset + 1]);
      offset += argumentType === 2 ? 4 : 3;
      if (offset > fields.length) { errors.push(`Malformed event list ${id}`); break; }
    }
    if (count > 0 && !triggers.has(id)) errors.push(`Events refer to missing trigger ${id}`);
  }
  const tagIds = new Set(data.tags.map(tag => tag.id));
  for (const tag of data.tags) if (!triggers.has(tag.triggerId)) errors.push(`Tag ${tag.id} refers to missing trigger ${tag.triggerId}`);
  for (const [coordinate, tag] of section(data, 'CellTags')) if (!tagIds.has(tag)) errors.push(`CellTag ${coordinate} refers to missing tag ${tag}`);
  for (const cellTag of data.cellTags) if (!Number.isInteger(cellTag.coords.x) || !Number.isInteger(cellTag.coords.y) || cellTag.coords.x < 0 || cellTag.coords.x > 511 || cellTag.coords.y < 0 || cellTag.coords.y > 511) errors.push(`Malformed CellTag coordinates (${cellTag.coords.x},${cellTag.coords.y})`);
  for (const id of section(data, 'VariableNames').keys()) if (!Number.isFinite(Number(id))) errors.push(`Malformed VariableNames id ${id}`);
  // Native linked-trigger assignment loops until the attached chain ends.
  // Cycles are rejected by the bounded VM before this check can run.
  for (const trigger of data.triggers) if (trigger.attachedTriggerId && !triggers.has(trigger.attachedTriggerId)) errors.push(`Trigger ${trigger.id} refers to missing attached trigger ${trigger.attachedTriggerId}`);
  const attached = new Map(data.triggers.map(trigger => [trigger.id, trigger.attachedTriggerId]));
  for (const trigger of data.triggers) {
    const visited = new Set(); let id = trigger.id;
    while (id) {
      if (visited.has(id)) { errors.push(`Attached trigger cycle at ${id}`); break; }
      visited.add(id); id = attached.get(id);
    }
  }
  return [...new Set(errors)];
}

/** Inspect original text; supported is scoped to triggers, not all map rules. */
export function inspectTriggers(rawMapText, appSourceOrOptions) {
  if (typeof rawMapText !== 'string') return failure('Map input must be INI text');
  const appSource = typeof appSourceOrOptions === 'string' ? appSourceOrOptions : appSourceOrOptions?.appSource ?? (defaultApp ??= readFileSync(DEFAULT_APP, 'utf8'));
  let native;
  try { native = compile(appSource); }
  catch (error) { return failure(`Native checker initialization failed: ${error.message}`); }
  native.warnings.length = 0;
  let data;
  try {
    native.context.inputMapText = rawMapText;
    // VM timeout also covers malformed attached-trigger cycles and unreasonable
    // declared action/event counts. It does not evaluate map text as code.
    data = vm.runInContext('runNative(inputMapText)', native.context, { timeout: 300 });
  } catch (error) { return failure(`Native trigger parser failed: ${error.message}`, native.evidence); }
  finally { delete native.context.inputMapText; }
  const parseErrors = validateRecords(data);
  const actionTypes = numericTypes(data.parsedActions), eventTypes = numericTypes(data.parsedEvents);
  const unknownActionTypes = Array.from(data.unknownActionTypes).sort((a, b) => a - b);
  const unknownEventTypes = Array.from(data.unknownEventTypes).sort((a, b) => a - b);
  const unimplementedActionTypes = actionTypes.filter(type => !native.actionFactory.handlers.has(type));
  const unimplementedEventTypes = eventTypes.filter(type => !native.eventFactory.handlers.has(type));
  // These registered executors require scenarioTeamRuntime. The installed
  // factory creates that runtime only on its campaign branch, before returning;
  // ordinary multiplayer proceeds through EM.factory without that runtime.
  const unsupportedMultiplayerActionTypes = actionTypes.filter(type => ['cpe', 'Wf'].includes(native.actionFactory.handlers.get(type)?.constructor));
  const orphanSections=orphanScenarioSections(data,unsupportedMultiplayerActionTypes);
  // FinalAlert commonly emits hundreds of "yes" flags without any map AI
  // definitions. MapFile.readScenarioTeams only iterates AITriggerTypes, so
  // this all-true default listing has no effect and requires no scenario
  // handler. Explicit false flags stay unverified instead of being discarded.
  const enableFlags = section(data, 'AITriggerTypesEnable');
  const harmlessAiEnableDefaults = section(data, 'AITriggerTypes').size === 0 && enableFlags.size > 0 && [...enableFlags.values()].every(value => /^(?:yes|true|1)$/i.test(value));
  const unsupportedSections = UNVERIFIED.filter(name => section(data, name).size > 0 && !orphanSections.includes(name) && !(name === 'AITriggerTypesEnable' && harmlessAiEnableDefaults));
  const reasons = [];
  if (unknownActionTypes.length) reasons.push(`Unknown trigger action types: ${unknownActionTypes.join(', ')}`);
  if (unknownEventTypes.length) reasons.push(`Unknown trigger event types: ${unknownEventTypes.join(', ')}`);
  if (unimplementedActionTypes.length) reasons.push(`Trigger action types without native handlers: ${unimplementedActionTypes.map(type => `${type} (${native.enums.actions[type]})`).join(', ')}`);
  if (unimplementedEventTypes.length) reasons.push(`Trigger event types without native handlers: ${unimplementedEventTypes.map(type => `${type} (${native.enums.events[type]})`).join(', ')}`);
  if (unsupportedMultiplayerActionTypes.length) reasons.push(`Trigger action types require the campaign scenario runtime: ${unsupportedMultiplayerActionTypes.map(type => `${type} (${native.enums.actions[type]})`).join(', ')}`);
  if (unsupportedSections.length) reasons.push(`Unverified scenario sections: ${unsupportedSections.join(', ')}`);
  reasons.push(...parseErrors);
  const scriptedSections = [...HANDLED, ...UNVERIFIED].filter(name => section(data, name).size > 0);
  return {
    hasScripts: scriptedSections.length > 0,
    supported: reasons.length === 0, reasons,
    unknownActionTypes, unknownEventTypes, unknownActions: unknownActionTypes, unknownEvents: unknownEventTypes,
    unimplementedActionTypes, unimplementedEventTypes, unsupportedMultiplayerActionTypes, parseErrors, unsupportedSections,
    handledSections: [...HANDLED.filter(name => section(data, name).size > 0), ...(harmlessAiEnableDefaults ? ['AITriggerTypesEnable'] : []),...orphanSections], scriptedSections,
    harmlessAiEnableDefaults,orphanScenarioSections:orphanSections,
    warnings: [...new Set(native.warnings)],
    stats: { tags: data.tags.length, triggers: data.triggers.length, actions: data.parsedActions.reduce((sum, [, entries]) => sum + entries.length, 0),
      events: data.parsedEvents.reduce((sum, [, entries]) => sum + entries.length, 0), actionTypes, eventTypes },
    actionHandlers: actionTypes.filter(type => native.actionFactory.handlers.has(type)).map(type => ({ type, ...native.actionFactory.handlers.get(type) })),
    eventHandlers: eventTypes.filter(type => native.eventFactory.handlers.has(type)).map(type => ({ type, ...native.eventFactory.handlers.get(type) })),
    evidence: native.evidence,
  };
}

function failure(reason, evidence) {
  return { hasScripts: true, supported: false, reasons: [reason], unknownActionTypes: [], unknownEventTypes: [],
    unknownActions: [], unknownEvents: [], unimplementedActionTypes: [], unimplementedEventTypes: [], unsupportedMultiplayerActionTypes: [], parseErrors: [reason],
    unsupportedSections: [], handledSections: [], scriptedSections: [], warnings: [], evidence };
}

export function nativeTriggerCapabilities(appSource = defaultApp ??= readFileSync(DEFAULT_APP, 'utf8')) {
  const native = compile(appSource);
  return { ...native.evidence,
    actions: [...native.actionFactory.handlers].map(([type, handler]) => ({ type, ...handler })).sort((a, b) => a.type - b.type),
    events: [...native.eventFactory.handlers].map(([type, handler]) => ({ type, ...handler })).sort((a, b) => a.type - b.type),
    unverifiedScenarioSections: [...UNVERIFIED] };
}
