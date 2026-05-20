#pragma once

#include "coder_font.h"
#include "coder_terminal.h"

#include <GLES3/gl3.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

struct Vertex { float x, y, u, v; uint8_t r, g, b, colorGlyph, br, bg, bb, padding; };
struct SolidVertex { float x, y, r, g, b, a; };

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
    void setTextOptions(bool ligatures, bool contextualAlternates, bool slashedZero, bool stylisticSet1, bool stylisticSet2, bool characterVariant1, bool boldFontStyle, bool cursorBlink, int cursorMode);
    void setTargetRefreshRate(float refreshRate);
    void setCellSize(int width, int height, int fontPixelSize);
    void resize(int width, int height);
    void draw(CoderTerminal& terminal);
    int cellWidth() const;
    int cellHeight() const;

private:
    void releaseGlResources();
    GLuint compile(GLenum type, const char* source);
    GLuint linkProgram(const char* name, const char* vertexSource, const char* fragmentSource);
    bool loadProgramBinary(GLuint program, const char* name, const char* vertexSource, const char* fragmentSource);
    void saveProgramBinary(GLuint program, const char* name, const char* vertexSource, const char* fragmentSource);
    std::string shaderCachePath(const char* name, const char* vertexSource, const char* fragmentSource) const;
    bool updateCachedCells(int cols, int rows, const CoderCursor& cursor, bool cellsChanged);
    GLuint program_ = 0;
    GLuint solidProgram_ = 0;
    GLuint vao_ = 0;
    GLuint solidVao_ = 0;
    std::vector<GLuint> rowGlyphVbos_;
    std::vector<GLuint> rowSolidVbos_;
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
    bool hasPresentedFrame_ = false;
    uint32_t cachedCursorColor_ = 0;
    GhosttyRenderStateCursorVisualStyle cachedCursorVisualStyle_ = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
    GLsizei cachedGlyphVertexCount_ = 0;
    GLsizei cachedSolidVertexCount_ = 0;
    uint32_t clearColor_ = 0x101014;
    uint32_t cursorColor_ = 0xe5e5e5;
    uint32_t cursorTextColor_ = 0x101014;
    float targetRefreshRate_ = 60.0f;
    uint64_t cachedAtlasGeneration_ = 0;
    uint64_t cachedSnapshotGeneration_ = 0;
    bool cursorBlink_ = true;
    int cursorMode_ = 0;
    std::vector<CoderCell> cachedCells_;
    std::vector<Vertex> frameVertices_;
    std::vector<SolidVertex> frameSolidVertices_;
    std::vector<uint8_t> frameSkipText_;
    std::vector<uint8_t> dirtyRows_;
    std::vector<std::vector<Vertex>> rowGlyphVertices_;
    std::vector<std::vector<SolidVertex>> rowSolidVertices_;
    std::vector<GLsizei> rowGlyphVertexCounts_;
    std::vector<GLsizei> rowSolidVertexCounts_;
    std::string shaderCacheDir_;
    CoderFont font_;
};
