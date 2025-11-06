#!/bin/bash

# This script is designed to run on macOS (natively) and Windows (using Git Bash or WSL).

echo "Starting cross-platform script..."

# Detect the operating system
if [[ "$(uname)" == "Darwin" ]]; then
    OS="macOS"
elif [[ "$(uname)" == "Linux" ]]; then
    # Note: WSL identifies as Linux
    OS="Windows (WSL/Git Bash)"
else
    OS="Other/Unknown"
fi

echo "Detected OS: $OS"

# Example of a common command: listing files
echo "Listing files in current directory:"
ls -l

echo "Script finished."
