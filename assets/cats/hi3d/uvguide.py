"""이름표 붙은 UV 안내도 (AI·사람이 품종 텍스처를 그릴 때 참고) — Blender 없이 실행.

입력: templates/<체형>_uv.json (uvviews.py), skins/<품종>.png (겹쳐 보기용)
출력: templates/<체형>_uv_guide.png      — 부위별 색 + 테두리 + 한·영 이름표 (2048², 텍스처는 1024² 로 그리면 됨)
      templates/<체형>_uv_guide_on_<품종>.png — 같은 이름표를 기존 품종 텍스처 위에
실행: python uvguide.py
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SK = os.path.join(HERE, '..', '..', '..', 'ui', 'office', 'models', 'cats', 'skins')
S = 2048
FONT = 'C:/Windows/Fonts/malgunbd.ttf'
COL = {'head': (255, 196, 140), 'body': (150, 200, 255), 'arm_L': (170, 230, 170), 'arm_R': (120, 205, 150),
       'leg_L': (230, 180, 230), 'leg_R': (200, 150, 220), 'tail': (255, 230, 120), 'misc': (210, 210, 210),
       'swatch': (255, 255, 255)}
PART = {'head': ('HEAD', '머리'), 'body': ('BODY', '몸통'), 'arm_L': ('LEFT ARM', '왼팔'), 'arm_R': ('RIGHT ARM', '오른팔'),
        'leg_L': ('LEFT LEG', '왼다리'), 'leg_R': ('RIGHT LEG', '오른다리'), 'tail': ('TAIL', '꼬리')}
VIEW = {'front': ('FRONT', '정면'), 'back': ('BACK', '뒤'), 'left': ('LEFT SIDE', '왼쪽 옆'), 'right': ('RIGHT SIDE', '오른쪽 옆'),
        'top': ('TOP', '위'), 'bottom': ('BOTTOM', '아래')}
NOTE = {('head', 'front'): ('face fur & markings (eyes/nose/mouth are 3D)', '얼굴 털·무늬 (눈·코·입은 3D)'),
        ('body', 'front'): ('chest / belly', '가슴·배'), ('body', 'back'): ('back / spine', '등')}
# 방향 표시: 옆·앞·뒤 조각은 위 = 머리 쪽, 위·아래 조각은 얼굴(정면) 쪽 표시
UP = {'front': '↑ UP', 'back': '↑ UP', 'left': '↑ UP  (face →... ← back)', 'right': '↑ UP', 'top': '↑ FACE side', 'bottom': '↓ FACE side'}
UP = {'front': '↑ up', 'back': '↑ up', 'left': '↑ up · ← face', 'right': '↑ up · face →', 'top': '↑ face side', 'bottom': '↓ face side'}


def px(u, v):
    return (u * S, (1 - v) * S)


def draw(body, base=None):
    d = json.load(open(os.path.join(HERE, 'templates', body + '_uv.json'), encoding='utf-8'))
    if base:
        im = Image.open(os.path.join(SK, base + '.png')).convert('RGB').resize((S, S), Image.LANCZOS)
    else:
        im = Image.new('RGB', (S, S), (250, 250, 250))
    over = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    od = ImageDraw.Draw(over)
    for f in d['faces']:
        pts = [px(*q) for q in f['uv']]
        c = COL.get(f['part'], (200, 200, 200))
        od.polygon(pts, fill=c + ((70 if base else 255),), outline=None)
    # 눈·코·입 자리 (메쉬로 그림 → 털만 칠할 것): 빨간 빗금
    import numpy as np
    import zones
    eye, mouth = zones.masks(body)
    hole = Image.fromarray(((eye | mouth) * 255).astype(np.uint8)).resize((S, S), Image.NEAREST)
    hatch = Image.new('RGBA', (S, S), (0, 0, 0, 0)); hd = ImageDraw.Draw(hatch)
    for k in range(-S, S, 10):
        hd.line([(k, 0), (k + S, S)], fill=(220, 40, 40, 200), width=3)
    over.paste(hatch, (0, 0), hole)
    im = Image.alpha_composite(im.convert('RGBA'), over)
    dr = ImageDraw.Draw(im)
    for msk, en, ko in ((eye, '3D EYE - paint fur only', '눈은 3D (털만)'), (mouth, '3D NOSE/MOUTH - fur only', '코·입은 3D (털만)')):
        ys, xs = np.nonzero(msk)
        if len(xs):
            cx, cy = xs.mean() * S / 1024, ys.max() * S / 1024 + 6
            f0 = ImageFont.truetype(FONT, 15)
            for t, dy in ((en, 0), (ko, 18)):
                for ox, oy in ((-2, 0), (2, 0), (0, -2), (0, 2)):
                    dr.text((cx - 70 + ox, cy + dy + oy), t, font=f0, fill=(255, 255, 255, 255))
                dr.text((cx - 70, cy + dy), t, font=f0, fill=(200, 30, 30, 255))
    for f in d['faces']:  # 테두리 (얇게)
        pts = [px(*q) for q in f['uv']]
        dr.line(pts + [pts[0]], fill=(90, 110, 150, 90), width=1)
    big = ImageFont.truetype(FONT, 26); mid = ImageFont.truetype(FONT, 20); small = ImageFont.truetype(FONT, 15)
    for lb in sorted(d['labels'], key=lambda l: -l['area']):
        u0, v0, u1, v1 = lb['box']
        x0, y1 = px(u0, v0); x1, y0 = px(u1, v1)
        w = x1 - x0; h = y1 - y0
        dr.rectangle([x0, y0, x1, y1], outline=(30, 60, 160, 255), width=2)
        p_en, p_ko = PART[lb['part']]; v_en, v_ko = VIEW[lb['view']]
        lines = [f'{p_en} · {v_en}', f'{p_ko} {v_ko}']
        note = NOTE.get((lb['part'], lb['view']))
        if note:
            lines += [note[0], note[1]]
        lines.append(UP[lb['view']])
        f = big if w > 220 and h > 160 else mid if w > 120 else small
        th = sum(dr.textbbox((0, 0), t, font=f)[3] + 4 for t in lines)
        y = y0 + max(4, (h - th) / 2)
        for t in lines:
            bb = dr.textbbox((0, 0), t, font=f)
            tx = x0 + (w - (bb[2] - bb[0])) / 2
            for ox, oy in ((-2, 0), (2, 0), (0, -2), (0, 2)):  # 흰 테두리 글자
                dr.text((tx + ox, y + oy), t, font=f, fill=(255, 255, 255, 255))
            dr.text((tx, y), t, font=f, fill=(20, 30, 90, 255))
            y += bb[3] + 4
    # 단색 칸 설명 (오른쪽 끝)
    sw = [(0.05, 'eyes / nose / whiskers color', '눈·코·수염 색'), (0.15, 'mouth pink', '입 분홍'), (0.25, 'white', '흰색')]
    x0 = 0.95 * S
    for v, en, ko in sw:
        y0 = (1 - v - 0.05) * S; y1 = (1 - v + 0.05) * S
        dr.rectangle([x0, y0, S - 2, y1], outline=(200, 40, 40, 255), width=3)
        for i, t in enumerate(('SOLID', en.split(' / ')[0], ko)):
            dr.text((x0 + 6, y0 + 8 + i * 22), t, font=small, fill=(200, 40, 40, 255))
    dr.text((x0 + 6, (1 - 0.65) * S), 'SOLID\nCOLOR\nSWATCH\n단색 칸\n(x>0.95)', font=small, fill=(200, 40, 40, 255))
    # 제목·규칙
    head = (f"{body.upper()} cat texture UV map (1024x1024).  LEFT = the cat's own left side.  Each box = one body part seen from one direction,"
            f' upright (up = toward head).  Grey = hidden folds (matching fur).  RED HATCH = eyes/nose/mouth are 3D: paint fur only.  NO text.')
    dr.rectangle([0, S - 34, S, S], fill=(255, 255, 255, 230))
    dr.text((10, S - 30), head, font=small, fill=(20, 20, 20, 255))
    name = f'{body}_uv_guide' + (f'_on_{base}' if base else '') + '.png'
    im.convert('RGB').save(os.path.join(HERE, 'templates', name))
    return name


if __name__ == '__main__':
    BASE = {'standard': 'siamese', 'foldear': 'scottish_fold', 'shortleg': 'munchkin', 'longhair': 'maine_coon'}
    for b, br in BASE.items():
        if os.path.exists(os.path.join(HERE, 'templates', b + '_uv.json')):
            print(draw(b), draw(b, br))
