# 사용: blender -b <리깅 손질한 .blend> --python scripts/blender/auto-weights.py -- <품종,...>   (털 많은 품종은 환경 변수 MEOW_VOXEL=0.012)
# 결과: design/rig/<품종>.json(관절)·<품종>.weights.json(가중치) → node scripts/apply-rig-edit.mjs <모델> <관절> - <가중치> → node scripts/ai-cat-anims.mjs <모델> <옛 체형>
# 화면 없는 Blender: 저장된 cats.blend 의 4종을 '빈틈 없는 대리 메시'로 자동 가중치(bone heat) → 원래 메시에 옮겨 담아 JSON 으로
# 원래 메시는 무늬 이음새마다 같은 자리 정점이 두 개, 입을 가른 틈, 털 조각이 있어 bone heat 가 실패한다.
import bpy, json, sys
from mathutils.bvhtree import BVHTree

import os
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "design", "rig")  # 저장소/design/rig
os.makedirs(OUT, exist_ok=True)
CATS = sys.argv[sys.argv.index("--") + 1].split(",") if "--" in sys.argv else ["korean_cheese", "scottish_fold", "persian", "munchkin"]
VOXEL = float(__import__("os").environ.get("MEOW_VOXEL", "0.006"))

for name in CATS:
    o = bpy.data.objects[name + "_rig"]
    me = next(c for c in o.children if c.type == "MESH")
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for b in o.data.bones:
        b.use_deform = b.name not in ("Root", "tail_root")
    # 1) 대리 메시: 쉬는 자세(뼈대 효과 없이) 그대로 복사 → 복셀 리메시
    px = me.copy(); px.data = me.data.copy(); px.name = name + "_proxy"
    bpy.context.collection.objects.link(px)
    px.modifiers.clear()
    if px.data.shape_keys:
        px.shape_key_clear()
    px.vertex_groups.clear()
    px.parent = None
    px.matrix_world = me.matrix_world.copy()
    bpy.ops.object.select_all(action="DESELECT")
    px.select_set(True); bpy.context.view_layer.objects.active = px
    rm = px.modifiers.new("remesh", "REMESH"); rm.mode = "VOXEL"; rm.voxel_size = VOXEL
    bpy.ops.object.modifier_apply(modifier=rm.name)
    # 2) 대리 메시에 자동 가중치
    bpy.ops.object.select_all(action="DESELECT")
    px.select_set(True); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    gname = {g.index: g.name for g in px.vertex_groups}
    pw = [{gname[x.group]: x.weight for x in v.groups if x.weight > 1e-4} for v in px.data.vertices]
    filled = sum(1 for w in pw if w)
    # 3) 원래 메시 정점마다 가장 가까운 대리 메시 면의 세 정점 가중치를 거리로 섞어 옮김(같은 월드 좌표에서)
    Mp = px.matrix_world; Mo = me.matrix_world
    verts = [Mp @ v.co for v in px.data.vertices]
    polys = [list(p.vertices) for p in px.data.polygons]
    bvh = BVHTree.FromPolygons(verts, polys)
    ws, empty = [], 0
    for v in me.data.vertices:
        wp = Mo @ v.co
        hit = bvh.find_nearest(wp)
        acc = {}
        if hit[2] is not None:
            vs = polys[hit[2]]
            ds = [max(1e-6, (verts[i] - hit[0]).length) for i in vs]
            inv = [1 / d for d in ds]; s = sum(inv)
            for i, k in zip(vs, inv):
                for g, w in pw[i].items():
                    acc[g] = acc.get(g, 0) + w * k / s
        g = sorted(acc.items(), key=lambda x: -x[1])[:4]
        if not g:
            empty += 1
        ws.append([v.co.x, v.co.z, -v.co.y, [[n, w] for n, w in g]])  # 메시 좌표(Z 위) → glTF(Y 위)
    json.dump(ws, open(os.path.join(OUT, name + ".weights.json"), "w"))
    json.dump({b.name: [b.head_local.x, b.head_local.z, -b.head_local.y] for b in o.data.bones}, open(os.path.join(OUT, name + ".json"), "w"), indent=1)
    bpy.data.objects.remove(px, do_unlink=True)
    print("AUTOW", name, "proxy", len(verts), "filled", filled, "orig", len(ws), "empty", empty)
