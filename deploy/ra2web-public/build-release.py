#!/usr/bin/env python3
"""Rebase the verified neutral RA2WEB presentation build onto the public server."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import os

HERE = Path(__file__).resolve().parent
ORIGIN = os.environ.get("RA2_PUBLIC_ORIGIN", "https://game.example.com")
LAN_ORIGIN = os.environ.get("RA2_LAN_ORIGIN", "https://lan-game.example.com")


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def integrity(data):
    return "sha384-" + base64.b64encode(hashlib.sha384(data).digest()).decode()


source, destination = [Path(p).resolve() for p in sys.argv[1:3]]
assert not destination.exists(), "Build into a new release directory"
shutil.copytree(source, destination)
config_path = destination / "config.json"
config = json.loads(config_path.read_text())
config.update(gameresBaseUrl=ORIGIN + "/game-resources-ui1/", feedbackUrl=ORIGIN + "/deployment/")
write_json(config_path, config)
write_json(destination / "servers.json", {"regions": [{
    "id": "CN", "label": "阿里云 · 公网联机", "available": True, "gameVersion": "0.87.3",
    "wolUrl": "wss://game.example.com/wol", "apiRegUrl": ORIGIN + "/register",
}]})
mods_path = destination / "mods.json"
mods = json.loads(mods_path.read_text())
for mod in mods["mods"]:
    if isinstance(mod.get("download"), str):
        mod["download"] = mod["download"].replace(LAN_ORIGIN, ORIGIN)
write_json(mods_path, mods)

index = destination / "index.html"
html = index.read_text().replace(LAN_ORIGIN, ORIGIN)
html = html.replace("红色警戒 2 · 局域网", "红色警戒 2 · 在线联机")
html = html.replace("红警局域网", "红警联机").replace("红色警戒 2 局域网联机平台", "红色警戒 2 在线联机平台")
html = html.replace("红色警戒 2, 局域网, RA2, RA2WEB", "红色警戒 2, 联机, RA2, RA2WEB")
html = html.replace("RA2WEB · 局域网", "RA2WEB · 联机").replace("局域网部署说明", "部署说明")
index.write_text(html)
pwa_path = destination / "manifest.webmanifest"
pwa = json.loads(pwa_path.read_text())
pwa.update(name="红色警戒 2 · 在线联机", short_name="红警联机", description="红色警戒 2 在线联机平台")
write_json(pwa_path, pwa)
for path in (destination / "res/locale").glob("*.json"):
    data = json.loads(path.read_text())
    for key in ["ts:reportbugtt", "ts:reportbugdesc", "ts:reportbuglink", "ts:connectfailed", "ts:gameres_download_desc"]:
        if key in data:
            data[key] = data[key].replace("局域网", "服务器").replace("LAN deployment", "Server deployment")
    write_json(path, data)

deployment = destination / "deployment"
deployment.joinpath("news.html").write_text(
    '<p><strong>RA2WEB · 在线联机</strong></p>'
    '<p>选择「阿里云 · 公网联机」，输入 2–15 位英文、数字、下划线或短横线昵称，以及至少 8 位密码。首次登录自动创建本站账号。</p>'
    '<p>房主建立游戏，其他玩家加入并点击「接受」，房主开始游戏。将本网址分享给朋友即可一起玩。</p>'
)
deployment.joinpath("index.html").write_text(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>RA2WEB 联机部署</title>'
    '<body style="max-width:760px;margin:40px auto;font:16px/1.7 sans-serif">'
    '<h1>RA2WEB · 在线联机</h1><p>Chrono Divide / RA2WEB 0.87.3，原版红警界面。</p>'
    '<p>网页、基础游戏资源、账号、大厅与对局服务由本站阿里云服务器提供。'
    '首次登录会自动创建本站账号；房主建立游戏，其他玩家加入并点击「接受」，房主开始游戏。</p>'
    '<p>战役、额外地图、音乐和其他 MOD 可能需要从上游下载。项目仅供个人研究与爱好使用，版权归各自所有者。</p>'
    '<p><a href="/LICENSE">许可</a> · <a href="/README.md">上游说明</a> · '
    '<a href="https://github.com/ra2web/ra2web.github.io/tree/ec91229bf85d637c2388edae31ef1f09805568e8">上游部署包</a> · '
    '<a href="build-public-release.py">公网部署源码</a> · <a href="neutralize-ui.py">界面恢复源码</a> · '
    '<a href="server/server.mjs">联机服务源码</a> · <a href="release.json">版本</a> · '
    '<a href="presentation.json">界面资源来源</a></p></body></html>'
)
# Keep the protocol implementation byte-identical to the tested LAN backend;
# only deployment labels and the fallback origin differ in this public copy.
server_path = deployment / "server/server.mjs"
server = server_path.read_text().replace("'RA2WEB-LAN'", "'RA2WEB'")
server = server.replace("Workstation-1", "Aliyun").replace("RA2WEB LAN", "RA2WEB")
server = server.replace("Game-Station", "Aliyun").replace("Game workstation local multiplayer", "Online multiplayer")
server = server.replace("Workstation 1 local multiplayer", "Online multiplayer")
server = server.replace(LAN_ORIGIN, ORIGIN)
server_path.write_text(server)
shutil.copy2(__file__, deployment / "build-public-release.py")

worker = destination / "ra2web-sw.js"
first, rest = worker.read_text().split("\n", 1)
worker_config = json.loads(first.removeprefix("const config = ").removesuffix(";"))
for name in ["/", "/index.html"]:
    worker_config["assetIntegrity"][name] = integrity(index.read_bytes())
worker.write_text("const config = " + json.dumps(worker_config, separators=(",", ":")) + ";\n" + rest)
version_path = destination / "version.json"
version = json.loads(version_path.read_text())
for name, entry in version["files"].items():
    path = destination / name
    if path.is_file():
        data = path.read_bytes()
        entry.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), integrity=integrity(data))
write_json(version_path, version)
meta_path = deployment / "release.json"
meta = json.loads(meta_path.read_text())
meta.update(origin=ORIGIN, publicDeployment=True, multiplayerBackendLocal=True,
            clientAndBaseAssetsLocal=True, serverSha256=hashlib.sha256(server_path.read_bytes()).hexdigest())
for key in ["stationUser", "stationAddress", "migrationDate"]:
    meta.pop(key, None)
meta["stationLabel"] = "阿里云 · 公网联机"
write_json(meta_path, meta)
for name in ["config.json", "servers.json", "mods.json", "index.html", "manifest.webmanifest"]:
    assert LAN_ORIGIN not in (destination / name).read_text(), name
for path in source.glob("js/*"):
    if path.is_file():
        assert path.read_bytes() == (destination / "js" / path.name).read_bytes(), path.name
assert integrity(index.read_bytes()) == worker_config["assetIntegrity"]["/"]
manifest_path = deployment / "files-sha256.json"
manifest = {str(p.relative_to(destination)): {
    "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
} for p in sorted(destination.rglob("*")) if p.is_file() and p != manifest_path}
write_json(manifest_path, manifest)
print(json.dumps({"release": str(destination), "files": len(manifest), "origin": ORIGIN}))
subprocess.run(["node", str(HERE / "prepare-static.mjs"), str(destination)], check=True)
subprocess.run([sys.executable, str(HERE / "use-oss.py"), str(destination)], check=True)
subprocess.run([sys.executable, str(HERE.parent / "ra2web-lan/customize-site.py"), str(destination)], check=True)
