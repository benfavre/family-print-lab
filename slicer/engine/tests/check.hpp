// A few lines of test harness: CHECK records failures and main() returns non-zero when any failed.
#pragma once

#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace check {
inline int &failures() {
	static int n = 0;
	return n;
}
inline std::vector<std::pair<const char *, std::function<void()>>> &tests() {
	static std::vector<std::pair<const char *, std::function<void()>>> t;
	return t;
}
struct Register {
	Register(const char *name, std::function<void()> fn) { tests().emplace_back(name, std::move(fn)); }
};
inline int run() {
	for (auto &t : tests()) {
		int before = failures();
		try {
			t.second();
		} catch (const std::exception &e) {
			std::fprintf(stderr, "  %s: threw %s\n", t.first, e.what());
			++failures();
		}
		std::fprintf(stderr, "%s %s\n", failures() == before ? "ok  " : "FAIL", t.first);
	}
	return failures() ? 1 : 0;
}
} // namespace check

#define CHECK_CAT2(a, b) a##b
#define CHECK_CAT(a, b) CHECK_CAT2(a, b)
#define TEST(name)                                                                                                     \
	static void CHECK_CAT(test_, __LINE__)();                                                                          \
	static check::Register CHECK_CAT(reg_, __LINE__)(name, CHECK_CAT(test_, __LINE__));                                \
	static void CHECK_CAT(test_, __LINE__)()
#define CHECK(cond)                                                                                                    \
	do {                                                                                                               \
		if (!(cond)) {                                                                                                 \
			std::fprintf(stderr, "  %s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #cond);                           \
			++check::failures();                                                                                       \
		}                                                                                                              \
	} while (0)
#define CHECK_EQ(a, b)                                                                                                 \
	do {                                                                                                               \
		auto _a = (a);                                                                                                 \
		auto _b = (b);                                                                                                 \
		if (!(_a == _b)) {                                                                                             \
			std::fprintf(stderr, "  %s:%d: %s == %s failed\n", __FILE__, __LINE__, #a, #b);                           \
			++check::failures();                                                                                       \
		}                                                                                                              \
	} while (0)
#define CHECK_MAIN                                                                                                     \
	int main() { return check::run(); }
