// Calibration tests as projects: a features/calib recipe applied the way Bambu Studio's Plater.cpp
// calib_* functions apply it in the GUI (load the test model, scale and cut it, change the settings,
// Print::set_calib_params), then held as an ordinary open project that slices and exports like any
// other. The per-layer changes themselves are upstream's (GCode.cpp reads the calib params at each
// layer change; Calib.cpp draws the PA line and pattern).
//
// origin: BambuStudio src/slic3r/GUI/Plater.cpp (calib_pa ~20342, _calib_pa_pattern ~20383,
//   _calib_pa_tower ~20466, calib_flowrate ~20529, calib_temp ~20639, calib_max_vol_speed ~20704,
//   calib_retraction ~20807, calib_VFA ~20866) @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
#include <algorithm>
#include <cmath>
#include <cstdlib>

#include <boost/filesystem.hpp>

#include "libslic3r/Format/STL.hpp"
#include "libslic3r/TriangleMeshSlicer.hpp"
#include "upstream.hpp"

namespace printlab::upstream {

using namespace Slic3r;
namespace fs = boost::filesystem;

namespace {

/** A config value's first entry as a number (per-extruder and per-filament lists hold text). */
double first_number(const DynamicPrintConfig &c, const std::string &key, double fallback) {
	const ConfigOption *o = c.option(key);
	if (!o) return fallback;
	std::string text;
	if (o->is_vector()) {
		auto list = static_cast<const ConfigOptionVectorBase *>(o)->vserialize();
		if (list.empty()) return fallback;
		text = list[0];
	} else
		text = o->serialize();
	char *end = nullptr;
	double v = std::strtod(text.c_str(), &end);
	return end == text.c_str() ? fallback : v;
}

std::string first_text(const DynamicPrintConfig &c, const std::string &key) {
	const ConfigOption *o = c.option(key);
	if (!o) return {};
	if (!o->is_vector()) return o->serialize();
	auto list = static_cast<const ConfigOptionVectorBase *>(o)->vserialize();
	return list.empty() ? std::string() : list[0];
}

/**
 * A recipe's plain values in the shape the config has: a per-extruder or per-filament list gets the
 * value in every entry (the GUI's set_config_values does the same). Keys this version does not know
 * are left out rather than failing the whole test.
 */
ConfigMap shaped(const ConfigMap &values, const DynamicPrintConfig &config) {
	ConfigMap out;
	for (const auto &kv : values) {
		if (!print_config_def.get(kv.first)) continue;
		const ConfigOption *o = config.option(kv.first);
		const std::string *v = std::get_if<std::string>(&kv.second);
		if (o && o->is_vector() && v)
			out[kv.first] = std::vector<std::string>(std::max<size_t>(1, static_cast<const ConfigOptionVectorBase *>(o)->size()), *v);
		else
			out[kv.first] = kv.second;
	}
	return out;
}

std::vector<std::string> list_of(const DynamicPrintConfig &c, const std::string &key) {
	const ConfigOption *o = c.option(key);
	if (!o) return {};
	return o->is_vector() ? static_cast<const ConfigOptionVectorBase *>(o)->vserialize() : std::vector<std::string>{o->serialize()};
}

std::string num(double v) {
	char buf[32];
	std::snprintf(buf, sizeof buf, "%.6g", v);
	return buf;
}

CalibMode to_upstream(calib::Mode m) {
	switch (m) {
	case calib::Mode::PaLine: return CalibMode::Calib_PA_Line;
	case calib::Mode::PaPattern: return CalibMode::Calib_PA_Pattern;
	case calib::Mode::PaTower: return CalibMode::Calib_PA_Tower;
	case calib::Mode::FlowRate: return CalibMode::Calib_Flow_Rate;
	case calib::Mode::TempTower: return CalibMode::Calib_Temp_Tower;
	case calib::Mode::VolSpeedTower: return CalibMode::Calib_Vol_speed_Tower;
	case calib::Mode::VfaTower: return CalibMode::Calib_VFA_Tower;
	case calib::Mode::RetractionTower: return CalibMode::Calib_Retraction_tower;
	case calib::Mode::None: break;
	}
	return CalibMode::Calib_None;
}

[[noreturn]] void too_large() {
	// Plater.cpp's own words for this case.
	throw EngineError(err::INVALID_PARAMS,
	                  "The current settings produce a model that is too large. Narrow the range or increase the step size.",
	                  "", "end");
}

/** Keeps the part of `mesh` below z (keep_below) or above it (drop_below), as Plater.cpp's cut() does. */
TriangleMesh cut(const TriangleMesh &mesh, double z, bool keep_lower) {
	indexed_triangle_set upper, lower;
	cut_mesh(mesh.its, static_cast<float>(z), &upper, &lower);
	TriangleMesh out(keep_lower ? std::move(lower) : std::move(upper));
	if (out.empty()) too_large();
	return out;
}

struct Piece {
	std::string name;
	TriangleMesh mesh; // in plate coordinates
};

} // namespace

void UpstreamFacade::apply_calib(const ProjectState &state, Model &model, const DynamicPrintConfig &config, bool bbl_printer,
                                 Calib_Params &params) {
	if (!state.calib) return;
	params.mode = to_upstream(state.calib->mode);
	params.start = state.calib->start;
	params.end = state.calib->end;
	params.step = state.calib->step;
	params.print_numbers = state.calib->print_numbers;
	if (params.mode == CalibMode::Calib_PA_Pattern && !model.objects.empty()) {
		// Plater.cpp _calib_pa_pattern: the pattern is custom G-code on the plate, drawn from the handle
		// cube's position (the plate already sits at the origin here, see build_model).
		CalibPressureAdvancePattern pattern(params, config, bbl_printer, model, Vec3d::Zero());
		pattern.generate_custom_gcodes(config, bbl_printer, model, Vec3d::Zero());
	}
}

CalibResult UpstreamFacade::calib_generate(const calib::Request &request, const PresetSelection &selection,
                                           const ResolvedBundle &presets, const std::string &bed_type) {
	DynamicPrintConfig base = project_config(presets.full, {});
	calib::Inputs in;
	in.nozzle = first_number(base, "nozzle_diameter", 0.4);
	in.layer_height = first_number(base, "layer_height", 0.2);
	in.first_layer_height = first_number(base, "initial_layer_print_height", 0.2);
	try {
		in.line_width = base.get_abs_value("line_width", in.nozzle);
	} catch (const std::exception &) {
		in.line_width = in.nozzle * 1.05;
	}
	if (!(in.line_width > 0)) in.line_width = in.nozzle * 1.05;
	in.flow_ratio = first_number(base, "filament_flow_ratio", 1.0);
	in.max_volumetric = first_number(base, "filament_max_volumetric_speed", 0);
	in.internal_solid_speed = first_number(base, "internal_solid_infill_speed", 100);
	in.top_surface_speed = first_number(base, "top_surface_speed", 100);
	in.wall_generator = first_text(base, "wall_generator");
	calib::Recipe recipe = calib::recipe(request, in);

	// The project's own settings: the recipe's, shaped like the presets' lists.
	ConfigMap own = shaped(recipe.config, base);
	if (recipe.keep_flush_speed) {
		// Plater.cpp: a flush speed of 0 means "use max volumetric speed", which the test raises to 200.
		auto flush = list_of(base, "filament_flush_volumetric_speed");
		auto max = list_of(base, "filament_max_volumetric_speed");
		for (size_t i = 0; i < flush.size(); ++i)
			if (std::strtod(flush[i].c_str(), nullptr) == 0 && !max.empty()) flush[i] = max[std::min(i, max.size() - 1)];
		if (!flush.empty()) own["filament_flush_volumetric_speed"] = flush;
	}
	if (recipe.min_max_layer_height > 0) {
		auto max = list_of(base, "max_layer_height");
		for (auto &v : max)
			if (std::strtod(v.c_str(), nullptr) < recipe.min_max_layer_height) v = num(recipe.min_max_layer_height);
		if (!max.empty()) own["max_layer_height"] = max;
	}
	DynamicPrintConfig config = project_config(presets.full, own);

	BoundingBoxf bed;
	if (auto *area = config.option<ConfigOptionPoints>("printable_area"))
		for (const Vec2d &p : area->values) bed.merge(p);
	if (!bed.defined) bed = BoundingBoxf(Vec2d(0, 0), Vec2d(256, 256));
	const Vec2d centre = bed.center();

	CalibState calib_state;
	calib_state.mode = recipe.mode;
	calib_state.start = recipe.start;
	calib_state.end = recipe.end;
	calib_state.step = recipe.step;
	calib_state.print_numbers = recipe.print_numbers;

	std::vector<Piece> pieces;
	if (recipe.pa_pattern) {
		// The handle cube, sized and placed from upstream's own pattern maths so the pattern is centred.
		Calib_Params params;
		params.mode = CalibMode::Calib_PA_Pattern;
		params.start = recipe.start;
		params.end = recipe.end;
		params.step = recipe.step;
		Model probe;
		ModelObject *o = probe.add_object();
		o->add_volume(make_cube(1, 1, 1));
		o->add_instance();
		CalibPressureAdvancePattern pattern(params, config, true, probe, Vec3d::Zero());
		const double side = pattern.handle_xy_size(), height = pattern.max_layer_z();
		const double min_x = centre.x() - pattern.print_size_x() / 2;
		const double max_y = centre.y() - pattern.print_size_y() / 2 - pattern.handle_spacing();
		if (min_x < bed.min.x() || max_y - side < bed.min.y() || min_x + pattern.print_size_x() > bed.max.x()) too_large();
		TriangleMesh cube = make_cube(side, side, height);
		cube.translate(static_cast<float>(min_x), static_cast<float>(max_y - side), 0);
		pieces.push_back({"PA pattern handle", std::move(cube)});
	} else {
		std::vector<fs::path> where;
		if (recipe.own_resource) {
			where.push_back(fs::path(resources_dir_) / "printlab" / recipe.resource);
#ifdef PRINTLAB_OWN_RESOURCES
			where.push_back(fs::path(PRINTLAB_OWN_RESOURCES) / recipe.resource);
#endif
		} else {
			where.push_back(fs::path(resources_dir_) / recipe.resource);
#ifdef PRINTLAB_UPSTREAM_RESOURCES
			where.push_back(fs::path(PRINTLAB_UPSTREAM_RESOURCES) / recipe.resource);
#endif
		}
		auto found = std::find_if(where.begin(), where.end(), [](const fs::path &p) { return fs::exists(p); });
		if (found == where.end())
			throw EngineError(err::FILE_READ, "This slicer is missing the model for that test. Reinstall Print Lab Slicer.",
			                  recipe.resource);
		Model model;
		try {
			const std::string file = found->string();
			if (found->extension() == ".step" || found->extension() == ".stp")
				// Bambu Studio's default meshing precision (linear 0.003, angle 0.5: STEP.hpp load_step).
				model = Model::read_from_step(file, LoadStrategy::AddDefaultInstances, nullptr, nullptr, nullptr, 0.003, 0.5, false);
			else
				model = Model::read_from_file(file, nullptr, nullptr, LoadStrategy::AddDefaultInstances | LoadStrategy::LoadModel);
		} catch (const std::exception &e) {
			throw EngineError(err::FILE_READ, "The model for that test could not be read.", e.what());
		}
		for (const ModelObject *o : model.objects) {
			Piece piece{o->name, {}};
			const Transform3d inst = o->instances.empty() ? Transform3d::Identity() : o->instances.front()->get_matrix();
			for (const ModelVolume *v : o->volumes) {
				if (!v->is_model_part()) continue;
				TriangleMesh m = v->mesh();
				m.transform(inst * v->get_matrix(), true);
				piece.mesh.merge(m);
			}
			if (!piece.mesh.empty()) pieces.push_back(std::move(piece));
		}
		if (pieces.empty()) throw EngineError(err::FILE_READ, "The model for that test is empty.", recipe.resource);

		// Scale about the origin (the objects keep their spacing), then sit the group on the bed centre.
		BoundingBoxf3 all;
		for (const Piece &p : pieces) all.merge(p.mesh.bounding_box());
		Vec3f scale(float(recipe.scale_x), float(recipe.scale_y), float(recipe.scale_z));
		if (recipe.fit_bed_x) {
			double fit = (bed.size().x() - 10) / all.size().x();
			if (fit < 1.0) scale.x() *= float(fit);
		}
		all = BoundingBoxf3();
		for (Piece &p : pieces) {
			p.mesh.scale(scale);
			all.merge(p.mesh.bounding_box());
		}
		Vec3d shift(centre.x() - all.center().x(), centre.y() - all.center().y(), -all.min.z());
		for (Piece &p : pieces) p.mesh.translate(shift.cast<float>());
		const double height = all.size().z();
		if (recipe.keep_below > 0 || recipe.drop_below > 0) {
			if (recipe.keep_below >= height || recipe.drop_below >= height) too_large();
			for (Piece &p : pieces) {
				if (recipe.keep_below > 0) p.mesh = cut(p.mesh, recipe.keep_below, true);
				if (recipe.drop_below > 0) {
					p.mesh = cut(p.mesh, recipe.drop_below, false);
					p.mesh.translate(0, 0, -static_cast<float>(recipe.drop_below));
				}
			}
		}
	}

	// Max volumetric speed: GCode.cpp takes mm/s, the test is asked in mm³/s (Plater.cpp converts with
	// the outer wall's cross-section and the filament's flow ratio).
	if (recipe.mode == calib::Mode::VolSpeedTower) {
		double per_mm = calib::mm3_per_mm(in.nozzle * 1.75, in.nozzle * 0.8) * in.flow_ratio;
		calib_state.start = recipe.start / per_mm;
		calib_state.end = recipe.end / per_mm;
		calib_state.step = recipe.step / per_mm;
	}

	// The project: one object per piece, all on plate 1.
	std::string id;
	{
		std::lock_guard<std::mutex> lock(mutex_);
		id = "p" + std::to_string(next_project_++);
	}
	fs::path dir = fs::path(work_dir_) / id / "calib";
	fs::create_directories(dir);
	CalibResult out;
	out.project_id = id;
	out.title = recipe.title;
	out.steps = recipe.steps;
	Project &project = out.project;
	project.title = recipe.title;
	project.presets = selection;
	project.project_config = own;
	std::vector<std::string> colours = list_of(config, "filament_colour"), types = list_of(config, "filament_type");
	for (size_t i = 0; i < std::max<size_t>(1, selection.filaments.size()); ++i)
		project.filaments.push_back({static_cast<int>(i) + 1, i < colours.size() ? colours[i] : "#FFFFFF",
		                             i < types.size() ? types[i] : "PLA"});
	Plate plate;
	plate.index = 1;
	plate.bed_type = bed_type;
	std::vector<calib::Step> flow_steps;
	for (size_t i = 0; i < pieces.size(); ++i) {
		Piece &p = pieces[i];
		// Each object at its own origin (x, y centred, z from 0), placed by its instance.
		BoundingBoxf3 bb = p.mesh.bounding_box();
		Vec3d at(bb.center().x(), bb.center().y(), bb.min.z());
		p.mesh.translate(-at.cast<float>());
		std::string mesh_id = "calib-" + id + "-" + std::to_string(i + 1);
		fs::path file = dir / (std::to_string(i + 1) + ".stl");
		if (!store_stl(file.string().c_str(), &p.mesh, true))
			throw EngineError(err::EXPORT_FAILED, "The test model could not be written.", file.string());
		auto entry = std::make_shared<MeshEntry>();
		entry->mesh = p.mesh;
		BoundingBoxf3 local = p.mesh.bounding_box();
		entry->info.mesh_id = mesh_id;
		entry->info.triangles = p.mesh.facets_count();
		entry->info.bbox = {local.min.x(), local.min.y(), local.min.z(), local.max.x(), local.max.y(), local.max.z()};
		{
			std::lock_guard<std::mutex> lock(mutex_);
			meshes_[mesh_id] = entry;
		}
		out.meshes[mesh_id] = entry->info;
		project.meshes[mesh_id] = {mesh_id, file.string()};

		SceneObject o;
		o.id = "o" + std::to_string(i + 1);
		o.name = p.name.empty() ? recipe.title : p.name;
		o.config = shaped(recipe.object_config, config);
		if (recipe.flow_from_names) {
			double m = calib::flow_modifier(p.name);
			if (!std::isnan(m)) {
				double ratio = calib::flow_ratio_for(in.flow_ratio, m, recipe.flow_linear);
				o.config["print_flow_ratio"] = num(ratio / in.flow_ratio);
				flow_steps.push_back({ratio, 0, 0, p.name});
			}
		}
		Part part;
		part.id = o.id + "p1";
		part.name = o.name;
		part.mesh = mesh_id;
		part.filament = 1;
		o.parts.push_back(part);
		Instance inst;
		inst.id = "i1";
		inst.transform = IDENTITY;
		inst.transform[9] = at.x();
		inst.transform[10] = at.y();
		inst.transform[11] = at.z();
		o.instances.push_back(inst);
		plate.instances.push_back({o.id, inst.id});
		project.objects.push_back(std::move(o));
	}
	project.plates.push_back(plate);
	if (recipe.flow_from_names) {
		std::sort(flow_steps.begin(), flow_steps.end(), [](const calib::Step &a, const calib::Step &b) { return a.value < b.value; });
		out.steps = flow_steps;
		out.base_flow_ratio = in.flow_ratio;
	}

	auto state = std::make_shared<ProjectState>();
	state->project = project;
	state->presets = presets;
	state->config = std::move(config);
	state->calib = calib_state;
	state->revision = 1;
	std::lock_guard<std::mutex> lock(mutex_);
	projects_[id] = state;
	return out;
}

} // namespace printlab::upstream
