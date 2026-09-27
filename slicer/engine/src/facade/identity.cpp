// What both facades report about the build: the pin and the patch queue, from version.hpp.
#include "identity.hpp"

#include <sstream>

#include "version.hpp"

namespace printlab {

EngineIdentity build_identity() {
	EngineIdentity id;
	id.upstream_name = PRINTLAB_UPSTREAM_NAME;
	id.upstream_tag = PRINTLAB_UPSTREAM_TAG;
	id.upstream_commit = PRINTLAB_UPSTREAM_COMMIT;
	id.queue_version = PRINTLAB_QUEUE_VERSION;
	id.queue_hash = PRINTLAB_QUEUE_HASH;
	std::stringstream patches(PRINTLAB_PATCHES);
	for (std::string p; std::getline(patches, p, ',');)
		if (!p.empty()) id.patches.push_back(p);
	return id;
}

} // namespace printlab
