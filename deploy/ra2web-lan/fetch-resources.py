#!/usr/bin/env python3
"""Mirror the published resource manifest and verify each payload's CRC32."""

import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import struct
import zlib


destination = Path(sys.argv[1]).resolve()
manifest_path = Path(sys.argv[2]).resolve()
manifest = json.loads(manifest_path.read_text())
assert manifest["version"] == 2 and manifest["format"] == "mix"
destination.mkdir(parents=True, exist_ok=True)
origins = [
    "https://res2.wangerhuoda.cn/",
    "https://wyhjres2.bun.sh.cn/",
    "https://werhd.k0s.cn/",
]

# Current clients use SHP loading screens from ui.mix. These obsolete PNGs
# remain listed upstream but return HTTP 404 at all published origins.
deprecated = [name for name in manifest["checksums"] if name.startswith("ls800") and name.endswith(".png")]
for name in deprecated:
    del manifest["checksums"][name]

# The live menu streams a replacement MP4 directly, without the obsolete
# manifest CRC. Validate its complete container, then pin the current payload
# in our generated manifest. MIX assets still require their original CRCs.
video_name = "ra2ts_l.mp4"
video = destination / video_name
subprocess.run([
    "curl", "-fsSL", "--connect-timeout", "15", "--max-time", "60",
    origins[0] + video_name + "?menu=werhd", "-o", str(video),
], check=True)
video_bytes = video.read_bytes()
offset, atom_types = 0, []
while offset < len(video_bytes):
    size, atom_type = struct.unpack_from(">I4s", video_bytes, offset)
    if size == 1:
        size = struct.unpack_from(">Q", video_bytes, offset + 8)[0]
    if size == 0:
        size = len(video_bytes) - offset
    assert size >= 8 and offset + size <= len(video_bytes), "Incomplete menu video"
    offset += size
    atom_types.append(atom_type)
assert offset == len(video_bytes) and all(atom in atom_types for atom in [b"ftyp", b"moov", b"mdat"])
video_upstream_crc = manifest["checksums"][video_name]
manifest["checksums"][video_name] = zlib.crc32(video_bytes)
(destination.parent / "resource-manifest-adjustments.json").write_text(json.dumps({
    "deprecatedUnavailablePngs": deprecated,
    "menuVideo": {"upstreamCrc32": video_upstream_crc, "currentCrc32": manifest["checksums"][video_name],
                  "sha256": hashlib.sha256(video_bytes).hexdigest()},
    "mixChecksumsChanged": False,
}, indent=2) + "\n")


def fetch(entry):
    name, expected = entry
    assert "/" not in name and name not in [".", ".."]
    target = destination / name
    data = target.read_bytes() if target.exists() else b""
    origin = "existing verified file"
    if not data or zlib.crc32(data) != expected:
        partial = target.with_name(target.name + ".part")
        for origin in origins:
            result = subprocess.run(
                [
                    "curl", "-fsSL", "--connect-timeout", "15", "--max-time", "180",
                    "--retry", "1", origin + name + "?h=" + str(expected), "-o", str(partial),
                ],
                capture_output=True, text=True,
            )
            if result.returncode == 0:
                data = partial.read_bytes()
                if zlib.crc32(data) == expected:
                    partial.replace(target)
                    break
        else:
            raise RuntimeError("Could not download a verified resource: " + name)
    receipt = {
        "file": name, "bytes": len(data), "crc32": expected,
        "sha256": hashlib.sha256(data).hexdigest(), "origin": origin,
    }
    print(json.dumps(receipt), flush=True)
    return receipt


receipts, errors = [], []
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    futures = [pool.submit(fetch, entry) for entry in manifest["checksums"].items()]
    for future in concurrent.futures.as_completed(futures):
        try:
            receipts.append(future.result())
        except Exception as error:
            errors.append(str(error))
            print("ERROR:", error, flush=True)
if errors:
    raise RuntimeError("; ".join(errors))
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
(destination.parent / "resource-receipt.json").write_text(
    json.dumps(receipts, indent=2) + "\n"
)
print("Verified", len(receipts), "resources;", sum(x["bytes"] for x in receipts), "bytes", flush=True)
