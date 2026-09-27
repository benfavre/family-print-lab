// origin: BambuStudio src/BambuStudio.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// origin: BambuStudio src/slic3r/GUI/PartPlate.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// origin: BambuStudio src/slic3r/GUI/Plater.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// Slicing one plate the way BambuStudio.cpp does it per plate (~6880-7300 at the pin): the plate's
// config over the project's, filament_map filled for the extruders, Print::apply, validate, process
// with a status callback, export_gcode with a GCodeProcessorResult, then the G-code checks it reports.
// Progress comes from Print's status callback; $/cancel calls Print::cancel().
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <fstream>
#include <thread>

#include <boost/filesystem.hpp>

#include "libslic3r/Exception.hpp"
#include "libslic3r/Color.hpp"
#include "libslic3r/FlushVolCalc.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/ProjectTask.hpp"
#include "upstream.hpp"
#include "facade/flush.hpp"
#include "facade/slice_config.hpp"

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

// BambuStudio.cpp 3823–3920, with Plater.cpp get_min_flush_volumes: projects assembled from
// presets have no correctly sized purge matrix yet. Keep a supplied matrix; otherwise use the
// upstream colour/material calculator, nozzle volume and long-retraction rules for each nozzle.
void prepare_flush_volumes(DynamicPrintConfig &config, int extruders) {
	const auto *colours = config.option<ConfigOptionStrings>("filament_colour");
	config.option<ConfigOptionFloats>("flush_multiplier", true)->values.resize(extruders, 1.0);
	config.option<ConfigOptionFloats>("flush_multiplier_fast", true)->values.resize(extruders, 1.2);
	if (!colours || colours->values.empty()) return;
	const size_t count = colours->values.size();
	auto &matrix = config.option<ConfigOptionFloats>("flush_volumes_matrix", true)->values;
	if (count == 1) {
		matrix.assign(extruders, 0.);
		return;
	}
	if (matrix.size() == count * count * extruders) return;
	std::vector<ColorRGBA> rgba(count);
	for (size_t i = 0; i < count; ++i)
		if (!decode_color(colours->values[i], rgba[i]))
			throw EngineError(err::INVALID_CONFIG, "Choose a valid filament colour.", "", "filament_colour");
	const auto *support = config.option<ConfigOptionBools>("filament_is_support");
	const auto *ids = config.option<ConfigOptionStrings>("filament_ids");
	const auto *volume = config.option<ConfigOptionFloatsNullable>("nozzle_volume");
	const auto *level = config.option<ConfigOptionInt>("enable_long_retraction_when_cut");
	const auto *machine_on = config.option<ConfigOptionBoolsNullable>("long_retractions_when_cut");
	const auto *machine_length = config.option<ConfigOptionFloatsNullable>("retraction_distances_when_cut");
	const auto *filament_on = config.option<ConfigOptionBoolsNullable>("filament_long_retractions_when_cut");
	const auto *filament_length = config.option<ConfigOptionFloatsNullable>("filament_retraction_distances_when_cut");
	const auto *datasets = config.option<ConfigOptionIntsNullable>("nozzle_flush_dataset");
	const auto *types = config.option<ConfigOptionEnumsGeneric>("extruder_type");
	const auto *volumes = config.option<ConfigOptionEnumsGeneric>("nozzle_volume_type");
	matrix.assign(count * count * extruders, 0);
	for (int nozzle = 0; nozzle < extruders; ++nozzle) {
		const auto extruder_type = ExtruderType(types ? flush::value(types->values, nozzle, int(etDirectDrive)) : int(etDirectDrive));
		const auto volume_type = NozzleVolumeType(volumes ? flush::value(volumes->values, nozzle, int(nvtStandard)) : int(nvtStandard));
		int dataset_index = nozzle;
		if (config.has("printer_extruder_variant") && config.has("printer_extruder_id") &&
		    !config.option<ConfigOptionInts>("printer_extruder_id")->values.empty())
			dataset_index = config.get_index_for_extruder(nozzle + 1, "printer_extruder_id",
				extruder_type, volume_type, "printer_extruder_variant");
		const size_t printer_index = dataset_index < 0 ? static_cast<size_t>(nozzle) : static_cast<size_t>(dataset_index);
		int dataset = datasets ? flush::value(datasets->values, printer_index, 0) : 0;
		if (dataset == ConfigOptionIntsNullable::nil_value()) dataset = 0;
		for (size_t from = 0; from < count; ++from) {
			// Raw projects may keep more than one variant per filament. Resolved bundles already
			// have one entry per filament, so retain that entry if the requested variant is absent.
			int filament_index = -1;
			if (config.has("filament_extruder_variant") && config.has("filament_self_index") &&
			    !config.option<ConfigOptionInts>("filament_self_index")->values.empty())
				filament_index = config.get_index_for_extruder(from + 1, "filament_self_index",
					extruder_type, volume_type, "filament_extruder_variant");
			const size_t fi = filament_index < 0 ? from : static_cast<size_t>(filament_index);
			int minimum;
			try {
				minimum = flush::minimum(volume ? flush::value(volume->values, printer_index, 0.) : 0.,
					level && level->value, level && level->value == EnableFilament,
					machine_on ? flush::value(machine_on->values, printer_index, static_cast<unsigned char>(0)) : 0,
					machine_length ? flush::value(machine_length->values, printer_index, 18.) : 18.,
					filament_on ? flush::value(filament_on->values, fi, static_cast<unsigned char>(255)) : 255,
					filament_length ? flush::value(filament_length->values, fi, std::nan("")) : std::nan(""));
			} catch (const std::invalid_argument &e) {
				throw EngineError(err::INVALID_CONFIG, e.what(), "", "flush_volumes_matrix");
			}
			FlushVolCalculator calculator(minimum, g_max_flush_volume, dataset);
			for (size_t to = 0; to < count; ++to) {
				if (from == to) continue;
				const auto &a = rgba[from], &b = rgba[to];
				const bool to_support = support && flush::value(support->values, to, static_cast<unsigned char>(0));
				int amount = to_support ? g_flush_volume_to_support : calculator.calc_flush_vol(
					ids && from < ids->values.size() ? ids->values[from] : "", ids && to < ids->values.size() ? ids->values[to] : "",
					a.a_uchar(), a.r_uchar(), a.g_uchar(), a.b_uchar(), b.a_uchar(), b.r_uchar(), b.g_uchar(), b.b_uchar());
				if (support && flush::value(support->values, from, static_cast<unsigned char>(0)) && !to_support)
					amount = std::max(g_min_flush_volume_from_support, amount);
				matrix[nozzle * count * count + from * count + to] = amount;
			}
		}
	}
}

// The CLI's auto-map input (6910–6944): four virtual AMS slots per extruder. These describe
// slicing choices, not a connected printer; the app checks the physical trays when sending.
void prepare_filament_grouping(Print &print, DynamicPrintConfig &config, int extruders) {
	const auto *mode = config.option<ConfigOptionEnum<FilamentMapMode>>("filament_map_mode");
	if (extruders < 2 || !mode || !is_auto_filament_map_mode(mode->value)) return;
	const auto *colours = config.option<ConfigOptionStrings>("filament_colour");
	const auto *types = config.option<ConfigOptionStrings>("filament_type");
	const auto *support = config.option<ConfigOptionBools>("filament_is_support");
	std::vector<std::vector<DynamicPrintConfig>> filaments(extruders);
	int index = 0;
	for (auto &slots : filaments) {
		for (int slot = 0; slot < 4; ++slot, ++index) {
			DynamicPrintConfig filament;
			filament.set_key_value("filament_colour", new ConfigOptionStrings({
				colours && !colours->values.empty() ? colours->values[index % colours->values.size()] : "#FFFFFFFF"}));
			filament.set_key_value("filament_type", new ConfigOptionStrings({
				types && !types->values.empty() ? types->values[index % types->values.size()] : "PLA"}));
			filament.set_key_value("filament_is_support", new ConfigOptionBools({
				support && !support->values.empty() ? bool(support->values[index % support->values.size()]) : false}));
			filament.set_key_value("tray_name", new ConfigOptionStrings({"A1"}));
			slots.push_back(std::move(filament));
		}
	}
	config.option<ConfigOptionStrings>("extruder_ams_count", true)->values.assign(extruders, "1#0|4#1");
	// CLI 3850–3856: GCode::do_export indexes the per-extruder matrices through these arrays.
	config.option<ConfigOptionFloats>("flush_multiplier", true)->values.resize(extruders, 1.0);
	config.option<ConfigOptionFloats>("flush_multiplier_fast", true)->values.resize(extruders, 1.2);
	print.set_extruder_filament_info(filaments);
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
	config.apply(to_config(slice_config::plate_overrides(*plate), scratch()), true);

	// filament_map: one extruder per filament, extruder 1 unless the plate says otherwise (BambuStudio.cpp ~6950).
	int filament_count = 1;
	if (auto *colours = config.option<ConfigOptionStrings>("filament_colour")) filament_count = std::max<int>(1, colours->values.size());
	std::vector<int> &maps = config.option<ConfigOptionInts>("filament_map", true)->values;
	maps.resize(filament_count, 1);
	for (size_t i = 0; i < plate->filament_maps.size() && i < maps.size(); ++i) maps[i] = plate->filament_maps[i];
	// Nozzle volume per extruder and per filament, as BambuStudio.cpp sets them before Print::apply
	// (~6948-6970): standard flow unless the printer's preset says otherwise, each filament on its
	// extruder's volume type.
	int extruders = 1;
	if (auto *n = config.option<ConfigOptionFloatsNullable>("nozzle_diameter")) extruders = std::max<int>(1, n->values.size());
	// CLI 3399: missing nozzle slots inherit the printer defaults, not always Standard.
	sync_nozzle_volume_type_to_extruder_count(config, true);
	std::vector<int> &volumes = config.option<ConfigOptionEnumsGeneric>("nozzle_volume_type", true)->values;
	volumes.resize(extruders, nvtStandard);
	std::vector<int> &volume_maps = config.option<ConfigOptionInts>("filament_volume_map", true)->values;
	slice_config::prepare_maps(maps, volume_maps, volumes, filament_count);
	restore_enum_maps(config);
	prepare_flush_volumes(config, extruders);

	Print print;
	// PartPlate::set_print supplies this before validation/export. Print's Eigen vector is
	// otherwise uninitialised, and export_gcode uses it as the processor's XY offset. Our
	// build_model already moves this plate into local coordinates, so its origin is zero.
	print.set_plate_origin(Vec3d::Zero());
	print.set_plate_index(plate_index - 1);
	prepare_filament_grouping(print, config, extruders);
	std::vector<SliceWarning> warnings;
	print.set_status_callback([&](const PrintBase::SlicingStatus &s) {
		if (s.flags & (PrintBase::SlicingStatus::UPDATE_PRINT_STEP_WARNINGS | PrintBase::SlicingStatus::UPDATE_PRINT_OBJECT_STEP_WARNINGS)) {
			if (!s.text.empty()) warnings.push_back({"SLICER", s.text, "", plate_index});
			return;
		}
		if (s.percent >= 0) progress({stage_for(s.percent), s.percent, s.text});
	});
	std::string printer_model;
	if (auto *m = config.option<ConfigOptionString>("printer_model")) printer_model = m->value;
	const bool bbl_printer = printer_model.compare(0, 9, "Bambu Lab") == 0;
	// Calibration projects (calib.cpp): upstream's per-layer changes and the PA pattern's G-code.
	Calib_Params calib_params;
	apply_calib(*state, *result->model, config, bbl_printer, calib_params);
	print.set_calib_params(calib_params);
	print.apply(*result->model, config);
	StringObjectException warning;
	StringObjectException error = print.validate(&warning);
	if (!error.string.empty()) throw EngineError(err::INVALID_CONFIG, error.string, error.string);
	if (!warning.string.empty()) warnings.push_back({"VALIDATE", warning.string, "", plate_index});
	if (print.empty()) throw EngineError(err::NOTHING_TO_SLICE, "Nothing on this plate is inside the printable area.");

	print.set_BBL_Printer(bbl_printer);
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
		// BambuStudio.cpp 7095–7102: the grouping pass chooses the actual maps. Keep them with
		// the sliced plate so export metadata agrees with the tool changes in its G-code.
		if (is_auto_filament_map_mode(print.get_filament_map_mode())) {
			config.option<ConfigOptionInts>("filament_map", true)->values = print.get_filament_maps();
			config.option<ConfigOptionInts>("filament_volume_map", true)->values = print.get_filament_volume_maps();
		}
		if (print.get_filament_map_mode() != fmmNozzleManual)
			config.option<ConfigOptionInts>("filament_nozzle_map", true)->values = print.get_filament_nozzle_maps();
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
	result->stats.objects = object_stats(*result);
	result->stats.warnings = warnings;
	result->config = config;
	state->sliced[plate_index] = result;
	progress({"gcode", 100, "Sliced."});
	return result->stats;
}

} // namespace printlab::upstream
