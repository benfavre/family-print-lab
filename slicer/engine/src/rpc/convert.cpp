#include "convert.hpp"

#include <algorithm>

namespace printlab {

namespace {
[[noreturn]] void bad(const std::string &where, const std::string &what) {
	throw EngineError(err::INVALID_PARAMS, "The slicer was sent something it cannot read.", where + ": " + what, where);
}
std::string at(const std::string &where, const std::string &key) { return where + "." + key; }
std::string at(const std::string &where, size_t i) { return where + "[" + std::to_string(i) + "]"; }
} // namespace

const char *kind_name(PresetKind k) {
	switch (k) {
	case PresetKind::Printer: return "printer";
	case PresetKind::Process: return "process";
	case PresetKind::Filament: return "filament";
	}
	return "printer";
}
PresetKind kind_from(const std::string &s) {
	if (s == "printer") return PresetKind::Printer;
	if (s == "process") return PresetKind::Process;
	if (s == "filament") return PresetKind::Filament;
	throw EngineError(err::INVALID_PARAMS, "Unknown preset kind.", s, "kind");
}
const char *part_type_name(PartType t) {
	switch (t) {
	case PartType::Model: return "model";
	case PartType::Negative: return "negative";
	case PartType::Modifier: return "modifier";
	case PartType::SupportBlocker: return "support_blocker";
	case PartType::SupportEnforcer: return "support_enforcer";
	}
	return "model";
}
PartType part_type_from(const std::string &s) {
	if (s == "model") return PartType::Model;
	if (s == "negative") return PartType::Negative;
	if (s == "modifier") return PartType::Modifier;
	if (s == "support_blocker") return PartType::SupportBlocker;
	if (s == "support_enforcer") return PartType::SupportEnforcer;
	throw EngineError(err::INVALID_PARAMS, "Unknown part type.", s, "type");
}

const Json &need(const Json &obj, const std::string &key, const std::string &where) {
	if (!obj.is_object()) bad(where, "expected an object");
	if (!obj.has(key)) bad(at(where, key), "missing");
	return obj[key];
}
std::string need_string(const Json &obj, const std::string &key, const std::string &where) {
	const Json &v = need(obj, key, where);
	if (!v.is_string()) bad(at(where, key), "expected a string");
	return v.as_string();
}
std::string opt_string(const Json &obj, const std::string &key, const std::string &fallback) {
	const Json &v = obj[key];
	return v.is_string() ? v.as_string() : fallback;
}
long long need_int(const Json &obj, const std::string &key, const std::string &where) {
	const Json &v = need(obj, key, where);
	try {
		return v.as_int();
	} catch (const Json::TypeError &) {
		bad(at(where, key), "expected an integer");
	}
}
double opt_number(const Json &obj, const std::string &key, double fallback) {
	const Json &v = obj[key];
	return v.is_number() ? v.as_number() : fallback;
}
bool opt_bool(const Json &obj, const std::string &key, bool fallback) {
	const Json &v = obj[key];
	return v.is_bool() ? v.as_bool() : fallback;
}

ConfigMap config_from(const Json &j, const std::string &where) {
	ConfigMap out;
	if (j.is_null()) return out;
	if (!j.is_object()) bad(where, "expected an object");
	for (const auto &kv : j.as_object()) {
		if (kv.second.is_string()) out[kv.first] = kv.second.as_string();
		else if (kv.second.is_array()) {
			std::vector<std::string> list;
			for (size_t i = 0; i < kv.second.size(); ++i) {
				if (!kv.second[i].is_string()) bad(at(at(where, kv.first), i), "expected a string");
				list.push_back(kv.second[i].as_string());
			}
			out[kv.first] = std::move(list);
		} else
			bad(at(where, kv.first), "expected a string or an array of strings");
	}
	return out;
}
Json to_json(const ConfigMap &c) {
	Json out = Json::object();
	for (const auto &kv : c) {
		if (const auto *s = std::get_if<std::string>(&kv.second)) out[kv.first] = *s;
		else {
			Json list = Json::array();
			for (const auto &v : std::get<std::vector<std::string>>(kv.second)) list.push_back(v);
			out[kv.first] = list;
		}
	}
	return out;
}

Transform transform_from(const Json &j, const std::string &where) {
	if (!j.is_array() || j.size() != 12) bad(where, "expected 12 numbers");
	Transform t{};
	for (size_t i = 0; i < 12; ++i) {
		if (!j[i].is_number()) bad(at(where, i), "expected a number");
		t[i] = j[i].as_number();
	}
	return t;
}
Json to_json(const Transform &t) {
	Json out = Json::array();
	for (double v : t) out.push_back(v);
	return out;
}

PresetRef preset_ref_from(const Json &j, const std::string &where) {
	PresetRef r;
	r.kind = kind_from(need_string(j, "kind", where));
	r.name = need_string(j, "name", where);
	r.source = opt_string(j, "source", "system");
	return r;
}
PresetSelection selection_from(const Json &j, const std::string &where) {
	PresetSelection s;
	s.printer = preset_ref_from(need(j, "printer", where), at(where, "printer"));
	s.process = preset_ref_from(need(j, "process", where), at(where, "process"));
	const Json &f = need(j, "filaments", where);
	if (!f.is_array()) bad(at(where, "filaments"), "expected an array");
	for (size_t i = 0; i < f.size(); ++i) s.filaments.push_back(preset_ref_from(f[i], at(at(where, "filaments"), i)));
	return s;
}

namespace {
ResolvedPreset resolved_from(const Json &j, const std::string &where) {
	ResolvedPreset p;
	p.kind = kind_from(need_string(j, "kind", where));
	p.name = need_string(j, "name", where);
	for (size_t i = 0; i < j["chain"].size(); ++i)
		if (j["chain"][i].is_string()) p.chain.push_back(j["chain"][i].as_string());
	p.config = config_from(need(j, "config", where), at(where, "config"));
	if (j["origin"].is_object())
		for (const auto &kv : j["origin"].as_object())
			if (kv.second.is_string()) p.origin[kv.first] = kv.second.as_string();
	return p;
}
std::map<int, std::string> paint_from(const Json &j) {
	std::map<int, std::string> out;
	if (!j.is_object()) return out;
	for (const auto &kv : j.as_object())
		if (kv.second.is_string()) out[std::stoi(kv.first)] = kv.second.as_string();
	return out;
}
} // namespace

ResolvedBundle bundle_from(const Json &j, const std::string &where) {
	ResolvedBundle b;
	b.printer = resolved_from(need(j, "printer", where), at(where, "printer"));
	b.process = resolved_from(need(j, "process", where), at(where, "process"));
	const Json &f = need(j, "filaments", where);
	for (size_t i = 0; i < f.size(); ++i) b.filaments.push_back(resolved_from(f[i], at(at(where, "filaments"), i)));
	b.full = config_from(j["full"], at(where, "full"));
	b.vendor_tag = opt_string(j["vendor"], "tag");
	b.vendor_version = opt_string(j["vendor"], "version");
	return b;
}

Project project_from(const Json &j, const std::string &where) {
	Project p;
	p.source_json = j.dump();
	const Json &meta = j["meta"];
	p.title = opt_string(meta, "title");
	if (meta["extras"].is_object())
		for (const auto &kv : meta["extras"].as_object())
			if (kv.second.is_string()) p.extras[kv.first] = kv.second.as_string();
	p.presets = selection_from(need(j, "presets", where), at(where, "presets"));
	p.project_config = config_from(j["projectConfig"], at(where, "projectConfig"));
	for (size_t i = 0; i < j["filaments"].size(); ++i) {
		const Json &f = j["filaments"][i];
		FilamentSlot s;
		s.index = static_cast<int>(need_int(f, "index", at(at(where, "filaments"), i)));
		s.color = opt_string(f, "color");
		s.type = opt_string(f, "type");
		p.filaments.push_back(s);
	}
	for (size_t i = 0; i < j["plates"].size(); ++i) {
		const Json &pl = j["plates"][i];
		std::string w = at(at(where, "plates"), i);
		Plate plate;
		plate.index = static_cast<int>(need_int(pl, "index", w));
		plate.name = opt_string(pl, "name");
		plate.locked = opt_bool(pl, "locked", false);
		plate.bed_type = opt_string(pl, "bedType");
		plate.print_sequence = opt_string(pl, "printSequence");
		plate.spiral_vase = opt_bool(pl, "spiralVase", false);
		for (size_t k = 0; k < pl["filamentMaps"].size(); ++k)
			if (pl["filamentMaps"][k].is_number()) plate.filament_maps.push_back(static_cast<int>(pl["filamentMaps"][k].as_int()));
		for (size_t k = 0; k < pl["instances"].size(); ++k) {
			const Json &r = pl["instances"][k];
			std::string wr = at(at(w, "instances"), k);
			plate.instances.push_back({need_string(r, "objectId", wr), need_string(r, "instanceId", wr)});
		}
		plate.config = config_from(pl["config"], at(w, "config"));
		p.plates.push_back(std::move(plate));
	}
	for (size_t i = 0; i < j["objects"].size(); ++i) {
		const Json &o = j["objects"][i];
		std::string w = at(at(where, "objects"), i);
		SceneObject obj;
		obj.id = need_string(o, "id", w);
		obj.name = opt_string(o, "name");
		obj.printable = opt_bool(o, "printable", true);
		obj.config = config_from(o["config"], at(w, "config"));
		for (size_t k = 0; k < o["parts"].size(); ++k) {
			const Json &pt = o["parts"][k];
			std::string wp = at(at(w, "parts"), k);
			Part part;
			part.id = need_string(pt, "id", wp);
			part.name = opt_string(pt, "name");
			part.type = part_type_from(opt_string(pt, "type", "model"));
			part.mesh = need_string(pt, "mesh", wp);
			part.transform = pt.has("transform") ? transform_from(pt["transform"], at(wp, "transform")) : IDENTITY;
			part.config = config_from(pt["config"], at(wp, "config"));
			part.filament = pt["filament"].is_number() ? static_cast<int>(pt["filament"].as_int()) : 0;
			const Json &paint = pt["paint"];
			part.paint_supports = paint_from(paint["supports"]);
			part.paint_seam = paint_from(paint["seam"]);
			part.paint_color = paint_from(paint["color"]);
			part.paint_fuzzy_skin = paint_from(paint["fuzzySkin"]);
			obj.parts.push_back(std::move(part));
		}
		for (size_t k = 0; k < o["instances"].size(); ++k) {
			const Json &in = o["instances"][k];
			std::string wi = at(at(w, "instances"), k);
			Instance inst;
			inst.id = need_string(in, "id", wi);
			inst.transform = in.has("transform") ? transform_from(in["transform"], at(wi, "transform")) : IDENTITY;
			inst.printable = opt_bool(in, "printable", true);
			obj.instances.push_back(inst);
		}
		for (size_t k = 0; k < o["heightRanges"].size(); ++k) {
			const Json &r = o["heightRanges"][k];
			obj.height_ranges.push_back({opt_number(r, "minZ", 0), opt_number(r, "maxZ", 0),
			                             config_from(r["config"], at(at(w, "heightRanges"), k))});
		}
		for (size_t k = 0; k < o["layerHeightProfile"].size(); ++k)
			if (o["layerHeightProfile"][k].is_number()) obj.layer_height_profile.push_back(o["layerHeightProfile"][k].as_number());
		p.objects.push_back(std::move(obj));
	}
	if (j["meshes"].is_object())
		for (const auto &kv : j["meshes"].as_object()) {
			const Json &storage = kv.second["storage"];
			if (opt_string(storage, "kind") == "file") p.meshes[kv.first] = {kv.first, opt_string(storage, "path")};
		}
	return p;
}

std::vector<PlateImages> images_from(const Json &j, const std::string &where) {
	std::vector<PlateImages> out;
	if (!j.is_array()) return out;
	for (size_t i = 0; i < j.size(); ++i) {
		std::string w = at(where, i);
		PlateImages im;
		im.plate = static_cast<int>(need_int(j[i], "plate", w));
		im.thumbnail = need_string(j[i], "thumbnail", w);
		im.no_light = opt_string(j[i], "noLight");
		im.top = opt_string(j[i], "top");
		im.pick = opt_string(j[i], "pick");
		im.small = opt_string(j[i], "small");
		out.push_back(im);
	}
	return out;
}

Json to_json(const ResolvedPreset &p) {
	Json chain = Json::array();
	for (const auto &c : p.chain) chain.push_back(c);
	Json origin = Json::object();
	for (const auto &kv : p.origin) origin[kv.first] = kv.second;
	return Json(Json::Object{{"kind", kind_name(p.kind)}, {"name", p.name}, {"chain", chain},
	                         {"config", to_json(p.config)}, {"origin", origin}});
}
Json to_json(const ResolvedBundle &b) {
	Json filaments = Json::array();
	for (const auto &f : b.filaments) filaments.push_back(to_json(f));
	return Json(Json::Object{{"printer", to_json(b.printer)},
	                         {"process", to_json(b.process)},
	                         {"filaments", filaments},
	                         {"full", to_json(b.full)},
	                         {"vendor", Json(Json::Object{{"tag", b.vendor_tag}, {"version", b.vendor_version}})}});
}
Json to_json(const PresetSummary &p) {
	Json compatible = Json::array();
	for (const auto &c : p.compatible_printers) compatible.push_back(c);
	Json out(Json::Object{{"kind", kind_name(p.kind)},
	                      {"name", p.name},
	                      {"source", "system"},
	                      {"id", p.name},
	                      {"inherits", p.inherits ? Json(*p.inherits) : Json()},
	                      {"instantiable", p.instantiable},
	                      {"compatiblePrinters", compatible},
	                      {"compatibleCondition", p.compatible_condition ? Json(*p.compatible_condition) : Json()}});
	if (p.printer_model) out["printerModel"] = *p.printer_model;
	if (p.nozzle) out["nozzle"] = *p.nozzle;
	if (p.filament_type) out["filamentType"] = *p.filament_type;
	if (p.filament_id) out["filamentId"] = *p.filament_id;
	if (p.setting_id) out["settingId"] = *p.setting_id;
	return out;
}
Json to_json(const MeshInfo &m) {
	Json bbox = Json::array();
	for (double v : m.bbox) bbox.push_back(v);
	return Json(Json::Object{{"meshId", m.mesh_id},
	                         {"triangles", static_cast<double>(m.triangles)},
	                         {"bbox", bbox},
	                         {"repaired", Json(Json::Object{{"edgesFixed", m.edges_fixed},
	                                                        {"facetsRemoved", m.facets_removed},
	                                                        {"facetsReversed", m.facets_reversed}})}});
}
Json to_json(const ConfigError &e) {
	Json out(Json::Object{{"key", e.key}, {"message", e.message}});
	if (!e.object_id.empty()) out["objectId"] = e.object_id;
	return out;
}
Json to_json(const SliceWarning &w) {
	Json out(Json::Object{{"code", w.code}, {"message", w.message}});
	if (!w.object_id.empty()) out["objectId"] = w.object_id;
	if (w.plate) out["plate"] = w.plate;
	return out;
}
Json to_json(const PlateStats &s) {
	Json filaments = Json::array(), objects = Json::array(), warnings = Json::array();
	for (const auto &f : s.filaments)
		filaments.push_back(Json(Json::Object{{"index", f.index}, {"grams", f.grams}, {"meters", f.meters}}));
	for (const auto &o : s.objects)
		objects.push_back(Json(Json::Object{{"objectId", o.object_id},
		                                    {"seconds", o.seconds ? Json(*o.seconds) : Json()},
		                                    {"grams", o.grams ? Json(*o.grams) : Json()}}));
	for (const auto &w : s.warnings) warnings.push_back(to_json(w));
	return Json(Json::Object{{"plate", s.plate}, {"seconds", s.seconds}, {"layers", s.layers},
	                         {"filaments", filaments}, {"objects", objects}, {"warnings", warnings}});
}
Json to_json(const SlicedPlate &p) {
	Json filaments = Json::array();
	for (const auto &f : p.filaments) {
		Json fj(Json::Object{{"id", f.id}, {"type", f.type}, {"color", f.color}, {"grams", f.grams}, {"meters", f.meters}});
		if (f.extruder == 1 || f.extruder == 2) fj["extruder"] = f.extruder;
		filaments.push_back(fj);
	}
	return Json(Json::Object{{"index", p.index}, {"gcode", p.gcode}, {"md5", p.md5}, {"minutes", p.minutes},
	                         {"grams", p.grams}, {"layers", p.layers}, {"supports", p.supports}, {"filaments", filaments}});
}
Json to_json(const Progress &p) {
	return Json(Json::Object{{"stage", p.stage}, {"percent", p.percent}, {"message", p.message}});
}

Json to_json(const PresetRef &r) {
	return Json(Json::Object{{"kind", kind_name(r.kind)}, {"name", r.name}, {"source", r.source}});
}

Json to_json(const Project &p, const std::map<std::string, MeshInfo> &meshes) {
	if (!p.source_json.empty()) return Json::parse(p.source_json);
	Json extras = Json::object();
	for (const auto &kv : p.extras) extras[kv.first] = kv.second;
	Json filaments_sel = Json::array();
	for (const auto &f : p.presets.filaments) filaments_sel.push_back(to_json(f));
	Json presets(Json::Object{{"printer", to_json(p.presets.printer)}, {"process", to_json(p.presets.process)}, {"filaments", filaments_sel}});
	Json filaments = Json::array();
	for (const auto &f : p.filaments) {
		size_t i = static_cast<size_t>(std::max(1, f.index) - 1);
		Json preset = i < p.presets.filaments.size() ? to_json(p.presets.filaments[i]) : Json();
		filaments.push_back(Json(Json::Object{{"index", f.index}, {"preset", preset}, {"color", f.color}, {"type", f.type}}));
	}
	Json plates = Json::array();
	for (const auto &pl : p.plates) {
		Json instances = Json::array();
		for (const auto &r : pl.instances) instances.push_back(Json(Json::Object{{"objectId", r.object_id}, {"instanceId", r.instance_id}}));
		Json pj(Json::Object{{"index", pl.index}, {"name", pl.name}, {"locked", pl.locked}, {"instances", instances}, {"config", to_json(pl.config)}});
		if (!pl.bed_type.empty()) pj["bedType"] = pl.bed_type;
		if (!pl.print_sequence.empty()) pj["printSequence"] = pl.print_sequence;
		if (pl.spiral_vase) pj["spiralVase"] = true;
		plates.push_back(pj);
	}
	Json objects = Json::array();
	for (const auto &o : p.objects) {
		Json parts = Json::array(), instances = Json::array(), ranges = Json::array();
		for (const auto &pt : o.parts) {
			Json pj(Json::Object{{"id", pt.id}, {"name", pt.name}, {"type", part_type_name(pt.type)}, {"mesh", pt.mesh},
			                     {"transform", to_json(pt.transform)}, {"config", to_json(pt.config)}});
			if (pt.filament > 0) pj["filament"] = pt.filament;
			parts.push_back(pj);
		}
		for (const auto &in : o.instances)
			instances.push_back(Json(Json::Object{{"id", in.id}, {"transform", to_json(in.transform)}, {"printable", in.printable}}));
		for (const auto &r : o.height_ranges)
			ranges.push_back(Json(Json::Object{{"minZ", r.min_z}, {"maxZ", r.max_z}, {"config", to_json(r.config)}}));
		objects.push_back(Json(Json::Object{{"id", o.id}, {"name", o.name}, {"parts", parts}, {"instances", instances},
		                                    {"config", to_json(o.config)}, {"heightRanges", ranges}, {"printable", o.printable}}));
	}
	Json mesh_refs = Json::object();
	for (const auto &kv : p.meshes) {
		auto info = meshes.find(kv.first);
		Json bbox = Json::array();
		size_t triangles = 0;
		if (info != meshes.end()) {
			for (double v : info->second.bbox) bbox.push_back(v);
			triangles = info->second.triangles;
		} else
			for (int i = 0; i < 6; ++i) bbox.push_back(0);
		mesh_refs[kv.first] = Json(Json::Object{{"id", kv.first},
		                                        {"triangles", static_cast<double>(triangles)},
		                                        {"vertices", static_cast<double>(triangles * 3)},
		                                        {"bbox", bbox},
		                                        {"storage", Json(Json::Object{{"kind", "file"}, {"path", kv.second.path}})}});
	}
	return Json(Json::Object{{"format", 1},
	                         {"meta", Json(Json::Object{{"title", p.title}, {"application", "Print Lab Slicer"}, {"extras", extras}})},
	                         {"presets", presets},
	                         {"projectConfig", to_json(p.project_config)},
	                         {"filaments", filaments},
	                         {"plates", plates},
	                         {"objects", objects},
	                         {"meshes", mesh_refs},
	                         {"passthrough", Json::object()}});
}

calib::Request calib_request_from(const Json &params, const std::string &where) {
	calib::Request r;
	r.kind = calib::kind_from(need_string(params, "kind", where));
	const Json &p = params["params"];
	if (!p.is_null() && !p.is_object()) bad(at(where, "params"), "expected an object");
	r.start = opt_number(p, "start", 0);
	r.end = opt_number(p, "end", 0);
	r.step = opt_number(p, "step", 0);
	r.pass = static_cast<int>(opt_number(p, "pass", 1));
	r.linear = opt_bool(p, "linear", false);
	r.print_numbers = opt_bool(p, "printNumbers", true);
	return r;
}

Json to_json(const CalibResult &r) {
	Json steps = Json::array();
	for (const auto &s : r.steps) {
		Json sj(Json::Object{{"value", s.value}, {"label", s.label}});
		if (s.z_max > s.z_min) {
			sj["zMin"] = s.z_min;
			sj["zMax"] = s.z_max;
		}
		steps.push_back(sj);
	}
	Json out(Json::Object{{"projectId", r.project_id}, {"project", to_json(r.project, r.meshes)}, {"title", r.title}, {"steps", steps}});
	if (r.base_flow_ratio > 0) out["baseFlowRatio"] = r.base_flow_ratio;
	return out;
}

Json to_json(const preview::Header &h) {
	Json bbox = Json::array(), features = Json::array(), tools = Json::array(), layers = Json::array();
	for (double n : h.bbox) bbox.push_back(n);
	for (const auto &name : preview::features()) features.push_back(name);
	for (const auto &t : h.tools)
		tools.push_back(Json(Json::Object{{"index", t.index}, {"color", t.color}, {"type", t.type}}));
	for (const auto &l : h.layers)
		layers.push_back(Json(Json::Object{{"z", l.z}, {"height", l.height}, {"seconds", l.seconds ? Json(*l.seconds) : Json()},
		                                  {"first", l.first}, {"count", l.count}}));
	return Json(Json::Object{{"version", 1}, {"plate", h.plate}, {"source", "engine"}, {"segments", h.segments},
	                         {"bbox", bbox}, {"features", features}, {"tools", tools}, {"layers", layers},
	                         {"totalSeconds", h.total_seconds ? Json(*h.total_seconds) : Json()}});
}

} // namespace printlab
