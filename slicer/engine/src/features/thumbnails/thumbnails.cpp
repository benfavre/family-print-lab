#include "thumbnails.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>

#ifdef PRINTLAB_HAVE_ZLIB
#include <zlib.h>
#endif

namespace printlab::thumbnails {

namespace {

struct V3 {
	double x, y, z;
};
V3 sub(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
double dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
V3 norm(V3 a) {
	double l = std::sqrt(dot(a, a));
	return l > 0 ? V3{a.x / l, a.y / l, a.z / l} : V3{0, 0, 1};
}

/** World → view: x right, y up, z towards the camera. */
V3 to_view(V3 p, View view) {
	if (view == View::Top) return p;
	// Iso: RotX(-45°) · RotZ(45°) applied to the point (Camera::set_iso_orientation).
	const double c = std::sqrt(0.5), s = std::sqrt(0.5);
	V3 r{c * p.x - s * p.y, s * p.x + c * p.y, p.z};         // RotZ(45°)
	return {r.x, c * r.y + s * r.z, -s * r.y + c * r.z};      // RotX(-45°)
}

uint32_t crc32(const uint8_t *data, size_t n, uint32_t crc = 0) {
	// Built once; static local initialisation is thread-safe (strands render side by side).
	static const std::array<uint32_t, 256> table = [] {
		std::array<uint32_t, 256> t{};
		for (uint32_t i = 0; i < 256; ++i) {
			uint32_t c = i;
			for (int k = 0; k < 8; ++k) c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
			t[i] = c;
		}
		return t;
	}();
	crc = ~crc;
	for (size_t i = 0; i < n; ++i) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
	return ~crc;
}

void put32(std::string &out, uint32_t v) {
	out += char(v >> 24);
	out += char(v >> 16);
	out += char(v >> 8);
	out += char(v);
}

void chunk(std::string &out, const char *type, const std::string &data) {
	put32(out, static_cast<uint32_t>(data.size()));
	std::string body = std::string(type, 4) + data;
	out += body;
	put32(out, crc32(reinterpret_cast<const uint8_t *>(body.data()), body.size()));
}

/** zlib stream of `raw`: deflated when zlib is linked, else stored blocks (valid, just larger). */
std::string zlib_stream(const std::string &raw) {
#ifdef PRINTLAB_HAVE_ZLIB
	uLongf size = compressBound(static_cast<uLong>(raw.size()));
	std::string packed(size, '\0');
	if (compress2(reinterpret_cast<Bytef *>(&packed[0]), &size, reinterpret_cast<const Bytef *>(raw.data()),
	              static_cast<uLong>(raw.size()), 6) == Z_OK) {
		packed.resize(size);
		return packed;
	}
#endif
	std::string out = "\x78\x01";
	size_t at = 0;
	do {
		size_t n = std::min<size_t>(65535, raw.size() - at);
		bool last = at + n == raw.size();
		out += char(last ? 1 : 0);
		out += char(n & 0xFF);
		out += char(n >> 8);
		out += char(~n & 0xFF);
		out += char((~n >> 8) & 0xFF);
		out.append(raw, at, n);
		at += n;
	} while (at < raw.size());
	uint32_t a = 1, b = 0;
	for (unsigned char c : raw) {
		a = (a + c) % 65521;
		b = (b + a) % 65521;
	}
	put32(out, (b << 16) | a);
	return out;
}

} // namespace

std::vector<uint8_t> render(const std::vector<Mesh> &meshes, const Options &o) {
	const int w = o.width, h = o.height;
	std::vector<uint8_t> px(static_cast<size_t>(w) * h * 4, 0);
	std::vector<double> depth(static_cast<size_t>(w) * h, -std::numeric_limits<double>::infinity());

	// Frame: the objects' box grown like Bambu Studio's (10 % sideways, 20 % in height), or the plate.
	double x0, x1, y0, y1;
	if (o.view == View::Top) {
		x0 = o.plate[0], y0 = o.plate[1], x1 = o.plate[2], y1 = o.plate[3];
	} else {
		double bx0 = 1e300, by0 = 1e300, bz0 = 0, bx1 = -1e300, by1 = -1e300, bz1 = 0;
		for (const Mesh &m : meshes)
			for (size_t i = 0; i + 2 < m.triangles.size(); i += 3) {
				bx0 = std::min<double>(bx0, m.triangles[i]), bx1 = std::max<double>(bx1, m.triangles[i]);
				by0 = std::min<double>(by0, m.triangles[i + 1]), by1 = std::max<double>(by1, m.triangles[i + 1]);
				bz1 = std::max<double>(bz1, m.triangles[i + 2]);
			}
		if (bx0 > bx1) return px;
		double gw = (bx1 - bx0) * 0.1, gd = (by1 - by0) * 0.1, gh = (bz1 - bz0) * 0.2;
		bx0 -= gw, bx1 += gw, by0 -= gd, by1 += gd, bz0 -= gh, bz1 += gh;
		x0 = y0 = 1e300, x1 = y1 = -1e300;
		for (int c = 0; c < 8; ++c) {
			V3 v = to_view({c & 1 ? bx1 : bx0, c & 2 ? by1 : by0, c & 4 ? bz1 : bz0}, o.view);
			x0 = std::min(x0, v.x), x1 = std::max(x1, v.x), y0 = std::min(y0, v.y), y1 = std::max(y1, v.y);
		}
	}
	double scale = std::min(w / std::max(x1 - x0, 1e-6), h / std::max(y1 - y0, 1e-6));
	double cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
	const V3 light = norm({-0.4, 0.6, 1.0}); // in view space: from the upper left, towards the camera

	for (const Mesh &m : meshes)
		for (size_t i = 0; i + 8 < m.triangles.size(); i += 9) {
			V3 p[3];
			for (int k = 0; k < 3; ++k) {
				V3 v = to_view({m.triangles[i + 3 * k], m.triangles[i + 3 * k + 1], m.triangles[i + 3 * k + 2]}, o.view);
				p[k] = {(v.x - cx) * scale + w / 2.0, h / 2.0 - (v.y - cy) * scale, v.z};
			}
			V3 n = norm(cross(sub(p[1], p[0]), sub(p[2], p[0])));
			// Screen y points down, so a facet facing the camera has a negative z normal here.
			double shade = o.lighting ? 0.35 + 0.65 * std::max(0.0, dot({n.x, -n.y, -n.z}, light)) : 1.0;
			uint8_t rgba[4];
			if (o.pick) {
				rgba[0] = uint8_t(m.pick_id & 0xFF), rgba[1] = uint8_t((m.pick_id >> 8) & 0xFF);
				rgba[2] = uint8_t((m.pick_id >> 16) & 0xFF), rgba[3] = 0xFF;
			} else {
				for (int k = 0; k < 3; ++k) rgba[k] = uint8_t(std::min(255.0, m.color[k] * shade));
				rgba[3] = m.color[3];
			}
			int minx = std::max(0, int(std::floor(std::min({p[0].x, p[1].x, p[2].x}))));
			int maxx = std::min(w - 1, int(std::ceil(std::max({p[0].x, p[1].x, p[2].x}))));
			int miny = std::max(0, int(std::floor(std::min({p[0].y, p[1].y, p[2].y}))));
			int maxy = std::min(h - 1, int(std::ceil(std::max({p[0].y, p[1].y, p[2].y}))));
			double area = (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y);
			if (std::fabs(area) < 1e-12) continue;
			for (int y = miny; y <= maxy; ++y)
				for (int x = minx; x <= maxx; ++x) {
					double sx = x + 0.5, sy = y + 0.5;
					double w0 = ((p[1].x - sx) * (p[2].y - sy) - (p[2].x - sx) * (p[1].y - sy)) / area;
					double w1 = ((p[2].x - sx) * (p[0].y - sy) - (p[0].x - sx) * (p[2].y - sy)) / area;
					double w2 = 1 - w0 - w1;
					if (w0 < 0 || w1 < 0 || w2 < 0) continue;
					double z = w0 * p[0].z + w1 * p[1].z + w2 * p[2].z;
					size_t at = static_cast<size_t>(y) * w + x;
					if (z <= depth[at]) continue;
					depth[at] = z;
					std::copy(rgba, rgba + 4, &px[at * 4]);
				}
		}
	return px;
}

std::string encode_png(const std::vector<uint8_t> &rgba, int width, int height) {
	std::string png = "\x89PNG\r\n\x1a\n";
	std::string ihdr;
	put32(ihdr, static_cast<uint32_t>(width));
	put32(ihdr, static_cast<uint32_t>(height));
	ihdr += "\x08\x06\x00\x00\x00"; // 8-bit, RGBA, deflate, adaptive filtering, no interlace
	chunk(png, "IHDR", std::string(ihdr.data(), 13));
	std::string raw;
	raw.reserve(static_cast<size_t>(height) * (width * 4 + 1));
	for (int y = 0; y < height; ++y) {
		raw += '\0'; // filter: none
		raw.append(reinterpret_cast<const char *>(&rgba[static_cast<size_t>(y) * width * 4]), static_cast<size_t>(width) * 4);
	}
	chunk(png, "IDAT", zlib_stream(raw));
	chunk(png, "IEND", "");
	return png;
}

bool write_png(const std::string &path, const std::vector<Mesh> &meshes, const Options &options) {
	std::ofstream f(path, std::ios::binary);
	if (!f) return false;
	std::string png = encode_png(render(meshes, options), options.width, options.height);
	f.write(png.data(), static_cast<std::streamsize>(png.size()));
	return static_cast<bool>(f);
}

} // namespace printlab::thumbnails
