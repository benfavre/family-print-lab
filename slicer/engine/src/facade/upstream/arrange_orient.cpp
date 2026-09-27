// Auto-orient and arrange with libslic3r's own algorithms (Orient.hpp orientation::orient,
// Arrange.hpp arrangement::arrange with the parameters BambuStudio.cpp sets up for its --arrange).
// Bambu Studio's CLI prepares arrangement through the GUI's PartPlateList; the plate-level extras it
// adds there (wipe tower placeholder, exclusion areas) are not applied here yet.
#include "libslic3r/Arrange.hpp"
#include "libslic3r/ModelArrange.hpp"
#include "libslic3r/Orient.hpp"
#include "upstream.hpp"

namespace printlab::upstream {

using namespace Slic3r;

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
		if ((plate == 0 && !p.locked) || p.index == plate) plates.push_back(p.index);
	std::vector<Arranged> out;
	for (int index : plates) {
		std::vector<std::string> instance_ids;
		auto model = build_model(*state, index, nullptr, &instance_ids);
		ModelInstancePtrs instances;
		arrangement::ArrangePolygons selected;
		for (ModelObject *mo : model->objects)
			for (ModelInstance *mi : mo->instances) {
				arrangement::ArrangePolygon ap = get_instance_arrange_poly(mi, state->config);
				ap.itemid = static_cast<int>(selected.size());
				selected.push_back(std::move(ap));
				instances.push_back(mi);
			}
		if (selected.empty()) continue;
		progress({"arranging", 10, "Arranging the plate…"});
		arrangement::ArrangeParams params;
		params.allow_rotations = allow_rotation;
		params.progressind = [](unsigned, std::string) {};
		params.stopcondition = [&cancel] { return cancel(); };
		arrangement::update_arrange_params(params, state->config, selected);
		if (spacing >= 0) params.min_obj_distance = scaled(spacing);
		arrangement::update_selected_items_inflation(selected, state->config, params);
		Points bed = arrangement::get_shrink_bedpts(state->config, params);
		arrangement::arrange(selected, {}, bed, params);
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
