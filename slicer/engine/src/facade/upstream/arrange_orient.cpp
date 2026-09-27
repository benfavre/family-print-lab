// Auto-orient and arrange with libslic3r's own algorithms (Orient.hpp orientation::orient,
// Arrange.hpp arrangement::arrange with the parameters BambuStudio.cpp sets up for its --arrange).
// The GUI's wipe tower reservation is adapted here; exclusion areas remain a separate follow-up.
// origin: BambuStudio src/slic3r/GUI/Jobs/ArrangeJob.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// origin: BambuStudio src/slic3r/GUI/PartPlate.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
#include <set>

#include "libslic3r/Arrange.hpp"
#include "libslic3r/GCode/WipeTower.hpp"
#include "libslic3r/ModelArrange.hpp"
#include "libslic3r/Orient.hpp"
#include "libnest2d/include/libnest2d/common.hpp"
#include "../wipe_tower.hpp"
#include "upstream.hpp"

namespace printlab::upstream {

using namespace Slic3r;

namespace {

DynamicPrintConfig plate_config(const ProjectState &state, int index, const DynamicPrintConfig &fallback,
                               const std::string &scratch) {
	for (const Plate &p : state.project.plates) {
		if (p.index != index) continue;
		DynamicPrintConfig config = state.config;
		ConfigMap overrides = p.config;
		if (!p.bed_type.empty()) overrides["curr_bed_type"] = p.bed_type;
		if (!p.print_sequence.empty()) overrides["print_sequence"] = p.print_sequence;
		if (p.spiral_vase) overrides["spiral_mode"] = std::string("1");
		config.apply(to_config(overrides, scratch), true);
		return config;
	}
	return fallback;
}

double number(const DynamicPrintConfig &config, const char *key, double fallback = 0) {
	const auto *option = config.option(key);
	return option ? option->getFloat() : fallback;
}

std::vector<double> numbers(const DynamicPrintConfig &config, const char *key) {
	// Nullable and plain floats are sibling classes with the same typed vector base.
	if (auto *v = dynamic_cast<const ConfigOptionVector<double> *>(config.option(key))) return v->values;
	return {};
}

double maximum(const DynamicPrintConfig &config, const char *key, double fallback) {
	const auto values = numbers(config, key);
	return values.empty() ? fallback : *std::max_element(values.begin(), values.end());
}

double position(const DynamicPrintConfig &config, const char *key, int plate) {
	const auto values = numbers(config, key);
	return values.empty() ? 0 : values[static_cast<size_t>(plate - 1) < values.size() ? plate - 1 : 0];
}

bool enabled(const DynamicPrintConfig &config, const char *key) {
	const auto *option = config.option(key);
	return option && option->getBool();
}

bool sequential(const DynamicPrintConfig &config) {
	const auto *option = config.option("print_sequence");
	return option && option->getInt() == static_cast<int>(PrintSequence::ByObject);
}

arrangement::ArrangePolygons wipe_towers(const ProjectState &state, int first_plate,
                                        const DynamicPrintConfig &source_config, const Model &model,
                                        const arrangement::ArrangePolygons &selected,
                                        const arrangement::ArrangeParams &params, const std::string &scratch) {
	std::vector<wipe_tower::Item> items;
	std::set<int> filaments;
	for (const auto &ap : selected) {
		wipe_tower::Item item;
		item.bed_temperature = ap.bed_temp;
		for (const auto &entry : ap.extrude_id_filament_types) item.filaments.insert(entry.first);
		filaments.insert(item.filaments.begin(), item.filaments.end());
		items.push_back(std::move(item));
	}
	double height = 0;
	for (const auto *object : model.objects)
		for (size_t i = 0; i < object->instances.size(); ++i)
			height = std::max(height, object->instance_bounding_box(i).max.z());
	arrangement::ArrangePolygons fixed;
	// Reserve on every virtual bed, as ArrangeJob does: otherwise overflow objects can occupy the
	// next plate's tower. The same material/height upper bound is safe for any subset that spills.
	for (int bed = 0; bed < MAX_NUM_PLATES; ++bed) {
		const int index = first_plate + bed;
		auto config = plate_config(state, index, source_config, scratch);
		const auto *timelapse = config.option("timelapse_type");
		if (!wipe_tower::needed(enabled(config, "enable_prime_tower"), sequential(config),
		                        timelapse && timelapse->getInt() == static_cast<int>(TimelapseType::tlSmooth),
		                        enabled(config, "enable_wrapping_detection"),
		                        params.allow_multi_materials_on_same_plate, items)) continue;
		wipe_tower::Settings s;
		s.width = number(config, "prime_tower_width");
		s.wipe_volume = maximum(config, "filament_prime_volume", 0);
		if (const auto *mode = config.option("prime_volume_mode"))
			if (mode->getInt() == static_cast<int>(pvmSaving)) s.wipe_volume = 15;
		s.layer_height = number(config, "layer_height", 0.08);
		s.infill_gap = number(config, "prime_tower_infill_gap", 100) / 100.;
		s.extruders = std::max<int>(1, numbers(config, "nozzle_diameter").size());
		s.filaments = static_cast<int>(filaments.size());
		s.filament_change_length = maximum(config, "filament_change_length", 0);
		s.filament_diameter = maximum(config, "filament_diameter", 1.75);
		s.rib_wall = enabled(config, "prime_tower_rib_wall");
		s.rib_width = number(config, "prime_tower_rib_width");
		s.extra_rib_length = number(config, "prime_tower_extra_rib_length");
		s.minimum_depth = WipeTower::get_limit_depth_by_height(static_cast<float>(height));
		s.brim = number(config, "prime_tower_brim_width");
		if (s.brim < 0) s.brim = WipeTower::get_auto_brim_by_height(static_cast<float>(height));
		s.x = position(config, "wipe_tower_x", index);
		s.y = position(config, "wipe_tower_y", index);
		const BoundingBox bounds(get_bed_shape(config));
		s.bed_min_x = unscaled<double>(bounds.min.x());
		s.bed_min_y = unscaled<double>(bounds.min.y());
		s.bed_max_x = unscaled<double>(bounds.max.x());
		s.bed_max_y = unscaled<double>(bounds.max.y());
		s.margin = WIPE_TOWER_MARGIN;
		wipe_tower::Reservation r;
		try { r = wipe_tower::estimate(s); }
		catch (const std::invalid_argument &e) { throw EngineError(err::INVALID_CONFIG, e.what(), "", "prime_tower_width"); }
		arrangement::ArrangePolygon ap;
		ap.poly.contour = Polygon({{scaled(r.min_x), scaled(r.min_y)}, {scaled(r.max_x), scaled(r.min_y)},
		                           {scaled(r.max_x), scaled(r.max_y)}, {scaled(r.min_x), scaled(r.max_y)}});
		ap.bed_idx = bed;
		ap.name = "WipeTower" + std::to_string(index);
		ap.is_virt_object = true;
		ap.is_wipe_tower = true;
		fixed.push_back(std::move(ap));
	}
	return fixed;
}

} // namespace

std::vector<Oriented> UpstreamFacade::orient(const std::string &project_id, const std::vector<std::string> &object_ids,
                                             const ProgressFn &progress, const CancelToken &cancel) {
	auto state = project(project_id);
	std::lock_guard<std::mutex> lock(state->mutex);
	std::vector<std::string> ids;
	auto model = build_model(*state, 0, &ids);
	std::vector<Oriented> out;
	for (size_t i = 0; i < model->objects.size(); ++i) {
		if (std::find(object_ids.begin(), object_ids.end(), ids[i]) == object_ids.end()) continue;
		if (cancel()) throw EngineError(err::CANCELLED, "Cancelled.");
		ModelObject *mo = model->objects[i];
		if (mo->instances.empty() || mo->volumes.empty()) continue;
		progress({"orienting", int(100 * out.size() / std::max<size_t>(1, object_ids.size())), "Finding the best way up…"});
		// orient() turns the volumes, not the instance, then centres them again (Orient.cpp orient(ModelObject*),
		// ModelObject::rotate): our parts keep their transforms, so the change goes into the instance:
		// instance' × volume' = new × volume, so new = instance' × volume' × volume⁻¹ (the same for every volume).
		// It also moves the object onto its instance's origin; like the CLI backend, keep it where it stood.
		const Transform3d volume_before = mo->volumes.front()->get_matrix();
		const Vec3d centre_before = mo->instance_bounding_box(0).center();
		orientation::orient(mo);
		mo->invalidate_bounding_box();
		const Vec3d centre_after = mo->instance_bounding_box(0).center();
		Transform3d placed = mo->instances.front()->get_matrix() * mo->volumes.front()->get_matrix() * volume_before.inverse();
		placed.pretranslate(Vec3d(centre_before.x() - centre_after.x(), centre_before.y() - centre_after.y(), 0));
		out.push_back({ids[i], from_transform3d(placed)});
	}
	return out;
}

std::vector<Arranged> UpstreamFacade::arrange(const std::string &project_id, int plate, double spacing, bool allow_rotation,
                                              const std::string & /*alignment*/, const ProgressFn &progress,
                                              const CancelToken &cancel) {
	auto state = project(project_id);
	std::lock_guard<std::mutex> lock(state->mutex);
	std::vector<int> plates;
	for (const Plate &p : state->project.plates)
		if (!p.locked && (plate == 0 || p.index == plate)) plates.push_back(p.index);
	std::vector<Arranged> out;
	for (int index : plates) {
		auto config = plate_config(*state, index, state->config, scratch());
		std::vector<std::string> instance_ids;
		auto model = build_model(*state, index, nullptr, &instance_ids);
		ModelInstancePtrs instances;
		arrangement::ArrangePolygons selected;
		for (ModelObject *mo : model->objects)
			for (ModelInstance *mi : mo->instances) {
				arrangement::ArrangePolygon ap = get_instance_arrange_poly(mi, config);
				ap.itemid = static_cast<int>(selected.size());
				selected.push_back(std::move(ap));
				instances.push_back(mi);
			}
		if (selected.empty()) continue;
		progress({"arranging", 10, "Arranging the plate…"});
		arrangement::ArrangeParams params;
		params.is_seq_print = sequential(config);
		params.cleareance_radius = number(config, "extruder_clearance_radius");
		params.nozzle_height = number(config, "nozzle_height");
		params.allow_rotations = allow_rotation;
		params.progressind = [](unsigned, std::string) {};
		params.stopcondition = [&cancel] { return cancel(); };
		arrangement::update_arrange_params(params, config, selected);
		if (spacing >= 0) params.min_obj_distance = scaled(spacing);
		arrangement::update_selected_items_inflation(selected, config, params);
		Points bed = arrangement::get_shrink_bedpts(config, params);
		auto fixed = wipe_towers(*state, index, config, *model, selected, params, scratch());
		arrangement::update_unselected_items_inflation(fixed, config, params);
		arrangement::arrange(selected, fixed, bed, params);
		if (cancel()) throw EngineError(err::CANCELLED, "Cancelled.");
		for (size_t i = 0; i < selected.size(); ++i) {
			const auto &ap = selected[i];
			if (!ap.is_arranged())
				throw EngineError(err::OUTSIDE_PLATE, "Some objects do not fit on the plate.", instance_ids[i]);
			instances[i]->apply_arrange_result(ap.translation.cast<double>(), ap.rotation);
			// Back into project coordinates; items that went to a virtual bed land on the plates after this one.
			int target = index + ap.bed_idx;
			Transform3d t = instances[i]->get_matrix();
			t.pretranslate(plate_origin(*state, target));
			const std::string &id = instance_ids[i];
			auto slash = id.find('/');
			out.push_back({id.substr(0, slash), id.substr(slash + 1), target, from_transform3d(t)});
		}
	}
	return out;
}

} // namespace printlab::upstream
