// The upstream facade's internals: the only headers in this repository that name Bambu Studio types.
// Written against libslic3r at the tag in slicer/upstream.lock; when upstream's API changes, the fix
// is in facade/upstream/*.cpp and nowhere else. Each call cites the upstream code it follows.
#pragma once

#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "libslic3r/Calib.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include "libslic3r/GCode/GCodeProcessor.hpp"

#include "../facade.hpp"

namespace printlab::upstream {

// ---- convert.cpp: our types ⇄ upstream's

/** Our 12 numbers are Bambu 3MF's transform attribute: tr(r, c) for c = 0..3, r = 0..2 (bbs_3mf.cpp add_transformation). */
Slic3r::Transform3d to_transform3d(const Transform &t);
Transform from_transform3d(const Slic3r::Transform3d &m);

/**
 * A ConfigMap loaded the way upstream loads preset files: written as JSON and read back with
 * ConfigBase::load_from_json, so arrays, enums and legacy values go through upstream's own parser.
 */
Slic3r::DynamicPrintConfig to_config(const ConfigMap &map, const std::string &scratch_dir);
ConfigMap from_config(const Slic3r::ConfigBase &config);
/**
 * Points every enum-list option back at its keys. Upstream's defaults for these options are built
 * without them (PrintConfig.cpp `new ConfigOptionEnumsGeneric{…}`; Config.hpp's initializer-list
 * constructor even initialises keys_map from itself), and apply() copies values only, so a config
 * made from DynamicPrintConfig::full_print_config() crashes when G-code export serialises it. The GUI
 * never meets this: its configs always come from preset files.
 */
void restore_enum_maps(Slic3r::ConfigBase &config);

// ---- the facade

struct MeshEntry {
	Slic3r::TriangleMesh mesh;
	MeshInfo info;
};

struct PlateResult {
	std::string gcode_file;
	Slic3r::GCodeProcessorResult gcode;
	PlateStats stats;
	double total_weight = 0;
	bool support_used = false;
	/** The plate's model (only its instances), as sliced; exported with the G-code. */
	std::unique_ptr<Slic3r::Model> model;
	Slic3r::DynamicPrintConfig config;
	/** identify_id per object index in `model` (slice_info, pick image, skip objects). */
	std::vector<std::string> object_ids;
};

/** A calibration test's upstream parameters, kept across project.sync (facade/upstream/calib.cpp). */
struct CalibState {
	calib::Mode mode = calib::Mode::None;
	double start = 0, end = 0, step = 0;
	bool print_numbers = false;
};

struct ProjectState {
	int revision = 0;
	std::optional<CalibState> calib;
	Project project;
	ResolvedBundle presets;
	Slic3r::DynamicPrintConfig config; // full config: presets.full + project config
	std::map<int, std::shared_ptr<PlateResult>> sliced;
	std::mutex mutex; // one strand per project already; this guards against stray cross-strand use
};

class UpstreamFacade final : public Facade {
public:
	UpstreamFacade();

	EngineIdentity identity() const override;
	std::vector<std::string> capabilities() const override;
	void configure(const std::string &work_dir, const std::string &resources_dir) override;

	MeshInfo mesh_put(const std::string &mesh_id, const std::string &path, const std::string &format) override;
	void mesh_drop(const std::vector<std::string> &mesh_ids) override;

	std::string project_create(const PresetSelection &presets) override;
	SyncResult project_sync(const std::string &project_id, const Project &project, const ResolvedBundle &presets) override;
	void project_close(const std::string &project_id) override;
	ValidateResult config_validate(const std::string &project_id, int plate) override;

	std::vector<Arranged> arrange(const std::string &project_id, int plate, double spacing, bool allow_rotation,
	                              const std::string &alignment, const ProgressFn &progress, const CancelToken &cancel) override;
	std::vector<Oriented> orient(const std::string &project_id, const std::vector<std::string> &object_ids,
	                             const ProgressFn &progress, const CancelToken &cancel) override;

	PlateStats slice(const std::string &project_id, int plate, const ProgressFn &progress, const CancelToken &cancel) override;
	ExportResult export_gcode3mf(const std::string &project_id, const std::vector<int> &plates, const std::string &path,
	                             const std::vector<PlateImages> &images, bool engine_images) override;

	CalibResult calib_generate(const calib::Request &request, const PresetSelection &selection, const ResolvedBundle &presets,
	                           const std::string &bed_type) override;

	std::vector<PresetSummary> profiles_list(PresetKind kind, const std::string &vendor_dir) override;
	ResolvedBundle profiles_resolve(const PresetSelection &selection, const std::string &vendor_dir) override;

	PreviewResult preview_get(const std::string &, int, const std::string &, bool) override;
	/** Statistics assigned only to labelled object extrusion, excluding shared start/end/purge moves. */
	std::vector<ObjectStats> object_stats(const PlateResult &result) const;

	// Shared by the .cpp files.
	std::shared_ptr<ProjectState> project(const std::string &id);
	const MeshEntry &mesh(const Project &project, const std::string &mesh_id);
	/**
	 * A Model of the project's objects. With `plate` > 0 only that plate's instances, each shifted by
	 * the plate's origin so the plate sits at the bed origin (PartPlateList::compute_origin);
	 * `object_ids` receives our object id for each ModelObject.
	 */
	std::unique_ptr<Slic3r::Model> build_model(const ProjectState &state, int plate, std::vector<std::string> *object_ids,
	                                           std::vector<std::string> *instance_ids = nullptr);
	/** Where plate `index` (1-based) sits in the project's coordinates. */
	Slic3r::Vec3d plate_origin(const ProjectState &state, int index) const;
	Slic3r::PresetBundle &bundle(const std::string &vendor_dir);
	std::string scratch() const { return work_dir_ + "/scratch"; }
	/** The full config a project slices with: the presets' combined config, then the project's own settings. */
	Slic3r::DynamicPrintConfig project_config(const ConfigMap &full, const ConfigMap &project_config);
	/**
	 * Before Print::apply (slice.cpp): a calibration project's upstream parameters, and for the PA
	 * pattern its custom G-code (Calib.cpp generate_custom_gcodes). `params` must outlive the print.
	 */
	void apply_calib(const ProjectState &state, Slic3r::Model &model, const Slic3r::DynamicPrintConfig &config,
	                 bool bbl_printer, Slic3r::Calib_Params &params);

private:
	std::string work_dir_, resources_dir_;
	std::mutex mutex_;
	std::map<std::string, std::shared_ptr<MeshEntry>> meshes_;
	std::map<std::string, std::shared_ptr<ProjectState>> projects_;
	std::map<std::string, std::unique_ptr<Slic3r::PresetBundle>> bundles_;
	int next_project_ = 1;
};

} // namespace printlab::upstream
