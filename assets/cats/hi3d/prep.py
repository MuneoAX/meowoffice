"""Hi3D 원본 glb → 작업용 저폴리 메쉬 (체형 공용).

1) 가져오기 → 부모 변환 적용 → 발바닥 원점, 정면 -Y, 좌우 중앙
2) 크기: height 를 주면 키를, head_w 를 주면 머리 폭(귀·수염 제외)을 맞춘다 (짧은다리형처럼 키가 달라도 머리 크기 통일)
3) 가까운 정점 합치기 → 좌우 대칭 축소(0.1 → tris 개) → 퇴화 면 정리 → 부드러운 셰이딩
사용: prep(r'...\\cat_shortleg_hi3d.glb', 'short', head_w=0.53)  → 'short_hi'(숨김), 'short_lo', 'short_lo_base'(숨김 복사)
"""
import bmesh
import bpy
from mathutils import Matrix, Vector


def head_width(me, z0):
    xs = [abs(v.co.x) for v in me.vertices if v.co.z > z0 and abs(v.co.y) < 0.6]
    xs.sort()
    return 2 * xs[int(len(xs) * 0.98)] if xs else 0


def prep(path, name, height=0.9, head_w=None, tris=8000):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    mesh = next(o for o in new if o.type == 'MESH')
    mw = mesh.matrix_world.copy(); mesh.parent = None; mesh.matrix_world = mw
    for o in new:
        if o is not mesh:
            bpy.data.objects.remove(o)
    mesh.name = name + '_hi'; mesh.data.name = name + '_hi'
    me = mesh.data
    me.transform(mesh.matrix_world); mesh.matrix_world = Matrix()
    vs = [v.co for v in me.vertices]
    mn = Vector([min(v[i] for v in vs) for i in range(3)]); mx = Vector([max(v[i] for v in vs) for i in range(3)])
    me.transform(Matrix.Translation(-Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))))
    if head_w:
        h = mx.z - mn.z
        s = head_w / head_width(me, h * 0.62)
    else:
        s = height / (mx.z - mn.z)
    me.transform(Matrix.Scale(s, 4))
    lo = bpy.data.objects.new(name + '_lo', me.copy()); lo.data.name = name + '_lo'
    bpy.context.scene.collection.objects.link(lo)
    bm = bmesh.new(); bm.from_mesh(lo.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0002)
    bm.to_mesh(lo.data); bm.free()
    for o in bpy.context.selected_objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = lo; lo.select_set(True)
    mesh.hide_set(True)
    for r in (0.1, None):
        md = lo.modifiers.new('dec', 'DECIMATE'); md.decimate_type = 'COLLAPSE'
        md.use_symmetry = True; md.symmetry_axis = 'X'
        md.ratio = r if r else tris / len(lo.data.polygons)
        bpy.ops.object.modifier_apply(modifier=md.name)
    bm = bmesh.new(); bm.from_mesh(lo.data)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=0.0005)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bm.to_mesh(lo.data); bm.free()
    for p in lo.data.polygons:
        p.use_smooth = True
    base = bpy.data.objects.new(name + '_lo_base', lo.data.copy())
    bpy.context.scene.collection.objects.link(base); base.hide_set(True)
    return lo, s, tuple(round(v, 3) for v in lo.dimensions)
