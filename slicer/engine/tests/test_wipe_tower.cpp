#include <limits>

#include "check.hpp"
#include "facade/wipe_tower.hpp"

using namespace printlab::wipe_tower;

namespace {
Settings settings() {
	Settings s;
	s.width = 40;
	s.wipe_volume = 80;
	s.layer_height = 0.2;
	s.infill_gap = 1;
	s.filaments = 2;
	s.rib_wall = false;
	s.minimum_depth = 5;
	s.brim = 3;
	s.bed_max_x = s.bed_max_y = 256;
	s.x = s.y = 100;
	s.margin = 15;
	return s;
}

bool invalid(const Settings &s) {
	try { estimate(s); }
	catch (const std::invalid_argument &) { return true; }
	return false;
}
} // namespace

TEST("only compatible multi-filament plates, painted parts or support materials need a tower") {
	const std::vector<Item> one = {{{1}, 60}};
	const std::vector<Item> mixed = {{{1}, 60}, {{2}, 60}};
	CHECK(!needed(true, false, false, false, true, one));
	CHECK(needed(true, false, false, false, true, mixed));
	CHECK(!needed(true, false, false, false, false, mixed));
	CHECK(!needed(true, false, false, false, true, {{{1}, 60}, {{2}, 100}}));
	CHECK(needed(true, false, false, false, false, {{{1, 2}, 60}}));
	CHECK(!needed(false, false, true, true, true, mixed));
	CHECK(!needed(true, true, true, true, true, mixed));
}

TEST("smooth timelapse and wrapping detection reserve a single-filament tower") {
	CHECK(needed(true, false, true, false, true, {{{1}, 60}}));
	CHECK(needed(true, false, false, true, true, {{{1}, 60}}));
	CHECK(!needed(true, false, true, true, true, {}));
	auto s = settings();
	s.filaments = 1;
	s.minimum_depth = 20;
	auto r = estimate(s);
	CHECK_EQ(r.max_y - r.min_y, 26.);
}

TEST("reserves volume-based depth and the brim on all four sides") {
	auto r = estimate(settings());
	CHECK_EQ(r.min_x, 97.);
	CHECK_EQ(r.max_x, 143.);
	CHECK_EQ(r.min_y, 97.);
	CHECK_EQ(r.max_y, 113.);
}

TEST("dual extruders include both priming and filament change volume") {
	auto s = settings();
	s.extruders = 2;
	s.filament_change_length = 8;
	s.filament_diameter = 2;
	auto r = estimate(s);
	// Two 80 mm³ prime volumes plus one 8 mm length of 2 mm filament: 160 + 8*pi mm³.
	CHECK(std::abs((r.max_y - r.min_y) - (26. + std::acos(-1.))) < 1e-8);
}

TEST("tall ribbed towers reserve their complete square, not just the configured width") {
	auto s = settings();
	s.rib_wall = true;
	s.rib_width = 8;
	s.extra_rib_length = 4;
	s.minimum_depth = 60;
	auto r = estimate(s);
	const double expected = 64 + 8 / std::sqrt(2.) + 6;
	CHECK(std::abs(r.max_x - r.min_x - expected) < 1e-8);
	CHECK(std::abs(r.max_y - r.min_y - expected) < 1e-8);
	// Shortening ribs cannot shrink below the volume required to prime both materials.
	s.extra_rib_length = -100;
	r = estimate(s);
	CHECK(r.max_y - r.min_y >= 26.);
}

TEST("clips requested positions to bed bounds and keeps the brim inside") {
	auto s = settings();
	s.x = -100;
	s.y = 1000;
	s.bed_min_x = 10;
	s.bed_min_y = 20;
	s.brim = 20;
	auto r = estimate(s);
	CHECK_EQ(r.min_x, 10.);
	CHECK_EQ(r.max_y, 241.);
	CHECK(r.min_y >= 20.);
}

TEST("invalid or oversized towers fail before an inverted clamp or non-finite polygon") {
	auto s = settings();
	s.width = 1000;
	CHECK(invalid(s));
	s = settings();
	s.layer_height = 0;
	CHECK(invalid(s));
	s = settings();
	s.wipe_volume = std::numeric_limits<double>::infinity();
	CHECK(invalid(s));
	s = settings();
	s.brim = -1;
	CHECK(invalid(s));
}

CHECK_MAIN
