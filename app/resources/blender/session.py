# Interactive editing session. Opens the model in Blender; every save (Ctrl+S) also exports the visible
# meshes back to the app, which records them as a new version.
# Usage: blender --python session.py -- in.stl export.stl name blendfile
#
# Everything here avoids Blender operators where it can: the script starts before the window exists, and
# save handlers run without a normal context, so operators like the STL importer would refuse to run.
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import bpy
from bpy.app.handlers import persistent
from common import args, read_stl, write_stl, set_millimetres, scene_triangles

src, export_path, name, blend_path = args()[:4]
state = {'skip_next_save': False}


@persistent
def export_after_save(_):
    if state['skip_next_save']:
        state['skip_next_save'] = False
        return
    try:
        tris = scene_triangles(bpy.context)
        if not tris:
            print('Family Print Lab: nothing visible to export', flush=True)
            return
        tmp = export_path + '.partial'
        write_stl(tmp, tris)
        os.replace(tmp, export_path)
        print('Family Print Lab: exported %d triangles back to the app' % len(tris), flush=True)
    except Exception as error:  # never break the user's save over the export
        print('Family Print Lab: export failed:', error, flush=True)


# Install the save hook first, so it is in place whatever happens below.
bpy.app.handlers.save_post.append(export_after_save)


def frame_view():
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type != 'VIEW_3D':
                continue
            space = area.spaces.active
            # Parts are in millimetres, so a 200 mm part is 200 units: widen the clipping range.
            space.clip_start = 0.1
            space.clip_end = 100000
            region = next((r for r in area.regions if r.type == 'WINDOW'), None)
            if region:
                with bpy.context.temp_override(window=window, area=area, region=region):
                    bpy.ops.view3d.view_all()


def setup():
    try:
        if os.path.abspath(bpy.data.filepath or '') == os.path.abspath(blend_path):
            pass  # Blender opened the earlier working file itself (it is passed on the command line).
        else:
            for obj in list(bpy.data.objects):  # the startup cube, lamp and camera
                bpy.data.objects.remove(obj, do_unlink=True)
            set_millimetres(bpy.context.scene)
            verts, faces = read_stl(src)
            mesh = bpy.data.meshes.new(name[:60] or 'Part')
            mesh.from_pydata(verts, [], faces)
            mesh.update()
            obj = bpy.data.objects.new(name[:60] or 'Part', mesh)
            bpy.context.scene.collection.objects.link(obj)
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            # The first save only creates the working file; it is not a change to send back.
            state['skip_next_save'] = True
            bpy.ops.wm.save_as_mainfile(filepath=blend_path)
        frame_view()
        print('Family Print Lab: session ready', flush=True)
        if os.environ.get('FPL_SELFTEST'):
            bpy.app.timers.register(selftest, first_interval=0.5)
    except Exception as error:
        print('Family Print Lab: could not set up the session:', error, flush=True)
    return None


def selftest():
    """For automated tests only: change the part, save like Ctrl+S does, and quit."""
    obj = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
    obj.scale = (1.5, 1.5, 1.5)
    window = bpy.context.window_manager.windows[0]
    with bpy.context.temp_override(window=window):
        bpy.ops.wm.save_mainfile()
        bpy.ops.wm.quit_blender()
    return None


# Run once the window exists.
bpy.app.timers.register(setup, first_interval=0.3)
