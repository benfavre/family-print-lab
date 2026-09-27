#!/usr/bin/env bash
# Builds Bambu Studio's dependency superbuild (slicer/.upstream/deps) for the headless engine, into
# ${PRINTLAB_SLICER_BUILD_DIR:-slicer/.build}/deps/usr/local. Called by `upstream.sh build`; run it on
# its own to warm a cache. Upstream's own options switch off what the GUI alone needs:
#   DEP_BUILD_WXWIDGETS=OFF  the GUI toolkit (the biggest dependency)
#   DEP_BUILD_FFMPEG=OFF     the camera view in the GUI
#   DEP_BUILD_LIBHARU=OFF    PDF export in the GUI
# The GL libraries are skipped too (dep_GLEW, dep_OpenCSG, dep_GLFW): only the GUI links them, and
# patch 0001 stops the top-level CMakeLists.txt from requiring them. They are what fails on a headless
# host (GLEW wants the GLU headers, GLFW on Linux wants extra-cmake-modules for Wayland).
#
#   build-deps.sh [-j N] [--print-key]
#
# The build is skipped when the stamp matches: the key is the upstream tag, the git tree hash of
# deps/ (so a patch touching deps/ rebuilds) and the platform. CI uses the same key for its cache.
set -euo pipefail

SLICER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UP="${PRINTLAB_UPSTREAM_DIR:-$SLICER/.upstream}"
BUILD="${PRINTLAB_SLICER_BUILD_DIR:-$SLICER/.build}"
JOBS=2
PRINT_KEY=0

die() {
	echo "build-deps.sh: $*" >&2
	exit 1
}
say() { echo "build-deps.sh: $*"; }
sha256() {
	if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

while [ $# -gt 0 ]; do
	case "$1" in
	-j)
		JOBS="${2:?-j needs a number}"
		shift 2
		;;
	-j*)
		JOBS="${1#-j}"
		shift
		;;
	--print-key)
		PRINT_KEY=1
		shift
		;;
	*) die "unknown option $1" ;;
	esac
done

[ -d "$UP/.git" ] || die "no upstream checkout at $UP: run upstream.sh fetch first."

platform() {
	local os arch
	os="$(uname -s | tr '[:upper:]' '[:lower:]')"
	case "$os" in mingw* | msys* | cygwin*) os=win32 ;; esac
	arch="$(uname -m)"
	case "$arch" in x86_64 | amd64) arch=x64 ;; aarch64) arch=arm64 ;; esac
	echo "$os-$arch"
}

# The upstream tag under our patches (upstream.sh fetch tags that commit printlab-base).
TAG="$(git -C "$UP" tag --points-at printlab-base 2>/dev/null | grep -v '^printlab-' | head -n 1 || true)"
PLATFORM="$(platform)"
# Configure from the build directory below. Keep override paths independent of that working
# directory, including Windows paths supplied by GitHub Actions to Git Bash.
if [[ "$PLATFORM" == win32-* ]]; then
	UP="$(cygpath -u "$UP")"
	BUILD="$(cygpath -u "$BUILD")"
fi
UP="$(cd "$UP" && pwd -P)"
case "$BUILD" in /*) ;; *) BUILD="$PWD/$BUILD" ;; esac
DEPS="$BUILD/deps"
case "$PLATFORM" in
win32-*)
	COMPILER="${CXX:-cl}"
	GENERATOR="${CMAKE_GENERATOR:-Visual Studio 17 2022}"
	COMPILER_VERSION="$("$COMPILER" 2>&1 || true)"
	command -v "$COMPILER" >/dev/null || die "MSVC is needed: use a Visual Studio developer shell."
	;;
*)
	COMPILER="${CXX:-c++}"
	GENERATOR="${CMAKE_GENERATOR:-Unix Makefiles}"
	COMPILER_VERSION="$("$COMPILER" --version)"
	;;
esac
# Installed dependencies are Release builds even when the engine is instrumented. Compiler,
# generator and architecture changes must not reuse an incompatible cached prefix.
FINGERPRINT="$(printf '%s\n' "$COMPILER_VERSION" "$GENERATOR" "${CMAKE_GENERATOR_PLATFORM:-}" \
	"${CFLAGS:-}" "${CXXFLAGS:-}" 'Release;DEP_DEBUG=OFF;headless-v3' |
	sha256 | cut -c1-12)"
KEY="deps-${TAG:-$(git -C "$UP" rev-parse --short HEAD)}-$(git -C "$UP" rev-parse HEAD:deps | cut -c1-12)-$PLATFORM-$FINGERPRINT"
if [ "$PRINT_KEY" = 1 ]; then
	echo "$KEY"
	exit 0
fi

if [ -f "$DEPS/.stamp" ] && [ "$(cat "$DEPS/.stamp")" = "$KEY" ] && [ -d "$DEPS/usr/local/lib" ]; then
	say "dependencies already built ($KEY)."
	exit 0
fi

# GMP's configure needs m4; some hosts (and minimal CI images) lack it. Build it once into the build
# directory instead of asking for root.
TOOLS="$BUILD/tools"
if [[ "$PLATFORM" != win32-* ]] && ! command -v m4 >/dev/null; then
	if [ ! -x "$TOOLS/bin/m4" ]; then
		say "m4 is missing; building it into ${TOOLS}"
		mkdir -p "$TOOLS/src"
		# Checked against the GNU release's sha256 before anything in it runs.
		curl -fsSL https://ftp.gnu.org/gnu/m4/m4-1.4.19.tar.xz -o "$TOOLS/src/m4.tar.xz"
		local_sum="$(sha256 "$TOOLS/src/m4.tar.xz" | cut -d' ' -f1)"
		[ "$local_sum" = 63aede5c6d33b6d9b13511cd0be2cac046f2e70fd0a07aa9573a04a82783af96 ] ||
			die "the m4 download does not match its checksum."
		tar -xJ -C "$TOOLS/src" -f "$TOOLS/src/m4.tar.xz"
		(cd "$TOOLS/src/m4-1.4.19" && ./configure --prefix="$TOOLS" >/dev/null && make -j "$JOBS" >/dev/null && make install >/dev/null)
	fi
	export PATH="$TOOLS/bin:$PATH"
fi
TOOLS_NEEDED=(cmake git perl)
case "$PLATFORM" in win32-*) TOOLS_NEEDED+=(nmake) ;; *) TOOLS_NEEDED+=(make) ;; esac
for tool in "${TOOLS_NEEDED[@]}"; do
	command -v "$tool" >/dev/null || die "$tool is needed to build the dependencies."
done

say "building Bambu Studio's dependencies ($KEY) with -j $JOBS into ${DEPS}; this takes hours the first time."
mkdir -p "$DEPS/build"
# Upstream detects a surrounding repository to add --directory to git apply. Our dependency
# archives live beside .upstream, so that relative path escapes its repository: newer Git rejects
# it and older Git may silently skip the patch. Isolate both configure and archive patch commands
# from enclosing repositories. Git's ceiling must be an ancestor, not the working directory itself.
PATCH_CEILING="$(cd "$BUILD" && pwd -P)"
if [[ "$PLATFORM" == win32-* ]]; then
	PATCH_CEILING="$(cygpath -w "$PATCH_CEILING")"
fi
(
	export GIT_CEILING_DIRECTORIES="$PATCH_CEILING"
	cd "$DEPS/build"
	# A few upstream recipes run `make -j` or `make -j<cores>` themselves (GMP, MPFR, OpenSSL); nice keeps
	# the machine usable meanwhile.
	export CMAKE_BUILD_PARALLEL_LEVEL="$JOBS"
	nice -n 10 cmake -S "$UP/deps" -B "$DEPS/build" \
		-G "$GENERATOR" \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_PROJECT_INCLUDE="$SLICER/scripts/dependency-targets.cmake" \
		-DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
		-DDESTDIR="$DEPS" \
		-DDEP_DEBUG=OFF \
		-DDEP_WX_GTK3=ON \
		-DDEP_BUILD_WXWIDGETS=OFF \
		-DDEP_BUILD_FFMPEG=OFF \
		-DDEP_BUILD_LIBHARU=OFF \
		-DDEP_BUILD_GLFW=OFF
	# Every dependency target except the GL ones (their dependencies come along).
	TARGETS=()
	while IFS= read -r t; do
		# Native Windows CMake writes CRLF; a CR must not become part of an MSBuild target.
		t="${t%$'\r'}"
		[ -z "$t" ] || TARGETS+=("$t")
	done <"$DEPS/build/printlab-dependency-targets.txt"
	[ ${#TARGETS[@]} -gt 0 ] || die "the superbuild lists no dependency targets."
	nice -n 10 cmake --build "$DEPS/build" --config Release -j "$JOBS" --target "${TARGETS[@]}"
)
echo "$KEY" >"$DEPS/.stamp"
say "dependencies built into $DEPS/usr/local."
