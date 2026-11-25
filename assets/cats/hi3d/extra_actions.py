"""고양이 추가 동작(스케이트·발라당)을 리그에 만든다 — Blender 안에서 exec 로 실행.

네 체형(standard·foldear·longhair·shortleg)이 같은 뼈 이름을 쓰므로, 각 체형 glb 를 불러온 리그에 build(arm) 을 부르면 된다.
동작은 그 리그의 '서 있기(idle)' 첫 프레임 자세를 바탕으로 관절마다 회전을 더한다(축은 2026-11-21 측정값):
- spine·chest·neck·head: 로컬 X- = 앞으로 숙임, X+ = 뒤로 젖힘(머리 들기)
- upper_arm: X+ = 옆으로 벌림. Z = 앞뒤 스윙(왼팔 앞 Z-, 오른팔 앞 Z+)
- thigh: X+ = 앞으로 듦, X- = 뒤로 뻗음. shin: X- = 무릎 굽힘. foot: X+ = 발끝 들기
- root: X- = 뒤로 넘어감(등을 바닥에), Z = 옆으로 구름. 위치: 로컬 Y = 위, 로컬 Z = 앞(-Y 월드)
내보내기: export_anims(arm, path) — 메시 없이 뼈대와 동작만 glb 로(게임이 이름으로 각 고양이 뼈에 다시 붙인다).
"""
import bpy
import mathutils

Q = mathutils.Quaternion
X, Z = (1, 0, 0), (0, 0, 1)
FPS = 24


def _base(arm, idle=None):
    """idle 첫 프레임의 관절 회전·위치. idle: 그 리그의 서 있기 동작(여러 체형을 불러오면 이름이 idle.001 처럼 바뀌므로 넘겨 준다)."""
    sc = bpy.context.scene
    idle = idle or bpy.data.actions['idle']
    arm.animation_data_create()
    arm.animation_data.action = idle
    sc.frame_set(int(idle.frame_range[0]))
    bpy.context.view_layer.update()
    return {pb.name: (pb.rotation_quaternion.copy(), pb.location.copy()) for pb in arm.pose.bones}


def _key(arm, base, act, frames):
    """frames: [(프레임, {뼈: [(축, 각)]}, {뼈: 위치 더하기 Vector})] 를 act 에 키로 넣는다."""
    sc = bpy.context.scene
    arm.animation_data.action = act
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    for f, rot, loc in frames:
        sc.frame_set(f)
        for pb in arm.pose.bones:
            q, l = base[pb.name]
            q = q.copy()
            for ax, ang in rot.get(pb.name, []):
                q = q @ Q(ax, ang)
            pb.rotation_quaternion = q
            pb.location = l + loc.get(pb.name, mathutils.Vector())
            pb.keyframe_insert('rotation_quaternion', frame=f)
            pb.keyframe_insert('location', frame=f)


def build_skate(arm, base):
    """스케이트: 1.6초(0~38) 반복. 왼발 밀기 → 미끄러짐 → 오른발 밀기 → 미끄러짐. 팔은 걷듯이 앞뒤 스윙."""
    act = bpy.data.actions.get('skate') or bpy.data.actions.new('skate')
    act.use_fake_user = True
    B = 0.45
    fixed = {'spine': [(X, -0.45)], 'chest': [(X, -0.25)], 'neck': [(X, 0.25)], 'head': [(X, 0.3)],
             'upper_arm.L': [(X, 0.25), (Z, -B)], 'upper_arm.R': [(X, 0.25), (Z, B)],
             'forearm.L': [(X, 0.3)], 'forearm.R': [(X, 0.3)], 'tail_01': [(X, 0.35)]}

    def phase(push, sw):
        d = {k: list(v) for k, v in fixed.items()}
        sup = {'thigh': [(X, 0.35)], 'shin': [(X, -0.6)], 'foot': [(X, 0.25)]}
        pushl = {'thigh': [(X, -0.85)], 'shin': [(X, 0.15)], 'foot': [(X, 0.35)]}
        glide = {'thigh': [(X, 0.15)], 'shin': [(X, -0.4)], 'foot': [(X, 0.2)]}
        for s in ('L', 'R'):
            g = pushl if push == s else sup if push else glide
            for k, v in g.items():
                d.setdefault(f'{k}.{s}', []).extend(v)
        d['upper_arm.L'].append((Z, -0.8 * sw))
        d['upper_arm.R'].append((Z, -0.8 * sw))
        return d
    _key(arm, base, act, [(0, phase('L', 1), {}), (10, phase(None, 0), {}), (19, phase('R', -1), {}),
                          (29, phase(None, 0), {}), (38, phase('L', 1), {})])
    act.frame_range = (0, 38)
    return act


def build_roll(arm, base):
    """발라당: 약 2.6초(0~62) 한 번. 뒤로 벌러덩 누워 네 발을 들고 좌우로 뒹굴다 일어난다.

    주의(2026-11-23): 여기서 만든 동작은 누운 채 세로축으로 돌아(root 의 Z) 호를 그리며 뒹군다. 게임에 들어가는 glb 는
    scripts/fix-roll-anim.mjs 가 뒤에서 고친 것이다 — root 의 Z 돌림을 몸통 긴 축(Y) 구르기로 바꾸고 3배로 키우며, 구르는 만큼 옆으로 옮기고,
    앞발을 하늘로 더 뻗고(위팔 Z ∓0.45, 아래팔 X -0.5), 뒷다리를 벌린다(허벅지 Z ∓0.5, 들기 전 좌표). 이 스크립트로 glb 를 다시 뽑으면 그 스크립트를 다시 돌려야 한다.
    """
    act = bpy.data.actions.get('roll') or bpy.data.actions.new('roll')
    act.use_fake_user = True
    V = mathutils.Vector
    paws_up = {'upper_arm.L': [(Z, -1.1), (X, 0.2)], 'upper_arm.R': [(Z, 1.1), (X, 0.2)],
               'forearm.L': [(X, 0.9)], 'forearm.R': [(X, 0.9)],
               'thigh.L': [(X, 1.0)], 'thigh.R': [(X, 1.0)], 'shin.L': [(X, -0.9)], 'shin.R': [(X, -0.9)],
               'head': [(X, 0.35)], 'tail_01': [(X, 0.5)], 'tail_02': [(X, 0.3)]}

    def back(side=0.0, knead=0.0):
        d = {k: list(v) for k, v in paws_up.items()}
        d['root'] = [(X, -1.75), (Z, side)]
        d['forearm.L'] = [(X, 0.9 + knead)]
        d['forearm.R'] = [(X, 0.9 - knead)]
        d['head'] = [(X, 0.35), (Z, -side * 0.6)]
        return d
    lie = {'root': V((0, 0.12, 0.26))}  # 누우면 몸이 바닥 위·제자리에 오게 들어 올리고 앞으로
    crouch = {'spine': [(X, 0.2)], 'thigh.L': [(X, 0.4)], 'thigh.R': [(X, 0.4)], 'shin.L': [(X, -0.5)], 'shin.R': [(X, -0.5)], 'root': [(X, -0.35)]}
    _key(arm, base, act, [
        (0, {}, {}),
        (8, crouch, {'root': V((0, 0.02, 0.06))}),
        (16, back(0.0, 0.0), lie),
        (24, back(0.35, 0.3), lie),
        (32, back(-0.35, -0.3), lie),
        (40, back(0.3, 0.3), lie),
        (48, back(-0.2, -0.2), lie),
        (54, crouch, {'root': V((0, 0.02, 0.06))}),
        (62, {}, {}),
    ])
    act.frame_range = (0, 62)
    return act


def build(arm, idle=None):
    """skate·roll 동작을 만든다(있으면 다시 만든다). 끝나면 idle 로 되돌린다."""
    for n in ('skate', 'roll'):
        a = bpy.data.actions.get(n)
        if a:
            bpy.data.actions.remove(a)
    idle = idle or bpy.data.actions['idle']
    base = _base(arm, idle)
    out = [build_skate(arm, base), build_roll(arm, base)]
    arm.animation_data.action = idle
    return out


def export_anims(arm, path):
    """뼈대와 skate·roll 동작만 glb 로 내보낸다(메시 없음). NLA 트랙으로 묶어 동작마다 애니메이션 하나."""
    ad = arm.animation_data
    keep = ad.action
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    for n in ('skate', 'roll'):
        t = ad.nla_tracks.new()
        t.name = n
        t.strips.new(n, int(bpy.data.actions[n].frame_range[0]), bpy.data.actions[n])
    ad.action = None
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_animations=True,
                              export_animation_mode='NLA_TRACKS', export_skins=False, export_yup=True)
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    ad.action = keep
