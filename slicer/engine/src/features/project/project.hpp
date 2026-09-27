// Lossless project fields, following the TypeScript slicer3mf reader/writer. ZIP and libslic3r stay
// in the facade; this module handles portable archive entries and plain geometry only.
#pragma once
#include <array>
#include <functional>
#include <map>
#include <string>
#include <vector>
#include "rpc/json.hpp"

namespace printlab::project_io {
using Files = std::map<std::string, std::string>;
struct Mesh {
	std::vector<std::array<float, 3>> vertices;
	std::vector<std::array<unsigned, 3>> triangles;
};
using StoreMesh = std::function<Json(const Mesh &)>;
using LoadMesh = std::function<Mesh(const std::string &)>;
/** StoreMesh returns the MeshRef, including its canonical content hash and local path. */
Json read(const Files &files, const StoreMesh &store);
Files write(const Json &project, const LoadMesh &load,
			const std::function<std::string(const std::string &)> &read_file);
std::string canonical_stl(const Mesh &mesh);
Mesh stl_mesh(const std::string &stl);
std::string base64(const std::string &bytes);
std::string unbase64(const std::string &text);
} // namespace printlab::project_io
