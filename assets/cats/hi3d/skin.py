"""품종 텍스처(스킨)용 준비 — Blender 안에서 실행.

1) make_uv: 텍스처 UV 'tex' 하나만 남긴다 (glTF 에서 0번). 몸은 자동 펼침(u 0~0.94),
   데칼(눈·코·입·반짝임)과 수염 가닥은 오른쪽 끝 단색 칸으로:
     어두운색(코·수염) u 0.975 v 0.05 / 입(분홍) v 0.15 / 흰색 v 0.25 / 눈동자 v 0.35 (품종마다 눈 색)
2) bake: 텍스처 픽셀마다 쉬는 자세의 표면 위치·법선을 구워 bake/<체형>.npz 로 저장
   → breeds.py 가 이것으로 품종 무늬를 계산한다 (Blender 없이).
"""
import math
import os

import bpy
import numpy as np

SWATCH = {8: 0.35, 16: 0.05, 6: 0.05, 15: 0.15, 7: 0.25}  # 칸 → 단색 칸 v (코·수염 어두운색 / 입 분홍 / 흰색 / 눈동자)
SW_U = 0.975
BODY_U = 0.94
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bake')


def special_faces(me):
    dec = me.attributes['decal'].data if 'decal' in me.attributes else None
    cell = me.attributes['cell'].data
    out = {}
    for p in me.polygons:
        c = cell[p.index].value
        if (dec and dec[p.index].value) or c == 16:  # 데칼, 형상 수염 가닥
            out[p.index] = SWATCH.get(c, 0.05)
    return out


def make_uv(obj_name, margin=0.003, keep=()):
    """keep: 지우지 않고 남길 UV (원본 텍스처를 굽는 데 쓰고 drop_uv 로 지운다)"""
    ob = bpy.data.objects[obj_name]; me = ob.data
    for uv in list(me.uv_layers):
        if uv.name not in keep:
            me.uv_layers.remove(uv)
    me.uv_layers.new(name='tex')
    me.uv_layers.active = me.uv_layers['tex']
    sp = special_faces(me)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.hide_set(False); ob.select_set(True); bpy.context.view_layer.objects.active = ob
    for p in me.polygons:
        p.select = p.index not in sp
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    uv = me.uv_layers['tex'].data
    for p in me.polygons:
        if p.index in sp:
            for li in p.loop_indices:
                uv[li].uv = (SW_U, sp[p.index])
        else:
            for li in p.loop_indices:
                u, v = uv[li].uv
                uv[li].uv = (u * BODY_U, v)
    return len(sp)


def drop_uv(obj_name):
    me = bpy.data.objects[obj_name].data
    for uv in list(me.uv_layers):
        if uv.name != 'tex':
            me.uv_layers.remove(uv)


def bake_face(obj_name, body, src='cat_hi', size=2048, dist=0.02):
    """원본(Hi3D 고해상도 메쉬·텍스처)의 색을 'tex' UV 공간으로 투사해 굽는다 → bake/<체형>_face.png
    축소 메쉬의 원본 UV 는 큰 삼각형 때문에 눈 경계가 뭉개지므로, 고해상도 원본에서 광선으로 가져온다.
    조각된 눈구멍과 원본 텍스처의 눈이 그대로 맞는다."""
    lo = bpy.data.objects[obj_name]; hi = bpy.data.objects[src]
    me = lo.data.copy()
    tmp = bpy.data.objects.new('_bake_tmp', me)
    bpy.context.scene.collection.objects.link(tmp)
    mat = bpy.data.materials.new('_bake_face'); mat.use_nodes = True
    nt = mat.node_tree
    tgt = nt.nodes.new('ShaderNodeTexImage')
    img = bpy.data.images.new('_bake_face_img', size, size, alpha=True)
    img.generated_color = (0, 0, 0, 0)
    tgt.image = img; nt.nodes.active = tgt
    me.materials.clear(); me.materials.append(mat)
    me.uv_layers.active = me.uv_layers['tex']
    sc = bpy.context.scene; old_engine = sc.render.engine
    sc.render.engine = 'CYCLES'; sc.cycles.samples = 1
    hidden = hi.hide_get(); hi.hide_set(False)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    hi.select_set(True); tmp.select_set(True); bpy.context.view_layer.objects.active = tmp
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, use_selected_to_active=True,
                        cage_extrusion=dist, max_ray_distance=dist * 2, margin=8)
    hi.hide_set(hidden)
    path = os.path.join(OUT, body + '_face.png')
    os.makedirs(OUT, exist_ok=True)
    img.filepath_raw = path; img.file_format = 'PNG'; img.save()
    sc.render.engine = old_engine
    bpy.data.images.remove(img)
    bpy.data.objects.remove(tmp); bpy.data.meshes.remove(me); bpy.data.materials.remove(mat)
    return path


def bake(obj_name, body, size=1024):
    """쉬는 자세 위치·법선을 텍스처 공간에 굽는다 (모디파이어 없는 임시 복사본)."""
    src = bpy.data.objects[obj_name]
    me = src.data.copy()
    tmp = bpy.data.objects.new('_bake_tmp', me)
    bpy.context.scene.collection.objects.link(tmp)
    sp = special_faces(me)
    # 단색 칸 면은 굽지 않는다 (지운다)
    import bmesh
    bm = bmesh.new(); bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in sp], context='FACES_ONLY')
    bm.to_mesh(me); bm.free()
    mat = bpy.data.materials.new('_bake_mat'); mat.use_nodes = True
    nt = mat.node_tree; nt.nodes.clear()
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    em = nt.nodes.new('ShaderNodeEmission')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    tex = nt.nodes.new('ShaderNodeTexImage')
    me.materials.clear(); me.materials.append(mat)
    sc = bpy.context.scene
    old_engine = sc.render.engine
    try:
        sc.render.engine = 'CYCLES'
    except TypeError as e:
        raise RuntimeError(str(e))
    sc.cycles.samples = 1
    sc.render.bake.margin = 6
    for o in bpy.context.selected_objects:
        o.select_set(False)
    tmp.select_set(True); bpy.context.view_layer.objects.active = tmp
    res = {}
    for key, sock in (('pos', 'Position'), ('nrm', 'Normal')):
        img = bpy.data.images.new('_bake_' + key, size, size, alpha=True, float_buffer=True)
        img.generated_color = (0, 0, 0, 0)
        tex.image = img; nt.nodes.active = tex
        for l in list(em.inputs['Color'].links):
            nt.links.remove(l)
        nt.links.new(geo.outputs[sock], em.inputs['Color'])
        bpy.ops.object.bake(type='EMIT', margin=6)
        a = np.empty(size * size * 4, dtype=np.float32)
        img.pixels.foreach_get(a)
        res[key] = a.reshape(size, size, 4)  # 아래쪽 행이 v=0
        bpy.data.images.remove(img)
    sc.render.engine = old_engine
    bpy.data.objects.remove(tmp); bpy.data.meshes.remove(me); bpy.data.materials.remove(mat)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, body + '.npz')
    np.savez_compressed(path, pos=res['pos'][..., :3].astype(np.float16), nrm=res['nrm'][..., :3].astype(np.float16),
                        mask=(res['pos'][..., 3] > 0.5))
    return path, int((res['pos'][..., 3] > 0.5).sum())


def transfer(ref_name, obj_name, src_png, out_png, size=1024, dist=0.02):
    """그려 둔 텍스처를 옛 메쉬(ref, 옛 UV) → 새 메쉬(새 UV) 로 옮겨 굽는다 (표면 위치 기준 투사).
    형상·UV 배치를 바꿔도 사용자가 그린 그림을 다시 그리지 않아도 되게."""
    ref = bpy.data.objects[ref_name]; src = bpy.data.objects[obj_name]
    me = src.data.copy()
    tmp = bpy.data.objects.new('_bake_tmp', me)
    bpy.context.scene.collection.objects.link(tmp)
    # 옛 메쉬에 그림 재질 (방출로 그대로)
    rmat = bpy.data.materials.new('_ref_mat'); rmat.use_nodes = True
    nt = rmat.node_tree; nt.nodes.clear()
    uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'tex'
    ti = nt.nodes.new('ShaderNodeTexImage'); ti.image = bpy.data.images.load(src_png, check_existing=False)
    em = nt.nodes.new('ShaderNodeEmission'); out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(uvn.outputs[0], ti.inputs['Vector']); nt.links.new(ti.outputs['Color'], em.inputs['Color'])
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    old_mats = list(ref.data.materials)
    ref.data.materials.clear(); ref.data.materials.append(rmat)
    # 새 메쉬에 굽는 그림
    tmat = bpy.data.materials.new('_tgt_mat'); tmat.use_nodes = True
    tt = tmat.node_tree.nodes.new('ShaderNodeTexImage')
    img = bpy.data.images.new('_xfer', size, size, alpha=True); img.generated_color = (1, 1, 1, 0)
    tt.image = img; tmat.node_tree.nodes.active = tt
    me.materials.clear(); me.materials.append(tmat)
    me.uv_layers.active = me.uv_layers['tex']
    sc = bpy.context.scene; old_engine = sc.render.engine
    sc.render.engine = 'CYCLES'; sc.cycles.samples = 1
    hidden = ref.hide_get(); ref.hide_set(False)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ref.select_set(True); tmp.select_set(True); bpy.context.view_layer.objects.active = tmp
    bpy.ops.object.bake(type='EMIT', use_selected_to_active=True, cage_extrusion=dist, max_ray_distance=dist * 2, margin=8)
    ref.hide_set(hidden)
    img.filepath_raw = out_png; img.file_format = 'PNG'; img.save()
    sc.render.engine = old_engine
    ref.data.materials.clear()
    for m in old_mats:
        ref.data.materials.append(m)
    for x in (img, ti.image):
        bpy.data.images.remove(x)
    bpy.data.objects.remove(tmp); bpy.data.meshes.remove(me)
    bpy.data.materials.remove(rmat); bpy.data.materials.remove(tmat)
    return out_png
