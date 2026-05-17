#include "coder_font.h"

#include FT_COLOR_H

#include <algorithm>
#include <android/log.h>
#include <array>
#include <cmath>
#include <unordered_set>
#include <string>
#include <vector>

CoderFont::CoderFont() = default;

CoderFont::~CoderFont() {
    releaseFace();
}

static void logMissingGlyph(uint32_t codepoint) {
    static std::unordered_set<uint32_t> logged;
    if (codepoint < 0x80 || logged.count(codepoint) != 0) return;
    logged.insert(codepoint);
    __android_log_print(ANDROID_LOG_WARN, "CoderFont", "missing glyph codepoint=U+%04X", codepoint);
}

static void logColorGlyphDetails(FT_Face face, uint32_t codepoint, uint32_t glyphIndex) {
    static std::unordered_set<uint32_t> logged;
    if (codepoint < 0x1f000 || logged.count(codepoint) != 0) return;
    logged.insert(codepoint);
    FT_LayerIterator layerIterator{};
    FT_UInt layerGlyphIndex = 0;
    FT_UInt layerColorIndex = 0;
    int layerCount = 0;
    while (FT_Get_Color_Glyph_Layer(face, glyphIndex, &layerGlyphIndex, &layerColorIndex, &layerIterator)) layerCount++;
    FT_OpaquePaint rootPaint{};
    bool hasPaint = FT_Get_Color_Glyph_Paint(face, glyphIndex, FT_COLOR_INCLUDE_ROOT_TRANSFORM, &rootPaint) != 0;
    FT_COLR_Paint paint{};
    bool hasRoot = hasPaint && FT_Get_Paint(face, rootPaint, &paint) != 0;
    __android_log_print(ANDROID_LOG_WARN, "CoderFont", "emoji color glyph cp=U+%04X glyph=%u layers=%d has_paint=%d root_format=%d", codepoint, glyphIndex, layerCount, hasPaint ? 1 : 0, hasRoot ? static_cast<int>(paint.format) : -1);
}

static uint8_t fixedAlpha(FT_F2Dot14 alpha) {
    if (alpha <= 0) return 0;
    if (alpha >= 0x4000) return 255;
    return static_cast<uint8_t>((static_cast<int>(alpha) * 255) / 0x4000);
}

static bool paletteColor(FT_Face face, const FT_ColorIndex& colorIndex, uint32_t foreground, FT_Color& outColor) {
    if (colorIndex.palette_index == 0xffffu) {
        outColor.blue = static_cast<FT_Byte>(foreground & 0xffu);
        outColor.green = static_cast<FT_Byte>((foreground >> 8u) & 0xffu);
        outColor.red = static_cast<FT_Byte>((foreground >> 16u) & 0xffu);
        outColor.alpha = fixedAlpha(colorIndex.alpha);
        return true;
    }
    FT_Color* palette = nullptr;
    if (FT_Palette_Select(face, 0, &palette) != 0 || !palette) return false;
    outColor = palette[colorIndex.palette_index];
    outColor.alpha = static_cast<FT_Byte>((static_cast<int>(outColor.alpha) * fixedAlpha(colorIndex.alpha)) / 255);
    return true;
}

struct ColorStop {
    float offset = 0.0f;
    FT_Color color{};
};

static std::vector<ColorStop> colorStops(FT_Face face, FT_ColorLine colorLine, uint32_t foreground) {
    std::vector<ColorStop> stops;
    FT_ColorStop stop{};
    while (FT_Get_Colorline_Stops(face, &stop, &colorLine.color_stop_iterator)) {
        FT_Color color{};
        if (paletteColor(face, stop.color, foreground, color)) stops.push_back({static_cast<float>(stop.stop_offset) / 65536.0f, color});
    }
    if (stops.empty()) return stops;
    std::sort(stops.begin(), stops.end(), [](const ColorStop& left, const ColorStop& right) { return left.offset < right.offset; });
    return stops;
}

static FT_Color sampleStops(const std::vector<ColorStop>& stops, float offset) {
    if (stops.empty()) return {};
    if (offset <= stops.front().offset) return stops.front().color;
    if (offset >= stops.back().offset) return stops.back().color;
    for (size_t index = 1; index < stops.size(); index++) {
        if (offset > stops[index].offset) continue;
        const auto& left = stops[index - 1];
        const auto& right = stops[index];
        float range = std::max(0.0001f, right.offset - left.offset);
        float t = std::clamp((offset - left.offset) / range, 0.0f, 1.0f);
        auto lerp = [&](FT_Byte a, FT_Byte b) { return static_cast<FT_Byte>(std::round(static_cast<float>(a) + (static_cast<float>(b) - static_cast<float>(a)) * t)); };
        return FT_Color{lerp(left.color.blue, right.color.blue), lerp(left.color.green, right.color.green), lerp(left.color.red, right.color.red), lerp(left.color.alpha, right.color.alpha)};
    }
    return stops.back().color;
}

enum class PaintKind { Solid, Linear, Radial, Sweep };

struct PaintFill {
    PaintKind kind = PaintKind::Solid;
    FT_Color solid{};
    std::vector<ColorStop> stops;
    float x0 = 0.0f;
    float y0 = 0.0f;
    float r0 = 0.0f;
    float x1 = 0.0f;
    float y1 = 0.0f;
    float r1 = 1.0f;
    float x2 = 0.0f;
    float y2 = 0.0f;
};

static FT_Color fillColorAt(const PaintFill& fill, float x, float y) {
    if (fill.kind == PaintKind::Solid) return fill.solid;
    if (fill.stops.empty()) return {};
    if (fill.kind == PaintKind::Linear) {
        float dx = fill.x1 - fill.x0;
        float dy = fill.y1 - fill.y0;
        float lengthSquared = std::max(0.0001f, dx * dx + dy * dy);
        return sampleStops(fill.stops, ((x - fill.x0) * dx + (y - fill.y0) * dy) / lengthSquared);
    }
    if (fill.kind == PaintKind::Radial) {
        float distance = std::hypot(x - fill.x0, y - fill.y0);
        float radiusDelta = std::max(0.0001f, fill.r1 - fill.r0);
        return sampleStops(fill.stops, (distance - fill.r0) / radiusDelta);
    }
    float angle = std::atan2(y - fill.y0, x - fill.x0) / (2.0f * static_cast<float>(M_PI));
    if (angle < 0.0f) angle += 1.0f;
    return sampleStops(fill.stops, angle);
}

static void blendMask(std::vector<uint8_t>& target, int targetWidth, int targetHeight, const FT_Bitmap& bitmap, int x, int y, const FT_Color& color) {
    for (uint32_t row = 0; row < bitmap.rows; row++) {
        int targetY = y + static_cast<int>(row);
        if (targetY < 0 || targetY >= targetHeight) continue;
        const uint8_t* source = bitmap.buffer + row * std::abs(bitmap.pitch);
        for (uint32_t col = 0; col < bitmap.width; col++) {
            int targetX = x + static_cast<int>(col);
            if (targetX < 0 || targetX >= targetWidth) continue;
            uint8_t mask = bitmap.pixel_mode == FT_PIXEL_MODE_MONO ? ((source[col >> 3] & (0x80 >> (col & 7))) ? 255 : 0) : source[col];
            int sourceAlpha = (static_cast<int>(mask) * static_cast<int>(color.alpha)) / 255;
            if (sourceAlpha == 0) continue;
            uint8_t* pixel = target.data() + (static_cast<size_t>(targetY) * targetWidth + targetX) * 4u;
            int inverseAlpha = 255 - sourceAlpha;
            pixel[0] = static_cast<uint8_t>((static_cast<int>(color.red) * sourceAlpha + static_cast<int>(pixel[0]) * inverseAlpha) / 255);
            pixel[1] = static_cast<uint8_t>((static_cast<int>(color.green) * sourceAlpha + static_cast<int>(pixel[1]) * inverseAlpha) / 255);
            pixel[2] = static_cast<uint8_t>((static_cast<int>(color.blue) * sourceAlpha + static_cast<int>(pixel[2]) * inverseAlpha) / 255);
            pixel[3] = static_cast<uint8_t>(sourceAlpha + (static_cast<int>(pixel[3]) * inverseAlpha) / 255);
        }
    }
}

static void blendMaskFill(std::vector<uint8_t>& target, int targetWidth, int targetHeight, const FT_Bitmap& bitmap, int x, int y, int bearingTop, float xScale, float yScale, const PaintFill& fill) {
    for (uint32_t row = 0; row < bitmap.rows; row++) {
        int targetY = y + static_cast<int>(row);
        if (targetY < 0 || targetY >= targetHeight) continue;
        const uint8_t* source = bitmap.buffer + row * std::abs(bitmap.pitch);
        for (uint32_t col = 0; col < bitmap.width; col++) {
            int targetX = x + static_cast<int>(col);
            if (targetX < 0 || targetX >= targetWidth) continue;
            uint8_t mask = bitmap.pixel_mode == FT_PIXEL_MODE_MONO ? ((source[col >> 3] & (0x80 >> (col & 7))) ? 255 : 0) : source[col];
            if (mask == 0) continue;
            float fontX = static_cast<float>(targetX) / std::max(0.0001f, xScale);
            float fontY = static_cast<float>(bearingTop - targetY) / std::max(0.0001f, yScale);
            FT_Color color = fillColorAt(fill, fontX, fontY);
            int sourceAlpha = (static_cast<int>(mask) * static_cast<int>(color.alpha)) / 255;
            if (sourceAlpha == 0) continue;
            uint8_t* pixel = target.data() + (static_cast<size_t>(targetY) * targetWidth + targetX) * 4u;
            int inverseAlpha = 255 - sourceAlpha;
            pixel[0] = static_cast<uint8_t>((static_cast<int>(color.red) * sourceAlpha + static_cast<int>(pixel[0]) * inverseAlpha) / 255);
            pixel[1] = static_cast<uint8_t>((static_cast<int>(color.green) * sourceAlpha + static_cast<int>(pixel[1]) * inverseAlpha) / 255);
            pixel[2] = static_cast<uint8_t>((static_cast<int>(color.blue) * sourceAlpha + static_cast<int>(pixel[2]) * inverseAlpha) / 255);
            pixel[3] = static_cast<uint8_t>(sourceAlpha + (static_cast<int>(pixel[3]) * inverseAlpha) / 255);
        }
    }
}

static bool renderSolidColrGlyph(FT_Face face, uint32_t baseGlyphIndex, int glyphWidth, int glyphHeight, uint32_t foreground, std::vector<uint8_t>& pixels, int& bitmapWidth, int& bitmapHeight, int& bearingLeft, int& bearingTop, int& advance) {
    FT_OpaquePaint rootPaint{};
    if (!FT_Get_Color_Glyph_Paint(face, baseGlyphIndex, FT_COLOR_NO_ROOT_TRANSFORM, &rootPaint)) return false;
    FT_ClipBox clipBox{};
    bool hasClipBox = FT_Get_Color_Glyph_ClipBox(face, baseGlyphIndex, &clipBox) != 0;
    int clipLeft = hasClipBox ? static_cast<int>(std::floor(static_cast<float>(clipBox.bottom_left.x) / 64.0f)) : 0;
    int clipRight = hasClipBox ? static_cast<int>(std::ceil(static_cast<float>(clipBox.top_right.x) / 64.0f)) : std::max(glyphWidth * 2, glyphHeight);
    int clipTop = hasClipBox ? static_cast<int>(std::ceil(static_cast<float>(clipBox.top_left.y) / 64.0f)) : static_cast<int>(glyphHeight * 0.78f);
    int clipBottom = hasClipBox ? static_cast<int>(std::floor(static_cast<float>(clipBox.bottom_left.y) / 64.0f)) : clipTop - glyphHeight;
    bitmapWidth = std::max(1, clipRight - clipLeft);
    bitmapHeight = std::max(1, clipTop - clipBottom);
    bearingLeft = clipLeft;
    bearingTop = clipTop;
    FT_Load_Glyph(face, baseGlyphIndex, FT_LOAD_DEFAULT | FT_LOAD_NO_BITMAP);
    advance = std::max(1, static_cast<int>(face->glyph->advance.x >> 6));
    pixels.assign(static_cast<size_t>(bitmapWidth * bitmapHeight * 4), 0);
    std::vector<uint8_t>* targetPixels = &pixels;
    bool rendered = false;
    bool unsupported = false;
    int unsupportedFormat = -1;
    int unsupportedComposite = -1;
    float xScale = static_cast<float>(face->size ? face->size->metrics.x_ppem : glyphHeight) / static_cast<float>(face->units_per_EM ? face->units_per_EM : 1024);
    float yScale = static_cast<float>(face->size ? face->size->metrics.y_ppem : glyphHeight) / static_cast<float>(face->units_per_EM ? face->units_per_EM : 1024);
    auto renderGlyphFill = [&](uint32_t glyphToPaint, const PaintFill& fill) {
        if (FT_Load_Glyph(face, glyphToPaint, FT_LOAD_RENDER | FT_LOAD_TARGET_NORMAL) != 0) {
            unsupported = true;
            return;
        }
        FT_GlyphSlot slot = face->glyph;
        blendMaskFill(*targetPixels, bitmapWidth, bitmapHeight, slot->bitmap, slot->bitmap_left - bearingLeft, bearingTop - slot->bitmap_top, bearingTop, xScale, yScale, fill);
        rendered = true;
    };
    auto renderPaint = [&](auto&& self, FT_OpaquePaint opaquePaint, uint32_t glyphToPaint, int depth) -> void {
        if (depth > 16 || unsupported) return;
        FT_COLR_Paint paint{};
        if (!FT_Get_Paint(face, opaquePaint, &paint)) {
            unsupported = true;
            return;
        }
        switch (paint.format) {
            case FT_COLR_PAINTFORMAT_COLR_LAYERS: {
                FT_LayerIterator iterator = paint.u.colr_layers.layer_iterator;
                FT_OpaquePaint layer{};
                while (FT_Get_Paint_Layers(face, &iterator, &layer)) self(self, layer, glyphToPaint, depth + 1);
                break;
            }
            case FT_COLR_PAINTFORMAT_GLYPH:
                self(self, paint.u.glyph.paint, paint.u.glyph.glyphID, depth + 1);
                break;
            case FT_COLR_PAINTFORMAT_TRANSFORM:
                self(self, paint.u.transform.paint, glyphToPaint, depth + 1);
                break;
            case FT_COLR_PAINTFORMAT_TRANSLATE:
                self(self, paint.u.translate.paint, glyphToPaint, depth + 1);
                break;
            case FT_COLR_PAINTFORMAT_SCALE:
                self(self, paint.u.scale.paint, glyphToPaint, depth + 1);
                break;
            case FT_COLR_PAINTFORMAT_ROTATE:
                self(self, paint.u.rotate.paint, glyphToPaint, depth + 1);
                break;
            case FT_COLR_PAINTFORMAT_SKEW:
                self(self, paint.u.skew.paint, glyphToPaint, depth + 1);
                break;
            case FT_COLR_PAINTFORMAT_SOLID: {
                FT_Color color{};
                if (!paletteColor(face, paint.u.solid.color, foreground, color)) {
                    unsupported = true;
                    break;
                }
                renderGlyphFill(glyphToPaint, PaintFill{PaintKind::Solid, color});
                break;
            }
            case FT_COLR_PAINTFORMAT_LINEAR_GRADIENT: {
                auto stops = colorStops(face, paint.u.linear_gradient.colorline, foreground);
                if (stops.empty()) {
                    unsupported = true;
                    break;
                }
                PaintFill fill;
                fill.kind = PaintKind::Linear;
                fill.stops = std::move(stops);
                fill.x0 = static_cast<float>(paint.u.linear_gradient.p0.x) / 65536.0f;
                fill.y0 = static_cast<float>(paint.u.linear_gradient.p0.y) / 65536.0f;
                fill.x1 = static_cast<float>(paint.u.linear_gradient.p1.x) / 65536.0f;
                fill.y1 = static_cast<float>(paint.u.linear_gradient.p1.y) / 65536.0f;
                renderGlyphFill(glyphToPaint, fill);
                break;
            }
            case FT_COLR_PAINTFORMAT_RADIAL_GRADIENT: {
                auto stops = colorStops(face, paint.u.radial_gradient.colorline, foreground);
                if (stops.empty()) {
                    unsupported = true;
                    break;
                }
                PaintFill fill;
                fill.kind = PaintKind::Radial;
                fill.stops = std::move(stops);
                fill.x0 = static_cast<float>(paint.u.radial_gradient.c0.x) / 65536.0f;
                fill.y0 = static_cast<float>(paint.u.radial_gradient.c0.y) / 65536.0f;
                fill.r0 = static_cast<float>(paint.u.radial_gradient.r0) / 65536.0f;
                fill.x1 = static_cast<float>(paint.u.radial_gradient.c1.x) / 65536.0f;
                fill.y1 = static_cast<float>(paint.u.radial_gradient.c1.y) / 65536.0f;
                fill.r1 = static_cast<float>(paint.u.radial_gradient.r1) / 65536.0f;
                renderGlyphFill(glyphToPaint, fill);
                break;
            }
            case FT_COLR_PAINTFORMAT_SWEEP_GRADIENT: {
                auto stops = colorStops(face, paint.u.sweep_gradient.colorline, foreground);
                if (stops.empty()) {
                    unsupported = true;
                    break;
                }
                PaintFill fill;
                fill.kind = PaintKind::Sweep;
                fill.stops = std::move(stops);
                fill.x0 = static_cast<float>(paint.u.sweep_gradient.center.x) / 65536.0f;
                fill.y0 = static_cast<float>(paint.u.sweep_gradient.center.y) / 65536.0f;
                renderGlyphFill(glyphToPaint, fill);
                break;
            }
            case FT_COLR_PAINTFORMAT_COMPOSITE:
                if (paint.u.composite.composite_mode == FT_COLR_COMPOSITE_SRC_OVER) {
                    self(self, paint.u.composite.backdrop_paint, glyphToPaint, depth + 1);
                    self(self, paint.u.composite.source_paint, glyphToPaint, depth + 1);
                    break;
                }
                if (paint.u.composite.composite_mode == FT_COLR_COMPOSITE_SRC_IN) {
                    self(self, paint.u.composite.backdrop_paint, glyphToPaint, depth + 1);
                    std::vector<uint8_t> backdrop = *targetPixels;
                    std::vector<uint8_t> source(backdrop.size(), 0);
                    targetPixels = &source;
                    self(self, paint.u.composite.source_paint, glyphToPaint, depth + 1);
                    targetPixels = &pixels;
                    for (size_t index = 0; index < pixels.size(); index += 4) {
                        int clipAlpha = backdrop[index + 3];
                        int sourceAlpha = (static_cast<int>(source[index + 3]) * clipAlpha) / 255;
                        if (sourceAlpha == 0) continue;
                        int inverseAlpha = 255 - sourceAlpha;
                        pixels[index] = static_cast<uint8_t>((static_cast<int>(source[index]) * sourceAlpha + static_cast<int>(pixels[index]) * inverseAlpha) / 255);
                        pixels[index + 1] = static_cast<uint8_t>((static_cast<int>(source[index + 1]) * sourceAlpha + static_cast<int>(pixels[index + 1]) * inverseAlpha) / 255);
                        pixels[index + 2] = static_cast<uint8_t>((static_cast<int>(source[index + 2]) * sourceAlpha + static_cast<int>(pixels[index + 2]) * inverseAlpha) / 255);
                        pixels[index + 3] = static_cast<uint8_t>(sourceAlpha + (static_cast<int>(pixels[index + 3]) * inverseAlpha) / 255);
                    }
                    break;
                }
                {
                    unsupported = true;
                    unsupportedFormat = static_cast<int>(paint.format);
                    unsupportedComposite = static_cast<int>(paint.u.composite.composite_mode);
                    break;
                }
            default:
                unsupported = true;
                unsupportedFormat = static_cast<int>(paint.format);
                break;
        }
    };
    renderPaint(renderPaint, rootPaint, baseGlyphIndex, 0);
    if (!rendered || unsupported) {
        static std::unordered_set<uint32_t> loggedUnsupported;
        if (loggedUnsupported.count(baseGlyphIndex) == 0) {
            loggedUnsupported.insert(baseGlyphIndex);
            __android_log_print(ANDROID_LOG_WARN, "CoderFont", "COLRv1 unsupported glyph=%u rendered=%d format=%d composite=%d", baseGlyphIndex, rendered ? 1 : 0, unsupportedFormat, unsupportedComposite);
        }
        return false;
    }
    return true;
}

bool CoderFont::init() {
    return rebuildAtlas();
}

void CoderFont::setFontData(const uint8_t* data, size_t length) {
    setFontData(data, length, nullptr, 0, nullptr, 0, nullptr, 0);
}

void CoderFont::setFontData(const uint8_t* regularData, size_t regularLength, const uint8_t* boldData, size_t boldLength, const uint8_t* italicData, size_t italicLength, const uint8_t* boldItalicData, size_t boldItalicLength) {
    auto assignData = [](std::vector<uint8_t>& target, const uint8_t* data, size_t length) {
        if (data == nullptr || length == 0) target.clear(); else target.assign(data, data + length);
    };
    assignData(primaryFaces_[0].data, regularData, regularLength);
    assignData(primaryFaces_[1].data, boldData, boldLength);
    assignData(primaryFaces_[2].data, italicData, italicLength);
    assignData(primaryFaces_[3].data, boldItalicData, boldItalicLength);
    releaseFace();
    if (texture_ != 0) rebuildAtlas();
}

void CoderFont::setCellSize(int width, int height) {
    if (glyphWidth_ == width && glyphHeight_ == height) return;
    glyphWidth_ = std::max(1, width);
    glyphHeight_ = std::max(1, height);
    baseline_ = static_cast<int>(glyphHeight_ * 0.78f);
    releaseFace();
    if (texture_ != 0) rebuildAtlas();
}

void CoderFont::setLigaturesEnabled(bool enabled) {
    ligaturesEnabled_ = enabled;
}

bool CoderFont::glyph(uint32_t codepoint, uint32_t flags, Glyph& outGlyph) {
    uint32_t index = styleIndex(flags);
    uint64_t key = (static_cast<uint64_t>(index) << 56u) | codepoint;
    auto existing = glyphs_.find(key);
    if (existing != glyphs_.end()) {
        outGlyph = existing->second;
        return true;
    }
    if (!loadPrimaryFace(index)) index = 0;
    uint32_t glyphIndex = primaryFaces_[index].face ? FT_Get_Char_Index(primaryFaces_[index].face, static_cast<FT_ULong>(codepoint)) : 0;
    if (glyphIndex != 0 && allocateGlyph(key, primaryFaces_[index].face, glyphIndex, outGlyph)) return true;
    if (index != 0 && loadPrimaryFace(0)) {
        glyphIndex = FT_Get_Char_Index(primaryFaces_[0].face, static_cast<FT_ULong>(codepoint));
        if (glyphIndex != 0 && allocateGlyph(codepoint, primaryFaces_[0].face, glyphIndex, outGlyph)) {
            glyphs_[key] = outGlyph;
            return true;
        }
    }
    if (loadFallbackFaces()) {
        for (size_t fallbackIndex = 0; fallbackIndex < fallbackFaces_.size(); fallbackIndex++) {
            auto& fallback = fallbackFaces_[fallbackIndex];
            glyphIndex = FT_Get_Char_Index(fallback.face, static_cast<FT_ULong>(codepoint));
            if (glyphIndex != 0 && allocateGlyph((static_cast<uint64_t>(fallbackIndex + 8) << 56u) | codepoint, fallback.face, glyphIndex, outGlyph)) {
                glyphs_[key] = outGlyph;
                return true;
            }
        }
    }
    logMissingGlyph(codepoint);
    if (codepoint != '?') return glyph('?', flags, outGlyph);
    return false;
}

bool CoderFont::glyphByIndex(uint32_t glyphIndex, uint32_t flags, Glyph& outGlyph) {
    uint32_t index = styleIndex(flags);
    uint64_t key = (static_cast<uint64_t>(index + 16) << 56u) | glyphIndex;
    auto existing = glyphs_.find(key);
    if (existing != glyphs_.end()) {
        outGlyph = existing->second;
        return true;
    }
    if (!loadPrimaryFace(index)) index = 0;
    return allocateGlyph(key, primaryFaces_[index].face, glyphIndex, outGlyph);
}

bool CoderFont::fallbackGlyphByIndex(uint32_t glyphIndex, uint32_t fallbackIndex, Glyph& outGlyph) {
    uint64_t key = (static_cast<uint64_t>(fallbackIndex + 32) << 56u) | glyphIndex;
    auto existing = glyphs_.find(key);
    if (existing != glyphs_.end()) {
        outGlyph = existing->second;
        return true;
    }
    return loadFallbackFaces() && fallbackIndex < fallbackFaces_.size() && allocateGlyph(key, fallbackFaces_[fallbackIndex].face, glyphIndex, outGlyph);
}

std::vector<CoderFont::ShapedGlyph> CoderFont::shape(const uint32_t* codepoints, uint32_t codepointCount, uint32_t flags) {
    if (!ligaturesEnabled_) return {};
    if (codepointCount < 2) return {};
    bool emojiCluster = false;
    for (uint32_t index = 0; index < codepointCount; index++) {
        uint32_t codepoint = codepoints[index];
        if (codepoint == 0x200d || (codepoint >= 0x1f3fb && codepoint <= 0x1f3ff) || (codepoint >= 0xfe00 && codepoint <= 0xfe0f)) emojiCluster = true;
    }
    uint32_t index = styleIndex(flags);
    if (!loadPrimaryFace(index)) index = 0;
    if (!primaryFaces_[index].harfbuzzFont) return {};
    auto shaped = shapeWithFont(primaryFaces_[index].harfbuzzFont, codepoints, codepointCount, UINT32_MAX);
    bool primaryRenderable = !shaped.empty();
    for (const auto& shapedGlyph : shaped) {
        Glyph glyph;
        if (shapedGlyph.glyphId == 0 || !glyphByIndex(shapedGlyph.glyphId, flags, glyph)) {
            primaryRenderable = false;
            break;
        }
    }
    if (primaryRenderable) return shaped;
    if (!loadFallbackFaces()) return shaped;
    if (emojiCluster) {
        for (uint32_t fallbackIndex = 0; fallbackIndex < fallbackFaces_.size(); fallbackIndex++) {
            auto fallbackShaped = shapeWithFont(fallbackFaces_[fallbackIndex].harfbuzzFont, codepoints, codepointCount, fallbackIndex);
            bool fallbackRenderable = !fallbackShaped.empty();
            for (const auto& shapedGlyph : fallbackShaped) {
                Glyph glyph;
                if (shapedGlyph.glyphId == 0 || !fallbackGlyphByIndex(shapedGlyph.glyphId, fallbackIndex, glyph)) {
                    fallbackRenderable = false;
                    break;
                }
            }
            if (fallbackRenderable) return fallbackShaped;
        }
    }
    struct RunFont {
        hb_font_t* harfbuzzFont = nullptr;
        uint32_t fallbackIndex = UINT32_MAX;
    };
    auto fontForCodepoint = [&](uint32_t codepoint) -> RunFont {
        if (primaryFaces_[index].face && FT_Get_Char_Index(primaryFaces_[index].face, static_cast<FT_ULong>(codepoint)) != 0) return {primaryFaces_[index].harfbuzzFont, UINT32_MAX};
        if (index != 0 && loadPrimaryFace(0) && primaryFaces_[0].face && FT_Get_Char_Index(primaryFaces_[0].face, static_cast<FT_ULong>(codepoint)) != 0) return {primaryFaces_[0].harfbuzzFont, UINT32_MAX};
        for (uint32_t fallbackIndex = 0; fallbackIndex < fallbackFaces_.size(); fallbackIndex++) {
            if (FT_Get_Char_Index(fallbackFaces_[fallbackIndex].face, static_cast<FT_ULong>(codepoint)) != 0) return {fallbackFaces_[fallbackIndex].harfbuzzFont, fallbackIndex};
        }
        return {};
    };
    std::vector<ShapedGlyph> mixedShaped;
    uint32_t runStart = 0;
    while (runStart < codepointCount) {
        RunFont runFont = fontForCodepoint(codepoints[runStart]);
        if (!runFont.harfbuzzFont) return shaped;
        uint32_t runEnd = runStart + 1;
        while (runEnd < codepointCount) {
            RunFont nextFont = fontForCodepoint(codepoints[runEnd]);
            if (nextFont.harfbuzzFont != runFont.harfbuzzFont || nextFont.fallbackIndex != runFont.fallbackIndex) break;
            runEnd++;
        }
        auto runShaped = shapeWithFont(runFont.harfbuzzFont, codepoints + runStart, runEnd - runStart, runFont.fallbackIndex);
        if (runShaped.empty()) return shaped;
        mixedShaped.insert(mixedShaped.end(), runShaped.begin(), runShaped.end());
        runStart = runEnd;
    }
    bool mixedRenderable = !mixedShaped.empty();
    for (const auto& shapedGlyph : mixedShaped) {
        Glyph glyph;
        bool loaded = shapedGlyph.fallbackIndex == UINT32_MAX ? glyphByIndex(shapedGlyph.glyphId, flags, glyph) : fallbackGlyphByIndex(shapedGlyph.glyphId, shapedGlyph.fallbackIndex, glyph);
        if (shapedGlyph.glyphId == 0 || !loaded) {
            mixedRenderable = false;
            break;
        }
    }
    if (mixedRenderable) return mixedShaped;
    for (uint32_t fallbackIndex = 0; fallbackIndex < fallbackFaces_.size(); fallbackIndex++) {
        auto fallbackShaped = shapeWithFont(fallbackFaces_[fallbackIndex].harfbuzzFont, codepoints, codepointCount, fallbackIndex);
        bool fallbackRenderable = !fallbackShaped.empty();
        for (const auto& shapedGlyph : fallbackShaped) {
            Glyph glyph;
            if (shapedGlyph.glyphId == 0 || !fallbackGlyphByIndex(shapedGlyph.glyphId, fallbackIndex, glyph)) {
                fallbackRenderable = false;
                break;
            }
        }
        if (fallbackRenderable) return fallbackShaped;
    }
    return shaped;
}

std::vector<CoderFont::ShapedGlyph> CoderFont::shapeWithFont(hb_font_t* font, const uint32_t* codepoints, uint32_t codepointCount, uint32_t fallbackIndex) {
    std::vector<ShapedGlyph> shaped;
    if (!font || codepointCount == 0) return shaped;
    hb_buffer_t* buffer = hb_buffer_create();
    hb_buffer_add_codepoints(buffer, codepoints, codepointCount, 0, codepointCount);
    hb_buffer_guess_segment_properties(buffer);
    hb_shape(font, buffer, nullptr, 0);
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
            fallbackIndex,
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
    atlasFullReported_ = false;
    if (!loadPrimaryFace(0)) return false;
    updateMetricsFromFace(primaryFaces_[0].face);
    GLint maxTextureSize = 0;
    glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTextureSize);
    int targetAtlasSize = maxTextureSize > 0 ? std::min(maxTextureSize, 8192) : 4096;
    atlasWidth_ = std::max(1024, targetAtlasSize);
    atlasHeight_ = std::max(1024, targetAtlasSize);
    __android_log_print(ANDROID_LOG_INFO, "CoderFont", "glyph atlas size=%dx%d max_texture_size=%d", atlasWidth_, atlasHeight_, maxTextureSize);
    if (texture_ == 0) glGenTextures(1, &texture_);
    glBindTexture(GL_TEXTURE_2D, texture_);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    std::vector<uint8_t> empty(static_cast<size_t>(atlasWidth_ * atlasHeight_ * 4), 0);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, atlasWidth_, atlasHeight_, 0, GL_RGBA, GL_UNSIGNED_BYTE, empty.data());
    for (uint32_t codepoint = 33; codepoint < 127; codepoint++) {
        Glyph ignored;
        glyph(codepoint, 0, ignored);
    }
    return texture_ != 0;
}

bool CoderFont::loadPrimaryFace(size_t index) {
    if (index >= primaryFaces_.size()) return false;
    auto& font = primaryFaces_[index];
    if (font.face) return true;
    if (font.data.empty() && index != 0) return loadPrimaryFace(0);
    if (font.data.empty()) return false;
    if (!library_ && FT_Init_FreeType(&library_) != 0) return false;
    if (FT_New_Memory_Face(library_, font.data.data(), static_cast<FT_Long>(font.data.size()), 0, &font.face) != 0) return false;
    if (!configureFaceSize(font.face)) {
        FT_Done_Face(font.face);
        font.face = nullptr;
        return false;
    }
    font.harfbuzzFont = hb_ft_font_create_referenced(font.face);
    return font.harfbuzzFont != nullptr;
}

bool CoderFont::loadFallbackFaces() {
    if (!fallbackFaces_.empty()) return true;
    if (!library_ && FT_Init_FreeType(&library_) != 0) return false;
    static constexpr std::array<const char*, 12> paths{
        "/system/fonts/NotoColorEmoji.ttf",
        "/system/fonts/NotoColorEmojiFlags.ttf",
        "/system/fonts/AndroidEmoji.ttf",
        "/product/fonts/NotoColorEmoji.ttf",
        "/system/fonts/NotoSansCJK-Regular.ttc",
        "/system/fonts/NotoSansJP-Regular.otf",
        "/system/fonts/NotoSansSC-Regular.otf",
        "/system/fonts/NotoSansTC-Regular.otf",
        "/system/fonts/NotoSansArabic-Regular.ttf",
        "/system/fonts/NotoNaskhArabic-Regular.ttf",
        "/system/fonts/DroidSansFallback.ttf",
        "/product/fonts/DroidSansFallback.ttf",
    };
    for (const char* path : paths) {
        FontFace font;
        if (FT_New_Face(library_, path, 0, &font.face) == 0) {
            FT_Select_Charmap(font.face, FT_ENCODING_UNICODE);
            configureFaceSize(font.face);
            font.harfbuzzFont = hb_ft_font_create_referenced(font.face);
            font.fallback = true;
            font.color = std::string(path).find("Emoji") != std::string::npos;
            if (font.color) {
                __android_log_print(ANDROID_LOG_INFO, "CoderFont", "emoji face path=%s fixed_sizes=%d scalable=%d current_ppem=%dx%d", path, font.face->num_fixed_sizes, FT_IS_SCALABLE(font.face) ? 1 : 0, font.face->size ? font.face->size->metrics.x_ppem : 0, font.face->size ? font.face->size->metrics.y_ppem : 0);
                for (FT_Int index = 0; index < font.face->num_fixed_sizes && index < 8; index++) {
                    __android_log_print(ANDROID_LOG_INFO, "CoderFont", "emoji strike index=%d ppem=%dx%d pixels=%dx%d", index, static_cast<int>((font.face->available_sizes[index].x_ppem + 32) >> 6), static_cast<int>((font.face->available_sizes[index].y_ppem + 32) >> 6), font.face->available_sizes[index].width, font.face->available_sizes[index].height);
                }
            }
            if (font.harfbuzzFont) fallbackFaces_.push_back(std::move(font)); else FT_Done_Face(font.face);
        }
    }
    return !fallbackFaces_.empty();
}

bool CoderFont::configureFaceSize(FT_Face face) {
    if (!face) return false;
    if (face->num_fixed_sizes > 0 && face->available_sizes) {
        FT_Int bestIndex = 0;
        int bestDistance = std::abs(static_cast<int>((face->available_sizes[0].y_ppem + 32) >> 6) - glyphHeight_);
        for (FT_Int index = 1; index < face->num_fixed_sizes; index++) {
            int height = static_cast<int>((face->available_sizes[index].y_ppem + 32) >> 6);
            int distance = std::abs(height - glyphHeight_);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = index;
            }
        }
        return FT_Select_Size(face, bestIndex) == 0;
    }
    return FT_Set_Pixel_Sizes(face, 0, static_cast<FT_UInt>(glyphHeight_)) == 0;
}

void CoderFont::updateMetricsFromFace(FT_Face face) {
    if (!face || !face->size) return;
    int ascender = static_cast<int>((face->size->metrics.ascender + 32) >> 6);
    int descender = static_cast<int>((face->size->metrics.descender - 32) >> 6);
    int measuredHeight = static_cast<int>((face->size->metrics.height + 32) >> 6);
    int inkHeight = std::max(1, ascender - descender);
    baseline_ = std::clamp(static_cast<int>(std::round(static_cast<float>(glyphHeight_) * static_cast<float>(ascender) / static_cast<float>(inkHeight))), glyphHeight_ / 2, std::max(1, glyphHeight_ - 1));
    static int loggedMetrics = 0;
    if (loggedMetrics < 8) {
        __android_log_print(ANDROID_LOG_INFO, "CoderFont", "font metrics cell=%dx%d ascender=%d descender=%d face_height=%d baseline=%d", glyphWidth_, glyphHeight_, ascender, descender, measuredHeight, baseline_);
        loggedMetrics++;
    }
}

uint32_t CoderFont::styleIndex(uint32_t flags) const {
    bool bold = (flags & 1u) != 0u;
    bool italic = (flags & 2u) != 0u;
    if (bold && italic) return 3;
    if (bold) return 1;
    if (italic) return 2;
    return 0;
}

bool CoderFont::allocateGlyph(uint64_t key, FT_Face face, uint32_t glyphIndex, Glyph& outGlyph) {
    if (!face) return false;
    if (!configureFaceSize(face)) return false;
    int loadResult = FT_Load_Glyph(face, glyphIndex, FT_LOAD_RENDER | FT_LOAD_TARGET_LIGHT | FT_LOAD_COLOR);
    if (loadResult != 0) loadResult = FT_Load_Glyph(face, glyphIndex, FT_LOAD_RENDER | FT_LOAD_COLOR);
    if (loadResult == 0 && face->glyph->bitmap.width == 0 && face->glyph->bitmap.rows == 0) {
        int colorLoadResult = FT_Load_Glyph(face, glyphIndex, FT_LOAD_DEFAULT | FT_LOAD_COLOR);
        if (colorLoadResult == 0) {
            int renderResult = FT_Render_Glyph(face->glyph, FT_RENDER_MODE_NORMAL);
            if (renderResult == 0) loadResult = 0;
        }
    }
    if (loadResult == 0 && face->glyph->bitmap.width == 0 && face->glyph->bitmap.rows == 0) {
        int outlineLoadResult = FT_Load_Glyph(face, glyphIndex, FT_LOAD_DEFAULT);
        if (outlineLoadResult == 0) {
            int renderResult = FT_Render_Glyph(face->glyph, FT_RENDER_MODE_NORMAL);
            if (renderResult == 0) loadResult = 0;
        }
    }
    if (loadResult != 0) {
        uint32_t loggedCodepoint = static_cast<uint32_t>(key & ((1ULL << 56u) - 1ULL));
        if (loggedCodepoint >= 0x1f000) __android_log_print(ANDROID_LOG_WARN, "CoderFont", "emoji load failed cp=U+%04X glyph=%u error=%d fixed_sizes=%d scalable=%d", loggedCodepoint, glyphIndex, loadResult, face->num_fixed_sizes, FT_IS_SCALABLE(face) ? 1 : 0);
        return false;
    }
    FT_GlyphSlot slot = face->glyph;
    int bitmapWidth = static_cast<int>(slot->bitmap.width);
    int bitmapHeight = static_cast<int>(slot->bitmap.rows);
    uint32_t loggedCodepoint = static_cast<uint32_t>(key & ((1ULL << 56u) - 1ULL));
    if (bitmapWidth == 0 || bitmapHeight == 0) {
        std::vector<uint8_t> colrPixels;
        int colrBearingLeft = 0;
        int colrBearingTop = 0;
        int colrAdvance = 0;
        if (renderSolidColrGlyph(face, glyphIndex, glyphWidth_, glyphHeight_, 0xffffffu, colrPixels, bitmapWidth, bitmapHeight, colrBearingLeft, colrBearingTop, colrAdvance)) {
            int paddedWidth = std::max(1, bitmapWidth) + 2;
            int paddedHeight = std::max(1, bitmapHeight) + 2;
            if (shelfX_ + paddedWidth >= atlasWidth_) {
                shelfX_ = 1;
                shelfY_ += shelfHeight_ + 1;
                shelfHeight_ = 0;
            }
            if (shelfY_ + paddedHeight >= atlasHeight_) {
                if (!atlasFullReported_) {
                    __android_log_print(ANDROID_LOG_WARN, "CoderFont", "glyph atlas full width=%d height=%d glyphs=%zu colr=1", atlasWidth_, atlasHeight_, glyphs_.size());
                    atlasFullReported_ = true;
                }
                return false;
            }
            int atlasX = shelfX_ + 1;
            int atlasY = shelfY_ + 1;
            shelfX_ += paddedWidth;
            shelfHeight_ = std::max(shelfHeight_, paddedHeight);
            glBindTexture(GL_TEXTURE_2D, texture_);
            glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
            glTexSubImage2D(GL_TEXTURE_2D, 0, atlasX, atlasY, bitmapWidth, bitmapHeight, GL_RGBA, GL_UNSIGNED_BYTE, colrPixels.data());
            Glyph glyph;
            glyph.u0 = static_cast<float>(atlasX) / static_cast<float>(atlasWidth_);
            glyph.v0 = static_cast<float>(atlasY) / static_cast<float>(atlasHeight_);
            glyph.u1 = static_cast<float>(atlasX + bitmapWidth) / static_cast<float>(atlasWidth_);
            glyph.v1 = static_cast<float>(atlasY + bitmapHeight) / static_cast<float>(atlasHeight_);
            glyph.width = bitmapWidth;
            glyph.height = bitmapHeight;
            glyph.bearingLeft = colrBearingLeft;
            glyph.bearingTop = colrBearingTop;
            glyph.advance = colrAdvance;
            glyph.color = true;
            glyphs_[key] = glyph;
            outGlyph = glyph;
            return true;
        }
        static std::unordered_set<uint64_t> loggedEmptyGlyphs;
        if (loggedCodepoint >= 0x1f000 && loggedEmptyGlyphs.count(key) == 0) {
            loggedEmptyGlyphs.insert(key);
            logColorGlyphDetails(face, loggedCodepoint, glyphIndex);
            __android_log_print(ANDROID_LOG_WARN, "CoderFont", "emoji glyph has no bitmap cp=U+%04X glyph=%u format=%lu fixed_sizes=%d scalable=%d", loggedCodepoint, glyphIndex, static_cast<unsigned long>(slot->format), face->num_fixed_sizes, FT_IS_SCALABLE(face) ? 1 : 0);
        }
        return false;
    }
    int paddedWidth = std::max(1, bitmapWidth) + 2;
    int paddedHeight = std::max(1, bitmapHeight) + 2;
    if (shelfX_ + paddedWidth >= atlasWidth_) {
        shelfX_ = 1;
        shelfY_ += shelfHeight_ + 1;
        shelfHeight_ = 0;
    }
    if (shelfY_ + paddedHeight >= atlasHeight_) {
        if (!atlasFullReported_) {
            __android_log_print(ANDROID_LOG_WARN, "CoderFont", "glyph atlas full width=%d height=%d glyphs=%zu", atlasWidth_, atlasHeight_, glyphs_.size());
            atlasFullReported_ = true;
        }
        return false;
    }
    int atlasX = shelfX_ + 1;
    int atlasY = shelfY_ + 1;
    shelfX_ += paddedWidth;
    shelfHeight_ = std::max(shelfHeight_, paddedHeight);
    if (bitmapWidth > 0 && bitmapHeight > 0) {
        std::vector<uint8_t> convertedBuffer;
        bool color = false;
        const uint8_t* uploadBuffer = bitmapBuffer(slot->bitmap, convertedBuffer, color);
        if (!uploadBuffer) return false;
        glBindTexture(GL_TEXTURE_2D, texture_);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
        glTexSubImage2D(GL_TEXTURE_2D, 0, atlasX, atlasY, bitmapWidth, bitmapHeight, GL_RGBA, GL_UNSIGNED_BYTE, uploadBuffer);
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
    glyph.color = slot->bitmap.pixel_mode == FT_PIXEL_MODE_BGRA;
    if (loggedCodepoint >= 0x1f000 && glyph.width > 0 && glyph.height > 0) {
        __android_log_print(ANDROID_LOG_INFO, "CoderFont", "emoji glyph key=%llu cp=U+%04X size=%dx%d bearing=%d,%d advance=%d color=%d pixel_mode=%d", static_cast<unsigned long long>(key), loggedCodepoint, glyph.width, glyph.height, glyph.bearingLeft, glyph.bearingTop, glyph.advance, glyph.color ? 1 : 0, slot->bitmap.pixel_mode);
    } else if (key >= (8ULL << 56u) && glyph.width > 0 && glyph.height > 0) {
        static std::unordered_set<uint64_t> loggedFallbackGlyphs;
        if (loggedFallbackGlyphs.size() < 24 && loggedFallbackGlyphs.count(key) == 0) {
            loggedFallbackGlyphs.insert(key);
            __android_log_print(ANDROID_LOG_INFO, "CoderFont", "fallback glyph key=%llu size=%dx%d bearing=%d,%d advance=%d color=%d pixel_mode=%d", static_cast<unsigned long long>(key), glyph.width, glyph.height, glyph.bearingLeft, glyph.bearingTop, glyph.advance, glyph.color ? 1 : 0, slot->bitmap.pixel_mode);
        }
    }
    glyphs_[key] = glyph;
    outGlyph = glyph;
    return true;
}

const uint8_t* CoderFont::bitmapBuffer(const FT_Bitmap& bitmap, std::vector<uint8_t>& convertedBuffer, bool& color) {
    convertedBuffer.assign(static_cast<size_t>(bitmap.width * bitmap.rows * 4), 0);
    for (uint32_t y = 0; y < bitmap.rows; y++) {
        const uint8_t* source = bitmap.buffer + y * std::abs(bitmap.pitch);
        uint8_t* target = convertedBuffer.data() + static_cast<size_t>(y * bitmap.width * 4);
        if (bitmap.pixel_mode == FT_PIXEL_MODE_GRAY) {
            for (uint32_t x = 0; x < bitmap.width; x++) {
                target[x * 4] = 255;
                target[x * 4 + 1] = 255;
                target[x * 4 + 2] = 255;
                target[x * 4 + 3] = source[x];
            }
        } else if (bitmap.pixel_mode == FT_PIXEL_MODE_BGRA) {
            color = true;
            for (uint32_t x = 0; x < bitmap.width; x++) {
                target[x * 4] = source[x * 4 + 2];
                target[x * 4 + 1] = source[x * 4 + 1];
                target[x * 4 + 2] = source[x * 4];
                target[x * 4 + 3] = source[x * 4 + 3];
            }
        } else if (bitmap.pixel_mode == FT_PIXEL_MODE_MONO) {
            for (uint32_t x = 0; x < bitmap.width; x++) {
                uint8_t alpha = (source[x >> 3] & (0x80 >> (x & 7))) ? 255 : 0;
                target[x * 4] = 255;
                target[x * 4 + 1] = 255;
                target[x * 4 + 2] = 255;
                target[x * 4 + 3] = alpha;
            }
        } else {
            return nullptr;
        }
    }
    return convertedBuffer.data();
}

void CoderFont::releaseFace() {
    auto releaseFont = [](FontFace& font) {
        if (font.harfbuzzFont) {
            hb_font_destroy(font.harfbuzzFont);
            font.harfbuzzFont = nullptr;
        }
        if (font.face) {
            FT_Done_Face(font.face);
            font.face = nullptr;
        }
    };
    for (auto& font : primaryFaces_) releaseFont(font);
    for (auto& font : fallbackFaces_) releaseFont(font);
    fallbackFaces_.clear();
    if (library_) {
        FT_Done_FreeType(library_);
        library_ = nullptr;
    }
}
