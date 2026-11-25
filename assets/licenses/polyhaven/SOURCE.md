# Poly Haven (CC0)

Poly Haven 의 모든 에셋은 CC0 (퍼블릭 도메인, 출처 표시 의무 없음) — https://polyhaven.com/license

| 쓰는 곳 | 원본 | 만든 이 | 받은 날 | 가공 |
|---|---|---|---|---|
| `assets/src3d/models/props/xmas_fir.glb`, `xmas_fir_needles.png` → `ui/office/models/props/xmas_fir.glb`, `xmas_fir_needles.webp` (크리스마스 트리 나무) | Fir Sapling Medium — https://polyhaven.com/a/fir_sapling_medium (glTF 1k, 변형 a) | Rob Tuytel (촬영), Rico Cilliers (모델링) | 2026-11-23 | `scripts/build-xmas-fir.py`: 잎 카드 솎기(67만 → 21만 삼각형, 남긴 카드는 키움), 줄기 둘레로 돌려 세 번 겹침(가지 숱), 높이 4.3m 로 맞춤, 죽은 가지 제외, 잎 색 + 알파를 한 장으로 합침. 이어서 `npm run optimize-assets -- --only xmas_fir` |

원본 파일은 저장소에 두지 않는다(74MB). 다시 만들려면 위 주소에서 glTF 1k 와 twigs_alpha 1k jpg 를 받아 스크립트에 폴더를 넘긴다.
