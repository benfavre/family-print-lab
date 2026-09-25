# Repairs a mesh for printing: merges duplicate vertices, removes loose geometry, fills holes,
# makes normals consistent. Usage: blender -b --factory-startup --python repair.py -- in.stl out.stl
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import bmesh
from common import args, load_stl, export_stl, result

src, dst = args()[:2]
obj = load_stl(src)
bm = bmesh.new()
bm.from_mesh(obj.data)
verts_before, faces_before = len(bm.verts), len(bm.faces)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
loose = [v for v in bm.verts if not v.link_faces]
bmesh.ops.delete(bm, geom=loose, context='VERTS')
degenerate = [f for f in bm.faces if f.calc_area() < 1e-12]
bmesh.ops.delete(bm, geom=degenerate, context='FACES')
holes = bmesh.ops.holes_fill(bm, edges=bm.edges, sides=0)
bmesh.ops.triangulate(bm, faces=bm.faces)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
non_manifold = sum(1 for e in bm.edges if not e.is_manifold)
bm.to_mesh(obj.data)
bm.free()
export_stl(obj, dst)
result(verts_before=verts_before, faces_before=faces_before, faces_after=len(obj.data.polygons),
       holes_filled=len(holes.get('faces', [])), degenerate_removed=len(degenerate), loose_removed=len(loose),
       non_manifold_edges=non_manifold)
