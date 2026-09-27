# Run in a Visual Studio developer shell after building the executable. Upstream's GMP/MPFR
# recipes install their DLLs into deps/usr/local/bin; resolve their transitive imports too.
cmake_minimum_required(VERSION 3.19)
if(NOT EXISTS "${ENGINE}")
    message(FATAL_ERROR "Missing engine: ${ENGINE}")
endif()
set(CMAKE_GET_RUNTIME_DEPENDENCIES_PLATFORM windows+pe)
set(CMAKE_GET_RUNTIME_DEPENDENCIES_TOOL dumpbin)
find_program(CMAKE_GET_RUNTIME_DEPENDENCIES_COMMAND dumpbin REQUIRED)
# OCCT installs into win64/vc*/bin rather than the prefix's bin directory (OCCT CMakeLists.txt,
# INSTALL_DIR_BIN); GMP and MPFR use bin. Search the installed prefix, never upstream's GUI tree.
file(GLOB_RECURSE installed_dlls "${PREFIX}/*.dll")
set(search_dirs "${PREFIX}/bin" "${PREFIX}/lib")
foreach(library IN LISTS installed_dlls)
    get_filename_component(directory "${library}" DIRECTORY)
    list(APPEND search_dirs "${directory}")
endforeach()
list(REMOVE_DUPLICATES search_dirs)
file(GET_RUNTIME_DEPENDENCIES
    EXECUTABLES "${ENGINE}"
    DIRECTORIES ${search_dirs}
    RESOLVED_DEPENDENCIES_VAR resolved
    UNRESOLVED_DEPENDENCIES_VAR unresolved
    PRE_EXCLUDE_REGEXES "[Aa][Pp][Ii]-[Mm][Ss]-" "[Ee][Xx][Tt]-[Mm][Ss]-"
    POST_EXCLUDE_REGEXES ".*[Ww][Ii][Nn][Dd][Oo][Ww][Ss][/\\\\].*")
if(unresolved)
    message(FATAL_ERROR "Unresolved engine runtime libraries: ${unresolved}")
endif()
foreach(library IN LISTS resolved)
    if(library MATCHES "[Bb][Aa][Mm][Bb][Uu]_[Nn][Ee][Tt][Ww][Oo][Rr][Kk][Ii][Nn][Gg]")
        message(FATAL_ERROR "The engine must not ship the proprietary networking plugin")
    endif()
    file(COPY "${library}" DESTINATION "${DESTINATION}")
endforeach()
# The host's System32 copies are excluded above. Ship the matching redistributable CRT supplied
# by Visual Studio, so the desktop bundle also starts on machines without the developer tools.
set(arch "$ENV{VSCMD_ARG_TGT_ARCH}")
if(NOT arch)
    set(arch x64)
endif()
file(GLOB crt "$ENV{VCToolsRedistDir}/${arch}/Microsoft.VC*.CRT/*.dll")
if(NOT crt)
    message(FATAL_ERROR "Visual Studio CRT redistributables not found; use a developer shell")
endif()
file(COPY ${crt} DESTINATION "${DESTINATION}")
