#!/bin/sh
# Maka on a Mac, everything on the LaCie, then hand over to a local Claude Code session.
# Usage (on the Mac, in Terminal):  sh mac-bootstrap.sh [/Volumes/LaCie]
set -eu
ROOT="${1:-/Volumes/LaCie}"
if [ ! -d "$ROOT" ]; then echo "Drive not found at $ROOT. Plug in the LaCie or pass its path: sh mac-bootstrap.sh /Volumes/<name>"; exit 1; fi
FS=$(diskutil info "$ROOT" 2>/dev/null | awk -F': *' '/File System Personality/ {print $2}')
case "$FS" in
  *APFS*|*"Mac OS Extended"*|*HFS*) echo "Drive format: $FS (ok)";;
  "") echo "Could not read the drive format; continuing";;
  *) echo "Drive format is $FS. Maka's keystore needs APFS or Mac OS Extended (POSIX permissions). Reformat the drive (Disk Utility, erases it) or use the app's Keychain only."; exit 1;;
esac
BASE="$ROOT/Maka"; mkdir -p "$BASE/home" "$BASE/workspace" "$BASE/ollama"
command -v brew >/dev/null || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || true)"
brew list node@22 >/dev/null 2>&1 || brew install node@22
brew link --overwrite --force node@22 >/dev/null 2>&1 || true
brew list --cask ollama >/dev/null 2>&1 || brew install --cask ollama
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
if [ ! -d "$BASE/repo/.git" ]; then git clone https://github.com/aimran6775/Maka.git "$BASE/repo"; else git -C "$BASE/repo" pull --ff-only; fi
PROFILE="$HOME/.zprofile"
grep -q "MAKA_HOME=" "$PROFILE" 2>/dev/null || cat >> "$PROFILE" <<ENV

# Maka on the LaCie
export MAKA_HOME="$BASE/home"
export MAKA_WORKSPACE="$BASE/workspace"
export OLLAMA_MODELS="$BASE/ollama"
ENV
export MAKA_HOME="$BASE/home" MAKA_WORKSPACE="$BASE/workspace" OLLAMA_MODELS="$BASE/ollama"
cd "$BASE/repo"
node --version
npm run assets:check
npm run test:fast 2>&1 | grep -E "^# (tests|pass|fail)"
echo
echo "Ready. Pull a worker model with:   ollama pull qwen3:8b     (Ollama must be running; open the Ollama app once)"
echo "Then start the local Claude Code session here with:   claude"
echo "and tell it:  read docs/MAC_HANDOFF.md and drive it"
