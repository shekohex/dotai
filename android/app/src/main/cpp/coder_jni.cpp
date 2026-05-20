#include "coder_renderer.h"
#include "coder_terminal.h"

#include <algorithm>
#include <jni.h>
#include <memory>
#include <string>
#include <vector>

struct JniByteArrayView {
    JNIEnv* env = nullptr;
    jbyteArray array = nullptr;
    jbyte* data = nullptr;
    jsize length = 0;

    JniByteArrayView(JNIEnv* env, jbyteArray array) : env(env), array(array) {
        if (!array) return;
        length = env->GetArrayLength(array);
        data = env->GetByteArrayElements(array, nullptr);
    }

    ~JniByteArrayView() {
        if (data) env->ReleaseByteArrayElements(array, data, JNI_ABORT);
    }

    const uint8_t* bytes() const { return reinterpret_cast<const uint8_t*>(data); }
    size_t size() const { return static_cast<size_t>(length); }
};

struct NativeTerminal {
    CoderTerminal terminal;
};

struct NativeRenderer {
    CoderRenderer renderer;
};

static CoderTerminal* terminal(NativeTerminal* handle) { return &handle->terminal; }
static CoderRenderer* renderer(NativeRenderer* handle) { return &handle->renderer; }

extern "C" JNIEXPORT jlong JNICALL
Java_com_coder_pi_CoderNative_nativeInitTerminal(JNIEnv*, jobject, jint cols, jint rows, jint cellWidth, jint cellHeight) {
    auto handle = std::make_unique<NativeTerminal>();
    handle->terminal.start(cols, rows, cellWidth, cellHeight);
    return reinterpret_cast<jlong>(handle.release());
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeDisposeTerminal(JNIEnv*, jobject, jlong handle) {
    delete reinterpret_cast<NativeTerminal*>(handle);
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_coder_pi_CoderNative_nativeInitRenderer(JNIEnv*, jobject) {
    return reinterpret_cast<jlong>(new NativeRenderer());
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeDisposeRenderer(JNIEnv*, jobject, jlong handle) {
    delete reinterpret_cast<NativeRenderer*>(handle);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeRendererSurfaceCreated(JNIEnv*, jobject, jlong rendererHandle) {
    renderer(reinterpret_cast<NativeRenderer*>(rendererHandle))->init();
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeRendererSetFont(JNIEnv* env, jobject, jlong rendererHandle, jbyteArray bytes) {
    JniByteArrayView regular(env, bytes);
    renderer(reinterpret_cast<NativeRenderer*>(rendererHandle))->setFontData(regular.bytes(), regular.size());
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeRendererSetFontStyles(JNIEnv* env, jobject, jlong rendererHandle, jbyteArray regularBytes, jbyteArray boldBytes, jbyteArray italicBytes, jbyteArray boldItalicBytes, jbyteArray fallbackBytes) {
    JniByteArrayView regular(env, regularBytes);
    JniByteArrayView bold(env, boldBytes);
    JniByteArrayView italic(env, italicBytes);
    JniByteArrayView boldItalic(env, boldItalicBytes);
    JniByteArrayView fallback(env, fallbackBytes);
    auto* nativeRenderer = renderer(reinterpret_cast<NativeRenderer*>(rendererHandle));
    nativeRenderer->setFontData(regular.bytes(), regular.size(), bold.bytes(), bold.size(), italic.bytes(), italic.size(), boldItalic.bytes(), boldItalic.size());
    nativeRenderer->setFallbackFontData(fallback.bytes(), fallback.size());
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeRendererSetShaderCacheDir(JNIEnv* env, jobject, jlong rendererHandle, jstring path) {
    const char* chars = env->GetStringUTFChars(path, nullptr);
    if (!chars) return;
    renderer(reinterpret_cast<NativeRenderer*>(rendererHandle))->setShaderCacheDir(chars);
    env->ReleaseStringUTFChars(path, chars);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSetTerminalTheme(JNIEnv* env, jobject, jlong terminalHandle, jint foreground, jint background, jint cursor, jint selectionBackground, jintArray palette) {
    jsize length = env->GetArrayLength(palette);
    jint* data = env->GetIntArrayElements(palette, nullptr);
    terminal(reinterpret_cast<NativeTerminal*>(terminalHandle))->setTheme(static_cast<uint32_t>(foreground), static_cast<uint32_t>(background), static_cast<uint32_t>(cursor), static_cast<uint32_t>(selectionBackground), reinterpret_cast<const uint32_t*>(data), static_cast<size_t>(length));
    env->ReleaseIntArrayElements(palette, data, JNI_ABORT);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeRendererSetTheme(JNIEnv*, jobject, jlong rendererHandle, jint background, jint cursor, jint cursorText) {
    renderer(reinterpret_cast<NativeRenderer*>(rendererHandle))->setTheme(static_cast<uint32_t>(background), static_cast<uint32_t>(cursor), static_cast<uint32_t>(cursorText));
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeRendererSetTextOptions(JNIEnv*, jobject, jlong rendererHandle, jboolean ligatures, jboolean contextualAlternates, jboolean slashedZero, jboolean stylisticSet1, jboolean stylisticSet2, jboolean characterVariant1, jboolean cursorBlink, jint cursorMode) {
    renderer(reinterpret_cast<NativeRenderer*>(rendererHandle))->setTextOptions(ligatures == JNI_TRUE, contextualAlternates == JNI_TRUE, slashedZero == JNI_TRUE, stylisticSet1 == JNI_TRUE, stylisticSet2 == JNI_TRUE, characterVariant1 == JNI_TRUE, cursorBlink == JNI_TRUE, cursorMode);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeRendererSetRefreshRate(JNIEnv*, jobject, jlong rendererHandle, jfloat refreshRate) {
    renderer(reinterpret_cast<NativeRenderer*>(rendererHandle))->setTargetRefreshRate(refreshRate);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeRendererSurfaceChanged(JNIEnv*, jobject, jlong terminalHandle, jlong rendererHandle, jint width, jint height, jint cellWidth, jint cellHeight) {
    const int columns = std::max(1, width / std::max(1, cellWidth));
    const int rows = std::max(1, height / std::max(1, cellHeight));
    renderer(reinterpret_cast<NativeRenderer*>(rendererHandle))->setCellSize(cellWidth, cellHeight);
    renderer(reinterpret_cast<NativeRenderer*>(rendererHandle))->resize(width, height);
    terminal(reinterpret_cast<NativeTerminal*>(terminalHandle))->resize(columns, rows, cellWidth, cellHeight);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeRendererDrawFrame(JNIEnv*, jobject, jlong terminalHandle, jlong rendererHandle) {
    renderer(reinterpret_cast<NativeRenderer*>(rendererHandle))->draw(*terminal(reinterpret_cast<NativeTerminal*>(terminalHandle)));
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeWrite(JNIEnv* env, jobject, jlong handle, jbyteArray bytes) {
    jsize length = env->GetArrayLength(bytes);
    jbyte* data = env->GetByteArrayElements(bytes, nullptr);
    terminal(reinterpret_cast<NativeTerminal*>(handle))->writeUtf8(reinterpret_cast<const char*>(data), length);
    env->ReleaseByteArrayElements(bytes, data, JNI_ABORT);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_coder_pi_CoderNative_nativePaste(JNIEnv* env, jobject, jlong handle, jbyteArray bytes) {
    JniByteArrayView input(env, bytes);
    std::vector<uint8_t> encoded = terminal(reinterpret_cast<NativeTerminal*>(handle))->encodePaste(input.bytes(), input.size());
    jbyteArray result = env->NewByteArray(static_cast<jsize>(encoded.size()));
    if (!encoded.empty()) env->SetByteArrayRegion(result, 0, static_cast<jsize>(encoded.size()), reinterpret_cast<const jbyte*>(encoded.data()));
    return result;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_coder_pi_CoderNative_nativeFocusEvent(JNIEnv* env, jobject, jlong handle, jboolean focused) {
    std::vector<uint8_t> encoded = terminal(reinterpret_cast<NativeTerminal*>(handle))->encodeFocus(focused == JNI_TRUE);
    jbyteArray result = env->NewByteArray(static_cast<jsize>(encoded.size()));
    if (!encoded.empty()) env->SetByteArrayRegion(result, 0, static_cast<jsize>(encoded.size()), reinterpret_cast<const jbyte*>(encoded.data()));
    return result;
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeFeed(JNIEnv* env, jobject, jlong handle, jbyteArray bytes) {
    jsize length = env->GetArrayLength(bytes);
    jbyte* data = env->GetByteArrayElements(bytes, nullptr);
    terminal(reinterpret_cast<NativeTerminal*>(handle))->feed(reinterpret_cast<const uint8_t*>(data), static_cast<size_t>(length));
    env->ReleaseByteArrayElements(bytes, data, JNI_ABORT);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeTextInput(JNIEnv* env, jobject, jlong handle, jstring text) {
    const char* chars = env->GetStringUTFChars(text, nullptr);
    if (chars) {
        for (const unsigned char* cursor = reinterpret_cast<const unsigned char*>(chars); *cursor != 0; cursor++) {
            terminal(reinterpret_cast<NativeTerminal*>(handle))->key(0, *cursor, 0);
        }
        env->ReleaseStringUTFChars(text, chars);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSetPreedit(JNIEnv* env, jobject, jlong handle, jstring text) {
    const char* chars = env->GetStringUTFChars(text, nullptr);
    if (chars) {
        terminal(reinterpret_cast<NativeTerminal*>(handle))->setPreedit(chars, std::strlen(chars));
        env->ReleaseStringUTFChars(text, chars);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeKeyEvent(JNIEnv*, jobject, jlong handle, jint keyCode, jint unicodeChar, jint metaState) {
    terminal(reinterpret_cast<NativeTerminal*>(handle))->key(keyCode, unicodeChar, metaState);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeScroll(JNIEnv*, jobject, jlong handle, jint rowDelta) {
    terminal(reinterpret_cast<NativeTerminal*>(handle))->scroll(rowDelta);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_coder_pi_CoderNative_nativeScrollInput(JNIEnv* env, jobject, jlong handle, jint rowDelta, jfloat x, jfloat y) {
    auto output = terminal(reinterpret_cast<NativeTerminal*>(handle))->scrollInput(rowDelta, x, y);
    jbyteArray result = env->NewByteArray(static_cast<jsize>(output.size()));
    if (!output.empty()) env->SetByteArrayRegion(result, 0, static_cast<jsize>(output.size()), reinterpret_cast<const jbyte*>(output.data()));
    return result;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_coder_pi_CoderNative_nativeMouseTracking(JNIEnv*, jobject, jlong handle) {
    return terminal(reinterpret_cast<NativeTerminal*>(handle))->mouseTracking() ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_coder_pi_CoderNative_nativeMouseEvent(JNIEnv* env, jobject, jlong handle, jint action, jfloat x, jfloat y, jint button, jint metaState) {
    auto output = terminal(reinterpret_cast<NativeTerminal*>(handle))->mouse(action, x, y, button, metaState);
    jbyteArray result = env->NewByteArray(static_cast<jsize>(output.size()));
    if (!output.empty()) env->SetByteArrayRegion(result, 0, static_cast<jsize>(output.size()), reinterpret_cast<const jbyte*>(output.data()));
    return result;
}

extern "C" JNIEXPORT jintArray JNICALL
Java_com_coder_pi_CoderNative_nativeScreenPositionFromViewport(JNIEnv* env, jobject, jlong handle, jint row, jint col) {
    int screenRow = 0;
    int screenCol = 0;
    jintArray result = env->NewIntArray(2);
    jint values[2] = {-1, -1};
    if (terminal(reinterpret_cast<NativeTerminal*>(handle))->screenPositionFromViewport(row, col, screenRow, screenCol)) {
        values[0] = screenRow;
        values[1] = screenCol;
    }
    env->SetIntArrayRegion(result, 0, 2, values);
    return result;
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSetSelection(JNIEnv*, jobject, jlong handle, jboolean active, jint startRow, jint startCol, jint endRow, jint endCol) {
    terminal(reinterpret_cast<NativeTerminal*>(handle))->setSelection(active == JNI_TRUE, startRow, startCol, endRow, endCol);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_coder_pi_CoderNative_nativeCopySelection(JNIEnv* env, jobject, jlong handle) {
    auto text = terminal(reinterpret_cast<NativeTerminal*>(handle))->copySelection();
    return env->NewStringUTF(text.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_coder_pi_CoderNative_nativeTitle(JNIEnv* env, jobject, jlong handle) {
    auto text = terminal(reinterpret_cast<NativeTerminal*>(handle))->title();
    return env->NewStringUTF(text.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_coder_pi_CoderNative_nativePwd(JNIEnv* env, jobject, jlong handle) {
    auto text = terminal(reinterpret_cast<NativeTerminal*>(handle))->pwd();
    return env->NewStringUTF(text.c_str());
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_coder_pi_CoderNative_nativeBellCount(JNIEnv*, jobject, jlong handle) {
    return static_cast<jlong>(terminal(reinterpret_cast<NativeTerminal*>(handle))->bellCount());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_coder_pi_CoderNative_nativeHyperlinkUriAt(JNIEnv* env, jobject, jlong handle, jint row, jint col) {
    auto text = terminal(reinterpret_cast<NativeTerminal*>(handle))->hyperlinkUriAt(row, col);
    return env->NewStringUTF(text.c_str());
}

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_coder_pi_CoderNative_nativeConsumeOscEvents(JNIEnv* env, jobject, jlong handle) {
    auto events = terminal(reinterpret_cast<NativeTerminal*>(handle))->consumeOscEvents();
    jclass stringClass = env->FindClass("java/lang/String");
    jobjectArray result = env->NewObjectArray(static_cast<jsize>(events.size()), stringClass, env->NewStringUTF(""));
    for (size_t index = 0; index < events.size(); index++) {
        jstring value = env->NewStringUTF(events[index].c_str());
        env->SetObjectArrayElement(result, static_cast<jsize>(index), value);
        env->DeleteLocalRef(value);
    }
    return result;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_coder_pi_CoderNative_nativeSelectedText(JNIEnv* env, jobject, jlong handle, jint startRow, jint startCol, jint endRow, jint endCol) {
    auto text = terminal(reinterpret_cast<NativeTerminal*>(handle))->selectedText(startRow, startCol, endRow, endCol);
    return env->NewStringUTF(text.c_str());
}

static void appendUtf8(std::string& output, uint32_t codepoint) {
    if (codepoint <= 0x7f) {
        output.push_back(static_cast<char>(codepoint));
    } else if (codepoint <= 0x7ff) {
        output.push_back(static_cast<char>(0xc0 | (codepoint >> 6)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    } else if (codepoint <= 0xffff) {
        output.push_back(static_cast<char>(0xe0 | (codepoint >> 12)));
        output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    } else {
        output.push_back(static_cast<char>(0xf0 | (codepoint >> 18)));
        output.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3f)));
        output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    }
}

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_coder_pi_CoderNative_nativeSnapshotText(JNIEnv* env, jobject, jlong handle) {
    int cols = 0;
    int rows = 0;
    int cursorCol = 0;
    int cursorRow = 0;
    auto cells = terminal(reinterpret_cast<NativeTerminal*>(handle))->snapshot(cols, rows, cursorCol, cursorRow);
    jclass stringClass = env->FindClass("java/lang/String");
    jobjectArray result = env->NewObjectArray(rows, stringClass, env->NewStringUTF(""));
    for (int row = 0; row < rows; row++) {
        std::string text;
        text.reserve(static_cast<size_t>(cols));
        for (int col = 0; col < cols; col++) {
            const auto& cell = cells[static_cast<size_t>(row * cols + col)];
            if (cell.codepointCount == 0) {
                text.push_back(' ');
                continue;
            }
            for (uint32_t index = 0; index < cell.codepointCount; index++) appendUtf8(text, cell.codepoints[index]);
        }
        while (!text.empty() && text.back() == ' ') text.pop_back();
        jstring line = env->NewStringUTF(text.c_str());
        env->SetObjectArrayElement(result, row, line);
        env->DeleteLocalRef(line);
    }
    return result;
}
