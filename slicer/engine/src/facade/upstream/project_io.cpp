// libslic3r owns model import/export; the project preservation layer retains fields its slicing
// model normalises or drops. Bambu's archive constants and extension handling follow the pin.
// origin: BambuStudio src/libslic3r/Format/bbs_3mf.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
#include <boost/nowide/fstream.hpp>
#include <iomanip>
#include <sstream>
#include <boost/filesystem.hpp>
#include <openssl/sha.h>
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/miniz_extension.hpp"
#include "libslic3r/Utils.hpp"
#include "features/project/project.hpp"
#include "rpc/convert.hpp"
#include "upstream.hpp"

namespace printlab::upstream {
using namespace Slic3r;
namespace fs = boost::filesystem;
namespace {
std::string file_bytes(const std::string &path) {
	boost::nowide::ifstream in(path, std::ios::binary);
	if (!in)
		throw std::runtime_error("Could not read " + path);
	return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}
struct Zip {
	mz_zip_archive archive{};
	bool write;
	Zip(const std::string &path, bool writing) : write(writing) {
		if (!(write ? open_zip_writer(&archive, path) : open_zip_reader(&archive, path)))
			throw std::runtime_error("Could not open 3MF " + path);
	}
	~Zip() {
		if (write)
			close_zip_writer(&archive);
		else
			close_zip_reader(&archive);
	}
};
project_io::Files read_archive(const std::string &path) {
	Zip zip(path, false);
	project_io::Files files;
	uint64_t remaining = 1024ull * 1024 * 1024;
	for (mz_uint i = 0; i < mz_zip_reader_get_num_files(&zip.archive); ++i) {
		mz_zip_archive_file_stat stat{};
		if (!mz_zip_reader_file_stat(&zip.archive, i, &stat))
			throw std::runtime_error("Unreadable 3MF archive entry.");
		if (stat.m_is_directory)
			continue;
		std::string name = stat.m_filename;
		if (name.empty() || files.count(name))
			throw std::runtime_error("Duplicate or unnamed 3MF archive entry.");
		if (stat.m_uncomp_size > remaining)
			throw std::runtime_error("The 3MF unpacks to more than 1 GB.");
		remaining -= stat.m_uncomp_size;
		std::string bytes(static_cast<size_t>(stat.m_uncomp_size), '\0');
		if (!mz_zip_reader_extract_to_mem(&zip.archive, i, bytes.data(), bytes.size(), 0))
			throw std::runtime_error("Could not unpack " + name);
		files.emplace(std::move(name), std::move(bytes));
	}
	return files;
}
void write_archive(const std::string &path, const project_io::Files &files) {
	Zip zip(path, true);
	for (const auto &kv : files)
		if (!mz_zip_writer_add_mem(&zip.archive, kv.first.c_str(), kv.second.data(), kv.second.size(),
								   MZ_DEFAULT_COMPRESSION))
			throw std::runtime_error("Could not write " + kv.first);
	if (!mz_zip_writer_finalize_archive(&zip.archive))
		throw std::runtime_error("Could not finish the 3MF archive.");
}
struct Imported {
	Model model;
	DynamicPrintConfig config;
	PlateDataPtrs plates;
	std::vector<Preset *> presets;
	~Imported() {
		release_PlateData_list(plates);
		for (auto *preset : presets)
			delete preset;
	}
};
void load_core(const std::string &path, Imported &result) {
	ConfigSubstitutionContext substitutions(ForwardCompatibilitySubstitutionRule::EnableSilent);
	bool bambu = false;
	Semver version;
	if (!load_bbs_3mf(path.c_str(), &result.config, &substitutions, &result.model, &result.plates, &result.presets,
					  &bambu, &version, nullptr, LoadStrategy::LoadModel | LoadStrategy::Silence))
		throw std::runtime_error("The upstream 3MF reader could not load this project.");
}
std::string hash(const std::string &bytes) {
	unsigned char digest[SHA256_DIGEST_LENGTH];
	SHA256(reinterpret_cast<const unsigned char *>(bytes.data()), bytes.size(), digest);
	std::ostringstream out;
	for (unsigned char c : digest)
		out << std::hex << std::setw(2) << std::setfill('0') << unsigned(c);
	return out.str();
}
struct Temporary {
	fs::path path;
	~Temporary() {
		boost::system::error_code ec;
		fs::remove(path, ec);
	}
};
} // namespace

OpenProjectResult UpstreamFacade::project_open(const std::string &path) {
	std::string id;
	try {
		auto files = read_archive(path);
		id = project_create({});
		std::string dir = (fs::path(work_dir_) / id / "meshes").string();
		fs::create_directories(dir);
		std::map<std::string, MeshInfo> infos;
		Json document = project_io::read(files, [&](const project_io::Mesh &mesh) {
			std::string stl = project_io::canonical_stl(mesh), mesh_id = hash(stl);
			std::string filename = (fs::path(dir) / (mesh_id + ".stl")).string();
			if (!infos.count(mesh_id)) {
				boost::nowide::ofstream out(filename, std::ios::binary);
				out.write(stl.data(), static_cast<std::streamsize>(stl.size()));
				out.close();
				if (!out)
					throw std::runtime_error("Could not write an imported mesh.");
				infos[mesh_id] = mesh_put(mesh_id, filename, "stl");
			}
			Json bounds = Json::array();
			for (double n : infos.at(mesh_id).bbox)
				bounds.push_back(n);
			return Json(Json::Object{{"id", mesh_id},
									 {"triangles", mesh.triangles.size()},
									 {"vertices", mesh.vertices.size()},
									 {"bbox", bounds},
									 {"storage", Json(Json::Object{{"kind", "file"}, {"path", filename}})}});
		});
		// The importer reads height-range configs even without LoadConfig (bbs_3mf.cpp:2006).
		// Validate only the model package: unsupported settings must remain editable and saveable.
		project_io::Files geometry_files;
		for (const auto &entry : files) {
			const fs::path name(entry.first);
			if (entry.first == "[Content_Types].xml" || name.extension() == ".model" || name.extension() == ".rels")
				geometry_files.insert(entry);
		}
		Temporary geometry_file{fs::path(dir) / "geometry.3mf"};
		write_archive(geometry_file.path.string(), geometry_files);
		Imported loaded;
		load_core(geometry_file.path.string(), loaded);
		auto state = project(id);
		std::lock_guard<std::mutex> lock(state->mutex);
		state->project = project_from(document, "project");
		state->config = project_config({}, {});
		try {
			state->config = project_config({}, state->project.project_config);
		} catch (const std::exception &e) {
			// Opening is not slicing. Keep the setting verbatim, but never slice using defaults instead.
			state->config_error = e.what();
		}
		return {id, dir, state->project, std::move(infos)};
	} catch (const std::exception &e) {
		if (!id.empty())
			project_close(id);
		throw EngineError(err::FILE_READ, "That project file could not be read.", e.what());
	}
}

void UpstreamFacade::project_save(const std::string &project_id, const std::string &path,
								  const std::vector<PlateImages> &images) {
	auto state = project(project_id);
	std::lock_guard<std::mutex> lock(state->mutex);
	try {
		Json document = to_json(state->project, {});
		for (const auto &image : images) {
			for (auto &plate : document["plates"].as_array())
				if (plate["index"] == Json(image.plate)) {
					for (const auto &entry :
						 std::vector<std::pair<std::string, std::string>>{{"thumbnail", image.thumbnail},
																		  {"no_light_thumbnail_file", image.no_light},
																		  {"top_file", image.top},
																		  {"pick_file", image.pick}}) {
						if (entry.second.empty())
							continue;
						std::string name = "Metadata/" + entry.first + "_" + std::to_string(image.plate) + ".png";
						document["passthrough"][name] = Json(Json::Object{{"path", entry.second}});
						if (entry.first == "thumbnail")
							plate["thumbnail"] = name;
						else
							plate["config"][entry.first] = name;
					}
				}
		}
		auto files = project_io::write(
			document,
			[&](const std::string &mesh_id) {
				auto source = state->project.meshes.find(mesh_id);
				if (source != state->project.meshes.end()) {
					try {
						return project_io::stl_mesh(file_bytes(source->second.path));
					} catch (const std::invalid_argument &) {
					} // ASCII STL/OBJ uploads use upstream's imported mesh.
				}
				const auto &its = mesh(state->project, mesh_id).mesh.its;
				project_io::Mesh plain;
				for (const auto &v : its.vertices)
					plain.vertices.push_back({v.x(), v.y(), v.z()});
				for (const auto &t : its.indices)
					plain.triangles.push_back({unsigned(t[0]), unsigned(t[1]), unsigned(t[2])});
				return plain;
			},
			file_bytes);
		// Run the upstream model exporter to validate that the edited geometry remains exportable.
		// Serialise the final archive with the preservation codec: the slicing model normalises
		// source transforms and cannot hold unknown config/XML or the app's tray/spool references.
		Temporary core{fs::path(scratch()) / fs::unique_path("project-%%%%-%%%%.3mf")};
		fs::create_directories(core.path.parent_path());
		ProjectState geometry;
		geometry.project = state->project;
		geometry.project.project_config.clear();
		for (auto &object : geometry.project.objects) {
			object.config.clear();
			object.height_ranges.clear();
			object.layer_height_profile.clear();
			for (auto &part : object.parts) {
				part.config.clear();
				part.filament = 0;
				part.paint_supports.clear();
				part.paint_seam.clear();
				part.paint_color.clear();
				part.paint_fuzzy_skin.clear();
			}
		}
		auto model = build_model(geometry, 0, nullptr);
		DynamicPrintConfig config = project_config({}, {});
		StoreParams params;
		std::string core_path = core.path.string();
		params.path = core_path.c_str();
		params.model = model.get();
		params.config = &config;
		params.strategy =
			SaveStrategy::Silence | SaveStrategy::SplitModel | SaveStrategy::Zip64 | SaveStrategy::SkipAuxiliary;
		if (!store_bbs_3mf(params))
			throw std::runtime_error("The upstream 3MF writer could not save this project.");
		// All modelled entries are intentional, and the preservation codec already carries every
		// passthrough entry. Do not add exporter-generated defaults the source project never contained.
		Temporary output{fs::path(path).parent_path() / fs::unique_path(".printlab-%%%%-%%%%.3mf")};
		write_archive(output.path.string(), files);
		if (auto error = rename_file(output.path.string(), path))
			throw std::runtime_error(error.message());
	} catch (const std::exception &e) {
		throw EngineError(err::EXPORT_FAILED, "The project file could not be written.", e.what());
	}
}
} // namespace printlab::upstream
