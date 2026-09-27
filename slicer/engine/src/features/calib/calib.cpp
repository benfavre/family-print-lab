// Calibration recipes; see calib.hpp for where each comes from. Values are written the way preset
// files write them (enums by key, booleans "0"/"1") so the facade loads them with upstream's own
// config reader.
//
// origin: BambuStudio src/slic3r/GUI/Plater.cpp, src/slic3r/GUI/calib_dlg.cpp @
//   926a7192574bcb9b3a732e1ec59a46d79cb45466
// origin: OrcaSlicer src/slic3r/GUI/Plater.cpp @ 8500fcdccaa10b5099ac20d252af3a7c560046f1 (v2.4.2)
#include "calib.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#include "facade/facade.hpp"

namespace printlab::calib {

namespace {

constexpr double EPSILON = 1e-4; // upstream's EPSILON (libslic3r.h), used to cut just above a block's top

[[noreturn]] void bad(const std::string &message, const std::string &key = {}) {
	throw EngineError(err::INVALID_PARAMS, message, message, key);
}

std::string num(double v) {
	char buf[32];
	std::snprintf(buf, sizeof buf, "%.6g", v);
	return buf;
}

/** "0.020" for PA values, "215" for temperatures: as many decimals as the step needs. */
std::string label(double v, double step) {
	int decimals = 0;
	for (double s = std::fabs(step); decimals < 4 && std::fabs(s - std::round(s)) > 1e-9; s *= 10) ++decimals;
	char buf[32];
	std::snprintf(buf, sizeof buf, "%.*f", decimals, v);
	return buf;
}

void need_range(const Request &r, double min_start, const char *what) {
	if (!(r.step > 0)) bad(std::string("The ") + what + " step must be more than 0.", "step");
	if (r.start < min_start) bad(std::string("The start ") + what + " must be at least " + num(min_start) + ".", "start");
	if (r.end < r.start + r.step) bad(std::string("The end ") + what + " must be at least start + step.", "end");
}

/** Bands of `height` mm, one per value from start to end (towers). */
std::vector<Step> bands(double start, double step, int count, double z0, double height) {
	std::vector<Step> out;
	for (int i = 0; i < count; ++i) {
		double v = start + i * step;
		out.push_back({v, z0 + i * height, z0 + (i + 1) * height, label(v, step)});
	}
	return out;
}

/** The values side by side (PA line and pattern). */
std::vector<Step> values(double start, double step, int count) {
	std::vector<Step> out;
	for (int i = 0; i < count; ++i) out.push_back({start + i * step, 0, 0, label(start + i * step, step)});
	return out;
}

Recipe flow_rate(const Request &r, const Inputs &in) {
	if (r.pass != 1 && r.pass != 2) bad("The flow rate test has a first and a second pass.", "pass");
	Recipe out;
	out.mode = Mode::FlowRate;
	out.flow_from_names = true;
	out.flow_linear = r.linear;
	const double nd = in.nozzle;
	// The models are made for a 0.4 nozzle: z scales to a set number of layers; x and y only grow, for
	// nozzles of 0.8 and up (both Plater.cpp's).
	const double layer = nd / 2.0;
	const double first = std::max(in.first_layer_height, layer);
	const double xy = nd / 0.6;
	if (xy > 1.2) out.scale_x = out.scale_y = xy;
	ConfigMap &o = out.object_config;
	if (r.linear) {
		// OrcaSlicer's YOLO test: 10 layers (2 bottom, 3 sparse, 5 top) of a 2 mm model.
		out.title = r.pass == 2 ? "Flow rate test (YOLO, perfectionist)" : "Flow rate test (YOLO)";
		out.resource = r.pass == 2 ? "calib/filament_flow/Orca-LinearFlow_fine.3mf" : "calib/filament_flow/Orca-LinearFlow.3mf";
		out.own_resource = true;
		out.scale_z = (first + 9 * layer) / 2;
		// Keep the fastest block within the filament's max volumetric speed.
		double widest = in.flow_ratio + (r.pass == 2 ? 0.035 : 0.05);
		double cap = in.max_volumetric > 0 ? in.max_volumetric / (mm3_per_mm(nd * 1.2, layer) * widest / in.flow_ratio)
		                                   : std::numeric_limits<double>::infinity();
		o["internal_solid_infill_speed"] = num(std::floor(std::min(in.internal_solid_speed, cap)));
		o["top_surface_speed"] = num(std::floor(std::min(in.top_surface_speed, cap)));
		o["wall_loops"] = std::string("1");
		o["bottom_shell_layers"] = std::string("2");
		o["top_shell_thickness"] = std::string("0");
	} else {
		out.title = r.pass == 2 ? "Flow rate test, pass 2" : "Flow rate test, pass 1";
		out.resource = r.pass == 2 ? "calib/filament_flow/flowrate-test-pass2.3mf" : "calib/filament_flow/flowrate-test-pass1.3mf";
		out.scale_z = (first + 6 * layer) / 1.4;
		// CalibUtils.cpp generate_max_speed_parameter_value: the preset's speed, capped by max volumetric speed.
		double cap = in.max_volumetric > 0 ? in.max_volumetric / mm3_per_mm(in.line_width, in.layer_height)
		                                   : std::numeric_limits<double>::infinity();
		o["internal_solid_infill_speed"] = num(std::floor(std::min(in.internal_solid_speed, cap)));
		o["top_surface_speed"] = num(std::floor(std::min(in.top_surface_speed, cap)));
		o["wall_loops"] = std::string("3");
		o["top_area_threshold"] = std::string("100%");
		o["bottom_shell_layers"] = std::string("1");
		o["filter_out_gap_fill"] = std::string("0");
	}
	o["top_one_wall_type"] = std::string("topmost");
	o["sparse_infill_density"] = std::string("35%");
	o["top_shell_layers"] = std::string("5");
	o["detect_thin_wall"] = std::string("1");
	o["sparse_infill_pattern"] = std::string("zig-zag");
	o["top_surface_line_width"] = num(nd * 1.2);
	o["internal_solid_infill_line_width"] = num(nd * 1.2);
	o["top_surface_pattern"] = std::string("monotonic");
	o["infill_direction"] = std::string("45");
	o["ironing_type"] = std::string("no ironing");
	o["top_solid_infill_flow_ratio"] = std::string("1");
	out.config["layer_height"] = num(layer);
	out.config["initial_layer_print_height"] = num(first);
	out.config["reduce_crossing_wall"] = std::string("1");
	out.config["enable_wrapping_detection"] = std::string("0");
	return out;
}

Recipe pa(const Request &r, const Inputs &in) {
	if (!(r.step > 0)) bad("The PA step must be more than 0.", "step");
	if (r.start < 0) bad("The start PA must be 0 or more.", "start");
	if (r.end <= r.start) bad("The end PA must be more than the start PA.", "end");
	Recipe out;
	out.start = r.start;
	out.end = r.end;
	out.step = r.step;
	out.config["enable_wrapping_detection"] = std::string("0");
	switch (r.kind) {
	case Kind::PaLine: {
		// GCode.cpp draws the lines instead of the placeholder model: ceil((end - start) / step) + 1 of them.
		out.title = "Pressure advance test (lines)";
		out.resource = "calib/pressure_advance/pressure_advance_test.stl";
		out.mode = Mode::PaLine;
		out.print_numbers = r.print_numbers;
		int count = static_cast<int>(std::llround(std::ceil((r.end - r.start) / r.step))) + 1;
		if (count > 60) bad("That is more than 60 lines. Narrow the range or use a bigger step.", "end");
		out.steps = values(r.start, r.step, count);
		break;
	}
	case Kind::PaPattern: {
		// Calib.cpp CalibPressureAdvancePattern draws it as custom G-code over a handle cube;
		// SuggestedConfigCalibPAPattern's settings (Calib.hpp) for a pattern that measures well.
		out.title = "Pressure advance test (pattern)";
		out.mode = Mode::PaPattern;
		out.pa_pattern = true;
		out.print_numbers = true;
		int count = static_cast<int>(std::ceil((r.end - r.start) / r.step + 1));
		out.steps = values(r.start, r.step, count);
		out.config["initial_layer_print_height"] = num(std::abs(in.nozzle - 0.2) < 1e-6 ? 0.2 : 0.25);
		out.config["layer_height"] = std::string("0.2");
		out.config["initial_layer_speed"] = std::string("30");
		out.config["line_width"] = num(in.nozzle * 112.5 / 100);
		out.config["initial_layer_line_width"] = num(in.nozzle * 140 / 100);
		out.config["skirt_loops"] = std::string("0");
		out.config["wall_loops"] = std::string("3");
		out.config["brim_type"] = std::string("no_brim");
		// CalibUtils.cpp update_speed_parameter: outer walls as fast as max volumetric speed allows.
		if (in.max_volumetric > 0) out.config["outer_wall_speed"] = num(std::floor(in.max_volumetric / mm3_per_mm(in.line_width, 0.2)));
		break;
	}
	default: {
		// One millimetre per value: GCode.cpp sets start + int(z) × step at each layer change.
		out.title = "Pressure advance test (tower)";
		out.resource = "calib/pressure_advance/tower_with_seam.stl";
		out.mode = Mode::PaTower;
		int count = static_cast<int>(std::ceil((r.end - r.start) / r.step)) + 1;
		out.keep_below = count;
		out.steps = bands(r.start, r.step, count, 0, 1);
		out.config["slow_down_layer_time"] = std::string("1");
		if (in.wall_generator == "arachne") out.config["wall_transition_angle"] = std::string("25");
		out.object_config["seam_position"] = std::string("back");
		break;
	}
	}
	return out;
}

Recipe temp_tower(const Request &r) {
	// calib_dlg.cpp: 180-350 °C in 5 °C steps, hottest at the bottom. The model's blocks are 10 mm, from
	// 350 °C at its foot; the facade cuts it to the range (Plater.cpp calib_temp).
	double start = std::floor(r.start / 5) * 5, end = std::floor(r.end / 5) * 5;
	if (start > 350 || end < 180 || end > start - 5)
		bad("Pick a start temperature of 350 °C or less, an end of 180 °C or more, and start at least 5 °C above the end.", "start");
	Recipe out;
	out.title = "Temperature tower";
	out.resource = "calib/temperature_tower/temperature_tower.stl";
	out.mode = Mode::TempTower;
	out.start = start;
	out.end = end;
	out.step = 5;
	long upper = std::lround((350 - end) / 5 + 1), lower = std::lround((350 - start) / 5);
	out.keep_below = upper * 10.0 + EPSILON;
	if (lower > 0) out.drop_below = lower * 10.0 + EPSILON;
	int count = static_cast<int>(std::lround((start - end) / 5)) + 1;
	out.steps = bands(start, -5, count, 0, 10);
	out.config["nozzle_temperature_initial_layer"] = num(start);
	out.config["nozzle_temperature"] = num(start);
	out.config["enable_wrapping_detection"] = std::string("0");
	out.object_config["brim_type"] = std::string("outer_only");
	out.object_config["brim_width"] = std::string("5");
	out.object_config["brim_object_gap"] = std::string("0");
	return out;
}

/** The shared set-up of the two speed towers (vase mode, one wall, max volumetric speed out of the way). */
void speed_tower(Recipe &out, const char *brim) {
	out.keep_flush_speed = true;
	out.config["filament_max_volumetric_speed"] = std::string("200");
	out.config["slow_down_layer_time"] = std::string("0");
	out.config["enable_overhang_speed"] = std::string("0");
	out.config["enable_height_slowdown"] = std::string("0");
	out.config["timelapse_type"] = std::string("0");
	out.config["wall_loops"] = std::string("1");
	out.config["top_shell_layers"] = std::string("0");
	out.config["bottom_shell_layers"] = std::string("1");
	out.config["sparse_infill_density"] = std::string("0%");
	out.config["spiral_mode"] = std::string("1");
	out.config["enable_wrapping_detection"] = std::string("0");
	out.object_config["brim_type"] = std::string(brim);
	out.object_config["brim_width"] = std::string("3");
	out.object_config["brim_object_gap"] = std::string("0");
}

Recipe max_volumetric(const Request &r, const Inputs &in) {
	need_range(r, std::numeric_limits<double>::min(), "volumetric speed");
	Recipe out;
	out.title = "Max volumetric speed test";
	out.resource = "calib/volumetric_speed/SpeedTestStructure.step";
	out.mode = Mode::VolSpeedTower;
	out.fit_bed_x = true;
	speed_tower(out, "outer_and_inner");
	const double line = in.nozzle * 1.75, layer = in.nozzle * 0.8;
	out.min_max_layer_height = layer;
	out.config["outer_wall_line_width"] = num(line);
	out.config["initial_layer_print_height"] = num(layer);
	out.config["layer_height"] = num(layer);
	out.keep_below = (r.end - r.start + 1) / r.step;
	// GCode.cpp sets the outer wall speed to start + z × step (mm/s); the facade converts these mm³/s
	// with the extrusion's cross-section and the filament's flow ratio (Plater.cpp calib_max_vol_speed).
	out.start = r.start;
	out.end = r.end;
	out.step = r.step;
	for (int z = 0; z <= static_cast<int>(out.keep_below); ++z)
		out.steps.push_back({r.start + z * r.step, double(z), double(z + 1), label(r.start + z * r.step, r.step)});
	return out;
}

Recipe vfa(const Request &r) {
	need_range(r, 10 + 1e-9, "speed");
	Recipe out;
	out.title = "VFA test";
	out.resource = "calib/vfa/VFA.stl";
	out.mode = Mode::VfaTower;
	speed_tower(out, "outer_only");
	out.start = r.start;
	out.end = r.end;
	out.step = r.step;
	// 5 mm per speed: GCode.cpp sets start + floor(z / 5) × step.
	int count = static_cast<int>(std::lround((r.end - r.start) / r.step)) + 1;
	out.keep_below = 5.0 * ((r.end - r.start) / r.step + 1);
	out.steps = bands(r.start, r.step, count, 0, 5);
	return out;
}

Recipe retraction(const Request &r) {
	need_range(r, 0, "retraction length");
	Recipe out;
	out.title = "Retraction test";
	out.resource = "calib/retraction/retraction_tower.stl";
	out.mode = Mode::RetractionTower;
	out.start = r.start;
	out.end = r.end;
	out.step = r.step;
	// 1 mm per length above a 0.4 mm base: GCode.cpp sets start + floor(max(0, z - 0.4)) × step.
	out.min_max_layer_height = 0.2;
	out.keep_below = 1.0 + 0.4 + (r.end - r.start) / r.step;
	int count = static_cast<int>(std::lround((r.end - r.start) / r.step)) + 1;
	out.steps = bands(r.start, r.step, count, 0.4, 1);
	out.config["enable_wrapping_detection"] = std::string("0");
	out.object_config["wall_loops"] = std::string("2");
	out.object_config["top_shell_layers"] = std::string("0");
	out.object_config["bottom_shell_layers"] = std::string("3");
	out.object_config["sparse_infill_density"] = std::string("0%");
	out.object_config["initial_layer_print_height"] = std::string("0.2");
	out.object_config["layer_height"] = std::string("0.2");
	return out;
}

} // namespace

const std::vector<Kind> &all_kinds() {
	static const std::vector<Kind> kinds = {Kind::FlowRate, Kind::PaLine,     Kind::PaPattern,     Kind::PaTower,
	                                        Kind::TempTower, Kind::Retraction, Kind::MaxVolumetric, Kind::Vfa};
	return kinds;
}

const char *kind_name(Kind k) {
	switch (k) {
	case Kind::FlowRate: return "flow_rate";
	case Kind::PaLine: return "pa_line";
	case Kind::PaPattern: return "pa_pattern";
	case Kind::PaTower: return "pa_tower";
	case Kind::TempTower: return "temp_tower";
	case Kind::Retraction: return "retraction";
	case Kind::MaxVolumetric: return "max_volumetric";
	case Kind::Vfa: return "vfa";
	}
	return "flow_rate";
}

Kind kind_from(const std::string &name) {
	for (Kind k : all_kinds())
		if (name == kind_name(k)) return k;
	bad("That is not a calibration test this slicer knows.", "kind");
}

std::string capability(Kind k) { return std::string("calib.") + kind_name(k); }

Recipe recipe(const Request &r, const Inputs &in) {
	if (!(in.nozzle > 0)) bad("The printer preset has no nozzle diameter.", "nozzle_diameter");
	switch (r.kind) {
	case Kind::FlowRate: return flow_rate(r, in);
	case Kind::PaLine:
	case Kind::PaPattern:
	case Kind::PaTower: return pa(r, in);
	case Kind::TempTower: return temp_tower(r);
	case Kind::Retraction: return retraction(r);
	case Kind::MaxVolumetric: return max_volumetric(r, in);
	case Kind::Vfa: return vfa(r);
	}
	bad("That is not a calibration test this slicer knows.", "kind");
}

double flow_modifier(const std::string &object_name) {
	const std::string prefix = "flowrate_";
	if (object_name.compare(0, prefix.size(), prefix) != 0 || object_name.size() == prefix.size())
		return std::numeric_limits<double>::quiet_NaN();
	std::string n = object_name.substr(prefix.size());
	if (n[0] == 'm') n[0] = '-';
	// strtod in the C locale's format: the engine never sets a locale (main.cpp), so '.' is the separator.
	char *end = nullptr;
	double v = std::strtod(n.c_str(), &end);
	return end && *end == '\0' ? v : std::numeric_limits<double>::quiet_NaN();
}

double flow_ratio_for(double current, double modifier, bool linear) {
	return linear ? current + modifier : current * (1.0 + modifier / 100.0);
}

double mm3_per_mm(double width, double height) { return height * (width - height * (1. - 0.25 * M_PI)); }

} // namespace printlab::calib
