#include "methods.hpp"

#include <algorithm>
#include <chrono>
#include <thread>

#include "version.hpp"
#include "convert.hpp"

namespace printlab {

namespace {

constexpr int PROTOCOL_MAJOR = 1;
constexpr int PROTOCOL_MINOR = 0;

Json ok() { return Json(Json::Object{{"ok", true}}); }

Json hello_result(const Facade &facade, const std::vector<std::string> &caps) {
	EngineIdentity id = facade.identity();
	Json patches = Json::array();
	for (const auto &p : id.patches) patches.push_back(p);
	Json capabilities = Json::array();
	for (const auto &c : caps) capabilities.push_back(c);
	Json profiles;
	if (!id.profiles_dir.empty())
		profiles = Json(Json::Object{{"dir", id.profiles_dir}, {"vendorVersion", id.vendor_version}});
	return Json(Json::Object{
	    {"engine", "printlab-slicer"},
	    {"version", PRINTLAB_ENGINE_VERSION},
	    {"protocol", Json(Json::Object{{"major", PROTOCOL_MAJOR}, {"minor", PROTOCOL_MINOR}})},
	    {"upstream", Json(Json::Object{{"name", id.upstream_name},
	                                   {"tag", id.upstream_tag},
	                                   {"commit", id.upstream_commit.empty() ? Json() : Json(id.upstream_commit)}})},
	    {"patchQueue",
	     Json(Json::Object{{"version", id.queue_version}, {"hash", id.queue_hash}, {"patches", patches}})},
	    {"capabilities", capabilities},
	    {"profiles", profiles}});
}

std::vector<std::string> string_list(const Json &j, const std::string &where) {
	if (!j.is_array())
		throw EngineError(err::INVALID_PARAMS, "The slicer was sent something it cannot read.", where + ": expected an array", where);
	std::vector<std::string> out;
	for (size_t i = 0; i < j.size(); ++i) {
		if (!j[i].is_string())
			throw EngineError(err::INVALID_PARAMS, "The slicer was sent something it cannot read.",
			                  where + "[" + std::to_string(i) + "]: expected a string", where);
		out.push_back(j[i].as_string());
	}
	return out;
}

} // namespace

void register_methods(Server &server, Facade &facade, const EngineOptions &options) {
	std::vector<std::string> caps = facade.capabilities();

	if (options.test_methods) caps.push_back("test.wait");
	server.set_capabilities(caps);
	auto started = std::make_shared<bool>(false);

	server.add("engine.hello", {"", true, [&facade, caps, started](const Json &p, CallContext &) {
		                            const Json &proto = need(p, "protocol", "params");
		                            long long major = need_int(proto, "major", "params.protocol");
		                            if (major != PROTOCOL_MAJOR)
			                            throw EngineError(err::INVALID_REQUEST,
			                                              "The app and the slicer speak different protocol versions. Update them together.",
			                                              "client major " + std::to_string(major));
		                            facade.configure(need_string(p, "workDir", "params"), opt_string(p, "resourcesDir"));
		                            *started = true;
		                            return hello_result(facade, caps);
	                            }});
	server.add("engine.ping", {"", true, [](const Json &, CallContext &) { return ok(); }});
	server.add("engine.shutdown", {"", true, [&server](const Json &, CallContext &) {
		                               server.request_stop();
		                               return ok();
	                               }});

	server.add("mesh.put", {"mesh.put", false, [&facade](const Json &p, CallContext &) {
		                        return to_json(facade.mesh_put(need_string(p, "meshId", "params"), need_string(p, "path", "params"),
		                                                       need_string(p, "format", "params")));
	                        }});
	server.add("mesh.drop", {"", false, [&facade](const Json &p, CallContext &) {
		                         facade.mesh_drop(string_list(need(p, "meshIds", "params"), "params.meshIds"));
		                         return ok();
	                         }});
	server.add("project.open", {"project.open", false, [&facade](const Json &p, CallContext &) {
		                           auto r = facade.project_open(need_string(p, "path", "params"));
		                           return Json(Json::Object{{"projectId", r.project_id}, {"project", to_json(r.project, r.meshes)}, {"meshDir", r.mesh_dir}});
	                           }});
	server.add("project.save", {"project.save", false, [&facade](const Json &p, CallContext &) {
		                           auto path = need_string(p, "path", "params");
		                           facade.project_save(need_string(p, "projectId", "params"), path, images_from(p["thumbnails"], "params.thumbnails"));
		                           return Json(Json::Object{{"path", path}});
	                           }});
	server.add("project.create", {"", false, [&facade](const Json &p, CallContext &) {
		                              std::string id = facade.project_create(selection_from(need(p, "presets", "params"), "params.presets"));
		                              return Json(Json::Object{{"projectId", id}});
	                              }});
	server.add("project.sync", {"project.sync", false, [&facade](const Json &p, CallContext &) {
		                            SyncResult r = facade.project_sync(need_string(p, "projectId", "params"),
		                                                               project_from(need(p, "project", "params"), "params.project"),
		                                                               bundle_from(need(p, "presets", "params"), "params.presets"));
		                            Json errors = Json::array();
		                            for (const auto &e : r.errors) errors.push_back(to_json(e));
		                            return Json(Json::Object{{"revision", r.revision}, {"errors", errors}});
	                            }});
	server.add("project.close", {"", false, [&facade](const Json &p, CallContext &) {
		                             facade.project_close(need_string(p, "projectId", "params"));
		                             return ok();
	                             }});
	server.add("config.validate", {"config.validate", false, [&facade](const Json &p, CallContext &) {
		                               int plate = p["plate"].is_number() ? static_cast<int>(p["plate"].as_int()) : 0;
		                               ValidateResult r = facade.config_validate(need_string(p, "projectId", "params"), plate);
		                               Json errors = Json::array(), warnings = Json::array();
		                               for (const auto &e : r.errors) errors.push_back(to_json(e));
		                               for (const auto &w : r.warnings) warnings.push_back(to_json(w));
		                               return Json(Json::Object{{"errors", errors}, {"warnings", warnings}});
	                               }});
	server.add("arrange", {"arrange", false, [&facade](const Json &p, CallContext &ctx) {
		                       const Json &plate = need(p, "plate", "params");
		                       int which = plate.is_string() && plate.as_string() == "all" ? 0 : static_cast<int>(need_int(p, "plate", "params"));
		                       auto rows = facade.arrange(need_string(p, "projectId", "params"), which, opt_number(p, "spacing", -1),
		                                                  opt_bool(p, "allowRotation", true), opt_string(p, "alignment", "center"),
		                                                  ctx.progress, *ctx.cancel);
		                       Json instances = Json::array();
		                       for (const auto &r : rows)
			                       instances.push_back(Json(Json::Object{{"objectId", r.object_id},
			                                                             {"instanceId", r.instance_id},
			                                                             {"plate", r.plate},
			                                                             {"transform", to_json(r.transform)}}));
		                       return Json(Json::Object{{"instances", instances}});
	                       }});
	server.add("orient", {"orient", false, [&facade](const Json &p, CallContext &ctx) {
		                      auto rows = facade.orient(need_string(p, "projectId", "params"),
		                                                string_list(need(p, "objectIds", "params"), "params.objectIds"), ctx.progress,
		                                                *ctx.cancel);
		                      Json objects = Json::array();
		                      for (const auto &r : rows)
			                      objects.push_back(Json(Json::Object{{"objectId", r.object_id}, {"transform", to_json(r.transform)}}));
		                      return Json(Json::Object{{"objects", objects}});
	                      }});
	server.add("slice", {"slice", false, [&facade](const Json &p, CallContext &ctx) {
		                     return to_json(facade.slice(need_string(p, "projectId", "params"),
		                                                 static_cast<int>(need_int(p, "plate", "params")), ctx.progress, *ctx.cancel));
	                     }});
	server.add("preview.get", {"preview.v1", false, [&facade](const Json &p, CallContext &) {
		                          auto r = facade.preview_get(need_string(p, "projectId", "params"),
		                                                      static_cast<int>(need_int(p, "plate", "params")),
		                                                      need_string(p, "path", "params"), opt_bool(p, "travel", true));
		                          return Json(Json::Object{{"path", r.path}, {"header", to_json(r.header)}});
	                          }});
	server.add("export.gcode3mf", {"export.gcode3mf", false, [&facade](const Json &p, CallContext &) {
		                               std::vector<int> plates;
		                               const Json &pl = need(p, "plates", "params");
		                               if (pl.is_array())
			                               for (size_t i = 0; i < pl.size(); ++i) plates.push_back(static_cast<int>(pl[i].as_int()));
		                               const Json &th = need(p, "thumbnails", "params");
		                               bool engine_images = th.is_string() && th.as_string() == "engine";
		                               ExportResult r = facade.export_gcode3mf(need_string(p, "projectId", "params"), plates,
		                                                                       need_string(p, "path", "params"),
		                                                                       engine_images ? std::vector<PlateImages>{} : images_from(th, "params.thumbnails"),
		                                                                       engine_images);
		                               Json out = Json::array();
		                               for (const auto &sp : r.plates) out.push_back(to_json(sp));
		                               return Json(Json::Object{{"path", r.path}, {"plates", out}});
	                               }});
	// Calibration tests (features/calib): gated per test, since each is its own capability.
	server.add("calib.generate", {"", false, [&facade, caps](const Json &p, CallContext &) {
		                              calib::Request request = calib_request_from(p, "params");
		                              std::string cap = calib::capability(request.kind);
		                              if (std::find(caps.begin(), caps.end(), cap) == caps.end())
			                              throw EngineError(err::CAPABILITY_MISSING, "This version of the slicer cannot make that test.", cap, cap);
		                              return to_json(facade.calib_generate(request, selection_from(need(p, "selection", "params"), "params.selection"),
		                                                                   bundle_from(need(p, "presets", "params"), "params.presets"),
		                                                                   opt_string(p, "bedType")));
	                              }});
	server.add("profiles.list", {"profiles.list", false, [&facade](const Json &p, CallContext &) {
		                             Json presets = Json::array();
		                             for (const auto &s : facade.profiles_list(kind_from(need_string(p, "kind", "params")), opt_string(p, "vendorDir")))
			                             presets.push_back(to_json(s));
		                             return Json(Json::Object{{"presets", presets}});
	                             }});
	server.add("profiles.resolve", {"profiles.resolve", false, [&facade](const Json &p, CallContext &) {
		                                return to_json(facade.profiles_resolve(selection_from(need(p, "selection", "params"), "params.selection"),
		                                                                       opt_string(p, "vendorDir")));
	                                }});

	if (options.test_methods)
		// Progress every `stepMs` for `steps` steps, cancellable: exercises the strand, progress and
		// cancel paths without slicing (conformance tests on a build without upstream).
		server.add("test.wait", {"test.wait", false, [](const Json &p, CallContext &ctx) {
			                         int steps = static_cast<int>(opt_number(p, "steps", 3));
			                         int step_ms = static_cast<int>(opt_number(p, "stepMs", 10));
			                         for (int i = 1; i <= steps; ++i) {
				                         std::this_thread::sleep_for(std::chrono::milliseconds(step_ms));
				                         if ((*ctx.cancel)()) throw EngineError(err::CANCELLED, "Cancelled.");
				                         ctx.progress({"slicing", i * 100 / steps, "Step " + std::to_string(i)});
			                         }
			                         return Json(Json::Object{{"steps", steps}});
		                         }});
}

} // namespace printlab
