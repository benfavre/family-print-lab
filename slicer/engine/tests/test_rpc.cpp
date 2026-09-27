// The protocol layer against the facade this build has (with PRINTLAB_WITH_UPSTREAM=OFF: the null
// one): framing, negotiation, error codes, strands, progress and cancel.
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <set>
#include <thread>

#include "check.hpp"
#include "facade/facade.hpp"
#include "rpc/methods.hpp"
#include "rpc/server.hpp"
#include "version.hpp"

using namespace printlab;

namespace {

struct Harness {
	std::mutex m;
	std::condition_variable cv;
	std::vector<Json> out;
	std::unique_ptr<Facade> facade = make_facade();
	Server server{[this](const std::string &line) {
		CHECK(line.find('\n') == std::string::npos);
		std::lock_guard<std::mutex> lock(m);
		out.push_back(Json::parse(line));
		cv.notify_all();
	}};
	Harness() { register_methods(server, *facade, EngineOptions{true}); }

	void send(const std::string &line) { server.handle_line(line); }
	/** The answer to request `id` (waits up to two seconds). */
	Json answer(int id) {
		std::unique_lock<std::mutex> lock(m);
		Json found;
		cv.wait_for(lock, std::chrono::seconds(2), [&] {
			for (const Json &j : out)
				if (j["id"] == Json(id) && (j.has("result") || j.has("error"))) {
					found = j;
					return true;
				}
			return false;
		});
		return found;
	}
	std::vector<Json> notifications(const std::string &method) {
		std::lock_guard<std::mutex> lock(m);
		std::vector<Json> r;
		for (const Json &j : out)
			if (j["method"] == Json(method)) r.push_back(j);
		return r;
	}
};

const char *HELLO = R"({"jsonrpc":"2.0","id":1,"method":"engine.hello","params":{"client":"test","protocol":{"major":1,"minor":0},"workDir":"/tmp"}})";

} // namespace

TEST("splits lines across chunks, drops CR and blank lines, and survives a line that is too long") {
	LineSplitter s(16);
	std::vector<std::string> lines;
	int too_long = 0;
	auto feed = [&](const std::string &chunk) {
		s.feed(chunk.data(), chunk.size(), [&](std::string l) { lines.push_back(l); }, [&] { ++too_long; });
	};
	feed("{\"a\":");
	feed("1}\r\n\n{\"b\"");
	feed(":2}\n");
	feed("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
	feed("yyyy\n{\"c\":3}\n");
	CHECK_EQ(lines.size(), size_t(3));
	CHECK_EQ(lines[0], std::string("{\"a\":1}"));
	CHECK_EQ(lines[1], std::string("{\"b\":2}"));
	CHECK_EQ(lines[2], std::string("{\"c\":3}"));
	CHECK_EQ(too_long, 1);
}

TEST("hello reports the protocol, the pin and the patch queue") {
	Harness h;
	h.send(HELLO);
	Json r = h.answer(1)["result"];
	CHECK_EQ(r["engine"].as_string(), std::string("printlab-slicer"));
	CHECK_EQ(r["protocol"]["major"].as_int(), 1LL);
	CHECK_EQ(r["version"].as_string(), std::string(PRINTLAB_ENGINE_VERSION));
	CHECK_EQ(r["upstream"]["name"].as_string(), std::string("BambuStudio"));
	CHECK_EQ(r["upstream"]["tag"].as_string(), std::string(PRINTLAB_UPSTREAM_TAG));
	CHECK_EQ(r["patchQueue"]["version"].as_int(), static_cast<long long>(PRINTLAB_QUEUE_VERSION));
	CHECK(r["capabilities"].is_array());
}

TEST("hello refuses another protocol major") {
	Harness h;
	h.send(R"({"jsonrpc":"2.0","id":1,"method":"engine.hello","params":{"client":"t","protocol":{"major":2,"minor":0},"workDir":"/tmp"}})");
	Json e = h.answer(1)["error"];
	CHECK_EQ(e["code"].as_int(), static_cast<long long>(err::INVALID_REQUEST));
	CHECK(!e["data"]["message"].as_string().empty());
}

TEST("answers errors with codes and plain words") {
	Harness h;
	h.send("{not json");
	h.send(R"({"jsonrpc":"2.0","id":2,"method":"no.such"})");
	h.send(R"({"jsonrpc":"2.0","id":3,"method":"engine.hello","params":{"client":"t"}})");
	h.send(R"({"jsonrpc":"1.0","id":4,"method":"engine.ping"})");
	h.send(R"({"jsonrpc":"2.0","id":5,"method":"engine.ping","params":[1]})");
	CHECK_EQ(h.answer(2)["error"]["code"].as_int(), static_cast<long long>(err::METHOD_NOT_FOUND));
	Json bad = h.answer(3)["error"];
	CHECK_EQ(bad["code"].as_int(), static_cast<long long>(err::INVALID_PARAMS));
	CHECK_EQ(bad["data"]["detail"].as_string(), std::string("params.protocol: missing"));
	CHECK_EQ(h.answer(4)["error"]["code"].as_int(), static_cast<long long>(err::INVALID_REQUEST));
	CHECK_EQ(h.answer(5)["error"]["code"].as_int(), static_cast<long long>(err::INVALID_PARAMS));
	std::lock_guard<std::mutex> lock(h.m);
	bool parse = false;
	for (const Json &j : h.out)
		if (j["error"]["code"] == Json(err::PARSE)) parse = j["id"].is_null() && !j["error"]["data"]["message"].as_string().empty();
	CHECK(parse);
}

TEST("a method whose capability is missing answers CAPABILITY_MISSING") {
	Harness h;
	if (h.facade->capabilities().empty()) {
		h.send(R"({"jsonrpc":"2.0","id":6,"method":"slice","params":{"projectId":"p","plate":1}})");
		Json e = h.answer(6)["error"];
		CHECK_EQ(e["code"].as_int(), static_cast<long long>(err::CAPABILITY_MISSING));
		CHECK_EQ(e["data"]["key"].as_string(), std::string("slice"));
	}
}

TEST("routes progress to the request and finishes it") {
	Harness h;
	h.send(R"({"jsonrpc":"2.0","id":"w1","method":"test.wait","params":{"steps":3,"stepMs":5}})");
	std::unique_lock<std::mutex> lock(h.m);
	h.cv.wait_for(lock, std::chrono::seconds(2), [&] {
		for (const Json &j : h.out)
			if (j["id"] == Json("w1")) return true;
		return false;
	});
	lock.unlock();
	auto progress = h.notifications("$/progress");
	CHECK_EQ(progress.size(), size_t(3));
	CHECK_EQ(progress[2]["params"]["id"].as_string(), std::string("w1"));
	CHECK_EQ(progress[2]["params"]["progress"]["percent"].as_int(), 100LL);
}

TEST("cancels a running request with $/cancel while ping still answers") {
	Harness h;
	h.send(R"({"jsonrpc":"2.0","id":10,"method":"test.wait","params":{"projectId":"a","steps":400,"stepMs":5}})");
	std::this_thread::sleep_for(std::chrono::milliseconds(30));
	h.send(R"({"jsonrpc":"2.0","id":11,"method":"engine.ping"})");
	CHECK(h.answer(11)["result"]["ok"].as_bool());
	h.send(R"({"jsonrpc":"2.0","method":"$/cancel","params":{"id":10}})");
	Json e = h.answer(10)["error"];
	CHECK_EQ(e["code"].as_int(), static_cast<long long>(err::CANCELLED));
}

TEST("runs different projects side by side and one project in order") {
	// Hold both projects inside their handlers: overlap is a fact we observe, not a wall-clock
	// performance threshold. The deadlines below only bound a broken scheduler's failure.
	std::mutex gate_mutex;
	std::condition_variable gate_cv;
	std::set<long long> entered;
	bool release = false, timed_out = false;
	Harness h;
	h.server.add("test.gated", {{}, false, [&](const Json &, CallContext &ctx) {
		std::unique_lock<std::mutex> lock(gate_mutex);
		entered.insert(ctx.id.as_int());
		gate_cv.notify_all();
		if (!gate_cv.wait_for(lock, std::chrono::seconds(10), [&] { return release; })) timed_out = true;
		return Json(Json::Object{{"ok", true}});
	}});
	h.send(R"({"jsonrpc":"2.0","id":20,"method":"test.gated","params":{"projectId":"a"}})");
	h.send(R"({"jsonrpc":"2.0","id":21,"method":"test.gated","params":{"projectId":"b"}})");
	h.send(R"({"jsonrpc":"2.0","id":22,"method":"test.gated","params":{"projectId":"a"}})");
	{
		std::unique_lock<std::mutex> lock(gate_mutex);
		CHECK(gate_cv.wait_for(lock, std::chrono::seconds(5), [&] { return entered.count(20) && entered.count(21); }));
		CHECK(!entered.count(22)); // a's first handler is still blocked, so its second cannot run
		release = true;
		gate_cv.notify_all();
	}
	CHECK(h.answer(20).has("result"));
	CHECK(h.answer(21).has("result"));
	CHECK(h.answer(22).has("result"));
	h.server.join();
	CHECK(!timed_out);
	std::lock_guard<std::mutex> lock(h.m);
	size_t at20 = 0, at22 = 0;
	for (size_t i = 0; i < h.out.size(); ++i) {
		if (h.out[i]["id"] == Json(20)) at20 = i;
		if (h.out[i]["id"] == Json(22)) at22 = i;
	}
	CHECK(at20 < at22); // project a's second request waited for its first
}

TEST("shutdown answers and stops the server") {
	Harness h;
	h.send(R"({"jsonrpc":"2.0","id":30,"method":"engine.shutdown"})");
	CHECK(h.answer(30)["result"]["ok"].as_bool());
	CHECK(h.server.stopping());
}

CHECK_MAIN
