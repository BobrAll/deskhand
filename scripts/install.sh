#!/bin/bash
# Installs the latest Deskhand release into /Applications.
#
# The release server is a GitHub release asset. Override DESKHAND_RELEASE_URL
# to install from a mirror; it must serve the same Deskhand-universal.zip and
# Deskhand-universal.zip.sha256.
set -euo pipefail

REPOSITORY="BobrAll/deskhand"
RELEASE_URL="${DESKHAND_RELEASE_URL:-https://github.com/${REPOSITORY}/releases/latest/download}"
RELEASE_URL="${RELEASE_URL%/}"
ZIP_NAME="Deskhand-universal.zip"
APP_NAME="Deskhand.app"
INSTALL_DIR="${DESKHAND_INSTALL_DIR:-/Applications}"
DESTINATION="${INSTALL_DIR}/${APP_NAME}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "Deskhand работает только на macOS."

MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
[ -n "$MACOS_MAJOR" ] && [ "$MACOS_MAJOR" -ge 14 ] 2>/dev/null \
  || fail "Нужна macOS 14 или новее. У тебя macOS ${MACOS_VERSION}."

case "$INSTALL_DIR" in
  /*) ;;
  *) fail "Папка установки должна быть абсолютным путём." ;;
esac
[ "$INSTALL_DIR" != "/" ] || fail "Нельзя ставить Deskhand в корень диска."

WORK="$(mktemp -d "${TMPDIR:-/tmp}/deskhand-install.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

say "Скачиваю Deskhand…"
curl -fL --retry 3 --connect-timeout 15 --progress-bar \
  "${RELEASE_URL}/${ZIP_NAME}" -o "${WORK}/${ZIP_NAME}" \
  || fail "Не удалось скачать Deskhand. Проверь интернет и попробуй ещё раз."

say "Проверяю контрольную сумму…"
curl -fsSL --retry 3 --connect-timeout 15 \
  "${RELEASE_URL}/${ZIP_NAME}.sha256" -o "${WORK}/${ZIP_NAME}.sha256" \
  || fail "Не удалось скачать контрольную сумму. Попробуй ещё раз."
(
  cd "$WORK"
  shasum -a 256 -c "${ZIP_NAME}.sha256" >/dev/null 2>&1
) || fail "Контрольная сумма не совпала. Скачай Deskhand заново."

say "Распаковываю…"
ditto -x -k "${WORK}/${ZIP_NAME}" "${WORK}/unpacked" \
  || fail "Не удалось распаковать архив."
SOURCE_APP="${WORK}/unpacked/${APP_NAME}"
[ -d "$SOURCE_APP" ] || fail "В архиве нет ${APP_NAME}."

if pgrep -x Deskhand >/dev/null 2>&1; then
  say "Закрываю запущенный Deskhand…"
  osascript -e 'tell application "Deskhand" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    pgrep -x Deskhand >/dev/null 2>&1 || break
    sleep 1
  done
  pgrep -x Deskhand >/dev/null 2>&1 \
    && fail "Deskhand всё ещё работает. Закрой его и запусти установщик снова."
fi

say "Устанавливаю в ${INSTALL_DIR}…"
mkdir -p "$INSTALL_DIR"
if [ -w "$INSTALL_DIR" ]; then
  rm -rf "$DESTINATION"
  ditto "$SOURCE_APP" "$DESTINATION"
else
  sudo rm -rf "$DESTINATION"
  sudo ditto "$SOURCE_APP" "$DESTINATION"
  sudo chown -R "$(id -u):$(id -g)" "$DESTINATION"
fi

xattr -dr com.apple.quarantine "$DESTINATION" 2>/dev/null || true

if [ "${DESKHAND_SKIP_LAUNCH:-0}" != "1" ]; then
  open "$DESTINATION" \
    || fail "Deskhand установлен, но не открылся. Запусти его из «Программ»."
  say "Готово. Deskhand открыт."
else
  say "Готово."
fi

say "Дальше дай Deskhand «Универсальный доступ» в «Системных настройках» → «Конфиденциальность и безопасность» и перезапусти приложение."
