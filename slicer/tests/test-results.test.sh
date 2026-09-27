#!/usr/bin/env bash
# Independent native/protocol/integration test failures must all be reported without a native build.
set -euo pipefail
SLICER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
fail() { echo "not ok - $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
mkdir -p "$TEMP/repo/slicer/scripts" "$TEMP/repo/app" "$TEMP/bin"
cp "$SLICER/scripts/upstream.sh" "$TEMP/repo/slicer/scripts/upstream.sh"
export PRINTLAB_SLICER_BUILD_DIR="$TEMP/build" PRINTLAB_TEST_EVENTS="$TEMP/events"
export PATH="$TEMP/bin:$PATH"
for dir in engine engine-protocol engine-sanitize engine-protocol-sanitize; do
	mkdir -p "$PRINTLAB_SLICER_BUILD_DIR/$dir/tests"
	touch "$PRINTLAB_SLICER_BUILD_DIR/$dir/CTestTestfile.cmake" "$PRINTLAB_SLICER_BUILD_DIR/$dir/CMakeCache.txt"
	# Tests never execute these fixtures; cover both Unix and Windows path selection.
	touch "$PRINTLAB_SLICER_BUILD_DIR/$dir/tests/project_codec" "$PRINTLAB_SLICER_BUILD_DIR/$dir/tests/project_codec.exe"
done
cat >"$TEMP/bin/ctest" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'ctest|%s\n' "$*" >>"$PRINTLAB_TEST_EVENTS"
case "$2" in
*engine-protocol*) exit "$PRINTLAB_TEST_PROTOCOL_RESULT" ;;
*) exit "$PRINTLAB_TEST_NATIVE_RESULT" ;;
esac
SH
cat >"$TEMP/bin/bunx" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'integration|%s|%s|%s\n' "$PRINTLAB_SLICER_PATH" "$PRINTLAB_PROJECT_CODEC" "$*" >>"$PRINTLAB_TEST_EVENTS"
exit "$PRINTLAB_TEST_INTEGRATION_RESULT"
SH
chmod +x "$TEMP/bin/ctest" "$TEMP/bin/bunx"
run_case() {
	local expected="$1" native="$2" protocol="$3" integration="$4" actual=0
	shift 4
	: >"$PRINTLAB_TEST_EVENTS"
	PRINTLAB_TEST_NATIVE_RESULT="$native" PRINTLAB_TEST_PROTOCOL_RESULT="$protocol" \
		PRINTLAB_TEST_INTEGRATION_RESULT="$integration" \
		bash "$TEMP/repo/slicer/scripts/upstream.sh" test "$@" >"$TEMP/output" 2>&1 || actual=$?
	[ "$actual" = "$expected" ] || { cat "$TEMP/output"; fail "expected exit $expected, got $actual"; }
}
all_ran() {
	[ "$(grep -c '^ctest|' "$PRINTLAB_TEST_EVENTS")" = 2 ] || fail 'both CTest suites must run'
	[ "$(grep -c '^integration|' "$PRINTLAB_TEST_EVENTS")" = 1 ] || fail 'integration suite must run'
	grep -Fq '|vitest --run src/lib/server/slicer/ src/lib/server/slicer3mf/native-codec.test.ts' "$PRINTLAB_TEST_EVENTS" || fail 'integration arguments changed'
}
run_case 8 8 0 0
all_ran
pass 'integration and protocol still run after native CTest fails; exit stays nonzero'
run_case 9 0 9 0
all_ran
pass 'integration still runs after protocol CTest fails'
run_case 7 0 0 7
all_ran
pass 'integration failure fails the command after green native suites'
run_case 8 8 9 7
all_ran
pass 'all failing suites run and the first failure status is retained'
run_case 0 0 0 0
all_ran
pass 'all passing suites succeed'
run_case 8 8 9 7 --native-only
[ "$(grep -c '^ctest|' "$PRINTLAB_TEST_EVENTS")" = 2 ] || fail 'native-only must run both CTest suites'
if grep -q '^integration|' "$PRINTLAB_TEST_EVENTS"; then fail 'native-only ran integrations'; fi
pass 'native-only skips integrations and preserves native failure'
run_case 0 8 0 7 --no-upstream --native-only
[ "$(grep -c '^ctest|' "$PRINTLAB_TEST_EVENTS")" = 1 ] || fail 'protocol-only selected wrong suites'
if grep -q '^integration|' "$PRINTLAB_TEST_EVENTS"; then fail 'protocol native-only ran integrations'; fi
pass 'protocol native-only selects only its own passing suite'
run_case 8 8 0 0 --sanitize
all_ran
grep -Fq 'engine-sanitize' "$PRINTLAB_TEST_EVENTS" || fail 'sanitizer engine was not selected'
grep -Fq -- '--build-config RelWithDebInfo' "$PRINTLAB_TEST_EVENTS" || fail 'sanitizer configuration changed'
pass 'sanitizer failures also retain integration coverage and configuration'
