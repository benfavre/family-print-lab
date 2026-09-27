// JSON ⇄ facade types, following the field names in app/src/lib/shared/slicer/*.ts. Readers throw
// EngineError(INVALID_PARAMS) with the path of the bad field, so the client learns what it sent wrong.
#pragma once

#include "../facade/facade.hpp"
#include "json.hpp"

namespace printlab {

/** Field readers: `where` names the field in error messages ("params.project.objects[2].id"). */
const Json &need(const Json &obj, const std::string &key, const std::string &where);
std::string need_string(const Json &obj, const std::string &key, const std::string &where);
std::string opt_string(const Json &obj, const std::string &key, const std::string &fallback = {});
long long need_int(const Json &obj, const std::string &key, const std::string &where);
double opt_number(const Json &obj, const std::string &key, double fallback);
bool opt_bool(const Json &obj, const std::string &key, bool fallback);

ConfigMap config_from(const Json &j, const std::string &where);
Json to_json(const ConfigMap &c);
Transform transform_from(const Json &j, const std::string &where);
Json to_json(const Transform &t);

PresetRef preset_ref_from(const Json &j, const std::string &where);
PresetSelection selection_from(const Json &j, const std::string &where);
ResolvedBundle bundle_from(const Json &j, const std::string &where);
Project project_from(const Json &j, const std::string &where);
std::vector<PlateImages> images_from(const Json &j, const std::string &where);

Json to_json(const ResolvedPreset &p);
Json to_json(const ResolvedBundle &b);
Json to_json(const PresetSummary &p);
Json to_json(const MeshInfo &m);
Json to_json(const PlateStats &s);
Json to_json(const SlicedPlate &p);
Json to_json(const ConfigError &e);
Json to_json(const SliceWarning &w);
Json to_json(const Progress &p);
Json to_json(const PresetRef &r);
/** A project as protocol JSON (project.ts); `meshes` fills each MeshRef's size and bounds. */
Json to_json(const Project &p, const std::map<std::string, MeshInfo> &meshes);
/** calib.generate: params.kind and params.params (start, end, step, pass, linear, printNumbers). */
calib::Request calib_request_from(const Json &params, const std::string &where);
Json to_json(const CalibResult &r);

} // namespace printlab
