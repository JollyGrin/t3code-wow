#!/bin/bash
# Install or update T3 Code for World of Warcraft.
#
#   curl -fsSL https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.sh | bash
#
# Run the same command again to update. From a clone, ./install.sh installs that copy.
# Options (after `bash -s --` when piping): --wow "/path/to/World of Warcraft" --slots N --no-service
#
# Copies the bridge and addon to ~/.local/share/t3code-wow, puts `t3code-wow` on your
# PATH, then runs `t3code-wow install`, which installs the addon into the game, gives
# the bridge a T3 Code session, starts it as a user service and walks you through the
# first launch.
set -euo pipefail

repo="ryanrhughes/t3code-wow"
ref="${T3CODE_WOW_REF:-main}"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/t3code-wow"
bin="$HOME/.local/bin"

if ! command -v node >/dev/null 2>&1; then
  if [[ $(uname -s) == "Darwin" ]]; then
    echo "T3 Code for World of Warcraft needs Node.js 22 or newer: brew install node (or mise use -g node@lts)." >&2
  else
    echo "T3 Code for World of Warcraft needs Node.js 22 or newer: mise use -g node@lts (or pacman -S nodejs)." >&2
  fi
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 22 )); then
  echo "T3 Code for World of Warcraft needs Node.js 22 or newer; found $(node --version)." >&2
  exit 1
fi

# KDE Plasma doesn't need grim: the bridge reads the game through KWin's D-Bus API.
if [[ ${XDG_SESSION_TYPE:-} == "wayland" && :${XDG_CURRENT_DESKTOP:-}: != *:KDE:* ]] && ! command -v grim >/dev/null 2>&1; then
  echo "Note: install grim so the bridge can see the game (pacman -S grim)." >&2
fi

# Install from this checkout, or download the latest version when piped from curl.
src=""
here="${BASH_SOURCE[0]:-}"
if [[ -n $here && -f $here ]]; then
  here="$(cd "$(dirname "$here")" && pwd)"
  if [[ -d "$here/bridge" && -d "$here/addon" ]]; then
    src="$here"
  fi
fi
if [[ -z $src ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading T3 Code for World of Warcraft ($ref)…"
  url="${T3CODE_WOW_TARBALL:-https://codeload.github.com/$repo/tar.gz/$ref}"
  if ! curl -fsSL "$url" | tar -xz -C "$tmp" --strip-components=1; then
    echo "Couldn't download $url." >&2
    exit 1
  fi
  src="$tmp"
fi

mkdir -p "$dest" "$bin"
rm -rf "$dest/bridge.new" "$dest/addon.new"
cp -r "$src/bridge" "$dest/bridge.new"
cp -r "$src/addon" "$dest/addon.new"
rm -rf "$dest/bridge" "$dest/addon"
mv "$dest/bridge.new" "$dest/bridge"
mv "$dest/addon.new" "$dest/addon"
chmod +x "$dest/bridge/bin/t3code-wow.js"
ln -sf "$dest/bridge/bin/t3code-wow.js" "$bin/t3code-wow"
if [[ ":$PATH:" != *":$bin:"* ]]; then
  echo "Note: $bin isn't on your PATH, so run t3code-wow as $bin/t3code-wow (or add $bin to PATH in your shell profile)." >&2
fi

# When piped from curl, stdin is this script; give the guided setup the keyboard.
if [[ ! -t 0 ]] && (: </dev/tty) 2>/dev/null; then
  node "$dest/bridge/bin/t3code-wow.js" install "$@" </dev/tty
else
  node "$dest/bridge/bin/t3code-wow.js" install "$@"
fi
