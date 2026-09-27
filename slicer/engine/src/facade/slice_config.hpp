// Plate overrides and map defaults follow the CLI and PartPlate's global fallback.
// origin: BambuStudio src/BambuStudio.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// origin: BambuStudio src/slic3r/GUI/PartPlate.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
#pragma once

#include <algorithm>
#include <stdexcept>
#include "types.hpp"

namespace printlab::slice_config {

inline ConfigMap plate_overrides(const Plate &plate) {
	ConfigMap overrides = plate.config;
	if (!plate.bed_type.empty()) overrides["curr_bed_type"] = plate.bed_type;
	if (!plate.print_sequence.empty()) overrides["print_sequence"] = plate.print_sequence;
	if (plate.spiral_vase) overrides["spiral_mode"] = std::string("1");
	if (!plate.filament_map_mode.empty()) overrides["filament_map_mode"] = plate.filament_map_mode;
	if (auto it = overrides.find("filament_map_mode"); it != overrides.end())
		if (const auto *mode = std::get_if<std::string>(&it->second); mode && *mode == "Default")
			overrides.erase(it);
	return overrides;
}

inline void prepare_maps(std::vector<int> &maps, std::vector<int> &volume_maps,
                         const std::vector<int> &nozzle_volumes, size_t filaments) {
	if (nozzle_volumes.empty()) throw std::invalid_argument("A printer must have a nozzle.");
	maps.resize(filaments, 1);
	volume_maps.resize(filaments, nozzle_volumes.front());
	// Keep explicit per-material volume types on Hybrid/manual multi-nozzle projects.
	// A project moved to a single-nozzle printer must discard old right-nozzle assignments.
	if (nozzle_volumes.size() == 1) {
		std::fill(maps.begin(), maps.end(), 1);
		std::fill(volume_maps.begin(), volume_maps.end(), nozzle_volumes.front());
	}
}

} // namespace printlab::slice_config
