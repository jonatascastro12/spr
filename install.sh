#!/usr/bin/env bash
set -euo pipefail

REPO="jonatascastro12/gw"
INSTALL_DIR="${GW_INSTALL_DIR:-/usr/local/bin}"
BINARY="gw"

get_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac
}

get_os() {
  local os
  os="$(uname -s)"
  case "$os" in
    Linux)  echo "linux" ;;
    Darwin) echo "darwin" ;;
    *) echo "Unsupported OS: $os" >&2; exit 1 ;;
  esac
}

main() {
  local os arch target tag url tmp

  os="$(get_os)"
  arch="$(get_arch)"
  target="gw-${os}-${arch}"

  echo "Detected platform: ${os}-${arch}"

  # Get latest release tag
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)"
  if [ -z "$tag" ]; then
    echo "Error: could not determine latest release." >&2
    exit 1
  fi
  echo "Latest release: ${tag}"

  url="https://github.com/${REPO}/releases/download/${tag}/${target}"

  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT

  echo "Downloading ${url}..."
  curl -fsSL -o "$tmp" "$url"
  chmod +x "$tmp"

  # Install — use sudo if needed
  if [ -w "$INSTALL_DIR" ]; then
    mv "$tmp" "${INSTALL_DIR}/${BINARY}"
  else
    echo "Installing to ${INSTALL_DIR} (requires sudo)..."
    sudo mv "$tmp" "${INSTALL_DIR}/${BINARY}"
  fi

  echo "Installed gw ${tag} to ${INSTALL_DIR}/${BINARY}"
  echo ""
  echo "Run 'gw --help' to get started."
}

main
