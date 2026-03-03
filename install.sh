#!/usr/bin/env bash
# claude-sounds installer
# Usage: curl -fsSL https://raw.githubusercontent.com/user/claude-sounds/main/install.sh | bash
#
# Runs the interactive claude-sounds setup via npx.
# Requires Node.js 18+ (which Claude Code already requires).

set -e

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required but not found."
  echo "Claude Code requires Node.js 18+ — install it from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js 18+ is required (found v$(node -v))"
  exit 1
fi

echo ""
echo "  🔊 Installing Claude Sounds..."
echo ""

npx claude-sounds "$@"
