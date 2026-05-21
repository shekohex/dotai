#!/usr/bin/env bash
set -euo pipefail

DEVICE="${1:-}"
if [[ -z "$DEVICE" ]]; then
  DEVICE="$(adb devices | awk '/device$/{print $1; exit}')"
fi

if [[ -z "$DEVICE" ]]; then
  echo "No adb device found" >&2
  exit 1
fi

MODEL_DIR="models"
MODEL="parakeet_tdt_0.6b_v3_5s_i8_stateful.tflite"
TOKENIZER="parakeet_tdt_0.6b_v3_tokenizer.json"

test -f "$MODEL_DIR/$MODEL"
test -f "$MODEL_DIR/$TOKENIZER"

adb -s "$DEVICE" shell run-as com.coder.pi mkdir -p files/speech/parakeet
adb -s "$DEVICE" push "$MODEL_DIR/$MODEL" "/data/local/tmp/$MODEL"
adb -s "$DEVICE" push "$MODEL_DIR/$TOKENIZER" "/data/local/tmp/$TOKENIZER"
adb -s "$DEVICE" shell run-as com.coder.pi cp "/data/local/tmp/$MODEL" "files/speech/parakeet/$MODEL"
adb -s "$DEVICE" shell run-as com.coder.pi cp "/data/local/tmp/$TOKENIZER" "files/speech/parakeet/$TOKENIZER"
adb -s "$DEVICE" shell rm "/data/local/tmp/$MODEL" "/data/local/tmp/$TOKENIZER"
adb -s "$DEVICE" shell run-as com.coder.pi ls -lh files/speech/parakeet
