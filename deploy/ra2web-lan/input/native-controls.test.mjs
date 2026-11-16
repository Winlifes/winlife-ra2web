import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const file=process.env.RA2_CLIENT_BUNDLE || new URL('../../../vendor/ra2web-lan-0.87.3-20261115-workshop11/js/app.js',import.meta.url);
const source=readFileSync(file,'utf8');
function nativeGate(name,globals={}){
  const fn=source.match(new RegExp('function '+name+'\\(s\\)\\{[^}]*\\}'))?.[0];assert.ok(fn,'Native gate is present');
  return vm.runInNewContext('('+fn+')',globals);
}
test('real HUD gate stays classic on coarse pointers and touch-enabled Windows devices',()=>{
  const shouldUseMobile=nativeGate('Doe',{t2:()=>true});
  for(const viewport of [{width:390,height:844},{width:1024,height:768},{width:1920,height:1080}])assert.equal(shouldUseMobile(viewport),false);
});
test('real virtual-controller gate ignores an old enabled preference and cannot remount the joystick',()=>{
  let reads=0;const gate=nativeGate('RY',{qNe:()=>true,ei:()=>false,U0:'old-joystick-setting'});
  assert.equal(gate({game:{gameOpts:{gameMode:'standard'}},localPrefs:{getItem(){reads++;return '1';}}}),false);
  assert.equal(reads,0);
});
