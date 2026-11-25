"""고양이 메쉬 부위 판정 → 팔레트 칸 (4체형 공용).

판정 = 원본 텍스처 색(검정: 눈·입·수염 / 분홍: 귀 안쪽·코) + 위치·면 방향 규칙(주둥이·가면·배·손발·양말·꼬리 끝 등).
경계가 매끄럽도록: 경계 삼각형만 잘게 나누고 다시 판정, 외톨이 삼각형은 이웃 다수결로 정리.

사용: Blender 안에서 runpy 로 실행 → run(obj_name, levels=2)
체형별 치수(머리 높이, 귀 높이 등)는 LAND 에서 조정한다.
"""
import collections

import bmesh
import bpy
from mathutils import Vector

CELL = {"body": 0, "head": 1, "tail": 2, "belly": 3, "muzzle": 4, "ear_inner": 5, "nose": 6, "eye_white": 7, "pupil": 8,
        "mask": 9, "ear_outer": 10, "paw": 11, "sock": 12, "glove": 13, "tail_tip": 14, "mouth": 15, "whisker": 16}
TEXTURE_CELLS = {CELL['pupil'], CELL['mouth'], CELL['whisker'], CELL['nose'], CELL['ear_inner']}

# 일반형 기준 치수 (키 0.9 m, 발바닥 원점, 정면 -Y)
LAND = dict(head_z=0.46, ear_z=0.78, arm_x=0.19, arm_z=(0.28, 0.52), hand_x=0.33, glove_x=0.27,
            tail_y=0.1, tail_tip_y=0.3, leg_z=0.17, paw_z=0.045, sock_z=0.10, belly_x=0.11)
# 접힌귀형: 귀는 facemap 이 판정(ear_z 끔), 꼬리는 위로 말려 끝을 높이로 판정
LAND_FOLD = dict(LAND, head_z=0.515, ear_z=2.0, eye_z=0.65, arm_z=(0.38, 0.53), arm_top=0.51, hand_x=0.30, glove_x=0.25,
                 tail_y=0.17, tail_zmax=0.56, tail_tip_z=0.45, leg_z=0.15)
# 짧은다리형: 다리가 0.07 m 남짓, 꼬리는 바닥에 누워 뒤로 뻗는다 (귀는 facemap 이 머리 타원체 밖으로 판정, 앞면은 분홍)
LAND_SHORT = dict(LAND, head_z=0.43, ear_z=2.0, ear_inner_z=0.7, eye_z=0.6, arm_x=0.17, arm_z=(0.3, 0.44), arm_top=0.43, hand_x=0.29,
                  glove_x=0.24, tail_y=0.13, tail_zmax=0.2, tail_tip_y=0.25, leg_z=0.07, paw_z=0.025, sock_z=0.05, belly_x=0.1)
# 장모형: 목 갈기, 꼬리는 바닥에서 오른쪽(+x)으로 말림 → 꼬리 끝은 x 로 판정
LAND_LONG = dict(LAND, head_z=0.5, ear_z=2.0, ear_inner_z=0.72, eye_z=0.64, arm_x=0.23, arm_z=(0.38, 0.5), arm_top=0.5,
                 hand_x=0.31, glove_x=0.27, tail_y=0.13, tail_zmax=0.25, tail_tip_x=0.17, leg_z=0.12, paw_z=0.035,
                 sock_z=0.07, belly_x=0.12)


def tex_sampler(image_name='Image_0', size=512):
    img = bpy.data.images[image_name]
    sm = bpy.data.images.get('tex_small')
    if not sm:
        sm = img.copy(); sm.name = 'tex_small'; sm.scale(size, size)
    W, H = sm.size
    px = sm.pixels[:]

    def sample(u, v):
        x = min(W - 1, max(0, int((u % 1) * W))); y = min(H - 1, max(0, int((v % 1) * H)))
        i = (y * W + x) * 4
        return px[i], px[i + 1], px[i + 2]
    return sample


def tex_class(rgb):
    r, g, b = rgb
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    if lum < 0.25:
        return 'dark'
    if r > g + 0.1 and r > b + 0.05:
        return 'pink'
    if lum < 0.55:
        return 'gray'
    return 'white'


def classify(c, n, tcls, nose, maskc, L=LAND):
    ax = abs(c.x)
    if tcls == 'ear':
        return 'ear_outer'
    if tcls in ('dark', 'gray'):
        return 'whisker' if ax > 0.15 else ('pupil' if c.z > nose.z + 0.02 else 'mouth')
    if tcls == 'pink':
        return 'ear_inner' if c.z > L.get('ear_inner_z', L['ear_z'] - 0.06) else 'nose'
    if c.z > L['head_z'] and ax < 0.27 and not (ax > L['arm_x'] and c.z < L.get('arm_top', 0.5)):
        if c.z > L['ear_z'] and ax > 0.08:
            return 'ear_outer'
        if n.y < -0.2 and (c - nose).length < 0.075:
            return 'muzzle'
        # 가면: 코·눈 사이 중심의 타원 (가로 넓게, 세로 좁게)
        d = Vector(((c.x - maskc.x) / 0.16, (c.y - maskc.y) / 0.2, (c.z - maskc.z) / 0.12))
        if n.y < -0.05 and d.length < 1.0:
            return 'mask'
        return 'head'
    if ax > L['arm_x'] and L['arm_z'][0] < c.z < L['arm_z'][1]:
        return 'paw' if ax > L['hand_x'] else ('glove' if ax > L['glove_x'] else 'body')
    if c.y > L['tail_y'] and c.z < L.get('tail_zmax', 0.42):
        tip = (c.z > L['tail_tip_z'] if 'tail_tip_z' in L else
               c.x > L['tail_tip_x'] if 'tail_tip_x' in L else c.y > L['tail_tip_y'])
        return 'tail_tip' if tip else 'tail'
    if c.z < L['leg_z']:
        return 'paw' if c.z < L['paw_z'] else ('sock' if c.z < L['sock_z'] else 'body')
    if L['leg_z'] < c.z < L['head_z'] - 0.01 and ax < L['belly_x'] and n.y < -0.55:
        return 'belly'
    return 'body'


def run(obj_name='cat_lo', levels=2, smooth_iters=2, L=LAND, tex=None):
    """tex: 텍스처 없는 체형용 판정 함수 (면 중심, 법선) → 'dark'|'pink'|'gray'|'white'"""
    ob = bpy.data.objects[obj_name]
    me = ob.data
    sample = None if tex else tex_sampler()
    bm = bmesh.new(); bm.from_mesh(me)
    uvl = bm.loops.layers.uv.get('UVMap')
    cl = bm.faces.layers.int.get('cell') or bm.faces.layers.int.new('cell')

    def face_tex(f):
        if tex:
            return tex(f.calc_center_median(), f.normal)
        u = sum(l[uvl].uv[0] for l in f.loops) / len(f.loops)
        v = sum(l[uvl].uv[1] for l in f.loops) / len(f.loops)
        return tex_class(sample(u, v))

    def landmarks():
        pink = [f.calc_center_median() for f in bm.faces if face_tex(f) == 'pink' and f.calc_center_median().z < L.get('ear_inner_z', L['ear_z'] - 0.06)]
        nose = sum(pink, Vector()) / len(pink)
        eyes = [f.calc_center_median() for f in bm.faces if face_tex(f) in ('dark', 'gray') and abs(f.calc_center_median().x) < 0.15 and f.calc_center_median().z > L.get('eye_z', 0.58)]
        eyec = sum(eyes, Vector()) / len(eyes) if eyes else nose + Vector((0, 0, 0.05))
        return nose, Vector((0, nose.y + 0.02, (nose.z + eyec.z) / 2 + 0.01))

    def label_all():
        nose, maskc = landmarks()
        for f in bm.faces:
            f[cl] = CELL[classify(f.calc_center_median(), f.normal, face_tex(f), nose, maskc, L)]

    bm.normal_update()
    label_all()
    # 경계 삼각형만 잘게 나누고 다시 판정
    for _ in range(levels):
        edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.link_faces[0][cl] != e.link_faces[1][cl]]
        if not edges:
            break
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
        bm.normal_update()
        label_all()
    # 외톨이 정리: 이웃 다수결 (텍스처에서 온 눈·코·입·수염·귀 안쪽은 그대로)
    for _ in range(smooth_iters):
        change = []
        for f in bm.faces:
            if f[cl] in TEXTURE_CELLS:
                continue
            nb = [g[cl] for e in f.edges for g in e.link_faces if g is not f]
            if not nb:
                continue
            top, cnt = collections.Counter(nb).most_common(1)[0]
            if top != f[cl] and cnt >= 2 and top not in TEXTURE_CELLS:
                change.append((f, top))
        for f, c in change:
            f[cl] = c
    # 팔레트 UV
    pl = bm.loops.layers.uv.get('palette') or bm.loops.layers.uv.new('palette')
    for f in bm.faces:
        ci = f[cl]
        u, v = ((ci % 8) + 0.5) / 8, 1 - ((ci // 8) + 0.5) / 8
        for l in f.loops:
            l[pl].uv = (u, v)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(me); bm.free(); me.update()
    return sum(len(p.vertices) - 2 for p in me.polygons)
