/* Suppress browser defaults on the game page, without intercepting game commands. */
(() => {
  'use strict';
  const rootId = 'ra2web-root';
  const editable = target => !!target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  const inGame = target => !!target?.closest?.('#' + rootId);
  const gameCanvas = target => inGame(target) && target.tagName === 'CANVAS' && !target.closest('.stats-layer');
  const cancel = event => { if (event.cancelable) event.preventDefault(); };
  // Ancestor containment stops pull-to-refresh and horizontal overscroll navigation.
  // Only canvases disable touch panning: dropdowns, lists and input fields still scroll.
  const css = `
    html,body{overscroll-behavior:none}
    #ra2web-root{overscroll-behavior:none}
    #ra2web-root canvas{touch-action:none;overscroll-behavior:none;-webkit-touch-callout:none;user-select:none;-webkit-user-select:none}
    .ra2web-vjoy-lite,.ra2web-portrait-battle-hud,.ra2web-landscape-battle-hud{display:none!important}
  `;
  function mount() {
    if (document.getElementById('winlife-game-input-style')) return;
    const style = document.createElement('style');style.id='winlife-game-input-style';style.textContent=css;document.head.append(style);
  }
  // Capture makes this effective even when the existing canvas listener stops bubbling.
  // preventDefault does not suppress the wheel event delivered to the game itself.
  window.addEventListener('wheel', event => {
    if (event.ctrlKey || gameCanvas(event.target)) cancel(event);
  }, {capture:true,passive:false});
  for (const type of ['gesturestart','gesturechange','gestureend']) {
    window.addEventListener(type,event=>{if(!editable(event.target))cancel(event);},{capture:true,passive:false});
  }
  for (const type of ['touchstart','touchmove']) {
    window.addEventListener(type,event=>{
      if (editable(event.target)) return;
      if (gameCanvas(event.target) || event.touches?.length > 1) cancel(event);
    },{capture:true,passive:false});
  }
  for (const type of ['contextmenu','dragstart','selectstart']) {
    window.addEventListener(type,event=>{if(inGame(event.target)&&!editable(event.target))cancel(event);},{capture:true,passive:false});
  }
  // Browser-owned right-button mouse gestures and OS edge gestures require local settings.
  // No history rewriting, key trapping, mouse-button suppression or registry changes.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
