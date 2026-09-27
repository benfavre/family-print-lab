// printlab-slicer: Print Lab's headless slicing engine, built from Bambu Studio's libslic3r at the
// tag in slicer/upstream.lock (see slicer/UPSTREAM.md). It speaks the Slicer Engine Protocol on stdin
// and stdout; stdout is kept for protocol lines only, so at startup the real stdout is set aside and
// everything else that prints to stdout (upstream's logging included) goes to stderr.
#include <clocale>
#include <cstdlib>
#include <cstring>
#include <string>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#define dup_fd _dup
#define dup2_fd _dup2
#define write_fd _write
#else
#include <csignal>
#include <unistd.h>
#define dup_fd ::dup
#define dup2_fd ::dup2
#define write_fd ::write
#endif

#include "facade/facade.hpp"
#include "rpc/methods.hpp"
#include "rpc/server.hpp"
#include "version.hpp"

int main(int argc, char **argv) {
	if (argc > 1 && (std::strcmp(argv[1], "--version") == 0)) {
		std::printf("printlab-slicer %s (%s %s)\n", PRINTLAB_ENGINE_VERSION, PRINTLAB_UPSTREAM_NAME, PRINTLAB_UPSTREAM_TAG);
		return 0;
	}
	// Numbers in JSON and in upstream's config files use '.', whatever the user's locale.
	std::setlocale(LC_NUMERIC, "C");
#ifndef _WIN32
	std::signal(SIGPIPE, SIG_IGN); // the app went away: writes fail and the read loop ends
#endif

	// Protocol on the original stdout; anything else printed to stdout lands on stderr.
	std::fflush(stdout);
	int proto = dup_fd(1);
	dup2_fd(2, 1);
#ifdef _WIN32
	_setmode(proto, _O_BINARY);
	_setmode(0, _O_BINARY);
#endif

	printlab::Server server([proto](const std::string &line) {
		std::string out = line + "\n";
		const char *p = out.data();
		size_t left = out.size();
		while (left > 0) {
			auto n = write_fd(proto, p, static_cast<unsigned>(left));
			if (n <= 0) return;
			p += n;
			left -= static_cast<size_t>(n);
		}
	});
	auto facade = printlab::make_facade();
	printlab::EngineOptions options;
	const char *test = std::getenv("PRINTLAB_ENGINE_TEST");
	options.test_methods = test && std::strcmp(test, "1") == 0;
	printlab::register_methods(server, *facade, options);
	std::fprintf(stderr, "printlab-slicer %s (%s %s) ready\n", PRINTLAB_ENGINE_VERSION, PRINTLAB_UPSTREAM_NAME,
	             PRINTLAB_UPSTREAM_TAG);
	server.run(0);
	return 0;
}
