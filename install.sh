#!/bin/sh
set -eu

REPO="leohenon/opencode-vim"
INSTALL_DIR="${OCV_INSTALL_DIR:-$HOME/.ocv/bin}"
VERSION="${OCV_VERSION:-}"
MODIFY_PATH=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "--version requires a value" >&2; exit 1; }
      VERSION="${2#v}"
      shift 2
      ;;
    --no-modify-path)
      MODIFY_PATH=0
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS" in
  linux) PLATFORM="linux" ;;
  darwin) PLATFORM="darwin" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "https://registry.npmjs.org/@leohenon%2Focv/ocv-v2" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi
[ -n "$VERSION" ] || { echo "Could not determine the OCV V2 preview version" >&2; exit 1; }
case "$VERSION" in
  2.*-ocv.*) ;;
  *) echo "Expected an OCV V2 version, got: $VERSION" >&2; exit 1 ;;
esac

SUFFIX=""
if [ "$ARCH" = "x64" ]; then
  if [ "$PLATFORM" = "linux" ] && ! grep -q -m1 -w avx2 /proc/cpuinfo 2>/dev/null; then SUFFIX="-baseline"; fi
  if [ "$PLATFORM" = "darwin" ] && [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || true)" != "1" ]; then SUFFIX="-baseline"; fi
fi
if [ "$PLATFORM" = "linux" ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
  SUFFIX="$SUFFIX-musl"
fi
TARGET="ocv-$PLATFORM-$ARCH$SUFFIX"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$INSTALL_DIR"

echo "Installing ocv v$VERSION ($PLATFORM/$ARCH)..."
BASE="https://github.com/$REPO/releases/download/v$VERSION/$TARGET"
if [ "$PLATFORM" = "linux" ]; then
  curl -fSL "$BASE.tar.gz" | tar -xz -C "$TMP"
else
  curl -fSL -o "$TMP/ocv.zip" "$BASE.zip"
  unzip -q "$TMP/ocv.zip" -d "$TMP"
fi
SOURCE=$(find "$TMP" -type f \( -name opencode -o -name ocv \) | head -n 1)
[ -n "$SOURCE" ] || { echo "Release archive did not contain the OCV binary" >&2; exit 1; }
mv "$SOURCE" "$INSTALL_DIR/ocv"
chmod +x "$INSTALL_DIR/ocv"

add_to_path() {
  file="$1"
  command="$2"
  [ -f "$file" ] || return 1
  grep -Fqx "$command" "$file" && return 0
  [ -w "$file" ] || return 1
  printf '\n# OCV\n%s\n' "$command" >> "$file"
  echo "Added $INSTALL_DIR to PATH in $file"
}

if [ "$MODIFY_PATH" = 1 ] && [ -z "${OCV_NO_MODIFY_PATH:-}" ] && [ -z "${OCV_INSTALL_DIR:-}" ]; then
  shell=$(basename "${SHELL:-sh}")
  command="export PATH=\"$INSTALL_DIR:\$PATH\""
  case "$shell" in
    fish) add_to_path "$HOME/.config/fish/config.fish" "fish_add_path \"$INSTALL_DIR\"" || true ;;
    zsh) add_to_path "${ZDOTDIR:-$HOME}/.zshrc" "$command" || add_to_path "${ZDOTDIR:-$HOME}/.zshenv" "$command" || true ;;
    bash) add_to_path "$HOME/.bashrc" "$command" || add_to_path "$HOME/.bash_profile" "$command" || add_to_path "$HOME/.profile" "$command" || true ;;
    *) add_to_path "$HOME/.profile" "$command" || true ;;
  esac
fi

echo "Installed ocv to $INSTALL_DIR/ocv"
echo "Run 'ocv' to start."
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf '\nAdd OCV to PATH:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR" ;;
esac
