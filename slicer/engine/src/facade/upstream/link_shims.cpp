// What libslic3r needs at link time but upstream only builds with the GUI (src/slic3r), so a headless
// build of Bambu Studio does not link as it stands (its own CLI is always built with the GUI):
//
// - nanosvg: libslic3r's NSVGUtils.cpp calls it, and only the GUI's BitmapCache.cpp compiles the
//   implementation. We compile it here from upstream's bundled header.
// - Slic3r::Http (src/slic3r/Utils/Http.cpp): LogSink.cpp fetches a log encryption key from Bambu's
//   servers when the GUI turns encrypted logs on. The engine never does, and must make no network
//   requests at all, so every request here does nothing: no socket is opened, the callbacks are never
//   called and LogSink keeps its built-in key.
// - Slic3r::BBL_Encrypt (src/slic3r/Utils/BBLUtil.cpp): the same encrypted logs. Encryption reports
//   failure, and LogSink then writes nothing encrypted.
//
// Nothing else from src/slic3r is linked (slicer/UPSTREAM.md: no GUI, no bambu_networking).
#define NANOSVG_IMPLEMENTATION
#include "nanosvg/nanosvg.h"

#include "slic3r/Utils/BBLUtil.hpp"
#include "slic3r/Utils/Http.hpp"

namespace Slic3r {

struct Http::priv {};

Http::Http(const std::string &) : p(new priv) {}
Http::Http(Http &&other) : p(std::move(other.p)) {}
Http::~Http() = default;
Http Http::get(std::string url) { return Http(url); }
Http &Http::timeout_max(long) { return *this; }
Http &Http::on_complete(CompleteFn) { return *this; }
Http &Http::on_error(ErrorFn) { return *this; }
void Http::perform_sync() {}

bool BBL_Encrypt::AES256CBC_Encrypt(unsigned char *, unsigned, unsigned char *, unsigned &out_len, const std::string &,
                                    const std::string &) {
	out_len = 0;
	return false;
}

bool BBL_Encrypt::AES256CBC_Decrypt(unsigned char *, unsigned, unsigned char *, unsigned &out_len, const std::string &,
                                    const std::string &) {
	out_len = 0;
	return false;
}

} // namespace Slic3r
