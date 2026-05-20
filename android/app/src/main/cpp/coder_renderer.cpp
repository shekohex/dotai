#include "coder_renderer.h"
#include "coder_shaders.h"

#include <android/log.h>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <vector>

struct Vertex { float x, y, u, v, r, g, b, br, bg, bb, colorGlyph; };
struct SolidVertex { float x, y, r, g, b, a; };

static bool isZeroWidthCodepoint(uint32_t codepoint) {
    return codepoint == 0x200d ||
        (codepoint >= 0xfe00 && codepoint <= 0xfe0f) ||
        (codepoint >= 0xe0100 && codepoint <= 0xe01ef) ||
        (codepoint >= 0x0300 && codepoint <= 0x036f) ||
        (codepoint >= 0x1f3fb && codepoint <= 0x1f3ff);
}

static bool isEmojiCodepoint(uint32_t codepoint) {
    return codepoint >= 0x1f000 || (codepoint >= 0x2600 && codepoint <= 0x27bf);
}

static bool isNarrowPrintableAsciiCell(const CoderCell& cell) {
    return cell.wide == GHOSTTY_CELL_WIDE_NARROW && cell.codepointCount == 1 && cell.codepoints[0] > ' ' && cell.codepoints[0] < 0x7fu;
}

static bool isArabicCodepoint(uint32_t codepoint) {
    return (codepoint >= 0x0600 && codepoint <= 0x06ff) ||
        (codepoint >= 0x0750 && codepoint <= 0x077f) ||
        (codepoint >= 0x08a0 && codepoint <= 0x08ff) ||
        (codepoint >= 0xfb50 && codepoint <= 0xfdff) ||
        (codepoint >= 0xfe70 && codepoint <= 0xfeff);
}

static bool isArabicRunCell(const CoderCell& cell) {
    if (cell.wide != GHOSTTY_CELL_WIDE_NARROW || cell.codepointCount != 1) return false;
    return isArabicCodepoint(cell.codepoints[0]) || cell.codepoints[0] == ' ';
}

static bool isEmojiClusterContinuation(const CoderCell& cell) {
    if (cell.wide == GHOSTTY_CELL_WIDE_SPACER_HEAD || cell.wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) return true;
    if (cell.codepointCount == 0) return false;
    uint32_t codepoint = cell.codepoints[0];
    return codepoint == 0x200d || (codepoint >= 0xfe00 && codepoint <= 0xfe0f) || (codepoint >= 0x1f3fb && codepoint <= 0x1f3ff);
}

static void addSolidQuad(std::vector<SolidVertex>& vertices, float x0, float y0, float x1, float y1, float r, float g, float b, float a) {
    vertices.insert(vertices.end(), {{x0,y0,r,g,b,a},{x1,y0,r,g,b,a},{x1,y1,r,g,b,a},{x0,y0,r,g,b,a},{x1,y1,r,g,b,a},{x0,y1,r,g,b,a}});
}

CoderRenderer::CoderRenderer() = default;

CoderRenderer::~CoderRenderer() {
    releaseGlResources();
}

void CoderRenderer::releaseGlResources() {
    if (vbo_ != 0) glDeleteBuffers(1, &vbo_);
    if (solidVbo_ != 0) glDeleteBuffers(1, &solidVbo_);
    if (vao_ != 0) glDeleteVertexArrays(1, &vao_);
    if (solidVao_ != 0) glDeleteVertexArrays(1, &solidVao_);
    if (program_ != 0) glDeleteProgram(program_);
    if (solidProgram_ != 0) glDeleteProgram(solidProgram_);
    vbo_ = 0;
    solidVbo_ = 0;
    vao_ = 0;
    solidVao_ = 0;
    program_ = 0;
    solidProgram_ = 0;
}

bool CoderRenderer::init() {
    releaseGlResources();
    cachedCells_.clear();
    GLint programBinaryFormatCount = 0;
    glGetIntegerv(GL_NUM_PROGRAM_BINARY_FORMATS, &programBinaryFormatCount);
    __android_log_print(ANDROID_LOG_INFO, "CoderRenderer", "gl_vendor=%s gl_renderer=%s gl_version=%s program_binary_formats=%d shader_cache=%s", glGetString(GL_VENDOR), glGetString(GL_RENDERER), glGetString(GL_VERSION), programBinaryFormatCount, shaderCacheDir_.empty() ? "disabled" : shaderCacheDir_.c_str());
    program_ = linkProgram("terminal", CoderTerminalVertexShader, CoderTerminalFragmentShader);
    solidProgram_ = linkProgram("solid", CoderSolidVertexShader, CoderSolidFragmentShader);
    GLint terminalLinked = 0;
    GLint solidLinked = 0;
    glGetProgramiv(program_, GL_LINK_STATUS, &terminalLinked);
    glGetProgramiv(solidProgram_, GL_LINK_STATUS, &solidLinked);
    if (!terminalLinked || !solidLinked) {
        char terminalLog[1024]{};
        char solidLog[1024]{};
        glGetProgramInfoLog(program_, sizeof(terminalLog), nullptr, terminalLog);
        glGetProgramInfoLog(solidProgram_, sizeof(solidLog), nullptr, solidLog);
        __android_log_print(ANDROID_LOG_ERROR, "CoderRenderer", "terminal link=%d %s solid link=%d %s", terminalLinked, terminalLog, solidLinked, solidLog);
    }
    glGenVertexArrays(1, &vao_);
    glGenBuffers(1, &vbo_);
    glGenVertexArrays(1, &solidVao_);
    glGenBuffers(1, &solidVbo_);
    glBindVertexArray(vao_);
    glBindBuffer(GL_ARRAY_BUFFER, vbo_);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, sizeof(Vertex), reinterpret_cast<void*>(0));
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, sizeof(Vertex), reinterpret_cast<void*>(sizeof(float) * 2));
    glEnableVertexAttribArray(2);
    glVertexAttribPointer(2, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex), reinterpret_cast<void*>(sizeof(float) * 4));
    glEnableVertexAttribArray(3);
    glVertexAttribPointer(3, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex), reinterpret_cast<void*>(sizeof(float) * 7));
    glEnableVertexAttribArray(4);
    glVertexAttribPointer(4, 1, GL_FLOAT, GL_FALSE, sizeof(Vertex), reinterpret_cast<void*>(sizeof(float) * 10));
    glBindVertexArray(solidVao_);
    glBindBuffer(GL_ARRAY_BUFFER, solidVbo_);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, sizeof(SolidVertex), reinterpret_cast<void*>(0));
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 4, GL_FLOAT, GL_FALSE, sizeof(SolidVertex), reinterpret_cast<void*>(sizeof(float) * 2));
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    return program_ != 0 && solidProgram_ != 0 && font_.init();
}

void CoderRenderer::setFontData(const uint8_t* data, size_t length) {
    font_.setFontData(data, length);
    cachedCells_.clear();
}

void CoderRenderer::setFontData(const uint8_t* regularData, size_t regularLength, const uint8_t* boldData, size_t boldLength, const uint8_t* italicData, size_t italicLength, const uint8_t* boldItalicData, size_t boldItalicLength) {
    font_.setFontData(regularData, regularLength, boldData, boldLength, italicData, italicLength, boldItalicData, boldItalicLength);
    cachedCells_.clear();
}

void CoderRenderer::setFallbackFontData(const uint8_t* data, size_t length) {
    font_.setFallbackFontData(data, length);
    cachedCells_.clear();
}

void CoderRenderer::setShaderCacheDir(std::string path) {
    shaderCacheDir_ = std::move(path);
}

void CoderRenderer::setTheme(uint32_t background, uint32_t cursor, uint32_t cursorText) {
    clearColor_ = background;
    cursorColor_ = cursor;
    cursorTextColor_ = ((cursorText >> 16u) & 0xffu) | (cursorText & 0x00ff00u) | ((cursorText & 0xffu) << 16u);
    cachedCells_.clear();
}

void CoderRenderer::setTextOptions(bool ligatures, bool contextualAlternates, bool slashedZero, bool stylisticSet1, bool stylisticSet2, bool characterVariant1, bool cursorBlink, int cursorMode) {
    font_.setOpenTypeFeatures(ligatures, contextualAlternates, slashedZero, stylisticSet1, stylisticSet2, characterVariant1);
    cursorBlink_ = cursorBlink;
    cursorMode_ = cursorMode < 0 ? 0 : cursorMode > 2 ? 2 : cursorMode;
    cachedCells_.clear();
}

void CoderRenderer::setTargetRefreshRate(float refreshRate) {
    targetRefreshRate_ = refreshRate > 1.0f ? refreshRate : 60.0f;
}

void CoderRenderer::resize(int width, int height) {
    const int nextWidth = width > 0 ? width : 1;
    const int nextHeight = height > 0 ? height : 1;
    if (width_ != nextWidth || height_ != nextHeight) cachedCells_.clear();
    width_ = nextWidth;
    height_ = nextHeight;
    glViewport(0, 0, width_, height_);
}

void CoderRenderer::setCellSize(int width, int height) {
    font_.setCellSize(width, height);
    cachedCells_.clear();
}

int CoderRenderer::cellWidth() const {
    return font_.glyphWidth();
}

int CoderRenderer::cellHeight() const {
    return font_.glyphHeight();
}

bool CoderRenderer::updateCachedCells(const std::vector<CoderCell>& cells, int cols, int rows, const CoderCursor& cursor) {
    bool changed = cachedCols_ != cols || cachedRows_ != rows || cachedCursorCol_ != cursor.col || cachedCursorRow_ != cursor.row || cachedCursorBlinking_ != cursor.blinking || cachedCursorColorHasValue_ != cursor.colorHasValue || cachedCursorColor_ != cursor.color || cachedCursorVisualStyle_ != cursor.visualStyle || cachedCells_.size() != cells.size();
    if (!changed) {
        for (size_t index = 0; index < cells.size(); index++) {
            if (!(cachedCells_[index] == cells[index])) {
                changed = true;
                break;
            }
        }
    }
    if (!changed) return false;
    cachedCols_ = cols;
    cachedRows_ = rows;
    cachedCursorCol_ = cursor.col;
    cachedCursorRow_ = cursor.row;
    cachedCursorBlinking_ = cursor.blinking;
    cachedCursorColorHasValue_ = cursor.colorHasValue;
    cachedCursorColor_ = cursor.color;
    cachedCursorVisualStyle_ = cursor.visualStyle;
    cachedCells_ = cells;
    return true;
}

void CoderRenderer::draw(CoderTerminal& terminal) {
    terminal.pump();
    if (terminal.synchronizedOutput() && cachedGlyphVertexCount_ > 0) return;
    int cols, rows;
    CoderCursor cursor;
    auto cells = terminal.snapshot(cols, rows, cursor);
    auto now = std::chrono::steady_clock::now();
    bool blinkPhase = (std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() / 550) % 2 == 0;
    bool cursorVisible = cursor.visible && (!cursor.blinking || !cursorBlink_ || (std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() / 550) % 2 == 0);
    bool hasBlinkingCells = false;
    for (const auto& cell : cells) {
        if ((cell.flags & 512u) != 0u) {
            hasBlinkingCells = true;
            break;
        }
    }
    bool shouldUploadBuffers = updateCachedCells(cells, cols, rows, cursor) || cachedCursorVisible_ != cursorVisible || (hasBlinkingCells && cachedBlinkPhase_ != blinkPhase);
    cachedCursorVisible_ = cursorVisible;
    cachedBlinkPhase_ = blinkPhase;
    glClearColor(((clearColor_ >> 16u) & 255u) / 255.0f, ((clearColor_ >> 8u) & 255u) / 255.0f, (clearColor_ & 255u) / 255.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    std::vector<Vertex> vertices;
    std::vector<SolidVertex> solidVertices;
    float cw = 2.0f * font_.glyphWidth() / width_;
    float ch = 2.0f * font_.glyphHeight() / height_;
    auto snapX = [&](float x) { return -1.0f + std::round(((x + 1.0f) * 0.5f) * static_cast<float>(width_)) * 2.0f / static_cast<float>(width_); };
    auto snapY = [&](float y) { return -1.0f + std::round(((y + 1.0f) * 0.5f) * static_cast<float>(height_)) * 2.0f / static_cast<float>(height_); };
    if (shouldUploadBuffers) {
        vertices.reserve(cells.size() * 6);
        solidVertices.reserve((cells.size() + 1) * 6);
        std::vector<uint8_t> skipText(cells.size(), 0);
        for (int row = 0; row < rows; row++) {
            int visualColumnShift = 0;
            for (int col = 0; col < cols; col++) {
            const auto& cell = cells[row * cols + col];
            float gridX0 = snapX(-1.0f + col * cw);
            float y0 = snapY(1.0f - (row + 1) * ch);
            float gridX1 = snapX(-1.0f + (col + 1) * cw);
            float y1 = snapY(1.0f - row * ch);
            float br = ((cell.background >> 0) & 255) / 255.0f;
            float bg = ((cell.background >> 8) & 255) / 255.0f;
            float bb = ((cell.background >> 16) & 255) / 255.0f;
            addSolidQuad(solidVertices, gridX0, y0, gridX1, y1, br, bg, bb, 1.0f);
            int cellSpan = cell.wide == GHOSTTY_CELL_WIDE_WIDE ? 2 : 1;
            float x0 = snapX(-1.0f + (col - visualColumnShift) * cw);
            float x1 = snapX(-1.0f + (col + cellSpan - visualColumnShift) * cw);
            float glyphCursorX = x0;
            auto glyphXBounds = [&](const CoderFont::Glyph& glyph, int xOffsetPixels) {
                float rawX0 = x0 + 2.0f * static_cast<float>(xOffsetPixels) / static_cast<float>(width_);
                float rawWidth = 2.0f * static_cast<float>(glyph.width) / static_cast<float>(width_);
                if (cell.wide == GHOSTTY_CELL_WIDE_WIDE) {
                    float availableWidth = x1 - x0;
                    float drawWidth = std::min(rawWidth, availableWidth);
                    float centeredX0 = x0 + std::max(0.0f, (availableWidth - drawWidth) * 0.5f);
                    float snappedX0 = snapX(centeredX0);
                    return std::array<float, 2>{snappedX0, snappedX0 + drawWidth};
                }
                float snappedX0 = snapX(rawX0);
                return std::array<float, 2>{snappedX0, snappedX0 + rawWidth};
            };
            uint32_t glyphColor = row == cursor.row && col == cursor.col && cursor.visualStyle == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK ? cursorTextColor_ : cell.foreground;
            float r = ((glyphColor >> 0) & 255) / 255.0f;
            float g = ((glyphColor >> 8) & 255) / 255.0f;
            float b = ((glyphColor >> 16) & 255) / 255.0f;
            if ((cell.flags & 256u) != 0u) {
                r = br + (r - br) * 0.50f;
                g = bg + (g - bg) * 0.50f;
                b = bb + (b - bb) * 0.50f;
            }
            const bool blinkHidden = (cell.flags & 512u) != 0u && !blinkPhase;
            bool synthesizeBold = font_.shouldSynthesizeBold(cell.flags);
            auto addDecorationColor = [&](float y, float thickness, float decorationR, float decorationG, float decorationB) {
                float dy = thickness * ch;
                addSolidQuad(solidVertices, x0, y, x1, y + dy, decorationR, decorationG, decorationB, 1.0f);
            };
            auto addSegmentedDecorationColor = [&](float y, float thickness, float decorationR, float decorationG, float decorationB, int segments, bool alternating) {
                float dy = thickness * ch;
                float segmentWidth = (x1 - x0) / static_cast<float>(segments);
                for (int segment = 0; segment < segments; segment++) {
                    if (alternating && (segment % 2) != 0) continue;
                    float sx0 = x0 + static_cast<float>(segment) * segmentWidth;
                    float sx1 = sx0 + segmentWidth * (alternating ? 0.72f : 0.38f);
                    addSolidQuad(solidVertices, sx0, y, sx1, y + dy, decorationR, decorationG, decorationB, 1.0f);
                }
            };
            auto addDecoration = [&](float y, float thickness) { addDecorationColor(y, thickness, r, g, b); };
            uint32_t underlineStyle = (cell.flags >> 5u) & 7u;
            if ((cell.flags & 4u) != 0u) {
                float ur = ((cell.underlineColor >> 0) & 255) / 255.0f;
                float ug = ((cell.underlineColor >> 8) & 255) / 255.0f;
                float ub = ((cell.underlineColor >> 16) & 255) / 255.0f;
                if (underlineStyle == 4u) {
                    addSegmentedDecorationColor(y0 + ch * 0.12f, 0.055f, ur, ug, ub, 6, false);
                } else if (underlineStyle == 5u) {
                    addSegmentedDecorationColor(y0 + ch * 0.12f, 0.045f, ur, ug, ub, 4, true);
                } else if (underlineStyle == 3u) {
                    addDecorationColor(y0 + ch * 0.09f, 0.035f, ur, ug, ub);
                    addSegmentedDecorationColor(y0 + ch * 0.17f, 0.035f, ur, ug, ub, 4, true);
                } else {
                    addDecorationColor(y0 + ch * 0.12f, 0.045f, ur, ug, ub);
                    if (underlineStyle == 2u) addDecorationColor(y0 + ch * 0.20f, 0.045f, ur, ug, ub);
                }
            }
            if ((cell.flags & 8u) != 0u) addDecoration(y0 + ch * 0.50f, 0.045f);
            if ((cell.flags & 16u) != 0u) addDecoration(y1 - ch * 0.14f, 0.045f);
            if (blinkHidden || cell.wide == GHOSTTY_CELL_WIDE_SPACER_HEAD || cell.wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) continue;
            if (cell.codepointCount == 0) continue;
            if (skipText[static_cast<size_t>(row * cols + col)] != 0) continue;
            if (isNarrowPrintableAsciiCell(cell)) {
                int runEndCol = col + 1;
                while (runEndCol < cols) {
                    const auto& runCell = cells[row * cols + runEndCol];
                    if (!isNarrowPrintableAsciiCell(runCell)) break;
                    if (runCell.flags != cell.flags || runCell.foreground != cell.foreground) break;
                    if (row == cursor.row && cursor.col >= col && cursor.col <= runEndCol) break;
                    runEndCol++;
                }
                if (runEndCol - col > 1) {
                    std::array<uint32_t, 64> runCodepoints{};
                    uint32_t runCodepointCount = 0;
                    for (int runCol = col; runCol < runEndCol && runCodepointCount < runCodepoints.size(); runCol++) runCodepoints[runCodepointCount++] = cells[row * cols + runCol].codepoints[0];
                    auto runGlyphs = font_.shape(runCodepoints.data(), runCodepointCount, cell.flags);
                    bool runRenderable = !runGlyphs.empty();
                    for (const auto& shapedGlyph : runGlyphs) {
                        CoderFont::Glyph glyph;
                        bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                        if (shapedGlyph.glyphId == 0 || !loaded) {
                            runRenderable = false;
                            break;
                        }
                    }
                    if (runRenderable) {
                        for (int skippedCol = col + 1; skippedCol < runEndCol; skippedCol++) skipText[static_cast<size_t>(row * cols + skippedCol)] = 1;
                        float runCursorX = x0;
                        for (const auto& shapedGlyph : runGlyphs) {
                            CoderFont::Glyph glyph;
                            bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                            if (!loaded || glyph.width <= 0 || glyph.height <= 0) {
                                runCursorX += 2.0f * static_cast<float>(shapedGlyph.xAdvance) / static_cast<float>(width_);
                                continue;
                            }
                            auto glyphX = glyphXBounds(glyph, glyph.bearingLeft + shapedGlyph.xOffset + static_cast<int>(std::round((runCursorX - x0) * static_cast<float>(width_) * 0.5f)));
                            float glyphX0 = glyphX[0];
                            float glyphY1 = snapY(y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop - shapedGlyph.yOffset) / static_cast<float>(height_));
                            float glyphX1 = glyphX[1];
                            float glyphY0 = snapY(glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_));
                            float colorGlyph = glyph.color ? 1.0f : 0.0f;
                            vertices.insert(vertices.end(), {{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY0,glyph.u1,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0,glyphY1,glyph.u0,glyph.v0,r,g,b,br,bg,bb,colorGlyph}});
                            runCursorX += 2.0f * static_cast<float>(shapedGlyph.xAdvance) / static_cast<float>(width_);
                        }
                        continue;
                    }
                }
            }
            if (cell.codepointCount == 1 && isArabicCodepoint(cell.codepoints[0])) {
                int runEndCol = col + 1;
                while (runEndCol < cols) {
                    const auto& runCell = cells[row * cols + runEndCol];
                    if (!isArabicRunCell(runCell)) break;
                    if (runCell.flags != cell.flags || runCell.foreground != cell.foreground) break;
                    if (row == cursor.row && cursor.col >= col && cursor.col <= runEndCol) break;
                    runEndCol++;
                }
                while (runEndCol > col && cells[row * cols + runEndCol - 1].codepointCount == 1 && cells[row * cols + runEndCol - 1].codepoints[0] == ' ') runEndCol--;
                if (runEndCol - col > 1) {
                    std::array<uint32_t, 64> runCodepoints{};
                    uint32_t runCodepointCount = 0;
                    for (int runCol = col; runCol < runEndCol && runCodepointCount < runCodepoints.size(); runCol++) runCodepoints[runCodepointCount++] = cells[row * cols + runCol].codepoints[0];
                    auto runGlyphs = font_.shape(runCodepoints.data(), runCodepointCount, cell.flags);
                    bool runRenderable = !runGlyphs.empty();
                    for (const auto& shapedGlyph : runGlyphs) {
                        CoderFont::Glyph glyph;
                        bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                        if (shapedGlyph.glyphId == 0 || !loaded) {
                            runRenderable = false;
                            break;
                        }
                    }
                    if (runRenderable) {
                        for (int skippedCol = col + 1; skippedCol < runEndCol; skippedCol++) skipText[static_cast<size_t>(row * cols + skippedCol)] = 1;
                        float runCursorX = x0;
                        for (const auto& shapedGlyph : runGlyphs) {
                            CoderFont::Glyph glyph;
                            bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                            if (!loaded || glyph.width <= 0 || glyph.height <= 0) {
                                runCursorX += 2.0f * static_cast<float>(shapedGlyph.xAdvance) / static_cast<float>(width_);
                                continue;
                            }
                            auto glyphX = glyphXBounds(glyph, glyph.bearingLeft + shapedGlyph.xOffset + static_cast<int>(std::round((runCursorX - x0) * static_cast<float>(width_) * 0.5f)));
                            float glyphX0 = glyphX[0];
                            float glyphY1 = snapY(y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop - shapedGlyph.yOffset) / static_cast<float>(height_));
                            float glyphX1 = glyphX[1];
                            float glyphY0 = snapY(glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_));
                            float colorGlyph = glyph.color ? 1.0f : 0.0f;
                            vertices.insert(vertices.end(), {{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY0,glyph.u1,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0,glyphY1,glyph.u0,glyph.v0,r,g,b,br,bg,bb,colorGlyph}});
                            runCursorX += 2.0f * static_cast<float>(shapedGlyph.xAdvance) / static_cast<float>(width_);
                        }
                        continue;
                    }
                }
            }
            std::array<uint32_t, 32> clusterCodepoints{};
            uint32_t clusterCodepointCount = 0;
            int clusterEndCol = col;
            bool clusterHasEmoji = false;
            auto appendCellCodepoints = [&](const CoderCell& sourceCell) {
                for (uint32_t index = 0; index < sourceCell.codepointCount && clusterCodepointCount < clusterCodepoints.size(); index++) {
                    uint32_t codepoint = sourceCell.codepoints[index];
                    clusterHasEmoji = clusterHasEmoji || isEmojiCodepoint(codepoint);
                    clusterCodepoints[clusterCodepointCount++] = codepoint;
                }
            };
            appendCellCodepoints(cell);
            while (clusterCodepointCount > 0 && clusterEndCol + 1 < cols) {
                int nextCol = clusterEndCol + 1;
                while (nextCol < cols && (cells[row * cols + nextCol].codepointCount == 0 || cells[row * cols + nextCol].wide == GHOSTTY_CELL_WIDE_SPACER_HEAD || cells[row * cols + nextCol].wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) && nextCol <= clusterEndCol + 2) nextCol++;
                if (nextCol >= cols) break;
                const auto& nextCell = cells[row * cols + nextCol];
                if (nextCell.codepointCount == 0) break;
                if (clusterCodepoints[clusterCodepointCount - 1] != 0x200d && !isEmojiClusterContinuation(nextCell)) break;
                clusterEndCol = nextCol;
                appendCellCodepoints(nextCell);
            }
            if (clusterHasEmoji && clusterEndCol > col && clusterCodepointCount > cell.codepointCount) {
                auto clusterGlyphs = font_.shape(clusterCodepoints.data(), clusterCodepointCount, cell.flags);
                bool clusterRenderable = !clusterGlyphs.empty();
                for (const auto& shapedGlyph : clusterGlyphs) {
                    CoderFont::Glyph glyph;
                    bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                    if (shapedGlyph.glyphId == 0 || !loaded) {
                        clusterRenderable = false;
                        break;
                    }
                }
                if (clusterRenderable) {
                    float clusterCursorX = x0;
                    for (int skippedCol = col + 1; skippedCol <= clusterEndCol; skippedCol++) skipText[static_cast<size_t>(row * cols + skippedCol)] = 1;
                    for (const auto& shapedGlyph : clusterGlyphs) {
                        CoderFont::Glyph glyph;
                        bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                        if (!loaded || glyph.width <= 0 || glyph.height <= 0) continue;
                        auto glyphX = glyphXBounds(glyph, glyph.bearingLeft + shapedGlyph.xOffset + static_cast<int>(std::round((clusterCursorX - x0) * static_cast<float>(width_) * 0.5f)));
                        float glyphX0 = glyphX[0];
                        float glyphY1 = snapY(y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop - shapedGlyph.yOffset) / static_cast<float>(height_));
                        float glyphX1 = glyphX[1];
                        float glyphY0 = snapY(glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_));
                        float colorGlyph = glyph.color ? 1.0f : 0.0f;
                        vertices.insert(vertices.end(), {{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY0,glyph.u1,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0,glyphY1,glyph.u0,glyph.v0,r,g,b,br,bg,bb,colorGlyph}});
                        clusterCursorX += 2.0f * static_cast<float>(shapedGlyph.xAdvance) / static_cast<float>(width_);
                    }
                    int clusterCellSpan = clusterEndCol - col + 1;
                    int collapsedCellSpan = clusterHasEmoji ? 2 : clusterCellSpan;
                    if (clusterCellSpan > collapsedCellSpan) visualColumnShift += clusterCellSpan - collapsedCellSpan;
                    continue;
                }
            }
            auto drawCodepoints = [&]() {
                for (uint32_t codepointIndex = 0; codepointIndex < cell.codepointCount; codepointIndex++) {
                    uint32_t codepoint = cell.codepoints[codepointIndex];
                    if (codepoint <= ' ' || isZeroWidthCodepoint(codepoint)) continue;
                    CoderFont::Glyph glyph;
                    if (!font_.glyph(codepoint, cell.flags, glyph) || glyph.width <= 0 || glyph.height <= 0) continue;
                    auto glyphX = glyphXBounds(glyph, glyph.bearingLeft + static_cast<int>(std::round((glyphCursorX - x0) * static_cast<float>(width_) * 0.5f)));
                    float glyphX0 = glyphX[0];
                    float glyphY1 = snapY(y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop) / static_cast<float>(height_));
                    float glyphX1 = glyphX[1];
                    float glyphY0 = snapY(glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_));
                    float colorGlyph = glyph.color ? 1.0f : 0.0f;
                    vertices.insert(vertices.end(), {{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY0,glyph.u1,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0,glyphY1,glyph.u0,glyph.v0,r,g,b,br,bg,bb,colorGlyph}});
                    glyphCursorX += 2.0f * static_cast<float>(glyph.advance) / static_cast<float>(width_);
                }
            };
            auto shapedGlyphs = font_.shape(cell.codepoints.data(), cell.codepointCount, cell.flags);
            if (shapedGlyphs.empty()) {
                drawCodepoints();
                continue;
            }
            bool shapedGlyphsRenderable = true;
            for (const auto& shapedGlyph : shapedGlyphs) {
                CoderFont::Glyph glyph;
                bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                if (shapedGlyph.glyphId == 0 || !loaded) {
                    shapedGlyphsRenderable = false;
                    break;
                }
            }
            if (!shapedGlyphsRenderable) {
                drawCodepoints();
                continue;
            }
            for (const auto& shapedGlyph : shapedGlyphs) {
                CoderFont::Glyph glyph;
                bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                if (!loaded || glyph.width <= 0 || glyph.height <= 0) continue;
                auto glyphX = glyphXBounds(glyph, glyph.bearingLeft + shapedGlyph.xOffset + static_cast<int>(std::round((glyphCursorX - x0) * static_cast<float>(width_) * 0.5f)));
                float glyphX0 = glyphX[0];
                float glyphY1 = snapY(y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop - shapedGlyph.yOffset) / static_cast<float>(height_));
                float glyphX1 = glyphX[1];
                float glyphY0 = snapY(glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_));
                float colorGlyph = glyph.color ? 1.0f : 0.0f;
                vertices.insert(vertices.end(), {{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY0,glyph.u1,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0,glyphY1,glyph.u0,glyph.v0,r,g,b,br,bg,bb,colorGlyph}});
                if (synthesizeBold && !glyph.color) {
                    float boldOffset = 2.0f / static_cast<float>(width_);
                    vertices.insert(vertices.end(), {{glyphX0 + boldOffset,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1 + boldOffset,glyphY0,glyph.u1,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1 + boldOffset,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0 + boldOffset,glyphY0,glyph.u0,glyph.v1,r,g,b,br,bg,bb,colorGlyph},{glyphX1 + boldOffset,glyphY1,glyph.u1,glyph.v0,r,g,b,br,bg,bb,colorGlyph},{glyphX0 + boldOffset,glyphY1,glyph.u0,glyph.v0,r,g,b,br,bg,bb,colorGlyph}});
                }
                glyphCursorX += 2.0f * static_cast<float>(shapedGlyph.xAdvance) / static_cast<float>(width_);
            }
            }
        }
        if (cursorVisible && cursor.col >= 0 && cursor.row >= 0 && cursor.col < cols && cursor.row < rows) {
            int cursorCol = cursor.wideTail && cursor.col > 0 ? cursor.col - 1 : cursor.col;
            const auto& cursorCell = cells[cursor.row * cols + cursorCol];
            bool cursorWide = cursor.wideTail || cursorCell.wide == GHOSTTY_CELL_WIDE_WIDE;
            float x0 = -1.0f + cursorCol * cw;
            float y0 = 1.0f - (cursor.row + 1) * ch;
            float x1 = x0 + cw * (cursorWide ? 2.0f : 1.0f);
            float y1 = y0 + ch;
            GhosttyRenderStateCursorVisualStyle visualStyle = cursor.visualStyle;
            if (cursorMode_ == 1) visualStyle = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_UNDERLINE;
            if (cursorMode_ == 2) visualStyle = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BAR;
            if (visualStyle == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_UNDERLINE) {
                y1 = y0 + ch * 0.16f;
            } else if (visualStyle == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BAR) {
                x1 = x0 + cw * 0.16f;
            }
            uint32_t cursorColor = cursor.colorHasValue ? cursor.color : cursorColor_;
            float cr = ((cursorColor >> 16u) & 255u) / 255.0f;
            float cg = ((cursorColor >> 8u) & 255u) / 255.0f;
            float cb = (cursorColor & 255u) / 255.0f;
            float alpha = visualStyle == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK ? 0.55f : 0.9f;
            if (visualStyle == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK_HOLLOW) {
                float thicknessX = cw * 0.08f;
                float thicknessY = ch * 0.08f;
                addSolidQuad(solidVertices, x0, y0, x1, y0 + thicknessY, cr, cg, cb, 0.9f);
                addSolidQuad(solidVertices, x0, y1 - thicknessY, x1, y1, cr, cg, cb, 0.9f);
                addSolidQuad(solidVertices, x0, y0, x0 + thicknessX, y1, cr, cg, cb, 0.9f);
                addSolidQuad(solidVertices, x1 - thicknessX, y0, x1, y1, cr, cg, cb, 0.9f);
            } else {
                addSolidQuad(solidVertices, x0, y0, x1, y1, cr, cg, cb, alpha);
            }
        }
        cachedGlyphVertexCount_ = static_cast<GLsizei>(vertices.size());
        cachedSolidVertexCount_ = static_cast<GLsizei>(solidVertices.size());
    }
    glUseProgram(solidProgram_);
    glBindVertexArray(solidVao_);
    glBindBuffer(GL_ARRAY_BUFFER, solidVbo_);
    if (shouldUploadBuffers) {
        glBufferData(GL_ARRAY_BUFFER, solidVertices.size() * sizeof(SolidVertex), solidVertices.data(), GL_DYNAMIC_DRAW);
    }
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glDrawArrays(GL_TRIANGLES, 0, cachedSolidVertexCount_);
    glUseProgram(program_);
    glBindVertexArray(vao_);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, font_.texture());
    glBindBuffer(GL_ARRAY_BUFFER, vbo_);
    if (shouldUploadBuffers) {
        glBufferData(GL_ARRAY_BUFFER, vertices.size() * sizeof(Vertex), vertices.data(), GL_DYNAMIC_DRAW);
    }
    glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    glDrawArrays(GL_TRIANGLES, 0, cachedGlyphVertexCount_);
    static auto lastReport = std::chrono::steady_clock::now();
    static int frameCount = 0;
    frameCount++;
    auto elapsed = std::chrono::duration<double>(now - lastReport).count();
    if (elapsed >= 2.0) {
        __android_log_print(ANDROID_LOG_INFO, "CoderRenderer", "fps=%.1f target_hz=%.1f cols=%d rows=%d glyph_vertices=%d solid_vertices=%d", frameCount / elapsed, targetRefreshRate_, cols, rows, cachedGlyphVertexCount_, cachedSolidVertexCount_);
        frameCount = 0;
        lastReport = now;
    }
}

GLuint CoderRenderer::compile(GLenum type, const char* source) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);
    GLint compiled = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
    if (!compiled) {
        char log[1024]{};
        glGetShaderInfoLog(shader, sizeof(log), nullptr, log);
        __android_log_print(ANDROID_LOG_ERROR, "CoderRenderer", "shader compile failed: %s", log);
    }
    return shader;
}

GLuint CoderRenderer::linkProgram(const char* name, const char* vertexSource, const char* fragmentSource) {
    GLuint linkedProgram = glCreateProgram();
    if (loadProgramBinary(linkedProgram, name, vertexSource, fragmentSource)) return linkedProgram;
    GLuint vertexShader = compile(GL_VERTEX_SHADER, vertexSource);
    GLuint fragmentShader = compile(GL_FRAGMENT_SHADER, fragmentSource);
    glProgramParameteri(linkedProgram, GL_PROGRAM_BINARY_RETRIEVABLE_HINT, GL_TRUE);
    glAttachShader(linkedProgram, vertexShader);
    glAttachShader(linkedProgram, fragmentShader);
    glLinkProgram(linkedProgram);
    GLint linked = 0;
    glGetProgramiv(linkedProgram, GL_LINK_STATUS, &linked);
    if (linked) saveProgramBinary(linkedProgram, name, vertexSource, fragmentSource);
    glDeleteShader(vertexShader);
    glDeleteShader(fragmentShader);
    return linkedProgram;
}

bool CoderRenderer::loadProgramBinary(GLuint program, const char* name, const char* vertexSource, const char* fragmentSource) {
    GLint formatCount = 0;
    glGetIntegerv(GL_NUM_PROGRAM_BINARY_FORMATS, &formatCount);
    if (formatCount <= 0 || shaderCacheDir_.empty()) return false;
    std::ifstream input(shaderCachePath(name, vertexSource, fragmentSource), std::ios::binary);
    if (!input) {
        __android_log_print(ANDROID_LOG_INFO, "CoderRenderer", "shader_cache_miss name=%s", name);
        return false;
    }
    GLenum format = 0;
    uint32_t size = 0;
    input.read(reinterpret_cast<char*>(&format), sizeof(format));
    input.read(reinterpret_cast<char*>(&size), sizeof(size));
    if (!input || size == 0 || size > 8 * 1024 * 1024) return false;
    std::vector<uint8_t> binary(size);
    input.read(reinterpret_cast<char*>(binary.data()), static_cast<std::streamsize>(binary.size()));
    if (!input) return false;
    glProgramBinary(program, format, binary.data(), static_cast<GLsizei>(binary.size()));
    GLint linked = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &linked);
    __android_log_print(ANDROID_LOG_INFO, "CoderRenderer", "shader_cache_%s name=%s bytes=%u", linked == GL_TRUE ? "hit" : "invalid", name, size);
    return linked == GL_TRUE;
}

void CoderRenderer::saveProgramBinary(GLuint program, const char* name, const char* vertexSource, const char* fragmentSource) {
    GLint formatCount = 0;
    glGetIntegerv(GL_NUM_PROGRAM_BINARY_FORMATS, &formatCount);
    if (formatCount <= 0 || shaderCacheDir_.empty()) return;
    GLint binaryLength = 0;
    glGetProgramiv(program, GL_PROGRAM_BINARY_LENGTH, &binaryLength);
    if (binaryLength <= 0) return;
    std::vector<uint8_t> binary(static_cast<size_t>(binaryLength));
    GLenum format = 0;
    GLsizei written = 0;
    glGetProgramBinary(program, binaryLength, &written, &format, binary.data());
    if (written <= 0) return;
    uint32_t size = static_cast<uint32_t>(written);
    std::ofstream output(shaderCachePath(name, vertexSource, fragmentSource), std::ios::binary | std::ios::trunc);
    if (!output) return;
    output.write(reinterpret_cast<const char*>(&format), sizeof(format));
    output.write(reinterpret_cast<const char*>(&size), sizeof(size));
    output.write(reinterpret_cast<const char*>(binary.data()), written);
    __android_log_print(ANDROID_LOG_INFO, "CoderRenderer", "shader_cache_save name=%s bytes=%u", name, size);
}

std::string CoderRenderer::shaderCachePath(const char* name, const char* vertexSource, const char* fragmentSource) const {
    uint64_t hash = 1469598103934665603ULL;
    auto update = [&](const char* value) {
        for (const unsigned char* cursor = reinterpret_cast<const unsigned char*>(value); *cursor != 0; cursor++) {
            hash ^= *cursor;
            hash *= 1099511628211ULL;
        }
    };
    update(name);
    const char* vendor = reinterpret_cast<const char*>(glGetString(GL_VENDOR));
    const char* renderer = reinterpret_cast<const char*>(glGetString(GL_RENDERER));
    const char* version = reinterpret_cast<const char*>(glGetString(GL_VERSION));
    update(vendor ? vendor : "");
    update(renderer ? renderer : "");
    update(version ? version : "");
    update(vertexSource);
    update(fragmentSource);
    return shaderCacheDir_ + "/" + name + "-" + std::to_string(hash) + ".bin";
}
