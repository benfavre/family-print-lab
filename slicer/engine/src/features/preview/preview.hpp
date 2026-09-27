// PLPV v1, shared with app/src/lib/shared/slicer/preview.ts. No upstream types.
#pragma once
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace printlab::preview {
using Point = std::array<float, 3>;
struct Segment {
	Point from, to;
	uint8_t feature = 0, tool = 0;
	float width = 0, height = 0, speed = 0;
	double z = 0;
	std::optional<double> layer_seconds;
};
struct Layer {
	double z = 0, height = 0;
	std::optional<double> seconds;
	size_t first = 0, count = 0;
};
struct Tool { int index = 0; std::string color, type; };
struct Header {
	int plate = 1;
	size_t segments = 0;
	std::array<double, 6> bbox{};
	std::vector<Tool> tools;
	std::vector<Layer> layers;
	std::optional<double> total_seconds;
};
const std::vector<std::string> &features();
/** Validate coordinates and derive contiguous layer ranges and bounds. */
Header header(const std::vector<Segment> &segments, int plate, const std::vector<Tool> &tools,
              std::optional<double> seconds);
/** The caller serialises Header using the protocol's JSON writer. All binary fields are little-endian. */
std::vector<uint8_t> encode(const std::vector<Segment> &segments, const std::string &header_json);
} // namespace printlab::preview
