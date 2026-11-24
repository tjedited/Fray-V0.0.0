#!/bin/bash

echo "Starting cross-platform script..."

cd Engine

# Detect the operating system
UNAME_OUT="$(uname)"
if [[ "$UNAME_OUT" == "Darwin" ]]; then
    BREW_INCLUDE=/opt/homebrew/include
    BREW_LIB=/opt/homebrew/lib
    INCLUDE_FLAGS="-I$BREW_INCLUDE"
    LIB_FLAGS="-L$BREW_LIB"
    OUT_DIR="build/Darwin"
    OUT_BIN="$OUT_DIR/engine"
elif [[ "$UNAME_OUT" == MINGW* || "$UNAME_OUT" == MSYS* || "$UNAME_OUT" == CYGWIN* ]]; then
    VCPKG_INCLUDE="C:/vcpkg/installed/x64-windows/include"
    VCPKG_LIB="C:/vcpkg/installed/x64-windows/lib"
    INCLUDE_FLAGS="-I$VCPKG_INCLUDE"
    LIB_FLAGS="-L$VCPKG_LIB -lws2_32"
    OUT_DIR="build/Windows"
    OUT_BIN="$OUT_DIR/engine.exe"
else
    echo "Unsupported OS: $UNAME_OUT"
    exit 1
fi

LIB_FLAGS="$LIB_FLAGS -lsqlite3 -lzip -pthread"

mkdir -p "$OUT_DIR"

echo "Compiling with: g++ -std=c++17 $(find . -name '*.cpp') $INCLUDE_FLAGS $LIB_FLAGS -o $OUT_BIN"
g++ -std=c++17 $(find . -name '*.cpp') $INCLUDE_FLAGS $LIB_FLAGS -o "$OUT_BIN"

"$OUT_BIN"