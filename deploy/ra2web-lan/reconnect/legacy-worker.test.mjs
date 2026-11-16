import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const worker=fs.readFileSync(new URL('../../../vendor/ra2web-public-0.87.3-20261115-workshop12/ra2web-sw.js',import.meta.url),'utf8');
const fingerprint=crypto.createHash('sha256').update(fs.readFileSync(new URL('./reconnect-ui.js',import.meta.url))).digest('hex').slice(0,16);
test('the actual installed previous worker leaves the additive helper to browser SRI on the first upgrade',async()=>{
  const handlers=new Map();vm.runInNewContext(worker,{self:{location:{origin:'https://test.invalid'},addEventListener:(type,fn)=>handlers.set(type,fn)},URL,Response,Request,Set,Map});
  let intercepted;
  const event=path=>({request:{method:'GET',url:'https://test.invalid'+path,mode:'cors'},respondWith:value=>{intercepted=value}});
  handlers.get('fetch')(event('/js/winlife-reconnect-'+fingerprint+'.js'));assert.equal((await intercepted).status,409);
  intercepted=undefined;handlers.get('fetch')(event('/reconnect/reconnect-ui-'+fingerprint+'.js'));assert.equal(intercepted,undefined);
});
