// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWorkshopMap} from '../deploy/ra2web-lan/map-library/add-workshop-maps.mjs';
import {createTeamBattleMap,teamMapPreview,auditTeamMap} from '../deploy/ra2web-lan/map-library/team-battle-map.mjs';
import {renderMapPreview,embedMapPreview} from '../deploy/ra2web-lan/map-library/map-preview.mjs';
import {serializeMap,parseMap} from '../deploy/ra2web-lan/map-editor/map-codec.mjs';

const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--out'))throw new Error('Usage: npm run maps -- [--out NEW_DIRECTORY]');
const out=path.resolve(args[1]||'artifacts/maps');
assert.ok(!fs.existsSync(out),'Use a new output directory: '+out);
fs.mkdirSync(path.dirname(out),{recursive:true});fs.mkdirSync(out);
const {doc:team,bridges}=createTeamBattleMap();
const records=[];
for(const item of [
  {id:'winlife-16p',doc:createWorkshopMap(),expected:'ff016e531747c1d7e257df99e594093e9d7498dad536bf911430e03ab13df930'},
  {id:'winlife-team8v8-v2',doc:team,preview:teamMapPreview(team,bridges),expected:'6d181588ddf0f50544d6d8c37539adf6a05dae76ecfc3dbbbc604f211f01009a'},
]){
  const preview=item.preview||renderMapPreview(item.doc);embedMapPreview(item.doc,preview);
  const bytes=Buffer.from(serializeMap(item.doc)),sha256=createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256,item.expected,'Generated map must match the published revision');
  const parsed=parseMap(bytes.toString('utf8'));assert.equal(parsed.spawns.length,16);
  const audit=item.id.includes('team8v8')?auditTeamMap(parsed,bridges):{spawns:parsed.spawns.length,mines:parsed.terrain.size};
  fs.writeFileSync(path.join(out,item.id+'.map'),bytes);
  fs.writeFileSync(path.join(out,item.id+'.png'),preview.png);
  records.push({id:item.id,title:parsed.metadata.name,file:item.id+'.map',preview:item.id+'.png',bytes:bytes.length,sha256,audit,runtimeStatus:'pending'});
}
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({schemaVersion:1,maps:records},null,2)+'\n');
console.log(JSON.stringify({directory:out,maps:records.map(({id,sha256})=>({id,sha256}))},null,2));
