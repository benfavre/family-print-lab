#!/usr/bin/env bash
# Select an executable native CMake can launch. Strawberry Perl also supplies an extensionless
# pkg-config script: Git Bash can run it, but Windows CreateProcess (and CMake) cannot.
set -euo pipefail
for candidate in "$@"; do
	case "$candidate" in *.exe | *.EXE) ;; *) continue ;; esac
	if [ -f "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
		printf '%s\n' "$candidate"
		exit 0
	fi
done
echo 'No working native pkg-config.exe found. Install pkgconfiglite before building on Windows.' >&2
exit 1
