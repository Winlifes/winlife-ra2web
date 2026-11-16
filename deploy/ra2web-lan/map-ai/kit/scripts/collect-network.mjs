// Read-only evidence collection from this deployment's real /healthz API.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliArgs,sha256,writeJson} from '../lib/common.mjs';

export function assessSnapshots(samples,host,guest){
  const errors=[],matched=new Map();let firstTurn,lastTurn;
  if(host===guest)errors.push('Host and guest must be two different nicknames');
  for(const sample of samples){
    const game=sample.game;
    if(!game?.started){errors.push('Target game is missing or not running');continue;}
    if(game.desynced)errors.push('Server reported a desync');
    if(!game.players?.includes(host)||!game.players?.includes(guest))errors.push('Both test identities must be in the target game');
    if(!Number.isInteger(game.turn))errors.push('Missing network turn');
    if(lastTurn!==undefined&&game.turn<lastTurn)errors.push('Network turn moved backwards');
    firstTurn??=game.turn;lastTurn=game.turn;
    for(const entry of game.hashes||[]){
      const values=new Map(entry.values),a=values.get(host),b=values.get(guest);
      if(a!==undefined&&b!==undefined){if(a!==b)errors.push('State checksum mismatch at turn '+entry.turn);else matched.set(entry.turn,{turn:entry.turn,host:a,guest:b});}
    }
  }
  if(!(lastTurn>firstTurn))errors.push('No observed turn progression');
  if(matched.size<3)errors.push('Need at least three different turns with matching checksums from both clients');
  return {status:errors.length?'fail':'pass',errors:[...new Set(errors)],firstTurn,lastTurn,matchingHashes:[...matched.values()]};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let report;
  try{
    const{options:o}=cliArgs(process.argv.slice(2));if(!o.base||!o.host||!o.guest||!o.map||!o.out)throw new Error('Usage: node scripts/collect-network.mjs --base https://ra.winlife.fun --host HOST --guest GUEST --map FILE.map --out evidence/network.json [--seconds 120]');
    const seconds=Number(o.seconds||120);if(!Number.isFinite(seconds)||seconds<10||seconds>600)throw new Error('seconds must be 10..600');
    const base=new URL(o.base);if(!['https:','http:'].includes(base.protocol)||base.username||base.password)throw new Error('Use a normal HTTP(S) site URL without credentials');
    const get=async url=>{const response=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('HTTP '+response.status);return response.json();};
    const room=await get(new URL('/healthz?network=1&user='+encodeURIComponent(o.host),base));
    if(room.room?.phase!=='playing')throw new Error('Start the real game with both clients before collecting evidence');
    report={schemaVersion:1,mapSha256:sha256(fs.readFileSync(o.map)),gameId:room.room.id,host:o.host,guest:o.guest,seconds,startedAt:new Date().toISOString(),
      mapBinding:'The file SHA is supplied by the operator; /healthz does not expose the loaded map SHA. Include browser import/transfer evidence separately.',samples:[]};
    const until=Date.now()+seconds*1000;
    do{const data=await get(new URL('/healthz',base)),game=data.games?.find(g=>g.id===report.gameId);
      report.samples.push({at:new Date().toISOString(),serverVersion:data.serverVersion,game:game||null});
      if(!game||game.desynced)break;if(Date.now()>=until)break;await new Promise(resolve=>setTimeout(resolve,Math.min(2000,until-Date.now())));
    }while(true);
    report.result=assessSnapshots(report.samples,o.host,o.guest);report.finishedAt=new Date().toISOString();writeJson(o.out,report);
    console.log(JSON.stringify({file:o.out,...report.result},null,2));if(report.result.status!=='pass')process.exitCode=1;
  }catch(error){if(report){report.error=error.message;report.result={status:'fail',errors:[error.message]};const{options}=cliArgs(process.argv.slice(2));writeJson(options.out,report);}console.error(error.message);process.exitCode=1;}
}
