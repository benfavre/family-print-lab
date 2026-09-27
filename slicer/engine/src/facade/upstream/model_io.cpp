// Meshes and the project model: files read with upstream's own readers (Model::read_from_file:
// STL, OBJ, 3MF, STEP), and our Project turned into a libslic3r Model the way bbs_3mf.cpp builds one
// from a project file (volumes with their matrices, per-volume and per-object config, painting).
#include <cmath>

#include "libslic3r/Format/bbs_3mf.hpp"
#include "upstream.hpp"

namespace printlab::upstream {

using namespace Slic3r;

MeshInfo UpstreamFacade::mesh_put(const std::string &mesh_id, const std::string &path, const std::string &format) {
	if (format != "stl" && format != "obj" && format != "3mf" && format != "step")
		throw EngineError(err::UNSUPPORTED_FORMAT, "That file type cannot be sliced.", format);
	Model model;
	try {
		DynamicPrintConfig config;
		ConfigSubstitutionContext subs(ForwardCompatibilitySubstitutionRule::EnableSilent);
		model = Model::read_from_file(path, &config, &subs, LoadStrategy::AddDefaultInstances | LoadStrategy::LoadModel);
	} catch (const std::exception &e) {
		throw EngineError(err::FILE_READ, "That model file could not be read.", e.what());
	}
	auto entry = std::make_shared<MeshEntry>();
	// Every volume of every object, in its object's coordinates (volume matrices applied).
	for (const ModelObject *o : model.objects)
		for (const ModelVolume *v : o->volumes) {
			if (!v->is_model_part()) continue;
			TriangleMesh m = v->mesh();
			m.transform(v->get_matrix(), true);
			entry->mesh.merge(m);
		}
	if (entry->mesh.empty()) throw EngineError(err::FILE_READ, "That model file has no shapes in it.", path);
	const TriangleMeshStats &stats = entry->mesh.stats();
	BoundingBoxf3 bb = entry->mesh.bounding_box();
	entry->info.mesh_id = mesh_id;
	entry->info.triangles = entry->mesh.facets_count();
	entry->info.bbox = {bb.min.x(), bb.min.y(), bb.min.z(), bb.max.x(), bb.max.y(), bb.max.z()};
	entry->info.edges_fixed = stats.repaired_errors.edges_fixed;
	entry->info.facets_removed = stats.repaired_errors.facets_removed;
	entry->info.facets_reversed = stats.repaired_errors.facets_reversed;
	std::lock_guard<std::mutex> lock(mutex_);
	meshes_[mesh_id] = entry;
	return entry->info;
}

void UpstreamFacade::mesh_drop(const std::vector<std::string> &mesh_ids) {
	std::lock_guard<std::mutex> lock(mutex_);
	for (const auto &id : mesh_ids) meshes_.erase(id);
}

const MeshEntry &UpstreamFacade::mesh(const Project &project, const std::string &mesh_id) {
	{
		std::lock_guard<std::mutex> lock(mutex_);
		auto it = meshes_.find(mesh_id);
		if (it != meshes_.end()) return *it->second;
	}
	// Not put yet, but the project names a file for it.
	auto file = project.meshes.find(mesh_id);
	if (file == project.meshes.end() || file->second.path.empty())
		throw EngineError(err::MESH_NOT_FOUND, "A shape in the project is missing.", mesh_id, "mesh");
	std::string ext = file->second.path.substr(file->second.path.find_last_of('.') + 1);
	for (auto &c : ext) c = static_cast<char>(std::tolower(c));
	mesh_put(mesh_id, file->second.path, ext == "stp" ? "step" : ext);
	std::lock_guard<std::mutex> lock(mutex_);
	return *meshes_.at(mesh_id);
}

namespace {

ModelVolumeType volume_type(PartType t) {
	switch (t) {
	case PartType::Model: return ModelVolumeType::MODEL_PART;
	case PartType::Negative: return ModelVolumeType::NEGATIVE_VOLUME;
	case PartType::Modifier: return ModelVolumeType::PARAMETER_MODIFIER;
	case PartType::SupportBlocker: return ModelVolumeType::SUPPORT_BLOCKER;
	case PartType::SupportEnforcer: return ModelVolumeType::SUPPORT_ENFORCER;
	}
	return ModelVolumeType::MODEL_PART;
}

void paint(FacetsAnnotation &facets, const std::map<int, std::string> &data) {
	if (data.empty()) return;
	// bbs_3mf.cpp reads paint_* attributes per triangle with set_triangle_from_string.
	for (const auto &kv : data) facets.set_triangle_from_string(kv.first, kv.second);
	facets.shrink_to_fit();
}

/** PrusaSlicer/Bambu Studio's grid of plates: columns = ceil-ish sqrt of the plate count (PartPlateList::compute_colum_count). */
int plate_columns(int count) {
	float value = std::sqrt(static_cast<float>(count));
	float round_value = std::round(value);
	return static_cast<int>(value > round_value ? round_value + 1 : round_value);
}

} // namespace

Vec3d UpstreamFacade::plate_origin(const ProjectState &state, int index) const {
	// Plate size from printable_area; stride = size × (1 + 1/5) (PartPlate.cpp LOGICAL_PART_PLATE_GAP).
	BoundingBoxf bed;
	if (auto *area = state.config.option<ConfigOptionPoints>("printable_area"))
		for (const Vec2d &p : area->values) bed.merge(p);
	double w = bed.defined ? bed.size().x() : 256, d = bed.defined ? bed.size().y() : 256;
	int cols = plate_columns(std::max<int>(1, static_cast<int>(state.project.plates.size())));
	int i = index - 1, row = i / cols, col = i % cols;
	return Vec3d(col * w * (1. + 1. / 5.), -row * d * (1. + 1. / 5.), 0);
}

std::unique_ptr<Model> UpstreamFacade::build_model(const ProjectState &state, int plate, std::vector<std::string> *object_ids,
                                                   std::vector<std::string> *instance_ids) {
	auto model = std::make_unique<Model>();
	const Project &p = state.project;
	const Plate *only = nullptr;
	if (plate > 0) {
		for (const Plate &pl : p.plates)
			if (pl.index == plate) only = &pl;
		if (!only) throw EngineError(err::INVALID_PARAMS, "That plate does not exist.", std::to_string(plate), "plate");
	}
	Vec3d shift = only ? Vec3d(-plate_origin(state, plate)) : Vec3d(Vec3d::Zero());
	for (const SceneObject &o : p.objects) {
		std::vector<const Instance *> instances;
		for (const Instance &in : o.instances) {
			bool on_plate = !only;
			if (only)
				for (const PlateRef &r : only->instances)
					if (r.object_id == o.id && r.instance_id == in.id) on_plate = true;
			if (on_plate) instances.push_back(&in);
		}
		if (instances.empty()) continue;
		ModelObject *mo = model->add_object();
		mo->name = o.name;
		mo->printable = o.printable;
		mo->config.assign_config(to_config(o.config, scratch()));
		for (const Part &part : o.parts) {
			TriangleMesh mesh = this->mesh(p, part.mesh).mesh;
			ModelVolume *v = mo->add_volume(std::move(mesh), volume_type(part.type), false);
			v->name = part.name;
			v->set_transformation(to_transform3d(part.transform));
			v->config.assign_config(to_config(part.config, scratch()));
			if (part.filament > 0) v->config.set("extruder", part.filament);
			paint(v->supported_facets, part.paint_supports);
			paint(v->seam_facets, part.paint_seam);
			paint(v->mmu_segmentation_facets, part.paint_color);
			paint(v->fuzzy_skin_facets, part.paint_fuzzy_skin);
		}
		for (const HeightRange &r : o.height_ranges) {
			ModelConfig &cfg = mo->layer_config_ranges[{r.min_z, r.max_z}];
			cfg.assign_config(to_config(r.config, scratch()));
		}
		if (!o.layer_height_profile.empty()) mo->layer_height_profile.set(o.layer_height_profile);
		for (const Instance *in : instances) {
			ModelInstance *mi = mo->add_instance();
			Transform3d t = to_transform3d(in->transform);
			t.pretranslate(shift);
			mi->set_transformation(Geometry::Transformation(t));
			mi->printable = in->printable;
			if (instance_ids) instance_ids->push_back(o.id + "/" + in->id);
		}
		if (object_ids) object_ids->push_back(o.id);
	}
	return model;
}

} // namespace printlab::upstream
