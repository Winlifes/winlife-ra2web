"""Chinese display names; third-party source maps remain byte-identical."""
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent


def normalized(value):
    return re.sub(r"\s+", " ", re.sub(r"^\[\d+\]\s*", "", value).strip()).lower()


def dictionary():
    entries = {}
    for line in (HERE / 'chinese-titles.txt').read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        original, chinese = line.split('|', 1)
        key = normalized(original)
        assert key not in entries, original
        entries[key] = chinese
    return entries


def translate(title, entries):
    if re.search(r'[\u3400-\u9fff]', title):
        return title
    key, notes = normalized(title), []
    suffixes = [
        (r'\s+(?:-\s*)?le$', '竞赛版'),
        (r'\s+(?:-\s*)?yr$', '尤里版'),
        (r'\s+ra2$', '红警二版'),
        (r'\s+blitz\s+1v1$', '闪击一对一'),
        (r'\s+blitz\s+2vs2$', '闪击二对二'),
        (r'\s+1v1$', '一对一'),
        (r'\s+2v2$', '二对二'),
        (r'\s+v(\d+(?:\.\d+)*)$', None),
    ]
    while key not in entries:
        for pattern, note in suffixes:
            match = re.search(pattern, key)
            if match:
                notes.insert(0, note if note else match[1] + '版')
                key = key[:match.start()].strip()
                break
        else:
            raise ValueError('Missing Chinese map title: ' + title)
    return entries[key] + ('（' + '，'.join(notes) + '）' if notes else '')


def localize(release):
    release = Path(release)
    entries, titles, files = dictionary(), {}, {}
    for name in ['catalog.json', 'game-index.json']:
        path = release / 'maps' / name
        data = json.loads(path.read_text())
        for record in data['maps']:
            original = record.get('originalTitle', record['title'])
            chinese = translate(original, entries)
            if record.get('variantInfo'):
                record['baseTitle'] = chinese
                chinese += '（版本' + str(record['variantInfo']['index']) + '）'
            record.update(title=chinese, originalTitle=original)
            titles[normalized(original)] = chinese
            files[record['file'].lower()] = chinese
        data['displayLanguage'] = 'zh-CN'
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    # Also cover English names in the original MIX map manifests. Native
    # filename-based translations continue to work for existing Chinese names.
    titles = {**entries, **titles}
    names = dict(schemaVersion=1, language='zh-CN', files=files, titles=titles)
    (release / 'maps' / 'chinese-names.json').write_text(json.dumps(names, ensure_ascii=False, indent=2) + '\n')
    return names


def patch_client(text, names):
    marker = '/* winlife-chinese-map-titles */'
    start = text.find(marker)
    if start >= 0:
        end = text.index('/* end-winlife-chinese-map-titles */', start) + len('/* end-winlife-chinese-map-titles */')
        text = text[:start] + text[end:].lstrip('\n')
    definitions = marker + '\nconst wlChineseMapNames=' + json.dumps(names, ensure_ascii=False, separators=(',', ':')) + ';\n' + '''function wlChineseMapTitle(file,title){
const input=String(title||""),count=input.match(/\\s*[(（]\\s*\\d+(?:-\\d+)?\\s*[)）]\\s*$/),base=count?input.slice(0,count.index):input;
const key=base.replace(/^\\[\\d+\\]\\s*/,"").trim().replace(/\\s+/g," ").toLowerCase();
const chinese=wlChineseMapNames.files[String(file||"").toLowerCase()]||wlChineseMapNames.titles[key];
return chinese?chinese+(count?count[0]:""):input
}
/* end-winlife-chinese-map-titles */
'''
    before = 'return lZ(l??o,t)}let jb,cZ='
    after = 'return lZ(wlChineseMapTitle(s,l??o),t)}let jb,cZ='
    if before in text:
        assert text.count(before) == 1
        text = text.replace(before, after, 1)
    else:
        assert after in text
    text = text.replace('s.match(/(\\(|（)\\s*\\d(-\\d)?\\s*(\\)|）)\\s*$/)',
                        's.match(/(\\(|（)\\s*\\d+(-\\d+)?\\s*(\\)|）)\\s*$/)')
    return definitions + text


if __name__ == '__main__':
    import sys
    names = localize(sys.argv[1])
    print(json.dumps(dict(files=len(names['files']), titles=len(names['titles'])), ensure_ascii=False))
