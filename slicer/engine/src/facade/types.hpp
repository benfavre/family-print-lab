// Our own plain structs for what crosses the facade, mirroring app/src/lib/shared/slicer/protocol.ts,
// project.ts and profiles.ts. Nothing here names an upstream type: rpc/ converts JSON to these, the
// facade converts these to libslic3r's Model, DynamicPrintConfig and Print. When upstream's API
// changes, only facade/upstream/*.cpp changes.
#pragma once

#include <array>
#include <atomic>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace printlab {

/** 3MF transform, 12 numbers as in the `transform` attribute (m00 m01 m02 m10 … m32; row vectors). */
using Transform = std::array<double, 12>;
constexpr Transform IDENTITY = {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0};
using BBox = std::array<double, 6>;

/** Upstream serialises every option as text; per-filament/per-extruder options are arrays. */
using ConfigValue = std::variant<std::string, std::vector<std::string>>;
using ConfigMap = std::map<std::string, ConfigValue>;

enum class PresetKind { Printer, Process, Filament };

struct PresetRef {
	PresetKind kind = PresetKind::Printer;
	std::string name;
	std::string source = "system"; // system | user | project
};
struct PresetSelection {
	PresetRef printer;
	PresetRef process;
	std::vector<PresetRef> filaments;
};

struct ResolvedPreset {
	PresetKind kind = PresetKind::Printer;
	std::string name;
	std::vector<std::string> chain;
	ConfigMap config;
	std::map<std::string, std::string> origin;
};
struct ResolvedBundle {
	ResolvedPreset printer;
	ResolvedPreset process;
	std::vector<ResolvedPreset> filaments;
	ConfigMap full;
	std::string vendor_tag;
	std::string vendor_version;
};
struct PresetSummary {
	PresetKind kind = PresetKind::Printer;
	std::string name;
	std::optional<std::string> inherits;
	bool instantiable = true;
	std::vector<std::string> compatible_printers;
	std::optional<std::string> compatible_condition;
	std::optional<std::string> printer_model, nozzle, filament_type, filament_id, setting_id;
};

struct MeshInfo {
	std::string mesh_id;
	size_t triangles = 0;
	BBox bbox{};
	int edges_fixed = 0, facets_removed = 0, facets_reversed = 0;
};

enum class PartType { Model, Negative, Modifier, SupportBlocker, SupportEnforcer };
struct Part {
	std::string id;
	std::string name;
	PartType type = PartType::Model;
	std::string mesh;
	Transform transform = IDENTITY;
	ConfigMap config;
	int filament = 0; // 1-based; 0 = inherit the object's
	/** Facet painting as Bambu Studio stores it (TriangleSelector hex strings by triangle index). */
	std::map<int, std::string> paint_supports, paint_seam, paint_color, paint_fuzzy_skin;
};
struct Instance {
	std::string id;
	Transform transform = IDENTITY;
	bool printable = true;
};
struct HeightRange {
	double min_z = 0, max_z = 0;
	ConfigMap config;
};
struct SceneObject {
	std::string id;
	std::string name;
	std::vector<Part> parts;
	std::vector<Instance> instances;
	ConfigMap config;
	std::vector<HeightRange> height_ranges;
	std::vector<double> layer_height_profile;
	bool printable = true;
};
struct PlateRef {
	std::string object_id, instance_id;
};
struct Plate {
	int index = 1;
	std::string name;
	bool locked = false;
	std::string bed_type;
	std::string print_sequence;
	std::string filament_map_mode;
	bool spiral_vase = false;
	std::vector<int> filament_maps;
	std::vector<PlateRef> instances;
	ConfigMap config;
};
struct FilamentSlot {
	int index = 1;
	std::string color;
	std::string type;
};
struct MeshFile {
	std::string id;
	std::string path; // storage.kind === 'file'
};
struct Project {
	std::string title;
	std::map<std::string, std::string> extras;
	PresetSelection presets;
	ConfigMap project_config;
	std::vector<FilamentSlot> filaments;
	std::vector<Plate> plates;
	std::vector<SceneObject> objects;
	std::map<std::string, MeshFile> meshes;
};

struct ConfigError {
	std::string key, message, object_id;
};
struct SliceWarning {
	std::string code, message, object_id;
	int plate = 0;
};
struct FilamentUse {
	int index = 1;
	double grams = 0, meters = 0;
};
struct ObjectStats {
	std::string object_id;
	std::optional<double> seconds, grams;
};
struct PlateStats {
	int plate = 1;
	double seconds = 0;
	int layers = 0;
	std::vector<FilamentUse> filaments;
	std::vector<ObjectStats> objects;
	std::vector<SliceWarning> warnings;
};
struct PlateImages {
	int plate = 1;
	std::string thumbnail, no_light, top, pick, small;
};
struct SlicedFilament {
	int id = 1;
	std::string type, color;
	double grams = 0, meters = 0;
	int extruder = 0; // 0: not stated
};
struct SlicedPlate {
	int index = 1;
	std::string gcode, md5;
	int minutes = 1;
	double grams = 0;
	int layers = 0;
	bool supports = false;
	std::vector<SlicedFilament> filaments;
};
struct Arranged {
	std::string object_id, instance_id;
	int plate = 1;
	Transform transform = IDENTITY;
};
struct Oriented {
	std::string object_id;
	Transform transform = IDENTITY;
};

struct Progress {
	std::string stage; // loading | preparing | slicing | perimeters | infill | support | gcode | exporting | arranging | orienting
	int percent = 0;
	std::string message;
};
using ProgressFn = std::function<void(const Progress &)>;

/** Set by $/cancel; long operations poll it (and pass it to upstream's cancel callback). */
struct CancelToken {
	std::atomic<bool> cancelled{false};
	bool operator()() const { return cancelled.load(); }
};

struct EngineIdentity {
	std::string upstream_name = "BambuStudio";
	std::string upstream_tag, upstream_commit;
	int queue_version = 0;
	std::string queue_hash;
	std::vector<std::string> patches;
	std::string profiles_dir, vendor_version; // empty when no profiles were found
};

const char *kind_name(PresetKind k);
PresetKind kind_from(const std::string &s);
const char *part_type_name(PartType t);
PartType part_type_from(const std::string &s);

} // namespace printlab
