#include <cmath>
#include <string>

#include "check.hpp"
#include "facade/facade.hpp"
#include "features/calib/calib.hpp"

using namespace printlab;
using namespace printlab::calib;

namespace {

Request req(Kind k, double start, double end, double step) {
	Request r;
	r.kind = k;
	r.start = start;
	r.end = end;
	r.step = step;
	return r;
}

std::string value(const ConfigMap &m, const std::string &key) {
	auto it = m.find(key);
	if (it == m.end()) return "(missing)";
	const auto *s = std::get_if<std::string>(&it->second);
	return s ? *s : "(list)";
}

bool throws_invalid(const Request &r) {
	try {
		recipe(r, Inputs{});
	} catch (const EngineError &e) {
		return e.code == err::INVALID_PARAMS;
	}
	return false;
}

} // namespace

TEST("every test has a protocol name and a capability, and names read back") {
	CHECK_EQ(all_kinds().size(), size_t(8));
	for (Kind k : all_kinds()) {
		CHECK(calib::kind_from(calib::kind_name(k)) == k);
		CHECK_EQ(capability(k), std::string("calib.") + calib::kind_name(k));
	}
	bool threw = false;
	try {
		calib::kind_from("warp_speed");
	} catch (const EngineError &) {
		threw = true;
	}
	CHECK(threw);
}

TEST("flow modifiers come from the object names") {
	CHECK_EQ(flow_modifier("flowrate_m5"), -5.0);
	CHECK_EQ(flow_modifier("flowrate_20"), 20.0);
	CHECK_EQ(flow_modifier("flowrate_0.005"), 0.005);
	CHECK_EQ(flow_modifier("flowrate_m0.035"), -0.035);
	CHECK(std::isnan(flow_modifier("cube")));
	CHECK(std::isnan(flow_modifier("flowrate_")));
	CHECK(std::isnan(flow_modifier("flowrate_x1")));
	CHECK(std::fabs(flow_ratio_for(0.98, -5, false) - 0.931) < 1e-9);
	CHECK(std::fabs(flow_ratio_for(0.98, 0.02, true) - 1.0) < 1e-9);
}

TEST("flow rate pass 1 scales to seven layers and sets the test's settings") {
	Inputs in;
	in.nozzle = 0.4;
	in.first_layer_height = 0.2;
	in.max_volumetric = 21;
	in.internal_solid_speed = 250;
	in.top_surface_speed = 200;
	in.line_width = 0.42;
	in.layer_height = 0.2;
	Recipe r = recipe(req(Kind::FlowRate, 0, 0, 0), in);
	CHECK_EQ(r.resource, std::string("calib/filament_flow/flowrate-test-pass1.3mf"));
	CHECK(r.mode == Mode::FlowRate);
	CHECK(r.flow_from_names && !r.flow_linear);
	CHECK(std::fabs(r.scale_z - (0.2 + 6 * 0.2) / 1.4) < 1e-9);
	CHECK_EQ(r.scale_x, 1.0);
	CHECK_EQ(value(r.object_config, "wall_loops"), std::string("3"));
	CHECK_EQ(value(r.object_config, "top_one_wall_type"), std::string("topmost"));
	CHECK_EQ(value(r.config, "layer_height"), std::string("0.2"));
	// 21 mm³/s over a 0.42 × 0.2 line: 21 / (0.2 × (0.42 − 0.2 × (1 − π/4))) ≈ 266 → the preset's 250 stays.
	CHECK_EQ(value(r.object_config, "internal_solid_infill_speed"), std::string("250"));
	CHECK_EQ(value(r.object_config, "top_surface_speed"), std::string("200"));
}

TEST("flow rate on a 0.8 nozzle grows in x and y too; the YOLO test uses Orca's model") {
	Inputs in;
	in.nozzle = 0.8;
	in.first_layer_height = 0.2;
	Request r2 = req(Kind::FlowRate, 0, 0, 0);
	r2.pass = 2;
	Recipe fine = recipe(r2, in);
	CHECK_EQ(fine.resource, std::string("calib/filament_flow/flowrate-test-pass2.3mf"));
	CHECK(std::fabs(fine.scale_x - 0.8 / 0.6) < 1e-9);
	Request yolo = req(Kind::FlowRate, 0, 0, 0);
	yolo.linear = true;
	Recipe y = recipe(yolo, Inputs{});
	CHECK(y.own_resource);
	CHECK_EQ(y.resource, std::string("calib/filament_flow/Orca-LinearFlow.3mf"));
	CHECK(y.flow_linear);
	CHECK(std::fabs(y.scale_z - (0.2 + 9 * 0.2) / 2) < 1e-9);
	Request bad = req(Kind::FlowRate, 0, 0, 0);
	bad.pass = 3;
	CHECK(throws_invalid(bad));
}

TEST("PA line: one line per value, numbers optional") {
	Request r = req(Kind::PaLine, 0, 0.1, 0.002);
	r.print_numbers = false;
	Recipe out = recipe(r, Inputs{});
	CHECK(out.mode == Mode::PaLine);
	CHECK_EQ(out.steps.size(), size_t(51));
	CHECK_EQ(out.steps.front().label, std::string("0.000"));
	CHECK_EQ(out.steps.back().label, std::string("0.100"));
	CHECK(!out.print_numbers);
	CHECK(throws_invalid(req(Kind::PaLine, 0, 1, 0.001)));
	CHECK(throws_invalid(req(Kind::PaLine, 0.1, 0.05, 0.01)));
}

TEST("PA pattern uses upstream's suggested settings for the nozzle") {
	Inputs in;
	in.nozzle = 0.2;
	in.max_volumetric = 12;
	in.line_width = 0.22;
	Recipe out = recipe(req(Kind::PaPattern, 0, 0.08, 0.005), in);
	CHECK(out.pa_pattern);
	CHECK_EQ(out.steps.size(), size_t(17));
	CHECK_EQ(value(out.config, "initial_layer_print_height"), std::string("0.2"));
	CHECK_EQ(value(out.config, "line_width"), std::string("0.225"));
	CHECK_EQ(value(out.config, "initial_layer_line_width"), std::string("0.28"));
	CHECK_EQ(value(out.config, "wall_loops"), std::string("3"));
	CHECK_EQ(value(out.config, "brim_type"), std::string("no_brim"));
	CHECK(value(out.config, "outer_wall_speed") != "(missing)");
}

TEST("PA tower: a millimetre per value, cut to the range") {
	Inputs in;
	in.wall_generator = "arachne";
	Recipe out = recipe(req(Kind::PaTower, 0, 0.1, 0.002), in);
	CHECK(out.mode == Mode::PaTower);
	CHECK_EQ(out.keep_below, 51.0);
	CHECK_EQ(out.steps.size(), size_t(51));
	CHECK_EQ(out.steps[10].z_min, 10.0);
	CHECK(std::fabs(out.steps[10].value - 0.02) < 1e-12);
	CHECK_EQ(value(out.config, "wall_transition_angle"), std::string("25"));
	CHECK_EQ(value(out.object_config, "seam_position"), std::string("back"));
}

TEST("temperature tower: 10 mm blocks from the start temperature down, cut at both ends") {
	Recipe out = recipe(req(Kind::TempTower, 230, 190, 5), Inputs{});
	CHECK(out.mode == Mode::TempTower);
	CHECK_EQ(out.steps.size(), size_t(9));
	CHECK_EQ(out.steps.front().value, 230.0);
	CHECK_EQ(out.steps.back().value, 190.0);
	CHECK_EQ(out.steps[1].z_min, 10.0);
	// (350 − 190) / 5 + 1 = 33 blocks kept from the model's foot, the lowest (350 − 230) / 5 = 24 dropped.
	CHECK(std::fabs(out.keep_below - 330.0) < 0.01);
	CHECK(std::fabs(out.drop_below - 240.0) < 0.01);
	CHECK_EQ(value(out.config, "nozzle_temperature"), std::string("230"));
	CHECK(throws_invalid(req(Kind::TempTower, 360, 300, 5)));
	CHECK(throws_invalid(req(Kind::TempTower, 200, 200, 5)));
	CHECK(throws_invalid(req(Kind::TempTower, 200, 170, 5)));
}

TEST("speed towers: vase mode, max volumetric out of the way, cut to the range") {
	Recipe mv = recipe(req(Kind::MaxVolumetric, 5, 20, 0.5), Inputs{});
	CHECK(mv.mode == Mode::VolSpeedTower);
	CHECK(mv.keep_flush_speed && mv.fit_bed_x);
	CHECK_EQ(value(mv.config, "spiral_mode"), std::string("1"));
	CHECK_EQ(value(mv.config, "filament_max_volumetric_speed"), std::string("200"));
	CHECK(std::fabs(mv.keep_below - 32.0) < 1e-9);
	CHECK(std::fabs(mv.min_max_layer_height - 0.32) < 1e-9);
	CHECK(throws_invalid(req(Kind::MaxVolumetric, 0, 20, 0.5)));
	Recipe v = recipe(req(Kind::Vfa, 40, 200, 10), Inputs{});
	CHECK(v.mode == Mode::VfaTower);
	CHECK_EQ(v.steps.size(), size_t(17));
	CHECK_EQ(v.keep_below, 85.0);
	CHECK_EQ(v.steps[2].z_min, 10.0);
	CHECK(throws_invalid(req(Kind::Vfa, 10, 200, 10)));
}

TEST("retraction tower: 1 mm per length above a 0.4 mm base") {
	Recipe out = recipe(req(Kind::Retraction, 0, 2, 0.1), Inputs{});
	CHECK(out.mode == Mode::RetractionTower);
	CHECK_EQ(out.steps.size(), size_t(21));
	CHECK(std::fabs(out.keep_below - 21.4) < 1e-9);
	CHECK(std::fabs(out.steps[3].z_min - 3.4) < 1e-9);
	CHECK_EQ(out.steps[3].label, std::string("0.3"));
	CHECK_EQ(value(out.object_config, "layer_height"), std::string("0.2"));
	CHECK(throws_invalid(req(Kind::Retraction, 0, 0.05, 0.1)));
}

CHECK_MAIN
