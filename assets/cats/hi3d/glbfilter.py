"""glb 내보내기 뒤 후처리: 작업 파일에 동작(Action)이 5벌(원본+포즈 장면 복사본 .001~.004)이라 내보내기가 65개를 담는다 → 이름이 13개 기본 동작인 것만 남기고 안 쓰는 버퍼를 정리한다.
사용: python glbfilter.py ui/office/models/cats/cat_*.glb"""
import json, struct, sys
KEEP = {'idle','walk','carry','hold','sit','sit_type','sit_talk','drink','raise_hand','walk4','sleep','sit_up','groom'}
def run(path):
    d = open(path,'rb').read()
    l = struct.unpack('<I', d[12:16])[0]
    j = json.loads(d[20:20+l])
    off = 20 + l
    bl = struct.unpack('<I', d[off:off+4])[0]; bin_ = d[off+8:off+8+bl]
    j['animations'] = [a for a in j.get('animations', []) if a.get('name') in KEEP]
    used = set()
    for m in j['meshes']:
        for p in m['primitives']:
            used.update(p['attributes'].values())
            if 'indices' in p: used.add(p['indices'])
            for t in p.get('targets', []): used.update(t.values())
    for s in j.get('skins', []):
        if 'inverseBindMatrices' in s: used.add(s['inverseBindMatrices'])
    for a in j['animations']:
        for s in a['samplers']: used.update([s['input'], s['output']])
    order = sorted(used); amap = {o: n for n, o in enumerate(order)}
    acc = [j['accessors'][o] for o in order]
    usedbv = {a['bufferView'] for a in acc if 'bufferView' in a} | {i['bufferView'] for i in j.get('images', []) if 'bufferView' in i}
    bvorder = sorted(usedbv); bmap = {o: n for n, o in enumerate(bvorder)}
    nb = bytearray(); nbv = []
    for o in bvorder:
        bv = j['bufferViews'][o]
        while len(nb) % 4: nb.append(0)
        s = bv.get('byteOffset', 0); chunk = bin_[s:s+bv['byteLength']]
        nv = dict(bv); nv['byteOffset'] = len(nb); nb += chunk; nbv.append(nv)
    for a in acc:
        if 'bufferView' in a: a['bufferView'] = bmap[a['bufferView']]
    for i in j.get('images', []):
        if 'bufferView' in i: i['bufferView'] = bmap[i['bufferView']]
    for m in j['meshes']:
        for p in m['primitives']:
            p['attributes'] = {k: amap[v] for k, v in p['attributes'].items()}
            if 'indices' in p: p['indices'] = amap[p['indices']]
    for s in j.get('skins', []):
        if 'inverseBindMatrices' in s: s['inverseBindMatrices'] = amap[s['inverseBindMatrices']]
    for a in j['animations']:
        for s in a['samplers']: s['input'] = amap[s['input']]; s['output'] = amap[s['output']]
    j['accessors'] = acc; j['bufferViews'] = nbv
    while len(nb) % 4: nb.append(0)
    j['buffers'] = [{'byteLength': len(nb)}]
    js = json.dumps(j, separators=(',', ':')).encode()
    while len(js) % 4: js += b' '
    out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(nb)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(nb), 0x004E4942) + bytes(nb)
    open(path, 'wb').write(out)
    return len(j['animations']), len(out)
if __name__ == '__main__':
    for p in sys.argv[1:]: print(p, run(p))
