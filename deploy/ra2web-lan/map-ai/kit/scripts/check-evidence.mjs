import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliArgs,sha256} from '../lib/common.mjs';

export function checkEvidence(mapFile,recordFile){
  const record=JSON.parse(fs.readFileSync(recordFile)),root=fs.realpathSync(path.dirname(recordFile)),errors=[];
  const expected=sha256(fs.readFileSync(mapFile));
  if(record.mapSha256!==expected)errors.push('Acceptance record belongs to another map SHA256');
  const names=['editorImportExport','roomPlayerCount','allSpawnPositions','mcvAndBuildingPlacement','resourceHarvesting','groundRoutes','aiSmoke','twoClientMapTransfer','networkHashes','visualAndPerformance','normalExit'];
  if(!record.testedClient||!record.testedMod)errors.push('Record the tested client version and mod/rules');
  for(const name of names){
    const check=record.checks?.[name];if(check?.status!=='pass'){errors.push(name+': '+(check?.status||'missing'));continue;}
    if(!check.notes?.trim()||!check.evidence?.length){errors.push(name+': missing observations or evidence');continue;}
    for(const evidence of check.evidence){
      try{
        if(typeof evidence.path!=='string'||path.isAbsolute(evidence.path))throw new Error('Use relative evidence paths');
        const file=fs.realpathSync(path.resolve(root,evidence.path)),relative=path.relative(root,file);
        if(relative==='..'||relative.startsWith('..'+path.sep))throw new Error('Evidence must stay inside the delivery directory');
        const bytes=fs.readFileSync(file);if(!bytes.length||sha256(bytes)!==evidence.sha256)throw new Error('Evidence file hash does not match');
        if(name==='networkHashes'){const network=JSON.parse(bytes);if(network.mapSha256!==expected||network.result?.status!=='pass')throw new Error('Network collection did not pass for this map file');}
      }catch(error){errors.push(name+': '+error.message);}
    }
  }
  return {mapSha256:expected,status:errors.length?'incomplete':'evidence-complete',runtimeEvidenceComplete:errors.length===0,
    scope:'Checks record completeness, file hashes and recorded network results. It does not independently authenticate screenshots or prove gameplay balance.',errors};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const{positional}=cliArgs(process.argv.slice(2));if(positional.length!==2)throw new Error('Usage: node scripts/check-evidence.mjs FILE.map runtime-acceptance.json');const result=checkEvidence(...positional);console.log(JSON.stringify(result,null,2));if(!result.runtimeEvidenceComplete)process.exitCode=2;}catch(error){console.error(error.message);process.exitCode=1;}
}
