# Reduces triangle count while keeping the shape. Usage: ... --python decimate.py -- in.stl out.stl 0.5
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from common import args, load_stl, export_stl, result

src, dst, ratio = args()[:3]
obj = load_stl(src)
before = len(obj.data.polygons)
mod = obj.modifiers.new('Decimate', 'DECIMATE')
mod.ratio = max(0.01, min(1.0, float(ratio)))
mod.use_collapse_triangulate = True
export_stl(obj, dst)
result(faces_before=before, ratio=mod.ratio)
