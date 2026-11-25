"""품종 텍스처(스킨) 생성기 — Blender 없이 실행 (numpy + PIL).

입력: bake/<체형>.npz (skin.py 가 구운 텍스처 픽셀별 표면 위치·법선)
출력: ui/office/models/cats/skins/<품종>.png (1024², 체형 glb 의 'tex' UV 용)
- 부위(머리·귀·주둥이·배·손발·꼬리)는 체형 치수로 정한 3D 영역, 경계는 부드럽게(약 3 mm).
- 무늬(고등어 줄무늬·벵갈 점·삼색 얼룩·포인트)는 3D 위치 함수 → UV 이음매가 없다.
- 오른쪽 끝 단색 칸: 눈동자·입·수염(어두운색) / 코 / 눈 반짝임(흰색).
품종 목록·색은 '품종 도감' 디자인(16종) 기준. 실행: python breeds.py [품종 ...]
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'ui', 'office', 'models', 'cats', 'skins')
SIZE = 1024
EDGE = 0.003  # 경계 부드러움 (m)

# ── 체형 치수 (regions.py LAND_*, facemap 얼굴 값과 같은 기준) ─────────────────────────
BODY = {
    'standard': dict(head_z=0.46, ear=('z', 0.78), arm_x=0.19, arm_z=(0.28, 0.52), hand_x=0.33, glove_x=0.27,
                     tail_y=0.1, tail_zmax=0.42, tip=('y', 0.3), leg_z=0.17, paw_z=0.045, sock_z=0.10, belly_x=0.11,
                     body_y=-0.06, nose=(0, -0.381, 0.567), eye=(0.087, 0.081), head_c=(0, -0.15, 0.63),
                     ear_tri=(0.74, 0.155, 0.06, 0.89, 0.17)),
    'foldear': dict(head_z=0.515, ear=('ell', (0, -0.075, 0.71), (0.235, 0.215, 0.19), 1.06, 0.08, 0.71), fold=True,
                    arm_x=0.19, arm_z=(0.38, 0.53), hand_x=0.30, glove_x=0.25, tail_y=0.17, tail_zmax=0.56,
                    tip=('z', 0.45), leg_z=0.15, paw_z=0.045, sock_z=0.10, belly_x=0.11, body_y=0.0,
                    nose=(0, -0.291, 0.62), eye=(0.09, 0.08), head_c=(0, -0.075, 0.71)),
    'shortleg': dict(head_z=0.43, ear=('ell', (0, -0.08, 0.63), (0.26, 0.22, 0.2), 1.06, 0.11, 0.63), arm_x=0.17,
                     arm_z=(0.3, 0.44), hand_x=0.29, glove_x=0.24, tail_y=0.13, tail_zmax=0.2, tip=('y', 0.25),
                     leg_z=0.07, paw_z=0.025, sock_z=0.05, belly_x=0.1, body_y=-0.035,
                     nose=(0, -0.303, 0.555), eye=(0.1, 0.07), head_c=(0, -0.08, 0.63),
                     ear_tri=(0.75, 0.17, 0.065, 0.9, 0.2)),
    'longhair': dict(head_z=0.5, ear=('ell', (0, -0.067, 0.67), (0.25, 0.22, 0.185), 1.1, 0.1, 0.74), arm_x=0.23,
                     arm_z=(0.38, 0.5), hand_x=0.31, glove_x=0.27, tail_y=0.13, tail_zmax=0.25, tip=('x', 0.17),
                     leg_z=0.12, paw_z=0.035, sock_z=0.07, belly_x=0.12, body_y=-0.05,
                     nose=(0, -0.294, 0.597), eye=(0.095, 0.085), head_c=(0, -0.067, 0.67),
                     ear_tri=(0.76, 0.16, 0.06, 0.92, 0.18)),
}


def ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def above(x, edge, w=EDGE):  # x > edge 이면 1 (부드럽게)
    return ss(edge - w, edge + w, x)


def hexc(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], dtype=np.float32)


# ── 값 잡음 (3D, 격자 해시 + 삼선형 보간) ─────────────────────────────────────────
def vnoise(p, freq, seed=0):
    q = p * freq + seed * 17.13
    i = np.floor(q).astype(np.int64); f = q - i
    f = f * f * (3 - 2 * f)

    def h(ix, iy, iz):
        n = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761)
        n = (n ^ (n >> 13)) * 1274126177
        return ((n ^ (n >> 16)) & 0xffff) / 65535.0
    x, y, z = i[:, 0], i[:, 1], i[:, 2]
    fx, fy, fz = f[:, 0], f[:, 1], f[:, 2]
    c = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (fx if dx else 1 - fx) * (fy if dy else 1 - fy) * (fz if dz else 1 - fz)
                c = c + w * h(x + dx, y + dy, z + dz)
    return c


def fbm(p, freq, seed=0, oct=3):
    a, s, t = 0.0, 1.0, 0.0
    for o in range(oct):
        a = a + s * vnoise(p, freq * 2 ** o, seed + o)
        t += s; s *= 0.5
    return a / t


# ── 부위 마스크 ──────────────────────────────────────────────────────────────
class Ctx:
    def __init__(self, body):
        d = np.load(os.path.join(HERE, 'bake', body + '.npz'))
        self.mask = d['mask']
        self.p = d['pos'].astype(np.float32)[self.mask]
        self.n = d['nrm'].astype(np.float32)[self.mask]
        self.B = B = BODY[body]
        p = self.p; x, y, z = p[:, 0], p[:, 1], p[:, 2]; ax = np.abs(x)
        self.x, self.y, self.z, self.ax = x, y, z, ax
        nose = np.array(B['nose']); self.nose = nose
        armzone = (above(ax, B['arm_x']) * above(z, B['arm_z'][0]) * (1 - above(z, B['arm_z'][1])))
        self.arm = armzone
        self.head = above(z, B['head_z']) * (1 - above(ax, 0.27)) * (1 - armzone)
        # 귀
        e = B['ear']
        if e[0] == 'z':
            self.ear = self.head * above(z, e[1]) * above(ax, 0.08, 0.01)
        else:
            c, r, k, axm, zm = np.array(e[1]), np.array(e[2]), e[3], e[4], e[5]
            rn = np.linalg.norm((p - c) / r, axis=1)
            self.ear = above(rn, k, 0.015) * above(ax, axm, 0.01) * above(z, zm, 0.01)
        # 원본 텍스처 얼굴 (일반형): 눈·코·입·귀 안쪽을 원본 그대로 덮어 쓴다
        fp = os.path.join(HERE, 'bake', body + '_face.png')
        self.face = None
        if os.path.exists(fp):
            f = np.asarray(Image.open(fp).convert('RGBA').resize((SIZE, SIZE), Image.LANCZOS), dtype=np.float32)[::-1] / 255  # 아래쪽 행 = v 0 (구운 배열과 같게)
            f = f[self.mask]
            got = ss(0.6, 0.95, f[:, 3])  # 실제로 구워진 픽셀만 (빈 테두리는 검정이라 눈으로 읽히면 안 된다)
            rgb = f[:, :3] / np.maximum(f[:, 3:4], 1e-3)  # 테두리 반투명 보정
            lum = rgb @ np.array([0.3, 0.59, 0.11], dtype=np.float32)
            self.face_dark = ss(0.5, 0.4, lum) * got  # 눈·코·수염 (원본 색 그대로, 경계만 또렷하게)
            self.face_rgb = rgb
            # 눈: 원본 텍스처의 어두운 눈 영역을 정면 타원으로 맞춘다 (중심·반지름 = 위치 분포의 평균·2σ).
            # 축소 메쉬에 그대로 찍으면 눈구멍 벽에서 번지므로, 원본 위치·크기의 또렷한 타원으로 다시 그린다.
            sel = (self.face_dark > 0.5) & (ax > 0.03) & (ax < 0.16) & (y < -0.2) & (z > nose[2] + 0.02) & (z < nose[2] + 0.16)
            ex_, ez_ = ax[sel], z[sel]
            self.eye_fit = (float(ex_.mean()), float(ez_.mean()), float(ex_.std() * 2.0), float(ez_.std() * 2.0))
            cx, cz, rx, rz = self.eye_fit
            er = np.sqrt(((ax - cx) / rx) ** 2 + ((z - cz) / rz) ** 2)
            self.eye_r = er
            self.eye = (1 - above(er, 1.0, 0.035)) * (y < -0.15) * self.head
            self.face_dark = self.face_dark * above(er, 1.5, 0.08)  # 눈 둘레의 번진 어두운 픽셀은 버림 (코·수염은 그대로)
            self.face_pink = ss(0.06, 0.16, rgb[:, 0] - rgb[:, 1]) * (1 - self.face_dark) * got  # 입·귀 안쪽
            self.face = f
        if B.get('fold') or self.face is not None:
            self.ear_in = 0
        else:  # 귀 앞면의 안쪽 삼각형 (밑변에서 끝으로 좁아짐, 테두리는 귀 색)
            bz, bcx, bh, tz, tx = B['ear_tri']
            k = np.clip((z - bz) / (tz - bz), 0, 1)
            cx = bcx + (tx - bcx) * k
            half = bh * (1 - k) * 0.75
            self.ear_in = (self.ear * ss(-0.1, -0.4, self.n[:, 1]) * above(z, bz + 0.012, 0.006)
                           * (1 - above(np.abs(ax - cx) - half, 0.0, 0.004)))
        # 주둥이(입 둘레 흰 털), 볼
        dn = np.linalg.norm(p - nose, axis=1)
        self.muzzle = self.head * (1 - above(dn, 0.07))
        ex, edz = B['eye']
        self.eyez = nose[2] + edz
        cheek = np.sqrt(((ax - (ex + 0.035)) / 0.035) ** 2 + ((z - (nose[2] - 0.002)) / 0.022) ** 2)
        self.blush = self.head * (1 - above(cheek, 1.0, 0.35)) * ss(-0.1, -0.5, self.n[:, 1])
        # 가면 (샴): 코·눈 사이 중심의 타원체
        mc = np.array([0, nose[1] + 0.02, (nose[2] + self.eyez) / 2 + 0.01])
        self.mask_face = self.head * (1 - above(np.linalg.norm((p - mc) / np.array([0.115, 0.2, 0.085]), axis=1), 0.9, 0.18))
        # 흰 얼굴 아래쪽 (ㅅ 모양 블레이즈): 코 위 0.04 에서 양옆으로 내려감
        self.blaze = self.head * (1 - above(z, nose[2] + 0.045 - 0.55 * ax)) * ss(0.0, -0.3, self.n[:, 1])
        # 손발·양말·장갑
        self.hand = armzone * above(ax, B['hand_x'])
        self.glove = armzone * above(ax, B['glove_x'])
        self.foot = (1 - above(z, B['paw_z'])) * (1 - self.tail_mask())
        self.sock = (1 - above(z, B['sock_z'])) * (1 - self.tail_mask())
        # 배: 정면 타원 (다리 위 ~ 턱 아래)
        zc = (B['leg_z'] + B['head_z']) / 2; zr = (B['head_z'] - B['leg_z']) / 2 + 0.02
        be = np.sqrt((ax / (B['belly_x'] * 1.25)) ** 2 + ((z - zc) / zr) ** 2)
        self.belly = (1 - above(be, 1.0, 0.06)) * (1 - above(y, B['body_y'] - 0.02, 0.02)) * (1 - self.head) * (1 - armzone)
        self.chest = (1 - above(be, 1.0, 0.06)) * (1 - above(y, B['body_y'] - 0.02, 0.02)) * above(z, (zc + B['head_z']) / 2 - 0.02) * (1 - armzone)
        # 꼬리
        self.tail = self.tail_mask()
        t = B['tip']
        coord = {'x': x, 'y': y, 'z': z}[t[0]]
        self.tail_tip = self.tail * above(coord, t[1], 0.01)
        self.back = ss(0.0, 0.6, self.n[:, 1])  # 등 쪽(+y 를 향한 면)
        self.top = ss(0.1, 0.8, self.n[:, 2])

    def tail_mask(self):
        B = self.B
        return above(self.y, B['tail_y'], 0.01) * (1 - above(self.z, B['tail_zmax'], 0.01))

    # ── 무늬 ──
    def stripes(self, period=0.045, width=0.35, seed=1, wobble=0.012):
        """고등어 줄무늬: 몸통은 높이 고리, 팔은 x 고리, 머리는 이마 세로줄"""
        p = self.p; x, y, z, ax = self.x, self.y, self.z, self.ax
        wob = (fbm(p, 9, seed) - 0.5) * 2 * wobble
        s_body = z + wob + 0.005 * np.abs(np.arctan2(x, y - self.B['body_y']))  # 등 쪽으로 살짝 휘는 고리
        s_arm = ax + wob
        s_tail = np.linalg.norm(p - np.array([0, self.B['tail_y'], 0.1]), axis=1) + wob
        s = np.where(self.arm > 0.5, s_arm, np.where(self.tail > 0.5, s_tail, s_body))
        band = np.abs(((s / period) % 1.0) - 0.5) * 2  # 0=줄 가운데
        st = 1 - ss(width - 0.12, width + 0.12, band)
        # 앞면(배)으로 갈수록 옅게
        st = st * (0.35 + 0.65 * ss(-0.75, 0.1, self.n[:, 1]))
        # 머리: 이마 세로줄 3개 (M자) + 볼 옆줄
        fore = (1 - ss(0.25, 0.55, np.abs((x / 0.032) - np.round(x / 0.032)))) * above(z, self.eyez + 0.035) * (1 - above(ax, 0.08)) * ss(0.2, -0.3, self.n[:, 1] + 0.3)
        sideh = 1 - ss(width - 0.1, width + 0.1, np.abs((((z + wob) / 0.03) % 1.0) - 0.5) * 2)
        side = sideh * above(ax, 0.17) * ss(0.4, -0.2, self.n[:, 1])
        backh = sideh * ss(0.0, 0.5, self.n[:, 1]) * above(z, self.B['head_z'] + 0.04)  # 뒤통수 가로줄
        head = np.maximum(np.maximum(fore, side), backh) * self.head * (1 - self.ear)
        return np.maximum(st * (1 - self.head), head)

    def spots(self, freq=22, seed=3, thr=0.62):
        """벵갈 점(로제트): 잡음 덩어리 + 가운데 옅게"""
        n = fbm(self.p, freq, seed, 2)
        ring = ss(thr - 0.03, thr + 0.03, n)
        core = ss(thr + 0.08, thr + 0.12, n)
        return ring * (1 - 0.6 * core), core

    def patches(self, freq=5, seed=7, thr=0.55):
        return ss(thr - 0.02, thr + 0.02, fbm(self.p, freq, seed, 3))


# ── 품종 정의 (도감 16종) ──────────────────────────────────────────────────────
def mix(col, m, c):
    m = np.asarray(m, dtype=np.float32)
    if m.ndim == 0:
        m = np.full(col.shape[0], float(m), np.float32)
    return col * (1 - m[:, None]) + hexc(c)[None, :] * m[:, None]


def paint(body, recipe):
    c = Ctx(body)
    col = np.tile(hexc(recipe['base']), (c.p.shape[0], 1))
    for layer in recipe['layers']:
        m = layer[0](c) if callable(layer[0]) else layer[0]
        col = mix(col, m, layer[1])
    if c.face is not None:  # 원본에서 귀 안쪽 분홍만 (눈·코·입·수염은 메쉬로 그린다)
        col = mix(col, c.face_pink * above(c.z, c.B['ear'][1] - 0.06) if c.B['ear'][0] == 'z' else 0, recipe.get('mouth', MOUTH))
    return c, col


def L(fn, color):
    return (fn, color)


WHITE = '#fbf8f3'
MOUTH = '#eba3a3'  # 입·귀 안쪽 분홍 (원본 디자인)
EAR_IN = '#f2b8b8'
BLUSH = '#f5a8a8'


def common(c):
    return []


BREEDS = {
    # 이름: 체형, 바탕색, 덧칠(마스크 함수, 색) 순서대로, 단색 칸(어두운색, 코)
    'siamese': dict(name='샴', body='standard', base='#f3e6d3', dark='#2a211d', nose='#3a2a26', eye='#274a86', layers=[
        L(lambda c: c.mask_face, '#5c4033'), L(lambda c: c.ear, '#5c4033'), L(lambda c: c.sock, '#5c4033'),
        L(lambda c: c.hand, '#5c4033'), L(lambda c: c.tail * 0.9, '#5c4033'), L(lambda c: c.ear_in * 0.7, '#c9a09a')]),
    'russian_blue': dict(name='러시안 블루', body='standard', base='#9aa1ab', dark='#24262b', nose='#4a4f58', eye='#2c6e40', layers=[
        L(lambda c: c.top * 0.15, '#868d98'), L(lambda c: c.ear_in * 0.8, '#d6a7a7')]),
    'persian': dict(name='페르시안', body='longhair', base='#f8f6f2', dark='#2a2524', nose='#3a2c2c', layers=[
        L(lambda c: c.ear_in, EAR_IN), L(lambda c: c.blush * 0.5, BLUSH)]),
    'scottish_fold': dict(name='스코티시 폴드', body='foldear', base='#f1e6d8', dark='#2a2422', nose='#3d2e2a', layers=[
        L(lambda c: c.ear, '#b8a08c'), L(lambda c: c.blush * 0.45, BLUSH)]),
    'munchkin': dict(name='먼치킨', body='shortleg', base='#f2b06a', dark='#2a2220', nose='#3a2a24', layers=[
        L(lambda c: c.belly, WHITE), L(lambda c: c.muzzle, WHITE), L(lambda c: c.sock, WHITE),
        L(lambda c: c.hand, WHITE), L(lambda c: c.ear_in, EAR_IN), L(lambda c: c.blush * 0.4, BLUSH)]),
    'maine_coon': dict(name='메인쿤', body='longhair', base='#8a6c55', dark='#231c18', nose='#3a2a24', layers=[
        L(lambda c: c.stripes(0.05, 0.3, 4) * 0.55, '#5a4434'), L(lambda c: c.chest, '#efe6da'),
        L(lambda c: c.blaze, '#efe6da'), L(lambda c: c.foot, '#efe6da'), L(lambda c: c.hand, '#efe6da'),
        L(lambda c: c.ear_in, '#d9b0a6'), L(lambda c: c.tail_tip * 0.7, '#5a4434')]),
    'bengal': dict(name='뱅갈', body='standard', base='#d98c3e', dark='#231a14', nose='#4a2f20', layers=[
        L(lambda c: c.spots()[0], '#3d2a1c'), L(lambda c: c.spots()[1] * 0.6, '#b06a2c'),
        L(lambda c: c.stripes(0.04, 0.3, 5) * (c.arm + c.tail).clip(0, 1), '#3d2a1c'),
        L(lambda c: c.stripes(0.04, 0.3, 5) * c.head, '#3d2a1c'),
        L(lambda c: c.belly * 0.85, '#f3dcc0'), L(lambda c: c.muzzle * 0.8, '#f3dcc0'), L(lambda c: c.ear_in, EAR_IN)]),
    'sphynx': dict(name='스핑크스', body='standard', base='#f0b7a8', dark='#2a2020', nose='#c98377', ears=1.35, layers=[
        L(lambda c: c.ear_in * 0.6, '#e8968a'), L(lambda c: c.top * 0.2, '#e8a596'), L(lambda c: c.blush * 0.4, '#e8968a')]),
    'ragdoll': dict(name='랙돌', body='longhair', base='#f4eee6', dark='#2a2422', nose='#5a4038', eye='#274a86', layers=[
        L(lambda c: c.ear, '#7a5a48'), L(lambda c: c.tail * 0.85, '#8a6a56'), L(lambda c: c.sock * 0.9, '#7a5a48'),
        L(lambda c: c.mask_face * (1 - c.muzzle) * 0.35, '#c4ab98'), L(lambda c: c.ear_in * 0.6, '#d8a8a0')]),
    'norwegian_forest': dict(name='노르웨이 숲', body='longhair', base='#7c7f86', dark='#222326', nose='#3a2e2e', layers=[
        L(lambda c: c.stripes(0.05, 0.25, 6) * 0.35, '#5d6067'), L(lambda c: c.chest, WHITE), L(lambda c: c.belly, WHITE),
        L(lambda c: c.blaze, WHITE), L(lambda c: c.foot, WHITE), L(lambda c: c.hand, WHITE), L(lambda c: c.ear_in, EAR_IN)]),
    'turkish_angora': dict(name='터키시 앙고라', body='longhair', base='#fbfaf8', dark='#2a2524', nose='#d79a9a', layers=[
        L(lambda c: c.ear_in, EAR_IN), L(lambda c: c.blush * 0.35, BLUSH)]),
    'korean_cheese': dict(name='코리안 치즈', body='standard', base='#f2a253', dark='#2a211c', nose='#3a2a24', layers=[
        L(lambda c: c.stripes(0.05, 0.3, 8) * 0.35, '#de8636'), L(lambda c: c.belly, WHITE), L(lambda c: c.blaze, WHITE),
        L(lambda c: c.foot, WHITE), L(lambda c: c.hand, WHITE), L(lambda c: c.ear_in, EAR_IN)]),
    'korean_tabby': dict(name='코리안 고등어', body='standard', base='#9a958e', dark='#211f1d', nose='#3a2e2a', layers=[
        L(lambda c: c.stripes(0.042, 0.33, 9), '#4f4a45'), L(lambda c: c.belly, '#f4f1ec'), L(lambda c: c.muzzle, '#f4f1ec'),
        L(lambda c: c.sock, '#f4f1ec'), L(lambda c: c.ear_in, EAR_IN), L(lambda c: c.blush * 0.35, BLUSH)]),
    'korean_calico': dict(name='코리안 삼색', body='standard', base=WHITE, dark='#211c1a', nose='#3a2a26', layers=[
        L(lambda c: c.patches(5, 11, 0.52) * (1 - c.belly) * (1 - c.muzzle), '#e8913e'),
        L(lambda c: c.patches(5, 23, 0.58) * (1 - c.belly) * (1 - c.muzzle), '#2c2a2a'),
        L(lambda c: c.ear * c.x.__gt__(0), '#e8913e'), L(lambda c: c.ear * c.x.__lt__(0), '#2c2a2a'),
        L(lambda c: c.tail * 0.9 * c.patches(9, 31, 0.45), '#2c2a2a'), L(lambda c: c.ear_in * 0.8, EAR_IN)]),
    'korean_tuxedo': dict(name='코리안 턱시도', body='standard', base='#2c2c30', dark='#111113', nose='#d79a9a', layers=[
        L(lambda c: c.chest, WHITE), L(lambda c: c.belly, WHITE), L(lambda c: c.blaze, WHITE),
        L(lambda c: c.foot, WHITE), L(lambda c: c.hand, WHITE), L(lambda c: c.ear_in * 0.8, '#c99a9a')]),
    'american_shorthair': dict(name='아메리칸 숏헤어', body='standard', base='#c4c4c4', dark='#1e1e1e', nose='#5a4a48', layers=[
        L(lambda c: c.stripes(0.04, 0.4, 12), '#3e3e40'), L(lambda c: c.belly * 0.7, '#efefef'),
        L(lambda c: c.muzzle, '#f2f2f2'), L(lambda c: c.ear_in, EAR_IN)]),
    # 대표(사용자 아바타): 회색 + 흰 가슴 (넥타이는 코드가 붙임)
    'boss': dict(name='대표', body='standard', base='#9aa3b2', dark='#1f2228', nose='#4a4f58', layers=[
        L(lambda c: c.belly, '#eef0f4'), L(lambda c: c.muzzle, '#eef0f4'), L(lambda c: c.sock, '#eef0f4'),
        L(lambda c: c.hand, '#eef0f4'), L(lambda c: c.ear_in, '#d6b0b0')]),
}


EYE = '#26272c'  # 기본 눈동자 색 (샴·랙돌은 파랑)


def swatches(key):
    """오른쪽 끝 단색 칸 (u 0.95~1, 위에서부터가 아니라 v 아래부터): 코·수염 / 입 분홍 / 흰색 / 눈동자"""
    r = BREEDS[key]
    return [r['dark'], r.get('mouth', MOUTH), '#ffffff', r.get('eye', EYE)]


def paint_swatches(img, key):
    """img: (H, W, 3) 배열, 아래쪽 행이 v 0"""
    u0 = int(SIZE * 0.95)
    for i, h in enumerate(swatches(key)):
        img[int(SIZE * 0.1 * i):int(SIZE * 0.1 * (i + 1)), u0:] = hexc(h)
    img[int(SIZE * 0.4):, u0:] = hexc(swatches(key)[0])
    return img


def build(key):
    r = BREEDS[key]
    c, col = paint(r['body'], r)
    img = np.tile(hexc(r['base']), (SIZE, SIZE, 1))
    img[c.mask] = col
    paint_swatches(img, key)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, key + '.png')
    Image.fromarray((img[::-1].clip(0, 1) * 255).astype(np.uint8)).save(path, optimize=True)  # PNG 위쪽 = v 1
    return path, os.path.getsize(path)


if __name__ == '__main__':
    # 사용자가 그린 텍스처(skins/user.json, apply_skin.py 가 기록)는 건너뛴다. 강제로 다시 만들려면 --force
    import json
    force = '--force' in sys.argv
    args = [a for a in sys.argv[1:] if a != '--force']
    reg = os.path.join(OUT, 'user.json')
    user = json.load(open(reg, encoding='utf-8')) if os.path.exists(reg) else {}
    for k in args or list(BREEDS):
        if k in user and not force:
            print(k, '사용자 텍스처 유지:', user[k]['src'])
            continue
        print(k, *build(k))
