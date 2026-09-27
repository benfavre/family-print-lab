// Minimum flushing volume follows the nozzle/cutter and filament override rules of
// origin: BambuStudio src/slic3r/GUI/Plater.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
#pragma once

#include <cmath>
#include <limits>
#include <stdexcept>
#include <vector>

namespace printlab::flush {

// ConfigOptionVector's first-value fallback, without ConfigOptionBoolsNullable::get_at turning
// the nil sentinel (255) into true. Empty options are allowed in imported project settings.
template<class T> T value(const std::vector<T> &values, size_t index, T fallback) {
	return values.empty() ? fallback : values[index < values.size() ? index : 0];
}

inline double numeric(double value, double fallback) {
	if (std::isnan(value)) return fallback; // the upstream nullable floating-point sentinel
	if (!std::isfinite(value) || value < 0 || value > std::numeric_limits<int>::max())
		throw std::invalid_argument("Nozzle volume and retraction distances must be finite, non-negative numbers.");
	return value;
}

// Keep the three states of a nullable boolean: 0 disables, 1 overrides, 255 inherits the printer.
inline int minimum(double nozzle_volume, bool machine_enabled, bool filament_override_enabled,
                   unsigned char machine_active, double machine_length,
                   unsigned char filament_active, double filament_length) {
	const int volume = static_cast<int>(numeric(nozzle_volume, 0.));
	const double printer_length = numeric(machine_length, 18.);
	int retract = machine_enabled && machine_active == 1 ? static_cast<int>(printer_length) : 0;
	if (filament_active == 0) retract = 0;
	else if (filament_active == 1 && filament_override_enabled)
		retract = static_cast<int>(numeric(filament_length, printer_length));
	const double result = volume - std::acos(-1.) * 1.75 * 1.75 / 4 * retract;
	if (result < std::numeric_limits<int>::min())
		throw std::invalid_argument("The retraction distance is too large.");
	return static_cast<int>(result);
}

} // namespace printlab::flush
