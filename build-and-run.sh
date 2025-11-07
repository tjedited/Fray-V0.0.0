#!/bin/bash

# This script is designed to run on macOS (natively) and Windows (using Git Bash or WSL).

echo "Starting cross-platform script..."

# Detect the operating system
UNAME_OUT="$(uname)"
if [[ "$UNAME_OUT" == "Darwin" ]]; then
    OUT_DIR="Engine/build/Darwin"
    OUT_BIN="$OUT_DIR/main"
elif [[ "$UNAME_OUT" == MINGW* || "$UNAME_OUT" == MSYS* || "$UNAME_OUT" == CYGWIN* ]]; then
    OUT_DIR="Engine/build/Windows"
    OUT_BIN="$OUT_DIR/main.exe"
else
    echo "Unsupported OS: $UNAME_OUT"
    exit 1
fi

mkdir -p "$OUT_DIR"

# Compile main.cpp
g++ Engine/main.cpp -o "$OUT_BIN"

echo "Build complete: $OUT_BIN"

# Run Electron app
cd Electron
npm run start