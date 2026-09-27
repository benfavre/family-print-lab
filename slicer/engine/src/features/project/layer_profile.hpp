// origin: BambuStudio src/libslic3r/Format/bbs_3mf.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// origin: BambuStudio src/libslic3r/Slicing.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// The importer rejects <=4 values (bbs_3mf.cpp:3035), though Slicing.cpp:794 accepts two points.
// A collinear midpoint preserves generate_object_layers' interpolation. Private metadata keeps
// the exact original representation, and is restored only while the side file remains unchanged.
#pragma once
#include "project.hpp"
#include <cmath>

namespace printlab::project_io {
inline bool two_point_profile(const Json &profile) {
	if (!profile.is_array() || profile.size() != 4)
		return false;
	for (const auto &v : profile.as_array())
		if (!v.is_number() || !std::isfinite(v.as_number()))
			return false;
	return profile[2].as_number() > profile[0].as_number() && profile[1].as_number() > 0 && profile[3].as_number() > 0;
}
inline Json studio_layer_profile(const Json &profile) {
	if (!two_point_profile(profile))
		return profile;
	return Json(Json::Array{profile[0], profile[1], profile[0].as_number() / 2 + profile[2].as_number() / 2,
							profile[1].as_number() / 2 + profile[3].as_number() / 2, profile[2], profile[3]});
}
inline Json restore_layer_profile(const Json &current, const Json &saved) {
	return two_point_profile(saved) && current == studio_layer_profile(saved) ? saved : current;
}
} // namespace printlab::project_io
