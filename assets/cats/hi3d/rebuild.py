"""체형 하나를 처음부터 다시 만든다 (Blender 안): 부위 칸 → 얼굴 데칼 → 텍스처 UV·굽기 → 가중치 → 동작 → glb.

사용: import rebuild; rebuild.run('foldear')
품종 텍스처는 그다음 breeds.py 로 (Blender 밖에서) 만든다.
일반형 기준 메쉬 std_lo_base 는 처음 한 번 cat_lo(텍스처 칸 판정 메쉬)에서 복사해 두었다.
"""
import importlib
import os

import bpy

import facemap
import make_actions
import regions
import skin
import uvviews
import weights

GLB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'ui', 'office', 'models', 'cats')

CFG = {
    # 일반형: 얼굴(눈·코·입·귀 안쪽)은 원본 텍스처를 그대로 옮겨 굽는다 (orig_face) → 데칼 없음
    'standard': dict(lo='std_lo', rig='cat_rig', L=regions.LAND, W='L_STD', W_uv=None, drop=1.0, orig_face=True, simplify=0.6,
                     # 뾰족한 곳 다듬기: 정수리 털뭉치, 볼 아래 양쪽 모서리(팔을 내리면 어깨 위 뿔처럼 보임), 어깨 연결부
                     despike=[(0, -0.13, 0.83, 0.04),
                              (0.245, -0.16, 0.557, 0.06), (-0.245, -0.16, 0.557, 0.06),
                              (0.21, -0.1, 0.42, 0.05), (-0.21, -0.1, 0.42, 0.05)],
                     shoulder=(0.12, 0.22, 0.34, 0.5),  # 어깨 구간 |x| x0→x1, z0~z1: 몸통→위팔 가중치를 고르게
                     jaw=dict(z0=0.45, zw=0.59, w=0.262),  # 아래 얼굴을 먼치킨 윤곽처럼
                     redecal_after=True,  # 데칼은 UV 전에 (배치 재현), 주둥이를 메운 뒤 다시 붙인다
                     snout=dict(cx=0.0, cz=0.55, rx=0.085, rz=0.06, h=0.012, y=-0.25),  # 옆에서 본 입 모양: 앞으로 둥글게
                     smooth_mouth=dict(cx=0.0, cz=0.556, rx=0.036, rz=0.024, fill=1.3, bulge=0.0, y=-0.3),
                     smooth_eyes=dict(cx=0.089, cz=0.632, rx=0.033, rz=0.05, fill=1.45, bulge=0.0, y=-0.24),  # 눈구멍 메우기만
                     # 눈·코·입은 메쉬로만: 메운 면 위에 원본 눈 타원 자리로 (다른 체형처럼 UV 전에)
                     face={'eye_x': 0.089, 'eye_dz': 0.065, 'eye_rx': 0.033, 'eye_rz': 0.05, 'eye_h': 0.005, 'mouth': 'shape'}, ear=None, ear_inner=None,
                     whiskers=None),
    'foldear': dict(redecal_after=True, mouth_shape=True, dup_whiskers=(-0.012, 15),
                     smooth_mouth=dict(cx=0.0, cz=0.609, rx=0.036, rz=0.024, fill=1.3, bulge=0.0, y=-0.211),
                     snout=dict(cx=0.0, cz=0.603, rx=0.085, rz=0.06, h=0.012, y=-0.161),
                     lo='fold_lo', rig='fold_rig', L=regions.LAND_FOLD, W='L_FOLD', drop=1.0, face={},
                    shoulder=(0.12, 0.21, 0.38, 0.53),
                    ear=dict(c=(0, -0.075, 0.71), r=(0.235, 0.215, 0.19), k=1.06), ear_inner=None, whiskers=None),
    'shortleg': dict(redecal_after=True, mouth_shape=True,
                     smooth_mouth=dict(cx=0.0, cz=0.544, rx=0.036, rz=0.024, fill=1.3, bulge=0.0, y=-0.223),
                     snout=dict(cx=0.0, cz=0.538, rx=0.085, rz=0.06, h=0.012, y=-0.173),
                     lo='short_lo', rig='short_rig', L=regions.LAND_SHORT, W='L_SHORT', drop=0.15,
                     shoulder=(0.12, 0.21, 0.3, 0.44),
                     face={'eye_x': 0.1, 'eye_dz': 0.07}, ear=dict(c=(0, -0.08, 0.63), r=(0.26, 0.22, 0.2), k=1.06, ax=0.11),
                     ear_inner=dict(ny=-0.35), whiskers=[(0.13, 0.22, -0.005, 0.005), (0.13, 0.22, -0.02, -0.03)]),
    'longhair': dict(redecal_after=True, mouth_shape=True,
                     smooth_mouth=dict(cx=0.0, cz=0.586, rx=0.036, rz=0.024, fill=1.3, bulge=0.0, y=-0.214),
                     snout=dict(cx=0.0, cz=0.580, rx=0.085, rz=0.06, h=0.012, y=-0.164),
                     lo='long_lo', rig='long_rig', L=regions.LAND_LONG, W='L_LONG', drop=0.3,
                     shoulder=(0.14, 0.24, 0.38, 0.5),
                     face={'eye_x': 0.09, 'eye_dz': 0.058, 'eye_rx': 0.026, 'eye_rz': 0.04}, ear=dict(c=(0, -0.067, 0.67), r=(0.25, 0.22, 0.185), k=1.1, ax=0.1, z=0.74),
                     ear_inner=dict(ny=-0.35), whiskers=[(0.14, 0.23, 0.0, 0.01), (0.14, 0.23, -0.015, -0.025)]),
}


def smooth_area(obj_name, e):
    """텍스처를 구운 뒤: 눈구멍을 메워 평평하게 하고, 눈(텍스처 타원) 자리를 앞으로 볼록하게.
    정점은 앞뒤(y)로만 옮긴다 → 정면 좌표(x, z)가 그대로라 구운 텍스처 위치가 고정된다.
    e: cx, cz = 눈 중심, rx, rz = 눈 타원 반지름(텍스처 눈), fill = 메우는 범위 배율, bulge = 솟는 높이(m)"""
    import bmesh
    import numpy as np
    me = bpy.data.objects[obj_name].data
    bm = bmesh.new(); bm.from_mesh(me)
    # 눈 안쪽은 큰 삼각형 몇 개뿐이라 솟게 할 정점이 없다 → 눈 둘레만 잘게 나눈다 (UV·가중치는 보간)
    for _ in range(2 if e['bulge'] > 0 else 0):  # 형상으로 솟게 할 때만
        eyes = []
        for f in bm.faces:
            c = f.calc_center_median()
            if c.y < e['y'] and min((((c.x - sx * e['cx']) / e['rx']) ** 2 + ((c.z - e['cz']) / e['rz']) ** 2) for sx in (1, -1)) < 1.3 ** 2:
                eyes.append(f)
        edges = list({ed for f in eyes for ed in f.edges})
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    for sx in (1, -1):
        cx = sx * e['cx']

        def r(v):
            return (((v.co.x - cx) / e['rx']) ** 2 + ((v.co.z - e['cz']) / e['rz']) ** 2) ** 0.5
        front = [v for v in bm.verts if v.co.y < e['y']]
        ring = [v for v in front if e['fill'] * 1.05 < r(v) < e['fill'] * 1.6]
        inner = [v for v in front if r(v) <= e['fill'] * 1.05]
        # 고리(눈구멍 바깥 얼굴면)에 곡면 y = f(x, z) 맞춤 (2차)
        A = np.array([[1, v.co.x, v.co.z, v.co.x ** 2, v.co.x * v.co.z, v.co.z ** 2] for v in ring])
        b = np.array([v.co.y for v in ring])
        k = np.linalg.lstsq(A, b, rcond=None)[0]
        for v in inner:
            x, z = v.co.x, v.co.z
            y = k @ np.array([1, x, z, x * x, x * z, z * z])
            rr = r(v)
            if rr < 1.1:  # 눈: 엠보싱 — 윗면은 살짝 둥글고 가장자리는 부드럽게 경사 (앞 = -y)
                lift = 1.0 - max(0.0, min(1.0, (rr - 0.78) / 0.3)) ** 2 * (3 - 2 * max(0.0, min(1.0, (rr - 0.78) / 0.3)))
                y -= e['bulge'] * lift * (0.88 + 0.12 * (1 - min(rr, 1.0) ** 2))
            w = min(1.0, (e['fill'] * 1.05 - rr) / 0.15 + 0.0) if rr > e['fill'] * 0.9 else 1.0  # 가장자리 부드럽게
            v.co.y = v.co.y + (y - v.co.y) * max(0.0, w)
    bm.normal_update()
    # 눌러 편 눈구멍 벽 중 뒤집혀 접힌 삼각형(법선이 뒤를 향함)은 지운다 — 앞을 향한 면이 같은 자리를 덮는다
    flip = []
    for f in bm.faces:
        c = f.calc_center_median()
        if c.y < e['y'] and f.normal.y > 0.2 and min(
                (((c.x - sx * e['cx']) / e['rx']) ** 2 + ((c.z - e['cz']) / e['rz']) ** 2) ** 0.5 for sx in (1, -1)) < e['fill'] * 1.05:
            flip.append(f)
    bmesh.ops.delete(bm, geom=flip, context='FACES')
    bm.to_mesh(me); bm.free(); me.update()


def despike(obj_name, spots, iters=20):
    """뾰족하게 솟은 곳을 매끈하게 (중심 x, y, z, 반지름). 가운데일수록 많이 다듬는다."""
    import bmesh
    from mathutils import Vector
    me = bpy.data.objects[obj_name].data
    bm = bmesh.new(); bm.from_mesh(me)
    for x, y, z, r in spots:
        c = Vector((x, y, z))
        vs = [v for v in bm.verts if (v.co - c).length < r]
        for i in range(iters):
            inner = [v for v in vs if (v.co - c).length < r * (1 - i / (iters * 1.5))]
            bmesh.ops.smooth_vert(bm, verts=inner, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(me); bm.free(); me.update()


# 먼치킨(짧은다리형) 아래 얼굴 윤곽: 정면에서 본 머리 아래쪽 곡선 (폭 비율 u → 턱부터의 높이 비율 h)
JAW_SHORT = [(0.0, 0.0), (0.54, 0.0), (0.64, 0.33), (0.71, 0.39), (0.79, 0.5), (0.86, 0.62), (0.93, 0.79), (1.0, 1.0)]


def jaw_like(obj_name, rig_name, e):
    """머리 아래쪽을 먼치킨 윤곽처럼 둥글게: 곡선 밖으로 튀어나온 정점을 x 방향으로 곡선까지 당긴다.
    e: z0 = 턱 높이, zw = 머리가 가장 넓은 높이, w = 가장 넓은 반폭. UV 는 그대로 (굽기 뒤에 실행)."""
    ob = bpy.data.objects[obj_name]; me = ob.data
    gi = {g.name: g.index for g in ob.vertex_groups}
    hs = {gi['head'], gi['neck']}
    hz = [h for _, h in JAW_SHORT]; uu = [u for u, _ in JAW_SHORT]

    def width(z):  # 높이 → 허용 반폭
        h = (z - e['z0']) / (e['zw'] - e['z0'])
        if h >= 1:
            return 9
        if h <= 0:
            return uu[1] * e['w']
        for i in range(1, len(hz)):
            if h <= hz[i] and hz[i] > hz[i - 1]:
                k = (h - hz[i - 1]) / (hz[i] - hz[i - 1])
                return (uu[i - 1] + (uu[i] - uu[i - 1]) * k) * e['w']
        return e['w']
    moved = 0
    for v in me.vertices:
        w = sum(g.weight for g in v.groups if g.group in hs)
        if w < 0.5 or not (e['z0'] < v.co.z < e['zw']):
            continue
        lim = width(v.co.z)
        if abs(v.co.x) > lim:
            v.co.x = lim * (1 if v.co.x > 0 else -1); moved += 1
    me.update()
    return moved


def denoise(obj_name, iters=4, lam=0.25):
    """전체 쭈글쭈글한 곳 다듬기: 약한 이웃 평균. 데칼·수염·귀는 제외.
    UV·굽기 뒤에 실행 → 텍스처는 그대로 (표면을 따라 몇 mm 미끄러질 뿐)."""
    import bmesh
    me = bpy.data.objects[obj_name].data
    bm = bmesh.new(); bm.from_mesh(me)
    dl = bm.faces.layers.int.get('decal'); cl = bm.faces.layers.int.get('cell')
    skip = set()
    for f in bm.faces:
        if (dl and f[dl]) or (cl and f[cl] in (16, 10, 5)):
            skip.update(f.verts)
    vs = [v for v in bm.verts if v not in skip and not v.is_boundary]
    # 부피 유지 라플라시안은 비다양체 면에서 가시가 튀어 쓰지 않는다 → 약한 이웃 평균을 여러 번
    for _ in range(iters):
        bmesh.ops.smooth_vert(bm, verts=vs, factor=lam, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.normal_update(); bm.to_mesh(me); bm.free(); me.update()
    return len(vs)


def snout(obj_name, e):
    """주둥이: 코 아래 얼굴면을 앞으로 둥글게 내민다 (옆에서 보면 이마→코→입→턱이 매끈한 볼록 곡선).
    앞뒤(y)로만 옮긴다 → 정면 좌표가 그대로라 텍스처 위치 유지. e: cx, cz 중심, rx, rz 반지름, h 높이, y 앞면 기준"""
    import math
    me = bpy.data.objects[obj_name].data
    for v in me.vertices:
        if v.co.y > e['y']:
            continue
        r = math.hypot((v.co.x - e['cx']) / e['rx'], (v.co.z - e['cz']) / e['rz'])
        if r < 1:
            v.co.y -= e['h'] * math.cos(r * math.pi / 2) ** 2
    me.update()


def simplify(obj_name, ratio=0.6):
    """면 수 줄이기 (잔주름 제거). UV·굽기 뒤에 실행 → 정점을 합칠 때 UV 도 보간되어 텍스처 위치 유지.
    데칼은 먼저 지운 상태여야 한다. 수염 가닥·귀는 얇아서 줄이지 않는다 (정점 그룹으로 제외)."""
    ob = bpy.data.objects[obj_name]; me = ob.data
    cell = me.attributes['cell'].data if 'cell' in me.attributes else None
    keep = set()
    if cell:
        for p in me.polygons:
            if cell[p.index].value in (16, 10, 5):
                keep.update(p.vertices)
    g = ob.vertex_groups.get('_decim') or ob.vertex_groups.new(name='_decim')
    g.add([v.index for v in me.vertices if v.index not in keep], 1.0, 'REPLACE')
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.hide_set(False); ob.select_set(True); bpy.context.view_layer.objects.active = ob
    arm = [m for m in ob.modifiers if m.type == 'ARMATURE']
    for m in arm:
        m.show_viewport = False
    md = ob.modifiers.new('simplify', 'DECIMATE'); md.decimate_type = 'COLLAPSE'; md.ratio = ratio
    md.use_symmetry = True; md.symmetry_axis = 'X'; md.vertex_group = '_decim'; md.vertex_group_factor = 1.0
    md.use_collapse_triangulate = True
    bpy.ops.object.modifier_move_to_index(modifier=md.name, index=0)
    bpy.ops.object.modifier_apply(modifier=md.name)
    for m in arm:
        m.show_viewport = True
    ob.vertex_groups.remove(ob.vertex_groups['_decim'])
    return sum(len(p.vertices) - 2 for p in me.polygons)


def dup_whiskers(obj_name, dz=-0.02, droop=10):
    """형상 수염 한 쌍을 복제해 아래에 한 쌍 더 (살짝 처지게). 수염은 단색 칸이라 UV 배치와 무관."""
    import math
    import bmesh
    from mathutils import Matrix, Vector
    me = bpy.data.objects[obj_name].data
    bm = bmesh.new(); bm.from_mesh(me)
    cl = bm.faces.layers.int['cell']
    for sg in (1, -1):
        faces = [f for f in bm.faces if f[cl] == 16 and f.calc_center_median().x * sg > 0]
        if not faces:
            continue
        ret = bmesh.ops.duplicate(bm, geom=faces)
        vs = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)]
        root = min(vs, key=lambda v: abs(v.co.x)).co.copy()  # 볼에 붙은 쪽
        rot = Matrix.Rotation(math.radians(droop * sg), 4, 'Y')  # 끝이 아래로 (원래 수염과 벌어지게)
        bmesh.ops.rotate(bm, verts=vs, cent=root, matrix=rot)
        bmesh.ops.translate(bm, verts=vs, vec=Vector((0, 0, dz)))
    bm.to_mesh(me); bm.free(); me.update()


def remove_decals(obj_name):
    import bmesh
    me = bpy.data.objects[obj_name].data
    bm = bmesh.new(); bm.from_mesh(me)
    dl = bm.faces.layers.int.get('decal')
    faces = [f for f in bm.faces if dl and f[dl]]
    verts = {v for f in faces for v in f.verts}
    bmesh.ops.delete(bm, geom=faces, context='FACES_ONLY')
    bmesh.ops.delete(bm, geom=[v for v in verts if v.is_valid and not v.link_faces], context='VERTS')
    bm.to_mesh(me); bm.free(); me.update()


def skin_material():
    m = bpy.data.materials.get('cat_skin') or bpy.data.materials.new('cat_skin')
    m.use_nodes = True
    return m


def run(body, export=True):
    for mod in (regions, facemap, skin, weights, make_actions, uvviews):
        importlib.reload(mod)
    c = CFG[body]
    lo = bpy.data.objects[c['lo']]; rig = bpy.data.objects[c['rig']]
    base = bpy.data.objects[c['lo'] + '_base']
    old = lo.data
    lo.parent = None
    lo.data = base.data.copy(); lo.data.name = c['lo'] + '_mesh'
    if old.users == 0:
        bpy.data.meshes.remove(old)
    for k in [a.name for a in lo.data.attributes if a.name in ('cell', 'decal')]:
        lo.data.attributes.remove(lo.data.attributes[k])
    if c.get('mouth_shape'):  # 입은 형상(주둥이 볼록)으로만
        c['face'] = dict(c['face'], mouth='shape')
    face = dict(c['face'], paint_eyes=False)
    tex = facemap.make(c['lo'], ear=c['ear'], face=face, ear_inner=c['ear_inner'])
    regions.run(c['lo'], levels=0, smooth_iters=0, L=c['L'], tex=tex)
    if c.get('simplify', 0.7):  # 면 수 줄이기 (잔주름 제거). UV 전에 — UV 뒤에 하면 조각 경계를 넘어 합쳐져 텍스처가 번진다
        simplify(c['lo'], c.get('simplify', 0.7))
    if c.get('smooth_eyes'):  # 눈구멍을 먼저 면으로 메운다 (눈은 메쉬라 텍스처를 눈구멍에 맞출 필요 없음) → UV 정면 조각에 구멍이 안 생긴다
        smooth_area(c['lo'], c['smooth_eyes'])
    if not c.get('decals_after'):
        facemap.add_decals(c['lo'], face=c['face'], whiskers=c['whiskers'])
    # UV 조각의 부위 판정은 처음 정한 가중치 규칙(W_uv)으로 고정한다 — 가중치 규칙을 고쳐도 UV 배치가 바뀌지 않게 (그려 둔 텍스처 유지)
    L_uv = getattr(weights, c['W_uv']) if c.get('W_uv') else None if 'W_uv' in c else (getattr(weights, c['W']) if c['W'] else None)
    L = getattr(weights, c['W']) if c['W'] else None
    unw = weights.run(c['lo'], c['rig'], L_uv)
    nsp = uvviews.make(c['lo'], body)
    if c.get('orig_face'):
        skin.bake_face(c['lo'], body)
    bake = skin.bake(c['lo'], body)
    if c.get('jaw'):  # 아래 얼굴 윤곽 (굽기 뒤, 가중치가 있어야 머리 정점을 고른다)
        jaw_like(c['lo'], c['rig'], c['jaw'])
    if c.get('despike'):  # UV·굽기 뒤에 형상만 다듬는다 (면 연결이 같아 UV 배치가 바뀌지 않음 → 그려 둔 텍스처 유지)
        despike(c['lo'], c['despike'])
    if c.get('redecal_after'):
        remove_decals(c['lo'])
    if c.get('dup_whiskers'):  # 형상 수염이 한 쌍뿐인 체형: 아래에 한 쌍 더 (UV 뒤 — 배치가 바뀌지 않게)
        dup_whiskers(c['lo'], *c['dup_whiskers'])
    if c.get('simplify_post'):  # (쓰지 않음) UV 뒤 면 줄이기는 조각 경계를 넘어 합쳐져 텍스처가 번진다
        simplify(c['lo'], c['simplify_post'])
    if c.get('denoise', True):  # 전체 쭈글쭈글한 곳 다듬기 (UV 뒤라 텍스처 유지)
        denoise(c['lo'])
    if c.get('smooth_mouth'):  # 주둥이의 원본 입 조각선(주름)을 메운다 — UV·굽기 뒤라 배치가 바뀌지 않는다 (그려 둔 텍스처 유지)
        smooth_area(c['lo'], c['smooth_mouth'])
    if c.get('snout'):  # 주둥이를 앞으로 둥글게 (입은 형상으로 표현)
        snout(c['lo'], c['snout'])
    if c.get('decals_after'):  # 메운 면 위에 코·입 엠보싱
        facemap.add_decals(c['lo'], face=c['face'], whiskers=c['whiskers'])
    if c.get('redecal_after'):  # 메운 면 위에 데칼 다시 (몸 UV 는 그대로)
        facemap.add_decals(c['lo'], face=c['face'], whiskers=c['whiskers'])
    if c.get('decals_after') or c.get('redecal_after') or L is not L_uv:  # 최종 가중치 (새 데칼 정점 포함, UV 는 그대로)
        unw = weights.run(c['lo'], c['rig'], L)
    if c.get('shoulder'):  # 어깨: 몸통→위팔 가중치를 바깥으로 갈수록 고르게 (팔을 내려도 계단·뿔·날개 없이)
        weights.shoulder_blend(c['lo'], *c['shoulder'])
    lo.data.materials.clear(); lo.data.materials.append(skin_material())
    make_actions.build(rig_name=c['rig'], drop=c['drop'])
    out = None
    if export:
        for o in bpy.context.selected_objects:
            o.select_set(False)
        for o in (rig, lo):
            o.hide_set(False); o.select_set(True)
        bpy.context.view_layer.objects.active = rig
        rig.animation_data.action = None
        out = os.path.abspath(os.path.join(GLB, 'cat_%s.glb' % body))
        bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_animations=True,
                                  export_skins=True, export_yup=True, export_apply=False, export_texcoords=True,
                                  export_normals=True, export_materials='EXPORT', export_animation_mode='ACTIONS',
                                  export_def_bones=False, export_force_sampling=True, export_morph=False)
    tris = sum(len(p.vertices) - 2 for p in lo.data.polygons)
    return dict(body=body, tris=tris, special=nsp, bake=bake[1], unweighted=unw, glb=out and os.path.getsize(out))
