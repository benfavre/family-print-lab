// Behavioural port of app/src/lib/server/slicer3mf/read.ts, preserving source metadata instead of
// accepting the slicer's normalisation as a project edit.
// origin: BambuStudio src/libslic3r/Format/bbs_3mf.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
#include "common.hpp"
#include <regex>

namespace printlab::project_io {
namespace {
struct Doc {
	std::string path, source;
	Xml root;
	std::map<int, const Xml *> objects;
};
struct Leaf {
	const Doc *doc;
	const Xml *object;
	int id;
	Json matrix;
};
struct Geometry {
	Mesh mesh;
	Json paint = Json::object(), faces = Json::object();
};
Geometry scan(const Doc &doc, const Xml &node) {
	const Xml *raw = node.child("mesh");
	if (!raw)
		throw std::invalid_argument("Missing mesh.");
	auto parsed = XmlParser(doc.source.substr(raw->start, raw->end - raw->start), false).parse();
	Geometry g;
	const Xml *vertices = parsed.child("vertices"), *triangles = parsed.child("triangles");
	if (!vertices || !triangles)
		throw std::invalid_argument("Mesh has no vertices or triangles.");
	for (const auto &v : vertices->children)
		if (v.name == "vertex") {
			std::array<float, 3> p{float(number(v.attr("x"))), float(number(v.attr("y"))), float(number(v.attr("z")))};
			for (float n : p)
				if (!std::isfinite(n))
					throw std::invalid_argument("Mesh coordinate is too large.");
			g.mesh.vertices.push_back(p);
		}
	for (const auto &t : triangles->children)
		if (t.name == "triangle") {
			std::array<unsigned, 3> tri{};
			for (int k = 0; k < 3; ++k) {
				int id = integer(t.attr("v" + std::to_string(k + 1)));
				if (id < 0 || size_t(id) >= g.mesh.vertices.size())
					throw std::invalid_argument("Bad triangle index.");
				tri[k] = unsigned(id);
			}
			std::string index = std::to_string(g.mesh.triangles.size());
			for (const auto &kv : PAINT) {
				std::string alias = kv.first == "supports" ? "slic3rpe:custom_supports"
									: kv.first == "seam"   ? "slic3rpe:custom_seam"
									: kv.first == "color"  ? "slic3rpe:mmu_segmentation"
														   : "";
				auto value = t.attr(kv.second, t.attr(alias));
				if (!value.empty())
					g.paint[kv.first][index] = value;
			}
			if (!t.attr("face_property").empty())
				g.faces[index] = t.attr("face_property");
			g.mesh.triangles.push_back(tri);
		}
	if (g.mesh.triangles.empty())
		throw std::invalid_argument("Empty project mesh.");
	return g;
}
Json preset(const char *kind, const std::string &name) {
	return object({{"kind", kind}, {"name", name}, {"source", "project"}});
}
void project_config(Json &project, const Files &files) {
	Json raw = text(files, CONFIG).empty() ? Json::object() : Json::parse(text(files, CONFIG));
	auto list = [](const Json &v) {
		Json a = Json::array();
		if (v.is_array())
			for (const auto &e : v.as_array())
				a.push_back(str(e));
		else if (v.is_string() && !v.as_string().empty())
			a.push_back(v);
		return a;
	};
	Json ids = list(raw["filament_settings_id"]), colours = list(raw["filament_colour"]),
		 types = list(raw["filament_type"]);
	Json presets = object({{"printer", preset("printer", str(raw["printer_settings_id"]))},
						   {"process", preset("process", str(raw["print_settings_id"]))},
						   {"filaments", Json::array()}});
	Json slots = Json::array();
	for (size_t i = 0; i < std::max({ids.size(), colours.size(), types.size()}); ++i) {
		auto ref = preset("filament", i < ids.size() ? str(ids[i]) : "");
		presets["filaments"].push_back(ref);
		slots.push_back(object({{"index", i + 1},
								{"preset", ref},
								{"color", i < colours.size() ? str(colours[i]) : ""},
								{"type", i < types.size() ? str(types[i]) : ""}}));
	}
	Json config = Json::object();
	for (const auto &kv : fields(raw))
		if (!PRESET_KEYS.count(kv.first)) {
			if (kv.second.is_array()) {
				Json a = Json::array();
				for (const auto &v : kv.second.as_array())
					a.push_back(v.is_string() ? v : Json(v.dump()));
				config[kv.first] = a;
			} else
				config[kv.first] = kv.second.is_string() ? kv.second : Json(kv.second.dump());
		}
	if (!text(files, LAB).empty()) {
		Json lab = Json::parse(text(files, LAB));
		if (lab["format"] == Json(1)) {
			auto keep = [](const Json &ref, const Json &saved) {
				return saved.is_object() && saved["kind"] == ref["kind"] && saved["name"] == ref["name"] ? saved : ref;
			};
			for (const auto *kind : {"printer", "process"})
				presets[kind] = keep(presets[kind], lab["presets"][kind]);
			for (size_t i = 0; i < slots.size(); ++i) {
				if (i < lab["presets"]["filaments"].size())
					presets["filaments"].as_array()[i] = keep(presets["filaments"][i], lab["presets"]["filaments"][i]);
				slots.as_array()[i]["preset"] = presets["filaments"][i];
				if (i < lab["filaments"].size())
					for (const auto *k : {"tray", "spoolId", "nozzle"})
						if (lab["filaments"][i].has(k))
							slots.as_array()[i][k] = lab["filaments"][i][k];
			}
		}
	}
	project["presets"] = presets;
	project["filaments"] = slots;
	project["projectConfig"] = config;
}
} // namespace
Json read(const Files &files, const StoreMesh &store) {
	std::string root_path = MODEL;
	if (!text(files, RELS).empty())
		for (const auto &r : XmlParser(text(files, RELS)).parse().children)
			if (r.name == "Relationship" &&
				r.attr("Type") == "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel")
				root_path = clean_path(r.attr("Target"));
	if (!files.count(root_path))
		throw std::invalid_argument("The 3MF has no root model.");
	std::map<std::string, Doc> docs;
	auto doc = [&](const std::string &name) -> Doc & {
		auto found = docs.find(name);
		if (found != docs.end())
			return found->second;
		if (!files.count(name))
			throw std::invalid_argument("Missing component model: " + name);
		Doc &d = docs[name];
		d.path = name;
		d.source = text(files, name);
		d.root = XmlParser(d.source).parse();
		const Xml *resources = d.root.child("resources");
		if (resources)
			for (const auto &o : resources->children)
				if (o.name == "object")
					d.objects[integer(o.attr("id"))] = &o;
		return d;
	};
	Doc &root = doc(root_path);
	Json meta = object({{"title", ""}}), extra = Json::object();
	for (const auto &m : root.root.children)
		if (m.name == "metadata") {
			std::string key = m.attr("name"), value = unescape(m.text, true);
			if (key.empty())
				continue;
			auto known = std::find_if(META.begin(), META.end(), [&](const auto &kv) { return kv.second == key; });
			if (known != META.end())
				meta[known->first] = value;
			else if (key != "BambuStudio:3mfVersion" || value != "1")
				extra[key] = value;
		}
	if (extra.size())
		meta["extras"] = extra;
	std::string settings_text = source_text(files, SETTINGS, "Metadata/Slic3r_PE_model.config");
	Xml settings;
	if (!settings_text.empty())
		settings = XmlParser(settings_text).parse();
	std::map<int, const Xml *> object_settings;
	std::vector<const Xml *> plate_settings;
	Json settings_xml = Json::array();
	for (const auto &s : settings.children) {
		if (s.name == "object")
			object_settings.emplace(integer(s.attr("id")), &s);
		else if (s.name == "plate")
			plate_settings.push_back(&s);
		else
			settings_xml.push_back(settings_text.substr(s.start, s.end - s.start));
	}
	std::vector<int> order;
	std::map<int, std::vector<const Xml *>> items;
	const Xml *build = root.root.child("build");
	if (build)
		for (const auto &i : build->children)
			if (i.name == "item") {
				int id = integer(i.attr("objectid"));
				if (!root.objects.count(id))
					throw std::invalid_argument("Build item refers to a missing object.");
				if (!items.count(id))
					order.push_back(id);
				items[id].push_back(&i);
			}
	if (order.empty())
		throw std::invalid_argument("The 3MF has nothing on its build plate.");
	std::function<void(Doc &, int, const Json &, std::vector<Leaf> &, int)> leaves;
	leaves = [&](Doc &d, int id, const Json &matrix, std::vector<Leaf> &out, int depth) {
		if (depth > 16)
			throw std::invalid_argument("The 3MF nests components too deeply.");
		if (!d.objects.count(id))
			throw std::invalid_argument("Missing component object.");
		const Xml *o = d.objects.at(id);
		if (o->child("mesh")) {
			out.push_back({&d, o, id, matrix});
			return;
		}
		if (const Xml *parts = o->child("components"))
			for (const auto &c : parts->children)
				if (c.name == "component") {
					Doc &target = c.attr("p:path").empty() ? d : doc(clean_path(c.attr("p:path")));
					leaves(target, integer(c.attr("objectid")), compose(transform(c.attr("transform")), matrix), out,
						   depth + 1);
				}
	};
	Json objects = Json::array(), mesh_refs = Json::object();
	std::map<int, size_t> top_indices;
	std::map<std::pair<std::string, int>, Geometry> geometry;
	for (int top_id : order) {
		size_t index = objects.size();
		std::string id = "o" + std::to_string(index + 1);
		top_indices[top_id] = index;
		const Xml &top = *root.objects.at(top_id);
		const Xml *settings = object_settings.count(top_id) ? object_settings[top_id] : nullptr;
		std::string name = top.attr("name", "Object_" + std::to_string(index + 1));
		Json config = Json::object(), extras = Json::object();
		if (settings)
			for (const auto &kv : metadata(*settings)) {
				if (kv.first == "name")
					name = kv.second;
				else if (kv.first == "module")
					extras[kv.first] = kv.second;
				else
					config[kv.first] = kv.second;
			}
		std::vector<Leaf> meshes;
		leaves(root, top_id, identity(), meshes, 0);
		std::vector<const Xml *> volumes;
		if (settings)
			for (const auto &v : settings->children)
				if (v.name == "part" || v.name == "volume")
					volumes.push_back(&v);
		bool ranged = std::any_of(volumes.begin(), volumes.end(),
								  [](const Xml *v) { return integer(v->attr("lastid", "0")) > 0; });
		if (ranged && meshes.size() != 1)
			throw std::invalid_argument("A project object mixes triangle ranges and parts.");
		Json parts = Json::array();
		size_t unnamed = 0;
		size_t count = ranged ? volumes.size() : meshes.size();
		for (size_t k = 0; k < count; ++k) {
			const Leaf &leaf = meshes[ranged ? 0 : k];
			auto key = std::make_pair(leaf.doc->path, leaf.id);
			if (!geometry.count(key))
				geometry[key] = scan(*leaf.doc, *leaf.object);
			Geometry g = geometry.at(key);
			const Xml *v = nullptr;
			if (ranged)
				v = volumes[k];
			else if (k < volumes.size() && integer(volumes[k]->attr("id", "-1")) == leaf.id)
				v = volumes[k];
			else
				for (const Xml *candidate : volumes)
					if (integer(candidate->attr("id", "-1")) == leaf.id) {
						v = candidate;
						break;
					}
			if (ranged) {
				int first = integer(v->attr("firstid", "0")), last = integer(v->attr("lastid", "0"));
				if (first < 0 || last < first || size_t(last) >= g.mesh.triangles.size())
					throw std::invalid_argument("A part lies outside its mesh.");
				g.mesh.triangles = std::vector<std::array<unsigned, 3>>(g.mesh.triangles.begin() + first,
																		g.mesh.triangles.begin() + last + 1);
				auto shift = [&](const Json &j) {
					Json out = Json::object();
					for (const auto &kv : fields(j)) {
						int n = integer(kv.first);
						if (n >= first && n <= last)
							out[std::to_string(n - first)] = kv.second;
					}
					return out;
				};
				for (auto &kv : g.paint.as_object())
					kv.second = shift(kv.second);
				g.faces = shift(g.faces);
			}
			// Canonicalisation drops unused vertices and merges equal vertices in first-use order.
			g.mesh = stl_mesh(canonical_stl(g.mesh));
			Json mesh_ref = store(g.mesh);
			std::string mesh_id = str(mesh_ref["id"]);
			mesh_refs[mesh_id] = mesh_ref;
			Json part = object({{"id", id + "-p" + std::to_string(k + 1)},
								{"sourceId", ranged ? int(k + 1) : leaf.id},
								{"name", ""},
								{"type", part_type(v ? v->attr("subtype") : "")},
								{"mesh", mesh_id},
								{"transform", leaf.matrix},
								{"config", Json::object()}});
			Json source = Json::object(), xml = Json::array();
			bool has_name = false;
			if (v) {
				if (v->attrs.count("uuid"))
					part["uuid"] = v->attr("uuid");
				for (const auto &kv : metadata(*v)) {
					const auto &key = kv.first, &value = kv.second;
					if (key == "name") {
						part["name"] = value;
						has_name = true;
					} else if (key == "volume_type" || key == "part_type")
						part["type"] = part_type(value);
					else if (key == "modifier") {
						if (value == "1")
							part["type"] = "modifier";
					} else if (key == "uuid")
						part["uuid"] = value;
					else if (key == "mesh_shared") {
					} else if (key == "extruder")
						part["filament"] = integer(value);
					else if (SOURCE.count(key))
						source[key] = value;
					else
						part["config"][key] = value;
				}
				for (const auto &c : v->children)
					if (c.name == "text_info")
						part["text"] = attrs(c);
					else if (c.name != "metadata")
						xml.push_back(settings_text.substr(c.start, c.end - c.start));
			}
			if (!has_name) {
				part["name"] = unnamed ? name + "_" + std::to_string(unnamed + 1) : name;
				++unnamed;
			}
			if (source.size())
				part["source"] = source;
			if (xml.size())
				part["xml"] = xml;
			for (auto it = g.paint.as_object().begin(); it != g.paint.as_object().end();)
				if (!it->second.size())
					it = g.paint.as_object().erase(it);
				else
					++it;
			if (g.paint.size())
				part["paint"] = g.paint;
			if (g.faces.size())
				part["faceProperties"] = g.faces;
			parts.push_back(part);
		}
		if (parts.size() == 0)
			throw std::invalid_argument("Project object has no mesh.");
		Json instances = Json::array();
		bool printable = false;
		for (const Xml *item : items.at(top_id)) {
			bool enabled = item->attr("printable") != "0" && item->attr("printable") != "false";
			printable |= enabled;
			instances.push_back(object({{"id", id + "-i" + std::to_string(instances.size() + 1)},
										{"transform", transform(item->attr("transform"))},
										{"printable", enabled}}));
		}
		Json obj = object({{"id", id},
						   {"sourceId", top_id},
						   {"name", name},
						   {"parts", parts},
						   {"instances", instances},
						   {"config", config},
						   {"heightRanges", Json::array()},
						   {"printable", printable}});
		if (extras.size())
			obj["extras"] = extras;
		objects.push_back(obj);
	}
	std::string heights = source_text(files, HEIGHTS, "Metadata/Slic3r_PE_layer_heights_profile.txt");
	std::istringstream lines(heights);
	std::string line;
	while (std::getline(lines, line)) {
		if (line.rfind("object_id=", 0) != 0)
			continue;
		auto sep = line.find('|');
		if (sep == std::string::npos)
			continue;
		int id = integer(line.substr(10, sep - 10));
		if (id < 1 || size_t(id) > objects.size())
			continue;
		std::string values = line.substr(sep + 1);
		std::replace(values.begin(), values.end(), ';', ' ');
		Json profile = Json::array();
		std::istringstream nums(values);
		std::string n;
		while (nums >> n)
			profile.push_back(number(n));
		if (profile.size() > 4 && profile.size() % 2 == 0)
			objects.as_array()[id - 1]["layerHeightProfile"] = profile;
	}
	for (const auto *file : {RANGES, CUT}) {
		std::string contents = file == std::string(RANGES)
								   ? source_text(files, RANGES, "Metadata/Prusa_Slicer_layer_config_ranges.xml")
								   : text(files, file);
		if (contents.empty())
			continue;
		for (const auto &o : XmlParser(contents).parse().children)
			if (o.name == "object") {
				int id = integer(o.attr("id"));
				if (id < 1 || size_t(id) > objects.size())
					continue;
				Json &target = objects.as_array()[id - 1];
				if (file == std::string(CUT))
					target["cutInfo"] = contents.substr(o.inner_start, o.inner_end - o.inner_start);
				else
					for (const auto &r : o.children)
						if (r.name == "range") {
							Json cfg = Json::object();
							for (const auto &opt : r.children)
								if (opt.name == "option")
									cfg[opt.attr("opt_key")] = opt.text;
							target["heightRanges"].push_back(object({{"minZ", number(r.attr("min_z"))},
																	 {"maxZ", number(r.attr("max_z"))},
																	 {"config", cfg}}));
						}
			}
	}
	Json plates = Json::array();
	std::set<int> indices;
	for (const Xml *p : plate_settings) {
		Json plate = object(
			{{"index", 0}, {"name", ""}, {"locked", false}, {"instances", Json::array()}, {"config", Json::object()}});
		for (const auto &kv : metadata(*p)) {
			const auto &k = kv.first, &v = kv.second;
			if (k == "plater_id")
				plate["index"] = integer(v);
			else if (k == "plater_name")
				plate["name"] = unescape(v, true);
			else if (k == "locked")
				plate["locked"] = (v == "true" || v == "1");
			else if (k == "bed_type")
				plate["bedType"] = v;
			else if (k == "print_sequence" && (v == "by layer" || v == "by object"))
				plate["printSequence"] = v;
			else if (k == "spiral_mode")
				plate["spiralVase"] = (v == "true" || v == "1");
			else if (k == "filament_map_mode")
				plate["filamentMapMode"] = v;
			else if (k == "filament_maps")
				plate["filamentMaps"] = ints(v);
			else if (k == "first_layer_print_sequence")
				plate["firstLayerSequence"] = ints(v);
			else if (k == "other_layers_print_sequence")
				plate["otherLayersSequence"] = ints(v);
			else if (k == "thumbnail_file")
				plate["thumbnail"] = v;
			else
				plate["config"][k] = v;
		}
		for (const auto &i : p->children)
			if (i.name == "model_instance") {
				auto m = metadata(i);
				if (!m.count("object_id") || !m.count("instance_id"))
					continue;
				int oi = integer(m["object_id"]), ii = integer(m["instance_id"]);
				if (!top_indices.count(oi))
					continue;
				Json &obj = objects.as_array()[top_indices.at(oi)];
				if (ii < 0 || size_t(ii) >= obj["instances"].size())
					continue;
				Json &inst = obj["instances"].as_array()[ii];
				if (m.count("identify_id"))
					inst["identifyId"] = integer(m["identify_id"]);
				Json ref = object({{"objectId", obj["id"]}, {"instanceId", inst["id"]}});
				if (std::find(plate["instances"].as_array().begin(), plate["instances"].as_array().end(), ref) ==
					plate["instances"].as_array().end())
					plate["instances"].push_back(ref);
			}
		plates.push_back(plate);
	}
	for (auto &plate : plates.as_array()) {
		int id = int(plate["index"].as_int());
		if (id > 0 && !indices.count(id))
			indices.insert(id);
		else
			plate["index"] = 0;
	}
	for (auto &plate : plates.as_array())
		if (plate["index"] == Json(0)) {
			int id = 1;
			while (indices.count(id))
				++id;
			plate["index"] = id;
			indices.insert(id);
		}
	if (!plates.size()) {
		Json refs = Json::array();
		for (const auto &o : objects.as_array())
			for (const auto &i : array(o["instances"]))
				refs.push_back(object({{"objectId", o["id"]}, {"instanceId", i["id"]}}));
		plates.push_back(
			object({{"index", 1}, {"name", ""}, {"locked", false}, {"instances", refs}, {"config", Json::object()}}));
	}
	std::sort(plates.as_array().begin(), plates.as_array().end(),
			  [](const Json &a, const Json &b) { return a["index"].as_int() < b["index"].as_int(); });
	if (!text(files, GCODES).empty()) {
		Xml gc = XmlParser(text(files, GCODES)).parse();
		std::vector<const Xml *> entries;
		for (const auto &c : gc.children)
			if (c.name == "plate")
				entries.push_back(&c);
		if (entries.empty())
			entries.push_back(&gc);
		for (const Xml *entry : entries) {
			int id = entry->name == "plate" && entry->child("plate_info")
						 ? integer(entry->child("plate_info")->attr("id"))
						 : 1;
			Json gcode = object({{"items", Json::array()}});
			for (const auto &c : entry->children) {
				if (c.name == "mode")
					gcode["mode"] = c.attr("value");
				if (c.name != "layer")
					continue;
				int type = c.attrs.count("type")			  ? integer(c.attr("type"))
						   : c.attr("gcode") == "M600"		  ? 0
						   : c.attr("gcode") == "M601"		  ? 1
						   : c.attr("gcode") == "tool_change" ? 3
															  : 2;
				std::string extra = c.attrs.count("type") ? c.attr("extra")
									: type == 1			  ? c.attr("color")
									: type == 2			  ? c.attr("gcode")
														  : "";
				gcode["items"].push_back(object({{"topZ", number(c.attr("top_z"))},
												 {"type", type},
												 {"extruder", integer(c.attr("extruder", "0"))},
												 {"color", c.attr("color")},
												 {"extra", extra}}));
			}
			for (auto &plate : plates.as_array())
				if (plate["index"] == Json(id))
					plate["customGcode"] = gcode;
		}
	}
	if (!text(files, SEQUENCE).empty()) {
		Json seq = Json::parse(text(files, SEQUENCE));
		for (auto &plate : plates.as_array()) {
			auto key = "plate_" + plate["index"].dump();
			if (seq[key].is_object())
				plate["filamentSequence"] = seq[key];
		}
	}
	Json passthrough = Json::object();
	for (const auto &kv : files) {
		const auto &name = kv.first;
		if (docs.count(name) || MODELLED.count(name) || name.back() == '/')
			continue;
		if (name.rfind("3D/", 0) == 0 && name.size() >= 6 && name.substr(name.size() - 6) == ".model")
			continue;
		if (name == RELS && root_path != MODEL)
			continue;
		passthrough[name] = object({{"base64", base64(kv.second)}});
	}
	Json project = object({{"format", 1},
						   {"meta", meta},
						   {"objects", objects},
						   {"meshes", mesh_refs},
						   {"plates", plates},
						   {"passthrough", passthrough}});
	if (settings_xml.size())
		project["modelSettingsXml"] = settings_xml;
	project_config(project, files);
	return project;
}
} // namespace printlab::project_io
