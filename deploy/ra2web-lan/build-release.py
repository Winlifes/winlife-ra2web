#!/usr/bin/env python3
"""Prepare a LAN release; optionally run neutralize-ui.py for native presentation."""

import base64
import hashlib
import html
import json
from pathlib import Path
import shutil
import subprocess
import sys
import os


source, destination, resources, mod_archive = [Path(arg).resolve() for arg in sys.argv[1:5]]
origin = os.environ.get("RA2_LAN_ORIGIN", "https://lan-game.example.com")
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
shutil.copytree(source, destination, ignore=shutil.ignore_patterns(".git"))
shutil.copytree(resources, destination / "game-resources", ignore=shutil.ignore_patterns("*.part"))
(destination / "mod").mkdir()
shutil.copy2(mod_archive, destination / "mod" / mod_archive.name)

config = json.loads((destination / "config.json").read_text())
config.update({
    "gameresBaseUrl": origin + "/game-resources/",
    "gameresBaseUrls": [],
    "debugLogging": False,
    "debugGameState": False,
    "quickMatchEnabled": False,
    "stallReconnectEnabled": False,
    "victoryShopUrl": "",
    "breakingNewsUrl": "/deployment/news.html",
})
config.pop("sentry", None)
(destination / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
servers = {"regions": [{
    "id": "LAN", "label": "游戏工作站 · 局域网", "available": True,
    "gameVersion": "0.87.3", "wolUrl": origin.replace("https:", "wss:") + "/wol",
    "apiRegUrl": origin + "/register",
}]}
(destination / "servers.json").write_text(json.dumps(servers, ensure_ascii=False, indent=2) + "\n")
mods = json.loads((destination / "mods.json").read_text())
for mod in mods["mods"]:
    if mod["id"] == "gonghui":
        mod["download"] = origin + "/mod/" + mod_archive.name
(destination / "mods.json").write_text(json.dumps(mods, ensure_ascii=False, indent=2) + "\n")

index = destination / "index.html"
badge = '<a href="/deployment/" target="_blank" rel="noopener" style="position:fixed;left:8px;bottom:6px;z-index:2147483647;color:#eee;background:#222c;font:12px sans-serif;padding:4px 7px;text-decoration:none">RA2WEB · 局域网</a>'
index.write_text(index.read_text().replace("</body>", badge + "\n</body>"))
deployment = destination / "deployment"
deployment.mkdir()
server_source = Path(__file__).resolve().parent / "server"
shutil.copytree(server_source, deployment / "server")
deployment.joinpath("news.html").write_text(
    '<p><strong>RA2WEB · 工作站 1 局域网联机</strong></p>'
    '<p>选择局域网大区，输入 2–15 位英文/数字昵称及至少 8 位密码。首次登录自动创建本地账号。</p>'
    '<p>一人建立游戏，其他人加入房间并点击「接受」，房主开始游戏。账号、大厅与对局均由工作站提供。</p>'
)
deployment.joinpath("index.html").write_text(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>RA2WEB 局域网部署</title>'
    '<body style="max-width:760px;margin:40px auto;font:16px/1.7 sans-serif">'
    '<h1>RA2WEB · 工作站 1</h1><p>王二火大 / Chrono Divide 0.87.3。</p>'
    '<p>客户端、基础游戏资源、账号、大厅和对战服务由局域网工作站提供；'
    '战役、额外地图、音乐及其他 MOD 可能需要联网下载。</p>'
    '<p>保留上游版权标识，供个人研究与爱好使用。</p>'
    '<p><a href="https://github.com/ra2web/ra2web.github.io/tree/' + html.escape(commit) + '">上游部署包</a> · '
    '<a href="/LICENSE">许可</a> · <a href="/README.md">上游说明</a> · '
    '<a href="build-release.py">部署源码</a> · <a href="server/server.mjs">联机服务源码</a> · '
    '<a href="release.json">版本清单</a></p></body></html>'
)
shutil.copy2(__file__, deployment / "build-release.py")
shutil.copy2(resources.parent / "resource-receipt.json", deployment / "resource-receipt.json")
shutil.copy2(resources.parent / "resource-manifest-adjustments.json", deployment / "resource-manifest-adjustments.json")
deployment.joinpath("release.json").write_text(json.dumps({
    "appVersion": "0.87.3", "assetVersion": "0.87.3-rea0ef5d", "upstreamCommit": commit,
    "upstream": "https://github.com/ra2web/ra2web.github.io", "origin": origin,
    "clientAndBaseAssetsLocal": True, "multiplayerBackendLocal": True,
    "runtimeModified": False,
    "serverVersion": json.loads((server_source / "package.json").read_text())["version"],
    "serverSha256": hashlib.sha256((server_source / "server.mjs").read_bytes()).hexdigest(),
    "wsVersion": json.loads((server_source / "package.json").read_text())["dependencies"]["ws"],
}, indent=2) + "\n")

# Retire the previous v86 worker while retaining installed game files in OPFS.
(destination / "sw.js").write_text("""self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({type: 'window'})) await client.navigate(client.url);
})()));
""")

def integrity(data):
    return "sha384-" + base64.b64encode(hashlib.sha384(data).digest()).decode()


# The upstream worker checks page integrity too. Keep its index pin consistent.
worker = destination / "ra2web-sw.js"
first_line, rest = worker.read_text().split("\n", 1)
worker_config = json.loads(first_line.removeprefix("const config = ").removesuffix(";"))
for path in ["/", "/index.html"]:
    worker_config["assetIntegrity"][path] = integrity(index.read_bytes())
worker.write_text("const config = " + json.dumps(worker_config, separators=(",", ":")) + ";\n" + rest)

version_path = destination / "version.json"
version = json.loads(version_path.read_text())
for name, entry in version["files"].items():
    path = destination / name
    if path.is_file():
        data = path.read_bytes()
        entry.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), integrity=integrity(data))
version_path.write_text(json.dumps(version, indent=2) + "\n")
for name, entry in version["files"].items():
    path = destination / name
    if path.is_file():
        assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"], name
assert (source / "js/app.js").read_bytes() == (destination / "js/app.js").read_bytes()
assert (source / "js/vendor.js").read_bytes() == (destination / "js/vendor.js").read_bytes()
assert integrity(index.read_bytes()) == worker_config["assetIntegrity"]["/"]
file_manifest = {
    str(path.relative_to(destination)): {
        "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }
    for path in sorted(destination.rglob("*")) if path.is_file()
}
(deployment / "files-sha256.json").write_text(json.dumps(file_manifest, indent=2) + "\n")
print(json.dumps({"release": str(destination), "commit": commit, "verifiedFiles": len(version["files"])}))

# UI restoration is a separate, reproducible step, using native assets already
# extracted from the user's existing game installation. It retains all credits.
neutralize = Path(__file__).resolve().with_name("neutralize-ui.py")
assets = neutralize.parent / "neutral-assets"
if (assets / "original-menu.webm").is_file():
    subprocess.run([sys.executable, str(neutralize), str(destination), str(source), str(assets)], check=True)
