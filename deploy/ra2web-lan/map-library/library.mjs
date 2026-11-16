import { readCatalog, listLocalMaps, saveLocalMap, loadGameMap } from '/map-editor/map-store.mjs?v=workshop1';
const $=id=>document.getElementById(id),theaters={TEMPERATE:'温带',SNOW:'雪地',URBAN:'城市',DESERT:'沙漠',NEWURBAN:'新城市',LUNAR:'月球'},categories={terrain:'地形',spawns:'出生点',resources:'资源',objects:'单位和建筑',rules:'规则',scripts:'触发器'};
let maps=[],local=[],tab='compatible',page=0,timer;
const PAGE_SIZE=48;
function node(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function toast(message,error=false){$('toast').hidden=false;$('toast').textContent=message;$('toast').className=error?'error':'';clearTimeout(timer);timer=setTimeout(()=>{$('toast').hidden=true;},4500);}
function safeUrl(value){if(typeof value!=='string'||!value.trim())return undefined;try{const u=new URL(value,location.href);return ['http:','https:'].includes(u.protocol)?u.href:undefined;}catch{return undefined;}}
function filtered(){
 const query=$('search').value.trim().toLowerCase(),players=$('players-filter').value,source=$('source-filter').value,theater=$('theater-filter').value;
 return (tab==='local'?local:maps.filter(m=>tab==='duplicates'?m.deduplication?.isRepresentative===false:m.deduplication?.isRepresentative!==false&&(tab==='archive'?!m.compatible:m.compatible))).filter(m=>(!query||[m.title,m.baseTitle,m.originalTitle,m.author,m.sourcePath,m.file].some(v=>String(v||'').toLowerCase().includes(query)))&&(!players||Number(m.players)===Number(players))&&(!source||m.source===source)&&(!theater||m.theater===theater));
}
function card(map){
 const activeFile=map.cleanedVersion?.file||map.file;
 const article=node('article',undefined,'map-card'),preview=node('a',undefined,'map-preview');preview.href='/map-editor/?map='+encodeURIComponent(activeFile);preview.title='在地图工坊查看 '+map.title;
 if(map.preview){const image=node('img');image.src=map.preview;image.alt=map.title+' 地图预览';image.loading='lazy';image.onerror=()=>{image.remove();preview.prepend(node('span','◇','preview-fallback'));};preview.append(image);}else preview.append(node('span','◇','preview-fallback'));
 preview.append(node('span',(map.players||'—')+' 人 · '+(theaters[map.theater]||map.theater||'自订'),'map-player-badge'));article.append(preview);
 const info=node('div',undefined,'map-card-info'),title=node('h2',map.title||map.file);title.title=map.originalTitle||map.title||map.file;info.append(title,node('div',(map.author||'作者未注明')+' · '+(map.sourceLabel||map.source||'本地创作'),'map-meta'));
 if(!map.compatible)info.append(node('div',(map.reasons||[]).join('；')||'尚未通过当前游戏版本的兼容检查。','compatibility-note'));
 if(map.deduplication?.builtinEquivalent?.suppressedInStandardSelection)info.append(node('div','与游戏自带地图内容一致，作战选图仅保留本版本。','deduplication-note'));
 if(map.variantInfo)info.append(node('div','同名地图存在差异：'+map.variantInfo.differentCategories.map(key=>categories[key]||key).join('、')+'。','version-note'));
 if(map.deduplication?.isRepresentative===false){const representative=maps.find(item=>item.file===map.deduplication.representativeFile);info.append(node('div','与「'+(representative?.title||'主版本')+'」内容一致，已合并选图条目，原图可继续下载。','deduplication-note'));}
 if(map.cleanedVersion)info.append(node('div','已清理未使用的单位配置：'+map.cleanedVersion.removedSections.join('、')+'。原图保留。','compatibility-note'));
 const actions=node('div',undefined,'map-actions'),edit=node('a','编辑','button');edit.href='/map-editor/?map='+encodeURIComponent(activeFile);actions.append(edit);
 function downloadButton(file,label,suffix=''){const button=node('button',label,'button');button.onclick=async()=>{try{const bytes=await loadGameMap(file),url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),a=node('a');a.href=url;a.download=(map.title||map.file).replace(/[<>:"/\\|?*]/g,'_')+suffix+'.map';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){toast(e.message,true);}};return button;}
 actions.append(downloadButton(activeFile,map.cleanedVersion?'下载清理版':'下载'));
 if(map.cleanedVersion){actions.append(downloadButton(map.file,'下载原图','_原图'));const audit=node('a','清理记录 ↗','button');audit.href=map.cleanedVersion.auditUrl;audit.target='_blank';audit.rel='noopener';actions.append(audit);}
 if(map.compatible){const use=node('button','在游戏中使用','button primary');use.onclick=async()=>{use.disabled=true;try{if(tab==='local'){toast('已在当前浏览器的游戏地图列表中，请刷新游戏后选择。');}else{await loadGameMap(activeFile);toast('地图已在游戏地图列表中，刷新游戏后按名称选择即可。');}}catch(e){toast(e.message,true);}finally{use.disabled=false;}};actions.append(use);}
 info.append(actions);const sourceUrl=safeUrl(map.sourcePage||map.sourceUrl);if(sourceUrl){const source=node('a','原始发布页 ↗','map-source');source.href=sourceUrl;source.target='_blank';source.rel='noopener noreferrer';info.append(source);}else info.append(node('span','保存在当前浏览器','map-source'));
 article.append(info);return article;
}
function render(){
 const results=filtered(),pages=Math.max(1,Math.ceil(results.length/PAGE_SIZE));page=Math.min(page,pages-1);$('map-grid').replaceChildren();
 for(const map of results.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE))$('map-grid').append(card(map));
 if(!results.length)$('map-grid').append(node('div',tab==='local'?'还没有自己的地图。打开地图编辑器，点击「加入我的游戏」后会出现在这里。':'没有符合条件的地图，试试调整筛选。','empty-state'));
 $('result-count').textContent=results.length+' 张地图';$('page-label').textContent=`${page+1} / ${pages}`;$('previous-page').disabled=page===0;$('next-page').disabled=page>=pages-1;
}
for(const id of ['search','players-filter','source-filter','theater-filter'])$(id).addEventListener(id==='search'?'input':'change',()=>{page=0;render();});
document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{tab=button.dataset.tab;page=0;document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-selected',String(b===button));});render();});
$('previous-page').onclick=()=>{page--;render();scrollTo({top:250,behavior:'smooth'});};$('next-page').onclick=()=>{page++;render();scrollTo({top:250,behavior:'smooth'});};
try{
 const [catalog,stored]=await Promise.all([readCatalog(),listLocalMaps().catch(()=>[])]);maps=catalog.maps;local=stored;
 $('total-count').textContent=maps.length;$('compatible-count').textContent=maps.filter(m=>m.compatible&&m.deduplication?.isRepresentative!==false).length;$('local-count').textContent=local.length;
 const dedup=catalog.semanticDeduplication;
 if(dedup){$('map-dedup-summary').hidden=false;$('map-dedup-text').textContent='已比较 '+maps.length+' 张归档与 '+dedup.builtinMapsCompared+' 张游戏自带地图，合并 '+dedup.nativeSelectionDuplicatesRemoved+' 处重复选项。同名但内容不同的地图保留并标明版本。';}
 $('duplicates-tab').hidden=!maps.some(m=>m.deduplication?.isRepresentative===false);
 for(const [id,label]of new Map(maps.map(m=>[m.source,m.sourceLabel||m.source])))$('source-filter').add(new Option(label,id));
 render();
}catch(error){$('map-grid').replaceChildren(node('div',error.message,'empty-state'));$('result-count').textContent='读取失败，请刷新重试。';}
