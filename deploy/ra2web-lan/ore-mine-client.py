"""Allow a map's native ore mines to replenish gems; legacy mines keep ore."""


def patch_client(text):
    changes = [
        ('this.spawnsTiberium=this.ini.getBool("SpawnsTiberium"),this.strength=',
         'this.spawnsTiberium=this.ini.getBool("SpawnsTiberium"),this.tiberiumToSpawn=this.ini.getNumber("TiberiumToSpawn",0),this.strength='),
        ('const o=Wm.calculateOverlayId(gr.Ore,n);if(o===void 0)throw new Error("Expected an overlayId");',
         'const o=Wm.calculateOverlayId(this.rules.tiberiumToSpawn??gr.Ore,n);if(o===void 0)throw new Error("Expected an overlayId");'),
    ]
    for before, after in changes:
        if after not in text:
            assert text.count(before) == 1, 'Native mine source changed: ' + before[:80]
            text = text.replace(before, after, 1)
        assert text.count(after) == 1
    return text
