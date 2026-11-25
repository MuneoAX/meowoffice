"""크리스마스 트리용 전나무 만들기: Poly Haven 'Fir Sapling Medium'(CC0) glTF → 가벼운 glb + 잎 텍스처.

  python scripts/build-xmas-fir.py <내려받은 폴더>
    <폴더>/fir_sapling_medium_1k.gltf, fir_sapling_medium.bin, textures/*_twigs_diff_1k.jpg, *_twigs_alpha_1k.jpg

하는 일
  - 세 그루 가운데 a(가장 키 크고 날씬한 것)만 쓴다. 죽은 가지는 뺀다.
  - 가지 숱을 늘리려고 같은 나무를 줄기 둘레로 돌려 세 번 겹친다(COPIES).
  - 잎(twigs)은 알파 카드 67만 삼각형이라 카드(이어진 조각) 단위로 솎아 내고(KEEP 비율), 남은 카드는 제 중심에서 키워 빈틈을 메운다.
  - 높이 HEIGHT(m)로 맞추고 줄기 밑동을 원점에 둔다.
  - 결과: assets/src3d/models/props/xmas_fir.glb (메시 xmasFirWood·xmasFirNeedles, 재질 없음 — 재질은 xmastree.js 가 입힌다),
          assets/src3d/models/props/xmas_fir_needles.png (색 + 알파). 이어서 npm run optimize-assets -- --only xmas_fir
필요: numpy, Pillow
"""
import json, os, struct, sys
import numpy as np
from PIL import Image

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'src3d', 'models', 'props')
VARIANT, HEIGHT, TARGET_TRIS, GROW_MAX, SEED = 0, 4.3, 210000, 3.0, 7
SLIM = 1.0  # 가로(xz) 배율: 1 = 원본 비율 그대로(변형 없음)

g = json.load(open(os.path.join(SRC, 'fir_sapling_medium_1k.gltf')))
blob = open(os.path.join(SRC, 'fir_sapling_medium.bin'), 'rb').read()

def acc(i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]
    ct = {5123: np.uint16, 5125: np.uint32, 5126: np.float32}[a['componentType']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    return np.frombuffer(blob, ct, a['count'] * n, off).reshape(-1, n).copy()

def prim(p):
    at = p['attributes']
    return acc(p['indices']).reshape(-1, 3).astype(np.int64), acc(at['POSITION']), acc(at['NORMAL']), acc(at['TEXCOORD_0'])

prims = g['meshes'][VARIANT]['primitives']
wi, wp, wn, wuv = prim(prims[0])
ti, tp, tn, tuv = prim(prims[1])

# 잎 카드 = 인덱스로 이어진 조각. 합집합 찾기(경로 압축)로 조각 번호를 매긴다.
par = np.arange(len(tp))
def find(x):
    r = x
    while par[r] != r: r = par[r]
    while par[x] != r: par[x], x = r, par[x]
    return r
for a, b, c in ti:
    ra, rb, rc = find(a), find(b), find(c)
    m = min(ra, rb, rc); par[ra] = m; par[rb] = m; par[rc] = m
root = np.array([find(i) for i in range(len(tp))])
ids, comp = np.unique(root, return_inverse=True)
tri_comp = comp[ti[:, 0]]
tris_per = np.bincount(tri_comp, minlength=len(ids))
print('잎 카드', len(ids), '개, 카드당 삼각형', tris_per.mean().round(1), '원래 삼각형', len(ti))

# 가지 수 늘리기: 같은 나무를 줄기 둘레로 돌려 COPIES 번 겹친다(가지 모양은 그대로, 각도·크기만 조금씩 다르게). 벌마다 다른 카드를 남긴다.
COPIES = [(0.0, 1.0), (2.2, 0.95), (4.3, 0.9)]  # (돌림 rad, 크기 배율)
lo0 = wp[wp[:, 1] < wp[:, 1].min() + 0.03 * np.ptp(wp[:, 1])]
axis = np.array([lo0[:, 0].mean(), wp[:, 1].min(), lo0[:, 2].mean()])  # 줄기 밑동
keep_frac = min(1.0, TARGET_TRIS / len(ti) / len(COPIES))
grow = min(GROW_MAX, 1.25 * (1 / keep_frac / len(COPIES)) ** 0.5 * 1.3)  # 넓이 보전보다 조금 더 키워 풍성하게
cent = np.zeros((len(ids), 3)); np.add.at(cent, comp, tp); cent /= np.bincount(comp, minlength=len(ids))[:, None]
grown = cent[comp] + (tp - cent[comp]) * grow
def turn(v, ang, k, point=True):
    c, s_ = np.cos(ang), np.sin(ang)
    d = (v - axis) if point else v
    out = np.stack([d[:, 0] * c + d[:, 2] * s_, d[:, 1], -d[:, 0] * s_ + d[:, 2] * c], 1)
    return out * k + axis if point else out
rng = np.random.default_rng(SEED)
W = [[], [], [], []]; T = [[], [], [], []]; wo = to = 0
for ang, k in COPIES:
    keep = rng.random(len(ids)) < keep_frac
    f = ti[keep[tri_comp]]
    used = np.unique(f); remap = -np.ones(len(tp), np.int64); remap[used] = np.arange(len(used))
    T[0].append(remap[f] + to); T[1].append(turn(grown[used], ang, k)); T[2].append(turn(tn[used], ang, 1, False)); T[3].append(tuv[used]); to += len(used)
    W[0].append(wi + wo); W[1].append(turn(wp, ang, k)); W[2].append(turn(wn, ang, 1, False)); W[3].append(wuv); wo += len(wp)
ti2, tp2, tn2, tuv2 = [np.concatenate(x) for x in T]
wi, wp, wn, wuv = [np.concatenate(x) for x in W]
print('남긴 비율', round(keep_frac, 3), '키움', round(grow, 2), '겹침', len(COPIES), '→ 잎 삼각형', len(ti2), '정점', len(tp2), '가지 삼각형', len(wi))

# 크기·자리: 줄기 밑동(아래 3% 정점의 가운데)을 원점으로, 전체 높이를 HEIGHT 로
lo = wp[wp[:, 1] < wp[:, 1].min() + 0.03 * np.ptp(wp[:, 1])]
base = np.array([lo[:, 0].mean(), wp[:, 1].min(), lo[:, 2].mean()])
top = max(wp[:, 1].max(), tp2[:, 1].max())
k = HEIGHT / (top - base[1])
sc = np.array([k * SLIM, k, k * SLIM])
wp2 = (wp - base) * sc; tp2 = (tp2 - base) * sc
print('배율', round(k, 3), '폭', np.ptp(tp2[:, 0]).round(2), np.ptp(tp2[:, 2]).round(2), '높이', tp2[:, 1].max().round(2))

def write_glb(path, meshes):
    bufs, views, accs, ms, nodes = [], [], [], [], []
    off = 0
    def add(arr, target, typ, ct, minmax=False):
        nonlocal off
        b = arr.tobytes(); pad = (-len(b)) % 4
        views.append({'buffer': 0, 'byteOffset': off, 'byteLength': len(b), 'target': target})
        a = {'bufferView': len(views) - 1, 'componentType': ct, 'count': len(arr), 'type': typ}
        if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
        accs.append(a); bufs.append(b + b'\0' * pad); off += len(b) + pad
        return len(accs) - 1
    for name, idx, pos, nor, uv in meshes:
        at = {'POSITION': add(pos.astype(np.float32), 34962, 'VEC3', 5126, True), 'NORMAL': add(nor.astype(np.float32), 34962, 'VEC3', 5126), 'TEXCOORD_0': add(uv.astype(np.float32), 34962, 'VEC2', 5126)}
        ii = add(idx.astype(np.uint32).reshape(-1), 34963, 'SCALAR', 5125)
        ms.append({'name': name, 'primitives': [{'attributes': at, 'indices': ii}]}); nodes.append({'name': name, 'mesh': len(ms) - 1})
    js = {'asset': {'version': '2.0', 'generator': 'build-xmas-fir.py', 'copyright': 'Poly Haven Fir Sapling Medium (CC0), reduced'}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}],
          'nodes': nodes, 'meshes': ms, 'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': off}]}
    jb = json.dumps(js, separators=(',', ':')).encode(); jb += b' ' * ((-len(jb)) % 4)
    bb = b''.join(bufs)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(jb) + 8 + len(bb)))
        f.write(struct.pack('<I4s', len(jb), b'JSON')); f.write(jb)
        f.write(struct.pack('<I4s', len(bb), b'BIN\0')); f.write(bb)

os.makedirs(OUT, exist_ok=True)
write_glb(os.path.join(OUT, 'xmas_fir.glb'), [('xmasFirWood', wi, wp2, wn, wuv), ('xmasFirNeedles', ti2, tp2, tn2, tuv2)])
T = os.path.join(SRC, 'textures')
rgb = Image.open(os.path.join(T, 'fir_sapling_medium_twigs_diff_1k.jpg')).convert('RGB')
al = Image.open(os.path.join(T, 'fir_sapling_medium_twigs_alpha_1k.jpg')).convert('L')
rgb.putalpha(al); rgb.save(os.path.join(OUT, 'xmas_fir_needles.png'))
print('저장', os.path.getsize(os.path.join(OUT, 'xmas_fir.glb')), os.path.getsize(os.path.join(OUT, 'xmas_fir_needles.png')))

# 장식 달 자리용 겉모양: 높이 0.25m 칸마다 잎 정점의 바깥 반지름(75 백분위). xmastree.js 의 FIR_PROFILE 에 그대로 옮긴다.
rad = np.hypot(tp2[:, 0], tp2[:, 2])
prof = []
for y0 in np.arange(0.25, HEIGHT, 0.25):
    m = (tp2[:, 1] >= y0) & (tp2[:, 1] < y0 + 0.25)
    prof.append(round(float(np.percentile(rad[m], 75)), 2) if m.sum() > 20 else 0.0)
print('잎 시작 높이', tp2[:, 1].min().round(2), 'FIR_PROFILE(0.25m 부터 0.25m 간격) =', prof)
