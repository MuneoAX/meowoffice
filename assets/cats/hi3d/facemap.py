"""텍스처 없는 체형(형상만 생성)용 얼굴·귀 판정 → regions.run(tex=...) 에 넘긴다.

- 눈·코·입: face 를 주면 정면 투영 좌표에 직접 그린다 (참고 시트 비율, 코 끝 기준).
  face 가 없으면 일반형(cat_lo)의 팔레트 칸을 정면 투영으로 옮긴다 (가장자리가 거칠다).
- 수염: 얇은 가닥(안쪽으로 쏜 광선이 금방 반대면에 닿음) + 볼 옆.
- 귀(접힌귀형): 머리 타원체 밖으로 튀어나온 위쪽 덩어리.
사용: tex = make('fold_lo', ear=dict(c=(0,-0.075,0.71), r=(0.235,0.215,0.19), k=1.06))
"""
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

SRC = 'cat_lo'
PUPIL, NOSE, MOUTH = 8, 6, 15


def nose_tip(name):
    vs = [v.co for v in bpy.data.objects[name].data.vertices if abs(v.co.x) < 0.03 and 0.5 < v.co.z < 0.75]
    return min(vs, key=lambda v: v.y).copy()


FACE = dict(eye_x=0.09, eye_dz=0.08, eye_rx=0.022, eye_rz=0.032, nose_w=0.02, mouth_r=0.012, mouth_w=0.0035)


def make(dst, ear=None, thin=0.025, whisker_z=(0.55, 0.74), sx=1.0, face=None, ear_inner=None):
    src = bpy.data.objects[SRC].data
    cells = src.attributes['cell'].data
    sbvh = BVHTree.FromPolygons([v.co for v in src.vertices], [p.vertices for p in src.polygons])
    ob = bpy.data.objects[dst]
    dbvh = BVHTree.FromPolygons([v.co for v in ob.data.vertices], [p.vertices for p in ob.data.polygons])
    tip = nose_tip(dst)
    dz = nose_tip(SRC).z - tip.z
    F = dict(FACE, **face) if face is not None else None

    def drawn(c):
        ax = abs(c.x); z = c.z - tip.z
        ez = F['eye_dz']
        if F.get('paint_eyes') and ((ax - F['eye_x']) / F['eye_rx']) ** 2 + ((z - ez) / F['eye_rz']) ** 2 < 1:
            return 'dark'
        if ax < F['nose_w'] and -0.014 < z < 0.012 and c.y < tip.y + 0.025:
            return 'pink'
        # 입: 코 아래 두 개의 아래쪽 반원 (ω)
        r = F['mouth_r']; mz = -0.016
        d = ((ax - r) ** 2 + (z - mz) ** 2) ** 0.5
        if F.get('paint_eyes') and z < mz + 0.002 and abs(d - r) < F['mouth_w'] and ax < 2 * r + 0.003:
            return 'dark'
        return None
    if ear:
        ec, er = Vector(ear['c']), Vector(ear['r'])

    def tex(c, n):
        ax = abs(c.x)
        # 수염 가닥
        if ax > 0.15 and whisker_z[0] < c.z < whisker_z[1]:
            hit = dbvh.ray_cast(c - n * 0.0005, -n, thin)
            if hit[0] is not None:
                return 'dark'
        # 귀: 머리 타원체 밖으로 튀어나온 위쪽 덩어리. 선 귀는 앞면(안쪽)을 분홍으로
        if ear and c.z > ear.get('z', ec.z) and ax > ear.get('ax', 0.08):
            d = c - ec
            if Vector((d.x / er.x, d.y / er.y, d.z / er.z)).length > ear['k']:
                return 'pink' if ear_inner and n.y < ear_inner['ny'] else 'ear'
        # 정면 투영
        if F and n.y < -0.1 and 0.5 < c.z < 0.8 and ax < 0.2:
            return drawn(c) or 'white'
        if not F and n.y < 0 and 0.5 < c.z < 0.8 and ax < 0.2:
            hit = sbvh.ray_cast(Vector((c.x / sx, -1.0, c.z + dz)), Vector((0, 1, 0)), 2.0)
            if hit[0] is not None:
                k = cells[hit[2]].value
                if k in (PUPIL, MOUTH):
                    return 'dark'
                if k == NOSE and ax < 0.06:
                    return 'pink'
        return 'white'
    return tex


# ── 데칼: 눈·코·입을 얼굴 표면에 붙인 얇은 형상으로 (경계가 깔끔하고 면 수가 적다) ──
def _project(bvh, pts, off):
    """off: 숫자 또는 점마다 높이 목록"""
    out = []
    for i, (x, z) in enumerate(pts):
        hit = bvh.ray_cast(Vector((x, -1.0, z)), Vector((0, 1, 0)), 2.0)
        if hit[0] is None:
            return None
        h = off[i] if isinstance(off, (list, tuple)) else off
        nrm = hit[1].normalized()
        if nrm.y > -0.35:  # 눌린 면(메운 눈구멍 벽 등)은 법선이 엉뚱하다 → 정면 쪽으로 띄운다
            nrm = (nrm + Vector((0, -1, 0))).normalized() if nrm.y < 0.3 else Vector((0, -1, 0))
        out.append(hit[0] + nrm * h)
    return out


def _dome(cx, cz, rx, rz, h, base, seg=24, rings=5):
    """엠보싱 눈: 타원 원판을 링마다 띄운다 (윗면은 살짝 둥글고 가장자리는 부드러운 경사)"""
    pts, tris = _disk(cx, cz, rx, rz, seg, rings)
    hs = [base + h]
    for r in range(1, rings + 1):
        k = r / rings
        t = max(0.0, min(1.0, (k - 0.7) / 0.3)); lift = 1 - t * t * (3 - 2 * t)
        hs += [base + h * lift * (0.88 + 0.12 * (1 - k * k))] * seg
    return pts, tris, hs


def _disk(cx, cz, rx, rz, seg=20, rings=3):
    import math
    pts = [(cx, cz)]
    for r in range(1, rings + 1):
        k = r / rings
        pts += [(cx + rx * k * math.cos(2 * math.pi * i / seg), cz + rz * k * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
    tris = [(0, 1 + i, 1 + (i + 1) % seg) for i in range(seg)]
    for r in range(1, rings):
        a, b = 1 + (r - 1) * seg, 1 + r * seg
        for i in range(seg):
            j = (i + 1) % seg
            tris += [(a + i, b + i, b + j), (a + i, b + j, a + j)]
    return pts, tris


def _strip(path, w):
    pts, tris = [], []
    for i, (x, z) in enumerate(path):
        p0 = path[max(0, i - 1)]; p1 = path[min(len(path) - 1, i + 1)]
        dx, dz = p1[0] - p0[0], p1[1] - p0[1]; L = (dx * dx + dz * dz) ** 0.5 or 1
        nx, nz = -dz / L * w / 2, dx / L * w / 2
        pts += [(x + nx, z + nz), (x - nx, z - nz)]
        if i:
            a = 2 * (i - 1)
            tris += [(a, a + 1, a + 3), (a, a + 3, a + 2)]
    return pts, tris


def _fit_surface(bvh, tip, half=0.055, n=11):
    """코 주변 얼굴면에 맞춘 매끈한 곡면 y = f(x, z) (2차). 정면에서 쏜 광선의 맞은 점으로 맞춘다."""
    import numpy as np
    rows, ys = [], []
    for i in range(n):
        for j in range(n):
            x = tip.x - half + 2 * half * i / (n - 1); z = tip.z - half + 2 * half * j / (n - 1)
            hit = bvh.ray_cast(Vector((x, -1.0, z)), Vector((0, 1, 0)), 2.0)
            if hit[0] is not None:
                rows.append([1, x, z, x * x, x * z, z * z]); ys.append(hit[0].y)
    k = np.linalg.lstsq(np.array(rows), np.array(ys), rcond=None)[0]

    def f(x, z):
        y = k @ np.array([1, x, z, x * x, x * z, z * z])
        fx = k[1] + 2 * k[3] * x + k[4] * z; fz = k[2] + k[4] * x + 2 * k[5] * z
        return float(y), Vector((fx, -1.0, fz)).normalized()
    return f


def _mouth_emboss(bvh, tip, F, off):
    """코(어두운색)·입(분홍) 엠보싱 조각 목록: (칸, (3D 점, 삼각형), None)"""
    import math
    surf = _fit_surface(bvh, tip)

    def place(x, z, h):
        y, n = surf(x, z)
        hit = bvh.ray_cast(Vector((x, -1.0, z)), Vector((0, 1, 0)), 2.0)
        if hit[0] is not None and hit[0].y < y:  # 원본이 곡면보다 앞이면 그 위로 (파묻히지 않게)
            y = hit[0].y
        return Vector((x, y, z)) + n * (off + h)

    out = []
    # 코: 둥근 역삼각형 돔 (가운데가 가장 높다)
    nw, nt, nb = F['nose_w'] * 0.62, tip.z + 0.006, tip.z - 0.009
    tri = [(-nw, nt), (nw, nt), (0, nb)]
    rim = []
    for i in range(3):
        a, b = tri[i], tri[(i + 1) % 3]
        rim += [(a[0] + (b[0] - a[0]) * t / 6, a[1] + (b[1] - a[1]) * t / 6) for t in range(6)]
    cz = (nt * 2 + nb) / 3
    pts = [place(0, cz, 0.0045)]
    mid = [place(px * 0.55, cz + (pz - cz) * 0.55, 0.0035) for px, pz in rim]
    edge = [place(px, pz, 0.0008) for px, pz in rim]
    pts += mid + edge
    m = len(rim); tris = []
    for i in range(m):
        j = (i + 1) % m
        tris.append((0, 1 + i, 1 + j))
        tris += [(1 + i, 1 + m + i, 1 + m + j), (1 + i, 1 + m + j, 1 + j)]
    out.append((6, (pts, tris), None))
    # 입: 코 아래 좌우로 맞붙은 계란 반구 두 개 (ω). mouth='shape' 이면 입은 형상(주둥이 볼록)으로만 — 그리지 않는다
    ex, ez, eh = F.get('mouth_egg', (0.0135, 0.0115, 0.0075))
    for sg in ((1, -1) if F.get('mouth', 'egg') == 'egg' else ()):
        cx, cz = sg * ex * 0.92, nb - ez * 0.55
        seg, rings = 20, 6
        flat = [(cx, cz)]
        hs = [eh]
        for r_ in range(1, rings + 1):
            k = r_ / rings
            hk = eh * max(0.0, 1 - k * k) ** 0.5  # 반타원체
            for a_ in range(seg):
                t = 2 * math.pi * a_ / seg
                flat.append((cx + ex * k * math.cos(t), cz + ez * k * math.sin(t) * (1.08 if math.sin(t) < 0 else 0.92)))
                hs.append(max(hk, 0.0003))
        tris = [(0, 1 + a_, 1 + (a_ + 1) % seg) for a_ in range(seg)]
        for r_ in range(1, rings):
            a0, b0 = 1 + (r_ - 1) * seg, 1 + r_ * seg
            for a_ in range(seg):
                b_ = (a_ + 1) % seg
                tris += [(a0 + a_, b0 + a_, b0 + b_), (a0 + a_, b0 + b_, a0 + b_)]
        out.append((15, ([place(x, z, h_) for (x, z), h_ in zip(flat, hs)], tris), None))
    return out


def _tube(path, w, h, place):
    """선을 둥글게 솟은 띠로: 단면 5점(가장자리 0 → 가운데 h)"""
    prof = [(-0.5, 0.0), (-0.3, 0.7), (0.0, 1.0), (0.3, 0.7), (0.5, 0.0)]
    pts, tris = [], []
    n = len(path)
    for i, (x, z) in enumerate(path):
        p0 = path[max(0, i - 1)]; p1 = path[min(n - 1, i + 1)]
        dx, dz = p1[0] - p0[0], p1[1] - p0[1]; L = (dx * dx + dz * dz) ** 0.5 or 1
        nx, nz = -dz / L, dx / L
        for s_, k in prof:
            pts.append(place(x + nx * s_ * w, z + nz * s_ * w, h * k))
        if i:
            a, b = (i - 1) * 5, i * 5
            for c in range(4):
                tris += [(a + c, b + c, b + c + 1), (a + c, b + c + 1, a + c + 1)]
    return pts, tris


def add_decals(obj_name, face=None, off=0.0015, whiskers=None):
    """regions.run 다음에 실행. 눈(pupil)·코(nose)·입(mouth) 데칼을 메쉬에 더한다."""
    import math
    import bmesh
    F = dict(FACE, **(face or {}))
    ob = bpy.data.objects[obj_name]; me = ob.data
    tip = nose_tip(obj_name)
    bvh = BVHTree.FromPolygons([v.co for v in me.vertices], [p.vertices for p in me.polygons])
    parts = []  # (칸, (점, 삼각형), 표면에서 띄우는 높이)
    ez = tip.z + F['eye_dz']
    for sg in (1, -1):
        pts, tris, hs = _dome(sg * F['eye_x'], ez, F['eye_rx'], F['eye_rz'], F.get('eye_h', 0.004), off + F.get('eye_lift', 0.0025))
        parts.append((8, (pts, tris), hs))
    # 코·입: 고양이 입 모양 그대로 엠보싱 (코 역삼각형 + 코 아래 짧은 세로선 + ω 두 곡선).
    # 얼굴 원본의 조각선(홈·돌기)을 따라가면 쭈글쭈글해지므로, 코 주변 얼굴면을 매끈한 곡면에 맞춰 그 위에 올린다.
    emboss = _mouth_emboss(bvh, tip, F, off)
    # 수염 (형상에 수염이 없는 체형): 볼 위 직선 (x0→x1, 높이 dz, 기울기)
    for x0, x1, dz0, dz1 in (whiskers or []):
        for sg in (1, -1):
            path = [(sg * (x0 + (x1 - x0) * i / 8), tip.z + dz0 + (dz1 - dz0) * i / 8) for i in range(9)]
            parts.append((16, _strip(path, 0.004), off))
    bm = bmesh.new(); bm.from_mesh(me)
    cl = bm.faces.layers.int['cell']; pl = bm.loops.layers.uv.get('palette')
    tl = bm.loops.layers.uv.get('tex')  # 텍스처 UV 가 이미 있으면 단색 칸으로 (skin.SWATCH 와 같은 값)
    SW = {8: 0.35, 16: 0.05, 6: 0.05, 15: 0.15, 7: 0.25}  # 눈동자는 따로 (품종마다 눈 색)
    dl = bm.faces.layers.int.get('decal') or bm.faces.layers.int.new('decal')  # 데칼 면 표시 (텍스처 UV 에서 단색 칸으로)
    added = 0
    for cell, (pts, tris), h in parts + emboss:
        if isinstance(pts[0], Vector):  # 이미 3D 좌표 (엠보싱)
            co = pts
        else:
            co = _project(bvh, pts, h)
        if co is None:
            continue
        vs = [bm.verts.new(c) for c in co]
        for t in tris:
            f = bm.faces.new([vs[i] for i in t])
            f.normal_update()
            if f.normal.y > 0:
                f.normal_flip()
            f[cl] = cell; f[dl] = 1; f.smooth = True
            if pl:
                u, v = ((cell % 8) + 0.5) / 8, 1 - ((cell // 8) + 0.5) / 8
                for l in f.loops:
                    l[pl].uv = (u, v)
            if tl:
                for l in f.loops:
                    l[tl].uv = (0.975, SW.get(cell, 0.05))
            added += 1
    bm.to_mesh(me); bm.free(); me.update()
    me.validate()  # 겹친 면 등 정리 (glTF 내보내기 경고 방지)
    return added
