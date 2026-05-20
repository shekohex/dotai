#include "coder_terminal.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <signal.h>
#include <string>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <android/log.h>

void CoderTerminal::TerminalDeleter::operator()(GhosttyTerminal terminal) const { ghostty_terminal_free(terminal); }
void CoderTerminal::RenderStateDeleter::operator()(GhosttyRenderState state) const { ghostty_render_state_free(state); }
void CoderTerminal::RowIteratorDeleter::operator()(GhosttyRenderStateRowIterator iterator) const { ghostty_render_state_row_iterator_free(iterator); }
void CoderTerminal::RowCellsDeleter::operator()(GhosttyRenderStateRowCells cells) const { ghostty_render_state_row_cells_free(cells); }
void CoderTerminal::KeyEncoderDeleter::operator()(GhosttyKeyEncoder encoder) const { ghostty_key_encoder_free(encoder); }
void CoderTerminal::KeyEventDeleter::operator()(GhosttyKeyEvent event) const { ghostty_key_event_free(event); }
void CoderTerminal::MouseEncoderDeleter::operator()(GhosttyMouseEncoder encoder) const { ghostty_mouse_encoder_free(encoder); }
void CoderTerminal::MouseEventDeleter::operator()(GhosttyMouseEvent event) const { ghostty_mouse_event_free(event); }

bool operator==(const CoderCell& lhs, const CoderCell& rhs) {
    return lhs.codepointCount == rhs.codepointCount
        && lhs.codepoints == rhs.codepoints
        && lhs.foreground == rhs.foreground
        && lhs.background == rhs.background
        && lhs.underlineColor == rhs.underlineColor
        && lhs.flags == rhs.flags
        && lhs.wide == rhs.wide;
}

CoderTerminal::CoderTerminal() = default;

CoderTerminal::~CoderTerminal() {
    if (ptyFd_ >= 0) close(ptyFd_);
    if (childPid_ > 0) {
        kill(childPid_, SIGHUP);
        waitpid(childPid_, nullptr, WNOHANG);
    }
}

bool CoderTerminal::start(int cols, int rows, int cellWidth, int cellHeight) {
    std::lock_guard lock(mutex_);
    cols_ = std::max(1, cols);
    rows_ = std::max(1, rows);
    cellWidth_ = cellWidth;
    cellHeight_ = cellHeight;
    cursorCol_ = 0;
    cursorRow_ = 0;
    cursor_ = CoderCursor{0, 0};
    cells_.assign(cols_ * rows_, CoderCell{{}, 0, 0xffd0d0d0, 0xff101014, 0xffd0d0d0, 0});

    GhosttyTerminalOptions options = { .cols = static_cast<uint16_t>(cols_), .rows = static_cast<uint16_t>(rows_), .max_scrollback = 1000 };
    GhosttyTerminal terminal = nullptr;
    GhosttyRenderState renderState = nullptr;
    GhosttyRenderStateRowIterator rowIterator = nullptr;
    GhosttyRenderStateRowCells rowCells = nullptr;
    GhosttyKeyEncoder keyEncoder = nullptr;
    GhosttyKeyEvent keyEvent = nullptr;
    GhosttyMouseEncoder mouseEncoder = nullptr;
    GhosttyMouseEvent mouseEvent = nullptr;
    if (ghostty_terminal_new(nullptr, &terminal, options) != GHOSTTY_SUCCESS) return false;
    if (ghostty_render_state_new(nullptr, &renderState) != GHOSTTY_SUCCESS) return false;
    if (ghostty_render_state_row_iterator_new(nullptr, &rowIterator) != GHOSTTY_SUCCESS) return false;
    if (ghostty_render_state_row_cells_new(nullptr, &rowCells) != GHOSTTY_SUCCESS) return false;
    if (ghostty_key_encoder_new(nullptr, &keyEncoder) != GHOSTTY_SUCCESS) return false;
    if (ghostty_key_event_new(nullptr, &keyEvent) != GHOSTTY_SUCCESS) return false;
    if (ghostty_mouse_encoder_new(nullptr, &mouseEncoder) != GHOSTTY_SUCCESS) return false;
    if (ghostty_mouse_event_new(nullptr, &mouseEvent) != GHOSTTY_SUCCESS) return false;
    terminal_.reset(terminal);
    renderState_.reset(renderState);
    rowIterator_.reset(rowIterator);
    rowCells_.reset(rowCells);
    keyEncoder_.reset(keyEncoder);
    keyEvent_.reset(keyEvent);
    mouseEncoder_.reset(mouseEncoder);
    mouseEvent_.reset(mouseEvent);

    ghostty_terminal_resize(terminal_.get(), static_cast<uint16_t>(cols_), static_cast<uint16_t>(rows_), static_cast<uint32_t>(cellWidth), static_cast<uint32_t>(cellHeight));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_USERDATA, this);
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_WRITE_PTY, reinterpret_cast<const void*>(writePtyEffect));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_TITLE_CHANGED, reinterpret_cast<const void*>(titleChangedEffect));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_BELL, reinterpret_cast<const void*>(bellEffect));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_SIZE, reinterpret_cast<const void*>(sizeEffect));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_COLOR_SCHEME, reinterpret_cast<const void*>(colorSchemeEffect));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES, reinterpret_cast<const void*>(deviceAttributesEffect));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_XTVERSION, reinterpret_cast<const void*>(xtversionEffect));

    return true;
}

void CoderTerminal::resize(int cols, int rows, int cellWidth, int cellHeight) {
    std::lock_guard lock(mutex_);
    const int nextCols = std::max(1, cols);
    const int nextRows = std::max(1, rows);
    const bool unchanged = cols_ == nextCols && rows_ == nextRows && cellWidth_ == cellWidth && cellHeight_ == cellHeight;
    cols_ = nextCols;
    rows_ = nextRows;
    cellWidth_ = cellWidth;
    cellHeight_ = cellHeight;
    cursorCol_ = std::clamp(cursorCol_, 0, cols_ - 1);
    cursorRow_ = std::clamp(cursorRow_, 0, rows_ - 1);
    if (unchanged) return;
    ghostty_terminal_resize(terminal_.get(), static_cast<uint16_t>(cols_), static_cast<uint16_t>(rows_), static_cast<uint32_t>(cellWidth), static_cast<uint32_t>(cellHeight));
    if (renderState_) {
        GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FULL;
        ghostty_render_state_set(renderState_.get(), GHOSTTY_RENDER_STATE_OPTION_DIRTY, &dirty);
    }
    if (ptyFd_ >= 0) {
        winsize size{static_cast<unsigned short>(rows_), static_cast<unsigned short>(cols_), static_cast<unsigned short>(cols_ * cellWidth), static_cast<unsigned short>(rows_ * cellHeight)};
        ioctl(ptyFd_, TIOCSWINSZ, &size);
    }
}

void CoderTerminal::pump() {
    std::lock_guard lock(mutex_);
    if (ptyFd_ < 0) return;
    std::array<uint8_t, 4096> buffer{};
    for (;;) {
        ssize_t count = read(ptyFd_, buffer.data(), buffer.size());
        if (count > 0) {
            processOscMetadata(buffer.data(), static_cast<size_t>(count));
            ghostty_terminal_vt_write(terminal_.get(), buffer.data(), static_cast<size_t>(count));
            updatePwd();
            continue;
        }
        if (count < 0 && errno == EAGAIN) break;
        if (count == 0 || (count < 0 && errno == EIO)) {
            close(ptyFd_);
            ptyFd_ = -1;
            break;
        }
        if (count < 0 && errno == EINTR) continue;
        break;
    }
    if (childPid_ > 0) waitpid(childPid_, nullptr, WNOHANG);
}

void CoderTerminal::writeUtf8(const char* data, int length) {
    std::lock_guard lock(mutex_);
    writePty(reinterpret_cast<const uint8_t*>(data), static_cast<size_t>(std::max(0, length)));
}

void CoderTerminal::feed(const uint8_t* data, size_t length) {
    std::lock_guard lock(mutex_);
    if (!terminal_ || data == nullptr || length == 0) return;
    processOscMetadata(data, length);
    ghostty_terminal_vt_write(terminal_.get(), data, length);
    updatePwd();
}

void CoderTerminal::key(int keyCode, int unicodeChar, int metaState) {
    std::lock_guard lock(mutex_);
    ghostty_key_encoder_setopt_from_terminal(keyEncoder_.get(), terminal_.get());
    ghostty_key_event_set_action(keyEvent_.get(), GHOSTTY_KEY_ACTION_PRESS);
    ghostty_key_event_set_key(keyEvent_.get(), mapAndroidKey(keyCode));
    ghostty_key_event_set_mods(keyEvent_.get(), mapAndroidMods(metaState));
    char utf8[8]{};
    size_t utf8Length = 0;
    if (unicodeChar > 0 && unicodeChar < 0x80 && unicodeChar != 0x7f) {
        utf8[0] = static_cast<char>(unicodeChar);
        utf8Length = 1;
    }
    ghostty_key_event_set_utf8(keyEvent_.get(), utf8Length > 0 ? utf8 : nullptr, utf8Length);
    std::array<char, 128> output{};
    size_t written = 0;
    GhosttyResult result = ghostty_key_encoder_encode(keyEncoder_.get(), keyEvent_.get(), output.data(), output.size(), &written);
    if (result == GHOSTTY_SUCCESS && written > 0) writePty(reinterpret_cast<const uint8_t*>(output.data()), written);
}

void CoderTerminal::setTheme(uint32_t foreground, uint32_t background, uint32_t cursor, uint32_t selectionBackground, const uint32_t* palette, size_t paletteLength) {
    std::lock_guard lock(mutex_);
    if (!terminal_ || !renderState_) return;
    auto makeColor = [](uint32_t color) -> GhosttyColorRgb {
        return GhosttyColorRgb{
            static_cast<uint8_t>((color >> 16u) & 0xffu),
            static_cast<uint8_t>((color >> 8u) & 0xffu),
            static_cast<uint8_t>(color & 0xffu),
        };
    };
    GhosttyColorRgb foregroundColor = makeColor(foreground);
    GhosttyColorRgb backgroundColor = makeColor(background);
    GhosttyColorRgb cursorColor = makeColor(cursor);
    selectionBackground_ = selectionBackground;
    const int luminance = static_cast<int>(backgroundColor.r) * 299 + static_cast<int>(backgroundColor.g) * 587 + static_cast<int>(backgroundColor.b) * 114;
    colorScheme_ = luminance > 127000 ? GHOSTTY_COLOR_SCHEME_LIGHT : GHOSTTY_COLOR_SCHEME_DARK;
    std::array<GhosttyColorRgb, 256> ghosttyPalette{};
    for (size_t index = 0; index < ghosttyPalette.size(); index++) {
        uint32_t color = index < paletteLength ? palette[index] : 0;
        ghosttyPalette[index] = makeColor(color);
    }
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &foregroundColor);
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &backgroundColor);
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &cursorColor);
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, ghosttyPalette.data());
    GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FULL;
    ghostty_render_state_set(renderState_.get(), GHOSTTY_RENDER_STATE_OPTION_DIRTY, &dirty);
}

void CoderTerminal::scroll(int rowDelta) {
    std::lock_guard lock(mutex_);
    if (!terminal_ || rowDelta == 0) return;
    GhosttyTerminalScrollViewport scroll{};
    scroll.tag = GHOSTTY_SCROLL_VIEWPORT_DELTA;
    scroll.value.delta = rowDelta;
    ghostty_terminal_scroll_viewport(terminal_.get(), scroll);
    GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FULL;
    ghostty_render_state_set(renderState_.get(), GHOSTTY_RENDER_STATE_OPTION_DIRTY, &dirty);
}

std::vector<uint8_t> CoderTerminal::scrollInput(int rowDelta, float x, float y) {
    std::lock_guard lock(mutex_);
    if (!terminal_ || rowDelta == 0) return {};
    bool mouseTracking = false;
    ghostty_terminal_get(terminal_.get(), GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &mouseTracking);
    if (mouseTracking) {
        ghostty_mouse_encoder_setopt_from_terminal(mouseEncoder_.get(), terminal_.get());
        GhosttyMouseEncoderSize size = GHOSTTY_INIT_SIZED(GhosttyMouseEncoderSize);
        size.screen_width = static_cast<uint32_t>(std::max(1, cols_ * cellWidth_));
        size.screen_height = static_cast<uint32_t>(std::max(1, rows_ * cellHeight_));
        size.cell_width = static_cast<uint32_t>(std::max(1, cellWidth_));
        size.cell_height = static_cast<uint32_t>(std::max(1, cellHeight_));
        ghostty_mouse_encoder_setopt(mouseEncoder_.get(), GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &size);
        ghostty_mouse_encoder_setopt(mouseEncoder_.get(), GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED, &mouseButtonPressed_);
        ghostty_mouse_event_set_action(mouseEvent_.get(), GHOSTTY_MOUSE_ACTION_PRESS);
        ghostty_mouse_event_set_button(mouseEvent_.get(), rowDelta < 0 ? GHOSTTY_MOUSE_BUTTON_FOUR : GHOSTTY_MOUSE_BUTTON_FIVE);
        ghostty_mouse_event_set_mods(mouseEvent_.get(), 0);
        ghostty_mouse_event_set_position(mouseEvent_.get(), GhosttyMousePosition{std::clamp(x, 0.0f, static_cast<float>(size.screen_width - 1)), std::clamp(y, 0.0f, static_cast<float>(size.screen_height - 1))});
        std::vector<uint8_t> result;
        for (int index = 0; index < std::abs(rowDelta); index++) {
            std::array<char, 128> output{};
            size_t written = 0;
            GhosttyResult encodeResult = ghostty_mouse_encoder_encode(mouseEncoder_.get(), mouseEvent_.get(), output.data(), output.size(), &written);
            if (encodeResult == GHOSTTY_SUCCESS && written > 0) result.insert(result.end(), output.begin(), output.begin() + static_cast<std::ptrdiff_t>(written));
        }
        return result;
    }
    GhosttyTerminalScreen activeScreen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
    bool altScroll = false;
    ghostty_terminal_get(terminal_.get(), GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &activeScreen);
    ghostty_terminal_mode_get(terminal_.get(), GHOSTTY_MODE_ALT_SCROLL, &altScroll);
    if (activeScreen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE && altScroll) {
        bool applicationCursor = false;
        ghostty_terminal_mode_get(terminal_.get(), GHOSTTY_MODE_DECCKM, &applicationCursor);
        const char* sequence = rowDelta < 0 ? (applicationCursor ? "\x1bOA" : "\x1b[A") : (applicationCursor ? "\x1bOB" : "\x1b[B");
        size_t sequenceLength = std::strlen(sequence);
        std::vector<uint8_t> result;
        result.reserve(sequenceLength * static_cast<size_t>(std::abs(rowDelta)));
        for (int index = 0; index < std::abs(rowDelta); index++) result.insert(result.end(), sequence, sequence + sequenceLength);
        return result;
    }
    GhosttyTerminalScrollViewport scroll{};
    scroll.tag = GHOSTTY_SCROLL_VIEWPORT_DELTA;
    scroll.value.delta = rowDelta;
    ghostty_terminal_scroll_viewport(terminal_.get(), scroll);
    GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FULL;
    ghostty_render_state_set(renderState_.get(), GHOSTTY_RENDER_STATE_OPTION_DIRTY, &dirty);
    return {};
}

bool CoderTerminal::mouseTracking() const {
    std::lock_guard lock(mutex_);
    if (!terminal_) return false;
    bool enabled = false;
    ghostty_terminal_get(terminal_.get(), GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &enabled);
    return enabled;
}

std::vector<uint8_t> CoderTerminal::mouse(int action, float x, float y, int button, int metaState) {
    std::lock_guard lock(mutex_);
    if (!terminal_ || !mouseEncoder_ || !mouseEvent_) return {};
    bool enabled = false;
    ghostty_terminal_get(terminal_.get(), GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &enabled);
    if (!enabled) return {};
    ghostty_mouse_encoder_setopt_from_terminal(mouseEncoder_.get(), terminal_.get());
    GhosttyMouseEncoderSize size = GHOSTTY_INIT_SIZED(GhosttyMouseEncoderSize);
    size.screen_width = static_cast<uint32_t>(std::max(1, cols_ * cellWidth_));
    size.screen_height = static_cast<uint32_t>(std::max(1, rows_ * cellHeight_));
    size.cell_width = static_cast<uint32_t>(std::max(1, cellWidth_));
    size.cell_height = static_cast<uint32_t>(std::max(1, cellHeight_));
    ghostty_mouse_encoder_setopt(mouseEncoder_.get(), GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &size);
    ghostty_mouse_encoder_setopt(mouseEncoder_.get(), GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED, &mouseButtonPressed_);
    ghostty_mouse_event_set_action(mouseEvent_.get(), action == 1 ? GHOSTTY_MOUSE_ACTION_RELEASE : action == 2 ? GHOSTTY_MOUSE_ACTION_MOTION : GHOSTTY_MOUSE_ACTION_PRESS);
    if (button == 1) ghostty_mouse_event_set_button(mouseEvent_.get(), GHOSTTY_MOUSE_BUTTON_LEFT);
    else if (button == 2) ghostty_mouse_event_set_button(mouseEvent_.get(), GHOSTTY_MOUSE_BUTTON_RIGHT);
    else if (button == 3) ghostty_mouse_event_set_button(mouseEvent_.get(), GHOSTTY_MOUSE_BUTTON_MIDDLE);
    else if (button == 4) ghostty_mouse_event_set_button(mouseEvent_.get(), GHOSTTY_MOUSE_BUTTON_FOUR);
    else if (button == 5) ghostty_mouse_event_set_button(mouseEvent_.get(), GHOSTTY_MOUSE_BUTTON_FIVE);
    else ghostty_mouse_event_clear_button(mouseEvent_.get());
    ghostty_mouse_event_set_mods(mouseEvent_.get(), mapAndroidMods(metaState));
    ghostty_mouse_event_set_position(mouseEvent_.get(), GhosttyMousePosition{std::clamp(x, 0.0f, static_cast<float>(size.screen_width - 1)), std::clamp(y, 0.0f, static_cast<float>(size.screen_height - 1))});
    std::array<char, 128> output{};
    size_t written = 0;
    mouseButtonPressed_ = action != 1;
    GhosttyResult result = ghostty_mouse_encoder_encode(mouseEncoder_.get(), mouseEvent_.get(), output.data(), output.size(), &written);
    if (result != GHOSTTY_SUCCESS || written == 0) return {};
    return std::vector<uint8_t>(output.begin(), output.begin() + static_cast<std::ptrdiff_t>(written));
}

bool CoderTerminal::screenPositionFromViewport(int row, int col, int& screenRow, int& screenCol) {
    std::lock_guard lock(mutex_);
    if (!terminal_) return false;
    GhosttyPoint point{};
    point.tag = GHOSTTY_POINT_TAG_VIEWPORT;
    point.value.coordinate.x = static_cast<uint16_t>(std::clamp(col, 0, std::max(0, cols_ - 1)));
    point.value.coordinate.y = static_cast<uint32_t>(std::clamp(row, 0, std::max(0, rows_ - 1)));
    GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
    if (ghostty_terminal_grid_ref(terminal_.get(), point, &ref) != GHOSTTY_SUCCESS) return false;
    GhosttyPointCoordinate screen{};
    if (ghostty_terminal_point_from_grid_ref(terminal_.get(), &ref, GHOSTTY_POINT_TAG_SCREEN, &screen) != GHOSTTY_SUCCESS) return false;
    screenCol = static_cast<int>(screen.x);
    screenRow = static_cast<int>(screen.y);
    return true;
}

void CoderTerminal::setSelection(bool active, int startRow, int startCol, int endRow, int endCol) {
    std::lock_guard lock(mutex_);
    selection_.active = active;
    selection_.startRow = std::max(0, startRow);
    selection_.startCol = std::clamp(startCol, 0, std::max(0, cols_ - 1));
    selection_.endRow = std::max(0, endRow);
    selection_.endCol = std::clamp(endCol, 0, std::max(0, cols_ - 1));
    if (renderState_) {
        GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FULL;
        ghostty_render_state_set(renderState_.get(), GHOSTTY_RENDER_STATE_OPTION_DIRTY, &dirty);
    }
}

std::string CoderTerminal::copySelection() {
    SelectionState selection;
    {
        std::lock_guard lock(mutex_);
        selection = selection_;
    }
    if (!selection.active) return {};
    return selectedText(selection.startRow, selection.startCol, selection.endRow, selection.endCol);
}

std::string CoderTerminal::title() {
    std::lock_guard lock(mutex_);
    return title_;
}

std::string CoderTerminal::pwd() {
    std::lock_guard lock(mutex_);
    updatePwd();
    return pwd_;
}

uint64_t CoderTerminal::bellCount() {
    std::lock_guard lock(mutex_);
    return bellCount_;
}

std::string CoderTerminal::hyperlinkUriAt(int row, int col) {
    std::lock_guard lock(mutex_);
    if (!terminal_) return {};
    GhosttyPoint point{};
    point.tag = GHOSTTY_POINT_TAG_VIEWPORT;
    point.value.coordinate.x = static_cast<uint16_t>(std::clamp(col, 0, std::max(0, cols_ - 1)));
    point.value.coordinate.y = static_cast<uint32_t>(std::clamp(row, 0, std::max(0, rows_ - 1)));
    GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
    if (ghostty_terminal_grid_ref(terminal_.get(), point, &ref) != GHOSTTY_SUCCESS) return {};
    size_t required = 0;
    GhosttyResult sizeResult = ghostty_grid_ref_hyperlink_uri(&ref, nullptr, 0, &required);
    if ((sizeResult != GHOSTTY_SUCCESS && sizeResult != GHOSTTY_OUT_OF_SPACE) || required == 0) return {};
    if (required > 2048) return {};
    std::vector<uint8_t> buffer(required);
    size_t written = 0;
    if (ghostty_grid_ref_hyperlink_uri(&ref, buffer.data(), buffer.size(), &written) != GHOSTTY_SUCCESS || written > buffer.size()) return {};
    return sanitizeBytes(buffer.data(), written, 2048);
}

std::vector<std::string> CoderTerminal::consumeOscEvents() {
    std::lock_guard lock(mutex_);
    std::vector<std::string> events;
    events.swap(oscEvents_);
    return events;
}

std::string CoderTerminal::selectedText(int startRow, int startCol, int endRow, int endCol) {
    std::lock_guard lock(mutex_);
    if (!terminal_) return {};
    GhosttyPoint startPoint{};
    startPoint.tag = GHOSTTY_POINT_TAG_SCREEN;
    startPoint.value.coordinate.x = static_cast<uint16_t>(std::clamp(startCol, 0, std::max(0, cols_ - 1)));
    startPoint.value.coordinate.y = static_cast<uint32_t>(std::max(0, startRow));
    GhosttyPoint endPoint{};
    endPoint.tag = GHOSTTY_POINT_TAG_SCREEN;
    endPoint.value.coordinate.x = static_cast<uint16_t>(std::clamp(endCol, 0, std::max(0, cols_ - 1)));
    endPoint.value.coordinate.y = static_cast<uint32_t>(std::max(0, endRow));
    GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
    if (ghostty_terminal_grid_ref(terminal_.get(), startPoint, &selection.start) != GHOSTTY_SUCCESS) return {};
    if (ghostty_terminal_grid_ref(terminal_.get(), endPoint, &selection.end) != GHOSTTY_SUCCESS) return {};
    selection.rectangle = false;
    GhosttyFormatterTerminalOptions options = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
    options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
    options.unwrap = false;
    options.trim = true;
    options.selection = &selection;
    GhosttyFormatter formatter = nullptr;
    if (ghostty_formatter_terminal_new(nullptr, &formatter, terminal_.get(), options) != GHOSTTY_SUCCESS) return {};
    uint8_t* output = nullptr;
    size_t length = 0;
    GhosttyResult result = ghostty_formatter_format_alloc(formatter, nullptr, &output, &length);
    ghostty_formatter_free(formatter);
    if (result != GHOSTTY_SUCCESS || !output || length == 0) return {};
    std::string text(reinterpret_cast<const char*>(output), length);
    ghostty_free(nullptr, output, length);
    return text;
}

std::vector<CoderCell> CoderTerminal::snapshot(int& cols, int& rows, int& cursorCol, int& cursorRow) {
    CoderCursor cursor;
    auto result = snapshot(cols, rows, cursor);
    cursorCol = cursor.col;
    cursorRow = cursor.row;
    return result;
}

std::vector<CoderCell> CoderTerminal::snapshot(int& cols, int& rows, CoderCursor& cursor) {
    std::lock_guard lock(mutex_);
    if (terminal_ && renderState_) {
        ghostty_render_state_update(renderState_.get(), terminal_.get());
        uint16_t renderCols = 0;
        uint16_t renderRows = 0;
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_COLS, &renderCols);
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_ROWS, &renderRows);
        GhosttyRenderStateColors colors = GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
        ghostty_render_state_colors_get(renderState_.get(), &colors);
        GhosttyRenderStateDirty dirtyState = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_DIRTY, &dirtyState);
        bool dimensionsChanged = cols_ != renderCols || rows_ != renderRows || cells_.size() != static_cast<size_t>(renderCols) * static_cast<size_t>(renderRows);
        cols_ = renderCols;
        rows_ = renderRows;
        const bool fullRedraw = dimensionsChanged || dirtyState == GHOSTTY_RENDER_STATE_DIRTY_FULL;
        if (fullRedraw) {
            cells_.assign(cols_ * rows_, CoderCell{{}, 0, rgb(colors.foreground), rgb(colors.background), rgb(colors.foreground), 0});
        }
        GhosttyRenderStateRowIterator rowIterator = rowIterator_.get();
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &rowIterator);
        int row = 0;
        while (ghostty_render_state_row_iterator_next(rowIterator) && row < rows_) {
            bool rowDirty = fullRedraw;
            if (!rowDirty) {
                ghostty_render_state_row_get(rowIterator, GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &rowDirty);
            }
            if (!rowDirty) {
                row++;
                continue;
            }
            for (int col = 0; col < cols_; col++) {
                cells_[row * cols_ + col] = CoderCell{{}, 0, rgb(colors.foreground), rgb(colors.background), rgb(colors.foreground), 0, GHOSTTY_CELL_WIDE_NARROW};
            }
            GhosttyRenderStateRowCells rowCells = rowCells_.get();
            ghostty_render_state_row_get(rowIterator, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &rowCells);
            int col = 0;
            while (ghostty_render_state_row_cells_next(rowCells) && col < cols_) {
                uint32_t graphemeLength = 0;
                ghostty_render_state_row_cells_get(rowCells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &graphemeLength);
                GhosttyCell rawCell = 0;
                GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
                if (ghostty_render_state_row_cells_get(rowCells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &rawCell) == GHOSTTY_SUCCESS) {
                    ghostty_cell_get(rawCell, GHOSTTY_CELL_DATA_WIDE, &wide);
                }
                std::array<uint32_t, 8> codepoints{};
                uint32_t codepointCount = 0;
                if (graphemeLength > 0) {
                    std::vector<uint32_t> graphemes(graphemeLength);
                    if (ghostty_render_state_row_cells_get(rowCells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, graphemes.data()) == GHOSTTY_SUCCESS) {
                        codepointCount = std::min<uint32_t>(static_cast<uint32_t>(codepoints.size()), graphemeLength);
                        std::copy_n(graphemes.begin(), codepointCount, codepoints.begin());
                    }
                }
                GhosttyColorRgb foregroundColor = colors.foreground;
                GhosttyColorRgb backgroundColor = colors.background;
                GhosttyColorRgb underlineColor = foregroundColor;
                ghostty_render_state_row_cells_get(rowCells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &foregroundColor);
                ghostty_render_state_row_cells_get(rowCells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &backgroundColor);
                GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
                ghostty_render_state_row_cells_get(rowCells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
                if (style.underline_color.tag == GHOSTTY_STYLE_COLOR_RGB) underlineColor = style.underline_color.value.rgb;
                if (style.underline_color.tag == GHOSTTY_STYLE_COLOR_PALETTE) underlineColor = colors.palette[style.underline_color.value.palette];
                if (style.inverse) {
                    std::swap(foregroundColor, backgroundColor);
                }
                uint32_t flags = style.bold ? 1u : 0u;
                if (style.italic) flags |= 2u;
                if (style.underline != 0) flags |= 4u;
                if (style.strikethrough) flags |= 8u;
                if (style.overline) flags |= 16u;
                if (style.faint) flags |= 256u;
                if (style.blink) flags |= 512u;
                flags |= (static_cast<uint32_t>(style.underline) & 7u) << 5u;
                if (style.invisible) codepointCount = 0;
                if (codepointCount > 0 && codepoints[0] >= 0x1f000) {
                    static int loggedEmojiCells = 0;
                    if (loggedEmojiCells < 16) {
                        __android_log_print(ANDROID_LOG_INFO, "CoderTerminal", "emoji cell row=%d col=%d count=%u cps=U+%04X U+%04X U+%04X U+%04X", row, col, codepointCount, codepoints[0], codepoints[1], codepoints[2], codepoints[3]);
                        loggedEmojiCells++;
                    }
                }
                cells_[row * cols_ + col] = CoderCell{codepoints, codepointCount, rgb(foregroundColor), rgb(backgroundColor), rgb(underlineColor), flags, wide};
                col++;
            }
            bool clean = false;
            ghostty_render_state_row_set(rowIterator, GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY, &clean);
            row++;
        }
        GhosttyRenderStateDirty cleanState = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
        ghostty_render_state_set(renderState_.get(), GHOSTTY_RENDER_STATE_OPTION_DIRTY, &cleanState);
        bool hasCursor = false;
        cursor_ = CoderCursor{};
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE, &cursor_.visible);
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING, &cursor_.blinking);
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE, &cursor_.visualStyle);
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR_HAS_VALUE, &cursor_.colorHasValue);
        if (cursor_.colorHasValue) {
            GhosttyColorRgb cursorColor{};
            if (ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR, &cursorColor) == GHOSTTY_SUCCESS) cursor_.color = (static_cast<uint32_t>(cursorColor.r) << 16u) | (static_cast<uint32_t>(cursorColor.g) << 8u) | static_cast<uint32_t>(cursorColor.b);
        }
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE, &hasCursor);
        if (hasCursor) {
            uint16_t cursorX = 0;
            uint16_t cursorY = 0;
            ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X, &cursorX);
            ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y, &cursorY);
            ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL, &cursor_.wideTail);
            cursorCol_ = cursorX;
            cursorRow_ = cursorY;
            cursor_.col = cursorCol_;
            cursor_.row = cursorRow_;
        } else {
            cursorCol_ = -1;
            cursorRow_ = -1;
        }
    }
    cols = cols_;
    rows = rows_;
    auto outputCells = cells_;
    if (selection_.active && terminal_) {
        int startRow = selection_.startRow;
        int startCol = selection_.startCol;
        int endRow = selection_.endRow;
        int endCol = selection_.endCol;
        if (startRow > endRow || (startRow == endRow && startCol > endCol)) {
            std::swap(startRow, endRow);
            std::swap(startCol, endCol);
        }
        for (int viewportRow = 0; viewportRow < rows_; viewportRow++) {
            int screenRow = 0;
            GhosttyPoint point{};
            point.tag = GHOSTTY_POINT_TAG_VIEWPORT;
            point.value.coordinate.x = 0;
            point.value.coordinate.y = static_cast<uint32_t>(viewportRow);
            GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
            if (ghostty_terminal_grid_ref(terminal_.get(), point, &ref) != GHOSTTY_SUCCESS) continue;
            GhosttyPointCoordinate screen{};
            if (ghostty_terminal_point_from_grid_ref(terminal_.get(), &ref, GHOSTTY_POINT_TAG_SCREEN, &screen) != GHOSTTY_SUCCESS) continue;
            screenRow = static_cast<int>(screen.y);
            if (screenRow < startRow || screenRow > endRow) continue;
            const int rowStartCol = screenRow == startRow ? startCol : 0;
            const int rowEndCol = screenRow == endRow ? endCol : cols_ - 1;
            for (int col = std::max(0, rowStartCol); col <= std::min(cols_ - 1, rowEndCol); col++) outputCells[viewportRow * cols_ + col].background = selectionBackground_;
        }
    }
    cursor = cursor_;
    return outputCells;
}

uint32_t CoderTerminal::rgb(GhosttyColorRgb color) const {
    return 0xff000000u | static_cast<uint32_t>(color.r) | (static_cast<uint32_t>(color.g) << 8u) | (static_cast<uint32_t>(color.b) << 16u);
}

void CoderTerminal::writePty(const uint8_t* data, size_t length) {
    if (ptyFd_ < 0) return;
    while (length > 0) {
        ssize_t written = write(ptyFd_, data, length);
        if (written > 0) {
            data += written;
            length -= static_cast<size_t>(written);
            continue;
        }
        if (written < 0 && errno == EINTR) continue;
        break;
    }
}

void CoderTerminal::processOscMetadata(const uint8_t* data, size_t length) {
    if (!data || length == 0) return;
    for (size_t index = 0; index < length; index++) {
        const uint8_t byte = data[index];
        if (oscMetadataActive_) {
            if (oscMetadataStEsc_) {
                if (byte == '\\') {
                    finishOscMetadata();
                } else {
                    if (oscMetadataBuffer_.size() < 8192) oscMetadataBuffer_.push_back('\x1b');
                    if (oscMetadataBuffer_.size() < 8192) oscMetadataBuffer_.push_back(static_cast<char>(byte));
                    else oscMetadataActive_ = false;
                }
                oscMetadataStEsc_ = false;
                continue;
            }
            if (byte == 0x07) {
                finishOscMetadata();
                continue;
            }
            if (byte == 0x1b) {
                oscMetadataStEsc_ = true;
                continue;
            }
            if (oscMetadataBuffer_.size() < 8192) oscMetadataBuffer_.push_back(static_cast<char>(byte));
            else oscMetadataActive_ = false;
            continue;
        }
        if (oscMetadataEsc_) {
            oscMetadataEsc_ = false;
            if (byte == ']') {
                oscMetadataActive_ = true;
                oscMetadataStEsc_ = false;
                oscMetadataBuffer_.clear();
                continue;
            }
        }
        oscMetadataEsc_ = byte == 0x1b;
    }
}

void CoderTerminal::finishOscMetadata() {
    oscMetadataActive_ = false;
    oscMetadataStEsc_ = false;
    if (oscMetadataBuffer_.rfind("7;", 0) == 0) {
        const auto* bytes = reinterpret_cast<const uint8_t*>(oscMetadataBuffer_.data() + 2);
        pwd_ = sanitizeBytes(bytes, oscMetadataBuffer_.size() - 2, 512);
        if (terminal_) {
            GhosttyString value{reinterpret_cast<const uint8_t*>(pwd_.data()), pwd_.size()};
            ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_PWD, &value);
        }
    } else if (oscMetadataBuffer_.rfind("52;", 0) == 0) {
        const size_t separator = oscMetadataBuffer_.find(';', 3);
        if (separator != std::string::npos && separator > 3) {
            const std::string kind = sanitizeBytes(reinterpret_cast<const uint8_t*>(oscMetadataBuffer_.data() + 3), separator - 3, 8);
            const std::string data = sanitizeBytes(reinterpret_cast<const uint8_t*>(oscMetadataBuffer_.data() + separator + 1), oscMetadataBuffer_.size() - separator - 1, 8192);
            oscEvents_.push_back("clipboard\t" + kind + "\t" + data);
        }
    } else if (oscMetadataBuffer_.rfind("9;", 0) == 0) {
        bool progressHandled = false;
        const bool progressCommand = oscMetadataBuffer_.rfind("9;4;", 0) == 0;
        if (progressCommand && oscMetadataBuffer_.size() >= 5) {
            const char state = oscMetadataBuffer_[4];
            const bool validState = state == '0' || state == '1' || state == '2' || state == '3' || state == '4';
            const bool validShape = oscMetadataBuffer_.size() == 5 || oscMetadataBuffer_[5] == ';';
            if (validState && validShape) {
                const size_t valueStart = oscMetadataBuffer_.size() > 5 ? 6 : oscMetadataBuffer_.size();
                const size_t valueEnd = oscMetadataBuffer_.find(';', valueStart);
                const size_t valueLength = valueStart < oscMetadataBuffer_.size() ? (valueEnd == std::string::npos ? oscMetadataBuffer_.size() - valueStart : valueEnd - valueStart) : 0;
                const std::string value = sanitizeBytes(reinterpret_cast<const uint8_t*>(oscMetadataBuffer_.data() + valueStart), valueLength, 8);
                oscEvents_.push_back(std::string("progress\t") + state + "\t" + value);
                progressHandled = true;
            }
        }
        if (!progressHandled && !progressCommand) {
            const std::string body = sanitizeBytes(reinterpret_cast<const uint8_t*>(oscMetadataBuffer_.data() + 2), oscMetadataBuffer_.size() - 2, 512);
            if (!body.empty()) oscEvents_.push_back("notification\t\t" + body);
        }
    } else if (oscMetadataBuffer_.rfind("777;notify;", 0) == 0) {
        const size_t titleStart = 11;
        const size_t separator = oscMetadataBuffer_.find(';', titleStart);
        if (separator != std::string::npos) {
            const std::string title = sanitizeBytes(reinterpret_cast<const uint8_t*>(oscMetadataBuffer_.data() + titleStart), separator - titleStart, 128);
            const std::string body = sanitizeBytes(reinterpret_cast<const uint8_t*>(oscMetadataBuffer_.data() + separator + 1), oscMetadataBuffer_.size() - separator - 1, 512);
            if (!title.empty() || !body.empty()) oscEvents_.push_back("notification\t" + title + "\t" + body);
        }
    }
    oscMetadataBuffer_.clear();
}

void CoderTerminal::updateTitle() {
    GhosttyString value{};
    if (terminal_ && ghostty_terminal_get(terminal_.get(), GHOSTTY_TERMINAL_DATA_TITLE, &value) == GHOSTTY_SUCCESS) title_ = sanitizeGhosttyString(value, 256);
}

void CoderTerminal::updatePwd() {
    GhosttyString value{};
    if (terminal_ && ghostty_terminal_get(terminal_.get(), GHOSTTY_TERMINAL_DATA_PWD, &value) == GHOSTTY_SUCCESS) pwd_ = sanitizeGhosttyString(value, 512);
}

std::string CoderTerminal::sanitizeGhosttyString(GhosttyString value, size_t maxBytes) {
    return sanitizeBytes(value.ptr, value.len, maxBytes);
}

std::string CoderTerminal::sanitizeBytes(const uint8_t* data, size_t length, size_t maxBytes) {
    if (!data || length == 0 || maxBytes == 0) return {};
    std::string output;
    output.reserve(std::min(length, maxBytes));
    size_t index = 0;
    while (index < length && output.size() < maxBytes) {
        const uint8_t byte = data[index];
        uint32_t codepoint = 0;
        size_t width = 0;
        if (byte < 0x80) {
            codepoint = byte;
            width = 1;
        } else if ((byte & 0xe0) == 0xc0 && index + 1 < length && (data[index + 1] & 0xc0) == 0x80) {
            codepoint = ((byte & 0x1f) << 6) | (data[index + 1] & 0x3f);
            width = codepoint >= 0x80 ? 2 : 0;
        } else if ((byte & 0xf0) == 0xe0 && index + 2 < length && (data[index + 1] & 0xc0) == 0x80 && (data[index + 2] & 0xc0) == 0x80) {
            codepoint = ((byte & 0x0f) << 12) | ((data[index + 1] & 0x3f) << 6) | (data[index + 2] & 0x3f);
            width = codepoint >= 0x800 && (codepoint < 0xd800 || codepoint > 0xdfff) ? 3 : 0;
        } else if ((byte & 0xf8) == 0xf0 && index + 3 < length && (data[index + 1] & 0xc0) == 0x80 && (data[index + 2] & 0xc0) == 0x80 && (data[index + 3] & 0xc0) == 0x80) {
            codepoint = ((byte & 0x07) << 18) | ((data[index + 1] & 0x3f) << 12) | ((data[index + 2] & 0x3f) << 6) | (data[index + 3] & 0x3f);
            width = codepoint >= 0x10000 && codepoint <= 0x10ffff ? 4 : 0;
        }
        if (width == 0) {
            if (output.size() + 3 > maxBytes) break;
            output.append("\xef\xbf\xbd", 3);
            index++;
            continue;
        }
        if ((codepoint < 0x20 && codepoint != '\t') || codepoint == 0x7f || (codepoint >= 0x80 && codepoint <= 0x9f)) {
            index += width;
            continue;
        }
        if (output.size() + width > maxBytes) break;
        output.append(reinterpret_cast<const char*>(data + index), width);
        index += width;
    }
    return output;
}

GhosttyKey CoderTerminal::mapAndroidKey(int keyCode) const {
    if (keyCode >= 29 && keyCode <= 54) return static_cast<GhosttyKey>(GHOSTTY_KEY_A + keyCode - 29);
    if (keyCode >= 7 && keyCode <= 16) return static_cast<GhosttyKey>(GHOSTTY_KEY_DIGIT_0 + keyCode - 7);
    if (keyCode >= 131 && keyCode <= 142) return static_cast<GhosttyKey>(GHOSTTY_KEY_F1 + keyCode - 131);
    if (keyCode >= 144 && keyCode <= 153) return static_cast<GhosttyKey>(GHOSTTY_KEY_NUMPAD_0 + keyCode - 144);
    switch (keyCode) {
        case 66: return GHOSTTY_KEY_ENTER;
        case 61: return GHOSTTY_KEY_TAB;
        case 67: return GHOSTTY_KEY_BACKSPACE;
        case 111: return GHOSTTY_KEY_ESCAPE;
        case 19: return GHOSTTY_KEY_ARROW_UP;
        case 20: return GHOSTTY_KEY_ARROW_DOWN;
        case 21: return GHOSTTY_KEY_ARROW_LEFT;
        case 22: return GHOSTTY_KEY_ARROW_RIGHT;
        case 92: return GHOSTTY_KEY_PAGE_UP;
        case 93: return GHOSTTY_KEY_PAGE_DOWN;
        case 122: return GHOSTTY_KEY_HOME;
        case 123: return GHOSTTY_KEY_END;
        case 112: return GHOSTTY_KEY_DELETE;
        case 124: return GHOSTTY_KEY_INSERT;
        case 121: return GHOSTTY_KEY_SCROLL_LOCK;
        case 143: return GHOSTTY_KEY_NUM_LOCK;
        case 62: return GHOSTTY_KEY_SPACE;
        case 69: return GHOSTTY_KEY_MINUS;
        case 70: return GHOSTTY_KEY_EQUAL;
        case 71: return GHOSTTY_KEY_BRACKET_LEFT;
        case 72: return GHOSTTY_KEY_BRACKET_RIGHT;
        case 73: return GHOSTTY_KEY_BACKSLASH;
        case 74: return GHOSTTY_KEY_SEMICOLON;
        case 75: return GHOSTTY_KEY_QUOTE;
        case 55: return GHOSTTY_KEY_COMMA;
        case 56: return GHOSTTY_KEY_PERIOD;
        case 76: return GHOSTTY_KEY_SLASH;
        case 68: return GHOSTTY_KEY_BACKQUOTE;
        case 154: return GHOSTTY_KEY_NUMPAD_DIVIDE;
        case 155: return GHOSTTY_KEY_NUMPAD_MULTIPLY;
        case 156: return GHOSTTY_KEY_NUMPAD_SUBTRACT;
        case 157: return GHOSTTY_KEY_NUMPAD_ADD;
        case 158: return GHOSTTY_KEY_NUMPAD_DECIMAL;
        case 160: return GHOSTTY_KEY_NUMPAD_ENTER;
        case 161: return GHOSTTY_KEY_NUMPAD_EQUAL;
        default: return GHOSTTY_KEY_UNIDENTIFIED;
    }
}

GhosttyMods CoderTerminal::mapAndroidMods(int metaState) const {
    GhosttyMods mods = 0;
    if ((metaState & 0x000000c1) != 0) mods |= GHOSTTY_MODS_SHIFT;
    if ((metaState & 0x00007000) != 0) mods |= GHOSTTY_MODS_CTRL;
    if ((metaState & 0x00000032) != 0) mods |= GHOSTTY_MODS_ALT;
    if ((metaState & 0x00070000) != 0) mods |= GHOSTTY_MODS_SUPER;
    return mods;
}

void CoderTerminal::writePtyEffect(GhosttyTerminal, void* userdata, const uint8_t* data, size_t length) {
    static_cast<CoderTerminal*>(userdata)->writePty(data, length);
}

void CoderTerminal::titleChangedEffect(GhosttyTerminal, void* userdata) {
    static_cast<CoderTerminal*>(userdata)->updateTitle();
}

void CoderTerminal::bellEffect(GhosttyTerminal, void* userdata) {
    static_cast<CoderTerminal*>(userdata)->bellCount_++;
}

bool CoderTerminal::sizeEffect(GhosttyTerminal, void* userdata, GhosttySizeReportSize* outSize) {
    auto* terminal = static_cast<CoderTerminal*>(userdata);
    outSize->rows = static_cast<uint16_t>(terminal->rows_);
    outSize->columns = static_cast<uint16_t>(terminal->cols_);
    outSize->cell_width = static_cast<uint32_t>(terminal->cellWidth_);
    outSize->cell_height = static_cast<uint32_t>(terminal->cellHeight_);
    return true;
}

bool CoderTerminal::colorSchemeEffect(GhosttyTerminal, void* userdata, GhosttyColorScheme* outScheme) {
    auto* terminal = static_cast<CoderTerminal*>(userdata);
    *outScheme = terminal->colorScheme_;
    return true;
}

bool CoderTerminal::deviceAttributesEffect(GhosttyTerminal, void*, GhosttyDeviceAttributes* outAttributes) {
    outAttributes->primary.conformance_level = GHOSTTY_DA_CONFORMANCE_VT220;
    outAttributes->primary.features[0] = GHOSTTY_DA_FEATURE_COLUMNS_132;
    outAttributes->primary.features[1] = GHOSTTY_DA_FEATURE_SELECTIVE_ERASE;
    outAttributes->primary.features[2] = GHOSTTY_DA_FEATURE_ANSI_COLOR;
    outAttributes->primary.num_features = 3;
    outAttributes->secondary.device_type = GHOSTTY_DA_DEVICE_TYPE_VT220;
    outAttributes->secondary.firmware_version = 1;
    outAttributes->secondary.rom_cartridge = 0;
    outAttributes->tertiary.unit_id = 0;
    return true;
}

GhosttyString CoderTerminal::xtversionEffect(GhosttyTerminal, void*) {
    static const uint8_t version[] = "coder-android";
    return GhosttyString{version, sizeof(version) - 1};
}
