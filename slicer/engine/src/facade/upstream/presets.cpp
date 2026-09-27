// Bambu Studio's system presets through upstream's own PresetBundle (the oracle for slicer-profiles):
// load_vendor_configs_from_json on <resources>/profiles, resolved configs from the loaded presets and
// the combined config from PresetBundle::full_config(). The inheritance chain and which preset set
// each key are read from the same JSON files, since PresetBundle keeps only the resolved result.
#include <fstream>
#include <sstream>

#include <boost/filesystem.hpp>

#include "rpc/json.hpp"
#include "upstream.hpp"
#include "version.hpp"

namespace printlab::upstream {

using namespace Slic3r;
namespace fs = boost::filesystem;

namespace {

const char *folder(PresetKind k) {
	switch (k) {
	case PresetKind::Printer: return "machine";
	case PresetKind::Process: return "process";
	case PresetKind::Filament: return "filament";
	}
	return "machine";
}

PresetCollection &collection(PresetBundle &b, PresetKind k) {
	switch (k) {
	case PresetKind::Printer: return b.printers;
	case PresetKind::Process: return b.prints;
	case PresetKind::Filament: return b.filaments;
	}
	return b.printers;
}

bool opt_instantiation(const Json &file) {
	return !(file["instantiation"].is_string() && file["instantiation"].as_string() == "false");
}

/** The raw preset files of a vendor folder, by kind and name (for chains and origins). */
struct RawPresets {
	std::map<std::string, Json> by_key; // "<folder>:<name>"
	explicit RawPresets(const std::string &vendor_dir) {
		for (PresetKind k : {PresetKind::Printer, PresetKind::Process, PresetKind::Filament}) {
			fs::path dir = fs::path(vendor_dir) / "BBL" / folder(k);
			if (!fs::exists(dir)) continue;
			for (auto &entry : fs::recursive_directory_iterator(dir)) {
				if (entry.path().extension() != ".json") continue;
				std::ifstream in(entry.path().string(), std::ios::binary);
				std::stringstream ss;
				ss << in.rdbuf();
				try {
					Json j = Json::parse(ss.str());
					if (j["name"].is_string()) by_key[std::string(folder(k)) + ":" + j["name"].as_string()] = j;
				} catch (const Json::ParseError &) {
				}
			}
		}
	}
	const Json *find(PresetKind k, const std::string &name) const {
		auto it = by_key.find(std::string(folder(k)) + ":" + name);
		return it == by_key.end() ? nullptr : &it->second;
	}
};

std::map<std::string, std::unique_ptr<RawPresets>> raw_cache;
std::mutex raw_mutex;

const RawPresets &raw(const std::string &vendor_dir) {
	std::lock_guard<std::mutex> lock(raw_mutex);
	auto &slot = raw_cache[vendor_dir];
	if (!slot) slot = std::make_unique<RawPresets>(vendor_dir);
	return *slot;
}

} // namespace

PresetBundle &UpstreamFacade::bundle(const std::string &vendor_dir_in) {
	std::string vendor_dir = vendor_dir_in.empty() ? resources_dir_ + "/profiles" : vendor_dir_in;
	std::lock_guard<std::mutex> lock(mutex_);
	auto &slot = bundles_[vendor_dir];
	if (!slot) {
		if (!fs::exists(fs::path(vendor_dir) / "BBL.json"))
			throw EngineError(err::PRESET_NOT_FOUND, "The slicer's printer profiles are missing.", vendor_dir + "/BBL.json");
		auto b = std::make_unique<PresetBundle>();
		try {
			b->load_vendor_configs_from_json(vendor_dir, PresetBundle::BBL_BUNDLE, PresetBundle::LoadConfigBundleAttribute::LoadSystem,
			                                 ForwardCompatibilitySubstitutionRule::EnableSilent);
		} catch (const std::exception &e) {
			throw EngineError(err::PRESET_NOT_FOUND, "The slicer's printer profiles could not be read.", e.what());
		}
		slot = std::move(b);
	}
	return *slot;
}

std::vector<PresetSummary> UpstreamFacade::profiles_list(PresetKind kind, const std::string &vendor_dir) {
	PresetBundle &b = bundle(vendor_dir);
	const RawPresets &files = raw(vendor_dir.empty() ? resources_dir_ + "/profiles" : vendor_dir);
	std::vector<PresetSummary> out;
	for (const Preset &p : collection(b, kind)) {
		if (!p.is_system) continue;
		PresetSummary s;
		s.kind = kind;
		s.name = p.name;
		const Json *file = files.find(kind, p.name);
		if (file && (*file)["inherits"].is_string()) s.inherits = (*file)["inherits"].as_string();
		s.instantiable = !file || opt_instantiation(*file);
		if (auto *cp = p.config.option<ConfigOptionStrings>("compatible_printers")) s.compatible_printers = cp->values;
		if (auto *cond = p.config.option<ConfigOptionString>("compatible_printers_condition"))
			if (!cond->value.empty()) s.compatible_condition = cond->value;
		if (kind == PresetKind::Printer) {
			if (auto *m = p.config.option<ConfigOptionString>("printer_model")) s.printer_model = m->value;
			if (auto *n = p.config.option("nozzle_diameter"))
				if (n->is_vector()) {
					auto values = static_cast<const ConfigOptionVectorBase *>(n)->vserialize();
					if (!values.empty()) s.nozzle = values.front();
				}
		}
		if (kind == PresetKind::Filament) {
			if (auto *t = p.config.option<ConfigOptionStrings>("filament_type"))
				if (!t->values.empty()) s.filament_type = t->values.front();
			if (!p.filament_id.empty()) s.filament_id = p.filament_id;
		}
		if (!p.setting_id.empty()) s.setting_id = p.setting_id;
		out.push_back(std::move(s));
	}
	return out;
}

ResolvedBundle UpstreamFacade::profiles_resolve(const PresetSelection &selection, const std::string &vendor_dir_in) {
	std::string vendor_dir = vendor_dir_in.empty() ? resources_dir_ + "/profiles" : vendor_dir_in;
	PresetBundle &b = bundle(vendor_dir);
	const RawPresets &files = raw(vendor_dir);

	auto resolve = [&](const PresetRef &ref) {
		if (ref.source != "system")
			throw EngineError(err::PRESET_NOT_FOUND, "Only Bambu Studio's own presets can be resolved here.", ref.name, ref.name);
		Preset *p = collection(b, ref.kind).find_preset(ref.name, false);
		if (!p || !p->is_system)
			throw EngineError(err::PRESET_NOT_FOUND, "That preset is not in Bambu Studio's profiles.", ref.name, ref.name);
		ResolvedPreset r;
		r.kind = ref.kind;
		r.name = ref.name;
		r.config = from_config(p->config);
		r.config.erase("inherits");
		// Chain and origins from the files, root last.
		for (std::string at = ref.name; !at.empty();) {
			const Json *file = files.find(ref.kind, at);
			if (!file || std::find(r.chain.begin(), r.chain.end(), at) != r.chain.end()) break;
			r.chain.push_back(at);
			at = (*file)["inherits"].is_string() ? (*file)["inherits"].as_string() : "";
		}
		for (auto it = r.chain.rbegin(); it != r.chain.rend(); ++it)
			for (const auto &kv : files.find(ref.kind, *it)->as_object())
				if (r.config.count(kv.first)) r.origin[kv.first] = *it;
		return r;
	};

	ResolvedBundle out;
	out.printer = resolve(selection.printer);
	out.process = resolve(selection.process);
	for (const PresetRef &f : selection.filaments) out.filaments.push_back(resolve(f));
	out.vendor_tag = PRINTLAB_UPSTREAM_TAG;
	if (!b.vendors.empty()) out.vendor_version = b.vendors.begin()->second.config_version.to_string();

	// The combined config exactly as Bambu Studio builds it for slicing (PresetBundle::full_config).
	std::lock_guard<std::mutex> lock(mutex_); // selections are bundle state
	b.printers.select_preset_by_name(selection.printer.name, true);
	b.prints.select_preset_by_name(selection.process.name, true);
	b.filament_presets.clear();
	for (const PresetRef &f : selection.filaments) b.filament_presets.push_back(f.name);
	if (!selection.filaments.empty()) b.filaments.select_preset_by_name(selection.filaments.front().name, true);
	out.full = from_config(b.full_config());
	return out;
}

} // namespace printlab::upstream
