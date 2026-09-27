// The upstream facade: projects held in memory by id, each with its full config (the resolved
// presets' combined config plus the project's own settings), and the capabilities this build offers.
#include <cstdlib>
#include <fstream>

#include <boost/filesystem.hpp>

#include "libslic3r/Utils.hpp"
#include "../identity.hpp"
#include "rpc/json.hpp"
#include "upstream.hpp"

namespace printlab::upstream {

using namespace Slic3r;
namespace fs = boost::filesystem;

namespace {
std::string opt_string_json(const Json &j) { return j["version"].is_string() ? j["version"].as_string() : ""; }
} // namespace

UpstreamFacade::UpstreamFacade() {
#ifdef PRINTLAB_UPSTREAM_RESOURCES
	resources_dir_ = PRINTLAB_UPSTREAM_RESOURCES;
#endif
	// libslic3r logs at trace level until told otherwise, a flood on stderr while slicing: warnings and
	// worse (0 fatal … 5 trace, Utils.hpp set_logging_level), or PRINTLAB_ENGINE_LOG_LEVEL.
	const char *level = std::getenv("PRINTLAB_ENGINE_LOG_LEVEL");
	set_logging_level(level && *level >= '0' && *level <= '5' ? static_cast<unsigned>(*level - '0') : 2);
}

EngineIdentity UpstreamFacade::identity() const {
	EngineIdentity id = build_identity();
	fs::path vendor = fs::path(resources_dir_) / "profiles" / "BBL.json";
	if (fs::exists(vendor)) {
		id.profiles_dir = (fs::path(resources_dir_) / "profiles" / "BBL").string();
		std::ifstream in(vendor.string(), std::ios::binary);
		std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		try {
			id.vendor_version = opt_string_json(Json::parse(text));
		} catch (const Json::ParseError &) {
		}
	}
	return id;
}

std::vector<std::string> UpstreamFacade::capabilities() const {
	std::vector<std::string> caps = {"mesh.put",        "project.sync",  "arrange",         "orient",         "slice",
	                                 "slice.cancel",    "export.gcode3mf", "export.thumbnails", "profiles.resolve", "profiles.list",
	                                 "paint.supports",  "paint.seam",    "paint.color",     "paint.fuzzy_skin", "modifiers",
	                                 "height_ranges",   "variable_layer_height", "preview.v1"};
	// Every calibration test (features/calib): their models ship with the engine's resources.
	for (calib::Kind k : calib::all_kinds()) caps.push_back(calib::capability(k));
	return caps;
}

void UpstreamFacade::configure(const std::string &work_dir, const std::string &resources_dir) {
	work_dir_ = work_dir;
	if (!resources_dir.empty()) resources_dir_ = resources_dir;
	fs::create_directories(fs::path(work_dir_) / "data");
	fs::create_directories(fs::path(work_dir_) / "tmp");
	// Upstream reads its resources and writes caches through these (Utils.hpp); keep both in our dirs.
	set_resources_dir(resources_dir_);
	set_data_dir((fs::path(work_dir_) / "data").string());
	set_temporary_dir((fs::path(work_dir_) / "tmp").string());
}

std::shared_ptr<ProjectState> UpstreamFacade::project(const std::string &id) {
	std::lock_guard<std::mutex> lock(mutex_);
	auto it = projects_.find(id);
	if (it == projects_.end()) throw EngineError(err::PROJECT_NOT_FOUND, "That slicer project is not open.", id);
	return it->second;
}

std::string UpstreamFacade::project_create(const PresetSelection &presets) {
	auto state = std::make_shared<ProjectState>();
	state->project.presets = presets;
	std::lock_guard<std::mutex> lock(mutex_);
	std::string id = "p" + std::to_string(next_project_++);
	projects_[id] = state;
	return id;
}

SyncResult UpstreamFacade::project_sync(const std::string &project_id, const Project &next, const ResolvedBundle &presets) {
	auto state = project(project_id);
	std::lock_guard<std::mutex> lock(state->mutex);
	SyncResult out;
	DynamicPrintConfig config = project_config(presets.full, next.project_config);
	for (const SceneObject &o : next.objects)
		for (const Part &p : o.parts) try {
				mesh(next, p.mesh);
			} catch (const EngineError &e) {
				out.errors.push_back({"mesh", e.what(), o.id});
			}
	state->project = next;
	state->presets = presets;
	state->config = std::move(config);
	state->sliced.clear(); // any change invalidates what was sliced
	out.revision = ++state->revision;
	return out;
}

DynamicPrintConfig UpstreamFacade::project_config(const ConfigMap &presets_full, const ConfigMap &own) {
	// The combined config the presets resolve to, then the project's own settings over it.
	ConfigMap full = presets_full;
	for (const auto &kv : own) full[kv.first] = kv.second;
	DynamicPrintConfig config = DynamicPrintConfig::full_print_config();
	config.apply(to_config(full, scratch()), true);
	config.normalize_fdm();
	restore_enum_maps(config);
	return config;
}

void UpstreamFacade::project_close(const std::string &project_id) {
	std::lock_guard<std::mutex> lock(mutex_);
	projects_.erase(project_id);
	boost::system::error_code ec;
	fs::remove_all(fs::path(work_dir_) / project_id, ec);
}

ValidateResult UpstreamFacade::config_validate(const std::string &project_id, int plate) {
	auto state = project(project_id);
	std::lock_guard<std::mutex> lock(state->mutex);
	ValidateResult out;
	for (const Plate &p : state->project.plates) {
		if (plate && p.index != plate) continue;
		std::vector<std::string> ids;
		auto model = build_model(*state, p.index, &ids);
		if (model->objects.empty()) continue;
		Print print;
		print.apply(*model, state->config);
		StringObjectException warning;
		StringObjectException error = print.validate(&warning);
		if (!error.string.empty()) out.errors.push_back({error.opt_key, error.string, ""});
		if (!warning.string.empty()) out.warnings.push_back({"VALIDATE", warning.string, "", p.index});
	}
	return out;
}

} // namespace printlab::upstream

namespace printlab {
std::unique_ptr<Facade> make_facade() { return std::make_unique<upstream::UpstreamFacade>(); }
} // namespace printlab
