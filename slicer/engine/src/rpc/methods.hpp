// Binds the protocol's methods (protocol.ts EngineMethods) to the facade. Talks only to facade/ and
// features/, never to upstream.
#pragma once

#include "../facade/facade.hpp"
#include "server.hpp"

namespace printlab {

struct EngineOptions {
	/** PRINTLAB_ENGINE_TEST=1: adds test.wait (progress and cancel without slicing), for conformance tests. */
	bool test_methods = false;
};

void register_methods(Server &server, Facade &facade, const EngineOptions &options);

} // namespace printlab
