// Native validation must prepare exactly the same plate as slicing, without invalidating its result.
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <stdexcept>

#include <boost/filesystem.hpp>

#include "check.hpp"
#include "facade/facade.hpp"

using namespace printlab;

namespace {

std::string contents(const std::string &path) {
	std::ifstream in(path, std::ios::binary);
	return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

struct Fixture {
	std::string work, id;
	std::unique_ptr<Facade> facade = make_facade();
	ResolvedBundle bundle;
	Project project;

	Fixture() {
		const char *resources = std::getenv("PRINTLAB_TEST_RESOURCES");
		if (!resources) throw std::runtime_error("PRINTLAB_TEST_RESOURCES is required");
		work = (boost::filesystem::temp_directory_path() / boost::filesystem::unique_path("printlab-validate-%%%%%%")).string();
		boost::filesystem::create_directories(work);
		facade->configure(work, resources);
		auto caps = facade->capabilities();
		CHECK(std::find(caps.begin(), caps.end(), "config.validate") != caps.end());
		PresetSelection sel;
		sel.printer = {PresetKind::Printer, "Bambu Lab P1S 0.4 nozzle", "system"};
		sel.process = {PresetKind::Process, "0.20mm Standard @BBL X1C", "system"};
		sel.filaments = {{PresetKind::Filament, "Bambu PLA Basic @BBL P1S 0.4 nozzle", "system"}};
		bundle = facade->profiles_resolve(sel, "");
		project.presets = sel;
		project.filaments = {{1, "#FF7A2F", "PLA"}};
		float v[8][3] = {{0, 0, 0}, {10, 0, 0}, {10, 10, 0}, {0, 10, 0},
		                 {0, 0, 2}, {10, 0, 2}, {10, 10, 2}, {0, 10, 2}};
		int faces[12][3] = {{0, 2, 1}, {0, 3, 2}, {4, 5, 6}, {4, 6, 7}, {0, 1, 5}, {0, 5, 4},
		                    {1, 2, 6}, {1, 6, 5}, {2, 3, 7}, {2, 7, 6}, {3, 0, 4}, {3, 4, 7}};
		std::string mesh = work + "/cube.stl";
		{
			std::ofstream out(mesh);
			out << "solid cube\n";
			for (auto &face : faces) {
				out << "facet normal 0 0 0\nouter loop\n";
				for (int k : face) out << "vertex " << v[k][0] << " " << v[k][1] << " " << v[k][2] << "\n";
				out << "endloop\nendfacet\n";
			}
			out << "endsolid cube\n";
		}
		facade->mesh_put("cube", mesh, "stl");
		id = facade->project_create(sel);
		add_plate(1, 0);
	}

	~Fixture() {
		facade->project_close(id);
		boost::filesystem::remove_all(work);
	}

	void add_plate(int index, double x_shift) {
		Plate plate;
		plate.index = index;
		plate.bed_type = "Textured PEI Plate";
		for (int copy = 0; copy < 2; ++copy) {
			SceneObject object;
			object.id = "o" + std::to_string(index) + "-" + std::to_string(copy);
			object.name = object.id;
			Part part;
			part.id = object.id + "-part";
			part.mesh = "cube";
			part.filament = 1;
			object.parts.push_back(part);
			Instance instance;
			instance.id = object.id + "-instance";
			instance.transform = {1, 0, 0, 0, 1, 0, 0, 0, 1, x_shift + 90 + copy * 30, 110, 0};
			object.instances.push_back(instance);
			plate.instances.push_back({object.id, instance.id});
			project.objects.push_back(object);
		}
		project.plates.push_back(plate);
	}

	void sync() { CHECK(facade->project_sync(id, project, bundle).errors.empty()); }

	void same_error_as_slice(const ConfigError &error, int plate) {
		try {
			facade->slice(id, plate, [](const Progress &) {}, CancelToken{});
			CHECK(false);
		} catch (const EngineError &e) {
			CHECK_EQ(e.code, err::INVALID_CONFIG);
			CHECK_EQ(std::string(e.what()), error.message);
		}
	}
};

} // namespace

TEST("validation applies plate-only spiral and layer-height settings like slicing") {
	Fixture f;
	f.project.plates[0].spiral_vase = true;
	f.sync();
	auto spiral = f.facade->config_validate(f.id, 1);
	CHECK_EQ(spiral.errors.size(), size_t(1));
	if (!spiral.errors.empty()) {
		CHECK_EQ(spiral.errors[0].key, "spiral_mode");
		f.same_error_as_slice(spiral.errors[0], 1);
	}
	f.project.plates[0].spiral_vase = false;
	f.project.plates[0].config["layer_height"] = std::string("0.8");
	f.sync();
	auto height = f.facade->config_validate(f.id, 1);
	CHECK(!height.errors.empty());
	if (!height.errors.empty()) f.same_error_as_slice(height.errors[0], 1);
}

TEST("validation selects plates, aggregates populated plates, and rejects absent plates") {
	Fixture f;
	f.add_plate(2, 256 * 1.2);
	f.project.plates[1].spiral_vase = true;
	f.project.plates[1].config["enable_prime_tower"] = std::string("0");
	f.project.plates[1].config["enable_wrapping_detection"] = std::string("1");
	Plate empty;
	empty.index = 3;
	f.project.plates.push_back(empty);
	f.sync();
	CHECK(f.facade->config_validate(f.id, 1).errors.empty());
	CHECK(f.facade->config_validate(f.id, 3).errors.empty());
	auto bad = f.facade->config_validate(f.id, 2);
	auto all = f.facade->config_validate(f.id, 0);
	CHECK_EQ(bad.errors.size(), size_t(1));
	CHECK_EQ(all.errors.size(), bad.errors.size());
	CHECK(std::any_of(all.warnings.begin(), all.warnings.end(), [](const SliceWarning &w) {
		return w.plate == 2 && w.message.find("Prime tower") != std::string::npos;
	}));
	if (!bad.errors.empty() && !all.errors.empty()) CHECK_EQ(all.errors[0].message, bad.errors[0].message);
	for (int plate : {99, -1}) {
		try {
			f.facade->config_validate(f.id, plate);
			CHECK(false);
		} catch (const EngineError &e) {
			CHECK_EQ(e.code, err::INVALID_PARAMS);
			CHECK_EQ(e.key, "plate");
		}
	}
}

TEST("validation preserves cached G-code, previews and repeatable slice estimates") {
	Fixture f;
	// This override must remain local when validation prepares another plate or runs again.
	f.project.plates[0].config["layer_height"] = std::string("0.1");
	f.sync();
	CHECK(f.facade->config_validate(f.id, 1).errors.empty());
	auto before = f.facade->slice(f.id, 1, [](const Progress &) {}, CancelToken{});
	const auto gcode = contents(f.work + "/" + f.id + "/plate_1.gcode");
	f.facade->preview_get(f.id, 1, f.work + "/before.bin", false);
	auto exported = f.facade->export_gcode3mf(f.id, {1}, f.work + "/before.3mf", {}, true);
	for (int repeat = 0; repeat < 2; ++repeat) CHECK(f.facade->config_validate(f.id, 0).errors.empty());
	CHECK_EQ(contents(f.work + "/" + f.id + "/plate_1.gcode"), gcode);
	f.facade->preview_get(f.id, 1, f.work + "/after.bin", false);
	CHECK_EQ(contents(f.work + "/after.bin"), contents(f.work + "/before.bin"));
	auto after_export = f.facade->export_gcode3mf(f.id, {1}, f.work + "/after.3mf", {}, true);
	CHECK_EQ(exported.plates[0].md5, after_export.plates[0].md5);
	auto after = f.facade->slice(f.id, 1, [](const Progress &) {}, CancelToken{});
	CHECK(std::isfinite(after.seconds));
	CHECK(std::abs(before.seconds - after.seconds) < 0.01);
	CHECK_EQ(before.layers, after.layers);
	CHECK_EQ(before.filaments.size(), after.filaments.size());
	for (size_t i = 0; i < std::min(before.filaments.size(), after.filaments.size()); ++i)
		CHECK(std::abs(before.filaments[i].grams - after.filaments[i].grams) < 0.0001);
}

CHECK_MAIN
