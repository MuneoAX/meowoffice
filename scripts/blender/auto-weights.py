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
    # 털 많은 품종은 리메시해도 털 끝이 따로 떨어진 작은 조각으로 남는데, bone heat 가 그런 조각에 엉뚱한 뼈(뒤통수 털 → 팔)를 준다.
    # 가장 큰 조각(몸)만 남기고 지운다. 떨어진 털의 원래 정점은 아래 4)에서 메시를 따라 뿌리 쪽 가중치를 이어받는다.
    import bmesh
    bm = bmesh.new(); bm.from_mesh(px.data); bm.verts.ensure_lookup_table()
    left, isles = set(bm.verts), []
    while left:
        st = [left.pop()]; isl = set(st)
        while st:
            v = st.pop()
            for e in v.link_edges:
                w = e.other_vert(v)
                if w in left:
                    left.discard(w); isl.add(w); st.append(w)
        isles.append(isl)
    isles.sort(key=len, reverse=True)
    drop = [v for isl in isles[1:] for v in isl]
    bmesh.ops.delete(bm, geom=drop, context="VERTS")
    bm.to_mesh(px.data); bm.free()
    print("AUTOW", name, "proxy islands", len(isles), "dropped verts", len(drop))
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
    ws, empty, dist = [], 0, []
    for v in me.data.vertices:
        wp = Mo @ v.co
        hit = bvh.find_nearest(wp)
        dist.append(hit[3] if hit[3] is not None else 1e9)
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
    # 4) 털 끝처럼 대리 메시(몸 겉면)에서 멀리 뻗은 정점은 가장 가까운 대리 면이 엉뚱한 부위(볼 털 끝 → 손 등)일 수 있어
    #    가시처럼 솟는다. 겉면 가까이(복셀 크기 안) 정점만 믿고, 먼 정점은 메시를 따라 뿌리 쪽 이웃의 가중치를 이어받게 한다.
    vs = me.data.vertices
    rep, seen = [], {}
    for v in vs:  # 같은 자리 정점(무늬 이음새)은 한 몸
        k = (round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5))
        rep.append(seen.setdefault(k, v.index))
    nb = {}
    for e in me.data.edges:
        a, c = rep[e.vertices[0]], rep[e.vertices[1]]
        if a != c:
            nb.setdefault(a, set()).add(c); nb.setdefault(c, set()).add(a)
    TRUST = VOXEL * 1.0
    known = {rep[i] for i in range(len(vs)) if dist[i] <= TRUST}
    W = {r: dict((n, w) for n, w in ws[r][3]) for r in known}
    frontier = [r for r in known]
    passes = 0
    while frontier:
        nxt = {}
        for r in frontier:
            for q in nb.get(r, ()):
                if q not in W:
                    nxt.setdefault(q, []).append(r)
        for q, srcs in nxt.items():
            acc = {}
            for r in srcs:
                for n, w in W[r].items():
                    acc[n] = acc.get(n, 0) + w / len(srcs)
            W[q] = acc
        frontier = list(nxt); passes += 1
    far = 0
    for i in range(len(vs)):
        r = rep[i]
        if r in W and dist[i] > TRUST:
            g = sorted(W[r].items(), key=lambda x: -x[1])[:4]
            t = sum(w for _, w in g) or 1
            ws[i][3] = [[n, w / t] for n, w in g]; far += 1
        elif r in W and rep[i] != i:
            ws[i][3] = ws[r][3]
    print("AUTOW", name, "far verts", far, "passes", passes)
    json.dump(ws, open(os.path.join(OUT, name + ".weights.json"), "w"))
    json.dump({b.name: [b.head_local.x, b.head_local.z, -b.head_local.y] for b in o.data.bones}, open(os.path.join(OUT, name + ".json"), "w"), indent=1)
    bpy.data.objects.remove(px, do_unlink=True)
    print("AUTOW", name, "proxy", len(verts), "filled", filled, "orig", len(ws), "empty", empty)
