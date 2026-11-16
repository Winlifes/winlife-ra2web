// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const dir='deploy/ra2web-lan/server';
const files=fs.readdirSync(dir).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>dir+'/'+name);
files.push('deploy/ra2web-lan/map-editor/editor-state.test.mjs','deploy/ra2web-lan/graphics/graphics-ui.test.mjs','deploy/ra2web-lan/input/game-input.test.mjs');
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',env:{...process.env,RA2_PLAYER16_OBSERVER:'1'}});
if(result.error)throw result.error;
process.exit(result.status??1);
