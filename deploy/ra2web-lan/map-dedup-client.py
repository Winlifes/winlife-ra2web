"""Apply the verified standard-mode map-list merge to the native client."""
import re

def patch_client(text, store_entry):
    assert re.fullmatch(r'map-editor/map-store-[a-f0-9]{16}\.mjs', store_entry)
    hook = 'await wl.deduplicateNativeMaps(n,o)'
    if hook not in text:
        before = 'for(const entry of await wl.listGameMaps())o.addFromMapFile({filename:entry.file,readAsString:()=>wl.registrationText(entry)})'
        assert text.count(before) == 1
        text = text.replace(before, before + ';const wlContentDedupResult=' + hook + ';console.info("Winlife map content dedup",JSON.stringify(wlContentDedupResult))', 1)
    assert text.count(hook) == 1
    pattern = r'import\("/map-editor/map-store(?:-[a-f0-9]{16})?\.mjs(?:\?v=workshop1)?"\)'
    text, count = re.subn(pattern, lambda _: 'import("/' + store_entry + '")', text)
    assert count == 2, count
    return text
