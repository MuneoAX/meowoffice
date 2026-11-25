"""그리기 쉬운 텍스처 UV ('tex') — Blender 안에서 실행. skin.make_uv 대신 쓴다.

부위(머리·몸통·팔·다리·꼬리)마다 6방향(정면·뒤·왼쪽·오른쪽·위·아래)에서 본 모습 그대로 펼친다.
- 면은 법선이 가장 가까운 방향의 조각으로 간다. 옆·뒤 조각도 위쪽 = 머리 쪽으로 똑바로 선다.
- 같은 방향에서 다른 면에 가려지는 면(털 가시 안쪽 등)은 겹치지 않게 '기타' 조각으로 따로 펼친다.
- 조각은 크기 비율을 유지한 채 회전 없이 배치하고, 이름표 위치를 templates/<체형>_uv.json 으로 남긴다
  (uvguide.py 가 이름표 붙은 안내도를 그린다 — AI·사람이 그릴 때 어느 조각이 어디인지 알 수 있게).
- 데칼(눈·코·입)과 수염 가닥은 오른쪽 끝 단색 칸 (skin.SWATCH).
부위는 정점 가중치(가장 큰 뼈)로 정하므로 weights.run 다음에 실행한다.
"""
import collections
import json
import math
import os

import bmesh
import bpy
from mathutils import Vector

import skin

HERE = os.path.dirname(os.path.abspath(__file__))
PART = {'head': 'head', 'neck': 'head', 'ear.L': 'head', 'ear.R': 'head',
        'hips': 'body', 'spine': 'body', 'chest': 'body',
        'upper_arm.L': 'arm_L', 'forearm.L': 'arm_L', 'hand.L': 'arm_L',
        'upper_arm.R': 'arm_R', 'forearm.R': 'arm_R', 'hand.R': 'arm_R',
        'thigh.L': 'leg_L', 'shin.L': 'leg_L', 'foot.L': 'leg_L',
        'thigh.R': 'leg_R', 'shin.R': 'leg_R', 'foot.R': 'leg_R',
        'tail_01': 'tail', 'tail_02': 'tail', 'tail_03': 'tail', 'tail_04': 'tail'}
# 방향: (법선, 투영 u, 투영 v, 깊이(카메라 쪽이 작다)). 모델 좌표: 정면 -Y, 왼쪽 +X, 위 +Z
VIEWS = {
    'front': (Vector((0, -1, 0)), lambda p: p.x, lambda p: p.z, lambda p: p.y),
    'back': (Vector((0, 1, 0)), lambda p: -p.x, lambda p: p.z, lambda p: -p.y),
    'left': (Vector((1, 0, 0)), lambda p: p.y, lambda p: p.z, lambda p: -p.x),
    'right': (Vector((-1, 0, 0)), lambda p: -p.y, lambda p: p.z, lambda p: p.x),
    'top': (Vector((0, 0, 1)), lambda p: p.x, lambda p: -p.y, lambda p: -p.z),
    'bottom': (Vector((0, 0, -1)), lambda p: p.x, lambda p: p.y, lambda p: p.z),
}


def face_parts(ob):
    me = ob.data
    names = {g.index: g.name for g in ob.vertex_groups}
    vpart = {}
    for v in me.vertices:
        if v.groups:
            g = max(v.groups, key=lambda g: g.weight)
            vpart[v.index] = PART.get(names[g.group], 'body')
        else:
            vpart[v.index] = 'body'
    return {p.index: collections.Counter(vpart[i] for i in p.vertices).most_common(1)[0][0] for p in me.polygons}


def occluded(faces, view, cell=0.004, tol=0.008):
    """앞에서부터 칸을 채우며, 이미 더 앞의 면이 덮은 칸이 대부분인 면을 골라낸다"""
    _, fu, fv, fd = VIEWS[view]
    rows = []
    for f in faces:
        vs = [l.vert.co for l in f.loops]
        c = f.calc_center_median()
        rows.append((fd(c), f, vs))
    rows.sort(key=lambda r: r[0])
    depth = {}
    hidden = set()
    for d, f, vs in rows:
        pts = []
        a, b, c = vs[0], vs[1], vs[2]
        for i in range(4):
            for j in range(4 - i):
                w1, w2 = (i + 0.5) / 4.5, (j + 0.5) / 4.5
                pts.append(a + (b - a) * w1 + (c - a) * w2)
        cells = {(int(math.floor(fu(p) / cell)), int(math.floor(fv(p) / cell))) for p in pts}
        cov = sum(1 for k in cells if k in depth and depth[k] < d - tol)
        if cov >= 0.6 * len(cells):
            hidden.add(f.index)
            continue
        for k in cells:
            if k not in depth or d < depth[k]:
                depth[k] = d
    return hidden


def make(obj_name, body, margin=0.006):
    ob = bpy.data.objects[obj_name]; me = ob.data
    fpart = face_parts(ob)
    sp = skin.special_faces(me)
    for uv in list(me.uv_layers):
        me.uv_layers.remove(uv)
    me.uv_layers.new(name='tex')
    bm = bmesh.new(); bm.from_mesh(me)
    bm.faces.ensure_lookup_table(); bm.normal_update()
    uvl = bm.loops.layers.uv['tex']
    groups = collections.defaultdict(list)
    for f in bm.faces:
        if f.index in sp:
            continue
        view = max(VIEWS, key=lambda k: f.normal.dot(VIEWS[k][0]))
        if fpart[f.index] == 'head' and f.normal.y < -0.25:  # 얼굴은 눈구멍 벽까지 정면 조각 하나에 (눈이 한 장에 그려지게)
            view = 'front'
        groups[(fpart[f.index], view)].append(f)
    # 가려진 면(털 가시 안쪽 등)은 따로 떼지 않고 같은 조각에 겹쳐 둔다: 앞면과 같은 털색을 쓰면 되고,
    # 따로 펼치면 자잘한 조각 수백 개가 흩어져 안내도가 지저분해진다. (occluded() 는 참고용으로 남김)
    misc = set()
    # 투영 좌표 (조각마다 멀리 떨어뜨려 두고 나중에 배치)
    gi = 0
    keys = sorted(groups)
    for key in keys:
        part, view = key
        _, fu, fv, _ = VIEWS[view]
        off = Vector((gi * 3.0, 0))
        for f in groups[key]:
            if f.index in misc:
                continue
            for l in f.loops:
                l[uvl].uv = (fu(l.vert.co) + off.x, fv(l.vert.co) + off.y)
        gi += 1
    for f in bm.faces:
        if f.index in sp:
            for l in f.loops:
                l[uvl].uv = (skin.SW_U, sp[f.index])
    gidx = {k: [f.index for f in fs] for k, fs in groups.items()}  # bmesh 를 풀기 전에 번호로
    bm.to_mesh(me); bm.free()
    # 가려진 면: 자동 펼침 → 전체 배치(회전 없음)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.hide_set(False); ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='OBJECT')
    for p in me.polygons:
        p.select = p.index in misc
    if misc:
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_mode(type='FACE')
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode='OBJECT')
        # 자동 펼침 결과(0~1)를 실제 크기 비율로: 면적을 맞춘다
        uv = me.uv_layers['tex'].data
        a3 = sum(me.polygons[i].area for i in misc)
        a2 = 0.0
        for i in misc:
            p = me.polygons[i]; li = list(p.loop_indices)
            q = [uv[k].uv for k in li]
            for k in range(1, len(q) - 1):
                a2 += abs((q[k] - q[0]).cross(q[k + 1] - q[0])) / 2
        s = math.sqrt(a3 / a2) if a2 else 1
        for i in misc:
            for k in me.polygons[i].loop_indices:
                uv[k].uv = (uv[k].uv[0] * s - 50, uv[k].uv[1] * s)
    for p in me.polygons:
        p.select = p.index in sp
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.mesh.hide(unselected=False)  # 단색 칸 면(데칼·수염)은 숨겨 배치에 끼지 않게 (데칼을 바꿔도 배치가 흔들리지 않는다)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    kw = dict(rotate=False, margin=margin, merge_overlap=True)  # 겹친 면은 한 조각으로
    try:
        bpy.ops.uv.pack_islands(shape_method='CONCAVE', **kw)
    except TypeError:
        bpy.ops.uv.pack_islands(**kw)
    bpy.ops.mesh.reveal(select=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    uv = me.uv_layers['tex'].data
    for p in me.polygons:
        if p.index in sp:  # 배치가 단색 칸 면까지 옮길 수 있어 다시 지정
            for k in p.loop_indices:
                uv[k].uv = (skin.SW_U, sp[p.index])
            continue
        for k in p.loop_indices:
            uv[k].uv = (uv[k].uv[0] * skin.BODY_U, uv[k].uv[1])
    # 이름표: 조각(부위·방향)마다 이어진 덩어리별 상자 (UV 0~1). 너무 작은 덩어리는 뺀다
    labels = []
    for key in keys:
        idx = [i for i in gidx[key] if i not in misc]
        if not idx:
            continue
        parent = {}

        def find(a):
            while parent.setdefault(a, a) != a:
                parent[a] = parent[parent[a]]; a = parent[a]
            return a
        # 모서리를 공유하는 면끼리만 한 덩어리 (Blender 배치가 조각을 나누는 기준과 같게)
        owner = {}
        for i in idx:
            parent.setdefault(i, i)
            for ek in me.polygons[i].edge_keys:
                if ek in owner:
                    parent[find(i)] = find(owner[ek])
                else:
                    owner[ek] = i
        comp = collections.defaultdict(list)
        for i in idx:
            comp[find(i)].append(i)
        total = sum(me.polygons[i].area for i in idx)
        for faces in comp.values():
            area = sum(me.polygons[i].area for i in faces)
            if area < 0.04 * total or area < 0.0015:
                continue
            us = [uv[k].uv for i in faces for k in me.polygons[i].loop_indices]
            u0 = min(q[0] for q in us); u1 = max(q[0] for q in us); v0 = min(q[1] for q in us); v1 = max(q[1] for q in us)
            labels.append(dict(part=key[0], view=key[1], box=[u0, v0, u1, v1], area=area))
    tris = []
    for p in me.polygons:
        q = [tuple(uv[k].uv) for k in p.loop_indices]
        tris.append(dict(uv=q, part=('swatch' if p.index in sp else 'misc' if p.index in misc else fpart[p.index])))
    os.makedirs(os.path.join(HERE, 'templates'), exist_ok=True)
    with open(os.path.join(HERE, 'templates', body + '_uv.json'), 'w', encoding='utf-8') as fh:
        json.dump(dict(labels=labels, faces=tris), fh)
    return dict(groups=len(keys), misc=len(misc), special=len(sp))
