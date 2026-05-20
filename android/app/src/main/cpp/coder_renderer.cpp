#include "coder_renderer.h"
#include "coder_shaders.h"

#include <android/log.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <utility>
#include <vector>

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

static bool isConstrainedSymbolCodepoint(uint32_t codepoint) {
    return (codepoint >= 0x2500 && codepoint <= 0x259f) ||
        (codepoint >= 0x25a0 && codepoint <= 0x25ff) ||
        (codepoint >= 0xe0a0 && codepoint <= 0xe0d7) ||
        (codepoint >= 0xe200 && codepoint <= 0xe2a9) ||
        (codepoint >= 0xe5fa && codepoint <= 0xe6b7) ||
        (codepoint >= 0xea60 && codepoint <= 0xebeb) ||
        (codepoint >= 0xed00 && codepoint <= 0xf2ff) ||
        (codepoint >= 0xf000 && codepoint <= 0xf8ff);
}

static bool isBoxDrawingCodepoint(uint32_t codepoint) {
    return codepoint >= 0x2500 && codepoint <= 0x257f;
}

enum class BoxLineStyle : uint8_t { none, light, heavy, doubleLine };
enum class BoxDrawingKind : uint8_t { lines, dashHorizontal, dashVertical, diagonalUp, diagonalDown, diagonalCross };

struct BoxDrawingGlyph {
    BoxLineStyle up = BoxLineStyle::none;
    BoxLineStyle right = BoxLineStyle::none;
    BoxLineStyle down = BoxLineStyle::none;
    BoxLineStyle left = BoxLineStyle::none;
    BoxDrawingKind kind = BoxDrawingKind::lines;
    uint8_t dashCount = 0;
    bool supported = false;
};

static BoxDrawingGlyph boxGlyph(BoxLineStyle up = BoxLineStyle::none, BoxLineStyle right = BoxLineStyle::none, BoxLineStyle down = BoxLineStyle::none, BoxLineStyle left = BoxLineStyle::none) {
    return BoxDrawingGlyph{up, right, down, left, BoxDrawingKind::lines, 0, true};
}

static BoxDrawingGlyph boxDashed(BoxDrawingKind kind, uint8_t count, BoxLineStyle style) {
    BoxDrawingGlyph glyph{};
    glyph.kind = kind;
    glyph.dashCount = count;
    glyph.supported = true;
    if (kind == BoxDrawingKind::dashHorizontal) {
        glyph.left = style;
        glyph.right = style;
    } else {
        glyph.up = style;
        glyph.down = style;
    }
    return glyph;
}

static BoxDrawingGlyph boxDiagonal(BoxDrawingKind kind) {
    BoxDrawingGlyph glyph{};
    glyph.kind = kind;
    glyph.supported = true;
    return glyph;
}

static BoxDrawingGlyph boxDrawingGlyph(uint32_t codepoint) {
    using S = BoxLineStyle;
    switch (codepoint) {
        case 0x2500: return boxGlyph(S::none, S::light, S::none, S::light);
        case 0x2501: return boxGlyph(S::none, S::heavy, S::none, S::heavy);
        case 0x2502: return boxGlyph(S::light, S::none, S::light, S::none);
        case 0x2503: return boxGlyph(S::heavy, S::none, S::heavy, S::none);
        case 0x2504: return boxDashed(BoxDrawingKind::dashHorizontal, 3, S::light);
        case 0x2505: return boxDashed(BoxDrawingKind::dashHorizontal, 3, S::heavy);
        case 0x2506: return boxDashed(BoxDrawingKind::dashVertical, 3, S::light);
        case 0x2507: return boxDashed(BoxDrawingKind::dashVertical, 3, S::heavy);
        case 0x2508: return boxDashed(BoxDrawingKind::dashHorizontal, 4, S::light);
        case 0x2509: return boxDashed(BoxDrawingKind::dashHorizontal, 4, S::heavy);
        case 0x250a: return boxDashed(BoxDrawingKind::dashVertical, 4, S::light);
        case 0x250b: return boxDashed(BoxDrawingKind::dashVertical, 4, S::heavy);
        case 0x250c: return boxGlyph(S::none, S::light, S::light, S::none);
        case 0x250d: return boxGlyph(S::none, S::heavy, S::light, S::none);
        case 0x250e: return boxGlyph(S::none, S::light, S::heavy, S::none);
        case 0x250f: return boxGlyph(S::none, S::heavy, S::heavy, S::none);
        case 0x2510: return boxGlyph(S::none, S::none, S::light, S::light);
        case 0x2511: return boxGlyph(S::none, S::none, S::light, S::heavy);
        case 0x2512: return boxGlyph(S::none, S::none, S::heavy, S::light);
        case 0x2513: return boxGlyph(S::none, S::none, S::heavy, S::heavy);
        case 0x2514: return boxGlyph(S::light, S::light, S::none, S::none);
        case 0x2515: return boxGlyph(S::light, S::heavy, S::none, S::none);
        case 0x2516: return boxGlyph(S::heavy, S::light, S::none, S::none);
        case 0x2517: return boxGlyph(S::heavy, S::heavy, S::none, S::none);
        case 0x2518: return boxGlyph(S::light, S::none, S::none, S::light);
        case 0x2519: return boxGlyph(S::light, S::none, S::none, S::heavy);
        case 0x251a: return boxGlyph(S::heavy, S::none, S::none, S::light);
        case 0x251b: return boxGlyph(S::heavy, S::none, S::none, S::heavy);
        case 0x251c: return boxGlyph(S::light, S::light, S::light, S::none);
        case 0x251d: return boxGlyph(S::light, S::heavy, S::light, S::none);
        case 0x251e: return boxGlyph(S::heavy, S::light, S::light, S::none);
        case 0x251f: return boxGlyph(S::light, S::light, S::heavy, S::none);
        case 0x2520: return boxGlyph(S::heavy, S::light, S::heavy, S::none);
        case 0x2521: return boxGlyph(S::heavy, S::heavy, S::light, S::none);
        case 0x2522: return boxGlyph(S::light, S::heavy, S::heavy, S::none);
        case 0x2523: return boxGlyph(S::heavy, S::heavy, S::heavy, S::none);
        case 0x2524: return boxGlyph(S::light, S::none, S::light, S::light);
        case 0x2525: return boxGlyph(S::light, S::none, S::light, S::heavy);
        case 0x2526: return boxGlyph(S::heavy, S::none, S::light, S::light);
        case 0x2527: return boxGlyph(S::light, S::none, S::heavy, S::light);
        case 0x2528: return boxGlyph(S::heavy, S::none, S::heavy, S::light);
        case 0x2529: return boxGlyph(S::heavy, S::none, S::light, S::heavy);
        case 0x252a: return boxGlyph(S::light, S::none, S::heavy, S::heavy);
        case 0x252b: return boxGlyph(S::heavy, S::none, S::heavy, S::heavy);
        case 0x252c: return boxGlyph(S::none, S::light, S::light, S::light);
        case 0x252d: return boxGlyph(S::none, S::light, S::light, S::heavy);
        case 0x252e: return boxGlyph(S::none, S::heavy, S::light, S::light);
        case 0x252f: return boxGlyph(S::none, S::heavy, S::light, S::heavy);
        case 0x2530: return boxGlyph(S::none, S::light, S::heavy, S::light);
        case 0x2531: return boxGlyph(S::none, S::light, S::heavy, S::heavy);
        case 0x2532: return boxGlyph(S::none, S::heavy, S::heavy, S::light);
        case 0x2533: return boxGlyph(S::none, S::heavy, S::heavy, S::heavy);
        case 0x2534: return boxGlyph(S::light, S::light, S::none, S::light);
        case 0x2535: return boxGlyph(S::light, S::light, S::none, S::heavy);
        case 0x2536: return boxGlyph(S::light, S::heavy, S::none, S::light);
        case 0x2537: return boxGlyph(S::light, S::heavy, S::none, S::heavy);
        case 0x2538: return boxGlyph(S::heavy, S::light, S::none, S::light);
        case 0x2539: return boxGlyph(S::heavy, S::light, S::none, S::heavy);
        case 0x253a: return boxGlyph(S::heavy, S::heavy, S::none, S::light);
        case 0x253b: return boxGlyph(S::heavy, S::heavy, S::none, S::heavy);
        case 0x253c: return boxGlyph(S::light, S::light, S::light, S::light);
        case 0x253d: return boxGlyph(S::light, S::light, S::light, S::heavy);
        case 0x253e: return boxGlyph(S::light, S::heavy, S::light, S::light);
        case 0x253f: return boxGlyph(S::light, S::heavy, S::light, S::heavy);
        case 0x2540: return boxGlyph(S::heavy, S::light, S::light, S::light);
        case 0x2541: return boxGlyph(S::light, S::light, S::heavy, S::light);
        case 0x2542: return boxGlyph(S::heavy, S::light, S::heavy, S::light);
        case 0x2543: return boxGlyph(S::heavy, S::light, S::light, S::heavy);
        case 0x2544: return boxGlyph(S::heavy, S::heavy, S::light, S::light);
        case 0x2545: return boxGlyph(S::light, S::light, S::heavy, S::heavy);
        case 0x2546: return boxGlyph(S::light, S::heavy, S::heavy, S::light);
        case 0x2547: return boxGlyph(S::heavy, S::heavy, S::light, S::heavy);
        case 0x2548: return boxGlyph(S::light, S::heavy, S::heavy, S::heavy);
        case 0x2549: return boxGlyph(S::heavy, S::light, S::heavy, S::heavy);
        case 0x254a: return boxGlyph(S::heavy, S::heavy, S::heavy, S::light);
        case 0x254b: return boxGlyph(S::heavy, S::heavy, S::heavy, S::heavy);
        case 0x254c: return boxDashed(BoxDrawingKind::dashHorizontal, 2, S::light);
        case 0x254d: return boxDashed(BoxDrawingKind::dashHorizontal, 2, S::heavy);
        case 0x254e: return boxDashed(BoxDrawingKind::dashVertical, 2, S::light);
        case 0x254f: return boxDashed(BoxDrawingKind::dashVertical, 2, S::heavy);
        case 0x2550: return boxGlyph(S::none, S::doubleLine, S::none, S::doubleLine);
        case 0x2551: return boxGlyph(S::doubleLine, S::none, S::doubleLine, S::none);
        case 0x2552: return boxGlyph(S::none, S::doubleLine, S::light, S::none);
        case 0x2553: return boxGlyph(S::none, S::light, S::doubleLine, S::none);
        case 0x2554: return boxGlyph(S::none, S::doubleLine, S::doubleLine, S::none);
        case 0x2555: return boxGlyph(S::none, S::none, S::light, S::doubleLine);
        case 0x2556: return boxGlyph(S::none, S::none, S::doubleLine, S::light);
        case 0x2557: return boxGlyph(S::none, S::none, S::doubleLine, S::doubleLine);
        case 0x2558: return boxGlyph(S::light, S::doubleLine, S::none, S::none);
        case 0x2559: return boxGlyph(S::doubleLine, S::light, S::none, S::none);
        case 0x255a: return boxGlyph(S::doubleLine, S::doubleLine, S::none, S::none);
        case 0x255b: return boxGlyph(S::light, S::none, S::none, S::doubleLine);
        case 0x255c: return boxGlyph(S::doubleLine, S::none, S::none, S::light);
        case 0x255d: return boxGlyph(S::doubleLine, S::none, S::none, S::doubleLine);
        case 0x255e: return boxGlyph(S::light, S::doubleLine, S::light, S::none);
        case 0x255f: return boxGlyph(S::doubleLine, S::light, S::doubleLine, S::none);
        case 0x2560: return boxGlyph(S::doubleLine, S::doubleLine, S::doubleLine, S::none);
        case 0x2561: return boxGlyph(S::light, S::none, S::light, S::doubleLine);
        case 0x2562: return boxGlyph(S::doubleLine, S::none, S::doubleLine, S::light);
        case 0x2563: return boxGlyph(S::doubleLine, S::none, S::doubleLine, S::doubleLine);
        case 0x2564: return boxGlyph(S::none, S::doubleLine, S::light, S::doubleLine);
        case 0x2565: return boxGlyph(S::none, S::light, S::doubleLine, S::light);
        case 0x2566: return boxGlyph(S::none, S::doubleLine, S::doubleLine, S::doubleLine);
        case 0x2567: return boxGlyph(S::light, S::doubleLine, S::none, S::doubleLine);
        case 0x2568: return boxGlyph(S::doubleLine, S::light, S::none, S::light);
        case 0x2569: return boxGlyph(S::doubleLine, S::doubleLine, S::none, S::doubleLine);
        case 0x256a: return boxGlyph(S::light, S::doubleLine, S::light, S::doubleLine);
        case 0x256b: return boxGlyph(S::doubleLine, S::light, S::doubleLine, S::light);
        case 0x256c: return boxGlyph(S::doubleLine, S::doubleLine, S::doubleLine, S::doubleLine);
        case 0x2571: return boxDiagonal(BoxDrawingKind::diagonalUp);
        case 0x2572: return boxDiagonal(BoxDrawingKind::diagonalDown);
        case 0x2573: return boxDiagonal(BoxDrawingKind::diagonalCross);
        case 0x2574: return boxGlyph(S::none, S::none, S::none, S::light);
        case 0x2575: return boxGlyph(S::light, S::none, S::none, S::none);
        case 0x2576: return boxGlyph(S::none, S::light, S::none, S::none);
        case 0x2577: return boxGlyph(S::none, S::none, S::light, S::none);
        case 0x2578: return boxGlyph(S::none, S::none, S::none, S::heavy);
        case 0x2579: return boxGlyph(S::heavy, S::none, S::none, S::none);
        case 0x257a: return boxGlyph(S::none, S::heavy, S::none, S::none);
        case 0x257b: return boxGlyph(S::none, S::none, S::heavy, S::none);
        case 0x257c: return boxGlyph(S::none, S::heavy, S::none, S::light);
        case 0x257d: return boxGlyph(S::light, S::none, S::heavy, S::none);
        case 0x257e: return boxGlyph(S::none, S::light, S::none, S::heavy);
        case 0x257f: return boxGlyph(S::heavy, S::none, S::light, S::none);
        default: return {};
    }
}

static bool isConstrainedSymbolCell(const CoderCell& cell) {
    if (cell.codepointCount == 0) return false;
    for (uint32_t index = 0; index < cell.codepointCount; index++) {
        if (isConstrainedSymbolCodepoint(cell.codepoints[index])) return true;
    }
    return false;
}

static bool isSymbolSpanNeighborCell(const CoderCell& cell, uint32_t background) {
    return cell.background == background && (cell.codepointCount == 0 || cell.codepoints[0] == ' ' || cell.wide == GHOSTTY_CELL_WIDE_SPACER_HEAD || cell.wide == GHOSTTY_CELL_WIDE_SPACER_TAIL);
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

static bool isComplexShapingCell(const CoderCell& cell) {
    if (cell.wide != GHOSTTY_CELL_WIDE_NARROW && cell.wide != GHOSTTY_CELL_WIDE_WIDE) return false;
    if (cell.codepointCount == 0 || isConstrainedSymbolCell(cell)) return false;
    if (cell.codepointCount > 1) return true;
    uint32_t codepoint = cell.codepoints[0];
    return codepoint >= 0x80 || isZeroWidthCodepoint(codepoint);
}

static bool isComplexRunCell(const CoderCell& cell) {
    return isComplexShapingCell(cell) || (cell.wide == GHOSTTY_CELL_WIDE_NARROW && cell.codepointCount == 1 && cell.codepoints[0] == ' ');
}

static void addSolidQuad(std::vector<SolidVertex>& vertices, float x0, float y0, float x1, float y1, float r, float g, float b, float a) {
    vertices.insert(vertices.end(), {{x0,y0,r,g,b,a},{x1,y0,r,g,b,a},{x1,y1,r,g,b,a},{x0,y0,r,g,b,a},{x1,y1,r,g,b,a},{x0,y1,r,g,b,a}});
}

static void addSolidLine(std::vector<SolidVertex>& vertices, float x0, float y0, float x1, float y1, float thicknessPixels, int width, int height, float r, float g, float b, float a) {
    float dx = x1 - x0;
    float dy = y1 - y0;
    float length = std::sqrt(dx * dx + dy * dy);
    if (length <= 0.0f) return;
    float pixelX = 2.0f / static_cast<float>(std::max(1, width));
    float pixelY = 2.0f / static_cast<float>(std::max(1, height));
    float nx = -dy / length * thicknessPixels * pixelX * 0.5f;
    float ny = dx / length * thicknessPixels * pixelY * 0.5f;
    SolidVertex a0{x0 + nx, y0 + ny, r, g, b, a};
    SolidVertex a1{x1 + nx, y1 + ny, r, g, b, a};
    SolidVertex a2{x1 - nx, y1 - ny, r, g, b, a};
    SolidVertex a3{x0 - nx, y0 - ny, r, g, b, a};
    vertices.insert(vertices.end(), {a0, a1, a2, a0, a2, a3});
}

static uint8_t colorByte(float value) {
    return static_cast<uint8_t>(std::clamp(value, 0.0f, 1.0f) * 255.0f + 0.5f);
}

static void addGlyphQuad(std::vector<Vertex>& vertices, float x0, float y0, float x1, float y1, const CoderFont::Glyph& glyph, float r, float g, float b, float alpha, float br, float bg, float bb, float colorGlyph) {
    const uint8_t red = colorByte(r);
    const uint8_t green = colorByte(g);
    const uint8_t blue = colorByte(b);
    const uint8_t foregroundAlpha = colorByte(alpha);
    const uint8_t backgroundRed = colorByte(br);
    const uint8_t backgroundGreen = colorByte(bg);
    const uint8_t backgroundBlue = colorByte(bb);
    const uint8_t colorGlyphFlag = colorByte(colorGlyph);
    vertices.insert(vertices.end(), {{x0,y0,glyph.u0,glyph.v1,red,green,blue,foregroundAlpha,backgroundRed,backgroundGreen,backgroundBlue,colorGlyphFlag},{x1,y0,glyph.u1,glyph.v1,red,green,blue,foregroundAlpha,backgroundRed,backgroundGreen,backgroundBlue,colorGlyphFlag},{x1,y1,glyph.u1,glyph.v0,red,green,blue,foregroundAlpha,backgroundRed,backgroundGreen,backgroundBlue,colorGlyphFlag},{x0,y0,glyph.u0,glyph.v1,red,green,blue,foregroundAlpha,backgroundRed,backgroundGreen,backgroundBlue,colorGlyphFlag},{x1,y1,glyph.u1,glyph.v0,red,green,blue,foregroundAlpha,backgroundRed,backgroundGreen,backgroundBlue,colorGlyphFlag},{x0,y1,glyph.u0,glyph.v0,red,green,blue,foregroundAlpha,backgroundRed,backgroundGreen,backgroundBlue,colorGlyphFlag}});
}

CoderRenderer::CoderRenderer() = default;

CoderRenderer::~CoderRenderer() {
    releaseGlResources();
}

void CoderRenderer::releaseGlResources() {
    if (!rowGlyphVbos_.empty()) glDeleteBuffers(static_cast<GLsizei>(rowGlyphVbos_.size()), rowGlyphVbos_.data());
    if (!rowSolidVbos_.empty()) glDeleteBuffers(static_cast<GLsizei>(rowSolidVbos_.size()), rowSolidVbos_.data());
    if (vao_ != 0) glDeleteVertexArrays(1, &vao_);
    if (solidVao_ != 0) glDeleteVertexArrays(1, &solidVao_);
    if (program_ != 0) glDeleteProgram(program_);
    if (solidProgram_ != 0) glDeleteProgram(solidProgram_);
    rowGlyphVbos_.clear();
    rowSolidVbos_.clear();
    rowGlyphVertexCounts_.clear();
    rowSolidVertexCounts_.clear();
    vao_ = 0;
    solidVao_ = 0;
    program_ = 0;
    solidProgram_ = 0;
    hasPresentedFrame_ = false;
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
    glGenVertexArrays(1, &solidVao_);
    glBindVertexArray(vao_);
    glEnableVertexAttribArray(0);
    glEnableVertexAttribArray(1);
    glEnableVertexAttribArray(2);
    glEnableVertexAttribArray(3);
    glBindVertexArray(solidVao_);
    glEnableVertexAttribArray(0);
    glEnableVertexAttribArray(1);
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

void CoderRenderer::setTextOptions(bool ligatures, bool contextualAlternates, bool slashedZero, bool stylisticSet1, bool stylisticSet2, bool characterVariant1, bool boldFontStyle, bool cursorBlink, int cursorMode) {
    font_.setOpenTypeFeatures(ligatures, contextualAlternates, slashedZero, stylisticSet1, stylisticSet2, characterVariant1);
    font_.setBoldStyleEnabled(boldFontStyle);
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

void CoderRenderer::setCellSize(int width, int height, int fontPixelSize) {
    font_.setCellSize(width, height, fontPixelSize);
    cachedCells_.clear();
}

int CoderRenderer::cellWidth() const {
    return font_.glyphWidth();
}

int CoderRenderer::cellHeight() const {
    return font_.glyphHeight();
}

bool CoderRenderer::updateCachedCells(int cols, int rows, const CoderCursor& cursor, bool cellsChanged) {
    const bool dimensionsChanged = cachedCols_ != cols || cachedRows_ != rows || cachedCells_.size() != static_cast<size_t>(std::max(cols, 0) * std::max(rows, 0));
    if (dimensionsChanged || !cellsChanged || dirtyRows_.size() != static_cast<size_t>(std::max(rows, 0))) dirtyRows_.assign(static_cast<size_t>(std::max(rows, 0)), dimensionsChanged ? 1 : 0);
    bool changed = dimensionsChanged || cachedCursorCol_ != cursor.col || cachedCursorRow_ != cursor.row || cachedCursorBlinking_ != cursor.blinking || cachedCursorColorHasValue_ != cursor.colorHasValue || cachedCursorColor_ != cursor.color || cachedCursorVisualStyle_ != cursor.visualStyle;
    if (!dimensionsChanged && cellsChanged) {
        for (int row = 0; row < rows; row++) if (dirtyRows_[static_cast<size_t>(row)] != 0) changed = true;
        if (cachedCursorRow_ >= 0 && cachedCursorRow_ < rows) dirtyRows_[static_cast<size_t>(cachedCursorRow_)] = 1;
        if (cursor.row >= 0 && cursor.row < rows) dirtyRows_[static_cast<size_t>(cursor.row)] = 1;
    }
    if (!cellsChanged && !dimensionsChanged) {
        if (cachedCursorRow_ >= 0 && cachedCursorRow_ < rows) dirtyRows_[static_cast<size_t>(cachedCursorRow_)] = 1;
        if (cursor.row >= 0 && cursor.row < rows) dirtyRows_[static_cast<size_t>(cursor.row)] = 1;
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
    return true;
}

void CoderRenderer::draw(CoderTerminal& terminal) {
    if (terminal.pumpAndSynchronizedOutput()) {
        if (!hasPresentedFrame_) {
            glClearColor(((clearColor_ >> 16u) & 255u) / 255.0f, ((clearColor_ >> 8u) & 255u) / 255.0f, (clearColor_ & 255u) / 255.0f, 1.0f);
            glClear(GL_COLOR_BUFFER_BIT);
            hasPresentedFrame_ = true;
        }
        return;
    }
    int cols, rows;
    CoderCursor cursor;
    const bool cellsChanged = terminal.snapshot(cols, rows, cursor, cachedCells_, cachedSnapshotGeneration_, &dirtyRows_);
    auto now = std::chrono::steady_clock::now();
    bool blinkPhase = (std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() / 550) % 2 == 0;
    bool cursorVisible = cursor.visible && (!cursor.blinking || !cursorBlink_ || (std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() / 550) % 2 == 0);
    bool hasBlinkingCells = false;
    for (const auto& cell : cachedCells_) {
        if ((cell.flags & 512u) != 0u) {
            hasBlinkingCells = true;
            break;
        }
    }
    const bool atlasChanged = cachedAtlasGeneration_ != font_.atlasGeneration();
    const bool blinkChanged = hasBlinkingCells && cachedBlinkPhase_ != blinkPhase;
    bool shouldUploadBuffers = updateCachedCells(cols, rows, cursor, cellsChanged) || cachedCursorVisible_ != cursorVisible || atlasChanged || blinkChanged;
    const auto& renderCells = cachedCells_;
    cachedCursorVisible_ = cursorVisible;
    cachedBlinkPhase_ = blinkPhase;
    glClearColor(((clearColor_ >> 16u) & 255u) / 255.0f, ((clearColor_ >> 8u) & 255u) / 255.0f, (clearColor_ & 255u) / 255.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    frameVertices_.clear();
    frameSolidVertices_.clear();
    float cw = 2.0f * font_.glyphWidth() / width_;
    float ch = 2.0f * font_.glyphHeight() / height_;
    auto snapX = [&](float x) { return -1.0f + std::round(((x + 1.0f) * 0.5f) * static_cast<float>(width_)) * 2.0f / static_cast<float>(width_); };
    auto snapY = [&](float y) { return -1.0f + std::round(((y + 1.0f) * 0.5f) * static_cast<float>(height_)) * 2.0f / static_cast<float>(height_); };
    if (shouldUploadBuffers) {
        int atlasRebuildAttempts = 0;
    rebuildFrameVertices:
        frameVertices_.clear();
        frameSolidVertices_.clear();
        frameVertices_.reserve(renderCells.size() * 6);
        frameSolidVertices_.reserve((renderCells.size() + 1) * 6);
        frameSkipText_.assign(renderCells.size(), 0);
        const uint64_t rowBuildAtlasGeneration = font_.atlasGeneration();
        const bool rebuildAllRows = rowGlyphVertices_.size() != static_cast<size_t>(rows) || rowSolidVertices_.size() != static_cast<size_t>(rows) || cachedAtlasGeneration_ != rowBuildAtlasGeneration || blinkChanged;
        if (rebuildAllRows) dirtyRows_.assign(static_cast<size_t>(std::max(rows, 0)), 1);
        if (rowGlyphVertices_.size() != static_cast<size_t>(rows)) rowGlyphVertices_.assign(static_cast<size_t>(rows), {});
        if (rowSolidVertices_.size() != static_cast<size_t>(rows)) rowSolidVertices_.assign(static_cast<size_t>(rows), {});
        for (int row = 0; row < rows; row++) {
            const bool rebuildRow = rebuildAllRows || dirtyRows_.empty() || dirtyRows_[static_cast<size_t>(row)] != 0;
            if (!rebuildRow) {
                frameVertices_.insert(frameVertices_.end(), rowGlyphVertices_[static_cast<size_t>(row)].begin(), rowGlyphVertices_[static_cast<size_t>(row)].end());
                frameSolidVertices_.insert(frameSolidVertices_.end(), rowSolidVertices_[static_cast<size_t>(row)].begin(), rowSolidVertices_[static_cast<size_t>(row)].end());
                continue;
            }
            const size_t rowGlyphStart = frameVertices_.size();
            const size_t rowSolidStart = frameSolidVertices_.size();
            int visualColumnShift = 0;
            for (int col = 0; col < cols; col++) {
                const auto& cell = renderCells[row * cols + col];
                float gridX0 = snapX(-1.0f + col * cw);
                float y0 = snapY(1.0f - (row + 1) * ch);
                float gridX1 = snapX(-1.0f + (col + 1) * cw);
                float y1 = snapY(1.0f - row * ch);
            float br = ((cell.background >> 0) & 255) / 255.0f;
            float bg = ((cell.background >> 8) & 255) / 255.0f;
            float bb = ((cell.background >> 16) & 255) / 255.0f;
            addSolidQuad(frameSolidVertices_, gridX0, y0, gridX1, y1, br, bg, bb, 1.0f);
            bool constrainedSymbolCell = isConstrainedSymbolCell(cell);
            int cellSpan = cell.wide == GHOSTTY_CELL_WIDE_WIDE ? 2 : 1;
            if (constrainedSymbolCell && cellSpan == 1 && col + 1 < cols && isSymbolSpanNeighborCell(renderCells[row * cols + col + 1], cell.background)) cellSpan = 2;
            float x0 = snapX(-1.0f + (col - visualColumnShift) * cw);
            float x1 = snapX(-1.0f + (col + cellSpan - visualColumnShift) * cw);
            float glyphCursorX = x0;
            auto glyphXBounds = [&](const CoderFont::Glyph& glyph, int xOffsetPixels) {
                float rawX0 = x0 + 2.0f * static_cast<float>(xOffsetPixels) / static_cast<float>(width_);
                float rawWidth = 2.0f * static_cast<float>(glyph.width) / static_cast<float>(width_);
                if (cell.wide == GHOSTTY_CELL_WIDE_WIDE || constrainedSymbolCell) {
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
            float textAlpha = (cell.flags & 256u) != 0u ? 0.50f : 1.0f;
            const bool blinkHidden = (cell.flags & 512u) != 0u && !blinkPhase;
            bool synthesizeBold = font_.shouldSynthesizeBold(cell.flags);
            auto addDecorationColor = [&](float y, float thickness, float decorationR, float decorationG, float decorationB) {
                float dy = thickness * ch;
                addSolidQuad(frameSolidVertices_, x0, y, x1, y + dy, decorationR, decorationG, decorationB, textAlpha);
            };
            auto addSegmentedDecorationColor = [&](float y, float thickness, float decorationR, float decorationG, float decorationB, int segments, bool alternating) {
                float dy = thickness * ch;
                float segmentWidth = (x1 - x0) / static_cast<float>(segments);
                for (int segment = 0; segment < segments; segment++) {
                    if (alternating && (segment % 2) != 0) continue;
                    float sx0 = x0 + static_cast<float>(segment) * segmentWidth;
                    float sx1 = sx0 + segmentWidth * (alternating ? 0.72f : 0.38f);
                    addSolidQuad(frameSolidVertices_, sx0, y, sx1, y + dy, decorationR, decorationG, decorationB, textAlpha);
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
            if (frameSkipText_[static_cast<size_t>(row * cols + col)] != 0) continue;
            if (cell.codepointCount == 1 && isBoxDrawingCodepoint(cell.codepoints[0])) {
                BoxDrawingGlyph boxGlyph = boxDrawingGlyph(cell.codepoints[0]);
                if (boxGlyph.supported) {
                    float pixelX = 2.0f / static_cast<float>(width_);
                    float pixelY = 2.0f / static_cast<float>(height_);
                    float centerX = snapX((gridX0 + gridX1) * 0.5f);
                    float centerY = snapY((y0 + y1) * 0.5f);
                    float lightThickness = std::max(1.0f, std::round(static_cast<float>(font_.glyphWidth()) * 0.07f));
                    float heavyThickness = std::max(2.0f, std::round(static_cast<float>(font_.glyphWidth()) * 0.14f));
                    float doubleOffsetX = lightThickness * pixelX;
                    float doubleOffsetY = lightThickness * pixelY;
                    auto drawHorizontalSegment = [&](float startX, float endX, BoxLineStyle style) {
                        if (style == BoxLineStyle::none) return;
                        float thickness = style == BoxLineStyle::heavy ? heavyThickness : lightThickness;
                        float halfThicknessY = thickness * pixelY * 0.5f;
                        if (style == BoxLineStyle::doubleLine) {
                            addSolidQuad(frameSolidVertices_, startX, centerY - doubleOffsetY - halfThicknessY, endX, centerY - doubleOffsetY + halfThicknessY, r, g, b, textAlpha);
                            addSolidQuad(frameSolidVertices_, startX, centerY + doubleOffsetY - halfThicknessY, endX, centerY + doubleOffsetY + halfThicknessY, r, g, b, textAlpha);
                            return;
                        }
                        addSolidQuad(frameSolidVertices_, startX, centerY - halfThicknessY, endX, centerY + halfThicknessY, r, g, b, textAlpha);
                    };
                    auto drawVerticalSegment = [&](float startY, float endY, BoxLineStyle style) {
                        if (style == BoxLineStyle::none) return;
                        float thickness = style == BoxLineStyle::heavy ? heavyThickness : lightThickness;
                        float halfThicknessX = thickness * pixelX * 0.5f;
                        if (style == BoxLineStyle::doubleLine) {
                            addSolidQuad(frameSolidVertices_, centerX - doubleOffsetX - halfThicknessX, startY, centerX - doubleOffsetX + halfThicknessX, endY, r, g, b, textAlpha);
                            addSolidQuad(frameSolidVertices_, centerX + doubleOffsetX - halfThicknessX, startY, centerX + doubleOffsetX + halfThicknessX, endY, r, g, b, textAlpha);
                            return;
                        }
                        addSolidQuad(frameSolidVertices_, centerX - halfThicknessX, startY, centerX + halfThicknessX, endY, r, g, b, textAlpha);
                    };
                    auto lineStyle = [&]() {
                        if (boxGlyph.up == BoxLineStyle::heavy || boxGlyph.right == BoxLineStyle::heavy || boxGlyph.down == BoxLineStyle::heavy || boxGlyph.left == BoxLineStyle::heavy) return BoxLineStyle::heavy;
                        return BoxLineStyle::light;
                    };
                    auto drawDashedHorizontal = [&](uint8_t count, BoxLineStyle style) {
                        int segments = std::max(2, static_cast<int>(count));
                        float desiredGap = style == BoxLineStyle::heavy ? heavyThickness : std::max(4.0f, lightThickness);
                        float gapWidth = std::min(desiredGap * pixelX, (gridX1 - gridX0) / static_cast<float>(segments * 2));
                        float totalDashWidth = (gridX1 - gridX0) - gapWidth * static_cast<float>(segments);
                        float dashWidth = totalDashWidth / static_cast<float>(segments);
                        float x = gridX0 + gapWidth * 0.5f;
                        for (int dash = 0; dash < segments; dash++) {
                            drawHorizontalSegment(x, x + dashWidth, style);
                            x += dashWidth + gapWidth;
                        }
                    };
                    auto drawDashedVertical = [&](uint8_t count, BoxLineStyle style) {
                        int segments = std::max(2, static_cast<int>(count));
                        float desiredGap = style == BoxLineStyle::heavy ? heavyThickness : std::max(4.0f, lightThickness);
                        float gapHeight = std::min(desiredGap * pixelY, (y1 - y0) / static_cast<float>(segments * 2));
                        float totalDashHeight = (y1 - y0) - gapHeight * static_cast<float>(segments);
                        float dashHeight = totalDashHeight / static_cast<float>(segments);
                        float y = y1 - dashHeight;
                        for (int dash = 0; dash < segments; dash++) {
                            drawVerticalSegment(y, y + dashHeight, style);
                            y -= dashHeight + gapHeight;
                        }
                    };
                    if (boxGlyph.kind == BoxDrawingKind::dashHorizontal) {
                        drawDashedHorizontal(boxGlyph.dashCount, lineStyle());
                        continue;
                    }
                    if (boxGlyph.kind == BoxDrawingKind::dashVertical) {
                        drawDashedVertical(boxGlyph.dashCount, lineStyle());
                        continue;
                    }
                    if (boxGlyph.kind == BoxDrawingKind::diagonalUp || boxGlyph.kind == BoxDrawingKind::diagonalCross) addSolidLine(frameSolidVertices_, gridX0 - pixelX * 0.5f, y0 - pixelY * 0.5f, gridX1 + pixelX * 0.5f, y1 + pixelY * 0.5f, lightThickness, width_, height_, r, g, b, textAlpha);
                    if (boxGlyph.kind == BoxDrawingKind::diagonalDown || boxGlyph.kind == BoxDrawingKind::diagonalCross) addSolidLine(frameSolidVertices_, gridX0 - pixelX * 0.5f, y1 + pixelY * 0.5f, gridX1 + pixelX * 0.5f, y0 - pixelY * 0.5f, lightThickness, width_, height_, r, g, b, textAlpha);
                    if (boxGlyph.kind == BoxDrawingKind::diagonalUp || boxGlyph.kind == BoxDrawingKind::diagonalDown || boxGlyph.kind == BoxDrawingKind::diagonalCross) continue;
                    float horizontalJoinPadding = heavyThickness * pixelX * 0.5f;
                    float verticalJoinPadding = heavyThickness * pixelY * 0.5f;
                    if (boxGlyph.left != BoxLineStyle::none && boxGlyph.right != BoxLineStyle::none && boxGlyph.left == boxGlyph.right) drawHorizontalSegment(gridX0, gridX1, boxGlyph.left);
                    else {
                        drawHorizontalSegment(gridX0, centerX + horizontalJoinPadding, boxGlyph.left);
                        drawHorizontalSegment(centerX - horizontalJoinPadding, gridX1, boxGlyph.right);
                    }
                    if (boxGlyph.up != BoxLineStyle::none && boxGlyph.down != BoxLineStyle::none && boxGlyph.up == boxGlyph.down) drawVerticalSegment(y0, y1, boxGlyph.up);
                    else {
                        drawVerticalSegment(centerY - verticalJoinPadding, y1, boxGlyph.up);
                        drawVerticalSegment(y0, centerY + verticalJoinPadding, boxGlyph.down);
                    }
                    continue;
                }
            }
            if (isNarrowPrintableAsciiCell(cell)) {
                int runEndCol = col + 1;
                while (runEndCol < cols) {
                    const auto& runCell = renderCells[row * cols + runEndCol];
                    if (!isNarrowPrintableAsciiCell(runCell)) break;
                    if (runCell.flags != cell.flags || runCell.foreground != cell.foreground) break;
                    if (row == cursor.row && cursor.col >= col && cursor.col <= runEndCol) break;
                    runEndCol++;
                }
                if (runEndCol - col > 1) {
                    std::array<uint32_t, 64> runCodepoints{};
                    uint32_t runCodepointCount = 0;
                    for (int runCol = col; runCol < runEndCol && runCodepointCount < runCodepoints.size(); runCol++) runCodepoints[runCodepointCount++] = renderCells[row * cols + runCol].codepoints[0];
                    auto runGlyphs = font_.shape(runCodepoints.data(), runCodepointCount, cell.flags, (runEndCol - col) * font_.glyphWidth());
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
                        for (int skippedCol = col + 1; skippedCol < runEndCol; skippedCol++) frameSkipText_[static_cast<size_t>(row * cols + skippedCol)] = 1;
                        for (const auto& shapedGlyph : runGlyphs) {
                            CoderFont::Glyph glyph;
                            bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                            if (!loaded || glyph.width <= 0 || glyph.height <= 0) continue;
                            auto glyphX = glyphXBounds(glyph, glyph.bearingLeft + shapedGlyph.xOffset + static_cast<int>(shapedGlyph.cellX) * font_.glyphWidth());
                            float glyphX0 = glyphX[0];
                            float glyphY1 = snapY(y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop - shapedGlyph.yOffset) / static_cast<float>(height_));
                            float glyphX1 = glyphX[1];
                            float glyphY0 = snapY(glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_));
                            float colorGlyph = glyph.color ? 1.0f : 0.0f;
                            addGlyphQuad(frameVertices_, glyphX0, glyphY0, glyphX1, glyphY1, glyph, r, g, b, textAlpha, br, bg, bb, colorGlyph);
                        }
                        continue;
                    }
                }
            }
            if (isComplexShapingCell(cell)) {
                int runEndCol = col + 1;
                while (runEndCol < cols) {
                    const auto& runCell = renderCells[row * cols + runEndCol];
                    if (!isComplexRunCell(runCell)) break;
                    if (runCell.flags != cell.flags || runCell.foreground != cell.foreground) break;
                    if (row == cursor.row && cursor.col >= col && cursor.col <= runEndCol) break;
                    runEndCol++;
                }
                while (runEndCol > col && renderCells[row * cols + runEndCol - 1].codepointCount == 1 && renderCells[row * cols + runEndCol - 1].codepoints[0] == ' ') runEndCol--;
                if (runEndCol - col > 0) {
                    std::array<uint32_t, 128> runCodepoints{};
                    std::array<uint32_t, 128> runClusters{};
                    uint32_t runCodepointCount = 0;
                    for (int runCol = col; runCol < runEndCol && runCodepointCount < runCodepoints.size(); runCol++) {
                        const auto& runCell = renderCells[row * cols + runCol];
                        for (uint32_t codepointIndex = 0; codepointIndex < runCell.codepointCount && runCodepointCount < runCodepoints.size(); codepointIndex++) {
                            runCodepoints[runCodepointCount] = runCell.codepoints[codepointIndex];
                            runClusters[runCodepointCount] = static_cast<uint32_t>(runCol - col);
                            runCodepointCount++;
                        }
                    }
                    auto runGlyphs = font_.shape(runCodepoints.data(), runClusters.data(), runCodepointCount, cell.flags, (runEndCol - col) * font_.glyphWidth());
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
                        for (int skippedCol = col + 1; skippedCol < runEndCol; skippedCol++) frameSkipText_[static_cast<size_t>(row * cols + skippedCol)] = 1;
                        for (const auto& shapedGlyph : runGlyphs) {
                            CoderFont::Glyph glyph;
                            bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                            if (!loaded || glyph.width <= 0 || glyph.height <= 0) continue;
                            auto glyphX = glyphXBounds(glyph, glyph.bearingLeft + shapedGlyph.xOffset + static_cast<int>(shapedGlyph.cellX) * font_.glyphWidth());
                            float glyphX0 = glyphX[0];
                            float glyphY1 = snapY(y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop - shapedGlyph.yOffset) / static_cast<float>(height_));
                            float glyphX1 = glyphX[1];
                            float glyphY0 = snapY(glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_));
                            float colorGlyph = glyph.color ? 1.0f : 0.0f;
                            addGlyphQuad(frameVertices_, glyphX0, glyphY0, glyphX1, glyphY1, glyph, r, g, b, textAlpha, br, bg, bb, colorGlyph);
                        }
                        continue;
                    }
                }
            }
            if (cell.codepointCount == 1 && isArabicCodepoint(cell.codepoints[0])) {
                int runEndCol = col + 1;
                while (runEndCol < cols) {
                    const auto& runCell = renderCells[row * cols + runEndCol];
                    if (!isArabicRunCell(runCell)) break;
                    if (runCell.flags != cell.flags || runCell.foreground != cell.foreground) break;
                    if (row == cursor.row && cursor.col >= col && cursor.col <= runEndCol) break;
                    runEndCol++;
                }
                while (runEndCol > col && renderCells[row * cols + runEndCol - 1].codepointCount == 1 && renderCells[row * cols + runEndCol - 1].codepoints[0] == ' ') runEndCol--;
                if (runEndCol - col > 1) {
                    std::array<uint32_t, 64> runCodepoints{};
                    uint32_t runCodepointCount = 0;
                    for (int runCol = col; runCol < runEndCol && runCodepointCount < runCodepoints.size(); runCol++) runCodepoints[runCodepointCount++] = renderCells[row * cols + runCol].codepoints[0];
                    auto runGlyphs = font_.shape(runCodepoints.data(), runCodepointCount, cell.flags, (runEndCol - col) * font_.glyphWidth());
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
                        for (int skippedCol = col + 1; skippedCol < runEndCol; skippedCol++) frameSkipText_[static_cast<size_t>(row * cols + skippedCol)] = 1;
                        for (const auto& shapedGlyph : runGlyphs) {
                            CoderFont::Glyph glyph;
                            bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                            if (!loaded || glyph.width <= 0 || glyph.height <= 0) continue;
                            auto glyphX = glyphXBounds(glyph, glyph.bearingLeft + shapedGlyph.xOffset + static_cast<int>(shapedGlyph.cellX) * font_.glyphWidth());
                            float glyphX0 = glyphX[0];
                            float glyphY1 = snapY(y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop - shapedGlyph.yOffset) / static_cast<float>(height_));
                            float glyphX1 = glyphX[1];
                            float glyphY0 = snapY(glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_));
                            float colorGlyph = glyph.color ? 1.0f : 0.0f;
                            addGlyphQuad(frameVertices_, glyphX0, glyphY0, glyphX1, glyphY1, glyph, r, g, b, textAlpha, br, bg, bb, colorGlyph);
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
                while (nextCol < cols && (renderCells[row * cols + nextCol].codepointCount == 0 || renderCells[row * cols + nextCol].wide == GHOSTTY_CELL_WIDE_SPACER_HEAD || renderCells[row * cols + nextCol].wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) && nextCol <= clusterEndCol + 2) nextCol++;
                if (nextCol >= cols) break;
                const auto& nextCell = renderCells[row * cols + nextCol];
                if (nextCell.codepointCount == 0) break;
                if (clusterCodepoints[clusterCodepointCount - 1] != 0x200d && !isEmojiClusterContinuation(nextCell)) break;
                clusterEndCol = nextCol;
                appendCellCodepoints(nextCell);
            }
            if (clusterHasEmoji && clusterEndCol > col && clusterCodepointCount > cell.codepointCount) {
                int clusterCellSpan = clusterEndCol - col + 1;
                int collapsedCellSpan = clusterHasEmoji ? 2 : clusterCellSpan;
                auto clusterGlyphs = font_.shape(clusterCodepoints.data(), clusterCodepointCount, cell.flags, collapsedCellSpan * font_.glyphWidth());
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
                    for (int skippedCol = col + 1; skippedCol <= clusterEndCol; skippedCol++) frameSkipText_[static_cast<size_t>(row * cols + skippedCol)] = 1;
                    for (const auto& shapedGlyph : clusterGlyphs) {
                        CoderFont::Glyph glyph;
                        bool loaded = shapedGlyph.fallbackIndex != UINT32_MAX ? font_.fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph) : font_.primaryGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.primaryIndex, glyph);
                        if (!loaded || glyph.width <= 0 || glyph.height <= 0) continue;
                        auto glyphX = glyphXBounds(glyph, glyph.bearingLeft + shapedGlyph.xOffset + static_cast<int>(shapedGlyph.cellX) * font_.glyphWidth());
                        float glyphX0 = glyphX[0];
                        float glyphY1 = snapY(y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop - shapedGlyph.yOffset) / static_cast<float>(height_));
                        float glyphX1 = glyphX[1];
                        float glyphY0 = snapY(glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_));
                        float colorGlyph = glyph.color ? 1.0f : 0.0f;
                        addGlyphQuad(frameVertices_, glyphX0, glyphY0, glyphX1, glyphY1, glyph, r, g, b, textAlpha, br, bg, bb, colorGlyph);
                    }
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
                    addGlyphQuad(frameVertices_, glyphX0, glyphY0, glyphX1, glyphY1, glyph, r, g, b, textAlpha, br, bg, bb, colorGlyph);
                    glyphCursorX += 2.0f * static_cast<float>(glyph.advance) / static_cast<float>(width_);
                }
            };
            auto shapedGlyphs = font_.shape(cell.codepoints.data(), cell.codepointCount, cell.flags, cellSpan * font_.glyphWidth());
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
                auto glyphX = glyphXBounds(glyph, glyph.bearingLeft + shapedGlyph.xOffset + static_cast<int>(shapedGlyph.cellX) * font_.glyphWidth());
                float glyphX0 = glyphX[0];
                float glyphY1 = snapY(y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop - shapedGlyph.yOffset) / static_cast<float>(height_));
                float glyphX1 = glyphX[1];
                float glyphY0 = snapY(glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_));
                float colorGlyph = glyph.color ? 1.0f : 0.0f;
                addGlyphQuad(frameVertices_, glyphX0, glyphY0, glyphX1, glyphY1, glyph, r, g, b, textAlpha, br, bg, bb, colorGlyph);
                if (synthesizeBold && !glyph.color) {
                    float boldOffset = 2.0f / static_cast<float>(width_);
                    addGlyphQuad(frameVertices_, glyphX0 + boldOffset, glyphY0, glyphX1 + boldOffset, glyphY1, glyph, r, g, b, textAlpha, br, bg, bb, colorGlyph);
                }
            }
            }
            rowGlyphVertices_[static_cast<size_t>(row)].assign(frameVertices_.begin() + static_cast<std::ptrdiff_t>(rowGlyphStart), frameVertices_.end());
            rowSolidVertices_[static_cast<size_t>(row)].assign(frameSolidVertices_.begin() + static_cast<std::ptrdiff_t>(rowSolidStart), frameSolidVertices_.end());
        }
        if (font_.atlasGeneration() != rowBuildAtlasGeneration) {
            rowGlyphVertices_.assign(static_cast<size_t>(rows), {});
            rowSolidVertices_.assign(static_cast<size_t>(rows), {});
            if (atlasRebuildAttempts++ < 2) goto rebuildFrameVertices;
            cachedAtlasGeneration_ = 0;
            shouldUploadBuffers = false;
            goto drawCachedBuffers;
        }
        if (cursorVisible && cursor.col >= 0 && cursor.row >= 0 && cursor.col < cols && cursor.row < rows) {
            const size_t cursorSolidStart = frameSolidVertices_.size();
            int cursorCol = cursor.wideTail && cursor.col > 0 ? cursor.col - 1 : cursor.col;
            const auto& cursorCell = renderCells[cursor.row * cols + cursorCol];
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
                addSolidQuad(frameSolidVertices_, x0, y0, x1, y0 + thicknessY, cr, cg, cb, 0.9f);
                addSolidQuad(frameSolidVertices_, x0, y1 - thicknessY, x1, y1, cr, cg, cb, 0.9f);
                addSolidQuad(frameSolidVertices_, x0, y0, x0 + thicknessX, y1, cr, cg, cb, 0.9f);
                addSolidQuad(frameSolidVertices_, x1 - thicknessX, y0, x1, y1, cr, cg, cb, 0.9f);
            } else {
                addSolidQuad(frameSolidVertices_, x0, y0, x1, y1, cr, cg, cb, alpha);
            }
            auto& cursorRowSolidVertices = rowSolidVertices_[static_cast<size_t>(cursor.row)];
            cursorRowSolidVertices.insert(cursorRowSolidVertices.end(), frameSolidVertices_.begin() + static_cast<std::ptrdiff_t>(cursorSolidStart), frameSolidVertices_.end());
        }
        cachedGlyphVertexCount_ = static_cast<GLsizei>(frameVertices_.size());
        cachedSolidVertexCount_ = static_cast<GLsizei>(frameSolidVertices_.size());
        cachedAtlasGeneration_ = font_.atlasGeneration();
    }
drawCachedBuffers:
    bool uploadAllRows = false;
    if (rowGlyphVbos_.size() != static_cast<size_t>(std::max(rows, 0))) {
        if (!rowGlyphVbos_.empty()) glDeleteBuffers(static_cast<GLsizei>(rowGlyphVbos_.size()), rowGlyphVbos_.data());
        rowGlyphVbos_.assign(static_cast<size_t>(std::max(rows, 0)), 0);
        if (!rowGlyphVbos_.empty()) glGenBuffers(static_cast<GLsizei>(rowGlyphVbos_.size()), rowGlyphVbos_.data());
        rowGlyphVertexCounts_.assign(rowGlyphVbos_.size(), 0);
        shouldUploadBuffers = true;
        uploadAllRows = true;
    }
    if (rowSolidVbos_.size() != static_cast<size_t>(std::max(rows, 0))) {
        if (!rowSolidVbos_.empty()) glDeleteBuffers(static_cast<GLsizei>(rowSolidVbos_.size()), rowSolidVbos_.data());
        rowSolidVbos_.assign(static_cast<size_t>(std::max(rows, 0)), 0);
        if (!rowSolidVbos_.empty()) glGenBuffers(static_cast<GLsizei>(rowSolidVbos_.size()), rowSolidVbos_.data());
        rowSolidVertexCounts_.assign(rowSolidVbos_.size(), 0);
        shouldUploadBuffers = true;
        uploadAllRows = true;
    }
    glUseProgram(solidProgram_);
    glBindVertexArray(solidVao_);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    for (int row = 0; row < rows; row++) {
        glBindBuffer(GL_ARRAY_BUFFER, rowSolidVbos_[static_cast<size_t>(row)]);
        glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, sizeof(SolidVertex), reinterpret_cast<void*>(0));
        glVertexAttribPointer(1, 4, GL_FLOAT, GL_FALSE, sizeof(SolidVertex), reinterpret_cast<void*>(sizeof(float) * 2));
        if (shouldUploadBuffers && (uploadAllRows || dirtyRows_.empty() || dirtyRows_[static_cast<size_t>(row)] != 0)) {
            const auto& rowVertices = rowSolidVertices_[static_cast<size_t>(row)];
            glBufferData(GL_ARRAY_BUFFER, rowVertices.size() * sizeof(SolidVertex), rowVertices.data(), GL_DYNAMIC_DRAW);
            rowSolidVertexCounts_[static_cast<size_t>(row)] = static_cast<GLsizei>(rowVertices.size());
        }
        glDrawArrays(GL_TRIANGLES, 0, rowSolidVertexCounts_[static_cast<size_t>(row)]);
    }
    glUseProgram(program_);
    glBindVertexArray(vao_);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, font_.texture());
    glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    for (int row = 0; row < rows; row++) {
        glBindBuffer(GL_ARRAY_BUFFER, rowGlyphVbos_[static_cast<size_t>(row)]);
        glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, sizeof(Vertex), reinterpret_cast<void*>(0));
        glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, sizeof(Vertex), reinterpret_cast<void*>(sizeof(float) * 2));
        glVertexAttribPointer(2, 4, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), reinterpret_cast<void*>(offsetof(Vertex, r)));
        glVertexAttribPointer(3, 4, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), reinterpret_cast<void*>(offsetof(Vertex, br)));
        if (shouldUploadBuffers && (uploadAllRows || dirtyRows_.empty() || dirtyRows_[static_cast<size_t>(row)] != 0)) {
            const auto& rowVertices = rowGlyphVertices_[static_cast<size_t>(row)];
            glBufferData(GL_ARRAY_BUFFER, rowVertices.size() * sizeof(Vertex), rowVertices.data(), GL_DYNAMIC_DRAW);
            rowGlyphVertexCounts_[static_cast<size_t>(row)] = static_cast<GLsizei>(rowVertices.size());
        }
        glDrawArrays(GL_TRIANGLES, 0, rowGlyphVertexCounts_[static_cast<size_t>(row)]);
    }
    hasPresentedFrame_ = true;
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
