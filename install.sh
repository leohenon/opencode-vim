#!/bin/sh
set -e

REPO="leohenon/opencode-vim"
INSTALL_DIR="${OCV_INSTALL_DIR:-$HOME/.ocv/bin}"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
linux) PLATFORM="linux" ;;
darwin) PLATFORM="darwin" ;;
*) echo "Unsupported OS: $OS" && exit 1 ;;
esac

case "$ARCH" in
x86_64 | amd64) ARCH="x64" ;;
aarch64 | arm64) ARCH="arm64" ;;
*) echo "Unsupported architecture: $ARCH" && exit 1 ;;
esac

TARGET="ocv-${PLATFORM}-${ARCH}"

# Get latest version
if [ -z "$OCV_VERSION" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed 's/.*"v\(.*\)".*/\1/')
else
  VERSION="$OCV_VERSION"
fi

if [ -z "$VERSION" ]; then
  echo "Could not determine latest version"
  exit 1
fi

echo "Installing ocv v$VERSION ($PLATFORM/$ARCH)..."
mkdir -p "$INSTALL_DIR"

# Download
URL="https://github.com/$REPO/releases/download/v$VERSION/$TARGET"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ "$PLATFORM" = "linux" ]; then
  URL="$URL.tar.gz"
  curl -fSL "$URL" | tar -xz -C "$TMP"
else
  URL="$URL.zip"
  curl -fSL -o "$TMP/ocv.zip" "$URL"
  unzip -q "$TMP/ocv.zip" -d "$TMP"
fi

mv "$TMP/opencode" "$INSTALL_DIR/ocv"
chmod +x "$INSTALL_DIR/ocv"

add_to_path() {
  CONFIG_FILE="$1"
  COMMAND="$2"

  if [ ! -f "$CONFIG_FILE" ]; then
    return 1
  fi

  if grep -Fxq "$COMMAND" "$CONFIG_FILE"; then
    return 0
  fi

  if [ -w "$CONFIG_FILE" ]; then
    {
      echo ""
      echo "# OpenCode Vim"
      echo "$COMMAND"
    } >> "$CONFIG_FILE"
    echo "Added $INSTALL_DIR to PATH in $CONFIG_FILE"
    return 0
  fi

  return 1
}

if [ "${OCV_NO_MODIFY_PATH:-}" != "1" ] && [ "${OCV_INSTALL_DIR:-}" = "" ]; then
  CURRENT_SHELL=$(basename "${SHELL:-sh}")
  PATH_COMMAND="export PATH=\"$INSTALL_DIR:\$PATH\""

  case "$CURRENT_SHELL" in
  fish)
    PATH_COMMAND="fish_add_path \"$INSTALL_DIR\""
    add_to_path "$HOME/.config/fish/config.fish" "$PATH_COMMAND" || true
    ;;
  zsh)
    add_to_path "${ZDOTDIR:-$HOME}/.zshrc" "$PATH_COMMAND" || add_to_path "${ZDOTDIR:-$HOME}/.zshenv" "$PATH_COMMAND" || true
    ;;
  bash)
    add_to_path "$HOME/.bashrc" "$PATH_COMMAND" || add_to_path "$HOME/.bash_profile" "$PATH_COMMAND" || add_to_path "$HOME/.profile" "$PATH_COMMAND" || true
    ;;
  *)
    add_to_path "$HOME/.profile" "$PATH_COMMAND" || true
    ;;
  esac
fi

case ":$PATH:" in
*":$INSTALL_DIR:"*) ;;
*)
  echo ""
  echo "Add ocv to your PATH:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
  echo ""
  echo "Then restart your shell or run the command above."
  ;;
esac

echo "Installed ocv to $INSTALL_DIR/ocv"
echo "Run 'ocv' to start."

if [ "$INSTALL_DIR" != "/usr/local/bin" ] && [ -x "/usr/local/bin/ocv" ]; then
  echo ""
  echo "Note: /usr/local/bin/ocv also exists from a previous install."
  echo "Remove it or make sure $INSTALL_DIR comes first in PATH."
fi
