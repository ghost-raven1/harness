#!/bin/sh
# Подготавливает точную версию Node локально, не меняя системную установку.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
case "$(uname -s)" in
  Darwin) HARNESS_OS=darwin ;;
  Linux) HARNESS_OS=linux ;;
  *) echo 'Для Windows откройте «Запустить Harness.cmd».'; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) HARNESS_ARCH=arm64 ;;
  x86_64|amd64) HARNESS_ARCH=x64 ;;
  *) echo 'Эта архитектура пока не поддерживается файлом запуска.'; exit 1 ;;
esac
HARNESS_VERSION=$(tr -d '\r\n' < "$ROOT/.nvmrc")
HARNESS_RELEASE="node-v$HARNESS_VERSION-$HARNESS_OS-$HARNESS_ARCH"
HARNESS_NODE="$ROOT/.tools/$HARNESS_RELEASE/bin/node"
HARNESS_NPM="$ROOT/.tools/$HARNESS_RELEASE/lib/node_modules/npm/bin/npm-cli.js"
runtime_ready() {
  [ -x "$HARNESS_NODE" ] && [ -f "$HARNESS_NPM" ] || return 1
  [ "$("$HARNESS_NODE" --version 2>/dev/null)" = "v$HARNESS_VERSION" ] || return 1
  case "$("$HARNESS_NODE" "$HARNESS_NPM" --version 2>/dev/null)" in
    11.*) return 0 ;;
    *) return 1 ;;
  esac
}
if ! runtime_ready; then
  mkdir -p "$ROOT/.tools"
  HARNESS_DOWNLOAD=$(mktemp -d "$ROOT/.tools/runtime-download.XXXXXX")
  trap 'rm -rf "$HARNESS_DOWNLOAD"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  echo "Первый запуск: загружаю Node.js $HARNESS_VERSION с nodejs.org…"
  fetch_file() {
    if command -v curl >/dev/null 2>&1; then curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 600 --output "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then wget --https-only --timeout=60 -O "$2" "$1"
    else echo 'Нужен curl или wget для загрузки Node.js.'; exit 1; fi
  }
  HARNESS_URL="https://nodejs.org/download/release/v$HARNESS_VERSION"
  fetch_file "$HARNESS_URL/SHASUMS256.txt" "$HARNESS_DOWNLOAD/SHASUMS256.txt"
  fetch_file "$HARNESS_URL/$HARNESS_RELEASE.tar.gz" "$HARNESS_DOWNLOAD/$HARNESS_RELEASE.tar.gz"
  HARNESS_EXPECTED=$(awk -v name="$HARNESS_RELEASE.tar.gz" '$2 == name {print $1}' "$HARNESS_DOWNLOAD/SHASUMS256.txt")
  if command -v shasum >/dev/null 2>&1; then HARNESS_ACTUAL=$(shasum -a 256 "$HARNESS_DOWNLOAD/$HARNESS_RELEASE.tar.gz" | awk '{print $1}')
  else HARNESS_ACTUAL=$(sha256sum "$HARNESS_DOWNLOAD/$HARNESS_RELEASE.tar.gz" | awk '{print $1}'); fi
  if [ -z "$HARNESS_EXPECTED" ] || [ "$HARNESS_EXPECTED" != "$HARNESS_ACTUAL" ]; then echo 'Проверка загрузки не прошла. Повторите запуск.'; exit 1; fi
  tar -xzf "$HARNESS_DOWNLOAD/$HARNESS_RELEASE.tar.gz" -C "$HARNESS_DOWNLOAD"
  "$HARNESS_DOWNLOAD/$HARNESS_RELEASE/bin/node" "$ROOT/scripts/install-runtime.mjs" "$HARNESS_DOWNLOAD/$HARNESS_RELEASE" "$HARNESS_RELEASE"
  rm -r "$HARNESS_DOWNLOAD"
  trap - EXIT HUP INT TERM
fi
exec "$HARNESS_NODE" "$ROOT/scripts/bootstrap.mjs" "$@"
