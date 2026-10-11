#!/bin/sh
# Maka on a Mac, everything on the LaCie, then hand over to a local Claude Code session.
# Usage (on the Mac, in Terminal):  sh mac-bootstrap.sh [/Volumes/LaCie] [--keep-exfat]
#   --keep-exfat   the drive stays ExFAT: the keystore/data home goes on the internal disk
#                  (~/Maka/home), the big things (repo, workspace, Ollama models) on the drive.
set -eu
ROOT="/Volumes/LaCie"; KEEP_EXFAT=0
for a in "$@"; do case "$a" in --keep-exfat) KEEP_EXFAT=1;; *) ROOT="$a";; esac; done
if [ ! -d "$ROOT" ]; then echo "Drive not found at $ROOT. Plug in the LaCie or pass its path: sh mac-bootstrap.sh /Volumes/<name>"; exit 1; fi
FS=$(diskutil info "$ROOT" 2>/dev/null | awk -F': *' '/File System Personality/ {print $2}')
HOME_DIR=""
case "$FS" in
  *APFS*|*"Mac OS Extended"*|*HFS*) echo "Drive format: $FS (ok)"; HOME_DIR="$ROOT/Maka/home";;
  "") echo "Could not read the drive format; continuing"; HOME_DIR="$ROOT/Maka/home";;
  *) if [ "$KEEP_EXFAT" = 1 ]; then
       echo "Drive format is $FS: keeping it. Data home and keystore go on the internal disk (~/Maka/home); repo, workspace and models on the drive."
       HOME_DIR="$HOME/Maka/home"
     else
       echo "Drive format is $FS. Maka's keystore needs APFS or Mac OS Extended (POSIX permissions)."
       echo "Either: Disk Utility -> select the LaCie -> Erase -> Format APFS (erases everything on it), then rerun this script;"
       echo "or rerun with --keep-exfat to keep the drive as is and put the data home on the internal disk:"
       echo "    sh /tmp/maka-bootstrap.sh $ROOT --keep-exfat"
       exit 1
     fi;;
esac
BASE="$ROOT/Maka"; mkdir -p "$HOME_DIR" "$BASE/workspace" "$BASE/ollama"
command -v brew >/dev/null || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || true)"
brew list node@22 >/dev/null 2>&1 || brew install node@22
brew link --overwrite --force node@22 >/dev/null 2>&1 || true
brew list --cask ollama >/dev/null 2>&1 || brew install --cask ollama
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
if [ ! -d "$BASE/repo/.git" ]; then git clone https://github.com/aimran6775/Maka.git "$BASE/repo"; else git -C "$BASE/repo" pull --ff-only; fi
[ "$KEEP_EXFAT" = 1 ] && git -C "$BASE/repo" config core.filemode false || true
PROFILE="$HOME/.zprofile"
grep -q "MAKA_HOME=" "$PROFILE" 2>/dev/null || cat >> "$PROFILE" <<ENV

# Maka on the LaCie
export MAKA_HOME="$HOME_DIR"
export MAKA_WORKSPACE="$BASE/workspace"
export OLLAMA_MODELS="$BASE/ollama"
ENV
export MAKA_HOME="$HOME_DIR" MAKA_WORKSPACE="$BASE/workspace" OLLAMA_MODELS="$BASE/ollama"
cd "$BASE/repo"
node --version
npm run assets:check
npm run test:fast 2>&1 | grep -E "^# (tests|pass|fail)"
echo
echo "Ready. Pull a worker model with:   ollama pull qwen3:8b     (Ollama must be running; open the Ollama app once)"
echo "Then start the local Claude Code session here with:   claude"
echo "and tell it:  read docs/MAC_HANDOFF.md and drive it"
