#pragma once

#include "coder_font.h"
#include "coder_terminal.h"

#include <GLES3/gl3.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

class CoderRenderer {
public:
    CoderRenderer();
    ~CoderRenderer();

    bool init();
    void setFontData(const uint8_t* data, size_t length);
    void setTheme(uint32_t background, uint32_t cursor, uint32_t cursorText);
    void setTextOptions(bool ligatures, bool cursorBlink, int cursorMode);
    void setTargetRefreshRate(float refreshRate);
    void setCellSize(int width, int height);
    void resize(int width, int height);
    void draw(CoderTerminal& terminal);
    int cellWidth() const;
    int cellHeight() const;

private:
    GLuint compile(GLenum type, const char* source);
    bool updateCachedCells(const std::vector<CoderCell>& cells, int cols, int rows, int cursorCol, int cursorRow);
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
    GLsizei cachedGlyphVertexCount_ = 0;
    GLsizei cachedSolidVertexCount_ = 0;
    uint32_t clearColor_ = 0x101014;
    uint32_t cursorColor_ = 0xe5e5e5;
    uint32_t cursorTextColor_ = 0x101014;
    float targetRefreshRate_ = 60.0f;
    bool cursorBlink_ = true;
    int cursorMode_ = 0;
    std::vector<CoderCell> cachedCells_;
    CoderFont font_;
};
