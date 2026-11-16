import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./graphics-ui.js',import.meta.url),'utf8');
function boot(renderer='ANGLE (NVIDIA GeForce RTX 3050 Direct3D11)') {
  const callbacks={},document={hidden:false,readyState:'loading',addEventListener:(type,fn)=>{callbacks[type]=fn;}},window={};
  runInNewContext(source,{window,document,navigator:{userAgent:'Windows NT 10.0 Edg/150.0'},performance:{now:()=>3000}});
  const canvas={addEventListener:(type,fn)=>{callbacks[type]=fn;}};
  const context={RENDERER:0x1f01,getExtension:()=>({UNMASKED_RENDERER_WEBGL:0x9246}),getParameter:()=>renderer,getContextAttributes:()=>({powerPreference:'high-performance'})};
  window.winlifeGraphics.attach(context,canvas);
  return {api:window.winlifeGraphics,document,callbacks,context,canvas};
}
test('reads the actual context renderer while keeping the GPU hint distinct',()=>{
  const {api}=boot();const info=api.snapshot().gpu;
  assert.match(info.renderer,/RTX 3050/);assert.equal(info.software,false);assert.equal(info.powerPreference,'high-performance');
});
test('software fallback is recognized even when a high-performance hint was requested',()=>{
  const {api}=boot('ANGLE (Google, Vulkan 1.3 SwiftShader Device)');assert.equal(api.snapshot().gpu.software,true);
});
test('counts actual draws and includes a visible stall in frame pacing',()=>{
  const {api}=boot();for(let i=0;i<=120;i++)api.frame(i*1000/60);
  let state=api.snapshot(2001);assert.ok(Math.abs(state.fps-60)<.01);assert.ok(Math.abs(state.frameIntervalP95-1000/60)<.01);
  api.frame(3000);state=api.snapshot(3001);assert.ok(state.fps<42);assert.ok(state.active);
});
test('background tabs and stopped drawing never retain an apparently live FPS',()=>{
  const {api,document,callbacks}=boot();api.frame(10);api.frame(26);assert.equal(api.snapshot(2000).fps,null);
  document.hidden=true;callbacks.visibilitychange();api.frame(2500);assert.equal(api.snapshot(2501).active,false);
  document.hidden=false;callbacks.visibilitychange();api.frame(2600);assert.equal(api.snapshot(2601).fps,null);
});
test('context loss clears measurements and restoration can report the new GPU',()=>{
  const {api,callbacks,context,canvas}=boot();api.frame(1);api.frame(17);callbacks.webglcontextlost();assert.equal(api.snapshot(18).fps,null);assert.equal(api.snapshot(18).contextLost,true);
  context.getParameter=()=> 'ANGLE (Intel UHD)';api.attach(context,canvas);assert.equal(api.snapshot().contextLost,false);assert.match(api.snapshot().gpu.renderer,/Intel/);
});
test('privacy-restricted context queries cannot interrupt the game renderer',()=>{
  const {api,canvas}=boot();assert.doesNotThrow(()=>api.attach({getExtension(){throw Error('blocked');}},canvas));assert.match(api.snapshot().gpu.renderer,/未公开/);
});
