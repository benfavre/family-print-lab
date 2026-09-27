# Included by the dependency project's project() call. Read actual CMake targets after every
# subdirectory has been configured; generator-specific `--target help` output is not an API.
cmake_minimum_required(VERSION 3.19)

function(printlab_collect_dependency_targets directory)
    get_property(targets DIRECTORY "${directory}" PROPERTY BUILDSYSTEM_TARGETS)
    foreach(target IN LISTS targets)
        if(target MATCHES "^dep_[A-Za-z0-9_]+$" AND
           NOT target MATCHES "^dep_(GLEW|OpenCSG|GLFW)$")
            file(APPEND "${CMAKE_BINARY_DIR}/printlab-dependency-targets.txt" "${target}\n")
        endif()
    endforeach()
    get_property(children DIRECTORY "${directory}" PROPERTY SUBDIRECTORIES)
    foreach(child IN LISTS children)
        printlab_collect_dependency_targets("${child}")
    endforeach()
endfunction()

function(printlab_write_dependency_targets)
    file(WRITE "${CMAKE_BINARY_DIR}/printlab-dependency-targets.txt" "")
    printlab_collect_dependency_targets("${CMAKE_SOURCE_DIR}")
endfunction()

if(CMAKE_CURRENT_SOURCE_DIR STREQUAL CMAKE_SOURCE_DIR)
    cmake_language(DEFER CALL printlab_write_dependency_targets)
endif()
