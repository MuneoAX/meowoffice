"""꼬리 뿌리 옮기기 (Blender 안, 제자리 후처리 — rebuild.run()·reinforce 를 다시 돌리지 않는다).
엉덩이 맨 아래에서 꼬리가 나오도록, 꼬리 쪽 정점과 꼬리 뼈(tail_01~04)를 함께 아래로 옮긴다.
 - 꼬리 정점: 꼬리 뼈 사슬을 따라가며 옮김량이 줄어든다 (taper = 사슬 위치 s 가 이 값에 이르면 0, None 이면 꼬리 전체를 통째로)
 - 엉덩이 쪽 이웃 정점: 꼬리 뿌리 점에서 반지름 R 안은 거리에 따라 부드럽게 줄어드는 만큼만 따라옴 → 이음매 면이 뿔처럼 늘어나지 않는다
 - stretch: 꼬리 마디 길이 배율 (짧은다리형 꼬리를 늘림). 뼈도 같은 배율로 늘어난다
 - 접힌귀형은 꼬리 면이 가슴·머리 뼈에 묶여 있었다 → 꼬리 정점 가중치를 사슬 위치에 맞춰 이웃한 두 꼬리 뼈 (+시작은 엉덩이) 로 다시 묶는다
UV·면 연결은 그대로 (정점 위치만 옮김). 늘이기는 앞뒤·좌우로만 (높이 유지).
사용(Blender): exec(open('.../move_tail_root.py', encoding='utf-8').read()); move('foldear')
"""
import bpy
import numpy as np
from mathutils import Vector

CF = {'standard': ('std_lo', 'cat_rig'), 'foldear': ('fold_lo', 'fold_rig'),
      'longhair': ('long_lo', 'long_rig'), 'shortleg': ('short_lo', 'short_rig')}
PARAM = {
    'standard': dict(delta=(0, 0.0, -0.07), taper=2.0, R=0.10),
    'foldear': dict(delta=(0, -0.05, -0.12), taper=None, R=0.12, reweight=True, ymin=0.105, cd=0.085, junction=(0.10, 0.08, 0.2, 0.4)),
    'longhair': dict(delta=(0, 0.0, -0.05), taper=2.0, R=0.10),
    'shortleg': dict(delta=(0, 0.0, -0.015), taper=2.0, R=0.08, stretch=1.45),
}
TAILS = ['tail_01', 'tail_02', 'tail_03', 'tail_04']


def sstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def chain_of(rig):
    b = rig.data.bones
    pts = [np.array(b[n].head_local[:]) for n in TAILS]
    pts.append(np.array(b['tail_04'].tail_local[:]))
    return pts


def project(P, ch):
    """각 정점의 가장 가까운 마디(k)·마디 위 위치(t, 0~1 clamp)·원시 t·거리"""
    n = len(P)
    best = np.full(n, 9.0); K = np.zeros(n, int); T = np.zeros(n); TR = np.zeros(n)
    for k in range(len(ch) - 1):
        ab = ch[k + 1] - ch[k]
        tr = ((P - ch[k]) @ ab) / (ab @ ab)
        t = np.clip(tr, 0, 1)
        d = np.linalg.norm(P - (ch[k] + t[:, None] * ab), axis=1)
        m = d < best
        best[m] = d[m]; K[m] = k; T[m] = t[m]; TR[m] = tr[m]
    return K, T, TR, best


def move(body, dry=False):
    lo, rg = CF[body]
    c = PARAM[body]
    o = bpy.data.objects[lo]; rig = bpy.data.objects[rg]
    me = o.data
    P = np.array([v.co[:] for v in me.vertices], np.float64)
    names = {g.index: g.name for g in o.vertex_groups}
    dom = [names[max(v.groups, key=lambda g: g.weight).group] if v.groups else None for v in me.vertices]
    ch = chain_of(rig)
    K, T, TR, dmin = project(P, ch)
    S = K + T  # 사슬 위치 0~4
    if c.get('reweight'):
        tail = (dmin < c['cd']) & (P[:, 1] > c['ymin'])
    else:
        tail = np.array([d is not None and d.startswith('tail') for d in dom])
    # 1) 늘이기: 마디 길이 배율 (원래 방향 유지)
    k = c.get('stretch', 1.0)
    ch2 = [ch[0]]
    sc = np.array([k, k, 1.0])  # 앞뒤·좌우로만 늘임 (높이는 그대로 → 바닥을 파고들지 않음)
    for i in range(4):
        ch2.append(ch2[-1] + (ch[i + 1] - ch[i]) * sc)
    P2 = P.copy()
    if k != 1.0:
        for v in np.where(tail)[0]:
            a, t = K[v], T[v]
            p0 = ch[a] + t * (ch[a + 1] - ch[a]); p1 = ch2[a] + t * (ch2[a + 1] - ch2[a])
            P2[v] = P[v] - p0 + p1
    # 2) 아래로 옮기기
    delta = np.array(c['delta'], np.float64)
    c0 = ch[0]
    f = sstep(1 - np.linalg.norm(P - c0, axis=1) / c['R'])  # 엉덩이 쪽: 꼬리 뿌리 점에서 멀어질수록 줄어듦
    jn = np.zeros(len(P), bool)
    if c.get('junction'):
        # 꼬리가 등 뒤쪽에서 갈라져 나오는 Y 이음매(팔꿈치) 정점은 꼬리와 함께 통째로 옮기고, 그 위아래 몸 면은 거리에 따라 줄여 이어준다
        yj, xj, z0, z1 = c['junction']
        jn = ~tail & (P[:, 1] > yj) & (np.abs(P[:, 0]) < xj) & (P[:, 2] > z0) & (P[:, 2] < z1)
        J = np.where(tail | jn)[0]
        dj = np.min(np.linalg.norm(P[:, None, :] - P[J][None, :, :], axis=2), axis=1)
        f = np.maximum(f, sstep(1 - dj / c['R']))
        f[jn] = 1.0
    if c['taper'] is None:
        ft = np.ones(len(P))
    else:
        ft = sstep(1 - S / c['taper'])
    f = np.where(tail, np.maximum(ft, f), f)
    P3 = P2 + f[:, None] * delta
    P3[:, 2] = np.maximum(P3[:, 2], np.minimum(P[:, 2], 0.004))  # 바닥 밑으로 내려가지 않게
    # 뼈 새 위치: 사슬 점 i 도 같은 규칙 (사슬 위치 s = i)
    def fch(s):
        return 1.0 if c['taper'] is None else float(sstep(1 - s / c['taper']))
    ch3 = [ch2[i] + fch(i) * delta for i in range(5)]
    ch3[4] = ch2[4] + fch(4.0) * delta
    info = dict(body=body, tail_verts=int(tail.sum()), moved=int((f > 0.01).sum()), max_move=float(np.linalg.norm(P3 - P, axis=1).max()),
                bones=[tuple(np.round(p, 3)) for p in ch3])
    if dry:
        return info
    # 뼈 (사슬은 서로 이어진 뼈들) — 먼저 옮겨 실패하면 정점은 그대로 남게
    rig.hide_set(False)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    for n in TAILS:
        eb[n].use_connect = False
    for i, n in enumerate(TAILS):
        # 뼈 방향·굴림은 그대로 (게임 코드가 꼬리 마디 회전을 기본 자세 기준으로 써 둔 각도가 맞아야 함), 머리 위치만 새 사슬로, 길이는 새 마디 길이
        vec = Vector((ch[i + 1] - ch[i]).tolist()); vec.normalize()
        roll = eb[n].roll
        eb[n].head = Vector(ch3[i].tolist()); eb[n].tail = Vector(ch3[i].tolist()) + vec * float(np.linalg.norm(ch3[i + 1] - ch3[i]))
        eb[n].roll = roll
    bpy.ops.object.mode_set(mode='OBJECT')
    for v, p in zip(me.vertices, P3):
        v.co = Vector(p.tolist())
    me.update()
    # 이음매 정점은 엉덩이 뼈로 (몸 면이 가슴·허리에 묶여 있으면 허리를 젖힐 때 꼬리 뿌리가 찢어진다)
    if jn.any():
        hips = o.vertex_groups['hips']
        for v in np.where(jn)[0]:
            for g in o.vertex_groups:
                g.remove([int(v)])
            hips.add([int(v)], 1.0, 'REPLACE')
    # 3) 접힌귀형: 꼬리 정점 가중치 다시
    if c.get('reweight'):
        P4 = np.array([v.co[:] for v in me.vertices], np.float64)
        K4, T4, TR4, d4 = project(P4, ch3)
        S4 = np.minimum(K4 + T4, 3.0)
        ids = {n: o.vertex_groups[n] for n in TAILS + ['hips']}
        for v in np.where(tail)[0]:
            s = S4[v]
            w = {}
            for i in range(4):
                x = max(0.0, 1 - abs(s - i)) if s < 3 else (1.0 if i == 3 else 0.0)
                if i == 0 and s < 1: x = min(1.0, s / 0.8)  # 몸에서 나오는 쪽은 엉덩이 뼈에서 꼬리 뼈로 서서히
                if x > 0: w[TAILS[i]] = x
            h = max(0.0, 1 - s / 0.8)
            if h > 0: w['hips'] = h
            tot = sum(w.values())
            for g in o.vertex_groups:
                g.remove([int(v)])
            for n, ww in w.items():
                ids[n].add([int(v)], ww / tot, 'REPLACE')
    return info


def fix_fold_gray(skin_png, box=(0.497, 0.538, 0.324, 0.380)):
    """접힌귀형 꼬리 뿌리의 회색 조각: UV 가 텍스처의 회색 빈 네모(꼬리 첫 마디 근처 작은 섬)에 걸린 면 20개.
    그 면 꼭짓점의 UV 를 가장 가까운(3차원) 정상 색 영역 꼭짓점의 UV 로 바꿔 이웃 털색과 이어 붙인다 (섬 경계는 그대로 이웃 UV 가 되어 이음매 없음).
    skin_png: 접힌귀형 피부 텍스처 (회색 칸 확인용)"""
    o = bpy.data.objects['fold_lo']; me = o.data; uv = me.uv_layers.active.data
    img = bpy.data.images.load(skin_png, check_existing=True)
    W, H = img.size
    px = np.array(img.pixels[:], np.float32).reshape(H, W, 4)

    def col(u, v):
        return px[min(H - 1, max(0, int(v * H))), min(W - 1, max(0, int(u * W))), :3]

    def gray(c):
        return abs(c[0] - c[1]) < 0.03 and abs(c[1] - c[2]) < 0.03 and 0.5 < c[0] < 0.7

    def good(c):  # 회색도 거의 흰색(배 털)도 아닌, 꼬리 털색
        return not gray(c) and c.min() < 0.85
    x0, x1, y0, y1 = box
    isl = set()
    for p in me.polygons:
        u = np.array([uv[l].uv[:] for l in p.loop_indices])
        if u[:, 0].min() > x0 and u[:, 0].max() < x1 and u[:, 1].min() > y0 and u[:, 1].max() < y1 and gray(col(*u.mean(0))):
            isl.add(p.index)
    V = np.array([v.co[:] for v in me.vertices])
    pool, pu, il = [], [], []
    for p in me.polygons:
        for l in p.loop_indices:
            if p.index in isl:
                il.append((l, me.loops[l].vertex_index))
            else:
                u = uv[l].uv[:]
                if good(col(*u)) and V[me.loops[l].vertex_index][1] > 0.085:  # 꼬리·이음매 쪽 색만
                    pool.append(me.loops[l].vertex_index); pu.append(u)
    pool = np.array(pool); pu = np.array(pu)
    for l, vi in il:
        k = np.linalg.norm(V[pool] - V[vi], axis=1).argmin()
        uv[l].uv = pu[k].tolist()
    return len(isl)
