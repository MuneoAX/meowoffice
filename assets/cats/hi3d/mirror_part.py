"""그림 텍스처에서 한쪽 부위를 반대쪽 부위로 덮어쓴다 (예: 회색으로 잘못 칠한 팔 → 크림색 팔을 좌우로 뒤집어).

사용: python mirror_part.py <그림> <체형> <고칠 부위> <가져올 부위> <저장 파일>
     python mirror_part.py texture/ScottishFold.png foldear arm_R arm_L texture/ScottishFold_fixed.png
- 부위 마스크: templates/<체형>_uv.json 의 면(part) 을 그려 만든다.
- 고칠 텍셀마다 표면 위치(bake/<체형>.npz)를 x 반전한 곳에서 가장 가까운 '가져올 부위' 텍셀의 색을 쓴다.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
S = 1024


def part_mask(body, part):
    d = json.load(open(os.path.join(HERE, 'templates', body + '_uv.json'), encoding='utf-8'))
    im = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(im)
    for f in d['faces']:
        if f['part'] == part:
            dr.polygon([(u * S, (1 - v) * S) for u, v in f['uv']], fill=255)
    return np.asarray(im) > 0  # PNG 방향


def run(src, body, dst_part, src_part, out):
    im = Image.open(src)
    if im.mode in ('RGBA', 'LA', 'P'):
        bg = Image.new('RGBA', im.size, (255, 255, 255, 255)); im = Image.alpha_composite(bg, im.convert('RGBA'))
    im = im.convert('RGB').resize((S, S), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32)
    d = np.load(os.path.join(HERE, 'bake', body + '.npz'))
    pos = d['pos'].astype(np.float32)[::-1]  # PNG 방향
    m = d['mask'][::-1]
    dst = part_mask(body, dst_part) & m
    srcm = part_mask(body, src_part) & m
    sp = pos[srcm]; sc = a[srcm]
    tp = pos[dst].copy(); tp[:, 0] *= -1  # 좌우 반전
    out_c = np.empty((len(tp), 3), np.float32)
    for i in range(0, len(tp), 200):  # 가장 가까운 점 (메모리 때문에 200개씩)
        d2 = ((tp[i:i + 200, None, :] - sp[None, :, :]) ** 2).sum(-1)
        out_c[i:i + 200] = sc[d2.argmin(1)]
    a[dst] = out_c
    Image.fromarray(a.clip(0, 255).astype(np.uint8)).save(out)
    return int(dst.sum()), int(srcm.sum())


if __name__ == '__main__':
    print(run(*sys.argv[1:6]))
