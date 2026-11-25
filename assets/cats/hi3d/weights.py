"""고양이 메쉬 가중치 (4체형 공용 뼈대 cat_rig).

자동 가중치(열 분포)는 생성 모델처럼 닫히지 않은 메쉬에서 실패하므로 직접 넣는다.
- 부위마다 담당 뼈 후보를 정하고, 뼈 선분까지 거리의 4제곱 반비례로 섞는다 (최대 3개, 이후 4개로 제한·정규화).
- 눈·코·입·수염(팔레트 칸)은 머리 100%.
사용: run('cat_lo', 'cat_rig')
"""
import bpy
from mathutils.geometry import intersect_point_line

FACE_PARTS = {6, 8, 15, 16}  # 코, 눈동자, 입, 수염
EAR_PARTS = {5, 10}  # 귀 안쪽·바깥 (접힌귀형처럼 높이로 못 가르는 귀)
# 접힌귀형: 귀는 칸으로 판정, 꼬리는 위로 말림
# 일반형: 머리 아래 옆(볼 아래)이 팔 규칙에 걸리지 않게 경계를 낮춘다 (0.5 → 0.485)
L_STD = dict(head_z=0.455, ear_z=0.74, arm_x=0.15, arm_z=(0.32, 0.52), tail_y=0.09, leg_z=0.2, arm_top=0.485)
L_FOLD = dict(head_z=0.51, ear_z=2.0, ear_by_cell=True, arm_x=0.15, arm_z=(0.38, 0.53), arm_top=0.51, neck_top=0.57, arm_y=0.05,
              tail_y=0.13, tail_zmax=0.56, leg_z=0.16, leg_y=0.1)
L_SHORT = dict(head_z=0.425, ear_z=2.0, ear_by_cell=True, arm_x=0.16, arm_z=(0.3, 0.45), arm_top=0.43, neck_top=0.48, arm_y=0.0,
               tail_y=0.12, tail_zmax=0.2, leg_z=0.08, leg_y=0.1)
L_LONG = dict(head_z=0.5, ear_z=2.0, ear_by_cell=True, arm_x=0.2, arm_z=(0.38, 0.5), arm_top=0.5, neck_top=0.55, arm_y=0.0,
              tail_y=0.13, tail_zmax=0.25, leg_z=0.12, leg_y=0.05)


def run(obj_name, rig_name, L=None):
    L = L or dict(head_z=0.455, ear_z=0.74, arm_x=0.15, arm_z=(0.32, 0.52), tail_y=0.09, leg_z=0.2)
    lo = bpy.data.objects[obj_name]; rig = bpy.data.objects[rig_name]; me = lo.data
    bones = {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in rig.data.bones}

    def seg_dist(p, name):
        h, t = bones[name]
        _, f = intersect_point_line(p, h, t)
        f = max(0.0, min(1.0, f))
        return (p - h.lerp(t, f)).length

    lo.vertex_groups.clear()
    groups = {n: lo.vertex_groups.new(name=n) for n in bones if n != 'root'}
    cells = me.attributes['cell'].data if 'cell' in me.attributes else None
    vface = {}
    if cells is not None:
        for p in me.polygons:
            for vi in p.vertices:
                vface.setdefault(vi, set()).add(cells[p.index].value)

    def cands(p, vi):
        ax = abs(p.x); s = 'L' if p.x > 0 else 'R'
        if vface.get(vi, set()) & FACE_PARTS:
            return ['head']
        if L.get('ear_by_cell') and vface.get(vi, set()) & EAR_PARTS:
            return [f'ear.{s}', 'head']
        if p.z > L['head_z'] and not (ax > 0.19 and p.z < L.get('arm_top', 0.5)):
            if p.z > L['ear_z'] and ax > 0.06:
                return [f'ear.{s}', 'head']
            return ['head', 'neck'] if p.z < L.get('neck_top', 0.52) else ['head']
        if ax > L['arm_x'] and L['arm_z'][0] < p.z < L['arm_z'][1] and p.y < L.get('arm_y', 0.03):
            return [f'upper_arm.{s}', f'forearm.{s}', f'hand.{s}', 'chest']
        if p.y > L['tail_y'] and p.z < L.get('tail_zmax', 0.4):
            return ['tail_01', 'tail_02', 'tail_03', 'tail_04', 'hips']
        if p.z < L['leg_z'] and ax > 0.005 and p.y < L.get('leg_y', 0.09):
            return [f'thigh.{s}', f'shin.{s}', f'foot.{s}', 'hips']
        return ['hips', 'spine', 'chest', 'neck']

    for v in me.vertices:
        ws = sorted(((1.0 / max(seg_dist(v.co, n), 0.004) ** 4, n) for n in cands(v.co, v.index)), reverse=True)[:3]
        tot = sum(w for w, _ in ws)
        for w, n in ws:
            if w / tot > 0.02:
                groups[n].add([v.index], w / tot, 'REPLACE')
    for v in me.vertices:
        gs = sorted(v.groups, key=lambda g: -g.weight)
        for g in gs[4:]:
            lo.vertex_groups[g.group].remove([v.index])
        gs = gs[:4]; s = sum(g.weight for g in gs) or 1
        for g in gs:
            g.weight /= s
    for m in list(lo.modifiers):
        if m.type == 'ARMATURE':
            lo.modifiers.remove(m)
    md = lo.modifiers.new('Armature', 'ARMATURE'); md.object = rig
    lo.parent = rig
    return sum(1 for v in me.vertices if not v.groups)


def smooth_region(obj_name, box, repeat=8, k=0.5):
    """box 안 정점의 가중치를 이웃과 섞는다 (어깨처럼 몸통→팔이 급하게 바뀌면 팔을 내릴 때 뾰족하게 접힌다).
    box: (x0, x1, z0, z1) — x 는 절댓값(좌우 공통)"""
    import bmesh
    ob = bpy.data.objects[obj_name]; me = ob.data
    x0, x1, z0, z1 = box
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
    nbrs = {v.index: [e.other_vert(v).index for e in v.link_edges] for v in bm.verts}
    bm.free()
    W = {v.index: {g.group: g.weight for g in v.groups} for v in me.vertices}
    names = {g.index: g.name for g in ob.vertex_groups}
    headish = lambda i: sum(w for g, w in W[i].items() if names[g] in ('head', 'neck', 'ear.L', 'ear.R')) >= 0.3
    # 머리에 속한 정점은 섞지 않는다 (섞으면 팔 가중치가 머리 아래로 번져, 팔을 내릴 때 볼 아래가 끌려 내려간다)
    sel = [v.index for v in me.vertices if x0 < abs(v.co.x) < x1 and z0 < v.co.z < z1 and not headish(v.index)]
    for _ in range(repeat):
        new = {}
        for i in sel:
            acc = {}
            for j in nbrs[i] + [i]:
                for g, w in W[j].items():
                    acc[g] = acc.get(g, 0) + w
            n = len(nbrs[i]) + 1
            avg = {g: w / n for g, w in acc.items()}
            mix = {g: W[i].get(g, 0) * (1 - k) + avg.get(g, 0) * k for g in set(W[i]) | set(avg)}
            top = sorted(mix.items(), key=lambda t: -t[1])[:4]
            t = sum(w for _, w in top) or 1
            new[i] = {g: w / t for g, w in top if w / t > 0.01}
        W.update(new)
    # 머리 정점에 남은 팔·손 가중치는 지운다 (머리·목으로 다시 나눔)
    arm = {g.index for g in ob.vertex_groups if g.name.startswith(('upper_arm', 'forearm', 'hand'))}
    fixed = []
    for v in me.vertices:
        i = v.index
        if not headish(i) or not (set(W[i]) & arm):
            continue
        rest = {g: w for g, w in W[i].items() if g not in arm}
        t = sum(rest.values()) or 1
        W[i] = {g: w / t for g, w in rest.items()}
        fixed.append(i)
    for i in set(sel) | set(fixed):
        for g in ob.vertex_groups:
            g.remove([i])
        for gi, w in W[i].items():
            ob.vertex_groups[gi].add([i], w, 'REPLACE')
    return len(sel), len(fixed)


def shoulder_blend(obj_name, x0, x1, z0, z1, side_bones=('chest', 'upper_arm')):
    """어깨 구간 |x| x0→x1 에서 몸통→위팔 가중치를 바깥으로 갈수록 일정하게 넘긴다 (smoothstep).
    이웃 섞기보다 결과가 고르다: 팔을 내리면 어깨가 계단·날개 없이 완만하게 굽는다. 머리 정점은 건드리지 않는다."""
    ob = bpy.data.objects[obj_name]; me = ob.data
    names = {g.index: g.name for g in ob.vertex_groups}
    idx = {g.name: g.index for g in ob.vertex_groups}
    n = 0
    for v in me.vertices:
        ax = abs(v.co.x)
        if not (x0 < ax < x1 and z0 < v.co.z < z1):
            continue
        ws = {names[g.group]: g.weight for g in v.groups}
        if ws.get('head', 0) + ws.get('neck', 0) >= 0.3:
            continue
        s = 'L' if v.co.x > 0 else 'R'
        t = (ax - x0) / (x1 - x0); t = t * t * (3 - 2 * t)
        for g in list(v.groups):
            ob.vertex_groups[g.group].remove([v.index])
        if 1 - t > 0.01:
            ob.vertex_groups[idx[side_bones[0]]].add([v.index], 1 - t, 'REPLACE')
        if t > 0.01:
            ob.vertex_groups[idx[side_bones[1] + '.' + s]].add([v.index], t, 'REPLACE')
        n += 1
    return n
