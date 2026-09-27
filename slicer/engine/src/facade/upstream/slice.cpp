// Slicing one plate the way BambuStudio.cpp does it per plate (~6880-7300 at the pin): the plate's
// config over the project's, filament_map filled for the extruders, Print::apply, validate, process
// with a status callback, export_gcode with a GCodeProcessorResult, then the G-code checks it reports.
// Progress comes from Print's status callback; $/cancel calls Print::cancel().
#include <atomic>
#include <chrono>
#include <fstream>
#include <thread>

#include <boost/filesystem.hpp>

#include "libslic3r/Exception.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/ProjectTask.hpp"
#include "upstream.hpp"

namespace printlab::upstream {

using namespace Slic3r;

namespace {

/** Our progress stages from upstream's status percentages (PrintObject steps report in this order). */
std::string stage_for(int percent) {
	if (percent < 10) return "preparing";
	if (percent < 25) return "slicing";
	if (percent < 45) return "perimeters";
	if (percent < 60) return "infill";
	if (percent < 70) return "support";
	return "gcode";
}

/** "; total layer number: N" from the G-code header (GCodeProcessor.cpp writes it). */
int layers_from_header(const std::string &gcode_file) {
	std::ifstream in(gcode_file);
	std::string line;
	for (int i = 0; i < 400 && std::getline(in, line); ++i) {
		auto at = line.find("total layer number:");
		if (at != std::string::npos) return std::atoi(line.c_str() + at + 19);
	}
	return 0;
}

} // namespace

PlateStats UpstreamFacade::slice(const std::string &project_id, int plate_index, const ProgressFn &progress,
                                 const CancelToken &cancel) {
	auto state = project(project_id);
	std::lock_guard<std::mutex> lock(state->mutex);
	const Plate *plate = nullptr;
	for (const Plate &p : state->project.plates)
		if (p.index == plate_index) plate = &p;
	if (!plate) throw EngineError(err::INVALID_PARAMS, "That plate does not exist.", std::to_string(plate_index), "plate");

	auto result = std::make_shared<PlateResult>();
	result->model = build_model(*state, plate_index, &result->object_ids);
	if (result->model->objects.empty()) throw EngineError(err::NOTHING_TO_SLICE, "There is nothing on this plate to slice.");

	DynamicPrintConfig config = state->config;
	ConfigMap plate_overrides = plate->config;
	if (!plate->bed_type.empty()) plate_overrides["curr_bed_type"] = plate->bed_type;
	if (!plate->print_sequence.empty()) plate_overrides["print_sequence"] = plate->print_sequence;
	if (plate->spiral_vase) plate_overrides["spiral_mode"] = std::string("1");
	config.apply(to_config(plate_overrides, scratch()), true);

	// filament_map: one extruder per filament, extruder 1 unless the plate says otherwise (BambuStudio.cpp ~6950).
	int filament_count = 1;
	if (auto *colours = config.option<ConfigOptionStrings>("filament_colour")) filament_count = std::max<int>(1, colours->values.size());
	std::vector<int> &maps = config.option<ConfigOptionInts>("filament_map", true)->values;
	maps.resize(filament_count, 1);
	for (size_t i = 0; i < plate->filament_maps.size() && i < maps.size(); ++i) maps[i] = plate->filament_maps[i];

	Print print;
	std::vector<SliceWarning> warnings;
	print.set_status_callback([&](const PrintBase::SlicingStatus &s) {
		if (s.flags & (PrintBase::SlicingStatus::UPDATE_PRINT_STEP_WARNINGS | PrintBase::SlicingStatus::UPDATE_PRINT_OBJECT_STEP_WARNINGS)) {
			if (!s.text.empty()) warnings.push_back({"SLICER", s.text, "", plate_index});
			return;
		}
		if (s.percent >= 0) progress({stage_for(s.percent), s.percent, s.text});
	});
	print.apply(*result->model, config);
	StringObjectException warning;
	StringObjectException error = print.validate(&warning);
	if (!error.string.empty()) throw EngineError(err::INVALID_CONFIG, error.string, error.string);
	if (!warning.string.empty()) warnings.push_back({"VALIDATE", warning.string, "", plate_index});
	if (print.empty()) throw EngineError(err::NOTHING_TO_SLICE, "Nothing on this plate is inside the printable area.");

	std::string printer_model;
	if (auto *m = config.option<ConfigOptionString>("printer_model")) printer_model = m->value;
	print.set_BBL_Printer(printer_model.compare(0, 9, "Bambu Lab") == 0);
	Model::setExtruderParams(config, filament_count);
	Model::setPrintSpeedTable(config, print.config());

	// $/cancel → Print::cancel(), which makes process() throw CanceledException.
	std::atomic<bool> done{false};
	std::thread watcher([&] {
		while (!done) {
			if (cancel()) print.cancel();
			std::this_thread::sleep_for(std::chrono::milliseconds(50));
		}
	});
	struct Join {
		std::atomic<bool> &done;
		std::thread &t;
		~Join() {
			done = true;
			t.join();
		}
	} join{done, watcher};

	boost::filesystem::path dir = boost::filesystem::path(work_dir_) / project_id;
	boost::filesystem::create_directories(dir);
	result->gcode_file = (dir / ("plate_" + std::to_string(plate_index) + ".gcode")).string();
	try {
		print.process();
		progress({"gcode", 90, "Writing the G-code…"});
		result->gcode_file = print.export_gcode(result->gcode_file, &result->gcode, nullptr);
	} catch (const CanceledException &) {
		throw EngineError(err::CANCELLED, "Slicing was cancelled.");
	} catch (const SlicingError &e) {
		throw EngineError(err::SLICE_FAILED, e.what(), e.what());
	}
	if (cancel()) throw EngineError(err::CANCELLED, "Slicing was cancelled.");

	// The G-code checks the CLI turns into errors (BambuStudio.cpp ~7184-7200).
	int check = result->gcode.gcode_check_result.error_code;
	if (check & 0b1100) throw EngineError(err::OUTSIDE_PLATE, "Part of the print goes outside the printable area.");
	if (check & 0b10000) throw EngineError(err::OUTSIDE_PLATE, "Part of the print is in the area the printer keeps clear.");
	if (check & 0b00011) throw EngineError(err::OUTSIDE_PLATE, "Part of the print is where this nozzle cannot reach.");

	const auto &mode = result->gcode.print_statistics.modes[static_cast<size_t>(PrintEstimatedStatistics::ETimeMode::Normal)];
	result->stats.plate = plate_index;
	result->stats.seconds = mode.time;
	result->stats.layers = layers_from_header(result->gcode_file);
	result->total_weight = print.print_statistics().total_weight;
	result->support_used = print.is_support_used();
	PlateData used;
	used.parse_filament_info(&result->gcode);
	for (const FilamentInfo &f : used.slice_filaments_info) result->stats.filaments.push_back({f.id + 1, f.used_g, f.used_m});
	result->stats.warnings = warnings;
	result->config = config;
	state->sliced[plate_index] = result;
	progress({"gcode", 100, "Sliced."});
	return result->stats;
}

} // namespace printlab::upstream
