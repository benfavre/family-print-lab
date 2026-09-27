// The facade of a build without Bambu Studio (PRINTLAB_WITH_UPSTREAM=OFF): the protocol layer works
// (hello, ping, shutdown, errors, cancel) and every slicing capability is absent, so clients fall back
// to the command line. Used by the engine's own tests and by CI jobs that cannot build upstream.
#include "facade.hpp"
#include "identity.hpp"

namespace printlab {

namespace {

[[noreturn]] void missing() {
	throw EngineError(err::CAPABILITY_MISSING, "This build of Print Lab Slicer has no slicing core.",
	                  "built with PRINTLAB_WITH_UPSTREAM=OFF");
}

class NullFacade final : public Facade {
public:
	EngineIdentity identity() const override { return build_identity(); }
	std::vector<std::string> capabilities() const override { return {}; }
	void configure(const std::string &, const std::string &) override {}
	MeshInfo mesh_put(const std::string &, const std::string &, const std::string &) override { missing(); }
	void mesh_drop(const std::vector<std::string> &) override {}
	std::string project_create(const PresetSelection &) override { missing(); }
	SyncResult project_sync(const std::string &, const Project &, const ResolvedBundle &) override { missing(); }
	void project_close(const std::string &) override {}
	ValidateResult config_validate(const std::string &, int) override { missing(); }
	std::vector<Arranged> arrange(const std::string &, int, double, bool, const std::string &, const ProgressFn &,
	                              const CancelToken &) override {
		missing();
	}
	std::vector<Oriented> orient(const std::string &, const std::vector<std::string> &, const ProgressFn &,
	                             const CancelToken &) override {
		missing();
	}
	PlateStats slice(const std::string &, int, const ProgressFn &, const CancelToken &) override { missing(); }
	ExportResult export_gcode3mf(const std::string &, const std::vector<int> &, const std::string &,
	                             const std::vector<PlateImages> &, bool) override {
		missing();
	}
	CalibResult calib_generate(const calib::Request &, const PresetSelection &, const ResolvedBundle &,
	                           const std::string &) override {
		missing();
	}
	std::vector<PresetSummary> profiles_list(PresetKind, const std::string &) override { missing(); }
	ResolvedBundle profiles_resolve(const PresetSelection &, const std::string &) override { missing(); }
};

} // namespace

std::unique_ptr<Facade> make_facade() { return std::make_unique<NullFacade>(); }

} // namespace printlab
