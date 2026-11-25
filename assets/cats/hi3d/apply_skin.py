"""직접 그린(또는 AI가 그린) 품종 텍스처를 적용한다 — Blender 없이 실행.

사용: python apply_skin.py <그림 파일> <품종 키>
- 1024² 로 맞추고, 조각 가장자리 흰 테두리를 안쪽 색으로 메우고, 눈·코·입 자리(메쉬가 그림)는 털색으로 지운다.
- 오른쪽 끝 단색 칸(u 0.95~1)은 그림에 있는 색 대신 같은 품종(없으면 일반형 기본)의 칸으로 덮어 쓴다
  (눈·코·수염·입 데칼이 그 칸을 쓴다).
- 결과: ui/office/models/cats/skins/<품종 키>.png
"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SK = os.path.join(HERE, '..', '..', '..', 'ui', 'office', 'models', 'cats', 'skins')


def fix_borders(im, body, band=7, mask=None):
    """그림이 조각 둘레에 흰 테두리를 두르면 모델 이음매에 흰 선이 생긴다.
    조각(구운 마스크) 가장자리 띠를 안쪽 색으로 다시 채운다."""
    import numpy as np
    m = mask if mask is not None else np.load(os.path.join(HERE, 'bake', body + '.npz'))['mask'][::-1]  # PNG 방향(위 = v 1)
    a = np.asarray(im, dtype=np.float32)
    good = m.copy()
    for _ in range(band):  # 안쪽으로 깎기
        g = good.copy()
        g[1:] &= good[:-1]; g[:-1] &= good[1:]; g[:, 1:] &= good[:, :-1]; g[:, :-1] &= good[:, 1:]
        good = g
    col = np.where(good[..., None], a, 0); w = good.astype(np.float32)
    for _ in range(band + 4):  # 바깥으로 번지며 채우기 (이웃 평균)
        s = np.zeros_like(col); c = np.zeros_like(w)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            s += np.roll(np.roll(col, dy, 0), dx, 1); c += np.roll(np.roll(w, dy, 0), dx, 1)
        new = (c > 0) & (w == 0)
        col[new] = s[new] / c[new][:, None]; w[new] = 1
    out = np.where((m & ~good)[..., None], col, a)
    return Image.fromarray(out.clip(0, 255).astype(np.uint8))


def clear_features(im, body, ring=10):
    """눈·코·입 자리(메쉬가 그리는 곳)의 그림을 지우고 둘레 털색으로 채운다"""
    import numpy as np
    import zones
    eye, mouth = zones.masks(body)
    hole = eye | mouth
    a = np.asarray(im, dtype=np.float32)
    col = np.where(hole[..., None], 0, a); w = (~hole).astype(np.float32)
    for _ in range(60):  # 구멍 바깥에서 안으로 번지며 채우기
        s = np.zeros_like(col); c = np.zeros_like(w)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            s += np.roll(np.roll(col * w[..., None], dy, 0), dx, 1); c += np.roll(np.roll(w, dy, 0), dx, 1)
        new = (c > 0) & (w == 0)
        if not new.any():
            break
        col[new] = s[new] / c[new][:, None]; w[new] = 1
    return Image.fromarray(np.where(hole[..., None], col, a).clip(0, 255).astype(np.uint8))


def apply(src, key, ref='korean_cheese', body='standard'):
    src_im = Image.open(src)
    if src_im.mode in ('RGBA', 'LA', 'P'):  # 투명한 곳은 흰 바탕으로
        bg = Image.new('RGBA', src_im.size, (255, 255, 255, 255))
        src_im = Image.alpha_composite(bg, src_im.convert('RGBA'))
    im = src_im.convert('RGB').resize((1024, 1024), Image.LANCZOS)
    im = fix_borders(im, body)
    im = clear_features(im, body)
    base = os.path.join(SK, key + '.png')
    # 단색 칸(눈동자·코·입 색)은 품종 정의(breeds.py)에서 — 그림에 있는 색은 쓰지 않는다
    import numpy as np
    import breeds
    arr = np.asarray(im, dtype=np.float32)[::-1] / 255  # 아래쪽 행 = v 0
    arr = breeds.paint_swatches(arr.copy(), key if key in breeds.BREEDS else ref)
    im = Image.fromarray((arr[::-1].clip(0, 1) * 255).astype(np.uint8))
    im.save(base)
    # 사용자 텍스처 목록: breeds.py 가 생성 텍스처로 덮어쓰지 않게
    import json
    reg = os.path.join(SK, 'user.json')
    d = json.load(open(reg, encoding='utf-8')) if os.path.exists(reg) else {}
    d[key] = dict(src=os.path.relpath(src, HERE).replace(os.sep, '/'), body=body)
    json.dump(d, open(reg, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return base


if __name__ == '__main__':
    # python apply_skin.py <그림> <품종 키> [체형]
    print(apply(sys.argv[1], sys.argv[2], body=sys.argv[3] if len(sys.argv) > 3 else 'standard'))
