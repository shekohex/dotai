#pragma once

#include "coder_font.h"
#include "coder_terminal.h"

#include <GLES3/gl3.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

class CoderRenderer {
public:
    CoderRenderer();
    ~CoderRenderer();

    bool init();
    void setFontData(const uint8_t* data, size_t length);
    void setFontData(const uint8_t* regularData, size_t regularLength, const uint8_t* boldData, size_t boldLength, const uint8_t* italicData, size_t italicLength, const uint8_t* boldItalicData, size_t boldItalicLength);
    void setFallbackFontData(const uint8_t* data, size_t length);
    void setShaderCacheDir(std::string path);
    void setTheme(uint32_t background, uint32_t cursor, uint32_t cursorText);
    void setTextOptions(bool ligatures, bool contextualAlternates, bool slashedZero, bool stylisticSet1, bool stylisticSet2, bool characterVariant1, bool cursorBlink, int cursorMode);
    void setTargetRefreshRate(float refreshRate);
    void setCellSize(int width, int height);
    void resize(int width, int height);
    void draw(CoderTerminal& terminal);
    int cellWidth() const;
    int cellHeight() const;

private:
    GLuint compile(GLenum type, const char* source);
    GLuint linkProgram(const char* name, const char* vertexSource, const char* fragmentSource);
    bool loadProgramBinary(GLuint program, const char* name, const char* vertexSource, const char* fragmentSource);
    void saveProgramBinary(GLuint program, const char* name, const char* vertexSource, const char* fragmentSource);
    std::string shaderCachePath(const char* name, const char* vertexSource, const char* fragmentSource) const;
    bool updateCachedCells(const std::vector<CoderCell>& cells, int cols, int rows, const CoderCursor& cursor);
    GLuint program_ = 0;
    GLuint solidProgram_ = 0;
    GLuint vao_ = 0;
    GLuint vbo_ = 0;
    GLuint solidVao_ = 0;
    GLuint solidVbo_ = 0;
    int width_ = 1;
    int height_ = 1;
    int cachedCols_ = 0;
    int cachedRows_ = 0;
    int cachedCursorCol_ = -1;
    int cachedCursorRow_ = -1;
    bool cachedCursorVisible_ = true;
    bool cachedBlinkPhase_ = true;
    bool cachedCursorBlinking_ = true;
    bool cachedCursorColorHasValue_ = false;
    uint32_t cachedCursorColor_ = 0;
    GhosttyRenderStateCursorVisualStyle cachedCursorVisualStyle_ = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
    GLsizei cachedGlyphVertexCount_ = 0;
    GLsizei cachedSolidVertexCount_ = 0;
    uint32_t clearColor_ = 0x101014;
    uint32_t cursorColor_ = 0xe5e5e5;
    uint32_t cursorTextColor_ = 0x101014;
    float targetRefreshRate_ = 60.0f;
    bool cursorBlink_ = true;
    int cursorMode_ = 0;
    std::vector<CoderCell> cachedCells_;
    std::string shaderCacheDir_;
    CoderFont font_;
};
