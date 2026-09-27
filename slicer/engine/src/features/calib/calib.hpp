// Calibration tests (the slicer-calibration package): what each test prints and how, as plain
// recipes. OrcaSlicer's Calibration menu (AGPL-3.0; generators by the OrcaSlicer authors, several
// first written for SuperSlicer and PrusaSlicer forks) set these up in its GUI; Bambu Studio took the
// same generators into libslic3r (Calib.cpp, GCode.cpp's per-layer changes) and its own GUI
// (Plater.cpp calib_*). The engine has no GUI, so the set-up steps are ported here as data: the test
// model, the settings each test changes, where the model is cut, and the value printed at each height
// or on each block. facade/upstream/calib.cpp applies a recipe to libslic3r (loads the model, cuts it,
// sets Print::set_calib_params); nothing here names an upstream type.
//
// origin: BambuStudio src/slic3r/GUI/Plater.cpp (calib_pa, _calib_pa_pattern, _calib_pa_tower,
//   calib_flowrate, calib_temp, calib_max_vol_speed, calib_retraction, calib_VFA) and
//   src/slic3r/GUI/calib_dlg.cpp (ranges and defaults) @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// origin: OrcaSlicer src/slic3r/GUI/Plater.cpp (adjust_settings_for_flowrate_calib, calib_flowrate:
//   the linear "YOLO" flow test) @ 8500fcdccaa10b5099ac20d252af3a7c560046f1 (v2.4.2)
#pragma once

#include <string>
#include <vector>

#include "facade/types.hpp"

namespace printlab::calib {

/** The tests, as the protocol names them (capability `calib.<name>`). */
enum class Kind { FlowRate, PaLine, PaPattern, PaTower, TempTower, Retraction, MaxVolumetric, Vfa };

/** Upstream's CalibMode (libslic3r/Calib.hpp), which Print::set_calib_params takes. */
enum class Mode { None, PaLine, PaPattern, PaTower, FlowRate, TempTower, VolSpeedTower, VfaTower, RetractionTower };

const std::vector<Kind> &all_kinds();
const char *kind_name(Kind k);
/** Throws EngineError(INVALID_PARAMS) for a name that is not a test. */
Kind kind_from(const std::string &name);
std::string capability(Kind k);

struct Request {
	Kind kind = Kind::FlowRate;
	double start = 0, end = 0, step = 0;
	/** Flow rate: 1 coarse, 2 fine. */
	int pass = 1;
	/** Flow rate: OrcaSlicer's linear ("YOLO") test instead of the two-pass one. */
	bool linear = false;
	/** PA line: print the value beside each line. */
	bool print_numbers = true;
};

/** What a recipe needs from the resolved presets (first extruder / first filament). */
struct Inputs {
	double nozzle = 0.4;
	double layer_height = 0.2;
	double first_layer_height = 0.2;
	double line_width = 0.42;
	double flow_ratio = 0.98;
	double max_volumetric = 0;
	double internal_solid_speed = 0;
	double top_surface_speed = 0;
	std::string wall_generator;
};

/** One band of the printed test: the value printed there, and where it is. */
struct Step {
	double value = 0;
	/** Heights (mm) for towers; 0, 0 for tests laid out side by side. */
	double z_min = 0, z_max = 0;
	/** The printed label or object name ("flowrate_m5", "0.020"). */
	std::string label;
};

struct Recipe {
	std::string title;
	/** Under the resources directory ("calib/…"). */
	std::string resource;
	/** Our own resource (slicer/engine/resources) rather than Bambu Studio's. */
	bool own_resource = false;
	/** Over the whole project: printer, process and filament keys. A plain value fills every entry of a per-extruder or per-filament list. */
	ConfigMap config;
	/** On every object. */
	ConfigMap object_config;
	double scale_x = 1, scale_y = 1, scale_z = 1;
	/** Shrink the model's width to fit the bed (max volumetric speed). */
	bool fit_bed_x = false;
	/** Cut the model: keep what is below `keep_below` and above `drop_below` (0: no cut). */
	double keep_below = 0, drop_below = 0;
	/** Raise the printer's max_layer_height to at least this (0: leave it). */
	double min_max_layer_height = 0;
	/** Set filament_flush_volumetric_speed from the real max before max volumetric speed is raised. */
	bool keep_flush_speed = false;
	/** Flow rate: each object's print_flow_ratio from its name ("flowrate_m5", "flowrate_0.01"). */
	bool flow_from_names = false;
	bool flow_linear = false;
	/** PA pattern: the engine draws the pattern and prints a small handle cube (sizes from upstream). */
	bool pa_pattern = false;
	Mode mode = Mode::None;
	/** Print::set_calib_params values (max volumetric speed: converted to mm/s by the facade). */
	double start = 0, end = 0, step = 0;
	bool print_numbers = false;
	std::vector<Step> steps;
};

/** The recipe for a request. Throws EngineError(INVALID_PARAMS) with plain words for bad ranges. */
Recipe recipe(const Request &request, const Inputs &in);

/** "flowrate_m5" → -5, "flowrate_0.01" → 0.01 (the name's number; `m` is minus). NaN when not one. */
double flow_modifier(const std::string &object_name);
/** The flow ratio an object prints with: current × (1 + m/100), or current + m for the linear test. */
double flow_ratio_for(double current, double modifier, bool linear);

/** Rounded-rectangle extrusion cross-section (Flow::mm3_per_mm in upstream's Flow.cpp for non-bridges). */
double mm3_per_mm(double width, double height);

} // namespace printlab::calib
