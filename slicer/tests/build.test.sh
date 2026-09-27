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

# Reproduce the real layout: a dependency build under the app repository beside a nested upstream
# repository, with an unpacked archive that has no .git directory of its own.
git init --quiet "$TEMP"
UP="$TEMP/upstream"
mkdir -p "$UP/deps/nested"
cat >"$UP/deps/CMakeLists.txt" <<'CMAKE'
cmake_minimum_required(VERSION 3.19)
project(BambuStudio-deps)
# Exercise Windows target-list line endings even on Linux/macOS. The collector's deferred call
# was registered by project(), so this runs after it has written the target list.
function(windows_target_lines)
    set(path "${CMAKE_BINARY_DIR}/printlab-dependency-targets.txt")
    file(READ "${path}" targets)
    string(REPLACE "\r\n" "\n" targets "${targets}")
    string(REPLACE "\n" "\r\n" targets "${targets}")
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
