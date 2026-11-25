"""glb 의 꼬리 가중치 바로잡기 (제자리, Blender 없이).
접힌귀형 glb 는 꼬리 면 꼭짓점 대부분이 가슴·목·머리 뼈에 묶여 있어 꼬리 뼈를 움직여도 꼬리가 따라오지 않았다.
꼬리 뼈 사슬(tail_01~04) 가까이(반지름 R)에 있는 꼭짓점을, 사슬을 따라간 위치에 맞춰 이웃한 두 꼬리 뼈에 나눠 묶는다.
시작 부분은 엉덩이(hips)와 섞어 이음매를 부드럽게 한다. 형상·UV 는 그대로.
사용: python -X utf8 fix_tail_weights.py <glb> [R=0.055]
"""
import json, struct, sys
import numpy as np

path = sys.argv[1]
R = float(sys.argv[2]) if len(sys.argv) > 2 else 0.055
b = bytearray(open(path, 'rb').read())
jl = struct.unpack('<I', b[12:16])[0]
j = json.loads(b[20:20 + jl])
binoff = 20 + jl + 8
names = [j['nodes'][i]['name'] for i in j['skins'][0]['joints']]
pr = j['meshes'][0]['primitives'][0]


def view(i, dt, n):
    a = j['accessors'][i]
    bv = j['bufferViews'][a['bufferView']]
    off = binoff + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    return np.frombuffer(memoryview(b)[off:off + a['count'] * n * np.dtype(dt).itemsize], dt).reshape(-1, n)


P = view(pr['attributes']['POSITION'], np.float32, 3)
J = view(pr['attributes']['JOINTS_0'], np.uint8, 4)
W = view(pr['attributes']['WEIGHTS_0'], np.float32, 4)
a = j['accessors'][j['skins'][0]['inverseBindMatrices']]
bv = j['bufferViews'][a['bufferView']]
IBM = np.frombuffer(bytes(b[binoff + bv.get('byteOffset', 0) + a.get('byteOffset', 0):][:64 * a['count']]), np.float32).reshape(-1, 4, 4).transpose(0, 2, 1)
hp = {n: np.linalg.inv(IBM[i])[:3, 3] for i, n in enumerate(names)}
tails = ['tail_01', 'tail_02', 'tail_03', 'tail_04']
ch = [hp[n] for n in tails]
ch.append(ch[3] + (ch[3] - ch[2]) / np.linalg.norm(ch[3] - ch[2]) * 0.12)  # 꼬리 끝 뼈의 머리 너머 끝부분까지
dmin = np.full(len(P), 9.0)
s = np.zeros(len(P))
for k, (p0, p1) in enumerate(zip(ch[:-1], ch[1:])):
    ab = p1 - p0
    traw = ((P - p0) @ ab) / (ab @ ab)
    t = np.clip(traw, 0, 1)
    d = np.linalg.norm(P - (p0 + t[:, None] * ab), axis=1)
    m = d < dmin
    dmin[m] = d[m]
    s[m] = k + t[m]
    if k == 0: sraw0 = traw
zz = P[:, 2] * np.sign(ch[-1][2])
dom = J[np.arange(len(J)), W.argmax(1)]
wrong = np.isin(dom, [names.index(n) for n in ('chest', 'neck', 'head', 'spine')])  # 꼬리 쪽인데 윗몸 뼈에 묶인 꼭짓점은 범위를 조금 넓게
sel = np.where(((dmin < R) & (zz > abs(hp['tail_01'][2]) * 0.85)) | (wrong & (dmin < R * 1.5) & (zz > abs(hp['tail_01'][2]) * 0.7)))[0]
ids = [names.index(n) for n in tails]
hips = names.index('hips')
for v in sel:
    sv = min(s[v], 3.0)
    w = {}
    for i in range(4):
        x = max(0.0, 1 - abs(sv - i)) if sv < 3 else (1.0 if i == 3 else 0.0)
        if i == 0 and sv < 1: x = min(1.0, sv / 0.8)  # 꼬리가 몸에서 나오는 쪽은 엉덩이 뼈에서 꼬리 뼈로 서서히 넘어간다
        if x > 0: w[ids[i]] = x
    h = max(0.0, 1 - s[v] / 0.8) if (sraw0[v] < 0.8 and s[v] < 0.8) else 0.0
    if h > 0: w[hips] = h
    tot = sum(w.values())
    top = sorted(w.items(), key=lambda kv: -kv[1])[:4]
    J[v] = 0; W[v] = 0
    for q, (jj, ww) in enumerate(top):
        J[v, q] = jj; W[v, q] = ww / tot
    W[v] /= W[v].sum()
open(path, 'wb').write(b)
print(path, '꼬리 꼭짓점', len(sel), '바꿈')
