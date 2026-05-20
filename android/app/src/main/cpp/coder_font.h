#pragma once

#include <GLES3/gl3.h>
#include <cstddef>
#include <cstdint>
#include <array>
#include <unordered_map>
#include <list>
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
        int atlasX = 0;
        int atlasY = 0;
        int width = 0;
        int height = 0;
        int bearingLeft = 0;
        int bearingTop = 0;
        int advance = 0;
        bool color = false;
    };

    struct ShapedGlyph {
        uint32_t glyphId = 0;
        uint32_t cellX = 0;
        uint32_t cluster = 0;
        int xAdvance = 0;
        int xOffset = 0;
        int yOffset = 0;
        uint32_t fallbackIndex = UINT32_MAX;
        uint32_t primaryIndex = UINT32_MAX;
    };

    CoderFont();
    ~CoderFont();

    bool init();
    void setFontData(const uint8_t* data, size_t length);
    void setFontData(const uint8_t* regularData, size_t regularLength, const uint8_t* boldData, size_t boldLength, const uint8_t* italicData, size_t italicLength, const uint8_t* boldItalicData, size_t boldItalicLength);
    void setFallbackFontData(const uint8_t* data, size_t length);
    void setCellSize(int width, int height, int fontPixelSize);
    void setOpenTypeFeatures(bool ligatures, bool contextualAlternates, bool slashedZero, bool stylisticSet1, bool stylisticSet2, bool characterVariant1);
    void setBoldStyleEnabled(bool enabled);
    bool glyph(uint32_t codepoint, uint32_t flags, Glyph& outGlyph);
    bool glyphByIndex(uint32_t glyphIndex, uint32_t flags, Glyph& outGlyph);
    bool primaryGlyphByIndex(uint32_t glyphIndex, uint32_t primaryIndex, Glyph& outGlyph);
    bool fallbackGlyphByIndex(uint32_t glyphIndex, uint32_t fallbackIndex, Glyph& outGlyph);
    std::vector<ShapedGlyph> shape(const uint32_t* codepoints, uint32_t codepointCount, uint32_t flags, int targetAdvance);
    std::vector<ShapedGlyph> shape(const uint32_t* codepoints, const uint32_t* clusters, uint32_t codepointCount, uint32_t flags, int targetAdvance);
    bool shouldSynthesizeBold(uint32_t flags) const;
    GLuint texture() const { return texture_; }
    int glyphWidth() const { return glyphWidth_; }
    int glyphHeight() const { return glyphHeight_; }
    int atlasWidth() const { return atlasWidth_; }
    int atlasHeight() const { return atlasHeight_; }
    uint64_t atlasGeneration() const { return atlasGeneration_; }
    int baseline() const { return baseline_; }

private:
    struct FontFace {
        FT_Face face = nullptr;
        hb_font_t* harfbuzzFont = nullptr;
        std::vector<uint8_t> data;
        bool fallback = false;
        bool color = false;
    };

    bool rebuildAtlas();
    bool growAtlas();
    bool resetAtlasForRecentGlyphs();
    bool loadPrimaryFace(size_t index);
    bool loadFallbackFaces();
    bool configureFaceSize(FT_Face face);
    void updateMetricsFromFace(FT_Face face);
    uint32_t styleIndex(uint32_t flags) const;
    std::vector<ShapedGlyph> shapeWithFont(hb_font_t* font, const uint32_t* codepoints, const uint32_t* clusters, uint32_t codepointCount, uint32_t fallbackIndex, uint32_t primaryIndex, int targetAdvance);
    bool allocateGlyph(uint64_t key, FT_Face face, uint32_t glyphIndex, Glyph& outGlyph);
    const uint8_t* bitmapBuffer(const FT_Bitmap& bitmap, std::vector<uint8_t>& convertedBuffer, bool& color);
    void releaseFace();

    struct ShapeCacheKey {
        std::vector<uint32_t> codepoints;
        std::vector<uint32_t> clusters;
        uint32_t flags = 0;
        int targetAdvance = 0;
        bool operator==(const ShapeCacheKey& other) const { return flags == other.flags && targetAdvance == other.targetAdvance && codepoints == other.codepoints && clusters == other.clusters; }
    };

    struct ShapeCacheKeyHash {
        size_t operator()(const ShapeCacheKey& key) const;
    };

    void clearShapeCache();
    std::vector<ShapedGlyph> shapeUncached(const uint32_t* codepoints, const uint32_t* clusters, uint32_t codepointCount, uint32_t flags, int targetAdvance);

    GLuint texture_ = 0;
    int glyphWidth_ = 18;
    int glyphHeight_ = 36;
    int fontPixelSize_ = 36;
    int baseline_ = 28;
    bool ligaturesEnabled_ = true;
    bool contextualAlternatesEnabled_ = true;
    bool slashedZeroEnabled_ = true;
    bool stylisticSet1Enabled_ = false;
    bool stylisticSet2Enabled_ = false;
    bool characterVariant1Enabled_ = false;
    int atlasWidth_ = 1024;
    int atlasHeight_ = 1024;
    int atlasTargetSize_ = 1024;
    int atlasMaxSize_ = 4096;
    bool atlasFullReported_ = false;
    bool atlasGrowing_ = false;
    bool atlasResetting_ = false;
    bool boldStyleEnabled_ = false;
    uint64_t atlasGeneration_ = 0;
    int shelfX_ = 1;
    int shelfY_ = 1;
    int shelfHeight_ = 0;
    std::vector<uint8_t> atlasPixels_;
    FT_Library library_ = nullptr;
    std::array<FontFace, 4> primaryFaces_;
    std::vector<uint8_t> bundledFallbackData_;
    std::vector<FontFace> fallbackFaces_;
    std::unordered_map<uint64_t, Glyph> glyphs_;
    std::list<ShapeCacheKey> shapeCacheOrder_;
    std::unordered_map<ShapeCacheKey, std::pair<std::vector<ShapedGlyph>, std::list<ShapeCacheKey>::iterator>, ShapeCacheKeyHash> shapeCache_;
};
