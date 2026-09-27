// Behavioural port of app/src/lib/server/slicer3mf/write.ts. Every extension retained by the app
// is written back into Bambu's archive layout; unknown archive entries retain their exact bytes.
// origin: BambuStudio src/libslic3r/Format/bbs_3mf.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
#include "common.hpp"
#include "layer_profile.hpp"

namespace printlab::project_io {
namespace {
const std::string HEAD = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
const std::string OPEN =
	"<model unit=\"millimeter\" xml:lang=\"en-US\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\" "
	"xmlns:BambuStudio=\"http://schemas.bambulab.com/package/2021\" "
	"xmlns:p=\"http://schemas.microsoft.com/3dmanufacturing/production/2015/06\" requiredextensions=\"p\">\n";
const std::string REL = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
std::string meta(const std::string &key, const std::string &value) {
	return "<metadata key=\"" + escape(key) + "\" value=\"" + escape(value) + "\"/>\n";
}
std::string hex8(unsigned id) {
	std::ostringstream out;
	out << std::hex << std::setfill('0') << std::setw(8) << id;
	return out.str();
}
std::string subtype(const Json &part) {
	const auto type = str(part["type"]);
	return type == "negative"			? "negative_part"
		   : type == "modifier"			? "modifier_part"
		   : type == "support_blocker"	? "support_blocker"
		   : type == "support_enforcer" ? "support_enforcer"
										: "normal_part";
}
std::string mesh_xml(int id, const Json &part, const Mesh &mesh) {
	std::string out = "<object id=\"" + std::to_string(id) + "\" p:UUID=\"" + hex8(id) +
					  "-81cb-4c03-9d28-80fed5dfa1dc\" type=\"" + (str(part["type"]) == "model" ? "model" : "other") +
					  "\"><mesh><vertices>\n";
	for (const auto &p : mesh.vertices)
		out += "<vertex x=\"" + format(p[0], 9) + "\" y=\"" + format(p[1], 9) + "\" z=\"" + format(p[2], 9) + "\"/>\n";
	out += "</vertices><triangles>\n";
	for (size_t i = 0; i < mesh.triangles.size(); ++i) {
		const auto &t = mesh.triangles[i];
		out += "<triangle v1=\"" + std::to_string(t[0]) + "\" v2=\"" + std::to_string(t[1]) + "\" v3=\"" +
			   std::to_string(t[2]) + "\"";
		for (const auto &kv : PAINT) {
			std::string value = str(part["paint"][kv.first][std::to_string(i)]);
			if (!value.empty())
				out += " " + kv.second + "=\"" + escape(value) + "\"";
		}
		std::string face = str(part["faceProperties"][std::to_string(i)]);
		if (!face.empty())
			out += " face_property=\"" + escape(face) + "\"";
		out += "/>\n";
	}
	return out + "</triangles></mesh></object>\n";
}
void fragment(const std::string &value) {
	XmlParser("<fragment>" + value + "</fragment>").parse();
}
} // namespace
Files write(const Json &project, const LoadMesh &load,
			const std::function<std::string(const std::string &)> &read_file) {
	const auto &objects = array(project["objects"]);
	if (objects.empty())
		throw std::invalid_argument("Add something to the project before saving it.");
	struct Sub {
		int id;
		std::string mesh, file;
		const Json *part;
	};
	std::vector<Sub> subs;
	std::map<std::string, size_t> keys;
	std::map<const Json *, size_t> part_sub;
	std::set<int> taken;
	struct Pending {
		std::string key, file;
		const Json *part;
	};
	std::vector<Pending> pending;
	for (size_t i = 0; i < objects.size(); ++i)
		for (const auto &p : array(objects[i]["parts"])) {
			std::string file = "3D/Objects/object_" + std::to_string(i + 1) + ".model";
			std::string key = str(p["mesh"]) + "#" + (p.has("sourceId") ? p["sourceId"].dump() : "new") + "#" +
							  p["paint"].dump() + p["faceProperties"].dump();
			if (keys.count(key)) {
				part_sub[&p] = keys.at(key);
				continue;
			}
			int want = p["sourceId"].is_number() ? int(p["sourceId"].as_int()) : 0;
			if (want > 0 && !taken.count(want)) {
				taken.insert(want);
				keys[key] = subs.size();
				part_sub[&p] = subs.size();
				subs.push_back({want, str(p["mesh"]), file, &p});
			} else
				pending.push_back({key, file, &p});
		}
	int next = taken.empty() ? 1 : *taken.rbegin() + 1;
	for (const auto &p : pending) {
		if (keys.count(p.key)) {
			part_sub[p.part] = keys.at(p.key);
			continue;
		}
		keys[p.key] = subs.size();
		part_sub[p.part] = subs.size();
		subs.push_back({next++, str((*p.part)["mesh"]), p.file, p.part});
	}
	std::vector<int> top_ids(objects.size());
	taken.clear();
	for (size_t i = 0; i < objects.size(); ++i) {
		int want = objects[i]["sourceId"].is_number() ? int(objects[i]["sourceId"].as_int()) : 0;
		if (want > 0 && !taken.count(want)) {
			top_ids[i] = want;
			taken.insert(want);
		}
	}
	next = std::max(next, taken.empty() ? 1 : *taken.rbegin() + 1);
	for (auto &id : top_ids)
		if (!id)
			id = next++;
	Files out;
	std::map<std::string, std::vector<const Sub *>> by_file;
	for (const auto &s : subs)
		by_file[s.file].push_back(&s);
	for (const auto &entry : by_file) {
		std::string body = HEAD + OPEN + "<metadata name=\"BambuStudio:3mfVersion\">1</metadata><resources>\n";
		for (const auto *s : entry.second)
			body += mesh_xml(s->id, *s->part, load(s->mesh));
		out[entry.first] = body + "</resources><build/></model>\n";
	}
	std::map<std::string, std::string> model_meta;
	model_meta["BambuStudio:3mfVersion"] = "1";
	for (const auto &kv : fields(project["meta"]["extras"]))
		model_meta[kv.first] = str(kv.second);
	for (const auto &kv : META)
		if (project["meta"].has(kv.first))
			model_meta[kv.second] = str(project["meta"][kv.first]);
	std::string model = HEAD + OPEN;
	for (const auto &kv : model_meta)
		model += "<metadata name=\"" + escape(kv.first) + "\">" + escape(escape(kv.second)) + "</metadata>\n";
	model += "<resources>\n";
	for (size_t i = 0; i < objects.size(); ++i) {
		model += "<object id=\"" + std::to_string(top_ids[i]) + "\" p:UUID=\"" + hex8(unsigned(i + 1)) +
				 "-61cb-4c03-9d28-80fed5dfa1dc\" type=\"model\"><components>\n";
		size_t k = 0;
		for (const auto &p : array(objects[i]["parts"])) {
			const auto &s = subs.at(part_sub.at(&p));
			model += "<component p:path=\"/" + escape(s.file) + "\" objectid=\"" + std::to_string(s.id) +
					 "\" p:UUID=\"" + hex8(unsigned(((i + 1) << 16) | k++)) +
					 "-b206-40ff-9872-83e8017abed1\" transform=\"" + values(p["transform"]) + "\"/>\n";
		}
		model += "</components></object>\n";
	}
	model += "</resources><build p:UUID=\"2c7c17d8-22b5-4d84-8835-1976022ea369\">\n";
	size_t item = 0;
	for (size_t i = 0; i < objects.size(); ++i)
		for (const auto &in : array(objects[i]["instances"]))
			model += "<item objectid=\"" + std::to_string(top_ids[i]) + "\" p:UUID=\"" + hex8(unsigned(++item)) +
					 "-b1ec-4553-aec9-835e5b724bb4\" transform=\"" + values(in["transform"]) + "\" printable=\"" +
					 ((in["printable"] == Json(false) || objects[i]["printable"] == Json(false)) ? "0" : "1") +
					 "\"/>\n";
	out[MODEL] = model + "</build></model>\n";
	std::string rels =
		HEAD + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n";
	size_t rel = 0;
	for (const auto &entry : by_file)
		rels += "<Relationship Target=\"/" + escape(entry.first) + "\" Id=\"rel-" + std::to_string(++rel) +
				"\" Type=\"" + REL + "\"/>\n";
	out[MODEL_RELS] = rels + "</Relationships>\n";
	std::string settings = HEAD + "<config>\n";
	for (size_t i = 0; i < objects.size(); ++i) {
		const auto &o = objects[i];
		settings += "<object id=\"" + std::to_string(top_ids[i]) + "\">\n" + meta("name", str(o["name"]));
		if (o["extras"].has("module"))
			settings += meta("module", str(o["extras"]["module"]));
		for (const auto &kv : fields(o["config"]))
			settings += meta(kv.first, config_text(kv.second));
		for (const auto &p : array(o["parts"])) {
			settings +=
				"<part id=\"" + std::to_string(subs.at(part_sub.at(&p)).id) + "\" subtype=\"" + subtype(p) + "\"";
			if (p.has("uuid"))
				settings += " uuid=\"" + escape(str(p["uuid"])) + "\"";
			settings += ">\n" + meta("name", str(p["name"]));
			for (const auto &kv : fields(p["source"]))
				settings += meta(kv.first, str(kv.second));
			if (p.has("filament"))
				settings += meta("extruder", p["filament"].dump());
			for (const auto &kv : fields(p["config"]))
				settings += meta(kv.first, config_text(kv.second));
			if (p.has("text")) {
				settings += "<text_info";
				for (const auto &kv : fields(p["text"]))
					settings += " " + kv.first + "=\"" + escape(str(kv.second)) + "\"";
				settings += "/>\n";
			}
			for (const auto &x : array(p["xml"])) {
				fragment(str(x));
				settings += str(x) + "\n";
			}
			settings += "</part>\n";
		}
		settings += "</object>\n";
	}
	std::map<std::string, size_t> object_indices;
	for (size_t i = 0; i < objects.size(); ++i)
		object_indices[str(objects[i]["id"])] = i;
	const std::map<std::string, std::string> plate_keys = {{"bedType", "bed_type"},
														   {"printSequence", "print_sequence"},
														   {"spiralVase", "spiral_mode"},
														   {"filamentMapMode", "filament_map_mode"},
														   {"thumbnail", "thumbnail_file"}};
	const std::map<std::string, std::string> plate_lists = {{"filamentMaps", "filament_maps"},
															{"firstLayerSequence", "first_layer_print_sequence"},
															{"otherLayersSequence", "other_layers_print_sequence"}};
	for (const auto &p : array(project["plates"])) {
		settings += "<plate>\n" + meta("plater_id", p["index"].dump()) + meta("plater_name", str(p["name"])) +
					meta("locked", p["locked"].dump());
		for (const auto &kv : plate_keys)
			if (p.has(kv.first))
				settings += meta(kv.second, config_text(p[kv.first]));
		for (const auto &kv : plate_lists)
			if (p.has(kv.first))
				settings += meta(kv.second, values(p[kv.first]));
		for (const auto &kv : fields(p["config"]))
			settings += meta(kv.first, config_text(kv.second));
		for (const auto &ref : array(p["instances"])) {
			auto found = object_indices.find(str(ref["objectId"]));
			if (found == object_indices.end())
				throw std::invalid_argument("Plate refers to an unknown object.");
			size_t oi = found->second;
			const auto &instances = array(objects[oi]["instances"]);
			auto it = std::find_if(instances.begin(), instances.end(),
								   [&](const Json &in) { return in["id"] == ref["instanceId"]; });
			if (it == instances.end())
				throw std::invalid_argument("Plate refers to an unknown instance.");
			settings += "<model_instance>\n" + meta("object_id", std::to_string(top_ids[oi])) +
						meta("instance_id", std::to_string(it - instances.begin()));
			if (it->has("identifyId"))
				settings += meta("identify_id", (*it)["identifyId"].dump());
			settings += "</model_instance>\n";
		}
		settings += "</plate>\n";
	}
	for (const auto &x : array(project["modelSettingsXml"])) {
		fragment(str(x));
		settings += str(x) + "\n";
	}
	out[SETTINGS] = settings + "</config>\n";
	Json config = project["projectConfig"].is_object() ? project["projectConfig"] : Json::object();
	if (!str(project["presets"]["printer"]["name"]).empty())
		config["printer_settings_id"] = project["presets"]["printer"]["name"];
	if (!str(project["presets"]["process"]["name"]).empty())
		config["print_settings_id"] = project["presets"]["process"]["name"];
	Json slots = project["filaments"];
	if (!slots.size())
		for (const auto &ref : array(project["presets"]["filaments"]))
			slots.push_back(object({{"preset", ref}, {"color", ""}, {"type", ""}}));
	if (slots.size()) {
		config["filament_settings_id"] = Json::array();
		config["filament_colour"] = Json::array();
		config["filament_type"] = Json::array();
		for (const auto &f : array(slots)) {
			config["filament_settings_id"].push_back(f["preset"]["name"]);
			config["filament_colour"].push_back(f["color"]);
			config["filament_type"].push_back(f["type"]);
		}
	}
	if (config.size())
		out[CONFIG] = config.dump() + "\n";
	std::string heights, ranges, cut;
	for (size_t i = 0; i < objects.size(); ++i) {
		const auto &o = objects[i];
		std::string id = std::to_string(i + 1);
		if (o["layerHeightProfile"].size() >= 4)
			heights += "object_id=" + id + "|" + values(studio_layer_profile(o["layerHeightProfile"]), ";") + "\n";
		if (o["heightRanges"].size()) {
			ranges += "<object id=\"" + id + "\">\n";
			for (const auto &r : array(o["heightRanges"])) {
				ranges += "<range min_z=\"" + r["minZ"].dump() + "\" max_z=\"" + r["maxZ"].dump() + "\">\n";
				for (const auto &kv : fields(r["config"]))
					ranges += "<option opt_key=\"" + escape(kv.first) + "\">" + escape(config_text(kv.second)) +
							  "</option>\n";
				ranges += "</range>\n";
			}
			ranges += "</object>\n";
		}
		if (o.has("cutInfo")) {
			fragment(str(o["cutInfo"]));
			cut += "<object id=\"" + id + "\">" + str(o["cutInfo"]) + "</object>\n";
		}
	}
	if (!heights.empty())
		out[HEIGHTS] = heights;
	if (!ranges.empty())
		out[RANGES] = HEAD + "<objects>\n" + ranges + "</objects>\n";
	if (!cut.empty())
		out[CUT] = HEAD + "<objects>\n" + cut + "</objects>\n";
	std::string gcodes;
	Json sequence = Json::object();
	for (const auto &p : array(project["plates"])) {
		if (p.has("customGcode")) {
			gcodes += "<plate><plate_info id=\"" + p["index"].dump() + "\"/>\n";
			for (const auto &g : array(p["customGcode"]["items"])) {
				int type = int(g["type"].as_int());
				std::string legacy = type == 1	 ? config_text(config["machine_pause_gcode"])
									 : type == 4 ? config_text(config["template_custom_gcode"])
									 : type == 3 ? "tool_change"
												 : str(g["extra"]);
				gcodes += "<layer top_z=\"" + g["topZ"].dump() + "\" type=\"" + g["type"].dump() + "\" extruder=\"" +
						  g["extruder"].dump() + "\" color=\"" + escape(str(g["color"])) + "\" extra=\"" +
						  escape(str(g["extra"])) + "\" gcode=\"" + escape(legacy) + "\"/>\n";
			}
			if (p["customGcode"].has("mode"))
				gcodes += "<mode value=\"" + escape(str(p["customGcode"]["mode"])) + "\"/>\n";
			gcodes += "</plate>\n";
		}
		if (p.has("filamentSequence"))
			sequence["plate_" + p["index"].dump()] = p["filamentSequence"];
	}
	if (!gcodes.empty())
		out[GCODES] = HEAD + "<custom_gcodes_per_layer>\n" + gcodes + "</custom_gcodes_per_layer>\n";
	if (sequence.size())
		out[SEQUENCE] = sequence.dump();
	bool own = false;
	Json lab_profiles = Json::array();
	bool has_profiles = false;
	for (const auto &o : array(project["objects"])) {
		bool keep = two_point_profile(o["layerHeightProfile"]);
		lab_profiles.push_back(keep ? o["layerHeightProfile"] : Json());
		has_profiles |= keep;
	}
	own |= has_profiles;
	auto plain = [](const Json &ref) { return ref["source"] == Json("project") && !ref.has("userPresetId"); };
	for (const auto *kind : {"printer", "process"})
		own |= !plain(project["presets"][kind]);
	for (const auto &ref : array(project["presets"]["filaments"]))
		own |= !plain(ref);
	Json lab_slots = Json::array(), lab_refs = Json::array();
	for (const auto &f : array(project["filaments"])) {
		Json extras = Json::object();
		for (const auto *k : {"tray", "spoolId", "nozzle"})
			if (f.has(k)) {
				extras[k] = f[k];
				own = true;
			}
		lab_slots.push_back(extras.size() ? extras : Json());
		lab_refs.push_back(f["preset"]);
	}
	if (own) {
		Json lab = object({{"format", 1},
						   {"presets", object({{"printer", project["presets"]["printer"]},
											   {"process", project["presets"]["process"]},
											   {"filaments", lab_refs}})},
						   {"filaments", lab_slots}});
		if (has_profiles)
			lab["layerHeightProfiles"] = lab_profiles;
		out[LAB] = lab.dump();
	}
	for (const auto &kv : fields(project["passthrough"]))
		if (!out.count(kv.first))
			out[kv.first] =
				kv.second.has("base64") ? unbase64(str(kv.second["base64"])) : read_file(str(kv.second["path"]));
	if (!out.count("[Content_Types].xml"))
		out["[Content_Types].xml"] =
			HEAD +
			"<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" "
			"ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"model\" "
			"ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/><Default Extension=\"png\" "
			"ContentType=\"image/png\"/><Default Extension=\"gcode\" ContentType=\"text/x.gcode\"/></Types>";
	if (!out.count(RELS)) {
		std::string r =
			HEAD +
			"<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship "
			"Target=\"/3D/3dmodel.model\" Id=\"rel-1\" Type=\"" +
			REL + "\"/>";
		for (const auto &p : array(project["plates"]))
			if (p.has("thumbnail") && out.count(str(p["thumbnail"]))) {
				r += "<Relationship Target=\"/" + escape(str(p["thumbnail"])) +
					 "\" Id=\"rel-2\" "
					 "Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail\"/>";
				break;
			}
		out[RELS] = r + "</Relationships>";
	}
	return out;
}
} // namespace printlab::project_io
