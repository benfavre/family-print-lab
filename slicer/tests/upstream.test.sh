#!/usr/bin/env bash
# Tests slicer/scripts/upstream.sh against a toy upstream with three tags: fetch at the pin, add and
# export a patch, re-fetch from the queue, rebase to a new tag and export again, then a tag the patch
# conflicts with (--report must list it and put the checkout back), and a tag that moved upstream.
#   bash slicer/tests/upstream.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/upstream.sh"
T="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT

# A clean git environment: no user config, fixed identity.
export HOME="$T/home" GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=Tester GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=Tester GIT_COMMITTER_EMAIL=t@example.invalid
mkdir -p "$HOME"
git config --global init.defaultBranch main
git config --global advice.detachedHead false

pass=0
ok() {
	pass=$((pass + 1))
	echo "ok $pass - $1"
}
fail() {
	echo "not ok - $1" >&2
	exit 1
}
expect() { # expect <description> <command…>
	local what="$1"
	shift
	"$@" || fail "$what"
	ok "$what"
}

# The toy upstream: v1, v2 (changes a line far from our patch), v3 (changes the line next to ours).
TOY="$T/toy"
git init --quiet "$TOY"
printf 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n' >"$TOY/lib.txt"
mkdir -p "$TOY/resources/printers"
echo '{"model_id":"T1"}' >"$TOY/resources/printers/T1.json"
git -C "$TOY" add -A && git -C "$TOY" commit --quiet -m "v1"
git -C "$TOY" tag -a v1 -m v1
sed -i 's/^theta$/theta (upstream v2)/' "$TOY/lib.txt"
git -C "$TOY" commit --quiet -am "v2"
git -C "$TOY" tag -a v2 -m v2
sed -i 's/^gamma$/gamma (upstream v3)/' "$TOY/lib.txt"
git -C "$TOY" commit --quiet -am "v3"
git -C "$TOY" tag v3
V1="$(git -C "$TOY" rev-parse 'v1^{commit}')"
V2="$(git -C "$TOY" rev-parse 'v2^{commit}')"

# A repository shaped like ours: slicer/{scripts/upstream.sh,upstream.lock,patches/series,UPSTREAM.md}.
R="$T/repo"
mkdir -p "$R/slicer/scripts" "$R/slicer/patches" "$R/app/resources"
cp "$SCRIPT" "$R/slicer/scripts/upstream.sh"
cat >"$R/slicer/upstream.lock" <<EOF
# toy lock
name=Toy
url=file://$TOY  # a trailing comment
tag=v1
commit=$V1
queue=0
queue_hash=
EOF
: >"$R/slicer/patches/series"
printf '# Upstream\n\n<!-- pin:start -->\nold\n<!-- pin:end -->\n\nRest of the page.\n' >"$R/slicer/UPSTREAM.md"
U="$R/slicer/scripts/upstream.sh"
UP="$R/slicer/.upstream"
lock() { sed -n "s/^$1=//p" "$R/slicer/upstream.lock"; }

# fetch at the pin, empty queue.
"$U" fetch >/dev/null
expect "fetch checks out the pinned commit" [ "$(git -C "$UP" rev-parse HEAD)" = "$V1" ]
expect "fetch tags printlab-base" [ "$(git -C "$UP" rev-parse 'printlab-base^{commit}')" = "$V1" ]
expect "fetch links rr-cache into the repository" [ -L "$UP/.git/rr-cache" ]
expect "a second fetch does nothing" bash -c "'$U' fetch | grep -q 'already at v1'"
grep -q 'state:      clean' <<<"$("$U" status)" || fail "status reports a clean checkout"
ok "status reports a clean checkout"

# A patch: change 'delta', commit with a header, export.
sed -i 's/^delta$/delta (print lab)/' "$UP/lib.txt"
git -C "$UP" commit --quiet -am "Build: our toy change" -m "Why: the test needs one patch. Upstreamable: no."
grep -q 'not exported' <<<"$("$U" status)" || fail "status notices an unexported commit"
ok "status notices an unexported commit"
if "$U" fetch >/dev/null 2>&1; then fail "fetch refuses to drop unexported commits"; fi
ok "fetch refuses to drop unexported commits"
"$U" export >/dev/null
PATCH="$(sed -e '/^#/d' -e '/^$/d' "$R/slicer/patches/series")"
expect "export writes one patch and the series" [ "$PATCH" = "0001-Build-our-toy-change.patch" ]
expect "the patch keeps its header" grep -q 'Upstreamable: no' "$R/slicer/patches/$PATCH"
expect "export zeroes the From line" grep -q '^From 0000000000000000000000000000000000000000' "$R/slicer/patches/$PATCH"
expect "export bumps the queue version" [ "$(lock queue)" = 1 ]
H1="$(lock queue_hash)"
expect "export records the queue hash" [ ${#H1} = 64 ]
expect "export keeps comments in the lock" grep -q '# toy lock' "$R/slicer/upstream.lock"
expect "export writes the pin into UPSTREAM.md" grep -q "| Bambu Studio | \`v1\` | \`$V1\` | version 1, 1 patch(es)" "$R/slicer/UPSTREAM.md"
expect "UPSTREAM.md keeps the rest of the page" grep -q 'Rest of the page.' "$R/slicer/UPSTREAM.md"
"$U" export >/dev/null
expect "exporting again without changes keeps the version" [ "$(lock queue) $(lock queue_hash)" = "1 $H1" ]

# A fresh fetch replays the queue.
rm -rf "$UP"
"$U" fetch >/dev/null
expect "fetch applies the queue" grep -q '^delta (print lab)$' "$UP/lib.txt"
expect "patches carry the patch queue as committer" [ "$(git -C "$UP" log -1 --format=%cn)" = "Print Lab patch queue" ]

# Rebase onto v2 and export.
"$U" rebase v2 --report "$T/report-v2.json" >/dev/null
expect "the rebase report says ok" grep -q '"ok":true' "$T/report-v2.json"
expect "rebase keeps our change" grep -q '^delta (print lab)$' "$UP/lib.txt"
expect "rebase brings upstream's change" grep -q '^theta (upstream v2)$' "$UP/lib.txt"
if "$U" fetch >/dev/null 2>&1; then fail "fetch refuses to drop a rebase that is not exported"; fi
ok "fetch refuses to drop a rebase that is not exported"
"$U" export >/dev/null
expect "export moves the lock to the new tag" [ "$(lock tag) $(lock commit)" = "v2 $V2" ]
expect "export bumps the queue version on a new tag" [ "$(lock queue)" = 2 ]
expect "the lock keeps its url" [ "$(lock url)" = "file://$TOY  # a trailing comment" ]

cp -R "$R/slicer/patches" "$T/patches-v2" && cp "$R/slicer/upstream.lock" "$T/lock-v2"

# v3 edits the line next to ours: the report lists the patch, the checkout goes back to v2.
if "$U" rebase v3 --report "$T/report-v3.json" >/dev/null 2>&1; then fail "a conflicting rebase fails"; fi
ok "a conflicting rebase fails"
expect "the report lists the failing patch" grep -q "\"failed\":\[\"$PATCH\"\]" "$T/report-v3.json"
expect "the report says not ok" grep -q '"ok":false' "$T/report-v3.json"
expect "the checkout is back on printlab at v2" [ "$(git -C "$UP" rev-parse --abbrev-ref HEAD) $(git -C "$UP" rev-parse 'printlab-base^{commit}')" = "printlab $V2" ]
expect "the checkout is clean after the report" [ -z "$(git -C "$UP" status --porcelain --untracked-files=no)" ]
expect "the lock still pins v2" [ "$(lock tag)" = v2 ]

# Without --report the rebase stops for a person; a recorded resolution is replayed next time.
if "$U" rebase v3 >/dev/null 2>"$T/stop.txt"; then fail "rebase stops on a conflict"; fi
expect "rebase explains how to continue" grep -q 'rebase --continue' "$T/stop.txt"
sed -i -e '/^<<<<<<<\|^=======\|^>>>>>>>/d' -e '/^gamma$/d' -e '/^delta$/d' "$UP/lib.txt"
grep -q '^gamma (upstream v3)$' "$UP/lib.txt" && grep -q '^delta (print lab)$' "$UP/lib.txt" || fail "test resolved the conflict"
git -C "$UP" add lib.txt
GIT_EDITOR=true git -C "$UP" rebase --continue >/dev/null 2>&1
"$U" export >/dev/null
expect "export after a hand-resolved rebase pins v3" [ "$(lock tag)" = v3 ]
expect "the resolution is recorded in slicer/rr-cache" [ -n "$(ls "$R/slicer/rr-cache")" ]

# Back at v2 with a fresh checkout, the same rebase now replays the recorded resolution by itself.
rm -rf "$UP" "$R/slicer/patches" && cp -R "$T/patches-v2" "$R/slicer/patches" && cp "$T/lock-v2" "$R/slicer/upstream.lock"
"$U" fetch >/dev/null
"$U" rebase v3 --report "$T/report-v3-again.json" >/dev/null 2>&1 || fail "rerere replays the recorded resolution"
ok "rerere replays the recorded resolution"
expect "the replayed rebase has both changes" grep -q '^gamma (upstream v3)$' "$UP/lib.txt"
expect "the replayed rebase has both changes (ours)" grep -q '^delta (print lab)$' "$UP/lib.txt"

# resources copies what the checkout has.
"$U" resources >/dev/null
expect "resources copies printers" [ -f "$R/app/resources/bambu/printers/T1.json" ]

# A tag that moved upstream is refused.
sed -i "s/^commit=.*/commit=$V1/" "$R/slicer/upstream.lock"
rm -rf "$UP"
if "$U" fetch >/dev/null 2>"$T/moved.txt"; then fail "fetch refuses a moved tag"; fi
expect "fetch explains a moved tag" grep -q 'Refusing' "$T/moved.txt"

echo "# $pass passed"
