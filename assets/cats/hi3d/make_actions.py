"""고양이 동작(Action) 생성 — 4체형 공용 뼈대(cat_rig) 기준.

실행: Blender 안에서 runpy.run_path(이 파일, run_name='__main__')
- 회전은 '쉬는 자세(T자) 기준 세계 축'으로 적는다: (뼈, 축, 각도). 축 x=(1,0,0) 등.
  모델 좌표: Z 위, 정면 -Y, 왼쪽 +X.
- 꼬리·귀 뼈에는 키를 넣지 않는다 (오피스 코드가 직접 움직임).
- 초당 30프레임, 첫 프레임 = 끝 프레임 (반복 재생).
"""
import math

import bpy
from mathutils import Quaternion, Vector

FPS = 30
RIG = 'cat_rig'
R = math.radians
X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)
NO_KEY = {'tail_01', 'tail_02', 'tail_03', 'tail_04', 'ear.L', 'ear.R'}

rig = None
P = None
DROP = 1.0  # 엉덩이를 내리는 정도 (@root 의 아래쪽 z). 다리가 짧은 체형은 작게


def use(name=RIG):
    """동작을 구울 뼈대 선택 (체형마다 뼈 위치가 달라 로컬 회전이 달라진다). 동작 이름은 공용이라 이전 것을 덮어쓴다."""
    global rig, P
    rig = bpy.data.objects[name]
    P = rig.pose.bones


def local_quat(name, rots):
    """세계 축 회전 목록 → 뼈 로컬 사원수 (쉬는 자세 기준)"""
    M = rig.data.bones[name].matrix_local.to_3x3()
    q = Quaternion()
    for axis, deg in rots:
        qw = Quaternion(Vector(axis), R(deg))
        q = (M.inverted() @ qw.to_matrix() @ M).to_quaternion() @ q
    return q


def apply(pose):
    """pose: {뼈: [(축, 각도), ...], '@root': (x, y, z) 위치}"""
    for pb in P:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    for name, rots in pose.items():
        if name == '@root':
            x, y, z = rots
            if z < 0:
                z *= DROP
            P['root'].location = rig.data.bones['root'].matrix_local.to_3x3().inverted() @ Vector((x, y, z))
        else:
            P[name].rotation_quaternion = local_quat(name, rots)


def mix(*poses):
    """여러 자세를 합친다 (같은 뼈는 회전을 이어 붙임)"""
    out = {}
    for p in poses:
        for k, v in p.items():
            if k == '@root':
                a = out.get('@root', (0, 0, 0))
                out['@root'] = tuple(a[i] + v[i] for i in range(3))
            else:
                out[k] = out.get(k, []) + list(v)
    return out


def side(sg):
    return 'L' if sg > 0 else 'R'


# ── 기본 자세 조각 ─────────────────────────────────────────────
def arms_down(deg=62):
    # T자에서 팔을 내린다. 오른팔(-X)은 Y축 -, 왼팔(+X)은 Y축 +
    return {'upper_arm.L': [(Y, deg)], 'upper_arm.R': [(Y, -deg)]}


def arms_forward(down=35, fwd=60, elbow=30):
    # 팔을 몸 앞으로 (타자·상자·결재판)
    return {
        'upper_arm.L': [(Y, down), (Z, -fwd)], 'upper_arm.R': [(Y, -down), (Z, fwd)],
        'forearm.L': [(Z, -elbow)], 'forearm.R': [(Z, elbow)],
    }


def sit_legs(knee=80):
    return {'thigh.L': [(X, -85)], 'thigh.R': [(X, -85)], 'shin.L': [(X, knee)], 'shin.R': [(X, knee)]}


def breathe(t):
    return {'chest': [(X, 1.5 * math.sin(t * 2 * math.pi))], 'head': [(X, -1.0 * math.sin(t * 2 * math.pi))]}


# ── 동작 정의: 이름 → (초, 함수(t: 0~1) → 자세) ─────────────────────
def a_idle(t):
    return mix(arms_down(), breathe(t), {'head': [(Z, 3 * math.sin(t * 2 * math.pi))]})


def a_walk(t):
    s = math.sin(t * 2 * math.pi)
    c = abs(math.cos(t * 2 * math.pi))
    return mix(arms_down(66), {
        'thigh.L': [(X, -35 * s)], 'thigh.R': [(X, 35 * s)],
        'shin.L': [(X, 30 * max(0, s))], 'shin.R': [(X, 30 * max(0, -s))],
        'upper_arm.L': [(X, 22 * s)], 'upper_arm.R': [(X, -22 * s)],
        'hips': [(Z, 5 * s)], 'chest': [(Z, -4 * s)],
        '@root': (0, 0, 0.018 * c),
    })


def a_carry(t):
    s = math.sin(t * 2 * math.pi)
    c = abs(math.cos(t * 2 * math.pi))
    return mix(arms_forward(30, 70, 25), {
        'thigh.L': [(X, -33 * s)], 'thigh.R': [(X, 33 * s)],
        'shin.L': [(X, 22 * max(0, s))], 'shin.R': [(X, 22 * max(0, -s))],
        'hips': [(Z, 4 * s)], '@root': (0, 0, 0.015 * c),
    })


def a_hold(t):
    # 서서 결재판 들고 기다리기
    return mix(arms_forward(30, 65, 45), breathe(t))


def a_sit(t):
    return mix(sit_legs(), arms_down(55), breathe(t))


def a_sit_type(t):
    # 타자: 두 앞발을 번갈아 들었다 내리친다 (초당 4번씩). 팔은 앞으로 뻗어 자판 위에
    w = t * 2 * math.pi * 4
    kl, kr = max(0.0, math.sin(w)), max(0.0, math.sin(w + math.pi))
    return mix(sit_legs(), arms_forward(35, 70, 25), breathe(t), {
        'forearm.L': [(Y, -22 * kl)], 'forearm.R': [(Y, 22 * kr)],   # 왼팔은 Y- 가 위, 오른팔은 Y+ 가 위
        'hand.L': [(Y, -15 * kl)], 'hand.R': [(Y, 15 * kr)],
        'head': [(X, -6 + 2 * math.sin(w / 2))], 'chest': [(Z, 2 * math.sin(w / 4))],
    })


def a_sit_talk(t):
    s = math.sin(t * 2 * math.pi)
    return mix(sit_legs(), arms_down(50), {
        'upper_arm.R': [(Z, 40 + 15 * s), (Y, 25)], 'forearm.R': [(Z, 40)],
        'head': [(Z, 12 * math.sin(t * 2 * math.pi)), (X, 4 * math.sin(t * 4 * math.pi))],
    })


def a_drink(t):
    s = max(0.0, math.sin(t * 2 * math.pi))
    return mix(sit_legs(), arms_down(55), {
        'upper_arm.R': [(Z, 70), (Y, -15 - 30 * s)], 'forearm.R': [(Z, 70 + 40 * s)],
        'head': [(X, -8 * s)],
    })


def a_raise_hand(t):
    s = math.sin(t * 2 * math.pi * 2)
    return mix(arms_down(), {
        'upper_arm.R': [(Y, 90 + 10 * s)], 'forearm.R': [(Y, 10 * s)],
        'head': [(Z, -6)], 'chest': [(Z, 3)],
    })


def quad_base(t=0.0):
    # 네 발 자세: 몸을 앞으로 숙이고 팔을 앞다리로, 발이 바닥에 닿게 내린다
    pose = {'hips': [(X, 72)], 'neck': [(X, -12)], 'head': [(X, -55)],
            'thigh.L': [(X, -68)], 'thigh.R': [(X, -68)], 'shin.L': [(X, 12)], 'shin.R': [(X, 12)],
            '@root': (0, 0, -0.06)}
    for sg in (1, -1):
        s = side(sg)
        pose[f'upper_arm.{s}'] = [(Y, 82 * sg), (X, -62)]
    return pose


def walk4_base():
    # 걷는 네 발 자세: 머리는 들어 앞을 보고, 목은 턱 밑에서 가슴으로 부드럽게, 앞다리는 가슴 밑에서 곧게 내려오며
    # 등은 어깨에서 엉덩이로 매끈하게 이어지고 엉덩이가 등보다 살짝 높게 둥글다 (뒷다리는 엉덩이 밑)
    pose = {'hips': [(X, 78)], 'spine': [(X, 3)], 'neck': [(X, -28)], 'head': [(X, -60)],
            'thigh.L': [(X, -74)], 'thigh.R': [(X, -74)], 'shin.L': [(X, 12)], 'shin.R': [(X, 12)],
            '@root': (0, 0, -0.03)}
    for sg in (1, -1):
        pose[f'upper_arm.{side(sg)}'] = [(Y, 82 * sg), (X, -82)]
    return pose


def a_walk4(t):
    s = math.sin(t * 2 * math.pi)
    # 대각선 다리가 함께 움직이는 걸음
    return mix(walk4_base(), {
        'thigh.L': [(X, -24 * s)], 'thigh.R': [(X, 24 * s)],
        'upper_arm.R': [(X, -24 * s)], 'upper_arm.L': [(X, 24 * s)],
        'head': [(X, 3 * math.sin(t * 4 * math.pi))],
        '@root': (0, 0, 0.012 * abs(math.cos(t * 2 * math.pi))),
    })


def a_sleep(t):
    b = math.sin(t * 2 * math.pi)
    pose = mix(quad_base(), {'head': [(X, 30)], 'thigh.L': [(X, -15)], 'thigh.R': [(X, -15)],
                             'chest': [(X, 2 * b)], '@root': (0, 0, -0.05)})
    return pose


def a_sit_up(t):
    # 앞발 들고 서기 (엉덩이로 앉아 몸을 세우고 두 팔을 위로)
    s = math.sin(t * 2 * math.pi)
    return mix(sit_legs(70), {
        'upper_arm.L': [(Y, -55 - 8 * s), (Z, -20)], 'upper_arm.R': [(Y, 55 + 8 * s), (Z, 20)],
        'forearm.L': [(Y, -30)], 'forearm.R': [(Y, 30)], 'head': [(X, -6)],
        '@root': (0, 0, -0.08),
    })


def a_groom(t):
    s = math.sin(t * 2 * math.pi * 2)
    return mix(sit_legs(70), arms_down(50), {
        'upper_arm.R': [(Z, 85), (Y, -10)], 'forearm.R': [(Z, 95 + 10 * s)],
        'head': [(Y, -12), (X, 10 + 6 * s)], '@root': (0, 0, -0.08),
    })


ACTIONS = {
    'idle': (2.0, a_idle), 'walk': (1.0, a_walk), 'carry': (1.0, a_carry), 'hold': (2.0, a_hold),
    'sit': (2.0, a_sit), 'sit_type': (1.0, a_sit_type), 'sit_talk': (2.0, a_sit_talk), 'drink': (2.0, a_drink),
    'raise_hand': (1.5, a_raise_hand), 'walk4': (0.8, a_walk4), 'sleep': (2.0, a_sleep),
    'sit_up': (1.5, a_sit_up), 'groom': (2.0, a_groom),
}


def build(step=3, rig_name=RIG, drop=1.0):
    """동작마다 Action 하나. step 프레임 간격으로 키, 끝 프레임은 첫 프레임과 같다."""
    global DROP
    use(rig_name)
    DROP = drop
    rig.animation_data_create()
    made = []
    for name, (sec, fn) in ACTIONS.items():
        old = bpy.data.actions.get(name)
        if old:
            bpy.data.actions.remove(old)
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data.action = act
        n = int(round(sec * FPS))
        frames = list(range(0, n, step)) + [n]
        for f in frames:
            apply(fn((f % n) / n))
            for pb in P:
                if pb.name in NO_KEY:
                    continue
                pb.keyframe_insert('rotation_quaternion', frame=f + 1)
                if pb.name == 'root':
                    pb.keyframe_insert('location', frame=f + 1)
        try:
            act.use_frame_range = True
            act.frame_start, act.frame_end = 1, n + 1
        except AttributeError:
            pass
        made.append((name, n + 1))
    rig.animation_data.action = None
    apply({})
    return made


if __name__ == '__main__':
    bpy.context.scene.render.fps = FPS
    print(build())
