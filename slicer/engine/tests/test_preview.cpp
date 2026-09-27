#include <cmath>
#include <limits>
#include "check.hpp"
#include "features/preview/preview.hpp"
#include "rpc/convert.hpp"
using namespace printlab;
namespace {
uint32_t integer(const std::vector<uint8_t> &bytes, size_t at, size_t n) {
	uint32_t value = 0;
	for (size_t i = 0; i < n; ++i) value |= uint32_t(bytes.at(at + i)) << (8 * i);
	return value;
}
}
TEST("PLPV bytes preserve coordinates, tools, attributes, padding and layer ranges") {
	std::vector<preview::Segment> segments = {
	    {{-1, 2, .2f}, {10, 2, .2f}, 2, 3, .42f, .2f, 123.4f, .2, 7},
	    {{10, 2, .2f}, {11, 3, .4f}, 1, 3, 0, 0, 90000, .4, 11},
	    {{11, 3, .4f}, {12, 3, .4f}, 3, 1, 9, 4, -1, .4, 11}};
	auto h = preview::header(segments, 2, {{3, "#112233", "PLA"}}, 18);
	CHECK_EQ(h.layers.size(), size_t(2));
	CHECK_EQ(h.layers[1].first, size_t(1));
	CHECK_EQ(h.layers[1].count, size_t(2));
	CHECK_EQ(h.layers[1].seconds.value(), 11);
	CHECK_EQ(h.bbox[0], -1);
	CHECK_EQ(h.bbox[3], 12);
	auto j = to_json(h);
	CHECK_EQ(j["features"].size(), size_t(24));
	CHECK_EQ(j["source"].as_string(), "engine");
	auto bytes = preview::encode(segments, j.dump());
	CHECK_EQ(std::string(bytes.begin(), bytes.begin() + 4), "PLPV");
	CHECK_EQ(integer(bytes, 4, 2), 1u);
	CHECK_EQ(integer(bytes, 6, 2), 1u);
	size_t hb = integer(bytes, 8, 4), start = 12 + hb;
	CHECK_EQ(hb % 4, size_t(0));
	CHECK_EQ(Json::parse(std::string(bytes.begin() + 12, bytes.begin() + start)), j);
	CHECK_EQ(integer(bytes, start, 4), 0xbf800000u); // -1, IEEE754 little-endian
	CHECK_EQ(bytes[start + 72], 2);
	CHECK_EQ(bytes[start + 73], 3);
	CHECK_EQ(bytes[start + 74], 42);
	CHECK_EQ(bytes[start + 75], 20);
	CHECK_EQ(bytes[start + 82], 255);
	CHECK_EQ(integer(bytes, start + 84, 2), 123u);
	CHECK_EQ(integer(bytes, start + 86, 2), 65535u);
	CHECK_EQ(integer(bytes, start + 88, 2), 0u);
	CHECK_EQ(bytes.size(), start + 92);
	CHECK_EQ(bytes.back(), 0);
}
TEST("empty previews and unavailable times remain valid") {
	auto h = preview::header({}, 1, {}, std::numeric_limits<double>::infinity());
	CHECK(!h.total_seconds);
	CHECK(h.layers.empty());
	CHECK_EQ(h.bbox, (std::array<double, 6>{}));
	auto bytes = preview::encode({}, to_json(h).dump());
	CHECK_EQ(integer(bytes, 6, 2), 0u);
	CHECK_EQ(bytes.size(), 12 + integer(bytes, 8, 4));
}
TEST("invalid coordinates fail instead of writing corrupt preview geometry") {
	preview::Segment s{};
	s.to[0] = std::numeric_limits<float>::quiet_NaN();
	bool rejected = false;
	try { preview::header({s}, 1, {}, 1); } catch (const std::invalid_argument &) { rejected = true; }
	CHECK(rejected);
}
CHECK_MAIN
