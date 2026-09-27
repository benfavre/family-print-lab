// A small pipe harness for the TypeScript/native codec conformance test. No upstream build needed.
#include <iostream>
#include <iterator>
#include <algorithm>
#include "features/project/project.hpp"
using namespace printlab;
using namespace printlab::project_io;
int main() {
	try {
		std::string input((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
		Json request = Json::parse(input);
		Files files;
		for (const auto &kv : request["files"].as_object())
			files[kv.first] = unbase64(kv.second.as_string());
		std::map<std::string, Mesh> meshes;
		std::map<std::string, std::string> contents;
		Json project = read(files, [&](const Mesh &mesh) {
			std::string stl = canonical_stl(mesh), id;
			for (const auto &kv : contents)
				if (kv.second == stl) {
					id = kv.first;
					break;
				}
			if (id.empty())
				id = "mesh-" + std::to_string(contents.size());
			contents[id] = stl;
			meshes[id] = mesh;
			std::array<double, 6> bbox{};
			for (size_t i = 0; i < mesh.vertices.size(); ++i)
				for (size_t k = 0; k < 3; ++k) {
					bbox[k] = i ? std::min(bbox[k], double(mesh.vertices[i][k])) : mesh.vertices[i][k];
					bbox[k + 3] = i ? std::max(bbox[k + 3], double(mesh.vertices[i][k])) : mesh.vertices[i][k];
				}
			Json bounds = Json::array();
			for (double n : bbox)
				bounds.push_back(n);
			return Json(Json::Object{{"id", id},
									 {"triangles", mesh.triangles.size()},
									 {"vertices", mesh.vertices.size()},
									 {"bbox", bounds},
									 {"storage", Json(Json::Object{{"kind", "file"}, {"path", id + ".stl"}})}});
		});
		if (request.has("project"))
			project = request["project"];
		Files written = write(
			project, [&](const std::string &id) { return meshes.at(id); },
			[](const std::string &) {
				throw std::runtime_error("Harness passthrough must be inline.");
				return std::string();
			});
		Json output = Json::object();
		output["project"] = project;
		output["files"] = Json::object();
		output["meshes"] = Json::object();
		for (const auto &kv : written)
			output["files"][kv.first] = base64(kv.second);
		for (const auto &kv : contents)
			output["meshes"][kv.first] = base64(kv.second);
		std::cout << output.dump() << '\n';
		return 0;
	} catch (const std::exception &e) {
		std::cerr << e.what() << '\n';
		return 1;
	}
}
