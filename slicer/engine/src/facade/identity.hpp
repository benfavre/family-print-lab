#pragma once

#include "types.hpp"

namespace printlab {

/** The pin and patch queue this binary was built from (profiles are filled in by the facade). */
EngineIdentity build_identity();

} // namespace printlab
