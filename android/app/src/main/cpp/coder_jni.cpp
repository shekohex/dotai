#include "coder_renderer.h"
#include "coder_terminal.h"

#include <jni.h>
#include <memory>

struct CoderSession {
    CoderTerminal terminal;
    CoderRenderer renderer;
};

extern "C" JNIEXPORT jlong JNICALL
Java_com_coder_pi_CoderNative_nativeInit(JNIEnv* env, jobject, jint cols, jint rows, jint cellWidth, jint cellHeight, jstring bashPath, jstring busyBoxPath, jstring toolsDir) {
    auto session = std::make_unique<CoderSession>();
    const char* bashPathChars = env->GetStringUTFChars(bashPath, nullptr);
    const char* busyBoxPathChars = env->GetStringUTFChars(busyBoxPath, nullptr);
    const char* toolsDirChars = env->GetStringUTFChars(toolsDir, nullptr);
    session->terminal.start(cols, rows, cellWidth, cellHeight, bashPathChars, busyBoxPathChars, toolsDirChars);
    env->ReleaseStringUTFChars(bashPath, bashPathChars);
    env->ReleaseStringUTFChars(busyBoxPath, busyBoxPathChars);
    env->ReleaseStringUTFChars(toolsDir, toolsDirChars);
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
    jsize length = env->GetArrayLength(bytes);
    jbyte* data = env->GetByteArrayElements(bytes, nullptr);
    session->renderer.setFontData(reinterpret_cast<const uint8_t*>(data), static_cast<size_t>(length));
    env->ReleaseByteArrayElements(bytes, data, JNI_ABORT);
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
