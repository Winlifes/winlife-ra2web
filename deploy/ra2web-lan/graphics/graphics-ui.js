/* Local rendering diagnostics. No input interception, game commands or network requests. */
(() => {
  'use strict';
  let gpu = null, contextLost = false, frames = [], dialog, gpuText, frameText, intervalText, advice;
  const isWindows = /Windows/i.test(navigator.userAgent);
  const software = value => /swiftshader|llvmpipe|software rasterizer|\bwarp\b|microsoft basic render/i.test(value || '');
  function reset() { frames = []; }
  function frame(now) {
    if (document.hidden || !Number.isFinite(now)) return;
    if (frames.length && now <= frames[frames.length - 1]) return;
    frames.push(now);
    while (frames.length > 4096 || (frames.length > 2 && frames[1] < now - 3000)) frames.shift();
  }
  function attach(context, canvas) {
    try {
      reset();
      contextLost = false;
      const debug = context.getExtension('WEBGL_debug_renderer_info');
      const renderer = context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER);
      gpu = {renderer: String(renderer || '浏览器未公开显卡名称'), software: software(String(renderer)),
        powerPreference: context.getContextAttributes()?.powerPreference || '未公开'};
      canvas.addEventListener('webglcontextlost', () => {contextLost = true; reset();}, {once:true});
    } catch { gpu = {renderer:'浏览器未公开显卡信息',software:false,powerPreference:'未公开'}; }
  }
  function snapshot(now = performance.now()) {
    const intervals = frames.slice(1).map((value,index) => value - frames[index]);
    const active = !document.hidden && !contextLost && frames.length > 1 && now - frames[frames.length - 1] < 1500;
    const ordered = intervals.slice().sort((a,b)=>a-b);
    return {gpu, contextLost, hidden:document.hidden, active,
      fps:active ? (frames.length - 1) * 1000 / (frames[frames.length - 1] - frames[0]) : null,
      frameIntervalP95:active ? ordered[Math.max(0,Math.ceil(ordered.length*.95)-1)] : null};
  }
  // These hooks are called after context creation and after an actual game/UI draw.
  // They never change the renderer, input queue, network turns or simulation.
  window.winlifeGraphics = {attach, frame, snapshot};
  document.addEventListener('visibilitychange', reset);
  const node = (tag, text, cls) => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (cls) result.className = cls;
    return result;
  };
  function render() {
    if (!dialog || dialog.hidden) return;
    const state = snapshot();
    gpuText.textContent = state.contextLost ? '显卡连接暂时中断，等待恢复…' : state.gpu?.renderer || '进入主菜单或对局后显示';
    frameText.textContent = state.active ? Math.round(state.fps) + ' FPS' : document.hidden ? '标签页在后台' : '等待画面绘制';
    intervalText.textContent = state.active ? state.frameIntervalP95.toFixed(1) + ' ms' : '—';
    if (state.gpu?.software) {
      advice.textContent = '检测到软件渲染。请检查 Edge 图形加速、显卡驱动和 Windows 的高性能显卡设置。';
      advice.className = 'wg-note wg-warning';
    } else {
      advice.textContent = isWindows ? '网页已请求高性能显卡。请核对上面的实际显卡；Windows 可为 Edge 单独指定高性能 GPU。' : '网页已请求高性能显卡，实际使用的显卡由系统与浏览器决定。';
      advice.className = 'wg-note';
    }
  }
  function mount() {
    if (document.getElementById('winlife-graphics')) return;
    const style = node('style');
    style.textContent = `
      #winlife-graphics{position:fixed;right:10px;bottom:10px;z-index:100001;font:13px/1.5 system-ui,sans-serif;color:#eee;text-shadow:none}
      #winlife-graphics button,#winlife-graphics a{font:inherit}
      #winlife-graphics button{cursor:pointer;color:#f1cf75;background:#171a1feb;border:1px solid #796444;border-radius:5px;padding:7px 12px}
      #winlife-graphics button:focus-visible,#winlife-graphics a:focus-visible{outline:2px solid #f1cf75;outline-offset:3px}
      #winlife-graphics-panel{position:absolute;right:0;bottom:44px;width:380px;max-width:calc(100vw - 20px);max-height:calc(100vh - 90px);overflow:auto;box-sizing:border-box;padding:16px;background:#14191ff5;border:1px solid #796444;border-radius:8px;box-shadow:0 8px 30px #0008}
      #winlife-graphics-panel[hidden]{display:none}
      #winlife-graphics h2{font-size:16px;color:#f1cf75;margin:0 0 10px}
      #winlife-graphics .wg-close{position:absolute;right:8px;top:8px;padding:2px 8px;background:transparent}
      #winlife-graphics dl{margin:10px 0;display:grid;grid-template-columns:108px minmax(0,1fr);gap:8px}
      #winlife-graphics dt{color:#aaa}#winlife-graphics dd{margin:0;overflow-wrap:anywhere}
      #winlife-graphics .wg-note{color:#bdc8d3;font-size:12px;margin:12px 0}
      #winlife-graphics .wg-warning{color:#ffd183}
      #winlife-graphics a{color:#f1cf75;text-underline-offset:3px}
      #winlife-graphics .wg-small{color:#9da9b5;font-size:11px}
    `;
    document.head.append(style);
    const root = node('div'); root.id = 'winlife-graphics';
    const toggle = node('button','画面 / 鼠标');
    toggle.type = 'button'; toggle.setAttribute('aria-expanded','false'); toggle.setAttribute('aria-controls','winlife-graphics-panel');
    dialog = node('section'); dialog.id = 'winlife-graphics-panel'; dialog.hidden = true;
    dialog.setAttribute('role','region'); dialog.setAttribute('aria-label','画面与鼠标');
    const close = node('button','×','wg-close'); close.type='button';close.setAttribute('aria-label','关闭画面与鼠标');
    const hide = () => {dialog.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();};
    close.onclick = hide;
    toggle.onclick = () => {dialog.hidden=!dialog.hidden;toggle.setAttribute('aria-expanded',String(!dialog.hidden));render();if(!dialog.hidden)close.focus();};
    dialog.append(node('h2','画面与鼠标'),close);
    const facts = node('dl');
    gpuText = node('dd');frameText=node('dd');intervalText=node('dd');
    for (const [label,value] of [['实际显卡',gpuText],['画面帧率',frameText],['较慢帧间隔',intervalText]]) facts.append(node('dt',label),value);
    advice = node('p',undefined,'wg-note');
    const guide = node('a','Windows 显卡设置与鼠标排查 ↗');guide.href='/graphics/';guide.target='_blank';guide.rel='noopener noreferrer';
    dialog.append(facts,advice,guide,node('p','指针拖动不跟手时，先看显卡与画面帧率。点击后单位反应慢时，查看左侧房间延迟。','wg-note'),
      node('p','帧率取最近 3 秒实际绘制；较慢帧间隔为第 95 百分位，不代表鼠标的端到端延迟。显卡信息仅在本机显示。','wg-small'));
    root.append(dialog,toggle);document.body.append(root);
    // Refresh the small panel only when it is open; frame() only stores timestamps.
    setInterval(render,1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',mount,{once:true}); else mount();
})();
