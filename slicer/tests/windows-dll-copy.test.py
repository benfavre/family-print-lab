#!/usr/bin/env python3
"""Exercise the pinned Windows runtime-copy function without Windows or native dependencies.

Run after upstream.sh fetch: python3 slicer/tests/windows-dll-copy.test.py [upstream-directory]
Only placeholder DLL files are copied; no generated binaries are executed.
"""
import pathlib
import re
import subprocess
import sys
import tempfile

upstream = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[1] / ".upstream"
source = (upstream / "CMakeLists.txt").read_text(encoding="utf-8")
start = source.index("function(bambustudio_copy_dlls ")
function = source[start:source.index("endfunction()", start) + len("endfunction()")]
ffmpeg = {"avcodec-61.dll", "swresample-5.dll", "swscale-8.dll", "avutil-59.dll"}

with tempfile.TemporaryDirectory(prefix="printlab-dll-copy-") as directory:
    root = pathlib.Path(directory)
    for name, gui, available in [("headless", False, False), ("gui-missing", True, False), ("gui", True, True)]:
        fixture = root / name
        fixture.mkdir()
        prefix = fixture / "prefix"
        # Materialise core runtime names used by the real function, while deliberately omitting
        # FFmpeg in the first two cases. This reproduces a completed headless dependency prefix.
        paths = re.findall(r"\$\{CMAKE_PREFIX_PATH\}/([^\s)]+\.dll)", function)
        for relative in paths:
            if "${" in relative or pathlib.Path(relative).name in ffmpeg:
                continue
            target = prefix / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        for relative in ["GMP/gmp/lib/win64/libgmp-10.dll", "MPFR/mpfr/lib/win64/libmpfr-4.dll", "WebView2/lib/win64/WebView2Loader.dll"]:
            target = fixture / "deps" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        if available:
            for dll in ffmpeg:
                (prefix / "bin" / dll).touch()
        output = fixture / "output"
        cmake = f'''cmake_minimum_required(VERSION 3.13)
project(WindowsDllCopy NONE)
set(CMAKE_SIZEOF_VOID_P 8)
set(CMAKE_SYSTEM_PROCESSOR x64)
set(CMAKE_GENERATOR_PLATFORM "")
set(SLIC3R_GUI {"ON" if gui else "OFF"})
set(TOP_LEVEL_PROJECT_DIR "${{CMAKE_CURRENT_SOURCE_DIR}}")
set(CMAKE_PREFIX_PATH "${{CMAKE_CURRENT_SOURCE_DIR}}/prefix")
add_custom_target(runtime)
set_target_properties(runtime PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${{CMAKE_CURRENT_SOURCE_DIR}}/output")
{function}
bambustudio_copy_dlls(runtime Release "" runtime_files)
file(WRITE "${{CMAKE_CURRENT_BINARY_DIR}}/runtime-files.txt" "${{runtime_files}}")
'''
        (fixture / "CMakeLists.txt").write_text(cmake, encoding="utf-8")
        result = subprocess.run(["cmake", "-S", str(fixture), "-B", str(fixture / "build")], capture_output=True, text=True)
        if name == "gui-missing":
            assert result.returncode != 0 and "avcodec-61.dll" in result.stderr, result.stdout + result.stderr
        else:
            assert result.returncode == 0, result.stdout + result.stderr
            assert (output / "libgmp-10.dll").exists(), "Headless core DLLs must still be copied"
            exported = (fixture / "build/runtime-files.txt").read_text(encoding="utf-8")
            for dll in ffmpeg:
                assert (output / dll).exists() == gui, (name, dll)
                assert (dll in exported) == gui, (name, dll, exported)
        print(f"ok - {name} Windows runtime copying")
