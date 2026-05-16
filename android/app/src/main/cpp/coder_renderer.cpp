#include "coder_renderer.h"
#include "coder_shaders.h"

#include <android/log.h>
#include <chrono>
#include <vector>

struct Vertex { float x, y, u, v, r, g, b; };
struct SolidVertex { float x, y, r, g, b, a; };

CoderRenderer::CoderRenderer() = default;

CoderRenderer::~CoderRenderer() = default;

bool CoderRenderer::init() {
    GLuint vs = compile(GL_VERTEX_SHADER, CoderTerminalVertexShader);
    GLuint fs = compile(GL_FRAGMENT_SHADER, CoderTerminalFragmentShader);
    GLuint solidVs = compile(GL_VERTEX_SHADER, CoderSolidVertexShader);
    GLuint solidFs = compile(GL_FRAGMENT_SHADER, CoderSolidFragmentShader);
    program_ = glCreateProgram();
    glAttachShader(program_, vs);
    glAttachShader(program_, fs);
    glLinkProgram(program_);
    solidProgram_ = glCreateProgram();
    glAttachShader(solidProgram_, solidVs);
    glAttachShader(solidProgram_, solidFs);
    glLinkProgram(solidProgram_);
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
    glDeleteShader(vs);
    glDeleteShader(fs);
    glDeleteShader(solidVs);
    glDeleteShader(solidFs);
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
}

void CoderRenderer::setTheme(uint32_t background, uint32_t cursor, uint32_t cursorText) {
    clearColor_ = background;
    cursorColor_ = cursor;
    cursorTextColor_ = ((cursorText >> 16u) & 0xffu) | (cursorText & 0x00ff00u) | ((cursorText & 0xffu) << 16u);
    cachedCells_.clear();
}

void CoderRenderer::setTextOptions(bool ligatures, bool cursorBlink, int cursorMode) {
    font_.setLigaturesEnabled(ligatures);
    cursorBlink_ = cursorBlink;
    cursorMode_ = cursorMode < 0 ? 0 : cursorMode > 2 ? 2 : cursorMode;
    cachedCells_.clear();
}

void CoderRenderer::setTargetRefreshRate(float refreshRate) {
    targetRefreshRate_ = refreshRate > 1.0f ? refreshRate : 60.0f;
}

void CoderRenderer::resize(int width, int height) {
    width_ = width > 0 ? width : 1;
    height_ = height > 0 ? height : 1;
    glViewport(0, 0, width_, height_);
}

void CoderRenderer::setCellSize(int width, int height) {
    font_.setCellSize(width, height);
}

int CoderRenderer::cellWidth() const {
    return font_.glyphWidth();
}

int CoderRenderer::cellHeight() const {
    return font_.glyphHeight();
}

bool CoderRenderer::updateCachedCells(const std::vector<CoderCell>& cells, int cols, int rows, int cursorCol, int cursorRow) {
    bool changed = cachedCols_ != cols || cachedRows_ != rows || cachedCursorCol_ != cursorCol || cachedCursorRow_ != cursorRow || cachedCells_.size() != cells.size();
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
    cachedCursorCol_ = cursorCol;
    cachedCursorRow_ = cursorRow;
    cachedCells_ = cells;
    return true;
}

void CoderRenderer::draw(CoderTerminal& terminal) {
    terminal.pump();
    int cols, rows, cursorCol, cursorRow;
    auto cells = terminal.snapshot(cols, rows, cursorCol, cursorRow);
    auto now = std::chrono::steady_clock::now();
    bool cursorVisible = !cursorBlink_ || (std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() / 550) % 2 == 0;
    bool shouldUploadBuffers = updateCachedCells(cells, cols, rows, cursorCol, cursorRow) || cachedCursorVisible_ != cursorVisible;
    cachedCursorVisible_ = cursorVisible;
    glClearColor(((clearColor_ >> 16u) & 255u) / 255.0f, ((clearColor_ >> 8u) & 255u) / 255.0f, (clearColor_ & 255u) / 255.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    std::vector<Vertex> vertices;
    std::vector<SolidVertex> solidVertices;
    float cw = 2.0f * font_.glyphWidth() / width_;
    float ch = 2.0f * font_.glyphHeight() / height_;
    if (shouldUploadBuffers) {
        vertices.reserve(cells.size() * 6);
        solidVertices.reserve((cells.size() + 1) * 6);
        for (int row = 0; row < rows; row++) {
            for (int col = 0; col < cols; col++) {
            const auto& cell = cells[row * cols + col];
            float x0 = -1.0f + col * cw;
            float y0 = 1.0f - (row + 1) * ch;
            float x1 = x0 + cw;
            float y1 = y0 + ch;
            float br = ((cell.background >> 0) & 255) / 255.0f;
            float bg = ((cell.background >> 8) & 255) / 255.0f;
            float bb = ((cell.background >> 16) & 255) / 255.0f;
            solidVertices.insert(solidVertices.end(), {{x0,y0,br,bg,bb,1.0f},{x1,y0,br,bg,bb,1.0f},{x1,y1,br,bg,bb,1.0f},{x0,y0,br,bg,bb,1.0f},{x1,y1,br,bg,bb,1.0f},{x0,y1,br,bg,bb,1.0f}});
            if (cell.codepointCount == 0) continue;
            float glyphCursorX = x0;
            uint32_t glyphColor = row == cursorRow && col == cursorCol ? cursorTextColor_ : cell.foreground;
            float r = ((glyphColor >> 0) & 255) / 255.0f;
            float g = ((glyphColor >> 8) & 255) / 255.0f;
            float b = ((glyphColor >> 16) & 255) / 255.0f;
            auto drawCodepoints = [&]() {
                for (uint32_t codepointIndex = 0; codepointIndex < cell.codepointCount; codepointIndex++) {
                    uint32_t codepoint = cell.codepoints[codepointIndex];
                    if (codepoint <= ' ') continue;
                    CoderFont::Glyph glyph;
                    if (!font_.glyph(codepoint, glyph) || glyph.width <= 0 || glyph.height <= 0) continue;
                    float glyphX0 = glyphCursorX + 2.0f * static_cast<float>(glyph.bearingLeft) / static_cast<float>(width_);
                    float glyphY1 = y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop) / static_cast<float>(height_);
                    float glyphX1 = glyphX0 + 2.0f * static_cast<float>(glyph.width) / static_cast<float>(width_);
                    float glyphY0 = glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_);
                    vertices.insert(vertices.end(), {{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b},{glyphX1,glyphY0,glyph.u1,glyph.v1,r,g,b},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b},{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b},{glyphX0,glyphY1,glyph.u0,glyph.v0,r,g,b}});
                    glyphCursorX += 2.0f * static_cast<float>(glyph.advance) / static_cast<float>(width_);
                }
            };
            auto shapedGlyphs = font_.shape(cell.codepoints.data(), cell.codepointCount);
            if (shapedGlyphs.empty()) {
                drawCodepoints();
                continue;
            }
            bool shapedGlyphsRenderable = true;
            for (const auto& shapedGlyph : shapedGlyphs) {
                CoderFont::Glyph glyph;
                if (shapedGlyph.glyphId == 0 || !font_.glyphByIndex(shapedGlyph.glyphId, glyph)) {
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
                if (!font_.glyphByIndex(shapedGlyph.glyphId, glyph) || glyph.width <= 0 || glyph.height <= 0) continue;
                float glyphX0 = glyphCursorX + 2.0f * static_cast<float>(glyph.bearingLeft + shapedGlyph.xOffset) / static_cast<float>(width_);
                float glyphY1 = y1 - 2.0f * static_cast<float>(font_.baseline() - glyph.bearingTop - shapedGlyph.yOffset) / static_cast<float>(height_);
                float glyphX1 = glyphX0 + 2.0f * static_cast<float>(glyph.width) / static_cast<float>(width_);
                float glyphY0 = glyphY1 - 2.0f * static_cast<float>(glyph.height) / static_cast<float>(height_);
                vertices.insert(vertices.end(), {{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b},{glyphX1,glyphY0,glyph.u1,glyph.v1,r,g,b},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b},{glyphX0,glyphY0,glyph.u0,glyph.v1,r,g,b},{glyphX1,glyphY1,glyph.u1,glyph.v0,r,g,b},{glyphX0,glyphY1,glyph.u0,glyph.v0,r,g,b}});
                if ((cell.flags & 1u) != 0u) {
                    float boldOffset = 2.0f / static_cast<float>(width_);
                    vertices.insert(vertices.end(), {{glyphX0 + boldOffset,glyphY0,glyph.u0,glyph.v1,r,g,b},{glyphX1 + boldOffset,glyphY0,glyph.u1,glyph.v1,r,g,b},{glyphX1 + boldOffset,glyphY1,glyph.u1,glyph.v0,r,g,b},{glyphX0 + boldOffset,glyphY0,glyph.u0,glyph.v1,r,g,b},{glyphX1 + boldOffset,glyphY1,glyph.u1,glyph.v0,r,g,b},{glyphX0 + boldOffset,glyphY1,glyph.u0,glyph.v0,r,g,b}});
                }
                glyphCursorX += 2.0f * static_cast<float>(shapedGlyph.xAdvance) / static_cast<float>(width_);
            }
            }
        }
        if (cursorVisible && cursorCol >= 0 && cursorRow >= 0 && cursorCol < cols && cursorRow < rows) {
            float x0 = -1.0f + cursorCol * cw;
            float y0 = 1.0f - (cursorRow + 1) * ch;
            float x1 = x0 + cw;
            float y1 = y0 + ch;
            if (cursorMode_ == 1) {
                y1 = y0 + ch * 0.16f;
            } else if (cursorMode_ == 2) {
                x1 = x0 + cw * 0.16f;
            }
            float cr = ((cursorColor_ >> 16u) & 255u) / 255.0f;
            float cg = ((cursorColor_ >> 8u) & 255u) / 255.0f;
            float cb = (cursorColor_ & 255u) / 255.0f;
            solidVertices.insert(solidVertices.end(), {{x0,y0,cr,cg,cb,0.55f},{x1,y0,cr,cg,cb,0.55f},{x1,y1,cr,cg,cb,0.55f},{x0,y0,cr,cg,cb,0.55f},{x1,y1,cr,cg,cb,0.55f},{x0,y1,cr,cg,cb,0.55f}});
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
    glDrawArrays(GL_TRIANGLES, 0, cachedSolidVertexCount_);
    glUseProgram(program_);
    glBindVertexArray(vao_);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, font_.texture());
    glBindBuffer(GL_ARRAY_BUFFER, vbo_);
    if (shouldUploadBuffers) {
        glBufferData(GL_ARRAY_BUFFER, vertices.size() * sizeof(Vertex), vertices.data(), GL_DYNAMIC_DRAW);
    }
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
