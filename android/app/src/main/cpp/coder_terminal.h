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
    uint32_t underlineColor;
    uint32_t flags;
    GhosttyCellWide wide;
};

struct CoderCursor {
    int col = -1;
    int row = -1;
    bool visible = true;
    bool blinking = true;
    bool wideTail = false;
    bool colorHasValue = false;
    uint32_t color = 0;
    GhosttyRenderStateCursorVisualStyle visualStyle = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
};

bool operator==(const CoderCell& lhs, const CoderCell& rhs);

class CoderTerminal {
public:
    CoderTerminal();
    ~CoderTerminal();

    bool start(int cols, int rows, int cellWidth, int cellHeight);
    void resize(int cols, int rows, int cellWidth, int cellHeight);
    void pump();
    bool pumpAndSynchronizedOutput();
    void writeUtf8(const char* data, int length);
    std::vector<uint8_t> encodePaste(const uint8_t* data, size_t length);
    std::vector<uint8_t> encodeFocus(bool focused);
    void feed(const uint8_t* data, size_t length);
    void key(int keyCode, int unicodeChar, int metaState);
    void setPreedit(const char* data, size_t length);
    void setTheme(uint32_t foreground, uint32_t background, uint32_t cursor, uint32_t selectionForeground, uint32_t selectionBackground, const uint32_t* palette, size_t paletteLength);
    void scroll(int rowDelta);
    std::vector<uint8_t> scrollInput(int rowDelta, float x, float y);
    bool mouseTracking() const;
    bool synchronizedOutput() const;
    std::vector<uint8_t> mouse(int action, float x, float y, int button, int metaState);
    bool screenPositionFromViewport(int row, int col, int& screenRow, int& screenCol);
    void setSelection(bool active, int startRow, int startCol, int endRow, int endCol);
    std::string copySelection();
    std::string title();
    std::string pwd();
    uint64_t bellCount();
    std::string hyperlinkUriAt(int row, int col);
    std::vector<std::string> consumeOscEvents();
    std::string selectedText(int startRow, int startCol, int endRow, int endCol);
    std::vector<CoderCell> snapshot(int& cols, int& rows, int& cursorCol, int& cursorRow);
    std::vector<CoderCell> snapshot(int& cols, int& rows, CoderCursor& cursor);
    bool snapshot(int& cols, int& rows, CoderCursor& cursor, std::vector<CoderCell>& outputCells, uint64_t& generation, std::vector<uint8_t>* dirtyRows = nullptr);

private:
    void pumpLocked();
    void writePty(const uint8_t* data, size_t length);
    void processOscMetadata(const uint8_t* data, size_t length);
    void finishOscMetadata();
    void updateTitle();
    void updatePwd();
    uint32_t rgb(GhosttyColorRgb color) const;
    GhosttyKey mapAndroidKey(int keyCode) const;
    GhosttyMods mapAndroidMods(int metaState) const;
    static std::string sanitizeGhosttyString(GhosttyString value, size_t maxBytes);
    static std::string sanitizeBytes(const uint8_t* data, size_t length, size_t maxBytes);
    static void writePtyEffect(GhosttyTerminal terminal, void* userdata, const uint8_t* data, size_t length);
    static void titleChangedEffect(GhosttyTerminal terminal, void* userdata);
    static void bellEffect(GhosttyTerminal terminal, void* userdata);
    static bool sizeEffect(GhosttyTerminal terminal, void* userdata, GhosttySizeReportSize* outSize);
    static bool colorSchemeEffect(GhosttyTerminal terminal, void* userdata, GhosttyColorScheme* outScheme);
    static bool deviceAttributesEffect(GhosttyTerminal terminal, void* userdata, GhosttyDeviceAttributes* outAttributes);
    static GhosttyString xtversionEffect(GhosttyTerminal terminal, void* userdata);

    struct TerminalDeleter { void operator()(GhosttyTerminal terminal) const; };
    struct RenderStateDeleter { void operator()(GhosttyRenderState state) const; };
    struct RowIteratorDeleter { void operator()(GhosttyRenderStateRowIterator iterator) const; };
    struct RowCellsDeleter { void operator()(GhosttyRenderStateRowCells cells) const; };
    struct KeyEncoderDeleter { void operator()(GhosttyKeyEncoder encoder) const; };
    struct KeyEventDeleter { void operator()(GhosttyKeyEvent event) const; };
    struct MouseEncoderDeleter { void operator()(GhosttyMouseEncoder encoder) const; };
    struct MouseEventDeleter { void operator()(GhosttyMouseEvent event) const; };

    using TerminalHandle = std::unique_ptr<GhosttyTerminalImpl, TerminalDeleter>;
    using RenderStateHandle = std::unique_ptr<GhosttyRenderStateImpl, RenderStateDeleter>;
    using RowIteratorHandle = std::unique_ptr<GhosttyRenderStateRowIteratorImpl, RowIteratorDeleter>;
    using RowCellsHandle = std::unique_ptr<GhosttyRenderStateRowCellsImpl, RowCellsDeleter>;
    using KeyEncoderHandle = std::unique_ptr<GhosttyKeyEncoderImpl, KeyEncoderDeleter>;
    using KeyEventHandle = std::unique_ptr<GhosttyKeyEventImpl, KeyEventDeleter>;
    using MouseEncoderHandle = std::unique_ptr<GhosttyMouseEncoderImpl, MouseEncoderDeleter>;
    using MouseEventHandle = std::unique_ptr<GhosttyMouseEventImpl, MouseEventDeleter>;

    TerminalHandle terminal_;
    RenderStateHandle renderState_;
    RowIteratorHandle rowIterator_;
    RowCellsHandle rowCells_;
    KeyEncoderHandle keyEncoder_;
    KeyEventHandle keyEvent_;
    MouseEncoderHandle mouseEncoder_;
    MouseEventHandle mouseEvent_;
    bool mouseButtonPressed_ = false;

    struct SelectionState {
        bool active = false;
        int startRow = 0;
        int startCol = 0;
        int endRow = 0;
        int endCol = 0;
    } selection_;

    mutable std::mutex mutex_;
    int ptyFd_ = -1;
    int childPid_ = -1;
    int cols_ = 80;
    int rows_ = 24;
    int cellWidth_ = 0;
    int cellHeight_ = 0;
    int cursorCol_ = 0;
    int cursorRow_ = 0;
    CoderCursor cursor_;
    std::vector<CoderCell> cells_;
    std::vector<uint32_t> preeditCodepoints_;
    uint64_t snapshotGeneration_ = 1;
    int snapshotPreeditCursorRow_ = -1;
    int snapshotPreeditCursorCol_ = -1;
    std::string title_;
    std::string pwd_;
    std::string oscMetadataBuffer_;
    std::vector<std::string> oscEvents_;
    uint64_t bellCount_ = 0;
    GhosttyColorScheme colorScheme_ = GHOSTTY_COLOR_SCHEME_DARK;
    uint32_t selectionForeground_ = 0xf8f8f2;
    uint32_t selectionBackground_ = 0x3a3a4a;
    bool oscMetadataEsc_ = false;
    bool oscMetadataActive_ = false;
    bool oscMetadataStEsc_ = false;
};
