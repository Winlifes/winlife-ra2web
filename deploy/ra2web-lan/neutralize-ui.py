#!/usr/bin/env python3
"""Restore native RA2 presentation and remove promotional UI in a staged release.

Does not modify gameplay, network code, rules, or any MIX archive. The original
SHP/palette pixels are encoded as PNG; the menu is a VP8 transcode of ra2ts_l.bik.
"""

import base64
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import sys
import subprocess
import zlib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
ORIGINAL_BUILD = "0.87.3-rea0ef5d"
BUILD = ORIGINAL_BUILD + "-lanui1"
ORIGIN = "https://ra-lan.winlife.fun:8443"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def sri(data):
    return "sha384-" + base64.b64encode(hashlib.sha384(data).digest()).decode()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def native_png(shp, pal):
    data, palette = shp.read_bytes(), pal.read_bytes()
    zero, width, height, frames = struct.unpack_from("<4H", data)
    x, y, fw, fh, compression = struct.unpack_from("<5H", data, 8)
    offset = struct.unpack_from("<I", data, 28)[0]
    assert (zero, width, height, frames) == (0, 800, 600, 1)
    assert (x, y, fw, fh, compression) == (0, 0, width, height, 0)
    assert offset == 32 and len(data) == offset + width * height
    assert len(palette) == 768 and max(palette) <= 63
    pixels = data[offset:]

    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    rows = b"".join(b"\0" + pixels[row * width:(row + 1) * width] for row in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0))
            + chunk(b"PLTE", bytes(c * 4 for c in palette))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


ZH = {
    "ts:downloadfailed": "无法下载远程资源。请检查网络连接，或联系局域网管理员。",
    "ts:gameres_locate_title": "导入《红色警戒 2》游戏资源",
    "ts:gameres_import_desc": "需要使用 MOD 时，请先导入完整的游戏资源包。",
    "ts:gameres_download_desc": "可导入您已有的游戏资源包，或联系局域网管理员获取导入说明。",
    "ts:gameres_download_hint": "提示：将游戏资源包保存在本地，然后选择文件导入。",
    "ts:import_failed": "无法导入游戏资源。请检查文件是否完整。",
    "ts:import_file_not_found": "找不到文件\"%s\"。请检查游戏资源是否完整。",
    "ts:import_archive_download_failed": "下载失败，请检查网络连接后重试。",
    "ts:import_archive_extract_failed": "解压归档文件失败。请检查文件是否完整。",
    "ts:import_invalid_archive": "解压归档文件失败。请提供有效的归档文件。",
    "ts:import_out_of_memory": "解压归档文件时内存不足。请使用 64 位桌面浏览器，并关闭不需要的标签页。",
    "ts:import_load_files_failed": "无法加载游戏文件。请重新检查游戏资源。",
    "ts:reportbug": "部署说明",
    "ts:reportbugtt": "查看局域网部署信息与使用说明",
    "ts:reportbugdesc": "局域网部署信息与使用说明：",
    "ts:reportbuglink": "查看部署说明",
    "ts:outdatedclient": "您正在使用过时的客户端。请刷新页面。",
    "txt_mismatch": "游戏版本不兼容。请让所有玩家刷新页面后重试。",
    "ts:gamecrashed": "游戏客户端意外崩溃。请刷新页面后重试。",
    "ts:custommapcrash": "当前地图可能不受支持或包含错误。请更换地图，或联系地图作者。",
    "ts:desyncdetected": "检测到游戏失去同步。请确认所有玩家使用相同版本和游戏资源。",
    "gui:replayversionmismatch": "回放使用的是不同的游戏版本（%s），无法加载。",
    "gui:replaymodmismatch": "回放使用了不同的 MOD，无法加载。",
    "ts:connectfailed": "无法连接到服务器。请检查网络连接及局域网服务状态。",
    "ts:serverfull": "服务器已满，请稍后重试。",
    "ts:assetloaderror": "无法加载游戏资源。请检查网络连接或重新导入资源。",
    "ts:gameiniterror": "无法初始化游戏。请检查游戏资源后重试。",
    "ts:donateprompt": "感谢游玩《红色警戒 2》。项目来源与版权信息见制作人员页面。",
    "ts:gameres_locate_title_expansion": "导入《红色警戒 2》游戏资源",
    "ts:gameres_import_desc_expansion": "可以将游戏资源拖入下方的方框中。",
    "ts:gameres_drop_desc_expansion": "将游戏资源拖放到此处",
    "gui:hostidleroomclosed": "空闲房间已关闭，请重新建立游戏或加入其他房间。",
    "stt:campaign": "游玩《红色警戒 2》战役关卡",
}
EN = {
    "ts:reportbug": "Deployment info",
    "ts:reportbugtt": "View LAN deployment information and instructions",
    "ts:reportbugdesc": "LAN deployment information and instructions:",
    "ts:reportbuglink": "View deployment information",
    "gui:hostidleroomclosed": "The idle room has closed. Create a new game or join another room.",
}


def apply(release, upstream, assets):
    deployment = release / "deployment"
    res = release / "game-resources"
    source_manifest = json.loads((ROOT / "vendor/ra2web-lan-resources/manifest.json").read_text())
    manifest = json.loads(json.dumps(source_manifest))
    menu = assets / "original-menu.webm"
    assert menu.read_bytes().startswith(b"\x1aE\xdf\xa3"), "Expected complete WebM transcode"
    shutil.copy2(menu, res / "ra2ts_l.webm")
    (res / "glsl.png").write_bytes(native_png(assets / "glsl.shp", assets / "gls.pal"))
    (res / "ls").mkdir(exist_ok=True)
    for shp in sorted(assets.glob("ls800*.shp")):
        palette = assets / ("mplsobs.pal" if shp.stem == "ls800obs" else "mpls.pal")
        (res / "ls" / (shp.stem + ".png")).write_bytes(native_png(shp, palette))
    manifest["checksums"].pop("ra2ts_l.mp4", None)
    (res / "ra2ts_l.mp4").unlink(missing_ok=True)
    for path in [res / "glsl.png", res / "ra2ts_l.webm", *sorted((res / "ls").glob("*.png"))]:
        manifest["checksums"][str(path.relative_to(res))] = zlib.crc32(path.read_bytes())
    write_json(res / "manifest.json", manifest)

    for name in manifest["checksums"]:
        if name.endswith(".mix"):
            assert (res / name).read_bytes() == (ROOT / "vendor/ra2web-lan-resources" / name).read_bytes(), name

    config_path = release / "config.json"
    config = json.loads(config_path.read_text())
    config.update(gameresBaseUrl=ORIGIN + "/game-resources-ui1/", discordUrl="", donateUrl="", victoryShopUrl="",
                  feedbackUrl=ORIGIN + "/deployment/", patchNotesUrl="/deployment/news.html")
    write_json(config_path, config)

    for locale in ["zh-CN", "zh-TW", "en-US"]:
        path = release / "res/locale" / (locale + ".json")
        original = json.loads((upstream / "res/locale" / path.name).read_text())
        strings = dict(original)
        replacements = EN if locale == "en-US" else ZH
        for key, value in replacements.items():
            if key in strings:
                # Retain all format placeholders required by callers.
                assert re.findall(r"%[sd]", strings[key]) == re.findall(r"%[sd]", value), key
                strings[key] = value
        for key, value in strings.items():
            if key in ["txt_copyright", "ts:disclaimer"]:
                continue
            strings[key] = value.replace("王二火大", "红色警戒 2").replace("wangerhuoda", "Red Alert 2")
        assert strings["txt_copyright"] == original["txt_copyright"]
        assert strings["ts:disclaimer"] == original["ts:disclaimer"]
        assert not any(any(p in value for p in ["公众号", "QQ交流群", "333566518"]) for key, value in strings.items()
                       if key not in ["txt_copyright", "ts:disclaimer"])
        write_json(path, strings)

    pwa = json.loads((release / "manifest.webmanifest").read_text())
    pwa.update(name="红色警戒 2 · 局域网", short_name="红警局域网", description="红色警戒 2 局域网联机平台")
    write_json(release / "manifest.webmanifest", pwa)

    # Two UI-only changes. Keep the source assertion narrow so upgrades fail closed.
    app_source = (upstream / "js/app.js").read_text()
    begin = app_source.index("async getMainMenuVideoUrl(s,e){")
    end = app_source.index("async routeToInitialScreen", begin)
    old_menu = app_source[begin:end]
    new_menu = old_menu.replace("ra2ts_l.mp4", "ra2ts_l.webm").replace("menu=werhd", "menu=lan-ui1")
    assert old_menu.count("ra2ts_l.mp4") == 3
    app_source = app_source[:begin] + new_menu + app_source[end:]
    old_shop = "!bRe()&&yn.set(Fi.ScreenType.VictoryShop,new eNe(this.config.victoryShopUrl,l))"
    assert app_source.count(old_shop) == 1
    app_source = app_source.replace(old_shop, "this.config.victoryShopUrl&&!bRe()&&yn.set(Fi.ScreenType.VictoryShop,new eNe(this.config.victoryShopUrl,l))")

    # Give this presentation build a new cohort. Refresh embedded dependency SRI
    # pins as well as the page and worker pins, without relaxing integrity checks.
    original_js = {p.name: p.read_bytes() for p in (upstream / "js").glob("*.js")}
    texts = {name: data.decode().replace(ORIGINAL_BUILD, BUILD) for name, data in original_js.items()}
    texts["app.js"] = app_source.replace(ORIGINAL_BUILD, BUILD)
    old_hashes = {name: sri(data) for name, data in original_js.items()}
    for _ in range(6):
        new_hashes = {name: sri(text.encode()) for name, text in texts.items()}
        updated = {name: text for name, text in texts.items()}
        for name, text in texts.items():
            for dependency, old_hash in old_hashes.items():
                if old_hash != new_hashes[dependency]:
                    text = text.replace(old_hash, new_hashes[dependency])
            updated[name] = text
        if texts == updated:
            break
        # Once references have been rewritten, include their previous values in
        # the next pass (the graph is acyclic: app -> worker/helper modules).
        old_hashes = new_hashes
        texts = updated
    else:
        raise AssertionError("Dependency integrity graph did not converge")
    for name, text in texts.items():
        (release / "js" / name).write_text(text)

    index = release / "index.html"
    html = index.read_text().replace(BUILD, ORIGINAL_BUILD).replace(ORIGINAL_BUILD, BUILD)
    html = re.sub(r'<title>.*?</title>', '<title>红色警戒 2 · 局域网</title>', html, count=1)
    html = re.sub(r'(<meta name="apple-mobile-web-app-title" content=")[^"]*', r'\1红警局域网', html, count=1)
    html = re.sub(r'(name="keywords"\s+content=")[^"]*', r'\1红色警戒 2, 局域网, RA2, RA2WEB', html, count=1)
    html = re.sub(r'(name="description"\s+content=")[^"]*', r'\1红色警戒 2 局域网联机平台', html, count=1)
    html = html.replace('"endpoint":"https://telemetry.bj1.wangerhuoda.cn/client-incidents"', '"endpoint":""')
    html = html.replace('"successSampleRate":0.02', '"successSampleRate":0')
    html = html.replace('https://feedback.ra2web.com', ORIGIN + '/deployment/')
    html = html.replace('>feedback.ra2web.com</a>', '>局域网部署说明</a>')
    for name, data in original_js.items():
        html = html.replace(sri(data), sri((release / "js" / name).read_bytes()))
    index.write_text(html)

    worker = release / "ra2web-sw.js"
    first, rest = worker.read_text().split("\n", 1)
    worker_config = json.loads(first.removeprefix("const config = ").removesuffix(";"))
    worker_config["version"] = BUILD
    worker_config["precache"] = [p.replace(BUILD, ORIGINAL_BUILD).replace(ORIGINAL_BUILD, BUILD)
                                 for p in worker_config["precache"]]
    worker_config["gameResourcePrefixes"] += [p for p in ["/game-resources/", "/game-resources-ui1/"]
                                               if p not in worker_config["gameResourcePrefixes"]]
    for name in worker_config["assetIntegrity"]:
        path = index if name in ["/", "/index.html"] else release / name.lstrip("/")
        worker_config["assetIntegrity"][name] = sri(path.read_bytes())
    worker.write_text("const config = " + json.dumps(worker_config, separators=(",", ":")) + ";\n" + rest)

    version_path = release / "version.json"
    version = json.loads(version_path.read_text())
    version["assetVersion"] = BUILD
    for name, entry in version["files"].items():
        path = release / name
        if path.is_file():
            data = path.read_bytes()
            entry.update(bytes=len(data), sha256=sha(data), integrity=sri(data))
    write_json(version_path, version)

    provenance = {
        "presentationBuild": BUILD, "gameplayModified": False, "mixArchivesModified": False,
        "uiCodeChanges": ["Use native RA2 menu video transcode", "Hide shop when its URL is empty"],
        "sourceGameAssets": "Existing local RA2 installation: vendor/ra2-vm/game/xwis",
        "nativeSources": {"menu": "language.mix/ra2ts_l.bik", "splash": "ra2.mix/local.mix/glsl.shp + gls.pal",
                          "loading": "ra2.mix/load.mix/ls800*.shp + mplsobs.pal; ra2.mix/cache.mix/mpls.pal"},
        "transcode": "FFmpeg bundled by upstream, Bink to VP8/WebM, 1500k, no audio",
        "inputs": {p.name: {"bytes": p.stat().st_size, "sha256": sha(p.read_bytes())}
                   for p in sorted(assets.iterdir()) if p.suffix in [".bik", ".shp", ".pal", ".webm"]},
        "replacedOrAdded": {name: {"bytes": (res / name).stat().st_size,
                                   "sha256": sha((res / name).read_bytes()), "crc32": crc}
                            for name, crc in manifest["checksums"].items()
                            if not name.endswith(".mix")},
        "retainedCredits": ["RA2WEB badge", "Upstream copyright and disclaimer", "LICENSE", "Chrono Divide logo"],
    }
    write_json(deployment / "presentation.json", provenance)
    receipts = [{"file": name, "bytes": (res / name).stat().st_size, "crc32": crc,
                 "sha256": sha((res / name).read_bytes()),
                 "origin": "original upstream MIX" if name.endswith(".mix") else "native RA2 presentation restoration"}
                for name, crc in manifest["checksums"].items()]
    write_json(deployment / "resource-receipt.json", receipts)
    release_meta = json.loads((deployment / "release.json").read_text())
    release_meta.update(assetVersion=BUILD, runtimeModified=True, gameplayModified=False,
                        presentationCleaned=True, presentationManifest="presentation.json")
    write_json(deployment / "release.json", release_meta)
    shutil.copy2(__file__, deployment / "neutralize-ui.py")
    shutil.copy2(HERE / "build-release.py", deployment / "build-release.py")
    if (HERE / "transcode-menu.cjs").exists():
        shutil.copy2(HERE / "transcode-menu.cjs", deployment / "transcode-menu.cjs")

    for name, crc in manifest["checksums"].items():
        assert zlib.crc32((res / name).read_bytes()) == crc, name
    for name, entry in version["files"].items():
        path = release / name
        if path.is_file():
            assert sri(path.read_bytes()) == entry["integrity"], name
    assert "王二火大" not in index.read_text()
    for name in ["vendor.js"]:
        assert (release / "js" / name).read_bytes() == original_js[name]
    hashes = {str(p.relative_to(release)): {"bytes": p.stat().st_size, "sha256": sha(p.read_bytes())}
              for p in sorted(release.rglob("*")) if p.is_file() and p != deployment / "files-sha256.json"}
    write_json(deployment / "files-sha256.json", hashes)
    print(json.dumps({"build": BUILD, "files": len(hashes), "resources": len(receipts), "mixArchivesModified": False}))


if __name__ == "__main__":
    apply(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(),
          Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else HERE / "neutral-assets")
    subprocess.run([sys.executable, str(HERE / "customize-site.py"), sys.argv[1]], check=True)
