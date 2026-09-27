# BambuStudio CMakeLists.txt at the pinned source adds these settings to its own directory, not
# libslic3r's public interface. Facade translation units include the same headers from outside that
# directory: on Windows they need _USE_MATH_DEFINES before <cmath>, consistent Boost WinAPI/UTF-8
# definitions, and explicit Boost linking rather than MSVC's header-driven automatic linking.
function(printlab_upstream_facade_platform target upstream)
    if (WIN32)
        get_directory_property(definitions DIRECTORY "${upstream}" COMPILE_DEFINITIONS)
        target_compile_definitions(${target} PRIVATE ${definitions})
        # BambuStudio v02.08.02.61 CMakeLists.txt links crypt32 through its libcurl interface.
        # Our headless facade consumes static OpenSSL::Crypto directly: its CAPI engine references
        # Cert* SDK functions, so every executable using this static facade needs the same library.
        # https://github.com/bambulab/BambuStudio/blob/926a7192574bcb9b3a732e1ec59a46d79cb45466/CMakeLists.txt
        target_link_libraries(${target} PUBLIC crypt32)
        if (MSVC)
            # Match upstream's large-object and source-encoding options without adopting its PCH,
            # debug-information, warning suppression or parallel-compiler policy.
            target_compile_options(${target} PRIVATE /bigobj "$<$<CXX_COMPILER_ID:MSVC>:/utf-8>")
        endif ()
    endif ()
endfunction()
