# Выпуск релиза

## Один раз

Создай локальный сертификат для стабильной подписи:

```sh
npm run sign:cert
```

Сертификат хранится в связке ключей. Он не нужен пользователям и не заменяет Developer ID: Gatekeeper по-прежнему будет предупреждать, зато разрешения Accessibility и Screen Recording переживут обновления. Не коммить `.p12` и не удаляй сертификат: если он потеряется, всем пользователям придётся один раз выдать разрешения заново.

При первой сборке macOS может спросить доступ к ключу. Нажми «Always Allow».

## Сборка

```sh
npm ci
npm run build:native
npm run dist
```

`build:native` собирает `deskhand-helper`, `whisper-cli` и `deskhand-agent`. `npm run dist` сам соберёт `transcribe-cli` и скачает модель, если их ещё нет.

В `release/` появятся:

- `Deskhand-universal.zip` — для установщика;
- `Deskhand-universal.dmg` — для ручной установки;
- `Deskhand-universal.zip.sha256` и `Deskhand-universal.dmg.sha256`;
- `install.sh` — тот же установщик, что лежит в репозитории.

Проверь, что подпись стабильная:

```sh
codesign -d -r- release/mac-universal/Deskhand.app
```

В выводе должно быть `certificate leaf = H"…"`, а не `cdhash`. Если видишь `cdhash`, сертификат не найден и сборка подписана ad-hoc: разрешения будут слетать после обновлений. `npm run dist` в этом случае завершится ошибкой; для локальной проверки можно задать `DESKHAND_ALLOW_ADHOC=1`.

## Публикация

```sh
gh release create v0.1.0 \
  release/Deskhand-universal.zip \
  release/Deskhand-universal.zip.sha256 \
  release/Deskhand-universal.dmg \
  release/Deskhand-universal.dmg.sha256 \
  release/install.sh
```

Имена `Deskhand-universal.zip`, `Deskhand-universal.zip.sha256` и `install.sh` должны оставаться одинаковыми: установщик и README берут их по адресу `/releases/latest/download/…`.

## Проверка перед анонсом

1. Скачай `install.sh` по ссылке из README и запусти на чистом Mac или в виртуальной машине.
2. Убедись, что `Deskhand.app` лежит в «Программах» и запускается без диалога Gatekeeper.
3. Проверь, что `xattr /Applications/Deskhand.app` не содержит `com.apple.quarantine`.
4. Выдай «Универсальный доступ», перезапусти и проверь, что выделение текста работает.
5. Собери следующую версию, установи поверх и убедись, что разрешение не слетело.
