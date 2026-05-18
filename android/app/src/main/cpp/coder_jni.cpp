#include "coder_renderer.h"
#include "coder_terminal.h"

#include <jni.h>
#include <memory>
#include <string>

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

struct CoderSession {
    CoderTerminal terminal;
    CoderRenderer renderer;
};

extern "C" JNIEXPORT jlong JNICALL
Java_com_coder_pi_CoderNative_nativeInit(JNIEnv*, jobject, jint cols, jint rows, jint cellWidth, jint cellHeight) {
    auto session = std::make_unique<CoderSession>();
    session->terminal.start(cols, rows, cellWidth, cellHeight);
    return reinterpret_cast<jlong>(session.release());
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeDispose(JNIEnv*, jobject, jlong handle) {
    delete reinterpret_cast<CoderSession*>(handle);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSurfaceCreated(JNIEnv*, jobject, jlong handle) {
    reinterpret_cast<CoderSession*>(handle)->renderer.init();
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSetFont(JNIEnv* env, jobject, jlong handle, jbyteArray bytes) {
    auto* session = reinterpret_cast<CoderSession*>(handle);
    JniByteArrayView regular(env, bytes);
    session->renderer.setFontData(regular.bytes(), regular.size());
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSetFontStyles(JNIEnv* env, jobject, jlong handle, jbyteArray regularBytes, jbyteArray boldBytes, jbyteArray italicBytes, jbyteArray boldItalicBytes) {
    auto* session = reinterpret_cast<CoderSession*>(handle);
    JniByteArrayView regular(env, regularBytes);
    JniByteArrayView bold(env, boldBytes);
    JniByteArrayView italic(env, italicBytes);
    JniByteArrayView boldItalic(env, boldItalicBytes);
    session->renderer.setFontData(regular.bytes(), regular.size(), bold.bytes(), bold.size(), italic.bytes(), italic.size(), boldItalic.bytes(), boldItalic.size());
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSetShaderCacheDir(JNIEnv* env, jobject, jlong handle, jstring path) {
    auto* session = reinterpret_cast<CoderSession*>(handle);
    const char* chars = env->GetStringUTFChars(path, nullptr);
    if (!chars) return;
    session->renderer.setShaderCacheDir(chars);
    env->ReleaseStringUTFChars(path, chars);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSetTheme(JNIEnv* env, jobject, jlong handle, jint foreground, jint background, jint cursor, jint cursorText, jintArray palette) {
    auto* session = reinterpret_cast<CoderSession*>(handle);
    jsize length = env->GetArrayLength(palette);
    jint* data = env->GetIntArrayElements(palette, nullptr);
    session->terminal.setTheme(static_cast<uint32_t>(foreground), static_cast<uint32_t>(background), static_cast<uint32_t>(cursor), reinterpret_cast<const uint32_t*>(data), static_cast<size_t>(length));
    session->renderer.setTheme(static_cast<uint32_t>(background), static_cast<uint32_t>(cursor), static_cast<uint32_t>(cursorText));
    env->ReleaseIntArrayElements(palette, data, JNI_ABORT);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSetTextOptions(JNIEnv*, jobject, jlong handle, jboolean ligatures, jboolean contextualAlternates, jboolean slashedZero, jboolean stylisticSet1, jboolean stylisticSet2, jboolean characterVariant1, jboolean cursorBlink, jint cursorMode) {
    reinterpret_cast<CoderSession*>(handle)->renderer.setTextOptions(ligatures == JNI_TRUE, contextualAlternates == JNI_TRUE, slashedZero == JNI_TRUE, stylisticSet1 == JNI_TRUE, stylisticSet2 == JNI_TRUE, characterVariant1 == JNI_TRUE, cursorBlink == JNI_TRUE, cursorMode);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSetRefreshRate(JNIEnv*, jobject, jlong handle, jfloat refreshRate) {
    reinterpret_cast<CoderSession*>(handle)->renderer.setTargetRefreshRate(refreshRate);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeSurfaceChanged(JNIEnv*, jobject, jlong handle, jint width, jint height, jint cellWidth, jint cellHeight) {
    auto* session = reinterpret_cast<CoderSession*>(handle);
    session->renderer.setCellSize(cellWidth, cellHeight);
    session->renderer.resize(width, height);
    session->terminal.resize(width / cellWidth, height / cellHeight, cellWidth, cellHeight);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeDrawFrame(JNIEnv*, jobject, jlong handle) {
    auto* session = reinterpret_cast<CoderSession*>(handle);
    session->renderer.draw(session->terminal);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeWrite(JNIEnv* env, jobject, jlong handle, jbyteArray bytes) {
    auto* session = reinterpret_cast<CoderSession*>(handle);
    jsize length = env->GetArrayLength(bytes);
    jbyte* data = env->GetByteArrayElements(bytes, nullptr);
    session->terminal.writeUtf8(reinterpret_cast<const char*>(data), length);
    env->ReleaseByteArrayElements(bytes, data, JNI_ABORT);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeFeed(JNIEnv* env, jobject, jlong handle, jbyteArray bytes) {
    auto* session = reinterpret_cast<CoderSession*>(handle);
    jsize length = env->GetArrayLength(bytes);
    jbyte* data = env->GetByteArrayElements(bytes, nullptr);
    session->terminal.feed(reinterpret_cast<const uint8_t*>(data), static_cast<size_t>(length));
    env->ReleaseByteArrayElements(bytes, data, JNI_ABORT);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeTextInput(JNIEnv* env, jobject, jlong handle, jstring text) {
    auto* session = reinterpret_cast<CoderSession*>(handle);
    const char* chars = env->GetStringUTFChars(text, nullptr);
    if (chars) {
        for (const unsigned char* cursor = reinterpret_cast<const unsigned char*>(chars); *cursor != 0; cursor++) {
            session->terminal.key(0, *cursor, 0);
        }
        env->ReleaseStringUTFChars(text, chars);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeKeyEvent(JNIEnv*, jobject, jlong handle, jint keyCode, jint unicodeChar, jint metaState) {
    reinterpret_cast<CoderSession*>(handle)->terminal.key(keyCode, unicodeChar, metaState);
}

extern "C" JNIEXPORT void JNICALL
Java_com_coder_pi_CoderNative_nativeScroll(JNIEnv*, jobject, jlong handle, jint rowDelta) {
    reinterpret_cast<CoderSession*>(handle)->terminal.scroll(rowDelta);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_coder_pi_CoderNative_nativeScrollInput(JNIEnv* env, jobject, jlong handle, jint rowDelta, jfloat x, jfloat y) {
    auto output = reinterpret_cast<CoderSession*>(handle)->terminal.scrollInput(rowDelta, x, y);
    jbyteArray result = env->NewByteArray(static_cast<jsize>(output.size()));
    if (!output.empty()) env->SetByteArrayRegion(result, 0, static_cast<jsize>(output.size()), reinterpret_cast<const jbyte*>(output.data()));
    return result;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_coder_pi_CoderNative_nativeMouseTracking(JNIEnv*, jobject, jlong handle) {
    return reinterpret_cast<CoderSession*>(handle)->terminal.mouseTracking() ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_coder_pi_CoderNative_nativeMouseEvent(JNIEnv* env, jobject, jlong handle, jint action, jfloat x, jfloat y, jint button, jint metaState) {
    auto output = reinterpret_cast<CoderSession*>(handle)->terminal.mouse(action, x, y, button, metaState);
    jbyteArray result = env->NewByteArray(static_cast<jsize>(output.size()));
    if (!output.empty()) env->SetByteArrayRegion(result, 0, static_cast<jsize>(output.size()), reinterpret_cast<const jbyte*>(output.data()));
    return result;
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
    auto* session = reinterpret_cast<CoderSession*>(handle);
    int cols = 0;
    int rows = 0;
    int cursorCol = 0;
    int cursorRow = 0;
    auto cells = session->terminal.snapshot(cols, rows, cursorCol, cursorRow);
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
