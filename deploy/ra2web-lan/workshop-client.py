"""Audited, narrowly anchored additions to the recovered 0.87.3 client.

The changes preserve legacy maps' reserved 0..7 spawn semantics. Extended
maps opt in with Basic.WinlifeMaxPlayers, rather than treating trigger
waypoints 8..15 as player starts. See proof/player16-20261112/AUDIT.md.
"""
import re

COLORS = {
    "WinlifeWhite": "0,0,250", "WinlifeSteel": "150,24,148",
    "WinlifeBrown": "18,195,140", "WinlifeMint": "112,85,255",
    "WinlifeRose": "236,95,255", "WinlifeLime": "61,235,255",
    "WinlifeNavy": "164,225,125", "WinlifeSand": "32,80,220",
}


def once(text, before, after):
    assert text.count(before) == 1, f"Workshop patch anchor ({text.count(before)}): {before[:100]}"
    return text.replace(before, after, 1)


def patch_client(text):
    observer_dispatch = 'this.handleGameOptObserver(R[1])'
    if observer_dispatch in text:
        # Observer indices are decimal numbers; O16 must remain 16, not 1.
        text = once(text, observer_dispatch, 'this.handleGameOptObserver(R.slice(1))')
    # Keep custom dropdowns inside the scrollable room's visible bounds.
    # Placement uses rendered coordinates, including the game's UI scale.
    select_helper = '''function wlFitLobbySelect(control,close){
const form=control?.closest(".lobby-form"),layer=control?.querySelector(".select-layer");
if(!form||!layer)return()=>{};
const place=()=>{
const box=control.getBoundingClientRect(),clip=form.getBoundingClientRect(),scale=box.height/(control.offsetHeight||box.height)||1;
if(box.bottom<=Math.max(clip.top,0)||box.top>=Math.min(clip.bottom,window.innerHeight)){close();return}
const below=Math.max(0,(Math.min(clip.bottom,window.innerHeight)-box.bottom-2)/scale),above=Math.max(0,(box.top-Math.max(clip.top,0)-2)/scale),up=below<240&&above>below;
layer.style.top=up?"auto":control.offsetHeight+"px";layer.style.bottom=up?control.offsetHeight+"px":"auto";
layer.style.maxHeight=Math.min(240,up?above:below)+"px"};place();
const scroll=event=>{if(!layer.contains(event.target))place()};
form.addEventListener("scroll",scroll,true);window.addEventListener("resize",close);
return()=>{form.removeEventListener("scroll",scroll,true);window.removeEventListener("resize",close)}
}
'''
    if 'function wlFitLobbySelect(' in text:
        text = re.sub(r'function wlFitLobbySelect\([\s\S]*?\n\}\n', lambda _: select_helper, text, count=1)
    else:
        text = select_helper + text
        text = once(text, 'if(d){h(o);const m=y=>{une(p.current,y.target)||u(!1)};',
                    'if(d){h(o);const wlCleanup=wlFitLobbySelect(p.current,()=>u(!1));const m=y=>{une(p.current,y.target)||u(!1)};')
        text = once(text, '()=>{document.removeEventListener("click",m)}}},[d]);',
                    '()=>{document.removeEventListener("click",m);wlCleanup()}}},[d]);')
    if 'function wlMapTitle(' not in text:
        text = ('function wlMapTitle(text){if(!text||[...text].some(c=>c.charCodeAt(0)>255))return text;'
                'try{return new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(text,c=>c.charCodeAt(0)))}'
                'catch{return text}}\n') + text
        text = once(text, 'this.uiName="NOSTR:"+(n.getString("Name")||r.replace(/\\.[^.]+$/,""));',
                    'this.uiName="NOSTR:"+((r.startsWith("wl_local_")?wlMapTitle(n.getString("Name")):n.getString("Name"))||r.replace(/\\.[^.]+$/,""));')
    local_loader_old = 'return tv(wi.fromBytes(await wl.loadGameMap(e),e))}if(AZ(e))'
    local_loader_new = ('try{return tv(wi.fromBytes(await wl.loadGameMap(e),e))}'
                        'catch(error){if(!e.startsWith("wl_local_"))throw error}}if(AZ(e))')
    if local_loader_old in text:
        text = once(text, local_loader_old, local_loader_new)
    numeric_starts = 'u4=({startPos:s,disabled:e,availableStartPositions:t,onSelect:i,strings:r})=>{const n=[...new Set([s,...t]).values()].sort();'
    if numeric_starts in text:
        text = once(text, numeric_starts, numeric_starts.replace('.sort();', '.sort((a,b)=>a-b);'))
    manifest_old = 'this.maxSlots=[...o?.entries.keys()??[]].filter(c=>Number(c)<8).length'
    manifest_early = 'this.maxSlots=[...o?.entries.keys()??[]].filter(c=>Number.isInteger(Number(c))&&Number(c)>=0&&Number(c)<wlSpawnCap(n)).length'
    manifest_new = ('const wlCap=wlSpawnCap(n),wlStarts=[...o?.entries.keys()??[]].map(Number).filter(c=>Number.isInteger(c)&&c>=0&&c<wlCap).sort((a,b)=>a-b);'
                    'if(wlCap>8&&(wlStarts.length!==wlCap||wlStarts.some((v,i)=>v!==i)))throw new Error("Extended maps need consecutive unique player starts");'
                    'this.maxSlots=new Set(wlStarts).size')
    if "function wlSpawnCap(" in text:
        if manifest_early in text:
            text = once(text, manifest_early, manifest_new)
        return text
    text = ('function wlSpawnCap(b){const raw=b?.getString("WinlifeMaxPlayers");'
            'if(!raw)return 8;const cap=Number(raw);'
            'if(!Number.isInteger(cap)||cap<2||cap>16)throw new Error("Invalid Winlife player capacity");'
            'return Math.max(8,cap)}\n') + text
    text = once(text, manifest_old, manifest_new)
    before = 'readStartingLocations(e){const t=[];for(const i of e.filter(r=>r.number<8).sort((r,n)=>r.number<n.number?-1:1))t.push({x:i.rx,y:i.ry});return t}'
    after = ('readStartingLocations(e){const cap=wlSpawnCap(this.getSection("Basic")),points=e.filter(r=>r.number>=0&&r.number<cap).sort((r,n)=>r.number-n.number);'
             'if(cap>8&&(points.length!==cap||points.some((p,i)=>p.number!==i)||new Set(points.map(p=>p.rx+","+p.ry)).size!==cap||'
             'points.some(p=>!this.tiles.some(tile=>tile.rx===p.rx&&tile.ry===p.ry))))throw new Error("Extended maps need consecutive, unique, valid player starts");'
             'return points.map(p=>({x:p.rx,y:p.ry}))}')
    text = once(text, before, after)
    old_colors = 'mx=["Gold","DarkRed","DarkBlue","DarkGreen","Orange","DarkSky","Purple","Magenta"]'
    new_colors = old_colors[:-1] + ',' + ','.join('"' + name + '"' for name in COLORS) + ']'
    text = once(text, old_colors, new_colors)
    for before, after in [
        ('const b=new Array(8).fill(void 0)', 'const b=new Array(16).fill(void 0)'),
        ('aiPlayers:new Array(8).fill(void 0)', 'aiPlayers:new Array(16).fill(void 0)'),
        ('this.observerSlotIndex=8', 'this.observerSlotIndex=16'),
        ('this.observerSlotIndex=r?0:8', 'this.observerSlotIndex=r?0:16'),
        ('this.wolCon.createGame(a,1,9,', 'this.wolCon.createGame(a,1,17,'),
        ('Math.min(9,o.maxSlots+(this.observerSlotIndex===0?1:0))', 'Math.min(17,o.maxSlots+(this.observerSlotIndex===0?1:0))'),
        ('for(let m=1;m<9;++m)', 'for(let m=1;m<17;++m)'),
        ('this.gameOpts?.maxSlots??8', 'this.gameOpts?.maxSlots??16'),
        ('g${e}${t}N39', 'g${e.toString(36)}${t.toString(36)}N39'),
        ('maxPlayers:Number(i[2])', 'maxPlayers:parseInt(i[2],36)'),
    ]:
        text = once(text, before, after)
    # The observer's dedicated row must never become an AI/combatant row.
    text = once(text, 'changeSlotType(s,e,t){if(!this.hostMode)',
                'changeSlotType(s,e,t){if(e===this.observerSlotIndex&&t!==void 0)return;if(!this.hostMode)')
    # Register source/local maps as native manifests; download only the selected
    # file, retaining the ordinary host-to-guest map transfer protocol.
    text = once(text, 'return PZ(n),o.sortByName(),n.mergeWith(o),this.mapList=n,n}',
                'try{const wl=await import("/map-editor/map-store.mjs?v=workshop1");for(const entry of await wl.listGameMaps())o.addFromMapFile({filename:entry.file,readAsString:()=>wl.registrationText(entry)})}catch(error){console.warn("Winlife map library unavailable",error)}return PZ(n),o.sortByName(),n.mergeWith(o),this.mapList=n,n}')
    text = once(text, 'async load(e,t){if(AZ(e)){',
                'async load(e,t){if(e.startsWith("wl_")){const wl=await import("/map-editor/map-store.mjs?v=workshop1");'
                'try{return tv(wi.fromBytes(await wl.loadGameMap(e),e))}catch(error){if(!e.startsWith("wl_local_"))throw error}}if(AZ(e)){')
    text = once(text, '},{label:e.get("GUI:Replays"),tooltip:e.get("STT:Replays"),',
                '},{label:"地图工坊",tooltip:"浏览社区地图，制作和导入自己的地图",onClick:()=>window.open("/map-editor/","_blank","noopener")},{label:e.get("GUI:Replays"),tooltip:e.get("STT:Replays"),')
    return text


def patch_rules(text):
    if 'WinlifeWhite=' in text:
        return text
    definitions = '\n'.join(name + '=' + value for name, value in COLORS.items())
    text, count = re.subn(r'(?im)^\[Colors\][ \t]*\r?$', lambda match: match.group() + '\n' + definitions, text, count=1)
    assert count == 1, 'Missing native [Colors] section'
    return text


def patch_style(text):
    if 'winlife-player16-scores' not in text:
        text += '\n/* winlife-player16-scores */\n#ra2web-root .score-wrapper { max-height:440px; overflow-y:auto; scrollbar-width:thin; }\n'
    # Replace earlier layout rules as well as supporting clean upstream builds.
    # A room has fixed-width inline columns; reserve scrollbar space from the
    # right padding rather than subtracting it from those columns.
    text = re.sub(r'\n/\* winlife-player16-layout[^*]*\*/\n(?:#ra2web-root [^\n]+\n)+', '\n', text)
    return text.rstrip() + '\n' + '''
/* winlife-player16-layout-v2: retain the native column widths and room height. */
#ra2web-root .lobby-form,
#ra2web-root .lobby-form.lobby-form-sp,
#ra2web-root .lobby-form.lobby-form-server-sel { max-height:560px; overflow-x:hidden; overflow-y:auto; scrollbar-gutter:stable; scrollbar-width:thin; padding-right:14px; }
#ra2web-root .lobby-form .player-slots { height:auto; min-height:263px; }
#ra2web-root .lobby-form .player-slot { white-space:nowrap; }
#ra2web-root .lobby-form .player-slot:empty { display:none; }
#ra2web-root .lobby-form .select .select-layer { z-index:20; top:26px; bottom:auto; max-height:240px; overflow-y:auto; overscroll-behavior:contain; }
#ra2web-root .loading-screen .player-status-container { max-height:calc(100% - 330px); overflow-y:auto; }
'''
