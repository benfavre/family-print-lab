// The facade: everything the engine asks of Bambu Studio's libslic3r, in our own types. Two
// implementations: facade/upstream/ (the real one, the only code that includes upstream headers) and
// facade/null_facade.cpp (a build without upstream, for the protocol layer's tests and CI).
#pragma once

#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "types.hpp"
#include "features/calib/calib.hpp"

namespace printlab {

/** Error codes, as ERROR in app/src/lib/shared/slicer/protocol.ts. */
namespace err {
constexpr int PARSE = -32700;
constexpr int INVALID_REQUEST = -32600;
constexpr int METHOD_NOT_FOUND = -32601;
constexpr int INVALID_PARAMS = -32602;
constexpr int INTERNAL = -32603;
constexpr int PROJECT_NOT_FOUND = 1001;
constexpr int MESH_NOT_FOUND = 1002;
constexpr int FILE_READ = 1003;
constexpr int UNSUPPORTED_FORMAT = 1004;
constexpr int INVALID_CONFIG = 1010;
constexpr int PRESET_NOT_FOUND = 1011;
constexpr int SLICE_FAILED = 1020;
constexpr int NOTHING_TO_SLICE = 1021;
constexpr int OUTSIDE_PLATE = 1022;
constexpr int CANCELLED = 1030;
constexpr int EXPORT_FAILED = 1040;
constexpr int CAPABILITY_MISSING = 1050;
constexpr int UPSTREAM_EXCEPTION = 1099;
} // namespace err

/** An error for the client: `message` is plain words for the UI; `detail` is upstream's own text. */
struct EngineError : std::runtime_error {
	int code;
	std::string detail, key, object_id;
	EngineError(int code, const std::string &message, std::string detail = {}, std::string key = {},
	            std::string object_id = {})
	    : std::runtime_error(message), code(code), detail(std::move(detail)), key(std::move(key)),
	      object_id(std::move(object_id)) {}
};

struct SyncResult {
	int revision = 0;
	std::vector<ConfigError> errors;
};
struct ValidateResult {
	std::vector<ConfigError> errors;
	std::vector<SliceWarning> warnings;
};
struct ExportResult {
	std::string path;
	std::vector<SlicedPlate> plates;
};
/** A calibration test set up as an open project, ready to slice (features/calib). */
struct CalibResult {
	std::string project_id;
	Project project;
	/** Size and bounds of each generated mesh (files named in project.meshes). */
	std::map<std::string, MeshInfo> meshes;
	std::string title;
	std::vector<calib::Step> steps;
	/** The flow ratio the steps' values start from (flow rate tests), else 0. */
	double base_flow_ratio = 0;
};

class Facade {
public:
	virtual ~Facade() = default;

	/** Upstream tag and commit, patch queue and bundled profiles. */
	virtual EngineIdentity identity() const = 0;
	/** Protocol capability names this build supports. */
	virtual std::vector<std::string> capabilities() const = 0;
	/** From engine.hello: the work directory and, when given, the resources directory. */
	virtual void configure(const std::string &work_dir, const std::string &resources_dir) = 0;

	virtual MeshInfo mesh_put(const std::string &mesh_id, const std::string &path, const std::string &format) = 0;
	virtual void mesh_drop(const std::vector<std::string> &mesh_ids) = 0;

	virtual std::string project_create(const PresetSelection &presets) = 0;
	virtual SyncResult project_sync(const std::string &project_id, const Project &project, const ResolvedBundle &presets) = 0;
	virtual void project_close(const std::string &project_id) = 0;
	virtual ValidateResult config_validate(const std::string &project_id, int plate) = 0;

	virtual std::vector<Arranged> arrange(const std::string &project_id, int plate /* 0 = all */, double spacing,
	                                      bool allow_rotation, const std::string &alignment, const ProgressFn &progress,
	                                      const CancelToken &cancel) = 0;
	virtual std::vector<Oriented> orient(const std::string &project_id, const std::vector<std::string> &object_ids,
	                                     const ProgressFn &progress, const CancelToken &cancel) = 0;

	virtual PlateStats slice(const std::string &project_id, int plate, const ProgressFn &progress,
	                         const CancelToken &cancel) = 0;
	/** `plates` empty = every sliced plate; `images` empty = render with features/thumbnails. */
	virtual ExportResult export_gcode3mf(const std::string &project_id, const std::vector<int> &plates,
	                                     const std::string &path, const std::vector<PlateImages> &images,
	                                     bool engine_images) = 0;

	/** Opens a project holding the calibration test for these presets (capability calib.<kind>). */
	virtual CalibResult calib_generate(const calib::Request &request, const PresetSelection &selection,
	                                   const ResolvedBundle &presets, const std::string &bed_type) = 0;

	virtual std::vector<PresetSummary> profiles_list(PresetKind kind, const std::string &vendor_dir) = 0;
	virtual ResolvedBundle profiles_resolve(const PresetSelection &selection, const std::string &vendor_dir) = 0;
};

/** The facade this binary was built with (upstream, or the null one). */
std::unique_ptr<Facade> make_facade();

} // namespace printlab
