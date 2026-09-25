# Shared helpers for Family Print Lab's Blender scripts. Blender imports this via sys.path.
import bpy, bmesh, json, struct, sys


def args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def load_stl(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 0.001
    bpy.context.scene.unit_settings.length_unit = 'MILLIMETERS'
    bpy.ops.wm.stl_import(filepath=path)
    objects = [o for o in bpy.context.selected_objects if o.type == 'MESH']
    if not objects:
        raise SystemExit('No mesh in the input file')
    if len(objects) > 1:
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
    return bpy.context.view_layer.objects.active or objects[0]


def export_stl(obj, path):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.wm.stl_export(filepath=path, export_selected_objects=True, apply_modifiers=True)


def result(**data):
    print('RESULT ' + json.dumps(data), flush=True)


# ---------- Operator-free STL I/O (works at startup and inside handlers, where operators may lack context) ----------

def read_stl(path):
    """Returns (vertices, faces) with shared vertices merged. Handles binary and ASCII STL."""
    with open(path, 'rb') as f:
        data = f.read()
    tris = []
    count = struct.unpack_from('<I', data, 80)[0] if len(data) >= 84 else 0
    if len(data) >= 84 and 84 + count * 50 == len(data):
        for i in range(count):
            v = struct.unpack_from('<9f', data, 84 + i * 50 + 12)
            tris.append((v[0:3], v[3:6], v[6:9]))
    else:
        points = []
        for line in data.decode('utf-8', 'replace').splitlines():
            parts = line.split()
            if len(parts) == 4 and parts[0] == 'vertex':
                points.append(tuple(float(x) for x in parts[1:]))
        tris = [tuple(points[i:i + 3]) for i in range(0, len(points) - 2, 3)]
    index, verts, faces = {}, [], []
    for tri in tris:
        face = []
        for p in tri:
            key = (round(p[0], 5), round(p[1], 5), round(p[2], 5))
            if key not in index:
                index[key] = len(verts)
                verts.append(p)
            face.append(index[key])
        if len(set(face)) == 3:
            faces.append(face)
    return verts, faces


def write_stl(path, triangles, header=b'Family Print Lab (Blender)'):
    """Writes binary STL from a list of triangles (three (x, y, z) points each)."""
    with open(path, 'wb') as f:
        f.write(header.ljust(80, b' ')[:80])
        f.write(struct.pack('<I', len(triangles)))
        for a, b, c in triangles:
            f.write(struct.pack('<12fH', 0, 0, 0, *a, *b, *c, 0))


def set_millimetres(scene):
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = 'MILLIMETERS'


def scene_triangles(context):
    """All visible mesh objects as world-space triangles, with modifiers applied."""
    deps = context.evaluated_depsgraph_get()
    tris = []
    for obj in context.scene.objects:
        if obj.type != 'MESH' or not obj.visible_get():
            continue
        evaluated = obj.evaluated_get(deps)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        mw = obj.matrix_world
        verts = [mw @ v.co for v in mesh.vertices]
        for t in mesh.loop_triangles:
            tris.append(tuple(tuple(verts[i]) for i in t.vertices))
        evaluated.to_mesh_clear()
    return tris
