//! 트레이 아이콘 렌더링 — 사용률 링 게이지 + 가운데 고양이 로고(RGBA 직접 래스터화, 4x4 슈퍼샘플링).
//! 바깥 링 = 5시간 세션 %, 안쪽 링 = 주간 전체 %. 색: 초록 < 60 ≤ 주황 < 85 ≤ 빨강.
//! 가운데 = 픽셀 도트 고양이 발자국 (PAW), 문어AI 기본 그라데이션(#8b6dff → #5b8cff) — 밝은·어두운 작업 표시줄 모두에서 보이는 중간 밝기.
//! 사용량 링도 화소 단위(계단)로 그려 픽셀 그림처럼 (배지 숫자는 원래 도트 글꼴).
//! 값 없음(오류·미로그인) → 회색 트랙만.
//! 읽지 않은 알림·권한 요청 있음 → 우상단 보라 배지(흰 테두리)에 건수(10 이상은 "9+").

/// 아이콘 한 변의 화소 수(32x32).
const SIZE: u32 = 32;
/// 화소당 한 변의 슈퍼샘플 수(4x4 = 16 샘플).
const SS: u32 = 4;
/// 발자국 도트 한 칸의 화소 크기.
///
/// `paw_at` 이 정수로 바꿔 쓴다(현재 2).
const DOT: f64 = 2.0;
/// 사용량 링도 도트(계단)로 그린다 — 가운데 발자국과 같은 픽셀 그림 느낌.
///
/// true 면 `render` 가 샘플 좌표를 화소 중심으로 양자화한 거리로 링 범위를 판정한다.
const PIXEL_RINGS: bool = true;

/// RGBA 색(채널당 0~255).
type Rgba = [u8; 4];

/// 바깥 링(5시간 세션)의 빈 트랙 색 — 값 없음이거나 채워지지 않은 부분.
const TRACK: Rgba = [148, 163, 184, 150];
/// 안쪽 링(주간 전체)의 빈 트랙 색.
const INNER_TRACK: Rgba = [148, 163, 184, 90];
/// 문어AI 기본 그라데이션의 시작색(왼쪽 위 #8b6dff, 프라이머리).
const CAT_FROM: [f64; 3] = [139.0, 109.0, 255.0];
/// 문어AI 기본 그라데이션의 끝색(오른쪽 아래 #5b8cff).
const CAT_TO: [f64; 3] = [91.0, 140.0, 255.0];
/// 알림 건수 배지의 바탕색(보라).
const BADGE: Rgba = [124, 58, 237, 255];
/// 배지의 테두리 색(흰색).
const BADGE_RIM: Rgba = [255, 255, 255, 255];
/// 배지 숫자 글자색(흰색).
const BADGE_TEXT: Rgba = [255, 255, 255, 255];
/// 3x5 비트맵 글꼴(행마다 하위 3비트, 왼쪽이 MSB): 0~9, '+'.
///
/// 인덱스 0~9 가 숫자, 10(`PLUS`)이 '+'. 배지 숫자를 그릴 때 `on_text` 가 읽는다.
const GLYPHS: [[u8; 5]; 11] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
    [0b000, 0b010, 0b111, 0b010, 0b000],
];
/// `GLYPHS` 에서 '+' 글리프의 인덱스(10).
const PLUS: usize = 10;

/// 배지에 쓸 글리프 목록과 확대 배율을 정한다(한 글자는 크게, "9+" 는 작게).
///
/// 0~9 는 그 숫자 한 글자(배율 2.6), 10 이상은 "9+"(`[9, PLUS]`, 배율 1.9).
///
/// # 인자
/// - `count`: 배지에 표시할 건수
///
/// # 반환
/// (글리프 인덱스 목록, 확대 배율).
///
/// # 참조
/// `render` 가 호출. `GLYPHS`, `PLUS` 사용.
fn badge_text(count: u32) -> (Vec<usize>, f64) {
    match count {
        0..=9 => (vec![count as usize], 2.6),
        _ => (vec![9, PLUS], 1.9),
    }
}

/// 배지 중심 기준 좌표가 글자 획 위인지 판정한다. 글자 사이 1칸 간격, 중앙 정렬.
///
/// 좌표를 글리프 칸 단위로 바꿔 범위를 벗어나거나 글자 사이 간격 칸이면 false, 아니면 해당 글리프 비트를 본다.
///
/// # 인자
/// - `glyphs`: 글리프 인덱스 목록(`badge_text` 결과)
/// - `scale`: 확대 배율
/// - `x`, `y`: 배지 중심 기준 좌표(화소 단위)
///
/// # 반환
/// 획 위면 true.
///
/// # 참조
/// `render` 가 호출. `GLYPHS` 읽음.
fn on_text(glyphs: &[usize], scale: f64, x: f64, y: f64) -> bool {
    let cols = glyphs.len() * 4 - 1;
    let gx = (x / scale + cols as f64 / 2.0).floor();
    let gy = (y / scale + 2.5).floor();
    if gx < 0.0 || gy < 0.0 || gx >= cols as f64 || gy >= 5.0 {
        return false;
    }
    let (gx, gy) = (gx as usize, gy as usize);
    if gx % 4 == 3 {
        return false;
    }
    GLYPHS[glyphs[gx / 4]][gy] >> (2 - gx % 4) & 1 == 1
}

/// 사용률에 따른 링 색을 고른다.
///
/// 85 이상 빨강, 60 이상 85 미만 주황, 그 미만 초록.
///
/// # 인자
/// - `pct`: 사용률(%)
///
/// # 반환
/// RGBA 색.
///
/// # 참조
/// `render` 가 호출.
fn level_color(pct: f64) -> Rgba {
    if pct >= 85.0 {
        [239, 68, 68, 255]
    } else if pct >= 60.0 {
        [245, 158, 11, 255]
    } else {
        [34, 197, 94, 255]
    }
}

/// 12시 방향 기준 시계방향 각도 비율(0~1)이 frac 이내인지 판정한다.
///
/// `frac` 이 0 이하면 false, 1 이상이면 true. 그 사이는 `atan2` 로 위쪽 0·시계방향 증가 각도를 구해 한 바퀴 대비 비율과 비교한다.
///
/// # 인자
/// - `dx`, `dy`: 링 중심 기준 좌표(y 는 아래가 양수)
/// - `frac`: 채울 비율(사용률/100)
///
/// # 반환
/// 이 좌표가 채워진 호 안이면 true.
///
/// # 참조
/// `render` 가 호출.
fn in_arc(dx: f64, dy: f64, frac: f64) -> bool {
    if frac <= 0.0 {
        return false;
    }
    if frac >= 1.0 {
        return true;
    }
    let a = dx.atan2(-dy); // 위쪽 0, 시계방향 증가
    let a = if a < 0.0 { a + std::f64::consts::TAU } else { a };
    a / std::f64::consts::TAU <= frac
}

/// 가운데 그림: 픽셀 도트 고양이 발자국(발가락 넷 + 큰 발바닥). 한 칸 = DOT×DOT 화소, 11×10 칸.
///
/// '#' 인 칸만 칠한다.
///
/// # 참조
/// `paw_at` 이 읽는다.
const PAW: [&str; 10] = [
    "..##...##..",
    ".####.####.",
    "..##...##..",
    "##.......##",
    "##..###..##",
    "##.#####.##",
    "..#######..",
    ".#########.",
    ".#########.",
    "..###.###..",
];

/// 화소가 발자국 위면 그 자리 색을 돌려준다(칸 단위로 통째로 칠해 또렷한 도트, 문어AI 기본 그라데이션).
///
/// 발자국을 32x32 중앙에 놓고 화소를 칸 좌표로 바꾼다. 범위 밖이거나 '#' 이 아니면 None, 맞으면
/// 칸의 가로·세로 위치 평균으로 `CAT_FROM`→`CAT_TO` 를 섞은 색을 돌려준다(왼쪽 위 → 오른쪽 아래).
///
/// # 인자
/// - `px`, `py`: 화소 좌표(0..SIZE)
///
/// # 반환
/// 불투명 RGBA 색. 발자국이 아닌 자리는 None.
///
/// # 참조
/// `render` 가 호출. `PAW`, `CAT_FROM`, `CAT_TO`, `DOT` 사용.
fn paw_at(px: u32, py: u32) -> Option<Rgba> {
    let (cols, rows) = (PAW[0].len() as u32, PAW.len() as u32);
    let d = DOT as u32;
    let (x0, y0) = ((SIZE - cols * d) / 2, (SIZE - rows * d) / 2);
    if px < x0 || py < y0 {
        return None;
    }
    let (cx, cy) = ((px - x0) / d, (py - y0) / d);
    if cx >= cols || cy >= rows || PAW[cy as usize].as_bytes()[cx as usize] != b'#' {
        return None;
    }
    let k = ((cx as f64 / (cols - 1) as f64) + (cy as f64 / (rows - 1) as f64)) / 2.0; // 왼쪽 위 → 오른쪽 아래
    let mix = |i: usize| (CAT_FROM[i] + (CAT_TO[i] - CAT_FROM[i]) * k).round() as u8;
    Some([mix(0), mix(1), mix(2), 255])
}

/// 트레이 아이콘 32x32 RGBA 버퍼를 만든다.
///
/// 화소마다 4x4 슈퍼샘플로 샘플 좌표를 돌며 우선순위대로 색을 고른다: 알림 배지(우상단) → 배지 테두리
/// → 바깥 링(세션) → 안쪽 링(주간) → 가운데 발자국. 링은 사용률만큼 12시부터 시계방향으로 `level_color` 색, 나머지는 트랙 색
/// (값 None 이면 트랙만). 샘플 색은 프리멀티플라이로 누적해 평균한 뒤 되돌린다.
///
/// # 인자
/// - `session`: 5시간 세션 사용률(%) 또는 None(값 없음)
/// - `weekly`: 주간 전체 사용률(%) 또는 None
/// - `badge`: 배지 숫자(0 이면 배지 없음, 10 이상은 "9+")
///
/// # 반환
/// SIZE×SIZE×4 바이트 RGBA 버퍼.
///
/// # 참조
/// `badge_text`, `on_text`, `in_arc`, `level_color`, `paw_at` 호출. `image` 가 호출.
pub fn render(session: Option<f64>, weekly: Option<f64>, badge: u32) -> Vec<u8> {
    let c = SIZE as f64 / 2.0;
    let (r_out, r_mid, r_wk, r_in) = (15.5, 13.4, 12.9, 11.4);
    let (bx, by, r_badge, r_rim) = (7.5, -7.5, 8.5, 10.0);
    let alert = badge > 0;
    let (glyphs, scale) = badge_text(badge);
    let mut buf = vec![0u8; (SIZE * SIZE * 4) as usize];

    for py in 0..SIZE {
        for px in 0..SIZE {
            let mut acc = [0f64; 4];
            for sy in 0..SS {
                for sx in 0..SS {
                    let x = px as f64 + (sx as f64 + 0.5) / SS as f64 - c;
                    let y = py as f64 + (sy as f64 + 0.5) / SS as f64 - c;
                    let d = if PIXEL_RINGS {
                        let (qx, qy) = ((x + c).floor() + 0.5 - c, (y + c).floor() + 0.5 - c);
                        (qx * qx + qy * qy).sqrt()
                    } else {
                        (x * x + y * y).sqrt()
                    };
                    let db = ((x - bx).powi(2) + (y - by).powi(2)).sqrt();
                    let col: Option<Rgba> = if alert && db <= r_badge {
                        Some(if on_text(&glyphs, scale, x - bx, y - by) { BADGE_TEXT } else { BADGE })
                    } else if alert && db <= r_rim {
                        Some(BADGE_RIM)
                    } else if d <= r_out && d >= r_mid {
                        Some(match session {
                            Some(p) if in_arc(x, y, p / 100.0) => level_color(p),
                            _ => TRACK,
                        })
                    } else if d <= r_wk && d >= r_in {
                        Some(match weekly {
                            Some(p) if in_arc(x, y, p / 100.0) => level_color(p),
                            _ => INNER_TRACK,
                        })
                    } else {
                        paw_at(px, py)
                    };
                    if let Some(k) = col {
                        // 프리멀티플라이 누적 → 평균 후 언프리멀티플라이.
                        let a = k[3] as f64 / 255.0;
                        acc[0] += k[0] as f64 * a;
                        acc[1] += k[1] as f64 * a;
                        acc[2] += k[2] as f64 * a;
                        acc[3] += a;
                    }
                }
            }
            let n = (SS * SS) as f64;
            let a = acc[3] / n;
            let i = ((py * SIZE + px) * 4) as usize;
            if a > 0.0 {
                buf[i] = (acc[0] / acc[3]).round() as u8;
                buf[i + 1] = (acc[1] / acc[3]).round() as u8;
                buf[i + 2] = (acc[2] / acc[3]).round() as u8;
                buf[i + 3] = (a * 255.0).round() as u8;
            }
        }
    }
    buf
}

/// `render` 결과를 Tauri 이미지로 감싼다.
///
/// # 인자
/// - `session`, `weekly`, `badge`: `render` 와 같음
///
/// # 반환
/// 32x32 `tauri::image::Image`(버퍼 소유).
///
/// # 참조
/// `render` 호출. 트레이 아이콘 설정에서 호출한다.
pub fn image(session: Option<f64>, weekly: Option<f64>, badge: u32) -> tauri::image::Image<'static> {
    tauri::image::Image::new_owned(render(session, weekly, badge), SIZE, SIZE)
}
