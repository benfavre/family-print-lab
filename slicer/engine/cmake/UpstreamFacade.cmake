# BambuStudio CMakeLists.txt at the pinned source adds these settings to its own directory, not
# libslic3r's public interface. Facade translation units include the same headers from outside that
# directory: on Windows they need _USE_MATH_DEFINES before <cmath>, consistent Boost WinAPI/UTF-8
# definitions, and explicit Boost linking rather than MSVC's header-driven automatic linking.
function(printlab_upstream_facade_platform target upstream)
    if (WIN32)
        get_directory_property(definitions DIRECTORY "${upstream}" COMPILE_DEFINITIONS)
        target_compile_definitions(${target} PRIVATE ${definitions})
        if (MSVC)
            # Match upstream's large-object and source-encoding options without adopting its PCH,
            # debug-information, warning suppression or parallel-compiler policy.
            target_compile_options(${target} PRIVATE /bigobj "$<$<CXX_COMPILER_ID:MSVC>:/utf-8>")
        endif ()
    endif ()
endfunction()
