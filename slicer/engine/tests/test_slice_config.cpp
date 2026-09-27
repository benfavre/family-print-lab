#include <limits>

#include "check.hpp"
#include "facade/flush.hpp"
#include "facade/slice_config.hpp"
#include "rpc/convert.hpp"

using namespace printlab;

TEST("nullable booleans retain their inherit sentinel and empty vectors have a fallback") {
	const std::vector<unsigned char> values{255, 0, 1};
	CHECK_EQ(flush::value(values, 0, static_cast<unsigned char>(0)), 255);
	CHECK_EQ(flush::value(values, 99, static_cast<unsigned char>(0)), 255);
	CHECK_EQ(flush::value(std::vector<unsigned char>{}, 0, static_cast<unsigned char>(255)), 255);
	CHECK_EQ(flush::value(std::vector<double>{130., 133., 133., 145.}, 3, 0.), 145.);
}

TEST("unset filament overrides inherit the machine's long retraction choice and distance") {
	// X2D: machine distance 18 mm, filament override 10 mm; nil must retain the machine value.
	CHECK_EQ(flush::minimum(92, true, true, 1, 18, 255, 10), 48);
	CHECK_EQ(flush::minimum(92, true, true, 1, 18, 1, 10), 67);
	CHECK_EQ(flush::minimum(92, true, true, 1, 18, 0, 10), 92);
	CHECK_EQ(flush::minimum(92, true, false, 1, 18, 1, 10), 48);
	CHECK_EQ(flush::minimum(92, true, true, 0, 18, 255, 10), 92);
	CHECK_EQ(flush::minimum(92, true, true, 255, 18, 255, 10), 92);
	CHECK_EQ(flush::minimum(92, false, false, 1, 18, 255, 10), 92);
}

TEST("nullable lengths and volumes never reach an undefined floating-point integer cast") {
	const double nil = std::numeric_limits<double>::quiet_NaN();
	CHECK_EQ(flush::minimum(92, true, true, 1, 18, 1, nil), 48);
	CHECK_EQ(flush::minimum(92, true, true, 1, nil, 255, nil), 48);
	CHECK_EQ(flush::minimum(nil, false, false, 0, nil, 255, nil), 0);
	for (double value : {-1., std::numeric_limits<double>::infinity(), 1e100}) {
		bool rejected = false;
		try { flush::minimum(value, false, false, 0, 18, 255, nil); }
		catch (const std::invalid_argument &) { rejected = true; }
		CHECK(rejected);
	}
}

TEST("plate filament mode and maps survive the protocol round trip independently of global settings") {
	Project p;
	p.presets.printer.name = "Printer";
	p.presets.process = {PresetKind::Process, "Process", "system"};
	p.project_config["filament_map_mode"] = std::string("Auto For Flush");
	Plate first;
	first.index = 1;
	first.filament_map_mode = "Manual";
	first.filament_maps = {2, 1, 2};
	first.config["filament_volume_map"] = std::vector<std::string>{"1", "0", "1"};
	Plate second;
	second.index = 2;
	second.filament_map_mode = "Default";
	p.plates = {first, second};
	const auto json = to_json(p, {});
	CHECK_EQ(json["plates"][0]["filamentMapMode"].as_string(), std::string("Manual"));
	CHECK_EQ(json["plates"][0]["filamentMaps"].size(), size_t(3));
	const auto back = project_from(json, "project");
	CHECK_EQ(back.plates[0].filament_maps, first.filament_maps);
	CHECK_EQ(back.plates[0].filament_map_mode, first.filament_map_mode);
	CHECK_EQ(back.plates[0].config, first.config);
	CHECK_EQ(back.plates[1].filament_map_mode, std::string("Default"));
	CHECK_EQ(std::get<std::string>(slice_config::plate_overrides(back.plates[0]).at("filament_map_mode")), std::string("Manual"));
	CHECK(!slice_config::plate_overrides(back.plates[1]).count("filament_map_mode"));
	second.filament_map_mode.clear();
	second.config["filament_map_mode"] = std::string("Default");
	CHECK(!slice_config::plate_overrides(second).count("filament_map_mode"));
}

TEST("multi-nozzle volume maps are preserved while missing material defaults are filled") {
	std::vector<int> maps{2, 1}, volumes{3, 0};
	slice_config::prepare_maps(maps, volumes, {0, 2}, 3);
	CHECK_EQ(maps, (std::vector<int>{2, 1, 1}));
	CHECK_EQ(volumes, (std::vector<int>{3, 0, 0}));
}

TEST("a single-nozzle printer clears stale right-nozzle and volume assignments") {
	std::vector<int> maps{2, 1}, volumes{3, 0};
	slice_config::prepare_maps(maps, volumes, {1}, 2);
	CHECK_EQ(maps, (std::vector<int>{1, 1}));
	CHECK_EQ(volumes, (std::vector<int>{1, 1}));
}

CHECK_MAIN
