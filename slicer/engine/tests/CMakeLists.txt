# ctest: the protocol layer and the thumbnails everywhere; facade smoke tests with upstream.
function(printlab_test name)
    add_executable(${name} ${name}.cpp)
    target_link_libraries(${name} PRIVATE ${ARGN})
    add_test(NAME ${name} COMMAND ${name})
endfunction()

printlab_test(test_json printlab_rpc)
# Compile the older-macOS fallback on every host, even when its standard library has to_chars.
add_executable(test_json_portable test_json.cpp ../src/rpc/json.cpp)
target_include_directories(test_json_portable PRIVATE ../src)
target_compile_definitions(test_json_portable PRIVATE PRINTLAB_JSON_FORCE_PORTABLE)
add_test(NAME test_json_portable COMMAND test_json_portable)
printlab_test(test_rpc printlab_rpc printlab_facade)
# Compile the real entry point with an ordinary cross-translation-unit static logger. This catches
# startup contamination even in protocol-only builds, before the native dependency build is needed.
add_executable(test_startup_engine ../src/main.cpp startup_log.cpp)
target_link_libraries(test_startup_engine PRIVATE printlab_facade printlab_rpc printlab_features)
if(UNIX AND NOT APPLE AND PRINTLAB_WITH_UPSTREAM)
    target_link_libraries(test_startup_engine PRIVATE ${CMAKE_DL_LIBS})
endif()
add_test(NAME test_startup COMMAND ${CMAKE_COMMAND}
    "-DENGINE=$<TARGET_FILE:test_startup_engine>" -P "${CMAKE_CURRENT_SOURCE_DIR}/test_startup.cmake")
printlab_test(test_thumbnails printlab_features)
printlab_test(test_calib printlab_features)
printlab_test(test_preview printlab_rpc printlab_features)
printlab_test(test_wipe_tower printlab_features)
printlab_test(test_project printlab_rpc printlab_features)
add_executable(project_codec project_codec.cpp)
target_link_libraries(project_codec PRIVATE printlab_rpc printlab_features)
printlab_test(test_slice_config printlab_rpc)
if (PRINTLAB_WITH_UPSTREAM)
    printlab_test(test_facade printlab_facade)
    printlab_test(test_arrange printlab_facade)
    printlab_test(test_validation printlab_facade)
    # A scheduler rendezvous regression must fail instead of hanging a native build forever.
    set_tests_properties(test_facade test_arrange test_validation PROPERTIES TIMEOUT 180)
    # Needs Bambu Studio's profiles: the checkout's resources/ (upstream.sh fetch has them).
    set_tests_properties(test_facade PROPERTIES ENVIRONMENT "PRINTLAB_TEST_RESOURCES=${PRINTLAB_UPSTREAM_DIR}/resources")
    set_tests_properties(test_arrange PROPERTIES ENVIRONMENT "PRINTLAB_TEST_RESOURCES=${PRINTLAB_UPSTREAM_DIR}/resources")
    set_tests_properties(test_validation PROPERTIES ENVIRONMENT "PRINTLAB_TEST_RESOURCES=${PRINTLAB_UPSTREAM_DIR}/resources")
endif ()
