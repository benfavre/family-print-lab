#include "check.hpp"
#include "rpc/json.hpp"

using printlab::Json;

TEST("parses and dumps the protocol's shapes on one line") {
	Json j = Json::parse(R"( {"jsonrpc":"2.0","id":7,"method":"slice","params":{"projectId":"p","plate":1,"x":[true,null,-1.5e2]}} )");
	CHECK_EQ(j["id"].as_int(), 7);
	CHECK_EQ(j["params"]["x"][2].as_number(), -150.0);
	CHECK(j["params"]["x"][1].is_null());
	CHECK(j["missing"]["deeper"].is_null());
	std::string out = j.dump();
	CHECK(out.find('\n') == std::string::npos);
	CHECK(Json::parse(out) == j);
}

TEST("escapes strings so no raw newline reaches the stream") {
	Json j(std::string("line one\nline \"two\"\t\x01"));
	CHECK_EQ(j.dump(), std::string(R"("line one\nline \"two\"\t\u0001")"));
	CHECK_EQ(Json::parse(j.dump()).as_string(), j.as_string());
}

TEST("reads unicode escapes, surrogate pairs included") {
	CHECK_EQ(Json::parse(R"("café 😀")").as_string(), std::string("caf\xc3\xa9 \xf0\x9f\x98\x80"));
}

TEST("writes numbers without a locale or float noise") {
	CHECK_EQ(Json(0.2).dump(), std::string("0.2"));
	CHECK_EQ(Json(600).dump(), std::string("600"));
	CHECK_EQ(Json(-1.25).dump(), std::string("-1.25"));
}

TEST("refuses what is not exactly one JSON value") {
	for (const char *bad : {"", "{", "{\"a\":}", "[1,]", "tru", "\"unterminated", "{} {}", "01", "\"\x01\"", "1.", "-"}) {
		bool threw = false;
		try {
			Json::parse(bad);
		} catch (const Json::ParseError &) {
			threw = true;
		}
		if (!threw) std::fprintf(stderr, "  accepted: %s\n", bad);
		CHECK(threw);
	}
}

TEST("copies are independent") {
	Json a = Json::object();
	a["list"].push_back(1);
	Json b = a;
	b["list"].push_back(2);
	CHECK_EQ(a["list"].size(), size_t(1));
	CHECK_EQ(b["list"].size(), size_t(2));
}

TEST("integers must be whole") {
	bool threw = false;
	try {
		Json(1.5).as_int();
	} catch (const Json::TypeError &) {
		threw = true;
	}
	CHECK(threw);
}

CHECK_MAIN
