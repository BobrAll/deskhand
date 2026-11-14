#!/bin/bash
# Creates a stable self-signed code signing identity for local Deskhand builds.
#
# macOS records Accessibility and Screen Recording grants against the app's
# designated requirement. An ad-hoc signature puts the build's cdhash there, so
# every rebuild looks like a new app and the grants stop working. A certificate
# makes the requirement stable across versions.
#
# The certificate is not trusted by Apple and does not remove Gatekeeper
# warnings. It only keeps TCC grants across updates.
set -euo pipefail

CERT_NAME="${DESKHAND_SIGN_IDENTITY:-Deskhand Local Signing}"
LOGIN_KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"
KEYCHAIN="${DESKHAND_KEYCHAIN:-$LOGIN_KEYCHAIN}"
KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }

case "$CERT_NAME" in
  *[!A-Za-z0-9._\ -]*) fail "В имени сертификата допустимы только латиница, цифры, пробел, точка, дефис и подчёркивание." ;;
esac

if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -Fq "\"$CERT_NAME\""; then
  say "Сертификат «${CERT_NAME}» уже есть."
  exit 0
fi

if [ ! -f "$KEYCHAIN" ]; then
  [ -n "$KEYCHAIN_PASSWORD" ] \
    || fail "Ключница ${KEYCHAIN} не найдена. Создай её или задай KEYCHAIN_PASSWORD."
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
fi

if [ -n "$KEYCHAIN_PASSWORD" ]; then
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/deskhand-cert.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

cat > "${WORK}/cert.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = ${CERT_NAME}
[ v3 ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -keyout "${WORK}/key.pem" -out "${WORK}/cert.pem" \
  -config "${WORK}/cert.cnf" >/dev/null 2>&1 \
  || fail "Не удалось создать сертификат через openssl."

P12_PASSWORD="$(openssl rand -hex 16)"
export P12_PASSWORD
P12_ARGS=(-export)
if openssl pkcs12 -help 2>&1 | grep -q -- '-legacy'; then
  P12_ARGS+=(-legacy)
fi
openssl pkcs12 "${P12_ARGS[@]}" \
  -inkey "${WORK}/key.pem" -in "${WORK}/cert.pem" \
  -out "${WORK}/cert.p12" -passout env:P12_PASSWORD >/dev/null 2>&1 \
  || fail "Не удалось упаковать сертификат в .p12."
security import "${WORK}/cert.p12" -k "$KEYCHAIN" -P "$P12_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null \
  || fail "Не удалось импортировать сертификат в ключницу."

if [ -n "$KEYCHAIN_PASSWORD" ]; then
  security set-key-partition-list -S apple-tool:,apple: -s \
    -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null 2>&1 \
    || say "Не удалось заранее разрешить codesign доступ к ключу. При первой сборке нажми «Always Allow»."
fi

security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -Fq "\"$CERT_NAME\"" \
  || fail "Сертификат создан, но codesign его не видит."

say "Сертификат «${CERT_NAME}» готов."
if [ "$KEYCHAIN" != "$LOGIN_KEYCHAIN" ]; then
  say "Ключница: ${KEYCHAIN}. Если codesign её не найдёт, добавь её в поиск: security list-keychains -d user -s \"${KEYCHAIN}\" \"${LOGIN_KEYCHAIN}\"."
fi
if [ -z "$KEYCHAIN_PASSWORD" ]; then
  say "При первой сборке macOS спросит доступ к ключу — нажми «Always Allow»."
fi
say "Дальше запусти npm run dist: сборка подпишется этим сертификатом."
