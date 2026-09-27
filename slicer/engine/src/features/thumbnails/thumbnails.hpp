// Plate pictures without a GPU. Bambu Studio renders them with OpenGL (GLCanvas3D::
// _render_thumbnail_internal); a headless engine has no GL context, so this is a small software
// rasteriser that draws the same views: the iso view (camera Iso: RotX(-45°)·RotZ(45°), Camera.cpp
// set_iso_orientation) of the plate's objects, lit or flat ("no light"), the top view of the whole
// plate, and the pick image (each object filled with its id as r + g·256 + b·65536, alpha 255, on a
// transparent background: picking_decode in Color.cpp).
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace printlab::thumbnails {

struct Mesh {
	/** Triangles in plate coordinates (mm): x y z for each corner, 9 floats per triangle. */
	std::vector<float> triangles;
	std::array<uint8_t, 4> color{0xEB, 0x81, 0x43, 0xFF};
	/** Pick images fill the object with this id. */
	uint32_t pick_id = 0;
};

enum class View { Iso, Top };

struct Options {
	int width = 512;
	int height = 512;
	View view = View::Iso;
	bool lighting = true;
	bool pick = false;
	/** Top view: the plate's printable area (x0, y0, x1, y1) in mm, framed whole. */
	std::array<double, 4> plate{0, 0, 256, 256};
};

/** RGBA pixels, row 0 at the top. */
std::vector<uint8_t> render(const std::vector<Mesh> &meshes, const Options &options);

/** A PNG (8-bit RGBA), deflated when the build has zlib (the upstream build does), else stored. */
std::string encode_png(const std::vector<uint8_t> &rgba, int width, int height);

/** render + encode_png into `path`; false when the file cannot be written. */
bool write_png(const std::string &path, const std::vector<Mesh> &meshes, const Options &options);

} // namespace printlab::thumbnails
