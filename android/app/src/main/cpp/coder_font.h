#pragma once

#include <GLES3/gl3.h>
#include <cstddef>
#include <cstdint>
#include <unordered_map>
#include <vector>

#include <ft2build.h>
#include FT_FREETYPE_H
#include <hb-ft.h>
#include <hb.h>

class CoderFont {
public:
    struct Glyph {
        float u0 = 0.0f;
        float v0 = 0.0f;
        float u1 = 0.0f;
        float v1 = 0.0f;
        int width = 0;
        int height = 0;
        int bearingLeft = 0;
        int bearingTop = 0;
        int advance = 0;
    };

    struct ShapedGlyph {
        uint32_t glyphId = 0;
        int xAdvance = 0;
        int xOffset = 0;
        int yOffset = 0;
    };

    CoderFont();
    ~CoderFont();

    bool init();
    void setFontData(const uint8_t* data, size_t length);
    void setCellSize(int width, int height);
    bool glyph(uint32_t codepoint, Glyph& outGlyph);
    bool glyphByIndex(uint32_t glyphIndex, Glyph& outGlyph);
    std::vector<ShapedGlyph> shape(const uint32_t* codepoints, uint32_t codepointCount);
    GLuint texture() const { return texture_; }
    int glyphWidth() const { return glyphWidth_; }
    int glyphHeight() const { return glyphHeight_; }
    int atlasWidth() const { return atlasWidth_; }
    int atlasHeight() const { return atlasHeight_; }
    int baseline() const { return baseline_; }

private:
    bool rebuildAtlas();
    bool loadFace();
    bool allocateGlyph(uint64_t key, uint32_t glyphIndex, bool loadByIndex, Glyph& outGlyph);
    void releaseFace();

    GLuint texture_ = 0;
    int glyphWidth_ = 18;
    int glyphHeight_ = 36;
    int baseline_ = 28;
    int atlasWidth_ = 2048;
    int atlasHeight_ = 2048;
    int shelfX_ = 1;
    int shelfY_ = 1;
    int shelfHeight_ = 0;
    FT_Library library_ = nullptr;
    FT_Face face_ = nullptr;
    hb_font_t* harfbuzzFont_ = nullptr;
    std::vector<uint8_t> fontData_;
    std::unordered_map<uint64_t, Glyph> glyphs_;
};
