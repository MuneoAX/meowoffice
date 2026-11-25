"""눈·코·입 자리 (메쉬로 그리는 부분) — 텍스처 픽셀 마스크.

눈·코·입·수염은 메쉬(데칼·형상)로만 그리므로, 텍스처의 그 자리는 털색이어야 한다.
- apply_skin.py: 받은 그림에서 이 자리를 주변 털색으로 메운다 (그림 속 눈이 메쉬 눈 밖으로 삐져나오지 않게)
- uvguide.py: 안내도에 '3D EYE / 3D MOUTH — 털만' 으로 표시
값은 rebuild.py 의 얼굴(face) 설정·코 끝과 같다.
"""
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
# 체형: 코 끝(x, y, z), 눈 (x, 코 위 높이, 반지름 x, 반지름 z)
FACE = {
    'standard': dict(nose=(0, -0.381, 0.567), eye=(0.089, 0.065, 0.033, 0.05)),
    'foldear': dict(nose=(0, -0.291, 0.62), eye=(0.09, 0.08, 0.022, 0.032)),
    'shortleg': dict(nose=(0, -0.303, 0.555), eye=(0.1, 0.07, 0.022, 0.032)),
    'longhair': dict(nose=(0, -0.294, 0.597), eye=(0.09, 0.058, 0.026, 0.04)),
}


def masks(body, grow=1.3):
    """(눈 마스크, 입 마스크) — PNG 방향(위 = v 1), 1024²"""
    d = np.load(os.path.join(HERE, 'bake', body + '.npz'))
    m = d['mask']; p = d['pos'].astype(np.float32); n = d['nrm'].astype(np.float32)
    F = FACE[body]; nx, ny, nz = F['nose']; ex, edz, rx, rz = F['eye']
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    front = (n[..., 1] < -0.1) & (y < ny + 0.15) & m
    eye = (((np.abs(x) - ex) / (rx * grow)) ** 2 + ((z - (nz + edz)) / (rz * grow)) ** 2 < 1) & front
    mouth = ((np.abs(x) / 0.03) ** 2 + ((z - (nz - 0.01)) / 0.025) ** 2 < 1) & front
    return eye[::-1], mouth[::-1]
