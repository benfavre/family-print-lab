#!/usr/bin/env bash
# Generator-independent dependency discovery and protocol build/test smoke tests. The default uses
# a tiny local dependency project (no downloads); BUILD_PROTOCOL=1 also compiles the real protocol
# engine with every available generator, then a separate sanitizer and debug-symbol build on Unix.
set -euo pipefail

SLICER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
fail() { echo "not ok - $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

# Strawberry's extensionless Perl wrapper may work in Bash but cannot be spawned by native CMake.
# A failed executable must also be skipped, and paths with spaces must retain their boundaries.
mkdir -p "$TEMP/pkg config"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TEMP/pkg config/pkg-config"
printf '#!/usr/bin/env bash\nexit 1\n' >"$TEMP/pkg config/broken.exe"
printf '#!/usr/bin/env bash\n[ "$1" = --version ]\n' >"$TEMP/pkg config/pkg-config.exe"
chmod +x "$TEMP/pkg config/"*
selector="$SLICER/scripts/windows-pkg-config.sh"
selected="$(bash "$selector" "$TEMP/pkg config/pkg-config" "$TEMP/pkg config/broken.exe" "$TEMP/pkg config/pkg-config.exe")"
[ "$selected" = "$TEMP/pkg config/pkg-config.exe" ] || fail 'native pkg-config selection'
if bash "$selector" "$TEMP/pkg config/pkg-config" "$TEMP/pkg config/broken.exe" >"$TEMP/pkg-config.log" 2>&1; then
	fail 'unusable native pkg-config candidates were accepted'
fi
grep -q 'No working native pkg-config.exe' "$TEMP/pkg-config.log" || fail 'missing pkg-config diagnostic'
pass 'native pkg-config selection skips wrappers and broken executables, preserving spaced paths'

# Directory-scoped Windows definitions do not propagate through a linked upstream target. Exercise
# that exact parent/child layout without downloading upstream or needing a Windows compiler. The
# simulated platform checks target properties, so MSVC-only flags are never sent to the host compiler.
mkdir -p "$TEMP/facade/upstream"
cat >"$TEMP/facade/upstream/CMakeLists.txt" <<'CMAKE'
add_definitions(-D_USE_MATH_DEFINES -DBOOST_ALL_NO_LIB -DBOOST_USE_WINAPI_VERSION=0x602 -DBOOST_SYSTEM_USE_UTF8 -DUNICODE)
add_library(upstream INTERFACE)
CMAKE
cat >"$TEMP/facade/CMakeLists.txt" <<'CMAKE'
cmake_minimum_required(VERSION 3.13)
project(FacadePlatform LANGUAGES CXX)
add_subdirectory(upstream)
file(WRITE "${CMAKE_BINARY_DIR}/facade.cpp" "int facade() { return 0; }\n")
add_library(facade STATIC "${CMAKE_BINARY_DIR}/facade.cpp")
target_link_libraries(facade PUBLIC upstream)
set(WIN32 "${SIMULATE_WINDOWS}")
set(MSVC "${SIMULATE_MSVC}")
include("${HELPER}")
printlab_upstream_facade_platform(facade "${CMAKE_CURRENT_SOURCE_DIR}/upstream")
get_target_property(definitions facade COMPILE_DEFINITIONS)
get_target_property(options facade COMPILE_OPTIONS)
get_target_property(public_libraries facade INTERFACE_LINK_LIBRARIES)
if(SIMULATE_WINDOWS)
    if(NOT "crypt32" IN_LIST public_libraries)
        message(FATAL_ERROR "Windows crypto SDK dependency is not transitive")
    endif()
    foreach(required _USE_MATH_DEFINES BOOST_ALL_NO_LIB BOOST_USE_WINAPI_VERSION=0x602 BOOST_SYSTEM_USE_UTF8 UNICODE)
        if(NOT required IN_LIST definitions)
            message(FATAL_ERROR "Missing upstream facade definition: ${required}")
        endif()
    endforeach()
elseif(definitions OR "crypt32" IN_LIST public_libraries)
    message(FATAL_ERROR "Windows settings leaked to another platform")
endif()
if(SIMULATE_WINDOWS AND SIMULATE_MSVC)
    if(NOT "/bigobj" IN_LIST options OR NOT "$<$<CXX_COMPILER_ID:MSVC>:/utf-8>" IN_LIST options)
        message(FATAL_ERROR "Missing MSVC facade options")
    endif()
elseif(options)
    message(FATAL_ERROR "MSVC options leaked to another compiler/platform")
endif()
get_target_property(public_definitions facade INTERFACE_COMPILE_DEFINITIONS)
get_target_property(public_options facade INTERFACE_COMPILE_OPTIONS)
get_directory_property(parent_definitions COMPILE_DEFINITIONS)
if(public_definitions OR public_options OR parent_definitions)
    message(FATAL_ERROR "Upstream settings leaked outside the facade")
endif()
CMAKE
for platform in windows-msvc windows-other unix; do
	win=OFF; msvc=OFF
	case "$platform" in windows-msvc) win=ON; msvc=ON ;; windows-other) win=ON ;; esac
	cmake -S "$TEMP/facade" -B "$TEMP/facade-$platform" \
		-DHELPER="$SLICER/engine/cmake/UpstreamFacade.cmake" \
		-DSIMULATE_WINDOWS="$win" -DSIMULATE_MSVC="$msvc" >"$TEMP/facade-$platform.log" 2>&1 ||
		{ cat "$TEMP/facade-$platform.log"; fail "$platform facade platform settings"; }
done
pass 'facade inherits private Windows header settings and transitive crypto SDK linking'

# On an actual Windows host, link a consumer of a static facade against the real SDK too. A property
# assertion alone would not catch misspelt SDK library names or a dependency that failed to propagate.
if [ "${OS:-}" = Windows_NT ]; then
	mkdir -p "$TEMP/crypto-link/upstream"
	printf 'add_library(upstream INTERFACE)\n' >"$TEMP/crypto-link/upstream/CMakeLists.txt"
	cat >"$TEMP/crypto-link/CMakeLists.txt" <<'CMAKE'
cmake_minimum_required(VERSION 3.13)
project(FacadeCryptoLink LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_subdirectory(upstream)
file(WRITE "${CMAKE_BINARY_DIR}/facade.cpp" "#include <windows.h>\n#include <wincrypt.h>\nint facade() { return CertFreeCertificateContext(nullptr) ? 0 : 1; }\n")
file(WRITE "${CMAKE_BINARY_DIR}/main.cpp" "int facade(); int main() { return facade(); }\n")
add_library(facade STATIC "${CMAKE_BINARY_DIR}/facade.cpp")
include("${HELPER}")
printlab_upstream_facade_platform(facade "${CMAKE_CURRENT_SOURCE_DIR}/upstream")
add_executable(consumer "${CMAKE_BINARY_DIR}/main.cpp")
target_link_libraries(consumer PRIVATE facade)
CMAKE
	cmake -S "$TEMP/crypto-link" -B "$TEMP/crypto-link-build" \
		-DHELPER="$SLICER/engine/cmake/UpstreamFacade.cmake" >"$TEMP/crypto-link.log" 2>&1 &&
		cmake --build "$TEMP/crypto-link-build" --config Release >>"$TEMP/crypto-link.log" 2>&1 ||
		{ cat "$TEMP/crypto-link.log"; fail 'Windows crypto SDK consumer link'; }
	pass 'static facade consumer links against the Windows crypto SDK'
fi

# Reproduce the real layout: a dependency build under the app repository beside a nested upstream
# repository, with an unpacked archive that has no .git directory of its own.
git init --quiet "$TEMP"
UP="$TEMP/upstream"
mkdir -p "$UP/deps/nested"
cat >"$UP/deps/CMakeLists.txt" <<'CMAKE'
cmake_minimum_required(VERSION 3.19)
project(BambuStudio-deps)
# Exercise Windows target-list line endings even on Linux/macOS, including duplicated CRs from
# explicit CRLF passed through a native text writer. The collector's deferred call
# was registered by project(), so this runs after it has written the target list.
function(windows_target_lines)
    set(path "${CMAKE_BINARY_DIR}/printlab-dependency-targets.txt")
    file(READ "${path}" targets)
    string(REPLACE "\r" "" targets "${targets}")
    string(REPLACE "\n" "\r\r\n" targets "${targets}")
    file(WRITE "${path}" "${targets}")
endfunction()
cmake_language(DEFER CALL windows_target_lines)
# Match upstream deps/CMakeLists.txt and OCCT's conditional git-apply prefix.
execute_process(COMMAND git rev-parse --is-inside-work-tree
    RESULT_VARIABLE git_status OUTPUT_VARIABLE git_inside OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET)
if(git_status EQUAL 0 AND git_inside STREQUAL "true")
    file(RELATIVE_PATH BINARY_DIR_REL "${CMAKE_SOURCE_DIR}/.." "${CMAKE_BINARY_DIR}")
endif()
set(archive "${CMAKE_BINARY_DIR}/dep_OCCT-prefix/src/dep_OCCT")
file(MAKE_DIRECTORY "${archive}")
file(WRITE "${archive}/value.txt" "before\n")
set(patch_args)
if(BINARY_DIR_REL)
    list(APPEND patch_args --directory "${BINARY_DIR_REL}/dep_OCCT-prefix/src/dep_OCCT")
endif()
add_custom_target(dep_Patch
    COMMAND git apply ${patch_args} "${CMAKE_SOURCE_DIR}/one.patch"
    WORKING_DIRECTORY "${archive}" VERBATIM)
add_custom_target(dep_Core
    COMMAND ${CMAKE_COMMAND} -E make_directory "${DESTDIR}/usr/local/lib"
    COMMAND ${CMAKE_COMMAND} -E touch "${DESTDIR}/core-built")
add_custom_target(dep_GLEW COMMAND ${CMAKE_COMMAND} -E false)
add_custom_target(dep_OpenCSG COMMAND ${CMAKE_COMMAND} -E false)
add_custom_target(dep_GLFW COMMAND ${CMAKE_COMMAND} -E false)
add_custom_target(unrelated COMMAND ${CMAKE_COMMAND} -E false)
add_subdirectory(nested)
CMAKE
cat >"$UP/deps/nested/CMakeLists.txt" <<'CMAKE'
add_custom_target(dep_Nested COMMAND ${CMAKE_COMMAND} -E touch "${DESTDIR}/nested-built")
CMAKE
cat >"$UP/deps/one.patch" <<'PATCH'
diff --git a/value.txt b/value.txt
--- a/value.txt
+++ b/value.txt
@@ -1 +1 @@
-before
+after
PATCH
git init --quiet "$UP"
git -C "$UP" add deps
git -C "$UP" -c user.name=Tester -c user.email=test@example.invalid commit --quiet -m 'Toy dependencies'
git -C "$UP" tag printlab-base
git -C "$UP" tag v1

GENERATORS=()
case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*) GENERATORS+=("${CMAKE_GENERATOR:-Visual Studio 17 2022}") ;;
*)
	command -v make >/dev/null && GENERATORS+=("Unix Makefiles")
	if command -v ninja >/dev/null; then GENERATORS+=(Ninja "Ninja Multi-Config"); fi
	;;
esac
[ ${#GENERATORS[@]} -gt 0 ] || fail 'no build generator available'

index=0
previous_key=""
for generator in "${GENERATORS[@]}"; do
	index=$((index + 1))
	export CMAKE_GENERATOR="$generator" PRINTLAB_UPSTREAM_DIR="$UP"
	export PRINTLAB_SLICER_BUILD_DIR="$TEMP/build-$index"
	key="$(bash "$SLICER/scripts/build-deps.sh" --print-key)"
	[ "$key" != "$previous_key" ] || fail 'generator changes must invalidate the dependency cache'
	previous_key="$key"
	log="$TEMP/deps-$index.log"
	bash "$SLICER/scripts/build-deps.sh" -j 2 >"$log" 2>&1 || { cat "$log"; fail "$generator dependency build"; }
	[ -f "$PRINTLAB_SLICER_BUILD_DIR/deps/core-built" ] || fail 'root dependency was skipped'
	[ -f "$PRINTLAB_SLICER_BUILD_DIR/deps/nested-built" ] || fail 'nested dependency was skipped'
	[ "$(cat "$PRINTLAB_SLICER_BUILD_DIR/deps/build/dep_OCCT-prefix/src/dep_OCCT/value.txt")" = after ] ||
		fail 'archive patch was silently skipped inside the surrounding repository'
	[ "$(cat "$PRINTLAB_SLICER_BUILD_DIR/deps/.stamp")" = "$key" ] || fail 'wrong cache stamp'
	bash "$SLICER/scripts/build-deps.sh" -j 2 >"$log" 2>&1
	grep -q 'already built' "$log" || fail 'matching cache was not reused'
	pass "$generator builds CRLF-listed dependencies, applies archive patches, excludes GUI targets and reuses its cache"

	if [ "${BUILD_PROTOCOL:-0}" = 1 ]; then
		bash "$SLICER/scripts/upstream.sh" build --no-upstream -j 2 >"$TEMP/protocol-$index.log" 2>&1 ||
			{ cat "$TEMP/protocol-$index.log"; fail "$generator protocol build"; }
		bash "$SLICER/scripts/upstream.sh" test --no-upstream --native-only
		pass "$generator protocol build and ctest"
	fi
done

# Exercise configure argument expansion without a native build, including the empty-sanitizer
# case that used to abort under macOS Bash 3.2 with set -u. Preserve flags containing spaces.
mkdir -p "$TEMP/cmake-probe"
cat >"$TEMP/cmake-probe/cmake" <<'SH'
#!/usr/bin/env bash
set -eu
if [ "$1" = -S ]; then printf '%s\n' "$@" >"$PRINTLAB_CMAKE_CAPTURE"; fi
SH
chmod +x "$TEMP/cmake-probe/cmake"
for mode in release sanitize debug-symbols; do
	# MSVC intentionally rejects UBSan; its Release/debug argument expansion still runs below.
	case "$(uname -s):$mode" in MINGW*:sanitize | MSYS*:sanitize | CYGWIN*:sanitize) continue ;; esac
	args=(--no-upstream)
	expected=Release
	if [ "$mode" != release ]; then args+=("--$mode"); expected=RelWithDebInfo; fi
	capture="$TEMP/configure-$mode.txt"
	PATH="$TEMP/cmake-probe:$PATH" PRINTLAB_CMAKE_CAPTURE="$capture" \
		bash "$SLICER/scripts/upstream.sh" build "${args[@]}" >"$TEMP/configure-$mode.log" 2>&1 ||
		{ cat "$TEMP/configure-$mode.log"; fail "$mode configure argument expansion"; }
	[ "$(grep -c '^-DCMAKE_BUILD_TYPE=' "$capture")" = 1 ] || fail 'build type must appear once'
	grep -Fxq -- "-DCMAKE_BUILD_TYPE=$expected" "$capture" || fail "$mode build type"
	if [ "$mode" = sanitize ]; then
		grep -Fq -- '-fsanitize=address,undefined,float-cast-overflow -fno-omit-frame-pointer' "$capture" ||
			fail 'sanitizer flags lost their argument boundaries'
	elif grep -q 'fsanitize=' "$capture"; then
		fail 'sanitizer flags leaked into an uninstrumented configure'
	fi
	pass "$mode configure arguments expand with strict shell options"
done

# Testing a missing configuration must fail rather than report a false green test run.
if bash "$SLICER/scripts/upstream.sh" test --sanitize --native-only >"$TEMP/missing.log" 2>&1; then
	fail 'missing sanitizer build was accepted'
fi
grep -q 'no matching engine build' "$TEMP/missing.log" || fail 'missing build diagnostic'
pass 'missing build fails explicitly'

if [ "${BUILD_PROTOCOL:-0}" = 1 ] && [[ "$(uname -s)" != MINGW* ]] && [[ "$(uname -s)" != MSYS* ]]; then
	for mode in sanitize debug-symbols; do
		bash "$SLICER/scripts/upstream.sh" build --no-upstream "--$mode" -j 2 >"$TEMP/$mode.log" 2>&1 ||
			{ cat "$TEMP/$mode.log"; fail "$mode build"; }
		bash "$SLICER/scripts/upstream.sh" test --no-upstream "--$mode" --native-only
		pass "$mode protocol build and ctest (separate from Release)"
	done
	grep -q 'fsanitize=address,undefined,float-cast-overflow' "$PRINTLAB_SLICER_BUILD_DIR/engine-protocol-sanitize/CMakeCache.txt" ||
		fail 'sanitizer flags missing'
	if grep -q 'fsanitize=' "$PRINTLAB_SLICER_BUILD_DIR/engine-protocol/CMakeCache.txt"; then
		fail 'sanitizer flags leaked into Release'
	fi
	pass 'sanitizer compiler and linker flags are isolated from Release'
fi
