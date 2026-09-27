#pragma once
#include "project.hpp"
#include "xml.hpp"
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <set>
#include <sstream>

namespace printlab::project_io {
inline constexpr const char *MODEL = "3D/3dmodel.model", *SETTINGS = "Metadata/model_settings.config",
							*CONFIG = "Metadata/project_settings.config",
							*HEIGHTS = "Metadata/layer_heights_profile.txt",
							*RANGES = "Metadata/layer_config_ranges.xml", *CUT = "Metadata/cut_information.xml",
							*GCODES = "Metadata/custom_gcode_per_layer.xml",
							*SEQUENCE = "Metadata/filament_sequence.json", *LAB = "Metadata/print_lab.json",
							*RELS = "_rels/.rels", *MODEL_RELS = "3D/_rels/3dmodel.model.rels";
inline const std::map<std::string, std::string> META = {{"title", "Title"},
														{"designer", "Designer"},
														{"license", "License"},
														{"origin", "Origin"},
														{"description", "Description"},
														{"application", "Application"},
														{"createdAt", "CreationDate"},
														{"modifiedAt", "ModificationDate"},
														{"sourceUrl", "SourceUrl"}};
inline const std::map<std::string, std::string> PAINT = {{"supports", "paint_supports"},
														 {"seam", "paint_seam"},
														 {"color", "paint_color"},
														 {"fuzzySkin", "paint_fuzzy_skin"}};
inline const std::set<std::string> SOURCE = {
	"matrix",			"source_file",	   "source_object_id", "source_volume_id", "source_offset_x",
	"source_offset_y",	"source_offset_z", "source_in_inches", "source_in_meters", "source_is_builtin_volume",
	"assembly_src_guid"};
inline const std::set<std::string> PRESET_KEYS = {"printer_settings_id", "print_settings_id", "filament_settings_id",
												  "filament_colour", "filament_type"};
inline const std::set<std::string> MODELLED = {MODEL,
											   MODEL_RELS,
											   SETTINGS,
											   CONFIG,
											   HEIGHTS,
											   RANGES,
											   CUT,
											   GCODES,
											   SEQUENCE,
											   LAB,
											   "Metadata/Slic3r_PE_model.config",
											   "Metadata/Slic3r_PE_layer_heights_profile.txt",
											   "Metadata/Prusa_Slicer_layer_config_ranges.xml"};
inline Json object(std::initializer_list<std::pair<const std::string, Json>> fields) {
	return Json(Json::Object(fields));
}
inline std::string str(const Json &j, const std::string &fallback = "") {
	return j.is_string() ? j.as_string() : fallback;
}
inline const Json::Array &array(const Json &j) {
	static const Json::Array empty;
	return j.is_array() ? j.as_array() : empty;
}
inline const Json::Object &fields(const Json &j) {
	static const Json::Object empty;
	return j.is_object() ? j.as_object() : empty;
}
inline std::string text(const Files &files, const std::string &name) {
	auto i = files.find(name);
	return i == files.end() ? "" : i->second;
}
inline std::string source_text(const Files &f, const std::string &a, const std::string &b) {
	return f.count(a) ? text(f, a) : text(f, b);
}
inline double number(const std::string &s) {
	size_t end;
	double n = std::stod(s, &end);
	while (end < s.size() && std::isspace(static_cast<unsigned char>(s[end])))
		++end;
	if (end != s.size() || !std::isfinite(n))
		throw std::invalid_argument("Invalid number in 3MF.");
	return n;
}
inline int integer(const std::string &s) {
	double n = number(s);
	if (n != std::floor(n) || n < -2147483648. || n > 2147483647.)
		throw std::invalid_argument("Invalid integer in 3MF.");
	return static_cast<int>(n);
}
inline std::string format(double n, int precision = 17) {
	if (!std::isfinite(n))
		throw std::invalid_argument("Non-finite project number.");
	std::ostringstream out;
	out.imbue(std::locale::classic());
	out << std::setprecision(precision) << n;
	return out.str();
}
inline Json identity() {
	return Json(Json::Array{1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0});
}
inline Json transform(const std::string &s) {
	if (s.empty())
		return identity();
	std::istringstream in(s);
	std::string word;
	Json t = Json::array();
	while (in >> word)
		t.push_back(number(word));
	if (t.size() != 12)
		throw std::invalid_argument("A 3MF transform must have 12 numbers.");
	return t;
}
inline Json compose(const Json &a, const Json &b) {
	Json out = Json::array();
	for (int r = 0; r < 4; ++r)
		for (int c = 0; c < 3; ++c) {
			double v = r == 3 ? b[9 + c].as_number() : 0;
			for (int k = 0; k < 3; ++k)
				v += a[r * 3 + k].as_number() * b[k * 3 + c].as_number();
			out.push_back(v);
		}
	return out;
}
inline std::string values(const Json &j, const std::string &separator = " ") {
	std::string out;
	for (const auto &v : array(j)) {
		if (!out.empty())
			out += separator;
		out += v.is_string() ? v.as_string() : v.dump();
	}
	return out;
}
inline std::string config_text(const Json &j) {
	return j.is_array() ? values(j, ",") : str(j, j.dump());
}
inline Json ints(const std::string &s) {
	std::istringstream in(s);
	std::string word;
	Json a = Json::array();
	while (in >> word)
		a.push_back(integer(word));
	return a;
}
inline std::map<std::string, std::string> metadata(const Xml &n) {
	std::map<std::string, std::string> out;
	for (const auto &c : n.children)
		if (c.name == "metadata" && c.attrs.count("key"))
			out[c.attr("key")] = c.attr("value");
	return out;
}
inline Json attrs(const Xml &n) {
	Json j = Json::object();
	for (const auto &a : n.attrs)
		j[a.first] = a.second;
	return j;
}
inline std::string part_type(const std::string &s) {
	if (s == "negative_part" || s == "NegativeVolume")
		return "negative";
	if (s == "modifier_part" || s == "ParameterModifier" || s == "1")
		return "modifier";
	if (s == "support_blocker" || s == "SupportBlocker")
		return "support_blocker";
	if (s == "support_enforcer" || s == "SupportEnforcer")
		return "support_enforcer";
	return "model";
}
inline std::string clean_path(std::string path) {
	if (!path.empty() && path.front() == '/')
		path.erase(0, 1);
	return path;
}
} // namespace printlab::project_io
