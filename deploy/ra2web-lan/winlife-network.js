/* Room and in-game RTT display. Observes existing sockets; sends no game actions. */
(() => {
  'use strict';
  const sessions = new Set();
  let timer, polling = false, panel, rows, status, snapshot;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function currentName() {
    return [...sessions].reverse().find(session => session.socket.readyState === WebSocket.OPEN && session.name)?.name;
  }
  function mount() {
    if (panel || !document.body) return;
    const style = element('style');
    style.textContent = `
      #winlife-network{position:fixed;left:10px;top:10px;z-index:100000;width:244px;max-width:calc(100vw - 20px);box-sizing:border-box;background:#121212e8;color:#eee;border:1px solid #796444;border-radius:4px;font:12px/1.5 sans-serif;text-shadow:none}
      #winlife-network[hidden]{display:none}
      #winlife-network summary{cursor:pointer;padding:6px 9px;color:#f1cf75;font-weight:bold;user-select:none}
      #winlife-network .network-body{padding:0 9px 8px}
      #winlife-network .network-caption{font-size:10px;color:#aaa;margin:0 0 6px}
      #winlife-network .network-row{display:grid;grid-template-columns:minmax(0,1fr) 54px 46px;gap:5px;padding:2px 0}
      #winlife-network .network-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #winlife-network .network-row span:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
      #winlife-network .network-heading{color:#aaa;border-bottom:1px solid #555;font-size:10px}
      #winlife-network .network-good{color:#96da94}#winlife-network .network-warn{color:#f2ce76}#winlife-network .network-bad{color:#ff9991}
      #winlife-network .network-status{border-top:1px solid #555;margin-top:5px;padding-top:5px;overflow-wrap:anywhere}
    `;
    document.head.append(style);
    panel = element('details');
    panel.id = 'winlife-network';
    panel.open = true;
    panel.hidden = true;
    panel.append(element('summary', '房间延迟'));
    const body = element('div', undefined, 'network-body');
    body.append(element('p', '玩家 ↔ 联机服务器 · 每 2 秒更新', 'network-caption'));
    const heading = element('div', undefined, 'network-row network-heading');
    ['玩家', '往返', '抖动'].forEach(text => heading.append(element('span', text)));
    rows = element('div');
    status = element('div', undefined, 'network-status');
    status.setAttribute('role', 'status');
    body.append(heading, rows, status);
    panel.append(body);
    document.body.append(panel);
  }
  function render(data, name, stale = false) {
    mount();
    if (!panel) return;
    snapshot = data;
    panel.hidden = !data?.room;
    if (panel.hidden) return;
    rows.replaceChildren();
    for (const player of data.room.players) {
      const row = element('div', undefined, 'network-row');
      const label = element('span', player.name + (player.name === name ? '（你）' : ''));
      label.title = player.name;
      const rtt = !stale && player.connected ? player.rttMs : null;
      const delay = element('span', rtt === null ? '--' : `${rtt} ms`, rtt === null || rtt >= 150 ? 'network-bad' : rtt >= 60 ? 'network-warn' : 'network-good');
      delay.title = !player.connected ? '玩家已离线' : rtt === null ? '尚无有效测量，或测量已超时' : '服务器通过此玩家现有 WebSocket 测量的往返时间';
      row.append(label, delay, element('span', !stale && player.jitterMs !== null ? `${player.jitterMs} ms` : '--'));
      rows.append(row);
    }
    const waiting = data.room.players.filter(player => player.active && player.waitingForMs >= 150);
    if (stale) {
      status.textContent = '延迟数据未刷新，正在重试…';
      status.className = 'network-status network-warn';
    } else if (waiting.length) {
      status.textContent = '等指令：' + waiting.map(player => `${player.name}（${player.waitingForMs} ms）`).join('、');
      status.className = 'network-status network-warn';
    } else if (data.room.recentWait) {
      const recent = data.room.recentWait;
      status.textContent = `最近等指令：${recent.names.join('、')}（${recent.waitMs} ms，${Math.max(0, Math.round((data.serverTime - recent.at) / 1000))} 秒前）`;
      status.className = 'network-status network-warn';
    } else {
      status.textContent = data.room.phase === 'room' ? '房间准备中' : data.room.phase === 'loading' ? '正在加载对局' : '同步正常';
      status.className = 'network-status network-good';
    }
    if (!stale && data.eventLoopDelayMs >= 80) status.append(element('div', `服务器调度延迟 ${data.eventLoopDelayMs} ms`, 'network-warn'));
  }
  async function poll() {
    if (polling) return;
    polling = true;
    const name = currentName();
    if (!name) {
      if (panel) panel.hidden = true;
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);
      try {
        const response = await fetch(`/healthz?network=1&user=${encodeURIComponent(name)}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Network status unavailable');
        const data = await response.json();
        if (currentName() === name) render(data, name);
      } catch {
        if (currentName() === name && snapshot) render(snapshot, name, true);
      } finally {
        clearTimeout(timeout);
      }
    }
    polling = false;
    timer = setTimeout(poll, 2000);
  }
  function wake() {
    clearTimeout(timer);
    if (!polling) poll();
  }
  function observe(socket, address) {
    let service;
    try {
      const url = new URL(address, location.href);
      if (url.host !== location.host || !['/wol', '/gserv'].includes(url.pathname)) return;
      service = url.pathname.slice(1);
    } catch { return; }
    const session = { socket, service };
    sessions.add(session);
    const send = socket.send;
    socket.send = function (data) {
      if (typeof data === 'string') for (const line of data.split(/\r?\n/)) {
        const fields = line.split(' ');
        if (fields[0].toLowerCase() === (service === 'wol' ? 'nick' : 'user')) session.candidate = fields[1];
      }
      return send.call(this, data);
    };
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      const accepted = service === 'wol' ? / 376 / : / 100 /;
      if (accepted.test(event.data) && session.candidate) {
        session.name = session.candidate;
        wake();
      }
    });
    socket.addEventListener('close', () => { sessions.delete(session); wake(); });
  }
  window.winlifeNetwork = { observe, getSnapshot: () => snapshot };
  window.addEventListener('pageshow', wake);
})();
