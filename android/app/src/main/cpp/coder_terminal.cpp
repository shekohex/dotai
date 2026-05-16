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

bool operator==(const CoderCell& lhs, const CoderCell& rhs) {
    return lhs.codepointCount == rhs.codepointCount
        && lhs.codepoints == rhs.codepoints
        && lhs.foreground == rhs.foreground
        && lhs.background == rhs.background
        && lhs.flags == rhs.flags;
}

CoderTerminal::CoderTerminal() = default;

CoderTerminal::~CoderTerminal() {
    if (ptyFd_ >= 0) close(ptyFd_);
    if (childPid_ > 0) {
        kill(childPid_, SIGHUP);
        waitpid(childPid_, nullptr, WNOHANG);
    }
}

bool CoderTerminal::start(int cols, int rows, int cellWidth, int cellHeight, const char* bashPath, const char* busyBoxPath, const char* toolsDir) {
    std::lock_guard lock(mutex_);
    bashPath_ = bashPath ? bashPath : "";
    busyBoxPath_ = busyBoxPath ? busyBoxPath : "";
    cols_ = std::max(1, cols);
    rows_ = std::max(1, rows);
    cellWidth_ = cellWidth;
    cellHeight_ = cellHeight;
    cursorCol_ = 0;
    cursorRow_ = 0;
    cells_.assign(cols_ * rows_, CoderCell{{}, 0, 0xffd0d0d0, 0xff101014, 0});

    GhosttyTerminalOptions options = { .cols = static_cast<uint16_t>(cols_), .rows = static_cast<uint16_t>(rows_), .max_scrollback = 1000 };
    GhosttyTerminal terminal = nullptr;
    GhosttyRenderState renderState = nullptr;
    GhosttyRenderStateRowIterator rowIterator = nullptr;
    GhosttyRenderStateRowCells rowCells = nullptr;
    GhosttyKeyEncoder keyEncoder = nullptr;
    GhosttyKeyEvent keyEvent = nullptr;
    if (ghostty_terminal_new(nullptr, &terminal, options) != GHOSTTY_SUCCESS) return false;
    if (ghostty_render_state_new(nullptr, &renderState) != GHOSTTY_SUCCESS) return false;
    if (ghostty_render_state_row_iterator_new(nullptr, &rowIterator) != GHOSTTY_SUCCESS) return false;
    if (ghostty_render_state_row_cells_new(nullptr, &rowCells) != GHOSTTY_SUCCESS) return false;
    if (ghostty_key_encoder_new(nullptr, &keyEncoder) != GHOSTTY_SUCCESS) return false;
    if (ghostty_key_event_new(nullptr, &keyEvent) != GHOSTTY_SUCCESS) return false;
    terminal_.reset(terminal);
    renderState_.reset(renderState);
    rowIterator_.reset(rowIterator);
    rowCells_.reset(rowCells);
    keyEncoder_.reset(keyEncoder);
    keyEvent_.reset(keyEvent);

    ghostty_terminal_resize(terminal_.get(), static_cast<uint16_t>(cols_), static_cast<uint16_t>(rows_), static_cast<uint32_t>(cellWidth), static_cast<uint32_t>(cellHeight));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_USERDATA, this);
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_WRITE_PTY, reinterpret_cast<const void*>(writePtyEffect));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_SIZE, reinterpret_cast<const void*>(sizeEffect));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES, reinterpret_cast<const void*>(deviceAttributesEffect));
    ghostty_terminal_set(terminal_.get(), GHOSTTY_TERMINAL_OPT_XTVERSION, reinterpret_cast<const void*>(xtversionEffect));

    if (!spawnPty(cellWidth, cellHeight)) return false;

    return true;
}

void CoderTerminal::resize(int cols, int rows, int cellWidth, int cellHeight) {
    std::lock_guard lock(mutex_);
    cols_ = std::max(1, cols);
    rows_ = std::max(1, rows);
    cellWidth_ = cellWidth;
    cellHeight_ = cellHeight;
    cells_.assign(cols_ * rows_, CoderCell{{}, 0, 0xffd0d0d0, 0xff101014, 0});
    cursorCol_ = 0;
    cursorRow_ = 0;
    ghostty_terminal_resize(terminal_.get(), static_cast<uint16_t>(cols_), static_cast<uint16_t>(rows_), static_cast<uint32_t>(cellWidth), static_cast<uint32_t>(cellHeight));
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
            ghostty_terminal_vt_write(terminal_.get(), buffer.data(), static_cast<size_t>(count));
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
    ghostty_terminal_vt_write(terminal_.get(), data, length);
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

void CoderTerminal::setTheme(uint32_t foreground, uint32_t background, uint32_t cursor, const uint32_t* palette, size_t paletteLength) {
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

std::vector<CoderCell> CoderTerminal::snapshot(int& cols, int& rows, int& cursorCol, int& cursorRow) {
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
        if (dimensionsChanged || dirtyState == GHOSTTY_RENDER_STATE_DIRTY_FULL) {
            cells_.assign(cols_ * rows_, CoderCell{{}, 0, rgb(colors.foreground), rgb(colors.background), 0});
        }
        GhosttyRenderStateRowIterator rowIterator = rowIterator_.get();
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &rowIterator);
        int row = 0;
        while (ghostty_render_state_row_iterator_next(rowIterator) && row < rows_) {
            bool rowDirty = dirtyState == GHOSTTY_RENDER_STATE_DIRTY_FULL;
            if (!rowDirty) {
                ghostty_render_state_row_get(rowIterator, GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &rowDirty);
            }
            if (!rowDirty) {
                row++;
                continue;
            }
            for (int col = 0; col < cols_; col++) {
                cells_[row * cols_ + col] = CoderCell{{}, 0, rgb(colors.foreground), rgb(colors.background), 0};
            }
            GhosttyRenderStateRowCells rowCells = rowCells_.get();
            ghostty_render_state_row_get(rowIterator, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &rowCells);
            int col = 0;
            while (ghostty_render_state_row_cells_next(rowCells) && col < cols_) {
                uint32_t graphemeLength = 0;
                ghostty_render_state_row_cells_get(rowCells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &graphemeLength);
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
                ghostty_render_state_row_cells_get(rowCells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &foregroundColor);
                ghostty_render_state_row_cells_get(rowCells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &backgroundColor);
                GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
                ghostty_render_state_row_cells_get(rowCells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
                if (style.inverse) {
                    std::swap(foregroundColor, backgroundColor);
                }
                uint32_t flags = style.bold ? 1u : 0u;
                if (style.italic) flags |= 2u;
                cells_[row * cols_ + col] = CoderCell{codepoints, codepointCount, rgb(foregroundColor), rgb(backgroundColor), flags};
                col++;
            }
            bool clean = false;
            ghostty_render_state_row_set(rowIterator, GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY, &clean);
            row++;
        }
        GhosttyRenderStateDirty cleanState = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
        ghostty_render_state_set(renderState_.get(), GHOSTTY_RENDER_STATE_OPTION_DIRTY, &cleanState);
        bool hasCursor = false;
        ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE, &hasCursor);
        if (hasCursor) {
            uint16_t cursorX = 0;
            uint16_t cursorY = 0;
            ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X, &cursorX);
            ghostty_render_state_get(renderState_.get(), GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y, &cursorY);
            cursorCol_ = cursorX;
            cursorRow_ = cursorY;
        }
    }
    cols = cols_;
    rows = rows_;
    cursorCol = cursorCol_;
    cursorRow = cursorRow_;
    return cells_;
}

uint32_t CoderTerminal::rgb(GhosttyColorRgb color) const {
    return 0xff000000u | static_cast<uint32_t>(color.r) | (static_cast<uint32_t>(color.g) << 8u) | (static_cast<uint32_t>(color.b) << 16u);
}

bool CoderTerminal::spawnPty(int cellWidth, int cellHeight) {
    int master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (master < 0) return false;
    if (grantpt(master) != 0 || unlockpt(master) != 0) {
        close(master);
        return false;
    }
    char slaveName[128]{};
    if (ptsname_r(master, slaveName, sizeof(slaveName)) != 0) {
        close(master);
        return false;
    }
    winsize size{static_cast<unsigned short>(rows_), static_cast<unsigned short>(cols_), static_cast<unsigned short>(cols_ * cellWidth), static_cast<unsigned short>(rows_ * cellHeight)};
    pid_t child = fork();
    if (child < 0) {
        close(master);
        return false;
    }
    if (child == 0) {
        setsid();
        int slave = open(slaveName, O_RDWR);
        if (slave < 0) _exit(127);
        ioctl(slave, TIOCSCTTY, 0);
        ioctl(slave, TIOCSWINSZ, &size);
        dup2(slave, STDIN_FILENO);
        dup2(slave, STDOUT_FILENO);
        dup2(slave, STDERR_FILENO);
        if (slave > STDERR_FILENO) close(slave);
        close(master);
        setenv("TERM", "xterm-256color", 1);
        setenv("HOME", "/", 1);
        setenv("PATH", "/system/bin:/system/xbin", 1);
        setenv("PS1", "$ ", 1);
        const uint8_t demoOutput[] =
            "\033[0mNC (No color)\n"
            "\033[1;37mWHITE\t\033[0;30mBLACK\n"
            "\033[0;34mBLUE\t\033[1;34mLIGHT_BLUE\n"
            "\033[0;32mGREEN\t\033[1;32mLIGHT_GREEN\n"
            "\033[0;36mCYAN\t\033[1;36mLIGHT_CYAN\n"
            "\033[0;31mRED\t\033[1;31mLIGHT_RED\n"
            "\033[0;35mPURPLE\t\033[1;35mLIGHT_PURPLE\n"
            "\033[0;33mYELLOW\t\033[1;33mLIGHT_YELLOW\n"
            "\033[1;30mGRAY\t\033[0;37mLIGHT_GRAY\n"
            "\033[11;1H\033[1;32mCURSOR_MOVED\033[0m\n"
            "\033[0m";
        write(STDOUT_FILENO, demoOutput, sizeof(demoOutput) - 1);
        execl("/system/bin/sh", "sh", "-i", NULL);
        _exit(127);
    }
    int flags = fcntl(master, F_GETFL, 0);
    fcntl(master, F_SETFL, flags | O_NONBLOCK);
    ioctl(master, TIOCSWINSZ, &size);
    ptyFd_ = master;
    childPid_ = child;
    return true;
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

bool CoderTerminal::sizeEffect(GhosttyTerminal, void* userdata, GhosttySizeReportSize* outSize) {
    auto* terminal = static_cast<CoderTerminal*>(userdata);
    outSize->rows = static_cast<uint16_t>(terminal->rows_);
    outSize->columns = static_cast<uint16_t>(terminal->cols_);
    outSize->cell_width = static_cast<uint32_t>(terminal->cellWidth_);
    outSize->cell_height = static_cast<uint32_t>(terminal->cellHeight_);
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
