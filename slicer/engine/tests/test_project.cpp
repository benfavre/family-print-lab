#include <limits>
#include "check.hpp"
#include "features/project/common.hpp"
#include "features/project/layer_profile.hpp"
#include "rpc/convert.hpp"
using namespace printlab;
using namespace printlab::project_io;
TEST("XML keeps raw fragments, Unicode references, and attribute newlines") {
	std::string source =
		"<root text=\"line1\nline2 &amp; &#x1f3e0;\"><unknown a='x'><!-- keep --><![CDATA[<raw>]]></unknown></root>";
	auto root = XmlParser(source).parse();
	CHECK_EQ(root.attr("text"), "line1\nline2 & 🏠");
	const auto &unknown = root.children[0];
	CHECK_EQ(source.substr(unknown.start, unknown.end - unknown.start),
			 "<unknown a='x'><!-- keep --><![CDATA[<raw>]]></unknown>");
	CHECK_EQ(unknown.text, "<raw>");
}
TEST("XML refuses external declarations and truncated or mismatched tags") {
	for (const auto *source : {"<!DOCTYPE model SYSTEM 'file:///etc/passwd'><model/>", "<model><object></model>",
							   "<model a=\"oops>", "<model/>trailing"}) {
		bool failed = false;
		try {
			XmlParser(source).parse();
		} catch (const std::invalid_argument &) {
			failed = true;
		}
		CHECK(failed);
	}
}
TEST("binary passthrough and canonical mesh data survive encoding") {
	std::string bytes("\0\x80\xff\n", 4);
	CHECK_EQ(unbase64(base64(bytes)), bytes);
	Mesh mesh{{{{0, 0, 0}}, {{1, 0, 0}}, {{0, 1, 0}}, {{0, 0, 0}}}, {{{0, 1, 2}}, {{3, 2, 1}}}};
	auto stl = canonical_stl(mesh);
	auto canonical = stl_mesh(stl);
	CHECK_EQ(canonical.vertices.size(), size_t(3));
	CHECK_EQ(canonical.triangles.size(), size_t(2));
	CHECK_EQ(canonical_stl(canonical), stl);
	bool rejected = false;
	try {
		unbase64("a===");
	} catch (const std::invalid_argument &) {
		rejected = true;
	}
	CHECK(rejected);
}
TEST("project conversion retains every protocol extension instead of dropping unknown fields") {
	Json input = Json::parse(
		R"({"format":1,"meta":{"title":"Stored","designer":"A","extras":{"Custom":"x"}},"presets":{"printer":{"kind":"printer","name":"","source":"project"},"process":{"kind":"process","name":"","source":"project"},"filaments":[]},"projectConfig":{},"filaments":[],"plates":[],"objects":[],"meshes":{},"passthrough":{"extra.bin":{"base64":"AA=="}},"modelSettingsXml":["<assemble/>"]})");
	CHECK_EQ(to_json(project_from(input, "project"), {}), input);
}
TEST("two-point profiles retain interpolation and do not override later edits") {
	Json original = Json::parse("[0,0.2,20,0.1]");
	Json expanded = studio_layer_profile(original);
	CHECK_EQ(expanded.size(), size_t(6));
	CHECK_EQ(expanded[2], Json(10));
	CHECK_EQ(restore_layer_profile(expanded, original), original);
	expanded.as_array()[3] = Json(0.18);
	CHECK_EQ(restore_layer_profile(expanded, original), expanded);
	CHECK_EQ(restore_layer_profile(Json(), original), Json());
}
CHECK_MAIN
