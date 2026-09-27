#include <atomic>
#include <cstdio>
#include <fstream>

#include <boost/filesystem.hpp>

#include "rpc/json.hpp"
#include "upstream.hpp"

namespace printlab::upstream {

using namespace Slic3r;

Transform3d to_transform3d(const Transform &t) {
	Transform3d m = Transform3d::Identity();
	for (int c = 0; c < 4; ++c)
		for (int r = 0; r < 3; ++r) m(r, c) = t[c * 3 + r];
	return m;
}

Transform from_transform3d(const Transform3d &m) {
	Transform t{};
	for (int c = 0; c < 4; ++c)
		for (int r = 0; r < 3; ++r) t[c * 3 + r] = m(r, c);
	return t;
}

DynamicPrintConfig to_config(const ConfigMap &map, const std::string &scratch_dir) {
	DynamicPrintConfig config;
	if (map.empty()) return config;
	static std::atomic<int> counter{0};
	boost::filesystem::create_directories(scratch_dir);
	std::string file = scratch_dir + "/config-" + std::to_string(counter++) + ".json";
	Json j = Json::object();
	for (const auto &kv : map) {
		if (const auto *s = std::get_if<std::string>(&kv.second)) j[kv.first] = *s;
		else {
			Json list = Json::array();
			for (const auto &v : std::get<std::vector<std::string>>(kv.second)) list.push_back(v);
			j[kv.first] = list;
		}
	}
	{
		std::ofstream out(file, std::ios::binary);
		out << j.dump();
	}
	std::map<std::string, std::string> key_values;
	std::string reason;
	// ConfigBase::load_from_json (Config.cpp): the loader Bambu Studio uses for preset files.
	config.load_from_json(file, ForwardCompatibilitySubstitutionRule::EnableSilent, key_values, reason);
	std::remove(file.c_str());
	if (!reason.empty())
		throw EngineError(err::INVALID_CONFIG, "Some settings could not be read.", reason);
	return config;
}

ConfigMap from_config(const ConfigBase &config) {
	ConfigMap out;
	for (const std::string &key : config.keys()) {
		const ConfigOption *opt = config.option(key);
		if (!opt) continue;
		// ConfigOptionString::serialize escapes for INI, not the JSON preset boundary.
		// ConfigOptionStrings::vserialize already returns raw strings (pinned Config.hpp).
		if (opt->type() == coString) out[key] = static_cast<const ConfigOptionString *>(opt)->value;
		else if (opt->is_vector()) out[key] = static_cast<const ConfigOptionVectorBase *>(opt)->vserialize();
		else out[key] = opt->serialize();
	}
	return out;
}

void restore_enum_maps(ConfigBase &config) {
	const ConfigDef *defs = config.def();
	if (!defs) return;
	for (const std::string &key : config.keys()) {
		ConfigOption *opt = config.option(key);
		if (!opt || opt->type() != coEnums) continue;
		const ConfigOptionDef *def = defs->get(key);
		if (!def || !def->enum_keys_map) continue;
		if (def->nullable) static_cast<ConfigOptionEnumsGenericNullable *>(opt)->keys_map = def->enum_keys_map;
		else static_cast<ConfigOptionEnumsGeneric *>(opt)->keys_map = def->enum_keys_map;
	}
}

} // namespace printlab::upstream
