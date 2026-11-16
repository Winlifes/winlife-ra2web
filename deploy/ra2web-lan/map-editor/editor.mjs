import {
  parseMap, serializeMap, createMap, setMetadata, setOverlay, getOverlay,
  setSpawn, removeSpawn, setTerrain, removeTerrain, addStructure, removeStructure,
  tileAtCell, isPlayableCell, playableBounds, OVERLAY_IDS, TERRAIN_TILES,
} from './map-codec.mjs?v=workshop1';
import { saveDraft, readDraft, saveLocalMap, loadGameMap, readGameIndex } from './map-store.mjs?v=workshop1';

import { captureEditorState, restoreEditorState, containsPlayableTile, tileRange, brushLine } from './editor-state.mjs?v=perf1';

const $ = id => document.getElementById(id);
const canvas = $('map-canvas'), context = canvas.getContext('2d');
const terrainCanvas = document.createElement('canvas'), terrainContext = terrainCanvas.getContext('2d');
const colors = ['#dfc65b','#de6261','#6396dc','#70aa78','#df995f','#77cbd4','#a18bd0','#dc8eaf','#e5e9e5','#9ba8b0','#af7f50','#9adac4','#eda6ca','#b4d36a','#6284b5','#d0c28d'];
const theaterNames = { TEMPERATE: '温带', SNOW: '雪地', URBAN: '城市', DESERT: '沙漠', NEWURBAN: '新城市', LUNAR: '月球' };
const toolNames = { select:'选择', land:'平地画笔', water:'水域画笔', ore:'矿石画笔', gems:'宝石画笔', trees:'树木画笔', spawn:'玩家出生点', building:'中立建筑', raise:'升高地块', lower:'降低地块', sample:'采样地块', erase:'清除资源与物体' };
const TW = 24, TH = 12, ELEVATION = 6;
let doc, tool = 'select', brushSize = 1, grid = true, maxPlayers = 16;
let selected, hover, sampled, pan, painting = false, spaceHeld = false;
let zoom = 1, offsetX = 0, offsetY = 0, dpr = 1, viewWidth = 0, viewHeight = 0;
let baseDirty = true, framePending = false, dirty = false, autosave, toastTimer;
let history = [], future = [], strokeChanged = new Set();
let worldRect, cacheScale = 1, cacheDirtyRect, playBounds, maxHeight = 14, canvasRect;
let structureCells = new Map(), inspected = '', pendingMove, processingFrame = false, lastPaintCell, validationPending = false;
let encoder, encoderFailed = false, documentEpoch = 0, documentRevision = 0, encodingId = 0;
const encodingJobs = new Map();
const stats = { frames:0, cachePaints:0, partialPaints:0, candidates:0, encodes:0, renderMs:[], viewMs:[], paintMs:[], fullMs:[], hitMs:[], historyMs:[], snapshotMs:[] };
function sample(name, value) { const list=stats[name];list.push(value);if(list.length>240)list.shift(); }
Object.defineProperty(window,'winlifeWorkshopPerformance',{configurable:true,value:{snapshot(){
  const result={...stats};for(const key of ['renderMs','viewMs','paintMs','fullMs','hitMs','historyMs','snapshotMs']){const values=[...stats[key]].sort((a,b)=>a-b);result[key]={count:values.length,p50:values[Math.floor(values.length*.5)]||0,p95:values[Math.floor(values.length*.95)]||0,max:values.at(-1)||0};}return result;
}}});
function setText(id, value) { const element=$(id),text=String(value);if(element.textContent!==text)element.textContent=text; }
function rebuildStructureIndex() { structureCells=new Map();for(const [id,item]of doc.structures){const key=item.ry*1000+item.rx;if(!structureCells.has(key))structureCells.set(key,[]);structureCells.get(key).push([id,item]);} }
function resetRenderCache() {
  let minY=Infinity;maxHeight=14;
  for(const tile of doc.tiles){minY=Math.min(minY,point(tile).y);maxHeight=Math.max(maxHeight,tile.z);}
  const width=doc.fullSize.width,height=doc.fullSize.height;
  const x=-(width-1)*TW/2-32,y=Math.min((width+1)*TH/2-14*ELEVATION-32,minY-32);
  worldRect={x,y,width:(2*width-2)*TW/2+64,height:(2*height+width)*TH/2+32-y};
  cacheScale=Math.min(Math.max(1,dpr),2,Math.sqrt(8_000_000/(worldRect.width*worldRect.height)));
  terrainCanvas.width=Math.ceil(worldRect.width*cacheScale);terrainCanvas.height=Math.ceil(worldRect.height*cacheScale);
  playBounds=playableBounds(doc);cacheDirtyRect=undefined;baseDirty=true;inspected='';
}
function invalidateTile(tile) {
  if(!tile||baseDirty)return;const p=point(tile),r={x:p.x-34,y:p.y-34,width:68,height:68};
  if(!cacheDirtyRect){cacheDirtyRect=r;return;}
  const x=Math.min(cacheDirtyRect.x,r.x),y=Math.min(cacheDirtyRect.y,r.y);
  cacheDirtyRect={x,y,width:Math.max(cacheDirtyRect.x+cacheDirtyRect.width,r.x+r.width)-x,height:Math.max(cacheDirtyRect.y+cacheDirtyRect.height,r.y+r.height)-y};
}
function touches(p,r,padX=TW,padY=TH) { return p.x+padX>=r.x&&p.x-padX<=r.x+r.width&&p.y+padY>=r.y&&p.y-padY<=r.y+r.height; }
function startEncoder() {
  if(encoderFailed)return;
  try {
    if(!encoder){
      encoder=new Worker(new URL('./map-worker.mjs?v=perf1',import.meta.url),{type:'module'});
      encoder.onmessage=({data})=>{const job=encodingJobs.get(data.id);if(!job){if(data.error)failEncoder(new Error(data.error));return;}encodingJobs.delete(data.id);data.error?job.reject(new Error(data.error)):job.resolve(data.text);};
      encoder.onerror=()=>failEncoder(new Error('Map encoder stopped'));
    }
    encoder.postMessage({type:'init',epoch:documentEpoch,text:serializeMap(doc)});
  }catch(error){failEncoder(error);}
}
function failEncoder(error) { encoderFailed=true;encoder?.terminate();encoder=undefined;for(const job of encodingJobs.values())job.reject(error);encodingJobs.clear(); }
async function encodeCurrentMap() {
  const epoch=documentEpoch,revision=documentRevision,metadata={...doc.metadata};
  if(!encoder||encoderFailed)return {text:serializeMap(doc),epoch,revision,metadata};
  const begin=performance.now(),state=captureEditorState(doc);sample('snapshotMs',performance.now()-begin);
  const id=++encodingId,text=await new Promise((resolve,reject)=>{encodingJobs.set(id,{resolve,reject});encoder.postMessage({type:'encode',id,epoch,state},[state.tiles.buffer,state.overlayDataBase.buffer]);});
  stats.encodes++;return {text,epoch,revision,metadata};
}
async function autosaveDraft() {
  if(painting||pan){autosave=setTimeout(autosaveDraft,600);return;}
  try{const result=await encodeCurrentMap();if(result.epoch!==documentEpoch||result.revision!==documentRevision)return;await saveDraft(result.text);if(result.epoch===documentEpoch&&result.revision===documentRevision)setText('save-status','草稿已自动保存');}
  catch(error){setText('save-status','草稿保存失败，请导出备份');}
}

function toast(message, error = false) {
  const box = $('toast'); box.textContent = message; box.className = error ? 'error' : ''; box.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { box.hidden = true; }, error ? 6500 : 3500);
}
function busy(value, label = '正在读取地图…') {
  $('loading-overlay').hidden = !value; $('loading-overlay').lastElementChild.textContent = label;
}
function report(error) { console.error(error); toast(error.message || '操作未能完成，请重试。', true); busy(false); }
function point(tile) { return { x: (tile.rx - tile.ry) * TW / 2, y: (tile.rx + tile.ry) * TH / 2 - tile.z * ELEVATION }; }
function diamond(path, x, y, width = TW, height = TH) {
  path.moveTo(x, y - height / 2); path.lineTo(x + width / 2, y); path.lineTo(x, y + height / 2); path.lineTo(x - width / 2, y); path.closePath();
}
function pathBatch(){return {paths:[],key:-1};}
function batchDiamond(batch,x,y,key){if(batch.key!==key){batch.paths.push(new Path2D());batch.key=key;}diamond(batch.paths.at(-1),x,y);}
function terrainColor(tile) {
  const water = TERRAIN_TILES[doc.metadata.theater]?.water;
  if (water !== undefined && tile.tileNum >= water && tile.tileNum < water + 14) return ['#315f72','#36677a','#396c80','#326275'][(tile.rx + tile.ry) & 3];
  const variant = Math.abs((tile.rx * 23 + tile.ry * 17 + tile.tileNum) % 6), height = Math.min(14, tile.z) * 2;
  if (doc.metadata.theater === 'SNOW') return `rgb(${160 + variant * 3 + height},${179 + variant * 3 + height},${179 + variant * 3 + height})`;
  if (doc.metadata.theater === 'DESERT' || doc.metadata.theater === 'LUNAR') return `rgb(${115 + variant * 3 + height},${105 + variant * 2 + height},${76 + variant * 2 + height})`;
  if (doc.metadata.theater === 'URBAN' || doc.metadata.theater === 'NEWURBAN') return `rgb(${79 + variant * 2 + height},${91 + variant * 2 + height},${84 + variant * 2 + height})`;
  return `rgb(${67 + variant * 3 + height},${91 + variant * 3 + height},${66 + variant * 2 + height})`;
}
function requestFrame(rebuild = false) {
  baseDirty ||= rebuild;
  if (framePending || processingFrame) return;
  framePending = true; requestAnimationFrame(() => {
    framePending=false;processingFrame=true;const begin=performance.now();let kind;
    try{if(pendingMove){const event=pendingMove;pendingMove=undefined;processPointer(event);}kind=baseDirty?'fullMs':cacheDirtyRect?'paintMs':'viewMs';render();}
    finally{processingFrame=false;stats.frames++;const elapsed=performance.now()-begin;sample('renderMs',elapsed);if(kind)sample(kind,elapsed);}
  });
}
function renderTerrain() {
  let rect=baseDirty?worldRect:cacheDirtyRect;
  if(!baseDirty){const x=worldRect.x+Math.floor((rect.x-worldRect.x)*cacheScale)/cacheScale,y=worldRect.y+Math.floor((rect.y-worldRect.y)*cacheScale)/cacheScale;rect={x,y,width:Math.ceil((rect.x+rect.width-x)*cacheScale)/cacheScale,height:Math.ceil((rect.y+rect.height-y)*cacheScale)/cacheScale};}
  const c=terrainContext;stats.cachePaints++;if(!baseDirty)stats.partialPaints++;
  c.save();c.setTransform(cacheScale,0,0,cacheScale,-worldRect.x*cacheScale,-worldRect.y*cacheScale);
  c.beginPath();c.rect(rect.x,rect.y,rect.width,rect.height);c.clip();c.clearRect(rect.x,rect.y,rect.width,rect.height);
  const range=tileRange(doc,rect,maxHeight),columns=2*doc.fullSize.width-1;
  const groups = new Map(), border = pathBatch(), outside = pathBatch();
  for(let row=range.minRow;row<=range.maxRow;row++)for(let col=range.minX;col<=range.maxX;col++){
    const index=row*columns+col,tile=doc.tiles[index],p=point(tile),batchKey=Math.floor(index/128);stats.candidates++;
    if(!touches(p,rect,TW,TH))continue;
    const color = terrainColor(tile); if (!groups.has(color)) groups.set(color,pathBatch());
    batchDiamond(groups.get(color),p.x,p.y,batchKey); if (grid) batchDiamond(border,p.x,p.y,batchKey);
    if (!containsPlayableTile(playBounds,tile)) batchDiamond(outside,p.x,p.y,batchKey);
  }
  for (const [color,batch] of [...groups].sort(([a],[b])=>a.localeCompare(b))) { c.fillStyle = color; for(const path of batch.paths)c.fill(path); }
  c.fillStyle = '#10191c88';for(const path of outside.paths)c.fill(path);
  if (grid) { c.lineWidth = .55 / Math.max(1,cacheScale); c.strokeStyle = '#152a2b49';for(const path of border.paths)c.stroke(path); }
  for (const item of doc.overlays.values()) {
    const tile = tileAtCell(doc,item.rx,item.ry); if (!tile) continue;
    const p = point(tile);if(!touches(p,rect,32,34))continue;const gems = item.id >= 27 && item.id <= 38, ore = item.id >= 102 && item.id <= 113;
    c.fillStyle = gems ? '#c895dd' : ore ? '#d6b763' : '#9c9f83';
    if (gems || ore) {
      for (let i=0;i<3;i++) { const px=p.x+(i-1)*4,py=p.y+((item.rx+item.ry+i)%3-1)*2; c.beginPath();diamond(c,px,py,4,3);c.fill(); }
    } else { c.fillRect(p.x-2,p.y-1,4,2); }
  }
  for (const item of doc.terrain.values()) {
    const tile=tileAtCell(doc,item.rx,item.ry);if(!tile)continue;const p=point(tile);if(!touches(p,rect,32,34))continue;
    c.fillStyle='#162f27';c.beginPath();c.ellipse(p.x,p.y+1,5,2,0,0,Math.PI*2);c.fill();
    c.fillStyle=doc.metadata.theater==='SNOW'?'#c3d0c3':'#294d39';c.beginPath();c.moveTo(p.x,p.y-12);c.lineTo(p.x+5,p.y);c.lineTo(p.x-5,p.y);c.closePath();c.fill();
  }
  for (const item of doc.structures.values()) {
    const tile=tileAtCell(doc,item.rx,item.ry);if(!tile)continue;const p=point(tile);if(!touches(p,rect,32,34))continue;
    c.fillStyle='#273735';c.beginPath();diamond(c,p.x,p.y,25,13);c.fill();
    c.fillStyle='#a9a18a';c.fillRect(p.x-6,p.y-11,12,12);c.fillStyle='#d4be83';c.fillRect(p.x-7,p.y-14,14,5);c.strokeStyle='#29322d';c.lineWidth=.7;c.strokeRect(p.x-6,p.y-11,12,12);
  }
  for (const spawn of doc.spawns) {
    const tile=tileAtCell(doc,spawn.rx,spawn.ry);if(!tile)continue;const p=point(tile);if(!touches(p,rect,32,34))continue;const color=colors[spawn.number % colors.length];
    c.fillStyle='#111e20bb';c.beginPath();c.ellipse(p.x,p.y+1,12,6,0,0,Math.PI*2);c.fill();
    c.strokeStyle=color;c.lineWidth=1.4;c.beginPath();c.moveTo(p.x,p.y+2);c.lineTo(p.x,p.y-21);c.stroke();
    c.fillStyle=color;c.fillRect(p.x,p.y-21,18,12);c.fillStyle='#17201f';c.font='bold 8px sans-serif';c.textAlign='center';c.textBaseline='middle';c.fillText(spawn.number+1,p.x+9,p.y-15);
  }
  c.restore();
}
function render() {
  if (!doc || !viewWidth) return;
  if(baseDirty||cacheDirtyRect){renderTerrain();baseDirty=false;cacheDirtyRect=undefined;}
  context.setTransform(1,0,0,1,0,0); context.clearRect(0,0,canvas.width,canvas.height);
  const left=Math.max(worldRect.x,-offsetX/zoom),top=Math.max(worldRect.y,-offsetY/zoom),right=Math.min(worldRect.x+worldRect.width,(viewWidth-offsetX)/zoom),bottom=Math.min(worldRect.y+worldRect.height,(viewHeight-offsetY)/zoom);
  if(right>left&&bottom>top)context.drawImage(terrainCanvas,(left-worldRect.x)*cacheScale,(top-worldRect.y)*cacheScale,(right-left)*cacheScale,(bottom-top)*cacheScale,(left*zoom+offsetX)*dpr,(top*zoom+offsetY)*dpr,(right-left)*zoom*dpr,(bottom-top)*zoom*dpr);
  context.setTransform(dpr*zoom,0,0,dpr*zoom,dpr*offsetX,dpr*offsetY);
  const highlighted = hover || selected;
  if (highlighted) {
    const p=point(highlighted);context.beginPath();diamond(context,p.x,p.y);
    context.fillStyle='#f7df9422';context.fill();context.strokeStyle='#f1cc83';context.lineWidth=1.3/zoom;context.stroke();
  }
  setText('zoom-label',Math.round(zoom*100)+'%');if(validationPending&&!painting){validationPending=false;updateValidation();}
}
function resize() {
  const previousDpr=dpr;canvasRect=canvas.getBoundingClientRect();viewWidth=canvasRect.width;viewHeight=canvasRect.height;dpr=Math.min(devicePixelRatio||1,2);
  const width=Math.round(viewWidth*dpr),height=Math.round(viewHeight*dpr);
  if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
  if(doc&&previousDpr!==dpr)resetRenderCache();requestFrame();
}
function fit() {
  if(!doc)return;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const tile of doc.tiles){const p=point(tile);minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
  zoom=Math.max(.08,Math.min(3,(viewWidth-70)/(maxX-minX+TW),(viewHeight-65)/(maxY-minY+TH)));
  offsetX=(viewWidth-(minX+maxX)*zoom)/2;offsetY=(viewHeight-(minY+maxY)*zoom)/2;requestFrame();
}
function hit(event) {const begin=performance.now(),tile=hitCell(event);sample('hitMs',performance.now()-begin);return tile;}
function hitCell(event) {
  if(!doc)return;
  const rect=canvasRect,x=(event.clientX-rect.left-offsetX)/zoom,y=(event.clientY-rect.top-offsetY)/zoom;
  const candidates=new Set();
  for(let height=0;height<=14;height++){
    const yy=y+height*ELEVATION,rx=Math.round(x/TW+yy/TH),ry=Math.round(yy/TH-x/TW);
    for(let ox=-1;ox<=1;ox++)for(let oy=-1;oy<=1;oy++){
      const tile=tileAtCell(doc,rx+ox,ry+oy);if(!tile||tile.z!==height)continue;const p=point(tile);
      if(Math.abs(x-p.x)/(TW/2)+Math.abs(y-p.y)/(TH/2)<=1.03)candidates.add(tile);
    }
  }
  return [...candidates].sort((a,b)=>(b.rx+b.ry)-(a.rx+a.ry))[0];
}
function inspect(tile) {
  if(!tile)return;const overlay=getOverlay(doc,tile.rx,tile.ry),tree=doc.terrain.get(tile.ry*1000+tile.rx),building=structureCells.get(tile.ry*1000+tile.rx)?.[0]?.[1];
  const signature=[tile.rx,tile.ry,tile.z,tile.tileNum,tile.subTile,overlay?.id,building?.name,tree?.name].join(':');if(signature===inspected)return;inspected=signature;
  setText('cell-coords',`${tile.rx}, ${tile.ry}`);setText('cell-height',tile.z);setText('cell-tile',`${tile.tileNum} / ${tile.subTile}`);
  setText('cell-content',building?.name||tree?.name||(overlay?.id===OVERLAY_IDS.ORE?'矿石':overlay?.id===OVERLAY_IDS.GEMS?'宝石':overlay?'Overlay '+overlay.id:'—'));
  setText('coordinate-status',`X ${tile.rx} · Y ${tile.ry} · H ${tile.z}`);
}
function chooseTool(value) {
  tool=value;document.querySelectorAll('[data-tool]').forEach(button=>button.classList.toggle('active',button.dataset.tool===value));
  $('spawn-settings').hidden=value!=='spawn';$('building-settings').hidden=value!=='building';$('tree-settings').hidden=value!=='trees';
  $('status-message').textContent=toolNames[value]+(value==='land'&&sampled?' · 已采样地块':'');canvas.style.cursor=value==='select'?'default':'crosshair';requestFrame();
}
function remember() {const begin=performance.now();history.push(captureEditorState(doc));if(history.length>12)history.shift();future=[];updateHistory();sample('historyMs',performance.now()-begin);}
function updateHistory() { $('undo').disabled=!history.length;$('redo').disabled=!future.length; }
function changed(rebuild=false) {
  dirty=true;documentRevision++;setText('dirty-indicator','●');setText('save-status','正在保存草稿…');
  clearTimeout(autosave);autosave=setTimeout(autosaveDraft,1100);validationPending=true;requestFrame(rebuild);
}
function markPaint(tile) {
  if(!containsPlayableTile(playBounds,tile))return false;
  const key=tile.ry*1000+tile.rx;if(strokeChanged.has(key))return false;strokeChanged.add(key);invalidateTile(tile);
  const terrain=TERRAIN_TILES[doc.metadata.theater];
  if(tool==='land') { if(sampled){tile.tileNum=sampled.tileNum;tile.subTile=sampled.subTile;}else{tile.tileNum=terrain?.clear??0;tile.subTile=0;} }
  else if(tool==='water') {if(!terrain)return;tile.tileNum=terrain.water;tile.subTile=(tile.rx&1)+2*(tile.ry&1);tile.z=0;setOverlay(doc,tile.rx,tile.ry,OVERLAY_IDS.EMPTY);removeTerrain(doc,tile.rx,tile.ry);}
  else if(tool==='ore'||tool==='gems') {if(terrain&&tile.tileNum>=terrain.water&&tile.tileNum<terrain.water+14)return;setOverlay(doc,tile.rx,tile.ry,tool==='ore'?OVERLAY_IDS.ORE:OVERLAY_IDS.GEMS,11);}
  else if(tool==='trees')setTerrain(doc,tile.rx,tile.ry,$('tree-kind').value);
  else if(tool==='raise')tile.z=Math.min(14,tile.z+1);
  else if(tool==='lower')tile.z=Math.max(0,tile.z-1);
  else if(tool==='erase') {setOverlay(doc,tile.rx,tile.ry,OVERLAY_IDS.EMPTY);removeTerrain(doc,tile.rx,tile.ry);for(const [id]of structureCells.get(key)||[])removeStructure(doc,id);structureCells.delete(key);}
  invalidateTile(tile);return true;
}
function paint(tile) {
  if(!tile)return;
  if(tool==='select'){selected=tile;inspect(tile);requestFrame();return;}
  if(tool==='sample'){sampled={tileNum:tile.tileNum,subTile:tile.subTile};chooseTool('land');toast('已采样瓦片 '+tile.tileNum+'，可使用平地画笔复制。');return;}
  if(!containsPlayableTile(playBounds,tile)){toast('请在地图可玩范围内编辑。');return;}
  if(tool==='spawn') {const previous=doc.spawns.find(s=>s.number===Number($('spawn-number').value));if(previous)invalidateTile(tileAtCell(doc,previous.rx,previous.ry));invalidateTile(tile);setSpawn(doc,Number($('spawn-number').value),tile.rx,tile.ry);refreshSpawns();}
  else if(tool==='building'){const key=tile.ry*1000+tile.rx;if(structureCells.has(key))return false;invalidateTile(tile);const id=addStructure(doc,{name:$('building-kind').value,rx:tile.rx,ry:tile.ry,owner:'Neutral',health:256});structureCells.set(key,[[id,doc.structures.get(id)]]);}
  else{let modified=false;const radius=(brushSize-1)/2;for(let x=-radius;x<=radius;x++)for(let y=-radius;y<=radius;y++)modified=markPaint(tileAtCell(doc,tile.rx+x,tile.ry+y))||modified;if(!modified)return false;}
  inspect(tile);return true;
}
function refreshSpawns() {
  const players=Math.min(maxPlayers,Math.max(2,Number(doc.metadata.maxPlayers)||doc.spawns.length));
  const old=$('spawn-number').value;$('spawn-number').replaceChildren();
  for(let i=0;i<players;i++){const option=new Option('玩家 '+(i+1),String(i));$('spawn-number').add(option);}
  $('spawn-number').value=Number(old)<players?old:'0';
  $('spawn-list').replaceChildren();
  for(let i=0;i<players;i++){
    const spawn=doc.spawns.find(item=>item.number===i),button=document.createElement('button');button.type='button';button.className='spawn-chip';
    const icon=document.createElement('i');icon.style.background=colors[i];icon.textContent=i+1;const label=document.createElement('span');label.textContent=spawn?`${spawn.rx}, ${spawn.ry}`:'待设置';
    button.append(icon,label);button.title='设置玩家 '+(i+1)+' 的出生点';button.onclick=()=>{chooseTool('spawn');$('spawn-number').value=i;};$('spawn-list').append(button);
  }
  $('spawn-count').textContent=`${doc.spawns.filter(item=>item.number<players).length}/${players}`;
}
function issues() {
  const list=[],players=Number(doc.metadata.maxPlayers)||2,occupied=new Set();
  if(players>maxPlayers)list.push('当前站点最多支持 '+maxPlayers+' 名参战玩家。');
  for(let i=0;i<players;i++){
    const spawn=doc.spawns.find(item=>item.number===i);
    if(!spawn){list.push(`玩家 ${i+1} 尚未设置出生点。`);continue;}
    const tile=tileAtCell(doc,spawn.rx,spawn.ry),water=TERRAIN_TILES[doc.metadata.theater]?.water;
    if(!tile||!isPlayableCell(doc,spawn.rx,spawn.ry))list.push(`玩家 ${i+1} 的出生点位于可玩范围外。`);
    else if(water!==undefined&&tile.tileNum>=water&&tile.tileNum<water+14)list.push(`玩家 ${i+1} 的出生点位于水中。`);
    const key=`${spawn.rx},${spawn.ry}`;if(occupied.has(key))list.push(`玩家 ${i+1} 的出生点与另一玩家重叠。`);occupied.add(key);
  }
  if(!TERRAIN_TILES[doc.metadata.theater])list.push('该地形的新增地块画笔暂不可用，原有地形会保留。');
  return list;
}
function updateValidation() {
  if(!doc)return;const list=issues();$('validation-count').textContent=list.length;$('validation-list').replaceChildren();
  if(!list.length){const item=document.createElement('li');item.textContent='出生点与地图范围检查通过';$('validation-list').append(item);}
  for(const message of list){const item=document.createElement('li');item.className='warning';item.textContent=message;$('validation-list').append(item);}
}
function refreshProperties() {
  $('document-name').textContent=doc.metadata.name;$('map-name').value=doc.metadata.name;$('map-author').value=doc.metadata.author||'';
  $('map-players').value=String(Math.min(maxPlayers,doc.metadata.maxPlayers));$('theater-label').textContent=theaterNames[doc.metadata.theater]||doc.metadata.theater;
  $('map-size').textContent=`${doc.metadata.width} × ${doc.metadata.height}`;$('canvas-label').textContent=`${theaterNames[doc.metadata.theater]||doc.metadata.theater} · ${doc.metadata.name}`;
  document.querySelector('[data-tool="water"]').disabled=!TERRAIN_TILES[doc.metadata.theater];refreshSpawns();updateValidation();
}
function loadDocument(next,{resetHistory=true,fitView=true}={}) {
  clearTimeout(autosave);doc=next;documentEpoch++;documentRevision=0;selected=hover=undefined;sampled=undefined;pendingMove=undefined;rebuildStructureIndex();resetRenderCache();startEncoder();
  if(resetHistory){history=[];future=[];}dirty=false;$('dirty-indicator').textContent='';refreshProperties();updateHistory();requestFrame(true);if(fitView)fit();busy(false);
}
async function undo(redo=false) {
  const from=redo?future:history,to=redo?history:future;if(!from.length)return;
  to.push(captureEditorState(doc));restoreEditorState(doc,from.pop());rebuildStructureIndex();resetRenderCache();refreshProperties();dirty=true;changed(true);updateHistory();
}
function download(text,name) {
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function decode(bytes) {try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('windows-1252').decode(bytes);}}
async function importFile(file) {
  if(!file)return;if(file.size>4*1024*1024)throw new Error('请导入 4 MB 以内的单张地图文件。');
  busy(true,'正在解析 '+file.name+'…');await new Promise(resolve=>requestAnimationFrame(resolve));
  const next=parseMap(decode(await file.arrayBuffer()));loadDocument(next);changed();toast('已导入 '+file.name+'，原有地图配置会保留。');
}
canvas.addEventListener('pointerdown',event=>{
  if(!doc)return;canvasRect=canvas.getBoundingClientRect();canvas.focus();canvas.setPointerCapture(event.pointerId);
  if(event.button===1||event.button===2||spaceHeld){pan={x:event.clientX,y:event.clientY,offsetX,offsetY};canvas.style.cursor='grabbing';return;}
  const tile=hit(event);if(!tile)return;strokeChanged.clear();painting=true;lastPaintCell={rx:tile.rx,ry:tile.ry};
  const initialTool=tool;if(!['select','sample'].includes(tool))remember();if(paint(tile))changed();if(initialTool==='sample')painting=false;
});
function processPointer(event) {
  if(pan){offsetX=pan.offsetX+event.clientX-pan.x;offsetY=pan.offsetY+event.clientY-pan.y;return;}
  hover=hit(event);inspect(hover);
  if(painting&&hover&&tool==='select'){selected=hover;return;}
  if(painting&&hover&&!['select','spawn','building','sample'].includes(tool)){
    let modified=false;for(const cell of brushLine(lastPaintCell||hover,hover))modified=paint(tileAtCell(doc,cell.rx,cell.ry))||modified;
    lastPaintCell={rx:hover.rx,ry:hover.ry};if(modified)changed();
  }
}
canvas.addEventListener('pointermove',event=>{pendingMove={clientX:event.clientX,clientY:event.clientY};requestFrame();});
function finishStroke(){if(pendingMove){const event=pendingMove;pendingMove=undefined;processPointer(event);}painting=false;pan=undefined;lastPaintCell=undefined;canvas.style.cursor=tool==='select'?'default':'crosshair';requestFrame();}
canvas.addEventListener('pointerup',finishStroke);canvas.addEventListener('pointercancel',finishStroke);canvas.addEventListener('lostpointercapture',finishStroke);
canvas.addEventListener('pointerleave',()=>{if(!painting&&!pan){pendingMove=undefined;hover=undefined;requestFrame();}});canvas.addEventListener('contextmenu',event=>event.preventDefault());
canvas.addEventListener('wheel',event=>{event.preventDefault();const rect=canvasRect,x=event.clientX-rect.left,y=event.clientY-rect.top,next=Math.max(.06,Math.min(5,zoom*Math.exp(-event.deltaY*.001)));offsetX=x-(x-offsetX)*next/zoom;offsetY=y-(y-offsetY)*next/zoom;zoom=next;requestFrame();},{passive:false});
document.addEventListener('keydown',event=>{
  if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
  if(event.code==='Space'){spaceHeld=true;event.preventDefault();}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();undo(event.shiftKey).catch(report);}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();$('export-map').click();}
});
document.addEventListener('keyup',event=>{if(event.code==='Space')spaceHeld=false;});
window.addEventListener('blur',()=>{spaceHeld=false;finishStroke();});
document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>{if(button.dataset.tool==='land')sampled=undefined;chooseTool(button.dataset.tool);}));
$('brush-size').addEventListener('input',event=>{brushSize=Number(event.target.value);$('brush-output').textContent=`${brushSize} × ${brushSize}`;});
$('undo').onclick=()=>undo().catch(report);$('redo').onclick=()=>undo(true).catch(report);$('fit-map').onclick=fit;
$('toggle-grid').onclick=()=>{grid=!grid;$('toggle-grid').classList.toggle('toggled',grid);requestFrame(true);};
$('import-map').onclick=()=>$('file-input').click();$('file-input').onchange=event=>importFile(event.target.files[0]).catch(report).finally(()=>{event.target.value='';});
$('new-map').onclick=()=>$('new-dialog').showModal();$('cancel-new').onclick=()=>$('new-dialog').close();
$('new-form').onsubmit=event=>{
  event.preventDefault();try{
    if(dirty&&!confirm('创建新地图将替换当前草稿。需要保留时，请先导出当前地图。'))return;
    const next=createMap({name:$('new-name').value.trim()||'我的新地图',width:Number($('new-width').value),height:Number($('new-height').value),theater:$('new-theater').value,players:Number($('new-players').value)});
    loadDocument(next);$('new-dialog').close();changed();toast('新地图已创建。');
  }catch(error){report(error);}
};
$('map-properties').onsubmit=event=>{
  event.preventDefault();try{
    const players=Number($('map-players').value);
    if(players>8&&doc.spawnLimit<=8){
      if(doc.waypoints.some(item=>item.number>=8&&item.number<players)){toast('原图的高编号路标可能被触发器使用。请新建扩展人数地图，或先另存并处理这些路标。',true);return;}
      if(!confirm('扩展人数后，需要为新增玩家布置独立出生点。是否继续？'))return;
    }
    remember();setMetadata(doc,{name:$('map-name').value.trim()||'未命名地图',author:$('map-author').value.trim(),maxPlayers:players});
    for(const spawn of [...doc.spawns])if(spawn.number>=players)removeSpawn(doc,spawn.number);
    refreshProperties();changed(true);toast('地图属性已更新。');
  }catch(error){report(error);}
};
$('export-map').onclick=async()=>{try{const warnings=issues();if(warnings.length&&!confirm('地图检查发现 '+warnings.length+' 项提示，仍要导出吗？'))return;const result=await encodeCurrentMap(),name=result.metadata.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')||'winlife-map';download(result.text,name+'.map');toast('地图已导出，可通过游戏的自订地图导入。');}catch(error){report(error);}};
$('use-map').onclick=async()=>{
  try{
    const warnings=issues();if(warnings.length){toast('请先处理地图检查中的提示，再加入游戏。',true);return;}
    const result=await encodeCurrentMap(),meta=result.metadata;const record=await saveLocalMap({text:result.text,title:meta.name,players:meta.maxPlayers,theater:meta.theater,author:meta.author});
    await saveDraft(record.text);if(result.epoch===documentEpoch&&result.revision===documentRevision){dirty=false;setText('dirty-indicator','');setText('save-status','已保存到我的游戏');}$('use-dialog').showModal();
  }catch(error){report(error);}
};
$('close-use').onclick=()=>$('use-dialog').close();
new ResizeObserver(()=>{resize();if(doc&&offsetX===0)fit();}).observe(canvas.parentElement);
async function start(){
  resize();
  try{const catalog=await readGameIndex();maxPlayers=Math.min(16,catalog.limits?.combatants||8);}catch{maxPlayers=16;}
  for(const id of ['map-players','new-players'])for(let i=2;i<=maxPlayers;i++)$(id).add(new Option(i+' 人',String(i)));
  $('new-players').value='4';
  const requested=new URL(location.href).searchParams.get('map');
  if(requested){busy(true,'正在从地图库读取地图…');const bytes=await loadGameMap(requested);loadDocument(parseMap(decode(bytes)));toast('地图已打开，可编辑后另存为自己的版本。');}
  else{const draft=await readDraft().catch(()=>undefined);loadDocument(draft?parseMap(draft.text):createMap({width:64,height:64,name:'我的新地图',players:4}));$('save-status').textContent=draft?'已恢复上次草稿':'本地草稿';}
  $('status-message').textContent='准备就绪 · 选择工具，在画布上编辑';
}
start().catch(report);
