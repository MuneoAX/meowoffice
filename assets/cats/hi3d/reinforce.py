"""완성된 lo 메쉬를 제자리에서 보강한다 (rebuild.run 을 다시 돌리지 않는다 → UV·굽기·품종 텍스처 그대로).

목적: 네 발 걷기(walk4)·낚시 자세에서 어깨가 직각으로 솟거나, 턱 아래 목이 접히거나, 엉덩이가 납작해지는 것을 줄인다.
- 형상은 바꾸지 않는다: 면을 '그대로 나누기'(모서리 중간점, 부드럽게 하지 않음)만 한다 → UV·가중치는 보간된다.
- 나머지는 가중치만 고친다 (목: 머리↔목↔가슴, 어깨: 가슴↔위팔 + 이웃 섞기, 엉덩이: 허벅지→엉덩이뼈).
사용: import reinforce; reinforce.run('standard')   (한 번만. 이미 했으면 건너뜀)
"""
import math

import bpy
import bmesh

FACE_CELLS = {16, 10, 5, 6, 8, 15}  # 수염, 귀(바깥·안), 코, 눈동자, 입 — 나누지 않는다


def ss(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def _bones(rig):
    return {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in rig.data.bones}


def subdivide(ob, zlo, zhi, xmax):
    """턱 아래~목 띠(z 구간, |x|<xmax)의 면을 한 번 '그대로' 나눈다 (모서리 중간점만, 부드럽게 하지 않음 → 형상·UV 그대로, 가중치 보간).
    얼굴 칸(코·눈동자·입·수염·귀)·데칼 면과 맞닿은 모서리는 나누지 않는다. 반환: (전 삼각형 수, 후 삼각형 수)"""
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me)
    cl = bm.faces.layers.int['cell']
    dl = bm.faces.layers.int.get('decal')
    before = sum(len(f.verts) - 2 for f in bm.faces)
    edges = set()
    for f in bm.faces:
        c = f.calc_center_median()
        if zlo < c.z < zhi and abs(c.x) < xmax:
            edges.update(f.edges)
    bad = lambda f: f[cl] in FACE_CELLS or (dl and f[dl])
    edges = [e for e in edges if not any(bad(lf) for lf in e.link_faces)]
    bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True, use_only_quads=False)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bm.to_mesh(me); bm.free(); me.update()
    return before, sum(len(p.vertices) - 2 for p in me.polygons)


def _nbrs(me):
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
    n = {v.index: [e.other_vert(v).index for e in v.link_edges] for v in bm.verts}
    bm.free()
    return n


def _get(ob):
    me = ob.data
    names = {g.index: g.name for g in ob.vertex_groups}
    return {v.index: {names[g.group]: g.weight for g in v.groups} for v in me.vertices}, names


def _put(ob, W, ids):
    idx = {g.name: g.index for g in ob.vertex_groups}
    for i in ids:
        for g in ob.vertex_groups:
            g.remove([i])
        top = sorted(W[i].items(), key=lambda t: -t[1])[:4]
        t = sum(w for _, w in top) or 1
        for n, w in top:
            if w / t > 0.005:
                ob.vertex_groups[idx[n]].add([i], w / t, 'REPLACE')


def _smooth(W, ids, nbrs, repeat, k, lock=()):
    ids = [i for i in ids if i not in lock]
    for _ in range(repeat):
        new = {}
        for i in ids:
            acc = {}
            ns = nbrs[i] + [i]
            for j in ns:
                for g, w in W[j].items():
                    acc[g] = acc.get(g, 0) + w
            n = len(ns)
            mix = {g: W[i].get(g, 0) * (1 - k) + acc.get(g, 0) / n * k for g in set(W[i]) | set(acc)}
            top = sorted(mix.items(), key=lambda t: -t[1])[:4]
            t = sum(w for _, w in top) or 1
            new[i] = {g: w / t for g, w in top}
        W.update(new)


def neck_weights(ob, rig, cfg):
    """턱 아래~가슴: z 에 따라 가슴→목→머리로 매끈하게 넘긴다 (부분 합 1). 얼굴 칸 정점·귀는 머리 100% 유지."""
    me = ob.data
    B = _bones(rig)
    c0 = B['chest'][0].z + cfg.get('n0', 0.0)  # 이 아래는 기존
    ch = B['chest'][1].z; nh = B['neck'][1].z; hh = B['head'][0].z
    z0, z1, z2, z3 = cfg['z']  # 가슴 100% 끝 / 머리 시작 / 가슴 0% / 머리 100%
    W, names = _get(ob)
    cells = me.attributes['cell'].data
    face_v = set()
    for p in me.polygons:
        if cells[p.index].value in FACE_CELLS:
            face_v.update(p.vertices)
    ids = []
    for v in me.vertices:
        i = v.index
        if i in face_v:
            continue
        ax = abs(v.co.x)
        w = W[i]
        if z3 <= v.co.z < hh + 0.25 and ax < 0.3 and w.get('neck', 0) > 0 and not any(n.startswith(('ear', 'upper_arm', 'forearm', 'hand')) for n in w):
            # 기존 규칙이 머리 칸 위쪽 가장자리까지 목을 섞어 두어 경계가 톱니처럼 보이던 곳: 머리 100%
            W[i] = {'head': 1.0}
            ids.append(i)
            continue
        if ax > cfg['xmax'] or not (z0 - 0.05 < v.co.z < z3 + 0.01):
            continue
        if sum(w.get(n, 0) for n in ('upper_arm.L', 'upper_arm.R', 'forearm.L', 'forearm.R', 'hand.L', 'hand.R')) > 0.3:
            continue
        head = ss((v.co.z - z1) / (z3 - z1))
        chest = (1 - head) * (1 - ss((v.co.z - z0) / (z2 - z0)))
        neck = 1 - head - chest
        # 기존 몸통 가중치(척추·엉덩이)가 섞여 있으면 가슴 몫에 합친다
        W[i] = {'head': head, 'neck': neck, 'chest': chest}
        ids.append(i)
    nb = _nbrs(me)
    _smooth(W, ids, nb, cfg.get('rep', 4), 0.5, lock=())
    _put(ob, W, ids)
    return len(ids)


def shoulder_weights(ob, rig, cfg):
    """어깨~겨드랑이: 가슴→위팔을 넓은 구간에 걸쳐 매끈하게(앞·위·뒤 모두), 그 뒤 이웃 섞기.
    cfg: x0, x1 (|x| 구간), z0, z1, rep, k. 머리·목 정점은 건드리지 않는다."""
    me = ob.data
    W, names = _get(ob)
    nb = _nbrs(me)
    x0, x1, z0, z1 = cfg['box']
    ids = []
    for v in me.vertices:
        ax = abs(v.co.x)
        w = W[v.index]
        if w.get('head', 0) + w.get('neck', 0) >= 0.3:
            continue
        if x0 < ax < x1 and z0 < v.co.z < z1:
            ids.append(v.index)
    _smooth(W, ids, nb, cfg['rep'], cfg['k'])
    _put(ob, W, ids)
    return len(ids)


def rump_weights(ob, rig, cfg):
    """엉덩이: 허리 위 엉덩이 살은 허벅지(·정강이·발)가 아니라 엉덩이뼈를 따르게 한다. 허벅지 끝으로 갈수록 허벅지를 서서히.
    cfg: z_t0 (이 아래는 허벅지 원래대로), z_t1 (이 위는 허벅지 0), ymin (이보다 뒤 정점만), rep"""
    me = ob.data
    W, names = _get(ob)
    nb = _nbrs(me)
    ids = []
    for v in me.vertices:
        i = v.index
        w = W[i]
        leg = sum(x for n, x in w.items() if n.startswith(('thigh', 'shin', 'foot')))
        if leg <= 0.0:
            continue
        # 몸통 쪽(안쪽 위)일수록 허벅지 몫을 엉덩이로: 높이 + 뒤쪽일수록
        f = ss((v.co.z - cfg['z_t0']) / (cfg['z_t1'] - cfg['z_t0']))
        f = max(f, cfg.get('back', 0.0) * ss((v.co.y - cfg['ymin']) / 0.08) * ss((v.co.z - cfg['z_t0'] + 0.05) / 0.06))
        if f <= 0.001:
            continue
        mv = 0.0
        for n in [n for n in w if n.startswith(('thigh', 'shin', 'foot'))]:
            d = w[n] * f
            w[n] -= d; mv += d
        w['hips'] = w.get('hips', 0) + mv
        ids.append(i)
    _smooth(W, ids, nb, cfg.get('rep', 3), 0.4)
    _put(ob, W, ids)
    return len(ids)


def run(body):
    """한 체형 보강. 이미 했으면 건너뜀. (rebuild.CFG 의 lo·rig·shoulder 를 쓴다)"""
    import rebuild
    c = rebuild.CFG[body]
    ob = bpy.data.objects[c['lo']]; rig = bpy.data.objects[c['rig']]
    if ob.get('reinforced'):
        return 'skip'
    B = _bones(rig)
    nz = B['neck'][0].z; hz = B['head'][0].z
    out = {}
    out['tris'] = subdivide(ob, hz - 0.05, hz + 0.02, 0.14)
    # 머리 100% 가 되는 높이: 주둥이(코·입 볼록) 아래 가장자리 밑 — 얼굴이 끌려 내려가거나 가장자리가 톱니처럼 들쭉날쭉해지지 않게
    sn = c.get('snout')
    z3 = max(nz + 0.05, min(hz + 0.05, sn['cz'] - sn['rz'] - 0.005)) if sn else hz + 0.05
    out['neck'] = neck_weights(ob, rig, dict(z=(nz - 0.09, nz - 0.03, hz - 0.02, z3), xmax=0.22, rep=4))
    sx0, sx1, sz0, sz1 = c['shoulder']
    out['shoulder'] = shoulder_weights(ob, rig, dict(box=(sx0 - 0.06, sx1 + 0.05, sz0 - 0.06, sz1 + 0.05), rep=6, k=0.5))
    th = B['thigh.L'][0].z
    out['rump'] = rump_weights(ob, rig, dict(z_t0=th - 0.09, z_t1=th + 0.01, ymin=B['hips'][0].y + 0.03, back=0.8, rep=3))
    ob['reinforced'] = 1
    return out
