import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const script=readFileSync(new URL('./game-input.js',import.meta.url),'utf8');
function fixture(){
  const handlers=new Map();
  const document={readyState:'loading',getElementById:()=>null,addEventListener(){}};
  const window={addEventListener(type,fn,options){handlers.set(type,{fn,options});}};
  vm.runInNewContext(script,{document,window});
  function target({tag='CANVAS',game=true,field=false,stats=false}={}){
    return {tagName:tag,closest(selector){if(selector==='#ra2web-root')return game?{}:null;if(selector==='.stats-layer')return stats?{}:null;return field?{}:null;}};
  }
  function dispatch(type,params={}){
    const event={target:target(),cancelable:true,prevented:false,ctrlKey:false,touches:[],preventDefault(){this.prevented=true;},
      stopPropagation(){throw Error('Game event propagation must remain intact');},stopImmediatePropagation(){throw Error('Game event propagation must remain intact');},...params};
    const entry=handlers.get(type);entry?.fn(event);return {event,options:entry?.options};
  }
  return {dispatch,target,handlers};
}
test('canvas wheel cancels browser scrolling while leaving game wheel delivery intact',()=>{
  const {dispatch}=fixture();const {event,options}=dispatch('wheel');assert.equal(event.prevented,true);assert.equal(options.capture,true);assert.equal(options.passive,false);
});
test('ordinary scrolling in menus, dropdowns and diagnostic panels remains available',()=>{
  const {dispatch,target}=fixture();for(const settings of [{tag:'DIV'},{tag:'DIV',game:false},{tag:'INPUT',field:true}])assert.equal(dispatch('wheel',{target:target(settings)}).event.prevented,false);
});
test('trackpad pinch / Ctrl-wheel cannot zoom the game webpage',()=>{
  const {dispatch,target}=fixture();assert.equal(dispatch('wheel',{ctrlKey:true,target:target({tag:'DIV'})}).event.prevented,true);
});
test('single-finger menu scroll and editable touches remain available',()=>{
  const {dispatch,target}=fixture();for(const type of ['touchstart','touchmove']){
    assert.equal(dispatch(type,{target:target({tag:'DIV'}),touches:[{}]}).event.prevented,false);
    assert.equal(dispatch(type,{target:target({tag:'INPUT',field:true}),touches:[{},{}]}).event.prevented,false);
  }
});
test('game-surface touches and multi-touch page gestures cancel browser defaults',()=>{
  const {dispatch,target}=fixture();for(const type of ['touchstart','touchmove']){
    assert.equal(dispatch(type,{touches:[{}]}).event.prevented,true);
    assert.equal(dispatch(type,{target:target({tag:'DIV'}),touches:[{},{}]}).event.prevented,true);
  }
  for(const type of ['gesturestart','gesturechange','gestureend'])assert.equal(dispatch(type).event.prevented,true);
});
test('context menus and selection are suppressed in the game, while text fields keep editing',()=>{
  const {dispatch,target}=fixture();for(const type of ['contextmenu','dragstart','selectstart']){
    assert.equal(dispatch(type).event.prevented,true);
    assert.equal(dispatch(type,{target:target({tag:'TEXTAREA',field:true})}).event.prevented,false);
    assert.equal(dispatch(type,{target:target({tag:'DIV',game:false})}).event.prevented,false);
  }
});
test('uncancellable events are ignored and browser navigation / game mouse buttons are untouched',()=>{
  const {dispatch,handlers}=fixture();assert.equal(dispatch('wheel',{cancelable:false}).event.prevented,false);
  for(const type of ['pointerdown','pointerup','mousedown','mouseup','keydown','keyup','popstate','beforeunload'])assert.equal(handlers.has(type),false);
});
