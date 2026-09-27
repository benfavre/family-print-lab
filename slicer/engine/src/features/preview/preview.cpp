#include "preview.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace printlab::preview {
const std::vector<std::string> &features() {
	static const std::vector<std::string> names = {"Other", "Travel", "Outer wall", "Inner wall", "Overhang wall",
	    "Sparse infill", "Internal solid infill", "Top surface", "Bottom surface", "Bridge", "Gap infill",
	    "Support", "Support interface", "Support transition", "Brim", "Skirt", "Prime tower", "Ironing",
	    "Custom", "Wipe", "Floating vertical shell", "Support ironing", "Multiple", "Flush"};
	return names;
}
namespace {
std::optional<double> valid_time(std::optional<double> t) {
	return t && std::isfinite(*t) && *t >= 0 ? t : std::nullopt;
}
unsigned quantise(double value, double scale, unsigned max) {
	return std::isfinite(value) ? static_cast<unsigned>(std::clamp(std::round(value * scale), 0.0, double(max))) : 0;
}
void integer(std::vector<uint8_t> &out, uint32_t value, unsigned bytes) {
	for (unsigned i = 0; i < bytes; ++i) out.push_back(static_cast<uint8_t>(value >> (i * 8)));
}
}
Header header(const std::vector<Segment> &segments, int plate, const std::vector<Tool> &tools,
              std::optional<double> seconds) {
	Header h;
	h.plate = plate;
	h.segments = segments.size();
	h.tools = tools;
	h.total_seconds = valid_time(seconds);
	for (size_t i = 0; i < segments.size(); ++i) {
		const auto &s = segments[i];
		if (!std::isfinite(s.z) || !std::isfinite(s.height)) throw std::invalid_argument("Preview layer is not finite.");
		for (size_t axis = 0; axis < 3; ++axis) {
			if (!std::isfinite(s.from[axis]) || !std::isfinite(s.to[axis])) throw std::invalid_argument("Preview coordinate is not finite.");
			double lo = std::min(s.from[axis], s.to[axis]), hi = std::max(s.from[axis], s.to[axis]);
			h.bbox[axis] = i ? std::min(h.bbox[axis], lo) : lo;
			h.bbox[axis + 3] = i ? std::max(h.bbox[axis + 3], hi) : hi;
		}
		if (h.layers.empty() || std::abs(h.layers.back().z - s.z) > 0.00001)
			h.layers.push_back({s.z, s.height, valid_time(s.layer_seconds), i, 0});
		++h.layers.back().count;
	}
	return h;
}
std::vector<uint8_t> encode(const std::vector<Segment> &segments, const std::string &json) {
	if (json.size() > std::numeric_limits<uint32_t>::max() - 3 || segments.size() > std::numeric_limits<uint32_t>::max())
		throw std::length_error("Preview is too large.");
	const size_t header_bytes = (json.size() + 3) & ~size_t(3);
	std::vector<uint8_t> out{'P', 'L', 'P', 'V'};
	integer(out, 1, 2);
	integer(out, std::any_of(segments.begin(), segments.end(), [](const Segment &s) { return s.feature == 1; }) ? 1 : 0, 2);
	integer(out, static_cast<uint32_t>(header_bytes), 4);
	out.insert(out.end(), json.begin(), json.end());
	out.resize(12 + header_bytes, ' ');
	for (const auto &s : segments)
		for (const auto &p : {s.from, s.to})
			for (float value : p) {
				if (!std::isfinite(value)) throw std::invalid_argument("Preview coordinate is not finite.");
				uint32_t bits;
				static_assert(sizeof(bits) == sizeof(value));
				std::memcpy(&bits, &value, sizeof(bits));
				integer(out, bits, 4);
			}
	for (const auto &s : segments) {
		out.push_back(s.feature);
		out.push_back(s.tool);
		out.push_back(quantise(s.width, 100, 255));
		out.push_back(quantise(s.height, 100, 255));
	}
	for (const auto &s : segments) integer(out, quantise(s.speed, 1, 65535), 2);
	while (out.size() % 4) out.push_back(0);
	return out;
}
} // namespace printlab::preview
