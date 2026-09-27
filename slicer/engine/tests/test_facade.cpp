// Facade smoke test (builds with upstream only): resolve Bambu Studio's P1S presets, slice a 20 mm
// cube and export the plate. Needs PRINTLAB_TEST_RESOURCES (the checkout's resources/).
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <filesystem>

#include <boost/filesystem.hpp>

#include "check.hpp"
#include "facade/facade.hpp"

using namespace printlab;

namespace {

std::string write_cube(const std::string &dir) {
	// ASCII STL, 20 × 20 × 10 mm.
	float v[8][3] = {{0, 0, 0}, {20, 0, 0}, {20, 20, 0}, {0, 20, 0}, {0, 0, 10}, {20, 0, 10}, {20, 20, 10}, {0, 20, 10}};
	int f[12][3] = {{0, 2, 1}, {0, 3, 2}, {4, 5, 6}, {4, 6, 7}, {0, 1, 5}, {0, 5, 4},
	                {1, 2, 6}, {1, 6, 5}, {2, 3, 7}, {2, 7, 6}, {3, 0, 4}, {3, 4, 7}};
	std::string path = dir + "/cube.stl";
	std::ofstream out(std::filesystem::u8path(path));
	out << "solid cube\n";
	for (auto &t : f) {
		out << "facet normal 0 0 0\nouter loop\n";
		for (int k : t) out << "vertex " << v[k][0] << " " << v[k][1] << " " << v[k][2] << "\n";
		out << "endloop\nendfacet\n";
	}
	out << "endsolid cube\n";
	return path;
}

} // namespace

TEST("slices a cube for the P1S and exports a printable file") {
	const char *resources = std::getenv("PRINTLAB_TEST_RESOURCES");
	if (!resources) {
		std::fprintf(stderr, "  skipped: PRINTLAB_TEST_RESOURCES is not set\n");
		return;
	}
	auto facade = make_facade(); // Installs UTF-8 filesystem conversion before constructing paths.
	std::string work = (boost::filesystem::temp_directory_path() / boost::filesystem::unique_path(u8"printlab-é-印刷-%%%%%%")).string();
	boost::filesystem::create_directories(work);
	facade->configure(work, resources);
	CHECK(!facade->identity().profiles_dir.empty());

	PresetSelection sel;
	sel.printer = {PresetKind::Printer, "Bambu Lab P1S 0.4 nozzle", "system"};
	sel.process = {PresetKind::Process, "0.20mm Standard @BBL X1C", "system"};
	sel.filaments = {{PresetKind::Filament, "Bambu PLA Basic @BBL P1S 0.4 nozzle", "system"}};
	ResolvedBundle bundle = facade->profiles_resolve(sel, "");
	CHECK(!bundle.full.empty());
	CHECK(bundle.printer.chain.size() >= 2);
	// JSON clients need actual line breaks, not the INI serializer's escaped text.
	CHECK(std::get<std::string>(bundle.full.at("machine_start_gcode")).find('\n') != std::string::npos);

	MeshInfo mesh = facade->mesh_put("cube", write_cube(work), "stl");
	CHECK_EQ(mesh.triangles, size_t(12));

	std::string id = facade->project_create(sel);
	Project p;
	p.presets = sel;
	p.extras["printer_model_id"] = "C12";
	p.filaments = {{1, "#FF7A2F", "PLA"}};
	// Exercise ownership changes from string expressions to comparison results on each slice.
	// Valgrind/LeakSanitizer must also see these strings freed, not just correct G-code text.
	p.project_config["machine_start_gcode"] = std::get<std::string>(bundle.full.at("machine_start_gcode")) +
	    "\n; ownership-check {if \"PLA\" == \"PLA\"}eq{endif} {if \"PLA\" != \"PETG\"}ne{endif} "
	    "{if \"A\" < \"B\"}lt{endif} {if \"B\" > \"A\"}gt{endif} "
	    "{if \"A\" <= \"A\"}le{endif} {if \"B\" >= \"B\"}ge{endif}\n";

	SceneObject o;
	o.id = "o1";
	o.name = "Cube";
	Part part;
	part.id = "p1";
	part.mesh = "cube";
	o.parts.push_back(part);
	Instance inst;
	inst.id = "i1";
	inst.transform = {1, 0, 0, 0, 1, 0, 0, 0, 1, 118, 118, 0};
	o.instances.push_back(inst);
	p.objects.push_back(o);
	Plate plate;
	plate.index = 1;
	plate.bed_type = "Textured PEI Plate";
	plate.instances = {{"o1", "i1"}};
	p.plates.push_back(plate);
	CHECK(facade->project_sync(id, p, bundle).errors.empty());

	CancelToken cancel;
	int updates = 0;
	auto progress = [&](const Progress &p) {
		++updates;
		if (std::getenv("PRINTLAB_TEST_PROGRESS"))
			std::fprintf(stderr, "slice %d%%: %s\n", p.percent, p.message.c_str());
	};
	PlateStats stats = facade->slice(id, 1, progress, cancel);
	CHECK_EQ(stats.layers, 50);
	CHECK(std::isfinite(stats.seconds));
	CHECK(stats.seconds > 0 && stats.seconds < 86400);
	CHECK(updates > 0);
	CHECK(!stats.filaments.empty());
	for (const auto &f : stats.filaments) {
		CHECK(std::isfinite(f.grams) && f.grams >= 0 && f.grams < 1000);
		CHECK(std::isfinite(f.meters) && f.meters >= 0 && f.meters < 1000);
	}
	for (int repeat = 0; repeat < 2; ++repeat) {
		auto again = facade->slice(id, 1, progress, cancel);
		CHECK(std::isfinite(again.seconds));
		CHECK(std::abs(again.seconds - stats.seconds) < 0.01);
		CHECK_EQ(again.filaments.size(), stats.filaments.size());
		for (size_t i = 0; i < std::min(again.filaments.size(), stats.filaments.size()); ++i) {
			CHECK(std::isfinite(again.filaments[i].grams));
			CHECK(std::abs(again.filaments[i].grams - stats.filaments[i].grams) < 0.0001);
			CHECK(std::isfinite(again.filaments[i].meters));
			CHECK(std::abs(again.filaments[i].meters - stats.filaments[i].meters) < 0.0001);
		}
	}

	std::ifstream generated(std::filesystem::u8path(work + "/" + id + "/plate_1.gcode"));
	const std::string gcode((std::istreambuf_iterator<char>(generated)), std::istreambuf_iterator<char>());
	// Windows CRT file handles deny deletion while open; release the reader before project_close.
	generated.close();
	CHECK(gcode.find("; ownership-check eq ne lt gt le ge") != std::string::npos);
	CHECK_EQ(stats.objects.size(), size_t(1));
	CHECK_EQ(stats.objects[0].object_id, "o1");
	// Upstream does not emit object labels for a single-instance plate.
	CHECK(!stats.objects[0].seconds);
	CHECK(!stats.objects[0].grams);
	auto preview = facade->preview_get(id, 1, work + "/preview.bin", false);
	CHECK(preview.header.segments > 0);
	CHECK(!preview.header.layers.empty());
	CHECK(boost::filesystem::file_size(preview.path) > preview.header.segments * 30);

	ExportResult r = facade->export_gcode3mf(id, {1}, work + "/out.gcode.3mf", {}, true);
	CHECK(boost::filesystem::file_size(r.path) > 1000);
	CHECK_EQ(r.plates.size(), size_t(1));
	CHECK_EQ(r.plates[0].md5.size(), size_t(32));
	facade->project_close(id);
	CHECK(!boost::filesystem::exists(boost::filesystem::path(work) / id));
	boost::filesystem::remove_all(work);
}

CHECK_MAIN
