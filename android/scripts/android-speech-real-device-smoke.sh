#!/usr/bin/env bash
set -euo pipefail

serial="${1:-}"
package_name="com.coder.pi"
test_package="com.coder.pi.test"
output_dir="build/validation/speech-real-device/$(date +%Y%m%d-%H%M%S)"

if [[ -z "$serial" ]]; then
  serial="$(adb devices -l | awk '/Pixel_7_Pro|Tab_A9/ { print $1; exit }')"
fi

if [[ -z "$serial" ]]; then
  echo "No Pixel 7 Pro or Samsung Tab A9 connected." >&2
  adb devices -l >&2
  exit 2
fi

model="$(adb -s "$serial" shell getprop ro.product.model | tr -d '\r')"
case "$model" in
  *"Pixel 7 Pro"*|*"Tab A9"*) ;;
  *)
    echo "Unsupported target model: $model" >&2
    exit 2
    ;;
esac

mkdir -p "$output_dir"
{
  echo "serial=$serial"
  echo "model=$model"
  echo "board=$(adb -s "$serial" shell getprop ro.board.platform | tr -d '\r')"
  echo "fingerprint=$(adb -s "$serial" shell getprop ro.build.fingerprint | tr -d '\r')"
} | tee "$output_dir/device.txt"

./gradlew assembleDebug assembleDebugAndroidTest --no-daemon
adb -s "$serial" install -r app/build/outputs/apk/debug/app-arm64-v8a-debug.apk
adb -s "$serial" install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

if [[ -x scripts/android-restore-speech-models.sh ]]; then
  scripts/android-restore-speech-models.sh "$serial" | tee "$output_dir/model-restore.log"
fi

adb -s "$serial" logcat -c
adb -s "$serial" shell input keyevent KEYCODE_WAKEUP || true
adb -s "$serial" shell wm dismiss-keyguard || true

adb -s "$serial" shell am start -W -a android.intent.action.VIEW -d 'pi://settings/speech' -n "$package_name/.MainActivity" | tee "$output_dir/settings-start.txt"
sleep 2
adb -s "$serial" exec-out screencap -p > "$output_dir/settings-speech.png"

adb -s "$serial" shell am instrument -w -e class com.coder.pi.SpeechDebugWorkflowInstrumentedTest "$test_package/androidx.test.runner.AndroidJUnitRunner" | tee "$output_dir/speech-debug-instrumentation.txt"

for state in RECORDING_WITH_SPEECH TRANSCRIPT_READY ENHANCEMENT_FAILED ENHANCED_READY; do
  adb -s "$serial" shell am force-stop "$package_name"
  adb -s "$serial" shell am start -W -a android.intent.action.VIEW -d "pi://debug/speech?state=$state" -n "$package_name/.MainActivity" > "$output_dir/${state}-start.txt"
  sleep 1
  adb -s "$serial" exec-out screencap -p > "$output_dir/${state}.png"
done

adb -s "$serial" logcat -d -t 2000 | grep -Ei 'FATAL EXCEPTION|AndroidRuntime|ANR|LiteRT|Tensor|OOM|Speech|Parakeet|Model|transcrib|audio|microphone' > "$output_dir/sanitized-log-excerpt.txt" || true

echo "Speech real-device smoke artifacts: $output_dir"
