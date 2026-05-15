#include "coder_font.h"

#include <algorithm>
#include <android/log.h>
#include <vector>

CoderFont::CoderFont() = default;

CoderFont::~CoderFont() {
    releaseFace();
}

bool CoderFont::init() {
    return rebuildAtlas();
}

void CoderFont::setFontData(const uint8_t* data, size_t length) {
    fontData_.assign(data, data + length);
    releaseFace();
    if (texture_ != 0) rebuildAtlas();
}

void CoderFont::setCellSize(int width, int height) {
    if (glyphWidth_ == width && glyphHeight_ == height) return;
    glyphWidth_ = std::max(1, width);
    glyphHeight_ = std::max(1, height);
    baseline_ = static_cast<int>(glyphHeight_ * 0.78f);
    if (texture_ != 0) rebuildAtlas();
}

bool CoderFont::glyph(uint32_t codepoint, Glyph& outGlyph) {
    uint64_t key = codepoint;
    auto existing = glyphs_.find(key);
    if (existing != glyphs_.end()) {
        outGlyph = existing->second;
        return true;
    }
    uint32_t glyphIndex = loadFace() ? FT_Get_Char_Index(face_, static_cast<FT_ULong>(codepoint)) : 0;
    if (glyphIndex != 0 && allocateGlyph(key, glyphIndex, true, outGlyph)) return true;
    if (codepoint != '?') return glyph('?', outGlyph);
    return false;
}

bool CoderFont::glyphByIndex(uint32_t glyphIndex, Glyph& outGlyph) {
    uint64_t key = 0x100000000ULL | glyphIndex;
    auto existing = glyphs_.find(key);
    if (existing != glyphs_.end()) {
        outGlyph = existing->second;
        return true;
    }
    return allocateGlyph(key, glyphIndex, true, outGlyph);
}

std::vector<CoderFont::ShapedGlyph> CoderFont::shape(const uint32_t* codepoints, uint32_t codepointCount) {
    std::vector<ShapedGlyph> shaped;
    if (!loadFace() || !harfbuzzFont_ || codepointCount == 0) return shaped;
    hb_buffer_t* buffer = hb_buffer_create();
    hb_buffer_add_codepoints(buffer, codepoints, codepointCount, 0, codepointCount);
    hb_buffer_guess_segment_properties(buffer);
    hb_shape(harfbuzzFont_, buffer, nullptr, 0);
    unsigned int glyphCount = 0;
    hb_glyph_info_t* infos = hb_buffer_get_glyph_infos(buffer, &glyphCount);
    hb_glyph_position_t* positions = hb_buffer_get_glyph_positions(buffer, &glyphCount);
    shaped.reserve(glyphCount);
    for (unsigned int index = 0; index < glyphCount; index++) {
        shaped.push_back(ShapedGlyph{
            infos[index].codepoint,
            static_cast<int>(positions[index].x_advance >> 6),
            static_cast<int>(positions[index].x_offset >> 6),
            static_cast<int>(positions[index].y_offset >> 6),
        });
    }
    hb_buffer_destroy(buffer);
    return shaped;
}

bool CoderFont::rebuildAtlas() {
    baseline_ = static_cast<int>(glyphHeight_ * 0.78f);
    glyphs_.clear();
    shelfX_ = 1;
    shelfY_ = 1;
    shelfHeight_ = 0;
    if (!loadFace()) return false;
    if (texture_ == 0) glGenTextures(1, &texture_);
    glBindTexture(GL_TEXTURE_2D, texture_);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    std::vector<uint8_t> empty(static_cast<size_t>(atlasWidth_ * atlasHeight_), 0);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, atlasWidth_, atlasHeight_, 0, GL_RED, GL_UNSIGNED_BYTE, empty.data());
    for (uint32_t codepoint = 33; codepoint < 127; codepoint++) {
        Glyph ignored;
        glyph(codepoint, ignored);
    }
    return texture_ != 0;
}

bool CoderFont::loadFace() {
    if (face_) return true;
    if (fontData_.empty()) return false;
    if (!library_ && FT_Init_FreeType(&library_) != 0) return false;
    if (FT_New_Memory_Face(library_, fontData_.data(), static_cast<FT_Long>(fontData_.size()), 0, &face_) != 0) return false;
    if (FT_Set_Pixel_Sizes(face_, 0, static_cast<FT_UInt>(glyphHeight_)) != 0) {
        releaseFace();
        return false;
    }
    harfbuzzFont_ = hb_ft_font_create_referenced(face_);
    return harfbuzzFont_ != nullptr;
}

bool CoderFont::allocateGlyph(uint64_t key, uint32_t glyphIndex, bool loadByIndex, Glyph& outGlyph) {
    if (!loadFace()) return false;
    int loadResult = loadByIndex
        ? FT_Load_Glyph(face_, glyphIndex, FT_LOAD_RENDER)
        : FT_Load_Char(face_, static_cast<FT_ULong>(glyphIndex), FT_LOAD_RENDER);
    if (loadResult != 0) return false;
    FT_GlyphSlot slot = face_->glyph;
    int bitmapWidth = static_cast<int>(slot->bitmap.width);
    int bitmapHeight = static_cast<int>(slot->bitmap.rows);
    int paddedWidth = std::max(1, bitmapWidth) + 2;
    int paddedHeight = std::max(1, bitmapHeight) + 2;
    if (shelfX_ + paddedWidth >= atlasWidth_) {
        shelfX_ = 1;
        shelfY_ += shelfHeight_ + 1;
        shelfHeight_ = 0;
    }
    if (shelfY_ + paddedHeight >= atlasHeight_) return false;
    int atlasX = shelfX_ + 1;
    int atlasY = shelfY_ + 1;
    shelfX_ += paddedWidth;
    shelfHeight_ = std::max(shelfHeight_, paddedHeight);
    if (bitmapWidth > 0 && bitmapHeight > 0) {
        glBindTexture(GL_TEXTURE_2D, texture_);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
        glTexSubImage2D(GL_TEXTURE_2D, 0, atlasX, atlasY, bitmapWidth, bitmapHeight, GL_RED, GL_UNSIGNED_BYTE, slot->bitmap.buffer);
    }
    Glyph glyph;
    glyph.u0 = static_cast<float>(atlasX) / static_cast<float>(atlasWidth_);
    glyph.v0 = static_cast<float>(atlasY) / static_cast<float>(atlasHeight_);
    glyph.u1 = static_cast<float>(atlasX + bitmapWidth) / static_cast<float>(atlasWidth_);
    glyph.v1 = static_cast<float>(atlasY + bitmapHeight) / static_cast<float>(atlasHeight_);
    glyph.width = bitmapWidth;
    glyph.height = bitmapHeight;
    glyph.bearingLeft = slot->bitmap_left;
    glyph.bearingTop = slot->bitmap_top;
    glyph.advance = static_cast<int>(slot->advance.x >> 6);
    glyphs_[key] = glyph;
    outGlyph = glyph;
    return true;
}

void CoderFont::releaseFace() {
    if (harfbuzzFont_) {
        hb_font_destroy(harfbuzzFont_);
        harfbuzzFont_ = nullptr;
    }
    if (face_) {
        FT_Done_Face(face_);
        face_ = nullptr;
    }
    if (library_) {
        FT_Done_FreeType(library_);
        library_ = nullptr;
    }
}
