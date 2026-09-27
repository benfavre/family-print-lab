// GCodeProcessorResult::MoveVertex (GCodeProcessor.hpp at upstream.lock): the same processed
// toolpaths Studio previews. store_move_vertex stores extruder_id as the zero-based filament id,
// and finalize replaces layer_duration with seconds. Arc interpolation already includes offsets.
#include <algorithm>
#include <cmath>
#include <boost/nowide/fstream.hpp>
#include <limits>

#include "rpc/convert.hpp"
#include "upstream.hpp"

namespace printlab::upstream {
using namespace Slic3r;
namespace {
preview::Point point(const Vec3f &p) { return {p.x(), p.y(), p.z()}; }
uint8_t feature(const GCodeProcessorResult::MoveVertex &m) {
	if (m.type == EMoveType::Travel) return 1;
	if (m.type == EMoveType::Wipe) return 19;
	const auto &names = preview::features();
	const std::string name = ExtrusionEntity::role_to_string(m.extrusion_role);
	auto it = std::find(names.begin(), names.end(), name);
	return it == names.end() ? 0 : static_cast<uint8_t>(it - names.begin());
}
bool motion(EMoveType type) {
	return type == EMoveType::Travel || type == EMoveType::Extrude || type == EMoveType::Wipe ||
	       type == EMoveType::Retract || type == EMoveType::Unretract;
}
} // namespace

PreviewResult UpstreamFacade::preview_get(const std::string &project_id, int plate, const std::string &path, bool travel) {
	auto state = project(project_id);
	std::lock_guard<std::mutex> lock(state->mutex);
	auto found = state->sliced.find(plate);
	if (found == state->sliced.end()) throw EngineError(err::INVALID_PARAMS, "Slice this plate before opening its preview.", "plate", "plate");
	const PlateResult &result = *found->second;
	std::vector<preview::Segment> segments;
	const auto &moves = result.gcode.moves;
	preview::Point previous = moves.empty() ? preview::Point{} : point(moves.front().position);
	for (size_t i = 1; i < moves.size(); ++i) {
		const auto &m = moves[i];
		// Seam vertices are display markers between the actual positions (process_G1/process_G2_G3).
		if (m.type == EMoveType::Seam) continue;
		preview::Point from = previous;
		previous = point(m.position);
		if (m.type != EMoveType::Extrude && m.type != EMoveType::Wipe && !(travel && m.type == EMoveType::Travel)) continue;
		const uint8_t role = feature(m);
		auto append = [&](const Vec3f &position) {
			preview::Point to = point(position);
			if (from != to) segments.push_back({from, to, role, m.extruder_id, m.width, m.height,
			                                    m.feedrate, m.print_z, m.layer_duration});
			from = to;
		};
		if (m.is_arc_move_with_interpolation_points())
			for (const auto &position : m.interpolation_points) append(position);
		append(m.position);
	}
	std::vector<preview::Tool> tools;
	const auto *colours = result.config.option<ConfigOptionStrings>("filament_colour");
	const auto *types = result.config.option<ConfigOptionStrings>("filament_type");
	for (size_t i = 0; i < result.gcode.filaments_count; ++i)
		tools.push_back({static_cast<int>(i), colours ? colours->get_at(i) : "#FFFFFF", types ? types->get_at(i) : ""});
	try {
		auto header = preview::header(segments, plate, tools, result.stats.seconds);
		auto bytes = preview::encode(segments, to_json(header).dump());
		boost::nowide::ofstream out(path, std::ios::binary);
		out.write(reinterpret_cast<const char *>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
		out.close();
		if (!out) throw std::runtime_error("Could not write " + path);
		return {path, std::move(header)};
	} catch (const std::exception &e) {
		throw EngineError(err::EXPORT_FAILED, "The toolpath preview could not be written.", e.what());
	}
}

std::vector<ObjectStats> UpstreamFacade::object_stats(const PlateResult &result) const {
	// ModelInstance::get_labeled_id is what GCode.cpp emits in the start/stop object comments,
	// and GCodeProcessor.cpp process_tags preserves in object_label_id. Single-object and calibration
	// prints do not emit those comments: their values remain null, never a share of the plate total.
	std::map<int, size_t> labels;
	std::vector<ObjectStats> stats;
	for (size_t i = 0; i < result.object_ids.size(); ++i) {
		stats.push_back({result.object_ids[i], std::nullopt, std::nullopt});
		for (const auto *instance : result.model->objects[i]->instances) {
			auto label = instance->get_labeled_id();
			if (label <= static_cast<size_t>(std::numeric_limits<int>::max())) labels[static_cast<int>(label)] = i;
		}
	}
	std::vector<bool> invalid_weight(stats.size(), false);
	bool valid_timeline = true;
	double previous_time = 0;
	for (const auto &m : result.gcode.moves) {
		if (!motion(m.type) && m.type != EMoveType::Tool_change) continue;
		double seconds = m.time[0] - previous_time;
		previous_time = m.time[0];
		if (!std::isfinite(seconds) || seconds < 0) valid_timeline = false;
		if (m.type == EMoveType::Tool_change) continue; // tool-change overhead is shared, not object work
		// Upstream can assign a motion timestamp to an inserted seam marker instead of the motion.
		// A resulting backward clock makes all object times unavailable: a later positive delta
		// could otherwise count the missing interval twice.
		auto label = labels.find(m.object_label_id);
		if (label == labels.end()) continue;
		size_t index = label->second;
		auto &s = stats[index];
		if (std::isfinite(seconds) && seconds >= 0) s.seconds = s.seconds.value_or(0) + seconds;

		if (m.type != EMoveType::Extrude || m.extrusion_role == erCustom || m.extrusion_role == erWipeTower || m.extrusion_role == erFlush) continue;
		// delta_extruder is consumed filament length, not nozzle travel; this preserves arc length and
		// flow multipliers. Densities are g/cm³, lengths and diameter are mm.
		size_t filament = m.extruder_id;
		if (filament >= result.gcode.filament_diameters.size() || filament >= result.gcode.filament_densities.size()) {
			invalid_weight[index] = true;
			continue;
		}
		double diameter = result.gcode.filament_diameters[filament];
		double density = result.gcode.filament_densities[filament];
		double grams = m.delta_extruder * diameter * diameter * std::acos(-1.0) * density / 4000.0;
		if (std::isfinite(grams) && grams >= 0 && diameter > 0 && density > 0) s.grams = s.grams.value_or(0) + grams;
		else invalid_weight[index] = true;
	}
	for (size_t i = 0; i < stats.size(); ++i) {
		if (!valid_timeline) stats[i].seconds.reset();
		if (invalid_weight[i]) stats[i].grams.reset();
	}
	return stats;
}
} // namespace printlab::upstream
