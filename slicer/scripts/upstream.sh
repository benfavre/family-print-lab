#!/usr/bin/env bash
# Keeps Print Lab Slicer's Bambu Studio fork up to date. Our code never lives in the upstream tree:
# slicer/.upstream is a throwaway checkout of the tag pinned in slicer/upstream.lock with our small
# patch queue (slicer/patches/series) applied on top. Moving to a new Bambu Studio release is
# `fetch`, `rebase <new-tag>`, `export`, then a normal pull request. slicer/UPSTREAM.md has the steps.
#
#   upstream.sh fetch [<tag>]                   materialise slicer/.upstream at the pin (idempotent)
#   upstream.sh rebase <new-tag> [--report f]   replay the patch queue onto a newer tag
#   upstream.sh export [--push <remote>]        write the queue back to slicer/patches and the lock
#   upstream.sh status                          pin, checkout, patch count and dirty state
#   upstream.sh resources                       copy profiles, printers and HMS texts out of the checkout
#   upstream.sh ports                           list ported files whose upstream origin changed
#   upstream.sh build [--deps-only|--no-upstream] [--sanitize|--debug-symbols] [-j N]
#   upstream.sh test [--sanitize|--debug-symbols] [--no-upstream] [--native-only]
#
# Environment: PRINTLAB_UPSTREAM_DIR (default slicer/.upstream), PRINTLAB_SLICER_BUILD_DIR
# (default slicer/.build).
set -euo pipefail

SLICER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(dirname "$SLICER")"
LOCK="$SLICER/upstream.lock"
PATCHES="$SLICER/patches"
SERIES="$PATCHES/series"
UP="${PRINTLAB_UPSTREAM_DIR:-$SLICER/.upstream}"
BUILD="${PRINTLAB_SLICER_BUILD_DIR:-$SLICER/.build}"
STATE_NAME="printlab-state"
QUEUE_NAME="Print Lab patch queue"
QUEUE_EMAIL="patch-queue@printlab.invalid"

die() {
	echo "upstream.sh: $*" >&2
	exit 1
}
say() { echo "upstream.sh: $*"; }

# The lock is key=value lines; '#' starts a comment at the start of a line or after whitespace
# (the same rule as app/tools/lib/upstream.ts parseLock, so a URL fragment survives).
lock_get() {
	[ -f "$LOCK" ] || die "slicer/upstream.lock not found."
	sed -E -e 's/(^|[[:space:]])#.*$//' -e 's/[[:space:]]+$//' "$LOCK" |
		sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" | tail -n 1
}

lock_set() {
	local key="$1" value="$2" tmp
	tmp="$(mktemp)"
	if grep -q -E "^$key=" "$LOCK"; then
		awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$LOCK" >"$tmp"
	else
		cat "$LOCK" >"$tmp"
		echo "$key=$value" >>"$tmp"
	fi
	cat "$tmp" >"$LOCK"
	rm -f "$tmp"
}

# Patch file names in order (blank lines and comments ignored).
series() {
	[ -f "$SERIES" ] || return 0
	sed -E -e 's/(^|[[:space:]])#.*$//' -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' "$SERIES" | grep -v '^$' || true
}

sha256() {
	if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

# sha256 over the series file and every patch in it, in order; empty when the queue is empty.
queue_hash() {
	local names
	names="$(series)"
	[ -n "$names" ] || return 0
	{
		cat "$SERIES"
		while IFS= read -r p; do
			[ -f "$PATCHES/$p" ] || die "patches/series lists $p, which does not exist."
			cat "$PATCHES/$p"
		done <<<"$names"
	} | sha256
}

g() { git -C "$UP" "$@"; }

# Commits made by this script (am, rebase) carry the patch queue's committer, whoever runs it.
gq() {
	GIT_COMMITTER_NAME="$QUEUE_NAME" GIT_COMMITTER_EMAIL="$QUEUE_EMAIL" git -C "$UP" "$@"
}

state_file() { echo "$UP/.git/$STATE_NAME"; }
state_get() { if [ -f "$(state_file)" ]; then sed -n "s/^$1=//p" "$(state_file)"; fi; }
# What fetch/rebase/export left behind: the tag, the queue hash, the HEAD it wrote and whether that
# HEAD is exported to slicer/patches (so fetch never throws away work that only lives in the checkout).
state_write() {
	printf 'tag=%s\nqueue_hash=%s\nhead=%s\nexported=%s\n' "$1" "$2" "$(g rev-parse HEAD)" "${3:-1}" >"$(state_file)"
}
unexported() {
	[ -f "$(state_file)" ] || return 1
	[ "$(state_get exported)" = 0 ] || [ "$(g rev-parse HEAD)" != "$(state_get head)" ]
}

has_checkout() { [ -d "$UP/.git" ]; }
need_checkout() { has_checkout || die "No checkout at ${UP#"$ROOT"/}: run upstream.sh fetch first."; }
rebasing() { [ -d "$UP/.git/rebase-merge" ] || [ -d "$UP/.git/rebase-apply" ]; }
dirty() { [ -n "$(g status --porcelain --untracked-files=no)" ]; }

# Commit of a tag we fetched; refuses when upstream moved a tag the lock pins.
tag_commit() { g rev-parse --verify --quiet "refs/tags/$1^{commit}"; }

fetch_tag() {
	local tag="$1" url
	url="$(lock_get url)"
	[ -n "$url" ] || die "slicer/upstream.lock is missing \"url\"."
	say "fetching $tag from $url"
	g fetch --quiet --depth 1 --no-tags "$url" "+refs/tags/$tag:refs/tags/$tag" ||
		die "could not fetch tag $tag from $url."
}

link_rr_cache() {
	mkdir -p "$SLICER/rr-cache"
	if [ ! -L "$UP/.git/rr-cache" ]; then
		rm -rf "$UP/.git/rr-cache"
		ln -s "$SLICER/rr-cache" "$UP/.git/rr-cache"
	fi
	g config rerere.enabled true
	g config rerere.autoupdate true
}

cmd_fetch() {
	local tag="${1:-$(lock_get tag)}" pinned want hash
	[ -n "$tag" ] || die "slicer/upstream.lock is missing \"tag\"."
	pinned="$(lock_get commit)"
	hash="$(queue_hash)"

	if has_checkout; then
		rebasing && die "a rebase is in progress in ${UP#"$ROOT"/}: finish it (git rebase --continue) or abort it first."
		if [ "$(state_get tag)" = "$tag" ] && [ "$(state_get queue_hash)" = "$hash" ] &&
			! unexported && ! dirty; then
			say "already at $tag with the current patch queue."
			return 0
		fi
		if unexported && [ "${FORCE:-}" != 1 ]; then
			die "${UP#"$ROOT"/} has commits that are not exported yet: run upstream.sh export, or FORCE=1 upstream.sh fetch to throw them away."
		fi
		dirty && [ "${FORCE:-}" != 1 ] && die "${UP#"$ROOT"/} has uncommitted changes: commit and export them, or FORCE=1 upstream.sh fetch to throw them away."
	else
		mkdir -p "$UP"
		git init --quiet "$UP"
	fi
	# Fallback identity so `git am` and `git rebase` work on CI runners; people keep their own.
	g config user.email >/dev/null || g config user.email "$QUEUE_EMAIL"
	g config user.name >/dev/null || g config user.name "$QUEUE_NAME"

	fetch_tag "$tag"
	want="$(tag_commit "$tag")" || die "tag $tag did not arrive."
	if [ "$tag" = "$(lock_get tag)" ] && [ "$want" != "$pinned" ]; then
		die "tag $tag is at $want upstream but slicer/upstream.lock pins $pinned. Refusing: a moved tag must be reviewed by hand."
	fi

	g checkout --quiet --force -B printlab "$want"
	g tag -f printlab-base "$want" >/dev/null
	link_rr_cache
	local names p
	names="$(series)"
	if [ -n "$names" ]; then
		while IFS= read -r p; do
			[ -f "$PATCHES/$p" ] || die "patches/series lists $p, which does not exist."
			gq am --quiet --3way --committer-date-is-author-date "$PATCHES/$p" ||
				die "patch $p does not apply to $tag. Run 'git -C ${UP#"$ROOT"/} am --abort', then see slicer/UPSTREAM.md (Resolving a patch that stopped applying)."
		done <<<"$names"
	fi
	state_write "$tag" "$hash"
	say "${UP#"$ROOT"/} is at $tag ($want) with $(printf '%s' "$names" | grep -c . || true) patch(es)."
}

json_str() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }

write_report() {
	local file="$1" ok="$2" from="$3" to="$4" stopped="$5" failed="$6" first=1 p
	{
		printf '{"ok":%s,"from":%s,"to":%s,"patches":%s,"stoppedAt":%s,"failed":[' \
			"$ok" "$(json_str "$from")" "$(json_str "$to")" "$(series | grep -c . || true)" \
			"$([ -n "$stopped" ] && json_str "$stopped" || echo null)"
		while IFS= read -r p; do
			[ -n "$p" ] || continue
			[ $first = 1 ] || printf ','
			first=0
			json_str "$p"
		done <<<"$failed"
		printf ']}\n'
	} >"$file"
}

# git rebase, continuing on its own whenever rerere replayed a recorded resolution for every conflict.
replay() {
	local i=0
	gq rebase --quiet --onto "$1" "$2" printlab >/dev/null 2>&1 && return 0
	while rebasing && [ $i -lt 500 ]; do
		i=$((i + 1))
		[ -z "$(g diff --name-only --diff-filter=U)" ] || return 1
		[ -n "$(g rerere status)" ] || [ -n "$(g diff --cached --name-only)" ] || return 1
		GIT_EDITOR=true gq rebase --continue >/dev/null 2>&1 && return 0
	done
	! rebasing
}

cmd_rebase() {
	local new="" report=""
	while [ $# -gt 0 ]; do
		case "$1" in
		--report)
			report="${2:?--report needs a file}"
			shift 2
			;;
		-*) die "unknown option $1" ;;
		*)
			new="$1"
			shift
			;;
		esac
	done
	[ -n "$new" ] || die "usage: upstream.sh rebase <new-tag> [--report <file.json>]"
	need_checkout
	rebasing && die "a rebase is already in progress in ${UP#"$ROOT"/}."
	dirty && die "${UP#"$ROOT"/} has uncommitted changes."
	[ "$(g rev-parse --abbrev-ref HEAD)" = printlab ] || die "${UP#"$ROOT"/} is not on branch printlab: run upstream.sh fetch."
	[ -n "$report" ] && report="$(cd "$(dirname "$report")" && pwd)/$(basename "$report")"

	local oldBase oldTag newCommit
	oldBase="$(g rev-parse 'printlab-base^{commit}')"
	oldTag="$(state_get tag)"
	link_rr_cache
	fetch_tag "$new"
	newCommit="$(tag_commit "$new")" || die "tag $new did not arrive."
	# Move the base first so `export` works after a conflict is resolved by hand; the old one is kept.
	g tag -f printlab-prev-base "$oldBase" >/dev/null
	g tag -f printlab-base "$newCommit" >/dev/null
	if replay "$newCommit" "$oldBase"; then
		[ -n "$report" ] && write_report "$report" true "$oldTag" "$new" "" ""
		state_write "$new" "" 0
		say "the patch queue applies to $new. Next: build and test, then upstream.sh export."
		return 0
	fi

	local stopped
	stopped="$(head -n 1 "$UP/.git/rebase-merge/message" 2>/dev/null || true)"
	if [ -z "$report" ]; then
		cat >&2 <<EOF
upstream.sh: a patch no longer applies cleanly to $new${stopped:+ ("$stopped")}.
  1. Fix the conflicts in ${UP#"$ROOT"/} (git -C ${UP#"$ROOT"/} status lists them).
  2. git -C ${UP#"$ROOT"/} add <files> && git -C ${UP#"$ROOT"/} rebase --continue
  3. Repeat until the rebase finishes, then run upstream.sh export and commit slicer/.
Your resolutions are recorded in slicer/rr-cache; commit them too so the next update replays them.
To give up: git -C ${UP#"$ROOT"/} rebase --abort && FORCE=1 upstream.sh fetch
EOF
		exit 1
	fi

	# CI report: abort, then check every patch against the new tag so the issue lists all that fail.
	g rebase --abort
	local failed="" p names
	names="$(series)"
	g checkout --quiet --detach "$newCommit"
	if [ -n "$names" ]; then
		while IFS= read -r p; do
			if g apply --check --3way "$PATCHES/$p" >/dev/null 2>&1; then
				g apply --3way --index "$PATCHES/$p" >/dev/null 2>&1 || failed+="$p"$'\n'
			else
				failed+="$p"$'\n'
			fi
		done <<<"$names"
	fi
	g reset --quiet --hard
	g checkout --quiet printlab
	g tag -f printlab-base "$oldBase" >/dev/null
	g tag -d printlab-prev-base >/dev/null
	write_report "$report" false "$oldTag" "$new" "$stopped" "$failed"
	say "the patch queue does not apply to $new; the report is in $report. The checkout is back at $oldTag."
	exit 1
}

update_upstream_md() {
	local md="$SLICER/UPSTREAM.md" tmp
	[ -f "$md" ] && grep -q '<!-- pin:start -->' "$md" || return 0
	tmp="$(mktemp)"
	awk -v tag="$1" -v commit="$2" -v queue="$3" -v hash="${4:-(empty)}" -v count="$5" '
		/<!-- pin:start -->/ {
			print
			print ""
			print "| Upstream | Tag | Commit | Patch queue |"
			print "| --- | --- | --- | --- |"
			printf "| Bambu Studio | `%s` | `%s` | version %s, %s patch(es), hash `%s` |\n", tag, commit, queue, count, hash
			print ""
			skip = 1
			next
		}
		/<!-- pin:end -->/ { skip = 0 }
		!skip { print }
	' "$md" >"$tmp"
	cat "$tmp" >"$md"
	rm -f "$tmp"
}

cmd_export() {
	local push=""
	while [ $# -gt 0 ]; do
		case "$1" in
		--push)
			push="${2:?--push needs a remote}"
			shift 2
			;;
		*) die "unknown option $1" ;;
		esac
	done
	need_checkout
	rebasing && die "a rebase is in progress: finish it first (git rebase --continue)."
	dirty && die "${UP#"$ROOT"/} has uncommitted changes: commit them as patches first."
	[ "$(g rev-parse --abbrev-ref HEAD)" = printlab ] || die "${UP#"$ROOT"/} is not on branch printlab."
	g merge-base --is-ancestor printlab-base printlab ||
		die "printlab does not sit on printlab-base (was a rebase aborted?): run FORCE=1 upstream.sh fetch."

	local base tag
	base="$(g rev-parse 'printlab-base^{commit}')"
	tag="$(g tag --points-at "$base" | grep -v -E '^printlab-' | head -n 1)"
	[ -n "$tag" ] || die "no upstream tag points at printlab-base."

	mkdir -p "$PATCHES"
	find "$PATCHES" -maxdepth 1 -name '*.patch' -delete
	g format-patch --quiet --zero-commit --no-signature --no-numbered -o "$PATCHES" printlab-base..printlab >/dev/null
	{
		echo "# The patch queue applied on top of the Bambu Studio tag in ../upstream.lock, in order."
		echo "# Written by upstream.sh export; see ../UPSTREAM.md before adding a patch."
		# format-patch generates plain numbered filenames; list only those in the queue root.
		# shellcheck disable=SC2012
		(cd "$PATCHES" && ls -1 -- *.patch 2>/dev/null | sort) || true
	} >"$SERIES"

	local hash queue count
	hash="$(queue_hash)"
	queue="$(lock_get queue)"
	queue="${queue:-0}"
	if [ "$hash" != "$(lock_get queue_hash)" ] || [ "$tag" != "$(lock_get tag)" ]; then
		queue=$((queue + 1))
	fi
	lock_set tag "$tag"
	lock_set commit "$base"
	lock_set queue "$queue"
	lock_set queue_hash "$hash"
	count="$(series | grep -c . || true)"
	update_upstream_md "$tag" "$base" "$queue" "$hash" "$count"
	state_write "$tag" "$hash"
	g tag -d printlab-prev-base >/dev/null 2>&1 || true
	say "exported $count patch(es) at $tag (queue version $queue). Commit slicer/ in a pull request."

	if [ -n "$push" ]; then
		g push --force "$push" "printlab:refs/heads/printlab/$tag"
		say "pushed printlab/$tag to $push (a browsable copy; slicer/patches stays the source of truth)."
	fi
}

cmd_status() {
	local tag commit count
	tag="$(lock_get tag)"
	commit="$(lock_get commit)"
	count="$(series | grep -c . || true)"
	echo "pin:        $(lock_get name) $tag ($commit)"
	echo "queue:      version $(lock_get queue), $count patch(es)"
	if ! has_checkout; then
		echo "checkout:   none (upstream.sh fetch creates ${UP#"$ROOT"/})"
		return 0
	fi
	local base ahead
	base="$(g rev-parse --verify --quiet 'printlab-base^{commit}' || echo none)"
	ahead="$(g rev-list --count printlab-base..printlab 2>/dev/null || echo '?')"
	echo "checkout:   ${UP#"$ROOT"/} at $(state_get tag) (base $base), $ahead patch commit(s)"
	[ "$base" = "$commit" ] || echo "            base differs from the lock: run upstream.sh export (after a rebase) or fetch"
	unexported && echo "            has commits that are not exported (upstream.sh export writes them to slicer/patches)"
	if rebasing; then
		echo "state:      rebase in progress"
	elif dirty; then
		echo "state:      uncommitted changes"
	else
		echo "state:      clean"
	fi
}

cmd_resources() {
	need_checkout
	local plat dest dist
	plat="$(uname -s | tr '[:upper:]' '[:lower:]' | sed -e 's/mingw.*\|msys.*\|cygwin.*/win32/')-$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')"
	dist="$SLICER/dist/$plat"
	for dest in "$ROOT/app/resources/bambu" "$dist/resources"; do
		[ "$dest" = "$dist/resources" ] && [ ! -d "$dist" ] && continue
		mkdir -p "$dest/profiles"
		rm -rf "$dest/profiles/BBL" "$dest/profiles/BBL.json" "$dest/printers" "$dest/hms"
		[ -d "$UP/resources/profiles/BBL" ] && cp -R "$UP/resources/profiles/BBL" "$dest/profiles/"
		[ -f "$UP/resources/profiles/BBL.json" ] && cp "$UP/resources/profiles/BBL.json" "$dest/profiles/"
		[ -d "$UP/resources/printers" ] && cp -R "$UP/resources/printers" "$dest/"
		[ -d "$UP/resources/hms" ] && cp -R "$UP/resources/hms" "$dest/"
		say "copied upstream resources to ${dest#"$ROOT"/}"
	done
}

# slicer/ports/ORIGINS.md rows: | our file | repo | upstream path | commit |
cmd_ports() {
	need_checkout
	local origins="$SLICER/ports/ORIGINS.md" ours repo upath commit changed=0 url
	[ -f "$origins" ] || die "slicer/ports/ORIGINS.md not found."
	url="$(lock_get url)"
	while IFS='|' read -r _ ours repo upath commit _; do
		ours="$(echo "$ours" | tr -d '` ' )"
		repo="$(echo "$repo" | tr -d '` ')"
		upath="$(echo "$upath" | tr -d '` ')"
		commit="$(echo "$commit" | tr -d '` ')"
		[[ "$commit" =~ ^[0-9a-f]{7,40}$ ]] || continue
		if [ "$repo" != BambuStudio ]; then
			echo "skip     $ours ($repo: compare by hand, or with its own lock)"
			continue
		fi
		g cat-file -e "$commit^{commit}" 2>/dev/null || g fetch --quiet --depth 1 "$url" "$commit" ||
			die "could not fetch $commit for $ours."
		if g diff --quiet "$commit" printlab-base -- "$upath"; then
			echo "same     $ours"
		else
			echo "CHANGED  $ours  ($upath since ${commit:0:10})"
			changed=1
		fi
	done <"$origins"
	[ $changed = 0 ] || say "review the CHANGED ports against upstream, then update their commit in ORIGINS.md."
}

platform_key() {
	local os arch
	os="$(uname -s | tr '[:upper:]' '[:lower:]')"
	case "$os" in mingw* | msys* | cygwin*) os=win32 ;; esac
	arch="$(uname -m)"
	case "$arch" in x86_64 | amd64) arch=x64 ;; aarch64) arch=arm64 ;; esac
	echo "$os-$arch"
}

engine_binary() {
	local dir="$1" config="$2" exe=""
	case "$(platform_key)" in win32-*) exe=".exe" ;; esac
	if grep -q '^CMAKE_CONFIGURATION_TYPES:' "$dir/CMakeCache.txt"; then
		echo "$dir/$config/printlab-slicer$exe"
	else
		echo "$dir/printlab-slicer$exe"
	fi
}

# build: dependencies (build-deps.sh), then the engine against the checkout, then slicer/dist/<plat>
# with the binary, the resources it reads at runtime (profiles, printers, info, calib) from the same tag,
# the licence and engine.json. --no-upstream builds the protocol layer only (minutes, no checkout).
cmd_build() {
	local deps_only=0 jobs=2 upstream=1 mode="" config=Release
	while [ $# -gt 0 ]; do
		case "$1" in
		--deps-only)
			deps_only=1
			shift
			;;
		--no-upstream)
			upstream=0
			shift
			;;
		--sanitize | --debug-symbols)
			[ -z "$mode" ] || die "choose either --sanitize or --debug-symbols."
			if [ "$1" = --sanitize ]; then mode=sanitize; else mode=debug; fi
			config=RelWithDebInfo
			shift
			;;
		-j)
			jobs="${2:?-j needs a number}"
			shift 2
			;;
		-j*)
			jobs="${1#-j}"
			shift
			;;
		*) die "unknown option $1" ;;
		esac
	done
	[ -f "$SLICER/engine/CMakeLists.txt" ] || die "slicer/engine/CMakeLists.txt is missing."
	local plat engine binary
	# Bash 3.2 (the macOS system shell) treats empty arrays as unset with set -u.
	# Every configure has a build type, so keep the argument array nonempty in every mode.
	local flags=("-DCMAKE_BUILD_TYPE=$config")
	plat="$(platform_key)"
	if [ "$mode" = sanitize ]; then
		case "$plat" in win32-*) die "--sanitize needs GCC or Clang on Linux or macOS (MSVC has no UBSan)." ;; esac
		# Global flags reach libslic3r in add_subdirectory, not just our executable. The dependency
		# prefix stays uninstrumented and reusable by Release; no sanitizer artifacts enter dist/<plat>.
		local sanitizer='-fsanitize=address,undefined,float-cast-overflow -fno-omit-frame-pointer'
		flags+=("-DCMAKE_C_FLAGS=${CFLAGS:-} $sanitizer" "-DCMAKE_CXX_FLAGS=${CXXFLAGS:-} $sanitizer"
			"-DCMAKE_EXE_LINKER_FLAGS=$sanitizer" "-DCMAKE_SHARED_LINKER_FLAGS=$sanitizer")
	fi
	if [ $upstream = 0 ]; then
		[ $deps_only = 0 ] || die "--deps-only and --no-upstream cannot be combined."
		engine="$BUILD/engine-protocol${mode:+-$mode}"
		cmake -S "$SLICER/engine" -B "$engine" -DPRINTLAB_WITH_UPSTREAM=OFF "${flags[@]}"
		cmake --build "$engine" --config "$config" -j "$jobs"
		say "built the protocol-only engine: $(engine_binary "$engine" "$config") (no slicing core)."
		return 0
	fi
	need_checkout
	PRINTLAB_UPSTREAM_DIR="$UP" PRINTLAB_SLICER_BUILD_DIR="$BUILD" bash "$SLICER/scripts/build-deps.sh" -j "$jobs"
	[ $deps_only = 1 ] && return 0
	engine="$BUILD/engine${mode:+-$mode}"
	# libslic3r stamps its version header with the configure time (string(TIMESTAMP) in
	# src/libslic3r/CMakeLists.txt), so every re-configure (a new patch, a lock change) would rebuild all
	# of it. CMake takes the time from SOURCE_DATE_EPOCH when set: the pinned commit's time keeps the
	# header, and the build, unchanged.
	SOURCE_DATE_EPOCH="$(g log -1 --format=%ct printlab-base)"
	export SOURCE_DATE_EPOCH
	cmake -S "$SLICER/engine" -B "$engine" -DPRINTLAB_UPSTREAM_DIR="$UP" \
		-DCMAKE_PREFIX_PATH="$BUILD/deps/usr/local" "${flags[@]}"
	# The upstream subdirectory is EXCLUDE_FROM_ALL. Build our default targets so new engine tests
	# are included automatically without maintaining a second list in this script.
	nice -n 10 cmake --build "$engine" --config "$config" -j "$jobs"
	binary="$(engine_binary "$engine" "$config")"
	# Never ship Bambu's proprietary network plugin or the GUI (slicer/UPSTREAM.md rule 7).
	if grep -a -q -E 'bambu_networking|NetworkAgent' "$binary"; then
		die "the engine references bambu_networking or NetworkAgent; it must not."
	fi
	local dist="$SLICER/dist/${mode:+$mode/}$plat"
	rm -rf "$dist"
	mkdir -p "$dist/resources/profiles"
	cp "$binary" "$dist/"
	case "$plat" in
	darwin-*)
		python3 "$SLICER/scripts/bundle-macos-runtime.py" --engine "$binary" --destination "$dist"
		;;
	win32-*)
		cmake "-DENGINE=$binary" "-DPREFIX=$BUILD/deps/usr/local" "-DDESTINATION=$dist" \
			-P "$SLICER/scripts/bundle-windows-runtime.cmake"
		;;
	esac
	cp -R "$UP/resources/profiles/BBL" "$UP/resources/profiles/BBL.json" "$dist/resources/profiles/"
	# calib/: the calibration tests' models (features/calib); printlab/: our own (ported from OrcaSlicer).
	for d in printers info calib; do [ -d "$UP/resources/$d" ] && cp -R "$UP/resources/$d" "$dist/resources/"; done
	[ -d "$SLICER/engine/resources" ] && mkdir -p "$dist/resources/printlab" && cp -R "$SLICER/engine/resources/." "$dist/resources/printlab/"
	cp "$UP/LICENSE" "$dist/LICENSE"
	local version
	version="$(sed -n -E 's/^project\(printlab-slicer VERSION ([0-9.]+).*/\1/p' "$SLICER/engine/CMakeLists.txt")"
	printf '{"engine":"printlab-slicer","version":"%s","platform":"%s","upstream":{"name":"%s","tag":"%s","commit":"%s"},"patchQueue":{"version":%s,"hash":"%s"}}\n' \
		"$version" "$plat" "$(lock_get name)" "$(lock_get tag)" "$(lock_get commit)" "$(lock_get queue)" "$(lock_get queue_hash)" >"$dist/engine.json"
	say "Print Lab Slicer is in ${dist#"$ROOT"/} (the app finds it there)."
}

cmd_test() {
	local engine="" codec="" dir mode="" config=Release native_only=0 protocol_only=0 result=0 suite_result
	while [ $# -gt 0 ]; do
		case "$1" in
		--sanitize | --debug-symbols)
			[ -z "$mode" ] || die "choose either --sanitize or --debug-symbols."
			if [ "$1" = --sanitize ]; then mode=sanitize; else mode=debug; fi
			config=RelWithDebInfo
			;;
		--native-only) native_only=1 ;;
		--no-upstream) protocol_only=1 ;;
		*) die "unknown option $1" ;;
		esac
		shift
	done
	# GMP/MPFR are DLLs on Windows; ctest binaries are in their own configuration directories.
	PATH="$SLICER/dist/${mode:+$mode/}$(platform_key):$BUILD/deps/usr/local/bin:$BUILD/deps/usr/local/lib:$PATH"
	export PATH
	local dirs=("$BUILD/engine${mode:+-$mode}" "$BUILD/engine-protocol${mode:+-$mode}")
	[ $protocol_only = 0 ] || dirs=("$BUILD/engine-protocol${mode:+-$mode}")
	for dir in "${dirs[@]}"; do
		if [ -f "$dir/CTestTestfile.cmake" ]; then
			# Keep collecting independent failures after an expensive platform build.
			if ctest --test-dir "$dir" --build-config "$config" --output-on-failure; then
				:
			else
				suite_result=$?
				[ "$result" != 0 ] || result=$suite_result
			fi
			if [ -z "$engine" ]; then
				engine="$(engine_binary "$dir" "$config")"
				codec="$dir/tests/project_codec"
				if grep -q '^CMAKE_CONFIGURATION_TYPES:' "$dir/CMakeCache.txt"; then codec="$dir/tests/$config/project_codec"; fi
				case "$(platform_key)" in win32-*) codec="$codec.exe" ;; esac
			fi
		fi
	done
	[ -n "$engine" ] || die "no matching engine build: run build with the same options first."
	[ $native_only = 0 ] || return "$result"
	[ -f "$codec" ] || die "the project codec test helper is missing: rebuild the engine first."
	if (cd "$ROOT/app" && PRINTLAB_SLICER_PATH="$engine" PRINTLAB_PROJECT_CODEC="$codec" bunx vitest --run \
		src/lib/server/slicer/ src/lib/server/slicer3mf/native-codec.test.ts); then
		:
	else
		suite_result=$?
		[ "$result" != 0 ] || result=$suite_result
	fi
	return "$result"
}

case "${1:-}" in
fetch | rebase | export | status | resources | ports | build | test)
	cmd="$1"
	shift
	"cmd_$cmd" "$@"
	;;
*)
	sed -n '6,15p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
