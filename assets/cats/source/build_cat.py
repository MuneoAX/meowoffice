"""고양이 아바타 생성 스크립트 (Blender 5.3).

실행: Blender 안에서
    import runpy; runpy.run_path(r".../build_cat.py", init_globals={"STAGE": "shape"}, run_name="__main__")
STAGE: shape | color | rig | anim | export | all
빈 장면이 아니어도 시작 시 기존 데이터를 지우고 같은 결과를 다시 만든다.
"""

import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

# ---------------------------------------------------------------- 매개변수
BODY = dict(
    name="standard",
    ear_type="upright",  # upright | folded
    leg_length=1.0,  # 다리 길이 배율
    fluff=0.0,  # 0~1, 장모형 갈기·꼬리 (아직 미구현: 0만 지원)
    tail_thickness=1.0,  # 꼬리 굵기 배율
    body_scale=1.0,  # 몸통 배율 (머리 제외)
)
SEAT_HEIGHT = 0.4  # typing 동작의 좌석 높이 (m)
FPS = 30

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else ""
ASSET_DIR = os.path.dirname(HERE)

# ---------------------------------------------------------------- 팔레트 칸
# 8x8 칸, 인덱스 = 행*8 + 열. 영역 묶음은 주석.
CELL = {
    "body": 0,  # 몸 기본색
    "head": 1,  # 몸 기본색 (머리)
    "tail": 2,  # 몸 기본색 (꼬리)
    "belly": 3,  # 배·입 주변
    "muzzle": 4,  # 배·입 주변
    "ear_inner": 5,  # 귀 안쪽
    "nose": 6,  # 코
    "eye_white": 7,  # 눈 흰자 (반사광)
    "pupil": 8,  # 눈동자
    "mask": 9,  # 포인트: 얼굴 가면
    "ear_outer": 10,  # 포인트: 귀
    "paw": 11,  # 포인트: 손발
    "sock": 12,  # 포인트: 발목 아래 다리
    "glove": 13,  # 포인트: 손목 쪽 팔
    "tail_tip": 14,  # 포인트: 꼬리 끝
    "mouth": 15,  # 여분: 입선
    "whisker": 16,  # 여분: 수염
}


def cell_uv(i):
    col, row = i % 8, i // 8
    return ((col + 0.5) / 8.0, 1.0 - (row + 0.5) / 8.0)


# ---------------------------------------------------------------- 장면 정리
def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.actions, bpy.data.images, bpy.data.cameras,
                 bpy.data.lights, bpy.data.curves):
        for d in list(coll):
            coll.remove(d)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    sc.unit_settings.scale_length = 1.0
    sc.render.fps = FPS


def collection(name):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


# ---------------------------------------------------------------- 도형 생성기
class Part:
    """부품 하나 = bmesh + 면별 팔레트 칸."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.cell = self.bm.faces.layers.int.new("cell")

    def set_cell(self, f, c):
        f[self.cell] = CELL[c]


def frames_along(points, up_hint=Vector((0, 0, 1))):
    """경로 점마다 (접선 z, 기준 x, y) 틀. 평행 이동으로 비틀림 최소화."""
    n = len(points)
    tans = []
    for i in range(n):
        a = points[max(i - 1, 0)]
        b = points[min(i + 1, n - 1)]
        tans.append((b - a).normalized())
    x = up_hint.cross(tans[0])
    if x.length < 1e-6:
        x = Vector((1, 0, 0)).cross(tans[0])
    x.normalize()
    frames = []
    for i, t in enumerate(tans):
        if i > 0:
            x = x - t * x.dot(t)
            x.normalize()
        y = t.cross(x)
        frames.append((x.copy(), y, t))
    return frames


def tube(part, centers, rx, ry, seg, start_pole=None, end_pole=None, frames=None, up_hint=Vector((0, 0, 1)), angle0=0.0):
    """고리 모양 단면을 경로를 따라 이은 관. 양 끝은 극점 하나로 닫는다.
    반환: faces 정보 목록 (face, ring, k, t)  ring=-1 시작 극, len 끝 극."""
    bm = part.bm
    if frames is None:
        frames = frames_along(centers, up_hint)
    rings = []
    for c, (fx, fy, fz), a_r, b_r in zip(centers, frames, rx, ry):
        ring = []
        for k in range(seg):
            a = angle0 + 2 * math.pi * k / seg
            ring.append(bm.verts.new(c + fx * (a_r * math.cos(a)) + fy * (b_r * math.sin(a))))
        rings.append(ring)
    n = len(rings)
    info = []
    for i in range(n - 1):
        for k in range(seg):
            k2 = (k + 1) % seg
            f = bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
            info.append((f, i, k, (i + 0.5) / max(n - 1, 1)))
    if start_pole is not None:
        p = bm.verts.new(start_pole)
        for k in range(seg):
            f = bm.faces.new((rings[0][(k + 1) % seg], rings[0][k], p))
            info.append((f, -1, k, 0.0))
    if end_pole is not None:
        p = bm.verts.new(end_pole)
        for k in range(seg):
            f = bm.faces.new((rings[-1][k], rings[-1][(k + 1) % seg], p))
            info.append((f, n, k, 1.0))
    return info


def ellipsoid(part, center, radii, axis_frame, angles_deg, seg, angle0=0.0):
    """극축 = axis_frame 의 z. angles_deg 는 시작 극에서 잰 고리 각도(오름차순, 0~180 사이).
    radii = (x, y, z) 틀 기준 반지름."""
    fx, fy, fz = axis_frame
    centers, rxs, rys = [], [], []
    for d in angles_deg:
        th = math.radians(d)
        centers.append(center + fz * (-math.cos(th) * radii[2]))
        rxs.append(math.sin(th) * radii[0])
        rys.append(math.sin(th) * radii[1])
    frames = [(fx, fy, fz)] * len(centers)
    return tube(part, centers, rxs, rys, seg, start_pole=center - fz * radii[2], end_pole=center + fz * radii[2], frames=frames,
                angle0=angle0)


def basis_from(z, x_hint):
    z = z.normalized()
    x = (x_hint - z * x_hint.dot(z)).normalized()
    return (x, z.cross(x), z)


def face_center(f):
    return f.calc_center_median()


# ---------------------------------------------------------------- 치수 (일반형 기준)
def dims(B):
    d = {}
    bs = B["body_scale"]
    d["ankle_z"] = 0.05
    d["hip_z"] = d["ankle_z"] + 0.152 * B["leg_length"]
    d["torso_bot"] = d["hip_z"] - 0.06 * bs
    d["torso_h"] = 0.30 * bs
    d["torso_top"] = d["torso_bot"] + d["torso_h"]
    d["torso_rx"] = 0.155 * bs
    d["torso_ry"] = 0.135 * bs
    d["head_w"], d["head_h"], d["head_d"] = 0.50, 0.40, 0.38
    d["head_c"] = Vector((0, 0.0, d["torso_top"] + d["head_h"] * 0.5 - 0.05))
    d["shoulder"] = Vector((0.12 * bs, 0.0, d["torso_bot"] + 0.235 * bs))
    d["hip"] = Vector((0.075 * bs, 0.0, d["hip_z"]))
    return d


# ---------------------------------------------------------------- 부품
def build_head(B, D):
    p = Part("Head")
    hc = D["head_c"]
    tilt = math.radians(18)
    # 극축: 앞(-Y)에서 아래로 tilt. 끝 극(180도 쪽)이 얼굴 중심(코).
    fz = Vector((0, -math.cos(tilt), -math.sin(tilt)))
    frame = basis_from(fz, Vector((1, 0, 0)))
    # 시작 극(뒤통수)에서 잰 각도. 앞쪽 = 180-각.
    front = [8, 15, 22, 29, 36, 43, 50, 60, 72, 85, 98, 112, 127, 142, 158]
    angles = sorted(180 - a for a in front)
    info = ellipsoid(p, Vector((0, 0, 0)), (1, 1, 1), frame, angles, 36)
    # 단위구 → 머리 모양: 폭·높이·깊이, 아래 볼 쪽을 조금 넓힘
    W, H, Dp = D["head_w"] / 2, D["head_h"] / 2, D["head_d"] / 2
    for v in p.bm.verts:
        x, y, z = v.co
        cheek = 1.0 + 0.10 * max(0.0, 0.35 - z) / 1.35  # 아래로 갈수록 넓게
        top = 1.0 - 0.06 * max(0.0, z)  # 정수리 약간 납작
        v.co = Vector((x * W * cheek, y * Dp, z * H * top)) + hc
    for f, ring, k, t in info:
        # ring 은 angles 오름차순 기준. 앞 극에서 잰 각도
        if ring >= len(angles):
            fa = 0.0
        elif ring < 0:
            fa = 180.0
        else:
            lo = 180 - angles[ring]
            hi = 180 - angles[ring + 1] if ring + 1 < len(angles) else 0.0
            fa = (lo + hi) / 2
        if fa < 22:
            p.set_cell(f, "muzzle")
        elif fa < 50:
            p.set_cell(f, "mask")
        else:
            p.set_cell(f, "head")
    return p


def head_bvh(head):
    bmesh.ops.recalc_face_normals(head.bm, faces=head.bm.faces)
    head.bm.normal_update()
    return BVHTree.FromBMesh(head.bm)


def project_front(bvh, x, z, push=0.002, y0=-1.0):
    """앞에서 +Y 방향으로 쏘아 머리 표면점과 법선."""
    hit, nrm, _, _ = bvh.ray_cast(Vector((x, y0, z)), Vector((0, 1, 0)))
    if hit is None:
        raise RuntimeError(f"머리 표면 투영 실패 x={x} z={z}")
    return hit + nrm * push, nrm


def flat_disc(p, bvh, cx, cz, rw, rh, seg, rings, cell, push, ring_cells=None, dome=0.0):
    """머리 표면에 붙는 납작한 타원 원판. 중심 극 + 고리. dome: 가운데를 볼록하게 띄우는 양."""
    bm = p.bm
    center, _ = project_front(bvh, cx, cz, push + dome)
    cv = bm.verts.new(center)
    prev = None
    rows = []
    for r in range(1, rings + 1):
        s = r / rings
        row = []
        for k in range(seg):
            a = 2 * math.pi * k / seg
            co, _ = project_front(bvh, cx + rw * s * math.cos(a), cz + rh * s * math.sin(a), push + dome * (1 - s * s))
            row.append(bm.verts.new(co))
        rows.append(row)
    faces = []
    for k in range(seg):
        f = bm.faces.new((cv, rows[0][k], rows[0][(k + 1) % seg]))
        faces.append((f, 0))
    for r in range(rings - 1):
        for k in range(seg):
            k2 = (k + 1) % seg
            f = bm.faces.new((rows[r][k], rows[r + 1][k], rows[r + 1][k2], rows[r][k2]))
            faces.append((f, r + 1))
    for f, r in faces:
        p.set_cell(f, ring_cells[r] if ring_cells else cell)
    for f, _ in faces:
        f.normal_update()
        if f.normal.y > 0:
            f.normal_flip()
    return faces


def build_eye_L(B, D, bvh):
    p = Part("Eye.L")
    hc = D["head_c"]
    ex, ez = 0.105, hc.z - 0.006
    flat_disc(p, bvh, ex, ez, 0.034, 0.045, 20, 2, "pupil", 0.003, dome=0.007)
    # 반사광: 위쪽 바깥
    flat_disc(p, bvh, ex + 0.009, ez + 0.019, 0.011, 0.012, 8, 1, "eye_white", 0.0095)
    return p


def build_nose(B, D, bvh):
    p = Part("Nose")
    hc = D["head_c"]
    nz = hc.z - 0.045
    co, nrm = project_front(bvh, 0.0, nz, -0.004)
    frame = basis_from(nrm, Vector((1, 0, 0)))  # z = 표면 바깥
    info = ellipsoid(p, co, (0.018, 0.011, 0.011), (frame[0], frame[1], frame[2]), [30, 60, 90, 120, 150], 10)
    # 위가 넓은 역삼각 느낌: 아래쪽 꼭짓점을 안으로
    for v in p.bm.verts:
        dz = v.co.z - co.z
        if dz < 0:
            v.co.x = v.co.x * (1 + dz / 0.016)
    for f, *_ in info:
        p.set_cell(f, "nose")
    return p


def arc_tube(p, pts, r, seg, cell):
    info = tube(p, pts, [r] * len(pts), [r] * len(pts), seg, start_pole=None, end_pole=None, up_hint=Vector((0, -1, 0)))
    bm = p.bm
    for f, *_ in info:
        p.set_cell(f, cell)
    return info


def build_mouth_L(B, D, bvh):
    """ω 의 왼쪽 반쪽: 코 아래에서 바깥으로 내려갔다 올라가는 호."""
    p = Part("Mouth.L")
    hc = D["head_c"]
    nz = hc.z - 0.058
    pts = []
    n = 7
    for i in range(n):
        a = math.pi * (1.0 - i / (n - 1))  # 180 -> 0
        x = 0.012 + 0.012 * math.cos(a) + 0.0
        z = nz - 0.011 * math.sin(a)
        co, _ = project_front(bvh, x, z, 0.0015)
        pts.append(co)
    # 시작점을 중앙선에 맞춤
    info = tube(p, pts, [0.0026] * n, [0.0026] * n, 4, start_pole=None, end_pole=None, up_hint=Vector((0, -1, 0)))
    for f, *_ in info:
        p.set_cell(f, "mouth")
    p.bm.verts.ensure_lookup_table()
    return p


def build_whiskers_L(B, D, bvh):
    p = Part("Whiskers.L")
    hc = D["head_c"]
    for j, ang in enumerate((14, 2, -10)):
        x0, z0 = 0.135, hc.z - 0.045 - j * 0.012
        start, _ = project_front(bvh, x0, z0, -0.006)
        a = math.radians(ang)
        L = 0.13
        pts = []
        for i in range(4):
            s = i / 3
            droop = -0.012 * s * s
            pts.append(start + Vector((math.cos(a) * L * s, -0.02 * s, math.sin(a) * L * s + droop)))
        r = 0.0024
        info = tube(p, pts, [r, r, r * 0.8, r * 0.5], [r, r, r * 0.8, r * 0.5], 3, start_pole=None, end_pole=pts[-1] + (pts[-1] - pts[-2]).normalized() * 0.004,
                    up_hint=Vector((0, -1, 0)))
        for f, *_ in info:
            p.set_cell(f, "whisker")
    return p


def build_ear_L(B, D, bvh):
    p = Part("Ear.L")
    hc = D["head_c"]
    d = Vector((0.50, 0.04, 0.86)).normalized()
    hit, nrm, _, _ = bvh.ray_cast(hc + d * 1.0, -d)
    base = hit - d * 0.025
    axis = Vector((math.sin(math.radians(18)), math.sin(math.radians(6)), 1)).normalized()
    fx, fy, fz = basis_from(axis, Vector((1, 0, 0)))
    yaw = math.radians(-12)  # 앞면이 약간 바깥을 보게
    R = Matrix.Rotation(yaw, 3, fz)
    fx, fy = R @ fx, R @ fy
    Hh = 0.165
    ts = [0.0, 0.18, 0.36, 0.54, 0.72, 0.88]
    centers, rx, ry = [], [], []
    for t in ts:
        w = (1 - t) ** 0.85
        centers.append(base + fz * (Hh * t))
        rx.append(0.088 * w)
        ry.append(0.030 * w + 0.004)
    frames = [(fx, fy, fz)] * len(ts)
    seg = 12
    info = tube(p, centers, rx, ry, seg, start_pole=base - fz * 0.02, end_pole=base + fz * Hh, frames=frames)
    # 귀 앞면(-fy 쪽) 오목하게
    for v in p.bm.verts:
        rel = v.co - base
        ly = rel.dot(fy)
        lx = rel.dot(fx)
        t = rel.dot(fz) / Hh
        if ly < 0 and 0.05 < t < 0.95:
            w = max(0.0, 1 - (lx / (0.088 * (1 - t) ** 0.85 + 1e-6)) ** 2)
            v.co += fy * (0.016 * w * (1 - t))
    if B["ear_type"] == "folded":
        pivot_t = 0.40
        pivot = base + fz * (Hh * pivot_t)
        Rf = Matrix.Rotation(math.radians(115), 3, fx)  # 앞으로 접기
        for v in p.bm.verts:
            rel = v.co - base
            t = rel.dot(fz) / Hh
            if t > pivot_t:
                k = min(1.0, (t - pivot_t) / 0.15)
                Rk = Matrix.Rotation(math.radians(115) * k, 3, -fx)
                v.co = pivot + Rk @ (v.co - pivot)
    for f, ring, k, t in info:
        a = (k + 0.5) / seg * 2 * math.pi
        front = math.sin(a) < -0.45
        if front and 0 <= ring <= len(ts) - 2:
            p.set_cell(f, "ear_inner")
        else:
            p.set_cell(f, "ear_outer")
    return p


def build_torso(B, D):
    p = Part("Torso")
    bot, h = D["torso_bot"], D["torso_h"]
    # 아래가 넓은 배 모양 프로필 (높이 비율, 반지름 비율)
    prof = [(0.06, 0.55), (0.15, 0.82), (0.27, 0.96), (0.40, 1.0), (0.52, 0.98), (0.63, 0.92), (0.73, 0.84), (0.82, 0.74),
            (0.90, 0.60), (0.96, 0.40)]
    centers = [Vector((0, 0, bot + h * t)) for t, _ in prof]
    rx = [D["torso_rx"] * r for _, r in prof]
    ry = [D["torso_ry"] * r for _, r in prof]
    frames = [(Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))] * len(prof)
    seg = 24
    info = tube(p, centers, rx, ry, seg, start_pole=Vector((0, 0, bot)), end_pole=Vector((0, 0, bot + h)), frames=frames,
                angle0=math.pi / seg)
    for f, ring, k, t in info:
        a = (k + 0.5) / seg * 2 * math.pi + math.pi / seg
        # 앞 = -Y = sin(a) < 0
        fwd = -math.sin(a)
        if fwd > 0.62 and 1 <= ring <= 7:
            p.set_cell(f, "belly")
        else:
            p.set_cell(f, "body")
    return p


def build_arm_L(B, D):
    p = Part("Arm.L")
    sh = D["shoulder"]
    ang = math.radians(45)
    dirv = Vector((math.sin(ang), 0.0, -math.cos(ang)))
    L = 0.155
    ts = [0.0, 0.15, 0.32, 0.45, 0.55, 0.68, 0.82, 1.0]  # 팔꿈치(0.5) 근처 촘촘
    centers = [sh + dirv * (L * t) for t in ts]
    r = [0.052 - 0.008 * t for t in ts]
    seg = 12
    info = tube(p, centers, r, r, seg, start_pole=sh - dirv * 0.03, end_pole=None, up_hint=Vector((0, -1, 0)))
    for f, ring, k, t in info:
        p.set_cell(f, "glove" if ring >= 5 else "body")
    # 손: 둥근 덩어리
    hand_c = sh + dirv * (L + 0.03)
    frame = basis_from(dirv, Vector((0, -1, 0)))
    info = ellipsoid(p, hand_c, (0.052, 0.048, 0.054), frame, [25, 55, 85, 115, 145], 12)
    for f, *_ in info:
        p.set_cell(f, "paw")
    return p


def build_leg_L(B, D):
    p = Part("Leg.L")
    hip = D["hip"]
    top = hip + Vector((0, 0, 0.05))
    ank = Vector((hip.x + 0.005, 0.0, D["ankle_z"]))
    ts = [0.0, 0.2, 0.4, 0.5, 0.6, 0.78, 0.9, 1.0]  # 무릎 0.5, 양말 경계 0.78
    centers = [top.lerp(ank, t) for t in ts]
    r = [0.068 - 0.012 * t for t in ts]
    seg = 12
    info = tube(p, centers, r, r, seg, start_pole=None, end_pole=None, frames=[(Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, -1)))] * len(ts))
    for f, ring, k, t in info:
        p.set_cell(f, "sock" if ring >= 5 else "body")
    # 발
    fc = Vector((ank.x + 0.004, -0.028, 0.034))
    frame = (Vector((1, 0, 0)), Vector((0, 0, 1)), Vector((0, -1, 0)))  # 극축 = 앞
    info = ellipsoid(p, fc, (0.06, 0.04, 0.082), frame, [22, 50, 80, 110, 140, 162], 12)
    # 발바닥 평평하게
    for v in p.bm.verts:
        if v.co.z < 0.0:
            v.co.z = 0.0
    for f, *_ in info:
        p.set_cell(f, "paw")
    return p


def build_tail(B, D):
    p = Part("Tail")
    th = B["tail_thickness"]
    p0 = Vector((0, D["torso_ry"] * 0.75, D["torso_bot"] + 0.07))
    p1 = Vector((0, p0.y + 0.26, p0.z - 0.02))
    p2 = Vector((0, p0.y + 0.30, p0.z + 0.30))
    p3 = Vector((0, p0.y + 0.20, p0.z + 0.42))
    n = 17
    pts = []
    for i in range(n):
        s = i / (n - 1)
        a = (1 - s) ** 3 * p0 + 3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s * s * p2 + s ** 3 * p3
        pts.append(a)
    r = [0.033 * th * (1.0 if i < n - 4 else 1.0 - 0.18 * (i - (n - 4))) for i in range(n)]
    seg = 10
    tip = pts[-1] + (pts[-1] - pts[-2]).normalized() * r[-1]
    info = tube(p, pts, r, r, seg, start_pole=pts[0] - (pts[1] - pts[0]).normalized() * 0.02, end_pole=tip, up_hint=Vector((1, 0, 0)))
    for f, ring, k, t in info:
        p.set_cell(f, "tail_tip" if ring >= n - 5 else "tail")
    return p


# ---------------------------------------------------------------- 대칭·객체화
def mirror_part(src, name):
    p = Part(name)
    src.bm.faces.ensure_lookup_table()
    mp = {}
    for v in src.bm.verts:
        mp[v] = p.bm.verts.new(Vector((-v.co.x, v.co.y, v.co.z)))
    for f in src.bm.faces:
        nf = p.bm.faces.new([mp[v] for v in reversed(f.verts)])
        nf[p.cell] = f[src.cell]
    return p


def to_object(p, coll):
    bm = p.bm
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    closed = all(e.is_manifold for e in bm.edges)
    if closed:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new(p.name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(p.name, me)
    coll.objects.link(ob)
    vg = ob.vertex_groups.new(name="part:" + p.name)
    vg.add(list(range(len(me.vertices))), 1.0, "REPLACE")
    return ob


def build_shape(B=BODY):
    D = dims(B)
    coll = collection("Cat")
    head = build_head(B, D)
    bvh = head_bvh(head)
    parts = [head]
    left = [build_eye_L(B, D, bvh), build_mouth_L(B, D, bvh), build_whiskers_L(B, D, bvh), build_ear_L(B, D, bvh),
            build_arm_L(B, D), build_leg_L(B, D)]
    parts.append(build_nose(B, D, bvh))
    parts.append(build_torso(B, D))
    parts.append(build_tail(B, D))
    for lp in left:
        parts.append(lp)
        parts.append(mirror_part(lp, lp.name[:-2] + ".R"))
    obs = [to_object(p, coll) for p in parts]
    # 단순 결합
    with bpy.context.temp_override(active_object=obs[0], object=obs[0], selected_objects=obs, selected_editable_objects=obs):
        bpy.ops.object.join()
    cat = obs[0]
    cat.name = "Cat"
    cat.data.name = "Cat"
    # 팔레트 질감 좌표(UV1): 면의 모든 꼭짓점을 칸 중앙 한 점으로
    me = cat.data
    uv = me.uv_layers.new(name="palette")
    cells = me.attributes["cell"].data
    for poly in me.polygons:
        u, v = cell_uv(cells[poly.index].value)
        for li in poly.loop_indices:
            uv.data[li].uv = (u, v)
    return cat


# ---------------------------------------------------------------- 미리보기용 색(내보내기 전 삭제)
PREVIEW = {
    "pupil": (0.03, 0.03, 0.04), "eye_white": (1, 1, 1), "nose": (0.95, 0.55, 0.6), "ear_inner": (0.98, 0.7, 0.72),
    "mouth": (0.15, 0.1, 0.1), "whisker": (0.12, 0.12, 0.12),
}


def add_preview_colors(cat):
    me = cat.data
    ca = me.color_attributes.new("preview", "BYTE_COLOR", "CORNER")
    inv = {v: k for k, v in CELL.items()}
    cells = me.attributes["cell"].data
    for poly in me.polygons:
        c = PREVIEW.get(inv[cells[poly.index].value], (0.93, 0.92, 0.9))
        for li in poly.loop_indices:
            ca.data[li].color = (*c, 1.0)


def capture_setup():
    coll = collection("Capture")
    cam_d = bpy.data.cameras.new("CaptureCam")
    cam = bpy.data.objects.new("CaptureCam", cam_d)
    cam.location = (1.6, -2.4, 1.4)
    cam.rotation_euler = (math.radians(70), 0, math.radians(34))
    coll.objects.link(cam)
    sun_d = bpy.data.lights.new("CaptureSun", "SUN")
    sun_d.energy = 3.0
    sun = bpy.data.objects.new("CaptureSun", sun_d)
    sun.rotation_euler = (math.radians(45), 0, math.radians(30))
    coll.objects.link(sun)
    bpy.context.scene.camera = cam


def save():
    path = os.path.join(HERE, "cat_standard.blend")
    bpy.ops.wm.save_as_mainfile(filepath=path, check_existing=False)
    return path


def report(cat):
    me = cat.data
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    zs = [v.co.z for v in me.vertices]
    bb = [cat.matrix_world @ Vector(c) for c in cat.bound_box]
    xs = [c.x for c in bb]
    ys = [c.y for c in bb]
    print(f"tris={tris} verts={len(me.vertices)} height={max(zs) - min(zs):.4f} minz={min(zs):.4f} "
          f"width={max(xs) - min(xs):.3f} depth={max(ys) - min(ys):.3f}")
    # 부품별 삼각형
    vg_names = {g.index: g.name for g in cat.vertex_groups}
    per = {}
    for p in me.polygons:
        g = me.vertices[p.vertices[0]].groups[0].group
        per[vg_names[g]] = per.get(vg_names[g], 0) + len(p.vertices) - 2
    print(per)


def main(stage):
    clear_scene()
    cat = build_shape(BODY)
    capture_setup()
    if stage == "shape":
        add_preview_colors(cat)
        report(cat)
        print("saved", save())
        return cat


if __name__ == "__main__":
    main(globals().get("STAGE", "all"))
