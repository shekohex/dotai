#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <ghostty/vt.h>

struct CoderCell {
    std::array<uint32_t, 8> codepoints;
    uint32_t codepointCount;
    uint32_t foreground;
    uint32_t background;
    uint32_t flags;
};

bool operator==(const CoderCell& lhs, const CoderCell& rhs);

class CoderTerminal {
public:
    CoderTerminal();
    ~CoderTerminal();

    bool start(int cols, int rows, int cellWidth, int cellHeight, const char* bashPath, const char* busyBoxPath, const char* toolsDir);
    void resize(int cols, int rows, int cellWidth, int cellHeight);
    void pump();
    void writeUtf8(const char* data, int length);
    void feed(const uint8_t* data, size_t length);
    void key(int keyCode, int unicodeChar, int metaState);
    void setTheme(uint32_t foreground, uint32_t background, uint32_t cursor, const uint32_t* palette, size_t paletteLength);
    void scroll(int rowDelta);
    std::vector<CoderCell> snapshot(int& cols, int& rows, int& cursorCol, int& cursorRow);

private:
    bool spawnPty(int cellWidth, int cellHeight);
    void writePty(const uint8_t* data, size_t length);
    uint32_t rgb(GhosttyColorRgb color) const;
    GhosttyKey mapAndroidKey(int keyCode) const;
    GhosttyMods mapAndroidMods(int metaState) const;
    static void writePtyEffect(GhosttyTerminal terminal, void* userdata, const uint8_t* data, size_t length);
    static bool sizeEffect(GhosttyTerminal terminal, void* userdata, GhosttySizeReportSize* outSize);
    static bool deviceAttributesEffect(GhosttyTerminal terminal, void* userdata, GhosttyDeviceAttributes* outAttributes);
    static GhosttyString xtversionEffect(GhosttyTerminal terminal, void* userdata);

    struct TerminalDeleter { void operator()(GhosttyTerminal terminal) const; };
    struct RenderStateDeleter { void operator()(GhosttyRenderState state) const; };
    struct RowIteratorDeleter { void operator()(GhosttyRenderStateRowIterator iterator) const; };
    struct RowCellsDeleter { void operator()(GhosttyRenderStateRowCells cells) const; };
    struct KeyEncoderDeleter { void operator()(GhosttyKeyEncoder encoder) const; };
    struct KeyEventDeleter { void operator()(GhosttyKeyEvent event) const; };

    using TerminalHandle = std::unique_ptr<GhosttyTerminalImpl, TerminalDeleter>;
    using RenderStateHandle = std::unique_ptr<GhosttyRenderStateImpl, RenderStateDeleter>;
    using RowIteratorHandle = std::unique_ptr<GhosttyRenderStateRowIteratorImpl, RowIteratorDeleter>;
    using RowCellsHandle = std::unique_ptr<GhosttyRenderStateRowCellsImpl, RowCellsDeleter>;
    using KeyEncoderHandle = std::unique_ptr<GhosttyKeyEncoderImpl, KeyEncoderDeleter>;
    using KeyEventHandle = std::unique_ptr<GhosttyKeyEventImpl, KeyEventDeleter>;

    TerminalHandle terminal_;
    RenderStateHandle renderState_;
    RowIteratorHandle rowIterator_;
    RowCellsHandle rowCells_;
    KeyEncoderHandle keyEncoder_;
    KeyEventHandle keyEvent_;

    std::mutex mutex_;
    int ptyFd_ = -1;
    int childPid_ = -1;
    std::string bashPath_;
    std::string busyBoxPath_;
    int cols_ = 80;
    int rows_ = 24;
    int cellWidth_ = 0;
    int cellHeight_ = 0;
    int cursorCol_ = 0;
    int cursorRow_ = 0;
    std::vector<CoderCell> cells_;
};
