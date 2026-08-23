# Included at the end of SUMO src/CMakeLists.txt by build.sh.
add_executable(uniscenarios-sumo-wasm "${UNISCENARIOS_SUMO_WASM_BRIDGE}")
target_link_libraries(uniscenarios-sumo-wasm ${sumolibs} libsumostatic)
target_link_options(uniscenarios-sumo-wasm PRIVATE
    # SUMO objects are compiled MinSizeRel. Avoid a multi-minute whole-module
    # Binaryen/LTO pass in the reproducible feasibility build; post-link -Oz is
    # a separate release optimization gate.
    "-O0"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web,worker,node"
    "-sFILESYSTEM=1"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sINITIAL_MEMORY=67108864"
    "-sMAXIMUM_MEMORY=536870912"
    "-sMALLOC=emmalloc"
    "-sASSERTIONS=0"
    "-sWASM_BIGINT=1"
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU32','UTF8ToString','stringToUTF8','lengthBytesUTF8']"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_us_sumo_start','_us_sumo_step','_us_sumo_upsert_external','_us_sumo_remove','_us_sumo_state_pointer','_us_sumo_state_count','_us_sumo_signal_state_pointer','_us_sumo_signal_state_count','_us_sumo_time','_us_sumo_last_error','_us_sumo_close']"
)
set_target_properties(uniscenarios-sumo-wasm PROPERTIES
    OUTPUT_NAME "sumo"
    SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/wasm"
)
