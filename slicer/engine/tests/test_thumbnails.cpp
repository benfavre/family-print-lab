#include <algorithm>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>

#include "check.hpp"
#include "features/thumbnails/thumbnails.hpp"

using namespace printlab::thumbnails;

namespace {

/** A w × d × h box at (x, y) as 12 triangles. */
Mesh box(float x, float y, float w, float d, float h, uint32_t id) {
	float v[8][3] = {{x, y, 0},     {x + w, y, 0},     {x + w, y + d, 0}, {x, y + d, 0},
	                 {x, y, h},     {x + w, y, h},     {x + w, y + d, h}, {x, y + d, h}};
	int f[12][3] = {{0, 2, 1}, {0, 3, 2}, {4, 5, 6}, {4, 6, 7}, {0, 1, 5}, {0, 5, 4},
	                {1, 2, 6}, {1, 6, 5}, {2, 3, 7}, {2, 7, 6}, {3, 0, 4}, {3, 4, 7}};
	Mesh m;
	for (auto &t : f)
		for (int k : t)
			for (int c = 0; c < 3; ++c) m.triangles.push_back(v[k][c]);
	m.pick_id = id;
	return m;
}

uint8_t alpha(const std::vector<uint8_t> &px, int w, int x, int y) { return px[(static_cast<size_t>(y) * w + x) * 4 + 3]; }

} // namespace

TEST("draws the objects in the middle of a transparent picture") {
	Options o;
	o.width = o.height = 128;
	auto px = render({box(100, 100, 20, 20, 10, 1)}, o);
	CHECK_EQ(px.size(), size_t(128 * 128 * 4));
	CHECK_EQ(alpha(px, 128, 64, 64), uint8_t(0xFF));
	CHECK_EQ(alpha(px, 128, 0, 0), uint8_t(0));
	CHECK_EQ(alpha(px, 128, 127, 127), uint8_t(0));
}

TEST("lit pictures shade the faces differently; flat ones do not") {
	Options o;
	o.width = o.height = 128;
	auto lit = render({box(0, 0, 20, 20, 20, 1)}, o);
	o.lighting = false;
	auto flat = render({box(0, 0, 20, 20, 20, 1)}, o);
	std::vector<uint32_t> lit_colours, flat_colours;
	for (size_t i = 0; i < lit.size(); i += 4) {
		if (lit[i + 3]) lit_colours.push_back(lit[i] | lit[i + 1] << 8 | lit[i + 2] << 16);
		if (flat[i + 3]) flat_colours.push_back(flat[i] | flat[i + 1] << 8 | flat[i + 2] << 16);
	}
	std::sort(lit_colours.begin(), lit_colours.end());
	std::sort(flat_colours.begin(), flat_colours.end());
	lit_colours.erase(std::unique(lit_colours.begin(), lit_colours.end()), lit_colours.end());
	flat_colours.erase(std::unique(flat_colours.begin(), flat_colours.end()), flat_colours.end());
	CHECK(lit_colours.size() >= 2);
	CHECK_EQ(flat_colours.size(), size_t(1));
}

TEST("pick pictures fill each object with its id") {
	Options o;
	o.width = o.height = 256;
	o.view = View::Top;
	o.pick = true;
	o.plate = {0, 0, 256, 256};
	auto px = render({box(20, 20, 40, 40, 10, 0x030201), box(180, 180, 40, 40, 10, 7)}, o);
	auto at = [&](int x, int y) { return &px[(static_cast<size_t>(y) * 256 + x) * 4]; };
	// Top view: plate y grows upwards, the picture's rows downwards.
	const uint8_t *a = at(40, 256 - 40), *b = at(200, 256 - 200), *none = at(128, 128);
	CHECK(a[0] == 1 && a[1] == 2 && a[2] == 3 && a[3] == 0xFF);
	CHECK(b[0] == 7 && b[1] == 0 && b[2] == 0 && b[3] == 0xFF);
	CHECK(none[3] == 0);
}

TEST("encodes a PNG with valid chunks") {
	std::vector<uint8_t> px(4 * 4 * 4, 0x80);
	std::string png = encode_png(px, 4, 4);
	CHECK(png.compare(0, 8, "\x89PNG\r\n\x1a\n") == 0);
	CHECK(png.compare(12, 4, "IHDR") == 0);
	CHECK(png.compare(24, 5, std::string("\x08\x06\x00\x00\x00", 5)) == 0);
	CHECK(png.compare(29, 4, "\xa9\xf1\x9e\x7e") == 0); // CRC of the 4 × 4 RGBA IHDR
	CHECK(png.find("IDAT") != std::string::npos);
	CHECK(png.compare(png.size() - 8, 4, "IEND") == 0);
}

TEST("writes PNG files to UTF-8 directories and names") {
	namespace fs = std::filesystem;
	const auto suffix = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
	const fs::path dir = fs::temp_directory_path() / fs::u8path(u8"printlab-é-印刷-" + suffix);
	fs::create_directories(dir);
	struct Cleanup {
		fs::path path;
		~Cleanup() { std::error_code ec; fs::remove_all(path, ec); }
	} cleanup{dir};
	const fs::path path = dir / fs::u8path(u8"aperçu-模型.png");
	Options options;
	options.width = options.height = 8;
	CHECK(write_png(path.u8string(), {}, options));
	CHECK(fs::exists(path));
	std::ifstream file(path, std::ios::binary);
	char signature[8]{};
	file.read(signature, sizeof(signature));
	CHECK(std::memcmp(signature, "\x89PNG\r\n\x1a\n", sizeof(signature)) == 0);
}

CHECK_MAIN
