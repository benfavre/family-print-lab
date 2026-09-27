#include "server.hpp"

#include "convert.hpp"

#include <cstdio>

#ifdef _WIN32
#include <io.h>
#define read_fd _read
#else
#include <unistd.h>
#define read_fd ::read
#endif

namespace printlab {

void LineSplitter::feed(const char *data, size_t n, const std::function<void(std::string)> &line,
                        const std::function<void()> &too_long) {
	size_t start = 0;
	for (size_t i = 0; i < n; ++i) {
		if (data[i] != '\n') continue;
		if (skipping_) skipping_ = false;
		else {
			buf_.append(data + start, i - start);
			if (!buf_.empty() && buf_.back() == '\r') buf_.pop_back();
			std::string out;
			out.swap(buf_);
			if (!out.empty()) line(std::move(out));
		}
		start = i + 1;
	}
	if (skipping_) return;
	buf_.append(data + start, n - start);
	if (buf_.size() > max_line_) {
		buf_.clear();
		skipping_ = true;
		too_long();
	}
}

Server::Server(Writer write) : write_(std::move(write)) {}

Server::~Server() {
	request_stop();
	join();
}

void Server::add(const std::string &name, Method m) { methods_[name] = std::move(m); }

void Server::set_capabilities(std::vector<std::string> caps) { caps_ = {caps.begin(), caps.end()}; }

void Server::respond(const Json &id, Json result) {
	Json msg(Json::Object{{"jsonrpc", "2.0"}, {"id", id}, {"result", std::move(result)}});
	std::lock_guard<std::mutex> lock(write_mutex_);
	write_(msg.dump());
}

void Server::fail(const Json &id, int code, const std::string &message, const std::string &detail,
                  const std::string &key, const std::string &object_id) {
	// error.data.message is plain words for the UI (protocol.ts EngineErrorData).
	Json data(Json::Object{{"message", message}});
	if (!detail.empty()) data["detail"] = detail;
	if (!key.empty()) data["key"] = key;
	if (!object_id.empty()) data["objectId"] = object_id;
	Json msg(Json::Object{{"jsonrpc", "2.0"},
	                      {"id", id},
	                      {"error", Json(Json::Object{{"code", code}, {"message", message}, {"data", data}})}});
	std::lock_guard<std::mutex> lock(write_mutex_);
	write_(msg.dump());
}

void Server::notify(const std::string &method, Json params) {
	Json msg(Json::Object{{"jsonrpc", "2.0"}, {"method", method}, {"params", std::move(params)}});
	std::lock_guard<std::mutex> lock(write_mutex_);
	write_(msg.dump());
}

void Server::log(const std::string &level, const std::string &message) {
	notify("$/log", Json(Json::Object{{"level", level}, {"message", message}}));
}

void Server::handle_line(const std::string &line) {
	Json msg;
	try {
		msg = Json::parse(line);
	} catch (const Json::ParseError &e) {
		fail(Json(), err::PARSE, "The slicer received a message it could not read.", e.what());
		return;
	}
	if (!msg.is_object() || msg["jsonrpc"] != Json("2.0") || !msg["method"].is_string()) {
		fail(msg["id"], err::INVALID_REQUEST, "The slicer received an invalid request.");
		return;
	}
	const std::string &method = msg["method"].as_string();
	if (method == "$/cancel") {
		std::lock_guard<std::mutex> lock(mutex_);
		auto it = cancels_.find(msg["params"]["id"].dump());
		if (it != cancels_.end()) it->second->cancelled = true;
		return;
	}
	if (!msg.has("id")) return; // other notifications: none defined yet
	const Json &id = msg["id"];
	if (!id.is_number() && !id.is_string()) {
		fail(Json(), err::INVALID_REQUEST, "The slicer received a request without a usable id.");
		return;
	}
	dispatch(id, method, msg["params"].is_null() ? Json::object() : msg["params"]);
}

void Server::dispatch(Json id, const std::string &name, Json params) {
	auto it = methods_.find(name);
	if (it == methods_.end()) {
		fail(id, err::METHOD_NOT_FOUND, "This version of the slicer does not know that request.", name);
		return;
	}
	const Method &m = it->second;
	if (!m.capability.empty() && !caps_.count(m.capability)) {
		fail(id, err::CAPABILITY_MISSING, "This version of the slicer cannot do that yet.", m.capability, m.capability);
		return;
	}
	if (!params.is_object()) {
		fail(id, err::INVALID_PARAMS, "The slicer was sent something it cannot read.", "params must be an object");
		return;
	}
	auto cancel = std::make_shared<CancelToken>();
	auto job = [this, id, name, params, cancel, &m]() {
		CallContext ctx{id, cancel, [this, id](const Progress &p) {
			                notify("$/progress", Json(Json::Object{{"id", id}, {"progress", to_json(p)}}));
		                }};
		try {
			Json result = m.run(params, ctx);
			// A cancelled request answers CANCELLED even when the work ended anyway (inline methods cannot be cancelled).
			if (cancel->cancelled && !m.inline_) fail(id, err::CANCELLED, "Cancelled.");
			else respond(id, std::move(result));
		} catch (const EngineError &e) {
			fail(id, e.code, e.what(), e.detail, e.key, e.object_id);
		} catch (const Json::TypeError &e) {
			fail(id, err::INVALID_PARAMS, "The slicer was sent something it cannot read.", e.what());
		} catch (const std::exception &e) {
			fail(id, err::UPSTREAM_EXCEPTION, "The slicer ran into a problem.", e.what());
		} catch (...) {
			fail(id, err::INTERNAL, "The slicer ran into a problem.");
		}
		std::lock_guard<std::mutex> lock(mutex_);
		cancels_.erase(id.dump());
	};
	{
		std::lock_guard<std::mutex> lock(mutex_);
		cancels_[id.dump()] = cancel;
	}
	if (m.inline_) job();
	else enqueue(params["projectId"].is_string() ? "project:" + params["projectId"].as_string() : "", std::move(job));
}

void Server::enqueue(const std::string &key, std::function<void()> job) {
	std::lock_guard<std::mutex> lock(mutex_);
	Strand &s = strands_[key];
	s.queue.push_back(std::move(job));
	if (!s.running) {
		s.running = true;
		if (s.thread.joinable()) s.thread.join(); // the previous run of this strand has returned
		s.thread = std::thread([this, key] { strand_loop(key); });
	}
}

void Server::strand_loop(const std::string &key) {
	for (;;) {
		std::function<void()> job;
		{
			std::lock_guard<std::mutex> lock(mutex_);
			Strand &s = strands_[key];
			if (s.queue.empty()) {
				s.running = false;
				idle_.notify_all();
				return;
			}
			job = std::move(s.queue.front());
			s.queue.pop_front();
		}
		job();
	}
}

void Server::request_stop() {
	std::lock_guard<std::mutex> lock(mutex_);
	stopping_ = true;
	for (auto &kv : cancels_) kv.second->cancelled = true;
}

bool Server::stopping() const {
	std::lock_guard<std::mutex> lock(const_cast<std::mutex &>(mutex_));
	return stopping_;
}

void Server::join() {
	std::unique_lock<std::mutex> lock(mutex_);
	idle_.wait(lock, [this] {
		for (auto &kv : strands_)
			if (kv.second.running) return false;
		return true;
	});
	for (auto &kv : strands_)
		if (kv.second.thread.joinable()) kv.second.thread.join();
}

void Server::run(int fd) {
	LineSplitter splitter;
	char buf[65536];
	while (!stopping()) {
		auto n = read_fd(fd, buf, sizeof buf);
		if (n <= 0) break;
		splitter.feed(
		    buf, static_cast<size_t>(n), [this](std::string line) { handle_line(line); },
		    [this] { fail(Json(), err::INVALID_REQUEST, "The slicer received a message too long to read."); });
	}
	request_stop();
	join();
}

} // namespace printlab
