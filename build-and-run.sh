#!/bin/bash

# This script is designed to run on macOS (natively) and Windows (using Git Bash or WSL).

echo "Starting cross-platform script..."

# Detect the operating system
if [[ "$(uname)" == "Darwin" ]]; then
    OUT_DIR="Engine/build/Darwin"
    OUT_BIN="$OUT_DIR/main"
elif [[ "$(uname)" == "Linux" ]]; then
    # Note: WSL identifies as Linux
    OUT_DIR="Engine/build/Windows"
    OUT_BIN="$OUT_DIR/main.exe"
else
    echo "Unsupported OS: $(uname)"
    exit 1
fi

mkdir -p "$OUT_DIR"

# Compile main.cpp
g++ Engine/main.cpp -o "$OUT_BIN"

echo "Build complete: $OUT_BIN"

# Run Electron app
cd Electron
npm run start