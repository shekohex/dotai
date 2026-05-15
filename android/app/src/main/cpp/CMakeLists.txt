# For more information about using CMake with Android Studio, read the
# documentation: https://d.android.com/studio/projects/add-native-code.html.
# For more examples on how to use CMake, see https://github.com/android/ndk-samples.

# Sets the minimum CMake version required for this project.
cmake_minimum_required(VERSION 3.22.1)
project(coder-terminal LANGUAGES C CXX)

include(FetchContent)

set(FT_DISABLE_ZLIB TRUE CACHE BOOL "" FORCE)
set(FT_DISABLE_BZIP2 TRUE CACHE BOOL "" FORCE)
set(FT_DISABLE_PNG TRUE CACHE BOOL "" FORCE)
set(FT_DISABLE_HARFBUZZ TRUE CACHE BOOL "" FORCE)
set(FT_DISABLE_BROTLI TRUE CACHE BOOL "" FORCE)

FetchContent_Declare(
    freetype
    URL https://download.savannah.gnu.org/releases/freetype/freetype-2.13.3.tar.xz
)
FetchContent_MakeAvailable(freetype)

set(HB_BUILD_SUBSET OFF CACHE BOOL "" FORCE)
set(HB_BUILD_UTILS OFF CACHE BOOL "" FORCE)
set(HB_HAVE_FREETYPE ON CACHE BOOL "" FORCE)
set(HB_HAVE_GLIB OFF CACHE BOOL "" FORCE)
set(HB_HAVE_GOBJECT OFF CACHE BOOL "" FORCE)
set(HB_HAVE_ICU OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    harfbuzz
    URL https://github.com/harfbuzz/harfbuzz/releases/download/8.5.0/harfbuzz-8.5.0.tar.xz
)
FetchContent_MakeAvailable(harfbuzz)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(GHOSTTY_LIB ${CMAKE_SOURCE_DIR}/../../../libs/${ANDROID_ABI}/libghostty-vt.a)
set(GHOSTTY_INCLUDE ${CMAKE_SOURCE_DIR}/../../../libs/include)
set(GENERATED_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated)

file(MAKE_DIRECTORY ${GENERATED_DIR})
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/shaders/terminal.vert TERMINAL_VERTEX_SHADER)
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/shaders/terminal.frag TERMINAL_FRAGMENT_SHADER)
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/shaders/solid.vert SOLID_VERTEX_SHADER)
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/shaders/solid.frag SOLID_FRAGMENT_SHADER)
configure_file(${CMAKE_CURRENT_SOURCE_DIR}/coder_shaders.h.in ${GENERATED_DIR}/coder_shaders.h @ONLY)

add_library(coder-terminal SHARED
    coder_jni.cpp
    coder_terminal.cpp
    coder_renderer.cpp
    coder_font.cpp
)

target_include_directories(coder-terminal PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${GENERATED_DIR})

if(NOT EXISTS ${GHOSTTY_LIB})
    message(FATAL_ERROR "Missing libghostty-vt for ${ANDROID_ABI}: ${GHOSTTY_LIB}")
endif()

if(NOT EXISTS ${GHOSTTY_INCLUDE}/ghostty/vt.h)
    message(FATAL_ERROR "Missing Ghostty VT headers: ${GHOSTTY_INCLUDE}")
endif()

add_library(ghostty-vt STATIC IMPORTED)
set_target_properties(ghostty-vt PROPERTIES IMPORTED_LOCATION ${GHOSTTY_LIB})
target_include_directories(coder-terminal PRIVATE ${GHOSTTY_INCLUDE})
target_link_libraries(coder-terminal PRIVATE ghostty-vt)

target_link_libraries(coder-terminal PRIVATE freetype harfbuzz EGL GLESv3 android log)
