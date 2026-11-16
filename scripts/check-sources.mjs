// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const roots=['deploy','scripts'];let checked=0;
function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);
  if(entry.isDirectory()){if(!['node_modules','__pycache__','proof','vendor'].includes(entry.name))visit(file);continue;}
  const command=/\.(?:js|mjs|cjs)$/.test(file)?[process.execPath,['--check',file]]:
    file.endsWith('.py')?['python3',['-c','import ast,sys; from pathlib import Path; ast.parse(Path(sys.argv[1]).read_text(), filename=sys.argv[1])',file]]:null;
  if(!command)continue;
  const result=spawnSync(command[0],command[1],{stdio:'inherit'});
  if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);checked++;
}}
for(const root of roots)visit(root);
console.log(JSON.stringify({syntaxChecked:checked}));
