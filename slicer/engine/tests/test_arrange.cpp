// Public-facade arrangement test: reserve the prime tower on the physical and virtual plates.
#include <algorithm>
#include <cstdlib>
#include <fstream>

#include <boost/filesystem.hpp>

#include "check.hpp"
#include "facade/facade.hpp"

using namespace printlab;

TEST("plate settings reserve a wipe tower on every bed that objects spill onto") {
	const char *resources = std::getenv("PRINTLAB_TEST_RESOURCES");
	if (!resources) {
		std::fprintf(stderr, "  skipped: PRINTLAB_TEST_RESOURCES is not set\n");
		return;
	}
	const auto work = boost::filesystem::temp_directory_path() / boost::filesystem::unique_path("arrange-%%%%%%");
	boost::filesystem::create_directories(work);
	struct Cleanup {
		boost::filesystem::path path;
		~Cleanup() { boost::filesystem::remove_all(path); }
	} cleanup{work};
	const auto file = (work / "box.obj").string();
	std::ofstream(file) << "v 0 0 0\nv 100 0 0\nv 100 100 0\nv 0 100 0\n"
	                       "v 0 0 10\nv 100 0 10\nv 100 100 10\nv 0 100 10\n"
	                       "f 1 3 2\nf 1 4 3\nf 5 6 7\nf 5 7 8\n"
	                       "f 1 2 6\nf 1 6 5\nf 2 3 7\nf 2 7 6\n"
	                       "f 3 4 8\nf 3 8 7\nf 4 1 5\nf 4 5 8\n";
	auto facade = make_facade();
	facade->configure(work.string(), resources);
	const auto mesh = facade->mesh_put("box", file, "obj");
	PresetSelection selection;
	selection.printer = {PresetKind::Printer, "Bambu Lab P1S 0.4 nozzle", "system"};
	selection.process = {PresetKind::Process, "0.20mm Standard @BBL X1C", "system"};
	selection.filaments = {{PresetKind::Filament, "Bambu PLA Basic @BBL P1S 0.4 nozzle", "system"},
	                       {PresetKind::Filament, "Bambu PLA Basic @BBL P1S 0.4 nozzle", "system"}};
	const auto bundle = facade->profiles_resolve(selection, "");
	const auto id = facade->project_create(selection);
	Project project;
	project.presets = selection;
	project.project_config["enable_prime_tower"] = std::string("0");
	project.filaments = {{1, "#FF0000", "PLA"}, {2, "#FFFFFF", "PLA"}};
	Plate plate;
	plate.bed_type = "Textured PEI Plate";
	plate.config = {{"enable_prime_tower", std::string("1")},
	                {"prime_tower_width", std::string("80")},
	                {"prime_tower_brim_width", std::string("0")},
	                {"prime_tower_rib_wall", std::string("0")},
	                {"prime_tower_infill_gap", std::string("100%")},
	                {"filament_prime_volume", std::vector<std::string>{"1280", "1280"}},
	                {"wipe_tower_x", std::vector<std::string>{"130"}},
	                {"wipe_tower_y", std::vector<std::string>{"130"}},
	                {"layer_height", std::string("0.2")},
	                {"prime_volume_mode", std::string("Default")}};
	for (int i = 0; i < 8; ++i) {
		SceneObject object;
		object.id = "object-" + std::to_string(i);
		object.name = object.id;
		Part part;
		part.id = "part";
		part.mesh = "box";
		part.filament = i % 2 + 1;
		object.parts.push_back(part);
		Instance instance;
		instance.id = "instance";
		object.instances.push_back(instance);
		plate.instances.push_back({object.id, instance.id});
		project.objects.push_back(object);
	}
	project.plates.push_back(plate);
	CHECK(facade->project_sync(id, project, bundle).errors.empty());
	const auto arranged = facade->arrange(id, 1, 6, false, "center", [](const Progress &) {}, CancelToken{});
	CHECK_EQ(arranged.size(), size_t(8));
	CHECK(std::any_of(arranged.begin(), arranged.end(), [](const Arranged &a) { return a.plate > 1; }));
	for (const auto &a : arranged) {
		// One project plate means a single column; virtual beds follow its 256 * 1.2 vertical stride.
		const double x = a.transform[9] + mesh.bbox[0];
		const double y = a.transform[10] + (a.plate - 1) * 256 * 1.2 + mesh.bbox[1];
		CHECK(x >= -0.01 && x + 100 <= 256.01);
		CHECK(y >= -0.01 && y + 100 <= 256.01);
		CHECK(x + 100 <= 130.01 || x >= 209.99 || y + 100 <= 130.01 || y >= 209.99);
	}
	// An invalid tower is ignored only when the plate explicitly disables it, not because the
	// project's setting is off. This also covers per-plate overrides of the project's setting.
	project.plates[0].config["prime_tower_width"] = std::string("1000");
	CHECK(facade->project_sync(id, project, bundle).errors.empty());
	bool refused = false;
	try { facade->arrange(id, 1, 6, false, "center", [](const Progress &) {}, CancelToken{}); }
	catch (const EngineError &e) { refused = e.code == err::INVALID_CONFIG; }
	CHECK(refused);
	project.plates[0].config["enable_prime_tower"] = std::string("0");
	CHECK(facade->project_sync(id, project, bundle).errors.empty());
	CHECK_EQ(facade->arrange(id, 1, 6, false, "center", [](const Progress &) {}, CancelToken{}).size(), size_t(8));
	facade->project_close(id);
}

CHECK_MAIN
