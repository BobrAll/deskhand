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
STAGING="${INSTALL_DIR}/.${APP_NAME}.new"
BACKUP="${INSTALL_DIR}/.${APP_NAME}.old"
SIGNING_LEAF="${DESKHAND_SIGNING_LEAF:-__DESKHAND_SIGNING_LEAF__}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "Deskhand работает только на macOS."

MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
[ -n "$MACOS_MAJOR" ] && [ "$MACOS_MAJOR" -ge 14 ] 2>/dev/null \
  || fail "Нужна macOS 14 или новее. У тебя macOS ${MACOS_VERSION}."

case "$RELEASE_URL" in
  https://*) ;;
  http://*) [ "${DESKHAND_ALLOW_HTTP:-0}" = "1" ] || fail "Зеркало должно работать по HTTPS." ;;
  *) fail "Некорректный адрес релиза." ;;
esac

case "$INSTALL_DIR" in
  /*) ;;
  *) fail "Папка установки должна быть абсолютным путём." ;;
esac
[ "$INSTALL_DIR" != "/" ] || fail "Нельзя ставить Deskhand в корень диска."

WORK="$(mktemp -d "${TMPDIR:-/tmp}/deskhand-install.XXXXXX")"

SUDO=()
if [ ! -d "$INSTALL_DIR" ] || [ ! -w "$INSTALL_DIR" ]; then
  SUDO=(sudo)
fi

privileged() {
  if [ "${#SUDO[@]}" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

BACKUP_MOVED=0
cleanup() {
  if [ "$BACKUP_MOVED" = 1 ] && [ ! -e "$DESTINATION" ] && [ -e "$BACKUP" ]; then
    privileged mv "$BACKUP" "$DESTINATION" 2>/dev/null || true
  fi
  if [ -e "$STAGING" ]; then
    privileged rm -rf "$STAGING" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

if [ "${DESKHAND_ALLOW_UNSIGNED:-0}" != "1" ]; then
  say "Проверяю подпись…"
  codesign --verify --deep --strict "$SOURCE_APP" >/dev/null 2>&1 \
    || fail "Подпись Deskhand не прошла проверку. Скачай релиз заново."

  REQUIREMENT="$(codesign -d -r- "$SOURCE_APP" 2>&1 || true)"
  LEAF="$(printf '%s\n' "$REQUIREMENT" \
    | sed -n 's/.*certificate leaf = H"\([0-9a-fA-F]*\)".*/\1/p' \
    | head -n 1 \
    | tr 'A-F' 'a-f')"
  [ -n "$LEAF" ] || fail "Deskhand не подписан. Скачай релиз заново."

  case "$SIGNING_LEAF" in
    ""|__DESKHAND_SIGNING_LEAF__) ;;
    *) [ "$LEAF" = "$SIGNING_LEAF" ] || fail "Сертификат Deskhand не совпадает с ожидаемым. Скачай релиз заново." ;;
  esac
fi

if pgrep -x Deskhand >/dev/null 2>&1; then
  say "Закрываю запущенный Deskhand…"
  pkill -TERM -x Deskhand 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    pgrep -x Deskhand >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -x Deskhand >/dev/null 2>&1; then
    pkill -KILL -x Deskhand 2>/dev/null || true
    sleep 1
  fi
  pgrep -x Deskhand >/dev/null 2>&1 \
    && fail "Deskhand всё ещё работает. Закрой его и запусти установщик снова."
fi

say "Устанавливаю в ${INSTALL_DIR}…"
privileged mkdir -p "$INSTALL_DIR" || fail "Не удалось создать ${INSTALL_DIR}."

if [ ! -e "$DESTINATION" ] && [ -e "$BACKUP" ]; then
  privileged mv "$BACKUP" "$DESTINATION" || fail "Не удалось восстановить предыдущую версию."
fi
privileged rm -rf "$STAGING" "$BACKUP" || fail "Не удалось подготовить папку установки."

privileged ditto "$SOURCE_APP" "$STAGING" || fail "Не удалось скопировать Deskhand."
if [ "${#SUDO[@]}" -gt 0 ]; then
  privileged chown -R "$(id -u):$(id -g)" "$STAGING"
fi
if ! xattr -dr com.apple.quarantine "$STAGING" 2>/dev/null; then
  say "Не удалось снять карантин. macOS может спросить подтверждение при первом запуске."
fi

if [ -e "$DESTINATION" ]; then
  privileged mv "$DESTINATION" "$BACKUP" || fail "Не удалось заменить старую версию."
  BACKUP_MOVED=1
fi
if ! privileged mv "$STAGING" "$DESTINATION"; then
  if [ "$BACKUP_MOVED" = 1 ]; then
    privileged mv "$BACKUP" "$DESTINATION" 2>/dev/null || true
    BACKUP_MOVED=0
  fi
  fail "Не удалось установить Deskhand. Старая версия осталась на месте."
fi
BACKUP_MOVED=0
privileged rm -rf "$BACKUP"

if [ "${DESKHAND_SKIP_LAUNCH:-0}" != "1" ]; then
  open "$DESTINATION" \
    || fail "Deskhand установлен, но не открылся. Запусти его из «Программ»."
  say "Готово. Deskhand открыт."
else
  say "Готово."
fi

say "Дальше дай Deskhand «Универсальный доступ» в «Системных настройках» → «Конфиденциальность и безопасность» и перезапусти приложение."
