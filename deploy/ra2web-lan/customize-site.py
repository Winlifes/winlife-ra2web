#!/usr/bin/env python3
"""Apply Winlife presentation and nickname-only lobby entry to a prepared build."""
import base64
import hashlib
import html
import json
from pathlib import Path
import shutil
import sys
import runpy
import subprocess
import os

HERE = Path(__file__).resolve().parent
UPSTREAM = Path(os.environ.get("RA2_UPSTREAM_DIR", HERE.parent.parent / "vendor/ra2web")).resolve()
BUILD = "0.87.3-rea0ef5d-workshop17"
NICK_KEY = "winlife.nickname"


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def sri(data):
    return "sha384-" + base64.b64encode(hashlib.sha384(data).digest()).decode()


def replace_once(text, before, after):
    assert text.count(before) == 1, before[:120]
    return text.replace(before, after, 1)


def apply(release):
    version_path = release / "version.json"
    version = json.loads(version_path.read_text())
    old_build = version["assetVersion"]
    config_path = release / "config.json"
    config = json.loads(config_path.read_text())
    config["stallReconnectEnabled"] = True
    dump(config_path, config)
    deployment = release / "deployment"
    workshop = runpy.run_path(str(HERE / "workshop-client.py"))
    rematch = runpy.run_path(str(HERE / "rematch-client.py"))
    localization = runpy.run_path(str(HERE / "map-library/localize-maps.py"))
    content_dedup = runpy.run_path(str(HERE / "map-dedup-client.py"))
    graphics = runpy.run_path(str(HERE / "graphics-client.py"))
    input_controls = runpy.run_path(str(HERE / "input-client.py"))
    ore_mines = runpy.run_path(str(HERE / "ore-mine-client.py"))
    reconnect = runpy.run_path(str(HERE / "reconnect-client.py"))
    library = HERE.parent.parent / "vendor/platform-map-library-20261113-mazes1/maps"
    if library.is_dir():
        shutil.copytree(library, release / "maps", dirs_exist_ok=True)
    (release / "maps").mkdir(exist_ok=True)
    for name in ["index.html", "library.mjs"]:
        shutil.copy2(HERE / "map-library" / name, release / "maps" / name)
    subprocess.run(["node", str(HERE / "map-library/add-workshop-maps.mjs"), str(release)], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["node", str(HERE / "map-library/team-battle-map.mjs"), str(release)], check=True, stdout=subprocess.DEVNULL)
    chinese_names = localization["localize"](release)
    store_bytes = (HERE / "map-editor/map-store.mjs").read_bytes()
    store_entry = "map-editor/map-store-" + hashlib.sha256(store_bytes).hexdigest()[:16] + ".mjs"
    (release / "map-editor").mkdir(exist_ok=True)
    (release / store_entry).write_bytes(store_bytes)
    style_bytes = (HERE / "map-editor/workshop.css").read_bytes()
    style_entry = "map-editor/workshop-" + hashlib.sha256(style_bytes).hexdigest()[:16] + ".css"
    (release / style_entry).write_bytes(style_bytes)
    library_module = release / "maps/library.mjs"
    library_module.write_text(library_module.read_text().replace('/map-editor/map-store.mjs?v=workshop1', '/' + store_entry))
    library_bytes = library_module.read_bytes()
    library_entry = "maps/library-" + hashlib.sha256(library_bytes).hexdigest()[:16] + ".mjs"
    (release / library_entry).write_bytes(library_bytes)
    library_page = release / "maps/index.html"
    library_page.write_text(replace_once(library_page.read_text(),
        '<script type="module" src="./library.mjs?v=workshop1"></script>',
        '<script type="module" src="./' + Path(library_entry).name + '" integrity="' + sri(library_bytes) + '" crossorigin="anonymous"></script>'))
    def patch_features(text):
        return reconnect["patch_client"](ore_mines["patch_client"](graphics["patch_client"](input_controls["patch_client"](content_dedup["patch_client"](localization["patch_client"](rematch["patch_client"](workshop["patch_client"](text)), chinese_names), store_entry)))))
    asset_hash_changes = []
    for name, patch in [("res/overlay/rules.ini", workshop["patch_rules"]), ("style.css", workshop["patch_style"])]:
        path = release / name
        previous = sri(path.read_bytes())
        path.write_text(patch(path.read_text()))
        current = sri(path.read_bytes())
        if previous != current:
            asset_hash_changes.append((previous, current))
            for suffix in [".br", ".gz"]:
                path.with_name(path.name + suffix).unlink(missing_ok=True)
    texts = {p.name: p.read_text() for p in (release / "js").glob("*.js")}
    previous_sri = {name: sri(text.encode()) for name, text in texts.items()}
    app = texts["app.js"]
    if old_build != BUILD or asset_hash_changes or patch_features(app) != app:
        if "lastAppliedNetworkRate" not in app:
            # Partial replay can repeat a notification already queued/applied
            # before a connection stalled. Keep rate changes idempotent.
            app = replace_once(app, 'setRate(e){if(this.debug(',
                'setRate(e){if(!Number.isFinite(e.rate)||e.rate<=0||!Number.isInteger(e.turnNo)||e.turnNo<0)throw new Error("Invalid network rate");'
                'const seen=this.lastAppliedNetworkRate;if(seen&&e.turnNo<=seen.turnNo){if(e.turnNo===seen.turnNo&&e.rate!==seen.rate)throw new Error("Conflicting applied network rate");return}'
                'const queued=this.queuedRateChanges.find(t=>t.turnNo===e.turnNo);if(queued){if(queued.rate!==e.rate)throw new Error("Conflicting queued network rate");return}'
                'if(this.debug(')
            app = replace_once(app, 'this.currentNetworkTurn===0&&e.turnNo===0)this.updateRate(e.rate);else{',
                'this.currentNetworkTurn===0&&e.turnNo===0){this.updateRate(e.rate);this.lastAppliedNetworkRate={...e}}else{')
            app = replace_once(app, 'this.updateRate(t.rate),this.queuedRateChanges.shift()',
                'this.updateRate(t.rate),this.lastAppliedNetworkRate={...t},this.queuedRateChanges.shift()')
        if 'S.current&&E.current&&y(S.current.value,E.current.value)' in app:
            first = app.index("const XRe=")
            end = app.index("ZRe=O.forwardRef(XRe)", first)
            component = app[first:end]
            password = 'O.createElement("div",{className:"field"},O.createElement("label",null,n.get("GUI:Password")),O.createElement("input",{name:"pass",type:"password",required:!0,maxLength:B_,ref:E}))'
            component = replace_once(component, ',' + password, '')
            component = replace_once(component, 'S.current&&E.current&&y(S.current.value,E.current.value)',
                                     'S.current&&y(S.current.value.trim(),"winlife-guest")')
            component = replace_once(component, 'ref:S,value:t,readOnly:!!t',
                                     'ref:S,defaultValue:t??(()=>{try{return localStorage.getItem("winlife.nickname")||""}catch{return""}})(),readOnly:!!t')
            app = app[:first] + component + app[end:]
            app = replace_once(app, 'updateSidebarButtons(){const e=ur();', 'updateSidebarButtons(){const e=!0;')
            app = replace_once(app, 'this.serverRegions.getSize()>1?', 'this.serverRegions.getSize()>0?')
            save = 'this.localPrefs.setItem(mt.PreferredServerRegion,i);'
            app = replace_once(app, save, save + 'try{localStorage.setItem("winlife.nickname",e)}catch{}')
            resume = 'jo&&this.serverRegions.isAvailable(jo.regionId)?'
            restore = 'if(!e.clearCredentials&&!jo){try{const saved=localStorage.getItem("winlife.nickname"),region=this.serverRegions.getFirstAvailable();if(saved&&region)jo={user:saved,pass:"winlife-guest",regionId:region.id}}catch{}}'
            app = replace_once(app, resume, restore + resume)
        if 'window.winlifeNetwork?.observe(R,e.url)' not in app:
            app = replace_once(app, 'const R=new WebSocket(e.url);R.transportKind=Mu',
                               'const R=new WebSocket(e.url);window.winlifeNetwork?.observe(R,e.url);R.transportKind=Mu')
            app = replace_once(app, 'this.gservPingIntervalId=setInterval(()=>{this.updateGservPing()},3e4)',
                               'this.gservPingIntervalId=setInterval(()=>{this.updateGservPing()},2e3)')
            app = replace_once(app, 'bT([Sb.Throttle(5e3)],sg.prototype,"updateGservPing",null)',
                               'bT([Sb.Throttle(2e3)],sg.prototype,"updateGservPing",null)')
        app = patch_features(app)
        texts["app.js"] = app
        texts = {name: text.replace(old_build, BUILD) for name, text in texts.items()}
        for previous, current in asset_hash_changes:
            texts = {name: text.replace(previous, current) for name, text in texts.items()}
        # Re-pin embedded dependency hashes after changing the build cohort.
        old_hashes = dict(previous_sri)
        for _ in range(6):
            new_hashes = {name: sri(text.encode()) for name, text in texts.items()}
            updated = {}
            for name, text in texts.items():
                for dependency, old_hash in old_hashes.items():
                    if old_hash != new_hashes[dependency]:
                        text = text.replace(old_hash, new_hashes[dependency])
                updated[name] = text
            if updated == texts:
                break
            old_hashes, texts = new_hashes, updated
        else:
            raise AssertionError("Integrity graph did not converge")
        for name, text in texts.items():
            (release / "js" / name).write_text(text)
            # A precompressed payload must belong to the same decoded build.
            if sri(text.encode()) != previous_sri[name]:
                for extension in [".br", ".gz"]:
                    (release / "js" / (name + extension)).unlink(missing_ok=True)

    shutil.copytree(HERE / "map-editor", release / "map-editor", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("*.test.mjs", "__pycache__"))
    editor_module = release / "map-editor/editor.mjs"
    editor_module.write_text(editor_module.read_text().replace('./map-store.mjs?v=workshop1', './' + Path(store_entry).name))
    # Old installed game workers pin known query-versioned URLs to their old
    # integrity map. Give the standalone editor a content-addressed entry URL,
    # with browser SRI, so it can update without replacing a running game SW.
    editor_bytes = (release / "map-editor/editor.mjs").read_bytes()
    editor_entry = "map-editor/editor-" + hashlib.sha256(editor_bytes).hexdigest()[:16] + ".mjs"
    retired_editor_entries = []
    for candidate in (release / "map-editor").glob("editor-*.mjs"):
        token = candidate.stem.removeprefix("editor-")
        if len(token) == 16 and all(c in "0123456789abcdef" for c in token) and candidate != release / editor_entry:
            name = str(candidate.relative_to(release)); retired_editor_entries.append(name)
            candidate.unlink()
            for suffix in [".br", ".gz"]:
                candidate.with_name(candidate.name + suffix).unlink(missing_ok=True)
            version["files"].pop(name, None)
    (release / editor_entry).write_bytes(editor_bytes)
    editor_page = release / "map-editor/index.html"
    editor_page.write_text(replace_once(editor_page.read_text(),
        '<script type="module" src="./editor.mjs"></script>',
        '<script type="module" src="./' + Path(editor_entry).name + '" integrity="' + sri(editor_bytes) + '" crossorigin="anonymous"></script>'))
    for page in [library_page, editor_page]:
        page.write_text(replace_once(page.read_text(), 'href="/map-editor/workshop.css"' if page == library_page else 'href="./workshop.css"',
            'href="/' + style_entry + '" integrity="' + sri(style_bytes) + '" crossorigin="anonymous"'))
    originals = {}
    common = {
        "gui:login": "进入大厅", "gui:changeserver": "修改昵称", "stt:changeserver": "修改昵称后重新进入大厅",
        "txt_badpass": "昵称正在使用或格式不正确，请换一个昵称（2–15 位字母、数字、_ 或 -）。",
        "gui:breakingnews": "使用说明",
    }
    for locale in ["zh-CN", "zh-TW", "en-US"]:
        source = json.loads((UPSTREAM / "res/locale" / (locale + ".json")).read_text())
        originals[locale] = {key: source[key] for key in ["txt_copyright", "gui:wwbrand", "ts:disclaimer"]}
        path = release / "res/locale" / (locale + ".json")
        strings = json.loads(path.read_text())
        if locale == "en-US":
            strings.update({
                "txt_copyright": "© 2026 Winlife · Site deployment and multiplayer service",
                "gui:wwbrand": '<a href="/deployment/attribution.html" target="_blank" rel="noopener noreferrer" style="color:inherit">Powered by RA2WEB / Chrono Divide</a>',
                "ts:disclaimer": "Winlife RA2 Multiplayer\nDeployed and maintained by Winlife for game enthusiasts. No affiliation with EA.\nThe original game, assets and engine belong to their respective rights holders.",
                "gui:login": "Enter lobby", "gui:changeserver": "Change nickname",
                "stt:changeserver": "Choose another nickname and re-enter the lobby",
                "txt_badpass": "Nickname is in use or invalid. Choose 2–15 letters, digits, underscores or dashes.",
                "gui:breakingnews": "How to play",
            })
        else:
            strings.update(common)
            strings.update({
                "txt_copyright": "© 2026 Winlife · 本站部署与联机服务",
                "gui:wwbrand": '<a href="/deployment/attribution.html" target="_blank" rel="noopener noreferrer" style="color:inherit">基于 RA2WEB / Chrono Divide</a>',
                "ts:disclaimer": "Winlife 红警联机\n本站由 Winlife 部署与维护，供游戏爱好者交流体验，与 EA 无关联。\n原游戏、素材与引擎的权利归各自权利人所有。",
            })
        dump(path, strings)
    dump(deployment / "upstream-notices.json", originals)
    attribution = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>来源与版权说明</title><body style="max-width:850px;margin:40px auto;font:16px/1.7 sans-serif"><h1>Winlife 红警联机 · 来源与版权说明</h1><p>本站由 Winlife 部署与维护。原游戏、素材和引擎的权利归各自权利人所有。以下保留上游声明原文。</p>'
    for locale, notices in originals.items():
        attribution += '<h2>' + html.escape(locale) + '</h2><pre style="white-space:pre-wrap">' + html.escape('\n\n'.join(notices.values())) + '</pre>'
    attribution += '<p><a href="/LICENSE">许可</a> · <a href="/README.md">上游说明</a> · <a href="/deployment/">部署信息</a></p></body></html>'
    (deployment / "attribution.html").write_text(attribution)
    info = deployment / "index.html"
    content = info.read_text()
    content = content.replace("账号、", "")
    content = content.replace("首次登录会自动创建本站账号；", "设置昵称即可进入大厅，无需注册或密码；")
    if 'href="attribution.html"' not in content:
        content = content.replace('</body>', '<p><a href="attribution.html">原作与引擎署名</a></p></body>')
    info.write_text(content)
    is_public = os.environ.get("RA2_SITE_KIND", "lan") == "public"
    region = "阿里云 · 公网联机" if is_public else json.loads((release / "servers.json").read_text())["regions"][0]["label"]
    (deployment / "news.html").write_text(
        '<p><strong>Winlife 红警联机</strong></p><p>选择「' + region + '」，设置 2–15 位英文、数字、下划线或短横线昵称即可进入大厅，无需注册或密码。</p>'
        '<p>成功进入大厅后自动保存昵称，下次沿用。需要更换时，在大厅点击「修改昵称」。</p>'
        '<p>一人建立游戏，其他玩家加入并点击「接受」，房主开始游戏。</p>'
        '<p>短暂掉线会自动重连。刷新或重开页面后可选「继续上一局」；请使用原浏览器、原昵称，所有人都断线时最多保留 5 分钟。刷新恢复会追赶历史进度，服务器重启后无法恢复原对局。</p>'
    )
    (release / "breaking-news.html").write_text((deployment / "news.html").read_text())
    dump(release / "updates.json", {"version": BUILD.replace("-rea0ef5d", ""), "items": [
        {"title": "断线重连与继续上一局", "text": "掉线自动重试，刷新或重开原浏览器后可继续原对局。所有人都断线时保留 5 分钟，刷新恢复需追赶历史进度。"},
        {"title": "16人地图紫矿与矿井", "text": "Winlife 16人对战平原改为紫色宝石矿，每名玩家两处矿区均有矿井，采空后继续补充紫矿。"},
        {"title": "移除摇杆与移动快捷栏", "text": "统一使用经典键鼠界面，移除触屏设备自动弹出的摇杆、移动快捷栏及相关设置。"},
        {"title": "减少浏览器手势干扰", "text": "游戏页面限制浏览器缩放、画布滚动和支持的侧滑导航，保留游戏滚轮、菜单滚动与输入框。Edge 自带的右键鼠标手势需在浏览器设置中关闭，说明见「画面 / 鼠标」。"},
        {"title": "显卡与画面帧率", "text": "右下角新增「画面 / 鼠标」，可查看当前实际显卡和画面帧率。Windows 双显卡电脑可按设置指南为 Edge 选择高性能显卡，该本地设置对局域网和公网均有效。"},
        {"title": "地图内容去重", "text": "逐项比较地形、出生点、资源、单位、规则和触发器，合并与游戏自带地图重复的选项；内容不同的同名地图标明版本。"},
        {"title": "地图中文名称", "text": "原生选图和社区地图库统一使用中文显示名，保留原名搜索及原地图文件。"},
        {"title": "结算后返回房间", "text": "对局期间保留房间，结算后可返回原房间，保留地图与玩家设置，重新准备即可再战。"},
        {"title": "客机席位修复", "text": "修复第二位玩家被误当成观察者的问题，恢复非房主自己的国家、颜色、起始位置和队伍选择。"},
        {"title": "房间布局修复", "text": "修复玩家设置换行、重叠和多余空白；支持普通地图与 16 人地图，下拉菜单随可用空间展开。"},
        {"title": "地图工坊性能优化", "text": "减少大地图拖动、缩放、画笔、撤销和保存时的停顿。"},
        {"title": "地图工坊与社区地图库", "text": "主菜单新增地图工坊，可浏览社区地图、编辑地形与资源、设置出生点，保存到自己的游戏或导出分享。"},
        {"title": "扩展 16 人对战", "text": "支持最多 16 名参战玩家及 1 名观察者；需要选择具备足够出生点的扩展地图，所有玩家均须刷新到新版。"},
        {"title": "联机缓冲优化", "text": "根据房间网络情况调整指令缓冲，减少短时延迟波动引起的顿挫。"},
        {"title": "Winlife 红警联机", "text": "菜单与加载画面采用原版素材。"},
        {"title": "昵称直接进入", "text": "设置昵称即可进入大厅，无需注册或密码。进入大厅后自动保存，下次沿用；大厅内可修改昵称。"},
        {"title": "实时房间延迟", "text": "建房与对局中显示每位玩家的往返延迟及抖动，每 2 秒更新。同步停顿时显示尚未收到谁的指令；点击面板标题可收起。"},
    ]})
    config_path = release / "config.json"
    config = json.loads(config_path.read_text())
    config["nicknameOnly"] = True
    dump(config_path, config)

    index = release / "index.html"
    page = index.read_text().replace(old_build, BUILD)
    for previous, current in asset_hash_changes:
        page = page.replace(previous, current)
    network_script = release / "js/winlife-network.js"
    shutil.copy2(HERE / "winlife-network.js", network_script)
    network_tag = '<script id="winlife-network-ui" src="./js/winlife-network.js?v=' + BUILD + '" integrity="' + sri(network_script.read_bytes()) + '" crossorigin="anonymous"></script>'
    if 'id="winlife-network-ui"' in page:
        import re
        page = re.sub(r'<script id="winlife-network-ui"[^>]*></script>', lambda _: network_tag, page, count=1)
    else:
        page = replace_once(page, '<script type="application/ra2web-entry"', network_tag + '\n    <script type="application/ra2web-entry"')
    (release / "graphics").mkdir(exist_ok=True)
    for name in ["index.html", "winlife-edge-gpu.ps1"]:
        shutil.copy2(HERE / "graphics" / name, release / "graphics" / name)
    graphics_bytes = (HERE / "graphics/graphics-ui.js").read_bytes()
    graphics_entry = "graphics/graphics-ui-" + hashlib.sha256(graphics_bytes).hexdigest()[:16] + ".js"
    (release / graphics_entry).write_bytes(graphics_bytes)
    graphics_tag = '<script id="winlife-graphics-ui" src="/' + graphics_entry + '" integrity="' + sri(graphics_bytes) + '" crossorigin="anonymous"></script>'
    if 'id="winlife-graphics-ui"' in page:
        import re
        page = re.sub(r'<script id="winlife-graphics-ui"[^>]*></script>', lambda _: graphics_tag, page, count=1)
    else:
        page = replace_once(page, '<script type="application/ra2web-entry"', graphics_tag + '\n    <script type="application/ra2web-entry"')
    input_bytes = (HERE / "input/game-input.js").read_bytes()
    input_entry = "js/winlife-game-input-" + hashlib.sha256(input_bytes).hexdigest()[:16] + ".js"
    (release / input_entry).write_bytes(input_bytes)
    input_tag = '<script id="winlife-game-input" src="/' + input_entry + '" integrity="' + sri(input_bytes) + '" crossorigin="anonymous"></script>'
    if 'id="winlife-game-input"' in page:
        import re
        page = re.sub(r'<script id="winlife-game-input"[^>]*></script>', lambda _: input_tag, page, count=1)
    else:
        page = replace_once(page, '<script type="application/ra2web-entry"', input_tag + '\n    <script type="application/ra2web-entry"')
    reconnect_bytes = (HERE / "reconnect/reconnect-ui.js").read_bytes()
    # Old installed workers reject unknown unversioned /js/ paths. Keep the
    # additive helper outside that pinned runtime namespace; browser SRI still
    # verifies its content-addressed URL on the first upgraded navigation.
    (release / "reconnect").mkdir(exist_ok=True)
    reconnect_entry = "reconnect/reconnect-ui-" + hashlib.sha256(reconnect_bytes).hexdigest()[:16] + ".js"
    (release / reconnect_entry).write_bytes(reconnect_bytes)
    reconnect_tag = '<script id="winlife-reconnect" data-version="' + BUILD + '" data-recover-builds="0.87.3-rea0ef5d-workshop15,0.87.3-rea0ef5d-workshop14" src="/' + reconnect_entry + '" integrity="' + sri(reconnect_bytes) + '" crossorigin="anonymous"></script>'
    if 'id="winlife-reconnect"' in page:
        import re
        page = re.sub(r'<script id="winlife-reconnect"[^>]*></script>', lambda _: reconnect_tag, page, count=1)
    else:
        page = replace_once(page, '<script type="application/ra2web-entry"', reconnect_tag + '\n    <script type="application/ra2web-entry"')
    for name, old_hash in previous_sri.items():
        page = page.replace(old_hash, sri((release / "js" / name).read_bytes()))
    index.write_text(page)
    worker = release / "ra2web-sw.js"
    first, rest = worker.read_text().split("\n", 1)
    worker_config = json.loads(first.removeprefix("const config = ").removesuffix(";"))
    for name in retired_editor_entries:
        worker_config["assetIntegrity"].pop('/' + name, None)
    worker_config["version"] = BUILD
    worker_config["precache"] = [p.replace(old_build, BUILD) for p in worker_config["precache"]]
    if not any(p.startswith('/js/winlife-network.js') for p in worker_config["precache"]):
        worker_config["precache"].append('/js/winlife-network.js?v=' + BUILD)
    worker_config["assetIntegrity"]['/js/winlife-network.js'] = sri(network_script.read_bytes())
    workshop_assets = ['map-editor/' + name for name in ['index.html', 'editor.mjs', 'editor-state.mjs', 'map-worker.mjs', 'map-store.mjs', 'map-codec.mjs', 'workshop.css']] + ['maps/index.html', 'maps/library.mjs', editor_entry, library_entry, store_entry, style_entry, graphics_entry, 'graphics/index.html', input_entry, reconnect_entry]
    for name in workshop_assets:
        worker_config["assetIntegrity"]['/' + name] = sri((release / name).read_bytes())
    for key in worker_config["assetIntegrity"]:
        file = index if key in ["/", "/index.html"] else release / key.lstrip("/")
        worker_config["assetIntegrity"][key] = sri(file.read_bytes())
    worker.write_text("const config = " + json.dumps(worker_config, separators=(",", ":")) + ";\n" + rest)

    server_dir = deployment / "server"
    for name in ["server.mjs", "server.test.mjs", "player16.test.mjs", "reconnect.test.mjs", "network-rate.mjs", "network-rate.test.mjs", "package.json"]:
        shutil.copy2(HERE / "server" / name, server_dir / name)
    server_path = server_dir / "server.mjs"
    server = server_path.read_text()
    if is_public:
        server = server.replace("'RA2WEB-LAN'", "'RA2WEB'").replace("Workstation-1", "Aliyun")
        server = server.replace("Game-Station", "Aliyun").replace("Game workstation local multiplayer", "Nickname-only lobby")
        server = server.replace("RA2WEB LAN", "Winlife multiplayer").replace("Workstation 1 local multiplayer", "Nickname-only lobby")
        server = server.replace("https://lan-game.example.com", "https://game.example.com")
        server_path.write_text(server)
    shutil.copy2(__file__, deployment / "customize-site.py")
    shutil.copy2(HERE / "neutralize-ui.py", deployment / "neutralize-ui.py")
    shutil.copy2(HERE / "build-release.py", deployment / "build-release.py")
    shutil.copy2(HERE / "workshop-client.py", deployment / "workshop-client.py")
    shutil.copy2(HERE / "rematch-client.py", deployment / "rematch-client.py")
    shutil.copy2(HERE / "map-dedup-client.py", deployment / "map-dedup-client.py")
    shutil.copy2(HERE / "graphics-client.py", deployment / "graphics-client.py")
    shutil.copytree(HERE / "graphics", deployment / "graphics", dirs_exist_ok=True)
    shutil.copy2(HERE / "input-client.py", deployment / "input-client.py")
    shutil.copy2(HERE / "ore-mine-client.py", deployment / "ore-mine-client.py")
    shutil.copy2(HERE / "reconnect-client.py", deployment / "reconnect-client.py")
    shutil.copytree(HERE / "reconnect", deployment / "reconnect", dirs_exist_ok=True)
    shutil.copytree(HERE / "input", deployment / "input", dirs_exist_ok=True)
    (deployment / "map-library").mkdir(exist_ok=True)
    for name in ["localize-maps.py", "chinese-titles.txt", "semantic-dedup.mjs", "native-rule-audit.mjs", "native-trigger-check.mjs", "build-catalog.mjs", "add-workshop-maps.mjs", "verify-workshop-map.mjs", "workshop-mines.test.mjs", "team-battle-map.mjs", "map-preview.mjs"]:
        shutil.copy2(HERE / "map-library" / name, deployment / "map-library" / name)
    for name in ["verify-release.mjs", "client-network-rate.test.mjs"]:
        shutil.copy2(HERE / name, deployment / name)
    if not is_public:
        shutil.copy2(HERE / "upgrade-network.mjs", deployment / "upgrade-network.mjs")
    else:
        (deployment / "upgrade-network.mjs").unlink(missing_ok=True)
    subprocess.run(["node", str(HERE / "map-library/verify-workshop-map.mjs"), str(release)], check=True, stdout=subprocess.DEVNULL)
    meta_path = deployment / "release.json"
    meta = json.loads(meta_path.read_text())
    meta.update(assetVersion=BUILD, siteName="Winlife 红警联机", nicknameOnly=True,
                serverVersion="0.7.0", serverSha256=hashlib.sha256(server_path.read_bytes()).hexdigest(),
                liveRoomLatency=True, latencyUpdateIntervalMs=2000, adaptiveNetworkTiming=True,
                networkTimingPolicy="Winlife RTT percentile and jitter; two-turn protocol verified against upstream",
                networkRateReplay=True, clientRateReplayDeduplication=True,
                maxCombatants=16, maxObservers=1, mapEditor=True, nativeMapLibrary=True,
                editorPerformanceOptimized=True, editorEntry=editor_entry, editorEncodingWorker=True,
                roomLayoutFixed=True, guestObserverIndexFixed=True,
                chineseMapNames=True, retainedMatchRooms=True, returnToRoom=True, libraryEntry=library_entry,
                mapStoreEntry=store_entry, workshopStyleEntry=style_entry,
                mapAiGuideEntry=True, mapAiGuideUrl="/map-ai/",
                semanticMapDeduplication=True, mapDeduplicationReport="/maps/deduplication-report.json",
                localGraphicsDiagnostics=True, graphicsEntry=graphics_entry, graphicsGuideUrl="/graphics/",
                gpuPreferenceHint="high-performance", windowsGpuPreferenceRequiresLocalSetting=True,
                virtualControlsRemoved=True, classicHudOnly=True, browserGestureGuard=True,
                gameInputEntry=input_entry, browserMouseGesturesRequireLocalSetting=True,
                mapSpecificMineResources=True, sixteenPlayerMapResourceType="gems", sixteenPlayerMapMines=32,
                automaticStallReconnectEnabled=True, refreshGameRecovery=True, reconnectEntry=reconnect_entry,
                reconnectGraceMs=300000, automaticReconnectRetryMs=90000,
                archivedMaps=len(json.loads((release / "maps/catalog.json").read_text())["maps"]),
                gameplayModified=True, playerLimitExtended=True)
    dump(meta_path, meta)
    compression = deployment / "precompression.json"
    if compression.exists():
        compressed = json.loads(compression.read_text())
        compressed["records"] = [record for record in compressed["records"]
                                  if (release / (record["file"] + ".br")).is_file()]
        dump(compression, compressed)
    version["assetVersion"] = BUILD
    version["files"].setdefault('js/winlife-network.js', {})
    for name in workshop_assets:
        version["files"].setdefault(name, {})
    for name, entry in version["files"].items():
        path = release / name
        if path.is_file():
            data = path.read_bytes()
            entry.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), integrity=sri(data))
    dump(version_path, version)
    manifest_path = deployment / "files-sha256.json"
    manifest = {str(p.relative_to(release)): {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                for p in sorted(release.rglob("*")) if p.is_file() and p != manifest_path}
    dump(manifest_path, manifest)
    print(json.dumps({"siteName": "Winlife 红警联机", "build": BUILD, "nicknameOnly": True, "files": len(manifest)}, ensure_ascii=False))


if __name__ == "__main__":
    apply(Path(sys.argv[1]).resolve())
