// Wipe tower reservation without the GUI. Plain inputs keep the sizing rules independently testable.
// origin: BambuStudio src/slic3r/GUI/Jobs/ArrangeJob.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// origin: BambuStudio src/slic3r/GUI/PartPlate.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
#pragma once

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <stdexcept>
#include <vector>

namespace printlab::wipe_tower {

struct Item {
	std::set<int> filaments;
	int bed_temperature = 0;
};

inline bool needed(bool enabled, bool sequential, bool smooth_timelapse, bool wrapping_detection,
                   bool allow_multi_materials, const std::vector<Item> &items) {
	if (!enabled || sequential || items.empty()) return false;
	if (smooth_timelapse || wrapping_detection) return true;
	std::map<int, std::set<int>> by_temperature;
	for (const auto &item : items) {
		if (item.filaments.size() > 1) return true;
		if (allow_multi_materials)
			by_temperature[item.bed_temperature].insert(item.filaments.begin(), item.filaments.end());
	}
	for (const auto &entry : by_temperature)
		if (entry.second.size() > 1) return true;
	return false;
}

struct Settings {
	double width = 0, wipe_volume = 0, layer_height = 0, infill_gap = 1;
	int extruders = 1, filaments = 1;
	double filament_change_length = 0, filament_diameter = 1.75;
	bool rib_wall = true;
	double rib_width = 0, extra_rib_length = 0;
	// Obtained from upstream's WipeTower helpers, including automatic brim sizing by height.
	double minimum_depth = 0, brim = 0;
	double x = 0, y = 0, bed_min_x = 0, bed_min_y = 0, bed_max_x = 0, bed_max_y = 0, margin = 0;
};

struct Reservation {
	// Outside edges, including the brim; directly suitable for a fixed arrangement polygon.
	double min_x, min_y, max_x, max_y;
};

inline Reservation estimate(const Settings &s) {
	const double inputs[] = {s.width, s.wipe_volume, s.layer_height, s.infill_gap, s.filament_change_length,
	                         s.filament_diameter, s.rib_width, s.extra_rib_length, s.minimum_depth, s.brim,
	                         s.x, s.y, s.bed_min_x, s.bed_min_y, s.bed_max_x, s.bed_max_y, s.margin};
	for (double value : inputs)
		if (!std::isfinite(value)) throw std::invalid_argument("The wipe tower settings must be finite.");
	if (s.width <= 0 || s.layer_height <= 0 || s.infill_gap <= 0 || s.filaments <= 0 || s.extruders <= 0 ||
	    s.wipe_volume < 0 || s.filament_change_length < 0 || s.filament_diameter <= 0 || s.brim < 0 ||
	    s.rib_width < 0 || s.minimum_depth < 0 || s.margin < 0)
		throw std::invalid_argument("The wipe tower settings are invalid.");
	double volume = s.wipe_volume * (s.extruders == 2 ? s.filaments : s.filaments - 1);
	if (s.extruders == 2)
		volume += s.filament_change_length * std::acos(-1.) * s.filament_diameter * s.filament_diameter / 4. *
		          (s.filaments / 2);
	double width = s.width, depth;
	if (s.rib_wall) {
		double volume_depth = std::sqrt(volume / s.layer_height * s.infill_gap);
		depth = std::max(s.minimum_depth, volume_depth);
		depth = std::min(s.rib_width, depth / 2.) / std::sqrt(2.) +
		        std::max(depth + s.extra_rib_length, volume_depth);
		// PartPlate's polygon uses the configured width even when rib sizing grows wider. Keep its
		// conservative width floor, but also cover the full square calculated by its size estimator.
		width = std::max(width, depth);
	} else {
		depth = std::max(s.minimum_depth, volume / (s.layer_height * width) * s.infill_gap);
	}
	const double min_x = s.bed_min_x + std::max(s.margin, s.brim);
	const double min_y = s.bed_min_y + std::max(s.margin, s.brim);
	const double max_x = s.bed_max_x - width - s.margin - s.brim;
	const double max_y = s.bed_max_y - depth - s.margin - s.brim;
	if (!std::isfinite(width) || !std::isfinite(depth) || width <= 0 || depth <= 0 || max_x < min_x || max_y < min_y)
		throw std::invalid_argument("The wipe tower does not fit on the plate.");
	const double x = std::clamp(s.x, min_x, max_x), y = std::clamp(s.y, min_y, max_y);
	return {x - s.brim, y - s.brim, x + width + s.brim, y + depth + s.brim};
}

} // namespace printlab::wipe_tower
