// The Slicer Engine Protocol server: newline-delimited JSON-RPC 2.0 (app/src/lib/shared/slicer/
// protocol.ts). The reader thread splits lines and answers cheap methods at once; everything else runs
// on a strand per projectId (requests for one project in order, different projects side by side).
// $/cancel sets the request's cancel token. Output lines are written whole under a lock.
#pragma once

#include <condition_variable>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "../facade/facade.hpp"
#include "json.hpp"

namespace printlab {

/** Splits a byte stream into lines; a line longer than `max_line` is dropped and reported. */
class LineSplitter {
public:
	explicit LineSplitter(size_t max_line = 64 * 1024 * 1024) : max_line_(max_line) {}
	/** Calls `line` for each complete line (without "\n" or a trailing "\r"); `too_long` for dropped ones. */
	void feed(const char *data, size_t n, const std::function<void(std::string)> &line,
	          const std::function<void()> &too_long);

private:
	std::string buf_;
	size_t max_line_;
	bool skipping_ = false;
};

struct CallContext {
	Json id;
	std::shared_ptr<CancelToken> cancel;
	ProgressFn progress;
};

struct Method {
	/** Capability the method needs; empty for methods every engine has. */
	std::string capability;
	/** Runs on the reader thread (cheap, must not block). */
	bool inline_ = false;
	std::function<Json(const Json &params, CallContext &ctx)> run;
};

class Server {
public:
	using Writer = std::function<void(const std::string &line)>;
	explicit Server(Writer write);
	~Server();

	void add(const std::string &name, Method m);
	/** Capabilities the engine reports; methods whose capability is not listed answer CAPABILITY_MISSING. */
	void set_capabilities(std::vector<std::string> caps);

	/** One protocol line from the client. */
	void handle_line(const std::string &line);
	/** Reads `fd` until EOF or shutdown, then waits for running requests. */
	void run(int fd);
	/** Stops accepting requests; running ones finish. */
	void request_stop();
	bool stopping() const;
	/** Waits for every strand to drain. */
	void join();

	void notify(const std::string &method, Json params);
	void log(const std::string &level, const std::string &message);

private:
	struct Strand {
		std::deque<std::function<void()>> queue;
		std::thread thread;
		bool running = false;
	};
	void respond(const Json &id, Json result);
	void fail(const Json &id, int code, const std::string &message, const std::string &detail = {},
	          const std::string &key = {}, const std::string &object_id = {});
	void dispatch(Json id, const std::string &method, Json params);
	void enqueue(const std::string &strand, std::function<void()> job);
	void strand_loop(const std::string &key);

	Writer write_;
	std::mutex write_mutex_;
	std::map<std::string, Method> methods_;
	std::set<std::string> caps_;

	std::mutex mutex_;
	std::condition_variable idle_;
	std::map<std::string, Strand> strands_;
	std::map<std::string, std::shared_ptr<CancelToken>> cancels_; // by request id (dumped)
	bool stopping_ = false;
};

} // namespace printlab
