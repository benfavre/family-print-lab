#!/usr/bin/env python3
"""Compile with upstream's Windows definitions, without PCH or native dependencies."""
import pathlib
import subprocess
import sys
import tempfile

upstream = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[1] / ".upstream"
source = (upstream / "CMakeLists.txt").read_text(encoding="utf-8")
start = source.index("if(WIN32)\n    add_definitions")
settings = source[start:source.index("endif(WIN32)", start) + len("endif(WIN32)")]

with tempfile.TemporaryDirectory(prefix="printlab-windows-platform-") as directory:
    root = pathlib.Path(directory)
    (root / "CMakeLists.txt").write_text(f'''cmake_minimum_required(VERSION 3.13)
project(WindowsPlatform LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(WIN32 ON)
{settings}
add_executable(platform platform.cpp)
''', encoding="utf-8")
    (root / "platform.cpp").write_text('''#include <limits>
#ifdef _MSC_VER
#include <windows.h>
#else
// Reproduce the SDK macros on non-Windows hosts, after the standard headers just as Thread.cpp
// can encounter them without pchheader.hpp. On MSVC exercise the real Windows SDK instead.
#ifndef NOMINMAX
#define min(a, b) ((a) < (b) ? (a) : (b))
#define max(a, b) ((a) > (b) ? (a) : (b))
#endif
#endif
struct Version { int min() const { return 0; } };
int main() { return std::numeric_limits<int>::max() > Version{}.min() ? 0 : 1; }
''', encoding="utf-8")
    for command in [
        ["cmake", "-S", str(root), "-B", str(root / "build")],
        ["cmake", "--build", str(root / "build"), "--config", "Release"],
    ]:
        result = subprocess.run(command, capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
    print("ok - upstream Windows definitions protect standard min/max without PCH")
