#include <cstdio>

namespace {
// Match an upstream static initializer that logs before main, in a different translation unit.
struct StartupLog {
	StartupLog() {
		std::fputs("printlab startup fixture\n", stdout);
		std::fflush(stdout);
	}
};
StartupLog startup_log;
}
