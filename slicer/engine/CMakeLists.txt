# printlab-slicer: Print Lab's headless slicing engine. Our code only; Bambu Studio comes in from the
# checkout slicer/scripts/upstream.sh materialises (slicer/.upstream: the tag in ../upstream.lock plus
# ../patches), consumed with add_subdirectory(... EXCLUDE_FROM_ALL) so only libslic3r and what it needs
# are built. Only src/facade/upstream/ includes upstream headers.
#
#   cmake -S slicer/engine -B build -DPRINTLAB_UPSTREAM_DIR=slicer/.upstream \
#         -DCMAKE_PREFIX_PATH=<deps>/usr/local -DCMAKE_BUILD_TYPE=Release
#   cmake -S slicer/engine -B build -DPRINTLAB_WITH_UPSTREAM=OFF   # protocol layer only (tests, CI)
cmake_minimum_required(VERSION 3.13)
project(printlab-slicer VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if (NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif ()

option(PRINTLAB_WITH_UPSTREAM "Build the slicing core from Bambu Studio (OFF: protocol layer only)" ON)
set(PRINTLAB_UPSTREAM_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../.upstream" CACHE PATH "Bambu Studio checkout (upstream.sh fetch)")
option(PRINTLAB_BUILD_TESTS "Build the engine's tests (ctest)" ON)

# The pin and the patch queue, reported in engine.hello. upstream.lock is key=value with # comments.
set(_slicer_dir "${CMAKE_CURRENT_SOURCE_DIR}/..")
file(STRINGS "${_slicer_dir}/upstream.lock" _lock_lines)
foreach (_line IN LISTS _lock_lines)
    string(REGEX REPLACE "(^|[ \t])#.*$" "" _line "${_line}")
    if (_line MATCHES "^[ \t]*([a-z_]+)[ \t]*=[ \t]*(.*[^ \t])?[ \t]*$")
        set(PRINTLAB_LOCK_${CMAKE_MATCH_1} "${CMAKE_MATCH_2}")
    endif ()
endforeach ()
if (NOT PRINTLAB_LOCK_queue)
    set(PRINTLAB_LOCK_queue 0)
endif ()
set(PRINTLAB_PATCHES "")
if (EXISTS "${_slicer_dir}/patches/series")
    file(STRINGS "${_slicer_dir}/patches/series" _series)
    foreach (_p IN LISTS _series)
        string(REGEX REPLACE "(^|[ \t])#.*$" "" _p "${_p}")
        string(STRIP "${_p}" _p)
        if (_p)
            list(APPEND PRINTLAB_PATCHES "${_p}")
        endif ()
    endforeach ()
endif ()
string(REPLACE ";" "," PRINTLAB_PATCHES "${PRINTLAB_PATCHES}")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_slicer_dir}/upstream.lock" "${_slicer_dir}/patches/series")
configure_file(src/version.hpp.in "${CMAKE_CURRENT_BINARY_DIR}/generated/version.hpp" @ONLY)

# The protocol layer: no upstream code, builds anywhere.
add_library(printlab_rpc STATIC
    src/rpc/json.cpp
    src/rpc/convert.cpp
    src/rpc/server.cpp
    src/rpc/methods.cpp
    src/facade/identity.cpp)
target_include_directories(printlab_rpc PUBLIC src "${CMAKE_CURRENT_BINARY_DIR}/generated")
find_package(Threads REQUIRED)
target_link_libraries(printlab_rpc PUBLIC Threads::Threads)

add_library(printlab_features STATIC src/features/thumbnails/thumbnails.cpp)
target_include_directories(printlab_features PUBLIC src)

if (PRINTLAB_WITH_UPSTREAM)
    if (NOT EXISTS "${PRINTLAB_UPSTREAM_DIR}/src/libslic3r/CMakeLists.txt")
        message(FATAL_ERROR "No Bambu Studio checkout at ${PRINTLAB_UPSTREAM_DIR}: run slicer/scripts/upstream.sh fetch, or configure with -DPRINTLAB_WITH_UPSTREAM=OFF.")
    endif ()
    # Headless, with upstream's own switches (see slicer/UPSTREAM.md); patch 0001 lets the top-level
    # CMakeLists.txt skip OpenGL, GLEW and GLFW when the GUI is off.
    set(SLIC3R_GUI OFF CACHE BOOL "" FORCE)
    set(SLIC3R_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(SLIC3R_STATIC ON CACHE BOOL "")
    # No precompiled headers: smaller compiler processes on small machines. Upstream relies on them to
    # hide a missing include or two (patch 0002).
    set(SLIC3R_PCH OFF CACHE BOOL "")
    set(BBL_RELEASE_TO_PUBLIC 1 CACHE STRING "")
    # "Not copy FFMPEG file": upstream's own switch; otherwise src/CMakeLists.txt copies the GUI's
    # FFmpeg libraries at configure time on Linux, and the headless deps build has none.
    set(FLATPAK TRUE CACHE BOOL "" FORCE)
    # Imported targets are local to the directory that finds them; libslic3r's link interface names
    # Boost::filesystem, so find Boost here first (same components and version as upstream's
    # CMakeLists.txt) to make its targets visible to our targets too.
    set(Boost_USE_STATIC_LIBS ON)
    find_package(Boost 1.83.0 REQUIRED COMPONENTS system filesystem thread log locale regex chrono atomic date_time iostreams)
    # The same for cereal: libslic3r links the imported target `cereal`, which otherwise ends up on
    # our link line as a plain -lcereal (header-only, so there is no such library).
    find_package(cereal REQUIRED)
    add_subdirectory("${PRINTLAB_UPSTREAM_DIR}" upstream EXCLUDE_FROM_ALL)
    find_package(ZLIB REQUIRED)
    target_compile_definitions(printlab_features PRIVATE PRINTLAB_HAVE_ZLIB)
    target_link_libraries(printlab_features PRIVATE ZLIB::ZLIB)
    add_library(printlab_facade STATIC
        src/facade/upstream/convert.cpp
        src/facade/upstream/model_io.cpp
        src/facade/upstream/presets.cpp
        src/facade/upstream/arrange_orient.cpp
        src/facade/upstream/slice.cpp
        src/facade/upstream/export.cpp
        src/facade/upstream/facade.cpp
        src/facade/upstream/link_shims.cpp)
    # libslic3r's MD5 calls (bbs_3mf.cpp, utils.cpp) come from OpenSSL, which upstream only links
    # through the GUI; the deps build has it.
    find_package(OpenSSL REQUIRED)
    target_link_libraries(printlab_facade PUBLIC printlab_rpc printlab_features libslic3r cereal OpenSSL::Crypto)
    # Upstream adds its source tree, bundled libraries (boost::nowide, libigl, Eigen) and generated
    # platform headers with include_directories() in its own top-level CMakeLists.txt, which does not
    # reach this directory: the facade takes the same list from there.
    get_directory_property(_upstream_includes DIRECTORY "${PRINTLAB_UPSTREAM_DIR}" INCLUDE_DIRECTORIES)
    target_include_directories(printlab_facade PRIVATE ${_upstream_includes})
    target_compile_definitions(printlab_facade PRIVATE PRINTLAB_UPSTREAM_RESOURCES="${PRINTLAB_UPSTREAM_DIR}/resources")
else ()
    add_library(printlab_facade STATIC src/facade/null_facade.cpp)
    target_link_libraries(printlab_facade PUBLIC printlab_rpc)
endif ()

add_executable(printlab-slicer src/main.cpp)
target_link_libraries(printlab-slicer PRIVATE printlab_facade printlab_rpc printlab_features)
if (UNIX AND NOT APPLE AND PRINTLAB_WITH_UPSTREAM)
    target_link_libraries(printlab-slicer PRIVATE ${CMAKE_DL_LIBS})
endif ()

if (PRINTLAB_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif ()
