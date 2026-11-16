import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const parent=path.resolve(process.argv[3]||'vendor/map-ai-package-1.0.0-20261113');
const engine=path.resolve(process.argv[2]||'vendor/ra2web-lan-0.87.3-20261112-workshop7');
if(fs.existsSync(parent))throw new Error('Choose a new package directory');
fs.mkdirSync(parent,{recursive:true});const kit=parent+'/winlife-ra2-map-ai',site=parent+'/site';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const run=(file,args,options={})=>execFileSync(file,args,{encoding:'utf8',maxBuffer:5*1024*1024,...options});
console.log(run(process.execPath,[here+'/build-kit.mjs',engine,kit]).trim());
const testOutput=run(process.execPath,['--test','tests/kit.test.mjs'],{cwd:kit});
if(!/(?:# |ℹ )fail 0/.test(testOutput))throw new Error('Kit tests did not pass');
const testsPassed=Number(testOutput.match(/(?:# |ℹ )pass (\d+)/)?.[1]);
if(!testsPassed)throw new Error('Cannot read test count');
const examples=[];
for(const name of ['2p-temperate','8p-snow','16p-temperate']){
  const result=JSON.parse(run(process.execPath,['scripts/generate.mjs','examples/'+name+'.json','--out','examples/generated/'+name],{cwd:kit}));
  const report=JSON.parse(fs.readFileSync(result.staticReport));
  const expected=JSON.parse(fs.readFileSync(kit+'/examples/'+name+'.json')).players;
  if(!report.staticPassed||!report.nativeDecoded||report.stats.players!==expected||report.runtimeVerified)throw new Error('Example verification failed');
  examples.push({name,players:expected,file:path.relative(kit,result.map).split(path.sep).join('/'),sha256:result.sha256,bytes:fs.statSync(result.map).size,status:result.status});
}
fs.writeFileSync(kit+'/KIT-VERIFICATION.json',JSON.stringify({kitVersion:'1.0.0',verifiedAt:new Date().toISOString(),node:process.version,testsPassed,testCommand:'node --test tests/kit.test.mjs',testOutput,examples,
  examplesRuntimeVerified:false,scope:'Authoring-tool checks and independent native data-path checks; generated examples have not been claimed as runtime-tested games.'},null,2)+'\n');
function files(root,relative=''){let all=[];for(const item of fs.readdirSync(path.join(root,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const name=path.join(relative,item.name);if(item.isDirectory())all.push(...files(root,name));else if(item.isFile())all.push(name);else throw new Error('Unexpected symlink in package');}return all;}
const manifest=Object.fromEntries(files(kit).map(name=>{const bytes=fs.readFileSync(path.join(kit,name));return[name.split(path.sep).join('/'),{bytes:bytes.length,sha256:sha(bytes)}];}));
fs.writeFileSync(kit+'/manifest-sha256.json',JSON.stringify(manifest,null,2)+'\n');
const archive=parent+'/winlife-ra2-map-ai-1.0.0.zip';
run('python3',['-c',`import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1]); destination=sys.argv[2]
with zipfile.ZipFile(destination,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as out:
 for file in sorted(root.rglob('*')):
  if file.is_file():
   item=zipfile.ZipInfo('winlife-ra2-map-ai/'+file.relative_to(root).as_posix(),date_time=(2026,11,13,0,0,0));item.compress_type=zipfile.ZIP_DEFLATED;item.external_attr=0o100644<<16
   out.writestr(item,file.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
`,kit,archive]);
fs.cpSync(kit,site,{recursive:true});fs.copyFileSync(archive,site+'/'+path.basename(archive));
const zipBytes=fs.readFileSync(archive),zipSha=sha(zipBytes);
const cards=examples.map(item=>`<article class="card"><h3>${item.players} 人${item.name.includes('snow')?'雪地双通道':'温带陆战'}</h3><p>真实地图 ${Math.round(item.bytes/1024)} KiB</p><p class="status">静态通过 · 运行待验收</p><a href="examples/generated/${item.name}/preview.svg">查看示意图</a><a href="${item.file}" download>地图文件</a></article>`).join('');
const html=fs.readFileSync(here+'/site-index.html','utf8').replace('__ZIP_SIZE__',Math.round(zipBytes.length/1024)+' KiB').replace('__ZIP_SHA__',zipSha).replace('__EXAMPLES__',cards);
fs.writeFileSync(site+'/index.html',html);fs.writeFileSync(site+'/download.json',JSON.stringify({version:'1.0.0',file:path.basename(archive),bytes:zipBytes.length,sha256:zipSha},null,2)+'\n');
console.log(JSON.stringify({kit,site,archive,archiveBytes:zipBytes.length,archiveSha256:zipSha,manifestFiles:Object.keys(manifest).length,examples}));
