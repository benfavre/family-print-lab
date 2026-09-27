// The printable .gcode.3mf, written by upstream's own exporter (store_bbs_3mf) with the plate data
// Bambu Studio fills for "Export plate sliced file" (Plater::export_3mf with SaveStrategy Silence |
// SplitModel | WithGcode | SkipModel, PartPlateList::store_to_3mf_structure): G-code, prediction,
// weight, filaments, printer_model_id and nozzle_diameters. Plate pictures come from files (the
// client's, or ours from features/thumbnails); the exporter copies them in when no GL render exists.
#include <algorithm>
#include <boost/filesystem.hpp>
#include <cctype>
#include <cstdlib>
#include <iomanip>
#include <sstream>

#include "features/thumbnails/thumbnails.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/ProjectTask.hpp"
#include "rpc/json.hpp"
#include "upstream.hpp"

namespace printlab::upstream {

using namespace Slic3r;
namespace fs = boost::filesystem;

namespace {

/** "#RRGGBB[AA]" as RGBA; anything else (a user's odd colour) keeps the default orange rather than throwing. */
std::array<uint8_t, 4> parse_colour(const std::string &hex) {
	std::array<uint8_t, 4> c{0xEB, 0x81, 0x43, 0xFF};
	if (hex.size() < 7 || hex[0] != '#' || !std::all_of(hex.begin() + 1, hex.begin() + 7, [](char ch) { return std::isxdigit(static_cast<unsigned char>(ch)) != 0; }))
		return c;
	for (int i = 0; i < 3; ++i) c[i] = static_cast<uint8_t>(std::strtol(hex.substr(1 + 2 * i, 2).c_str(), nullptr, 16));
	return c;
}

/** The plate's objects as thumbnail meshes, in plate coordinates, in their filament colours. */
std::vector<thumbnails::Mesh> plate_meshes(const PlateResult &r) {
	std::vector<thumbnails::Mesh> out;
	const auto *colours = r.config.option<ConfigOptionStrings>("filament_colour");
	for (size_t oi = 0; oi < r.model->objects.size(); ++oi) {
		const ModelObject *mo = r.model->objects[oi];
		for (const ModelInstance *mi : mo->instances) {
			thumbnails::Mesh m;
			m.pick_id = static_cast<uint32_t>(oi + 1);
			for (const ModelVolume *v : mo->volumes) {
				if (!v->is_model_part()) continue;
				int extruder = v->config.has("extruder") ? v->config.opt_int("extruder") : 0;
				if (extruder <= 0 && mo->config.has("extruder")) extruder = mo->config.opt_int("extruder");
				if (colours && !colours->values.empty())
					m.color = parse_colour(colours->values[std::min<size_t>(std::max(extruder, 1) - 1, colours->values.size() - 1)]);
				TriangleMesh tm = v->mesh();
				tm.transform(mi->get_matrix() * v->get_matrix(), true);
				for (const auto &f : tm.its.indices)
					for (int k = 0; k < 3; ++k) {
						const auto &p = tm.its.vertices[f[k]];
						m.triangles.insert(m.triangles.end(), {p.x(), p.y(), p.z()});
					}
			}
			out.push_back(std::move(m));
		}
	}
	return out;
}

std::string printer_model_id(const ProjectState &state, PresetBundle *bundle) {
	auto it = state.project.extras.find("printer_model_id");
	if (it != state.project.extras.end() && !it->second.empty()) return it->second;
	// Preset::get_printer_type: the vendor model whose name is the preset's printer_model.
	std::string model;
	if (auto *m = state.config.option<ConfigOptionString>("printer_model")) model = m->value;
	if (bundle)
		for (const auto &vendor : bundle->vendors)
			for (const auto &vm : vendor.second.models)
				if (vm.name == model) return vm.model_id;
	return "";
}

} // namespace

ExportResult UpstreamFacade::export_gcode3mf(const std::string &project_id, const std::vector<int> &plates_in,
                                             const std::string &path, const std::vector<PlateImages> &images,
                                             bool engine_images) {
	auto state = project(project_id);
	std::lock_guard<std::mutex> lock(state->mutex);
	std::vector<int> plates = plates_in;
	if (plates.empty())
		for (const auto &kv : state->sliced) plates.push_back(kv.first);
	if (plates.empty()) throw EngineError(err::EXPORT_FAILED, "Slice a plate first.");
	for (int p : plates)
		if (!state->sliced.count(p)) throw EngineError(err::EXPORT_FAILED, "Slice plate " + std::to_string(p) + " first.");

	// One model for the file: every plate's objects (each plate's at the bed origin, as sliced; the
	// geometry is not stored with SkipModel), plate data pointing at them by index.
	Model model;
	PlateDataPtrs plate_data;
	PresetBundle *presets = nullptr;
	try {
		presets = &bundle("");
	} catch (const EngineError &) {
	}
	std::string model_id = printer_model_id(*state, presets);
	std::string nozzles;
	if (auto *n = state->config.option("nozzle_diameter")) nozzles = n->serialize();
	fs::path dir = fs::path(work_dir_) / project_id;
	for (int index : plates) {
		PlateResult &r = *state->sliced.at(index);
		auto *pd = new PlateData();
		pd->plate_index = index - 1;
		for (const Plate &p : state->project.plates)
			if (p.index == index) pd->plate_name = p.name, pd->locked = p.locked;
		for (size_t oi = 0; oi < r.model->objects.size(); ++oi) {
			int obj_idx = static_cast<int>(model.objects.size());
			ModelObject *copy = model.add_object(*r.model->objects[oi]);
			for (size_t ii = 0; ii < copy->instances.size(); ++ii) pd->objects_and_instances.emplace_back(obj_idx, static_cast<int>(ii));
		}
		pd->gcode_file = r.gcode_file;
		pd->is_sliced_valid = true;
		pd->gcode_prediction = std::to_string(static_cast<int>(r.stats.seconds));
		if (r.total_weight != 0.0) {
			std::ostringstream w;
			w.imbue(std::locale::classic());
			w << std::fixed << std::setprecision(2) << r.total_weight;
			pd->gcode_weight = w.str();
		}
		pd->toolpath_outside = r.gcode.toolpath_outside;
		pd->timelapse_warning_code = r.gcode.timelapse_warning_code;
		pd->is_label_object_enabled = r.gcode.label_object_enabled;
		pd->is_support_used = r.support_used;
		pd->parse_filament_info(&r.gcode);
		pd->printer_model_id = model_id;
		pd->nozzle_diameters = nozzles;
		const auto *types = r.config.option<ConfigOptionStrings>("filament_type");
		const auto *colours = r.config.option<ConfigOptionStrings>("filament_colour");
		const auto *ids = r.config.option<ConfigOptionStrings>("filament_ids");
		for (FilamentInfo &f : pd->slice_filaments_info) {
			f.type = types ? types->get_at(f.id) : "PLA";
			f.color = colours ? colours->get_at(f.id) : "#FFFFFF";
			f.filament_id = ids ? ids->get_at(f.id) : "";
		}
		pd->config.apply(r.config, true);

		// Pictures: the client's files, else ours.
		const PlateImages *given = nullptr;
		for (const PlateImages &im : images)
			if (im.plate == index) given = &im;
		std::string base = (dir / ("plate_" + std::to_string(index))).string();
		if (given) {
			pd->thumbnail_file = given->thumbnail;
			pd->no_light_thumbnail_file = given->no_light.empty() ? given->thumbnail : given->no_light;
			pd->top_file = given->top;
			pd->pick_file = given->pick;
		} else if (engine_images) {
			auto meshes = plate_meshes(r);
			thumbnails::Options o;
			thumbnails::write_png(pd->thumbnail_file = base + ".png", meshes, o);
			o.lighting = false;
			thumbnails::write_png(pd->no_light_thumbnail_file = base + "_no_light.png", meshes, o);
			BoundingBoxf bed;
			if (auto *area = r.config.option<ConfigOptionPoints>("printable_area"))
				for (const Vec2d &p : area->values) bed.merge(p);
			thumbnails::Options top;
			top.view = thumbnails::View::Top;
			if (bed.defined) top.plate = {bed.min.x(), bed.min.y(), bed.max.x(), bed.max.y()};
			thumbnails::write_png(pd->top_file = base + "_top.png", meshes, top);
			top.pick = true;
			thumbnails::write_png(pd->pick_file = base + "_pick.png", meshes, top);
		}
		plate_data.push_back(pd);
	}

	StoreParams params;
	params.path = path.c_str();
	params.model = &model;
	params.plate_data_list = plate_data;
	params.export_plate_idx = plates.size() == 1 ? plates.front() - 1 : -1;
	DynamicPrintConfig config = state->sliced.at(plates.front())->config;
	params.config = &config;
	params.strategy = SaveStrategy::Silence | SaveStrategy::SplitModel | SaveStrategy::WithGcode | SaveStrategy::SkipModel |
	                  SaveStrategy::Zip64;
	bool ok = false;
	try {
		ok = store_bbs_3mf(params);
	} catch (const std::exception &e) {
		release_PlateData_list(plate_data);
		throw EngineError(err::EXPORT_FAILED, "The sliced file could not be written.", e.what());
	}
	ExportResult out;
	out.path = path;
	for (size_t i = 0; i < plate_data.size(); ++i) {
		const PlateData *pd = plate_data[i];
		const PlateResult &r = *state->sliced.at(plates[i]);
		SlicedPlate sp;
		sp.index = plates[i];
		sp.gcode = "Metadata/plate_" + std::to_string(plates[i]) + ".gcode";
		sp.md5 = pd->gcode_file_md5;
		sp.minutes = std::max(1, static_cast<int>(std::lround(r.stats.seconds / 60.0)));
		sp.grams = std::round(r.total_weight * 10) / 10;
		sp.layers = r.stats.layers;
		sp.supports = r.support_used;
		for (const FilamentInfo &f : pd->slice_filaments_info)
			sp.filaments.push_back({f.id + 1, f.type, f.color, f.used_g, f.used_m, 0});
		out.plates.push_back(sp);
	}
	release_PlateData_list(plate_data);
	if (!ok) throw EngineError(err::EXPORT_FAILED, "The sliced file could not be written.", path);
	return out;
}

} // namespace printlab::upstream
