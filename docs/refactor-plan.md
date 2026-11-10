# План рефакторинга: чистый код, первый проход

Ветка: `refactor/clean-code-pass`. Скилл: `.agents/skills/refactoring/SKILL.md`,
правила — `.agents/skills/ub-mode-lite/SKILL.md`.

Прогресс отмечается чекбоксами прямо в этом файле. Отметка `[x]` означает, что
изменение сделано, проверено и попало в коммит ветки. `[~]` — в работе.
Невыполненное остаётся `[ ]`; отложенные по риску собраны в отдельном списке в
конце каждого пакета, чтобы их не потеряли.

## 1. Цель и границы

Кодовая база писалась до появления скилла чистого кода. Первый проход —
**косметический**: имена, комментарии, именованные константы, удаление мёртвого
кода, разбиение слишком длинных функций на части без изменения порядка
эффектов. Никаких новых абстракций, слоёв и зависимостей.

**Правило прохода: меняется структура, не поведение.**

### Что считается косметикой

- переименование локальных переменных, приватных функций, параметров, файлов
- переименование внутренних (не публичных) типов и полей
- перенос/переписывание/удаление комментариев
- вынос магических чисел и строк в именованные константы
- извлечение функции из тела другой функции (чистый move, без переупорядочивания)
- удаление мёртвого кода и неиспользуемых экспортов
- приведение терминологии к одному слову в пределах модуля

### Два правила границ

1. **Переименование не пересекает границу пакета.** Если экспортируемый символ
   используется за пределами файлов своего пакета — имя не меняется. Пример:
   `hideAgentPresentation` из `src/main/agent/presentation.ts` импортируется в
   `src/main/index.ts` и `src/main/overlay/index.ts`, поэтому остаётся как есть,
   хотя внутри пакета имя неудачное. Сначала правится внутренность, потом —
   отдельным шагом — граница.
2. **Поля в `@shared/types.ts`, `@shared/api.ts`, `@shared/ipc.ts` — это
   контракт IPC.** Они не переименовываются вообще: имя поля пересекает границу
   процесса и совпадает с ключом в сообщении. В этих файлах допустимы только
   комментарии, удаление мёртвого кода и переименование *локальных* сущностей.

### Что категорически вне этого прохода

Проверять перед каждым изменением — это контракты, а не косметика:

1. **Протокол sidecar.** Ключи JSON в stdin/stdout (`method`, `params`,
   `max_steps`, `verify_actions`, `timings`, `kind`, …) — это контракт между
   Swift и TypeScript. Меняются только имена в памяти, никогда на проводе.
   Защищено `src/main/agent/sidecar.test.ts` (реальный транскрипт).
2. **IPC-каналы** (`settings.save`, `pointer.draw`, `agent.*`, …) — строки
   в `src/shared/ipc.ts` не переименовываются.
3. **Ключи настроек и хранилища** (`electron-store`, `agent-runs`, `secrets`) —
   ключи на диске не переименовываются.
4. **Текст промптов** (`src/main/prompt.ts`, `AgentLoop.systemPrompt`,
   `ToolSurface.definitions()`) — формулировки влияют на модель. Комментарии
   рядом можно править, строки — нет. Схемы инструментов побайтово
   зафиксированы в `ToolSurfaceTests.swift`.
5. **Пользовательские строки** (русский UI, голосовые фразы, тексты ошибок,
   которые видит пользователь) — не трогаются.
6. **Текст, который читает модель** (`AgentLoop` batch-stop messages, диффы,
   подписи шагов) — это тоже поведение.
7. **Публичные API модулей**, которые пересекают границу процесса или
   пакета: экспорты `@shared/*`, `src/preload/index.d.ts`, `Package.swift`
   продукты. Внутри модуля — можно, через границу — нет.

Если находка требует изменения поведения, она помечается **RISKY** и
откладывается: не делается в этом проходе.

## 2. Базовая линия (до изменений)

Снято на `main` перед созданием ветки:

| Проверка | Результат |
| --- | --- |
| `npm run typecheck` | чисто |
| `npm run lint` | чисто |
| `swift test` (`native/deskhand`) | 19 + остальные наборы, 0 падений |
| `npm test` | **16 падений в 2 файлах** — см. ниже |

Предсуществующие падения, не связанные с рефакторингом:

- `src/main/agent/timing.integration.test.ts` — 10 тестов.
- `src/main/agent/trace.integration.test.ts` — 6 тестов, та же причина.

**Уточнённая причина (проверено вручную на `deskhand-agent --serve`).** Это не
баг в коде стороны TypeScript. Цепочка такая: integration-тесты запускают
настоящий бинарник, бинарник **до** принятия `run` проверяет «Универсальный
доступ», у процесса vitest этого разрешения нет — и он отдаёт `error` вместо
потока событий, после чего тест ждёт `done`, которого не будет:

```
{"event":"ready","params":{"tools":11,"version":"1"}}
{"event":"error","params":{"code":"accessibility","message":"Нет разрешения «Универсальный доступ»."}}
{"error":{"message":"accessibility permission is required"},"id":1}
```

Следствия:

1. Падения **средовые, а не регрессия**: на машине, где у тест-раннера есть
   Accessibility, они зелёные. То же разрешение валит единственный красный
   Swift-тест (`AXIsProcessTrusted() == false`), то есть это один факт
   окружения, а не два бага.
2. Пока разрешения нет, integration-тесты — «единственная защита от
   переименованного поля» по `docs/agent-reliability.md` — **не защищают
   ничего**. Форму протокола по записанному транскрипту проверяет
   `sidecar.test.ts`, но сквозная проверка переименованного поля выключена.
   Для прохода, который переименовывает поля по обе стороны границы, это
   важно; чинить — отдельная задача (дать разрешение тест-раннеру или
   перестроить тест так, чтобы он не зависел от системного разрешения).

**Правило прохода:** падения не растут. Если после пакета число падений
больше 16 или список файлов шире этих двух — изменение откатывается.
Починить их — отдельная задача, не часть косметического прохода.

## 3. Прогресс

| Пакет | Область | Статус | Проверки |
| --- | --- | --- | --- |
| Пакет | Область | Статус | Проверки |
| --- | --- | --- | --- |
| WP1 | Swift `DeskhandCore` | готово (`1521099`) | 92 Core теста, 1 предсуществующее падение |
| WP2 | Swift `AgentKit`/`LLM`/`Agent` | готово (`3b36494`) | 45 тестов Agent+LLM, 0 падений |
| WP3 | `main/agent` + слои рисования | готово (`5a6401f`) | 279 тестов, 16 предсуществующих падений |
| WP4 | `main/overlay` + `main/context` | готово (`bce8970`) | 208 тестов overlay+context+shared+preload |
| WP5 | остальной `main` | готово (`de12f1d`) | 558 тестов пакета |
| WP6 | `shared` + `preload` | готово (`edeeaf0`) | 122 теста, снапшоты не менялись |
| WP7 | `renderer` | готово (`0159fb4`) | 195 тестов, снапшоты не менялись |
| WP8 | документация | готово (`ef1cd8d`) | ссылки сверены с кодом |
| WP9 | переименования через границы | готово (`f6a9066`) | 1241 тест, снапшоты не менялись |
| WP10 | Swift, вторая волна | готово (`2fe48bb`) | 92+45 тестов, +10 новых |

Итоговые проверки:

- [x] `npm run typecheck` — чисто
- [x] `npm run lint` — чисто
- [x] `npm test` — 1241 проходит, 16 падений только в двух integration-файлах
- [x] `swift test` в `native/deskhand` — 137 тестов, 1 предсуществующее падение
- [x] `npm run build:agent` — сайдкар собирается
- [x] `npm run build` — приложение собирается

## 4. Пакеты работ

Пакеты нарезаны по владению файлами, чтобы субагенты не конфликтовали в
одном дереве. Порядок — от внутреннего к внешнему: сначала Swift (его
наблюдает TypeScript через протокол), потом main, потом shared/preload,
потом renderer.

### WP1 — Swift: `DeskhandCore`

Файлы: `native/deskhand/Sources/DeskhandCore/*.swift`,
`native/deskhand/Tests/DeskhandCoreTests/*.swift`.

**Переименования**

- [x] `WindowCapture.swift:17` — `pngData` хранит JPEG (кодировщик JPEG-first)
      → `imageData`; `:25` doc «spent encoding the PNG» → «encoding the image»;
      `:41` текст ошибки про PNG.
- [x] `ToolExecutor.swift:9` — `case imagePNG(Data)` → `case image(Data)`.
      JSON-ключи `type`/`data`/`mimeType` не тронуты (проверено в `mcpJSON`).
- [x] Один атрибут AX под тремя именами: `AXElement.descriptionText`,
      `AXWalkedValues.label`, `AXNode.label` → `label` везде.
- [x] Одно число под двумя именами: `ChildrenResult.declaredCount` →
      `declaredItemCount` (и `AXNode.hiddenItemCount`).
- [x] Один отказ под тремя именами → `childrenRefused`. Отклонение от плана:
      план предлагал `refusedChildren`, но это читается как коллекция, поэтому
      выбран Bool-вариант.
- [x] `AXTreeWalker.swift:187` vs `:224` → `isLayoutScaffolding(role:)` /
      `isContainerHidingChildren(role:frame:)`.
- [x] `AppSession.swift:50` `mapper` → `coordinateMapper`; `:49` `capture` →
      `lastCapture`; `currentSnapshot` удалён, используется `snapshot`
      (11 мест вызова).
- [x] `ToolExecutor.swift:432` — `describe(name:arguments:narration:)` →
      `policyContext(...)`, больше не перегружает `describe(_ node:)`.
- [x] `ToolExecutor.swift:212` — `finish(... action:)` → `actionLabel:`
      (11 мест вызова); `bringToFrontChecked(action:)` → `actionLabel:`.
- [x] `Keyboard.swift:77-88` — `Destination.focusedApp` → `.frontmostApp`.
- [x] `WindowCapture.swift:165` `fit(size:longestEdge:)` →
      `downscaledSize(of:longestEdge:)`; `:157` `distance(_:_:)` →
      `distance(from:to:)`.
- [x] `SystemPermissions.swift:47` `openPrivacySettings()` →
      `openAccessibilityPrivacySettings()`.

**Комментарии**

- [x] `ToolExecutor.swift:418-431` — два почти одинаковых doc-блока слиты;
      `:595-599` — двухголовый doc на `bringToFront` слит; `:559-562` —
      комментарий про «снимок всегда в полном качестве» переписан:
      `includeScreenshot` передаётся дальше как есть.
- [x] `AppCatalog.swift:231-266` — слитый doc-блок разделён: ожидание
      активации описывает `activate(pid:timeout:)`, подъём окна —
      `activate(pid:raising:)`, в том порядке, в котором код работает.
- [x] «PNG» в документации полей: `Timings.swift` (`encode` — сжатие
      изображения, `screenshotBytes` — размер закодированного изображения).
      В `AgentObserver.swift:37` и `AgentLoop.swift:47,488` — зона WP2.

**Константы**

- [x] `Mouse.swift` — девять пауз → `Mouse.Pace` (значения не менялись).
- [x] `WindowCapture.swift:89,96` — `minimumWindowSide = 40`,
      `frameMatchTolerance = 8`.
- [x] `AppSession.swift:11-27` — `DiffSettle.*` → с `Milliseconds`.
- [x] `Timings.swift:129-151` — протокол меток назван один раз: `TimingLabel`
      (`model`, `runTotal`, `toolPrefix`, `phasePrefix`), используется
      `bottleneck()`. Производители в `AgentLoop` перейдут на него в WP2.

**Мёртвый код**

- [x] `AppSession.swift:51,259` — `lastActionAt` + `noteAction()` и 10 мест
      вызова удалены (проверено grep: чтений ноль).
- [x] `ToolSurface.swift:8` — `version` без читателя.
- [x] `AppCatalog.swift:179` — `launch(_:)` без вызовов.
- [x] `Timings.swift:39-49` `measure` / `measureAsync` без вызовов.
- [x] `AXElement.swift:18,197,210,141` — `systemWide()`, `mainWindow()`,
      `pid()`, `attributeNames()` без вызовов.
- [x] `JSONValue.swift:106` `isNumber` без вызовов.
- [x] `SyntheticEvent.isSynthetic` без вызовов — удалён вместе с doc-строкой.
- [x] `ToolExecutor.ensureKeyboardTarget` — no-op `if let focused … _ = focused`.

**Извлечения**

- [x] `ToolSurface.swift:10-389` — схема собирается из
      `schema(properties:required:)` и `appProperty`/`elementIndexProperty`/
      `string|number|integer|bool|enumProperty`. **Вывод побайтово тот же**:
      SHA-256 `4f58efcf…` до и после, набор различных строковых литералов
      идентичен, повторы свернулись ровно в счётчики хелперов.
- [x] `Mouse.swift:49-56` дублировал `Keyboard.swift:130-137` →
      `SyntheticEvent.eventSource()`, используется обоими.

**Тесты**

- [x] `InputTests.swift` (599 строк, 7 наборов) разнесён на `KeyboardTests`,
      `CoordinateMapperTests`, `WindowCaptureTests` (геометрия + выбор окна),
      `AXTreeRendererTests`, `ToolSurfaceTests`, `AXSnapshotDiffTests`.
      Было 54 метода, стало 54; значения и сообщения те же, менялся только
      синтаксис вызова и три имени тестов под `declaredItemCount`.

**Отложено (RISKY)**

- [ ] `Keyboard.swift:43-56` vs `ToolExecutor.swift:936-949` — две таблицы
      модификаторов с разными синонимами. Объединение меняет набор
      принимаемых строк.
- [ ] `ToolExecutorTests.swift:147` `testDisambiguatesBySuffix` не передаёт
      `suffix` и дублирует `testDisambiguatesByPrefix`. Исправление меняет
      покрытие.
- [ ] `ActionPresentation.swift:44` — `target`/`window` → `elementFrame` /
      `windowFrame`. Оба читаются в `Sources/DeskhandAgent/Bridge.swift`, то
      есть за границей пакета, и ключи `target`/`window` уходят на провод.
      Нужна координация с WP2.
- [ ] `SystemPermissions` — `import AppKit` после типа и `NSWorkspaceShim`,
      который существует только ради него. Не входило в план, следующий проход.

### WP2 — Swift: `DeskhandAgentKit`, `DeskhandLLM`, `DeskhandAgent`

Файлы: `Sources/DeskhandAgentKit/*.swift`, `Sources/DeskhandLLM/*.swift`,
`Sources/DeskhandAgent/*.swift`, `Tests/DeskhandAgentTests/*.swift`,
`Tests/DeskhandLLMTests/*.swift`.

**Переименования**

- [ ] `AgentLoop.swift:75` — `timings` (сборщик) конфликтует с `options.timings`
      (флаг) → `timingLog`.
- [ ] `AgentLoop.swift:469` — `reportRun(steps:calls:failed:)` → `failedCalls`
      (совпадает с `RunReport.failedCalls`).
- [ ] `AgentLoop.swift:553` `trim` → `trimmedHistory`; `:654,659`
      `preview`/`previewText` → `argumentPreview`/`textPreview`;
      `:615` `appKey(ofTreeMessage:)` → `appKey(forTreeMessage:)`.
- [ ] `AgentObserver.swift:38` — `isError: Bool` → параметр `didFail:`
      (тип не менять).
- [ ] `ChatProvider.swift:19` `toolIsError` / `ToolResult.isError` /
      `toolFinished(isError:)` — одно слово `isError`.
- [ ] `ChatProvider.swift:78` `Usage` → `TokenUsage`.
- [ ] `ProviderConfig.swift:56` `endpointURL()` — чистое чтение → свойство;
      `:36-37` дефолты в `defaultBaseURL`/`defaultModel`.
- [ ] `AnthropicProvider.swift:30` `encodeBlocks` vs `openai.ts:34`
      `encodeParts` — выбрать одно имя (в Swift — `encodeBlocks`).
- [ ] `Bridge.swift:88` `handle(line:)` → `handleRequest(_:)`; `:53`
      `ApprovalWait.value()` → свойство.

**Комментарии**

- [ ] `main.swift:7-16` — doc-комментарий разрезан оператором
      `_ = NSApplication.shared`.
- [ ] `main.swift:88-93` — секция `USAGE` напечатана дважды.

**Константы**

- [ ] `AnthropicProvider.swift:146` / `OpenAICompatibleProvider.swift:155` —
      `"Deskhand/0.1"` литерал дважды; `:90`/`:93` `[400, 404, 422]` дважды →
      общие константы DeskhandLLM.
- [ ] `Bridge.swift:291,299` — таймауты `600` и `0.1` → имена.
- [ ] `Bridge.swift:478` `2000` → `maximumResultTextLength`.

**Мёртвый код**

- [ ] `ProviderConfig.swift:70` `redactedDescription` без вызовов.
- [ ] `ProviderConfig.swift:139,190` — список truthy дублирован → один хелпер.
- [ ] `Bridge.swift:37-39` `RunHandle` оборачивает один `CancelToken` и ничего
      не добавляет.

**Извлечения**

- [ ] `AgentLoop.swift:444-447` — тройка «записать total → loopStopped →
      reportRun» повторена 4 раза → приватный `finishRun(reason:answer:)`.
      Порядок эффектов сохранить.
- [ ] `AnthropicProvider.swift:157-161` и
      `OpenAICompatibleProvider.swift:166-170` — `ToolCallBuilder` скопирован
      дословно → один внутренний тип.

**Отложено (RISKY)**

- [ ] `AgentLoop.swift:377-379` — в сообщении остановки пакета длинные серии
      пробелов из-за переноса строк без `\`. Это текст, который читает модель.
- [ ] `Bridge.swift:155,255,297` — русский и английский в одной ветке
      сообщений. Пользовательский текст.

### WP3 — TypeScript: агент, слои рисования

Файлы: `src/main/agent/**`, `src/main/pointer.ts`,
`src/main/annotations.ts`, `src/main/annotationGrounding.ts`,
`src/main/layerWindow.ts`.

**Переименования**

- [x] `agent/index.ts:87` `EMPTY` → `IDLE_EVENT`; `:226` `last` → `lastPublished`
      (и `last: () => last` → `lastEvent`); `:318` `rows()` → `actionRows()`;
      `:481` `handle(event)` → `handleSidecarEvent`.
- [x] `agent/index.ts:329` `finish()` конфликтует с полем `current.finish` →
      `settleRun()`.
- [x] `agent/approval.ts:37-38` — `CRITICAL` → `COMMITTING_ACTION`, собранный из
      `PAYMENT_WORDS`/`SENDING_WORDS`/`DELETION_WORDS`/`ACCESS_WORDS`/
      `PASSWORD_WORDS`/`AGREEMENT_WORDS`/`ENGLISH_WORDS`. Склеенный источник
      regex **побайтово равен** прежнему литералу; поведение сверено на корпусе
      из 53 строк.
- [x] `agent/approval.ts:68` `describe(request)` → `matchableText`.
- [x] `agent/approval.ts:144` `remembered` → `rememberedKeys` (поле в
      `AgentSettings` не переименовывалось).
- [x] `agent/cursor.ts:60-61` — `held`/`turn` → `glowOwner`/`turnCount`.
- [x] `agent/cursor.ts:276` — `hide(force)` → `hide(immediate)` + `hideNow()`.
- [x] `agent/presentation.ts:112,117,127` — `local`, `localRect`, `centre` →
      `toLayerPoint`, `toLayerRect`, `rectCenter`.
- [x] `agent/outline.ts:93-97` — `formatOutline(probe, windowBounds, captureArea)`,
      то же для `describeScreen`.
- [x] `agent/trace.ts:29` `open` → `openTurns`; `:31` `writes` → `writeQueue`;
      `:92` `timed` → `traceTimed`.
- [x] `annotationGrounding.ts:8` — тело очищено (type predicate вместо `frame!`);
      переименование `groundAnnotation` **не сделано**: вызовы в
      `src/main/overlay/index.ts:46,828`, за границей пакета.
- [ ] `pointer.ts` — привести к «drawing» имена файла и типов. **Не сделано**:
      модуль импортируют `src/main/index.ts`, `overlay/index.ts`, и на нём
      замокан `overlay/controller.test.ts`; `PointerShape`/`PointerPayload` —
      контракт `@shared/types`.

**Комментарии**

- [x] `annotations.ts:28-29` — комментарий, описывавший **противоположное**
      правило, переписан: ниже `MIN_SIDE` в *обеих* осях — это точка; круг
      выживает (размер добавляется позже), стрелка/подчёркивание/бокс
      отбрасываются.
- [x] `layerWindow.ts:17` — «these two» → «all three»; добавлен комментарий к
      placeholder-рамке 400×300 и doc к `LayerWindowOptions.page`.

**Константы**

- [x] `agent/index.ts:151-176` — подстроки остановок →
      `STOP_BUDGET`/`STOP_TOKEN_LIMIT`/`STOP_REPEATED`/`STOP_RETURNING_TO_SCREEN`.
      Строки не менялись: они приходят от Swift.
- [x] `agent/index.ts:629` — `active.stopped ?? 'incomplete'` → `UNKNOWN_STOP`.
- [x] `agent/approval.ts:165-168` — `COMMAND_MODIFIER`, `FINDER_DELETE_KEY`,
      `FINDER_BUNDLE_ID`.
- [x] `agent/cursor.ts:13` → `CURSOR_FADE_MS` (160); `agent/presentation.ts:33`
      → `POINTER_FADE_MS` (240); `pointer.ts` → `DRAWING_FADE_MS` (240).
      Значения не унифицированы.
- [x] `agent/sidecar.ts:272,313,387,293` — `START_TIMEOUT_MS`,
      `REQUEST_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS`, `MAX_LOG_LINE_CHARS`.
- [x] `agent/trace.ts:117` `schema: 2` → `TRACE_SCHEMA`.
- [x] `annotations.ts:98,101-102,133` — `PERCENT_COORDINATE`, `DEFAULT_SIDE`,
      `MAX_BOX_SHARE`.
- [x] `annotationGrounding.ts:23-24` — `MAX_TARGET_SHARE`.
- [x] `pointer.ts:73,191-193` — `MIN_RING_RADIUS`, `RING_PADDING`, литералы
      `1500`/`240` → константы.
- [x] `layerWindow.ts` — `LOAD_TIMEOUT_MS`.
- [x] `outline.ts` — `OVERCOLLECT_FACTOR`, `SAME_ROW_POINTS`, `MIN_FRAME_SIDE`.
- [x] `cursor.ts` — `WAIT_LABEL_MS`.

**Мёртвый код**

- [x] `annotations.ts:130-131` — две ветки с одинаковым телом → одна
      (`kind !== 'box'`).
- [x] `pointer.ts:40-47` vs `:200-208` — сброс состояния → `resetPointerState()`.
- [x] `pointer.ts:196` — `isPointerVisible()` удалён (только собственный тест);
      четыре места в тесте теперь проверяют состояние окна.
- [x] `cursor.ts hide()` — недостижимая внутренняя проверка `isDestroyed()`
      удалена (внешняя в том же тике).

**Извлечения**

- [x] `agent/index.ts:377-478` `runTurn` → `subscribeToRun` + `releaseRun`
      (порядок: watcher, onEvent, run, `await done`, unsubscribe, release).
- [x] `agent/cursor.ts:335-398` — `paintSuccess` / `paintQuestion` / `paintStep`.
- [x] `agent/sidecar.ts:484-629` — `translate` по семействам событий плюс
      `numberParam`/`textParam`/`screenRectParam` и типизированный `EventOf<K>`.
      Ключи на проводе не тронуты, `sidecar.test.ts` проходит без правок.
- [x] `annotations.ts:26` vs `:65` — `MARKERS`/`MARKER`, alternation выведен из
      `KINDS`.
- [x] `annotationGrounding.ts:21` — `matches[0].frame!` → type predicate.
- [x] `agent/cursor.ts:93`, `agent/presentation.ts:74`, `pointer.ts:58` —
      `ensureLayerWindow`, `sameScreenRect`, `placeLayer` в `layerWindow.ts`.
      Семантика каждого вызова сохранена: `pointer.ts` округляет **и** при
      сравнении, **и** при применении (`round: true`); `cursor.ts`/
      `presentation.ts` сравнивают и применяют без округления, а
      `presentation.ts` по-прежнему сообщает `moved`. `pointer.ts` не следит за
      `destroyed` — и раньше не следил. Новые тесты в `layerWindow.test.ts`
      фиксируют все три поведения, включая разницу в округлении.
- [x] Тесты: мок `BrowserWindow` вынесен в `src/main/test/layerWindowMock.ts`
      (`layerWindowClass`, `lastLayerWindow`, `FakeLayerWindow`), используется
      `cursor.test.ts` и `presentation.test.ts`; ~110 строк дубля удалены.

**Тесты**

- [x] `agent/index.ts:868` — `HISTORY_TURN_CHARS` поднята выше первого
      использования.

**Отложено (RISKY)**

- [ ] `agent/presentation.ts:176,320-325` — публичный API смешивает префиксы;
      затрагивает `src/main/index.ts`, `overlay/index.ts`.
- [ ] `agent/outline.ts:102-123` vs `:156-161` — `isListable` извлечён, но
      различие сохранено: `formatOutline` дополнительно применяет правило ролей
      для `editable`, а фильтр `onTargets` — нет. Историю проверить не удалось:
      фильтр ролей в `formatOutline` с первого коммита, а `onTargets` добавлен
      позже в `f62e584` без него. Комментарий на `isListable` описывает
      разницу и почему чекбокс всё равно должен быть привязываемым.
- [ ] `annotations.ts:33-38,93,110,112` — `ParsedLine.text` всегда `''`, поле
      мёртвое, но читается в `response.ts:85` и тесте (чужая зона).

### WP4 — TypeScript: оверлей и контекст

Файлы: `src/main/overlay/**`, `src/main/context/**`.

**Комментарии**

- [x] `overlay/index.ts:1-9` — doc-модуля разрезан импортом; `node:crypto`
      импортирован дважды.
- [x] `overlay/index.ts:291-307` — 16-строчный JSDoc про `captureFor` приклеен к
      переменной `captureInFlight` → перенести на `captureFor`.
- [x] `overlay/host.ts:5-8` — doc ссылается на `windows.ts`, которого нет.
- [x] `context/collect.ts:6` — ссылка на `overlay.ts`, файл теперь
      `overlay/index.ts`.
- [x] `overlay/request.ts:241` — `WEB_LOOKUP_INSTRUCTION` объявлена после
      функции, которая её использует.
- [x] `overlay/request.ts:4` — устаревшая ссылка на путь и число строк.

**Переименования**

- [x] `overlay/index.ts:228,250,256` — `state()`, `emit()`, `refresh()` →
      `overlayState()`, `sendToWindow()`, `publishState()`. Публичные ключи
      контроллера сохранены (`state: overlayState` и т. д.), `index.ts`/`ipc.ts`
      не тронуты.
- [x] `overlay/index.ts:755` — `clearPointer()` чистит аннотации →
      `clearAnnotations`.
- [x] `overlay/index.ts:339-350` — `b`/`o` → `backgroundBounds`/`observedBounds`.
- [x] `overlay/index.ts:1235` — параметр `session` затеняет внешнюю `session`;
      `:1289` — флаг `send` затеняет метод `send()`.
- [x] `overlay/index.ts:1083-1099` — свойство `describeScreen` затеняет импорт →
      импорт алиасирован в `readScreenOutline`; поле
      `BuildTurnRequestInput.describeScreen` не тронуто.
- [x] `overlay/history.ts:3,32,41` — `SavedCommand`, `write()`, `read()` → по
      смыслу одной записи.
- [x] `overlay/emptyAnswer.ts:2` — параметр `annotations: number` — это счётчик
      → `annotationCount`.
- [x] `context/collect.ts:20` — `captureScreenshot: boolean` называется так же,
      как функция `captureScreenshot()` → `wantsScreenshot`; `:17`
      `onInputReady` vs `onCopySent` в `selection.ts:17` — одно слово.
- [x] `context/selection.ts:15` — `MAX_SELECTION_CHARS = 24_000` конфликтует по
      имени с `prompt.ts:11` `MAX_SELECTION_CHARS = 12_000` →
      `MAX_SELECTED_TEXT_CHARS`. Проверено: импортирует только
      `selection.test.ts`, константа в `prompt.ts` не тронута.
- [x] `context/screenshot.ts:148` — `compress` ещё и масштабирует и кодирует →
      `encodeScreenshot`.

**Константы**

- [x] `overlay/index.ts:123-125` — два имени для одного бюджета в 1500 символов
      → `MAX_HISTORY_CHARS`.
- [x] `overlay/index.ts:1219` — URL атрибуции OpenRouter — магическая строка →
      `OPENROUTER_ATTRIBUTION`.
- [x] `overlay/request.ts:227` — `Math.max(maxTokens * 2, 1024)` →
      `REFINE_TOKEN_FACTOR`, `REFINE_MIN_TOKENS`.
- [x] `context/screenshot.ts:110,128,196` — минимум 2 pt трижды →
      `MIN_CAPTURE_SIDE`; `:245,255` — 12 попыток и 40 мс →
      `READ_ATTEMPTS`, `READ_RETRY_MS`; `0.02` → `PLACEMENT_TOLERANCE`;
      `8000` → `SCREENCAPTURE_TIMEOUT_MS`.
- [x] `context/selection.ts` — `450` и `35` → `SELECTION_POLL_TIMEOUT_MS`,
      `SELECTION_POLL_INTERVAL_MS`.
- [x] `overlay/index.ts` — `MAX_SHOT_AGE_MS` перенесён в блок констант модуля.

**Мёртвый код**

- [x] `overlay/index.ts:606,624,630` — `const shownEarly = true` и два мёртвых
      `if` → удалить флаг.

**Извлечения**

- [x] `overlay/index.ts:890-1196` — `sendTurn` ~300 строк, 12 обязанностей →
      `runAgentTurn()` / `runWriterTurn()`, оба возвращают `TurnResult | null`.
      Порядок эффектов сохранён; поток по-прежнему пишет в `session.answer`
      через `append`, поэтому живой текст карточки не изменился.
- [x] `overlay/index.ts:1048-1063` — две цепочки тернарников в четыре уровня из
      одних и тех же флагов → `describeRunOutcome(run, acknowledged)`.
- [x] `context/screenshot.ts:107-118` vs `:125-136` — `captureRegion` и
      `captureArea` — одна функция, разница только в `-o` →
      `captureRectangle(rect, file, { omitShadow })`.
- [x] `context/screenshot.ts:152,221` — inline-тип placement дважды → `Placement`.
- [x] `overlay/history.ts:46-50` — миграцию legacy `exchanges` вынести →
      `migrateLegacyExchanges(saved)`.
- [x] `overlay/index.ts` — дублированные блоки `windowStillMatches` →
      `observationHolds()`.

**Тесты**

- [x] `visibility.test.ts` — файл называется «visibility», а покрывает
      маршрутизацию, веб-поиск, голос, историю и свечение → `controller.test.ts`
      (переименован, заголовок описывает шесть реальных тем; не разнесён —
      группы уже разделены).

**Сделано, хотя было помечено RISKY**

- [x] `overlay/index.ts:941-942` vs `:993-994` — предикат маршрутизации вынесен
      в один `const isActionRequest`, второе чтение `agent.availability()`
      убрано. Проверено: между двумя прежними чтениями поток только вызывает
      `beginAgentTurn` (UI), `setTimeout`, `getSettings()` (чтение),
      `isExcluded` (чистая), `readPreviousCommand` (пишет только хранилище
      разговора) и `Array.filter` — записи настроек там нет, а входы
      «бинарник есть» и «AX разрешён» измениться не могут.

**Отложено (RISKY)**

- [ ] `overlay/request.ts:69-80` — `TurnRequest.useImage`/`.screenshot`
      читаются только тестом. Удаление требует правки теста.
- [ ] `overlay/index.ts` — `overlayShots` (`WeakSet`) пишется и никогда не
      читается. Найдено попутно, вне списка пакета; не удалено, чтобы не
      расширять область.

### WP5 — TypeScript: остальной main

Файлы: `src/main/index.ts`, `ipc.ts`, `prompt.ts`, `response.ts`,
`turnStream.ts`, `card.ts`, `tray.ts`, `hotkey.ts`, `util.ts`, `paths.ts`,
`permissions.ts`, `pageLoad.ts`, `denyExternalLinks.ts`, `src/main/llm/**`,
`src/main/voice/**`, `src/main/tts/**`, `src/main/settings/**`,
`src/main/windows/**`, `src/main/native/**`, `src/main/paste/**`.

**Переименования**

- [ ] `ipc.ts:65-68` — `sanitizeSettings` ничего не валидирует, это голый каст
      → `asSettingsPatch`.
- [ ] `ipc.ts:70-77` `bundle()` → `loadSettingsBundle()`.
- [ ] `ipc.ts:207` — канал `settings.hold`, обработчик `markSettingsBusy`,
      состояние `settingsBusy` — одно слово (канал не менять).
- [ ] `response.ts:31-33,73,91` — одно понятие под тремя именами (`shapes`,
      `collected()`, `remember()`) → `annotations`.
- [ ] `turnStream.ts` — `onShapes` → `onAnnotations`.
- [ ] `voice/whisper.ts:89` — `resolveModel` конфликтует по имени с
      `llm/index.ts:27` → `resolveWhisperModel`.
- [ ] `voice/listen.ts:16` — `VOICE_KEY_CODES as KEY_CODES` скрывает источник;
      `:72,80` — поле `current` и геттер `accelerator` об одном.
- [ ] `llm/webSearch.ts:48` — `const responses = ...` — булево с именем
      коллекции → `useResponsesApi`.
- [ ] `tray.ts:11` — `toggle` не говорит, что включает → `openAssistant`.
- [ ] `hotkey.ts:10` — `current` → `registeredAccelerator`.
- [ ] `card.ts:113,121` — `xFor`/`yFor` → `horizontalEdgeFor`/`verticalEdgeFor`.
- [ ] `windows/settings.ts:111` — `settingsWindows()` → `openAppWindows()`,
      отфильтровать `null` внутри.

**Комментарии**

- [ ] `turnStream.ts:1-16` — doc-модуля между двумя блоками импортов.
- [ ] `index.ts:4,206,239`, `tray.ts:2`, `windows/index.ts:474` — «tray-only
      (no Dock icon)», что противоречит `index.ts:35-39`. Переписать.
- [ ] `windows/index.ts:41` — «три ширины» в `@shared/metrics`, а там пять.
- [ ] `llm/reasoning.ts:1` — комментарий говорит «не отправляем неподдерживаемые
      параметры», а функция отправляет `reasoning_effort: 'none'`.
- [ ] `paths.ts:7-12`, `native/helper.ts:38-51`, `voice/whisper.ts:56-65` —
      список кандидатов ресурса трижды; зафиксировать разницу фолбэков
      комментарием.
- [ ] `windows/index.ts:226-275` — JSDoc на локальной `const` вместо функции.
- [ ] `layerWindow.ts` — все правки этого файла делает WP3.

**Константы**

- [ ] `ipc.ts:79-88` — `4000` → `BUNDLE_ID_TIMEOUT_MS`.
- [ ] `paste/index.ts:58` — `delay(40)` → `PASTEBOARD_SETTLE_MS`; `:29-34` —
      `1500`, `50` → имена.
- [ ] `settings.ts:48,55,57` — `1200` и `80` → `CLOSE_GRACE_MS`, `CLOSE_POLL_MS`.
- [ ] `voice/index.ts:84,90` — `5000`/`30_000` → единый стиль разделителей.
- [ ] `voice/whisper.ts:202,259,278,315,333,336` — потоки, лимиты stderr,
      таймауты, троттлинг → имена.
- [ ] `native/helper.ts:58,100,265` — `4000` трижды; `:325` `30_000`;
      `4_000 + text.length * 40` → имена.
- [ ] `tts/index.ts:59` — `'\u0000'` разделитель ключа кэша → имя.
- [ ] `llm/webSearch.ts:45,57,62,68,78` — `512`, `3`, `5`/`10`, `45_000` → имена.
- [ ] `llm/testKey.ts:12,32` — `12_000` и `160` → имена.
- [ ] `card.ts` — `'#0f1115'`, позиция светофора, `16`/`18` → имена.
- [ ] `util.ts:20-32` — `intervalMs = 40` → `DEFAULT_POLL_MS`.

**Мёртвый код**

- [ ] `paste/index.ts:37-41` — `putOnClipboard` дословно равен `copyText`
      → удалить и вызывать `copyText`.
- [ ] `native/helper.ts:227-230` `helperOpenBrowser` без вызовов.
- [ ] `settings/store.ts:85` `settingsWereRecovered` — если только тесты,
      задокументировать или убрать.
- [ ] `hotkey.ts:12-16,58` — `RegisterResult.accelerator`, `currentHotkey()`
      только в тестах.
- [ ] `permissions.ts:91` `openMicrophonePane` только через
      `openPermissionPane` и тесты.

**Извлечения**

- [ ] `native/helper.ts` — 513 строк, семь обязанностей → `native/process.ts`,
      `native/ax.ts`, `native/input.ts`, `native/apps.ts`. Чистые move,
      экспорты те же.
- [ ] `settings/secrets.ts:35-46,76-87` — `getApiKey`/`getTtsKey` и ещё две
      пары идентичны кроме слота → `readSlot`/`writeSlot`/`deleteSlot`.
- [ ] `windows/settings.ts:12-66` vs `:68-90` — создание окна скопировано →
      `openAppWindow({ title, width, height, page, resizable })`.
- [ ] `index.ts:124-222` — `bootstrap()` → `buildApplicationMenu()` +
      `reportStartupPermissions()`.
- [ ] `ipc.ts:146-180` — извлечь `applySettingsSideEffects(previous, next)`.
- [ ] `voice/index.ts:236-311` — `onTap` ~75 строк →
      `onPress`/`onRelease`/`onCancel`.
- [ ] `tts/index.ts:105` — динамический импорт `node:fs/promises` при
      статическом сверху → добавить в статический.
- [ ] `llm/anthropic.ts:50-52` vs `openai.ts:64-66` — `endpoint()` идентичен →
      `apiRoot` в `http.ts`; `:107-118` vs `openai.ts:105-115` — разбор
      «malformed» дублирован.
- [ ] `permissions.ts:20-41` — три одинаковых try/catch → `safe(fn, fallback)`.
- [ ] `tray.ts:30-42` и `index.ts:125-153` — подписи меню и акселераторы
      дублированы → общие константы. Строки не менять.
- [ ] `card.ts:38-48` — `ScreenPoint`/`CardRect` дублируют
      `Point01`/`ScreenRect` → переиспользовать; `:87` `clamp` → в `util.ts`.
- [ ] `windows/index.ts:470` — `passthrough` объявлена через ~250 строк после
      первого чтения → перенести к `drawing`/`voice`.

**Отложено (RISKY)**

- [ ] `prompt.ts:24-25` — `includeScreenshot` и `hasImage` → переименование
      параметров требует правки `overlay/request.ts` (чужой пакет).
- [ ] `prompt.ts:250-255` — четыре позиционных аргумента → объект опций;
      проверить, что текст промпта не меняется.
- [ ] `ipc.ts:343-345` vs `index.ts:232-234` — `second-instance` зарегистрирован
      дважды. Удаление меняет число открытий оверлея.
- [ ] `paths.ts`/`native/helper.ts`/`voice/whisper.ts` — унификация кандидатов
      ресурса: у трёх копий разные фолбэки.
- [ ] `llm/testKey.ts:24-33` — переписывает таблицу статусов из `http.ts` с
      другими формулировками. Тексты видны пользователю.
- [ ] `voice/index.ts:474-496,531` — `mode()`, `isBusy()`, `phase()` не
      используются вне тестов.
- [ ] `voice/whisper.ts:39` — модуль `whisper.ts` запускает и `transcribe-cli`
      → `voice/recognizer.ts`; переименование файла затрагивает импорты.

### WP6 — TypeScript: `shared` и `preload`

Файлы: `src/shared/**`, `src/preload/**`.

Напоминание: поля интерфейсов в `shared/types.ts` — контракт IPC, не
переименовывать. Работа здесь — комментарии, мёртвый код, локальные имена,
экспорт типов.

**Комментарии**

- [x] `shared/keycodes.ts:4` — заголовок описывает «agent parser» в
      `agent/keys.ts`, которого нет, и зовёт голосовой парсер `parseShortcut`
      (реально — `main/voice/listen.ts:parseAccelerator`). Переписать по факту.
      Механизм в новом тексте: парсеру нужен модификатор *и* клавиша, поэтому
      важен именно поднабор — иначе `Alt+esc` стал бы биндящимся.
- [x] `shared/metrics.ts:5,11` — ссылки на `main/windows.ts`, реальный путь
      `main/windows/index.ts`.
- [x] `shared/ipc.ts:87,96` — комментарии про «один план», хотя плана заранее
      нет → «run»/«step».
- [x] `shared/tts.ts:13` — проверки несовпадения нет нигде: читается только
      `RECORDED.voice`. `model`/`style` — запись о том, как сделаны клипы.
- [x] `shared/intent.ts:1` — заголовок повторяется; сжат, regex не тронуты.
- [x] `shared/intent.ts:70` — `BROWSER_COMMAND` и `FOLLOWING_ACTION` без
      объяснения; `allowsWebLookup` без doc-блока.
- [x] `shared/types.ts:424` — двойная пустая строка перед `TranscribeResult`.
- [x] `shared/accelerator.ts` — «shared by the two parsers» повторял ту же
      несуществующую историю → «the voice parser and the UI».
- [x] `shared/speechBank.ts:15` — 20 из 21 групп `SpeechCue` не читаются нигде,
      кроме `acknowledge`. **Не удалять** — незавершённая фича. Не сделано:
      пометить комментарием, какие группы пока не произносятся.

**Экспорт типов (аддитивно)**

- [x] `shared/types.ts:18,627,662` — `VoiceAction`, `RefineRequest`,
      `OverlayNotice` не экспортируются, хотя входят в публичные интерфейсы.
- [x] `shared/types.ts:271` — `AgentCursorFrame.phase` — inline-union → вынести
      `type AgentCursorPhase`. Поле и члены union не переименованы.

**Локальные имена**

- [x] `preload/index.ts:41` — `subscribe<null>(...)` → `subscribeSignal`.

**Тесты**

- [x] `preload/index.test.ts:74` — `pendingName` присваивается и только
      `void`-ится.
- [x] `shared/defaults.test.ts:38` — «see the note in PROGRESS» — файла нет.
- [x] `shared/keycodes.test.ts:10` — повторяет несуществующую историю про
      `parseShortcut` и парсер агента.

**Отложено (нужна правка вне пакета)**

- [ ] `shared/defaults.ts:343-344` — **исходная посылка неверна**: `MIN_SIDE` и
      `MAX_SIDE` не экспортируются и вне `defaults.ts` не читаются, а renderer
      жёстко пишет `480`/`2400`. Следующий шаг — не переименование, а «вынести
      и заставить renderer потреблять».
- [ ] `shared/defaults.ts:171` — `whisperModel` экспортируется, используется
      только тестом; задокументирован как тестовый экспорт, не удалён.
- [ ] `shared/defaults.ts:360` — `sanitizeVoice` смешивает четыре приведения.
- [ ] `shared/defaults.ts:420` — `slice(-256)` → `MAX_REMEMBERED_APPROVALS`.
- [ ] `shared/defaults.ts:103` — три хоста инлайном → `PLUSVIBE_HOSTS`.
- [ ] `shared/api.ts:32,56` — `RunningAppInfo` и `AppPickResult` — идентичные
      формы для одного понятия.
- [ ] `shared/intent.ts:23,32,73` — основа глаголов записана трижды. Якорность
      и лишний `сделай` должны сохраниться побайтово.
- [ ] `preload/index.d.ts:3` — то же объявление `Window.deskhand`, что и в
      `renderer/env.d.ts:3`. Оставить `renderer/env.d.ts` (его видит
      `tsconfig.web.json`), удалить `preload/index.d.ts` — правка в
      `renderer`/конфиге.
- [ ] `src/main/agent/cursor.ts` — `paintStep` всё ещё пишет
      `phase: 'arming' | 'acting'` инлайном; теперь можно `AgentCursorPhase`.
      Правка в WP3.

### WP7 — Renderer

Файлы: `src/renderer/**`.

Инварианты: CSS-классы и токены (`--accent`, `--cursor-accent`, …) — контракт
`docs/style.md`, не переименовывать. Русские тексты на экране не меняются.
Пропсы компонентов переименовываются только если компонент используется в
одном месте внутри пакета.

**Мёртвый код и враньё в комментариях**

- [ ] `overlay/keyPolicy.ts:54` — `KeyInput.hasRequestId` объявлен, передаётся
      из `App.tsx:972,1065` и тестов, но политика его не читает. Удалить поле и
      аргументы.
- [ ] `overlay/markdown.ts:5` — заголовок говорит, что таблиц нет, а
      `tableAt`/`Block.table`/`CellAlign` реализуют таблицы; там же
      «420-point card» при `FULL_WIDTH = 360`. Переписать.
- [ ] `overlay/viewFlags.ts:71` — `blocked` возвращается и не потребляется;
      `App.tsx:1026` заново выводит то же → добавить `blocked` в
      деструктуризацию `deriveView` и удалить дубль.
- [ ] `settings/App.tsx:115` — doc-блок `ApplyState` висит над
      `export function App()`, а тип живёт в `ApplyStatus.tsx:14`.
- [ ] `settings/AgentTab.tsx:57` — комментарий про «сохраняется только по
      кнопке», а кнопки сохранения в этом окне нет (автосейв).
- [ ] `settings/HotkeyField.tsx:84` — `buttonRef` присоединён и не читается.
- [ ] `settings/HotkeyField.tsx:72` — `prettyHotkey` — обёртка на одну строку
      вокруг `prettyAccelerator`, её импортирует onboarding из
      модуля-компонента.
- [ ] `useVoice.ts:46` — `available` вычисляется, возвращается и никем не
      читается. Удалить поле, вызов `status()` оставить.
- [ ] `useVoice.ts:112` — JSDoc с отступом в один пробел.
- [ ] `cursor/cursor.ts:13` — третья копия `clamp` в renderer, с другим guard.
- [ ] `presenter/presenter.ts:14` — `NS` дублирует `pointer/draw.ts:5`.
- [ ] `overlay/App.tsx:74` — `ruler` объявлен ниже `measureLine` → поднять выше.

**Одно имя на понятие**

- [ ] `overlay/App.tsx:639`, `useSpeech.ts:232` — слово `voice` означает
      «промпт был произнесён», а `useVoice()` — микрофон. Внутренние имена →
      `spoken`/`fromSpeech`. Поле `SendRequest.voice` — IPC, не трогать.
- [ ] `overlay/metrics.ts:28` — `NARROW_WIDTH`/`VOICE_WIDTH`/`FULL_WIDTH` —
      алиасы `CARD_*` → переименовать модуль (`cardMetrics.ts`) и использовать
      `CARD_*` везде.
- [ ] `overlay/viewFlags.ts:50,54,76` — `actionAsk` → `promptLooksLikeAction`;
      `alert` → `needsAttention`; `agentNotice` → инлайн.
- [ ] `overlay/cardWidth.ts:31` `manualCeiling` → `userWidthCeiling`; `:72`
      `listening` → `showingVoiceBars`.
- [ ] `overlay/markdown.ts:46,50` — `NUMBER` → `ORDERED`; `WORD` →
      `LETTER_OR_DIGIT`.
- [ ] `overlay/markdownText.tsx:19` — `tail?: boolean` → `withCaret`.
- [ ] `overlay/useVoice.ts:68` — `pendingStopRef` → `pendingStopTranscribeRef`.
- [ ] `settings/App.tsx:135` — локальная `hotkeyError` (строка) vs
      `SettingsBundle.hotkeyError` (булев флаг) — разные имена.
- [ ] `settings/App.tsx:129`, `onboarding/App.tsx:28` — `banner`/`notice`/
      `status` — четыре имени для временного сообщения.
- [ ] `settings/sections/ProviderSection.tsx:51` — `status` → `keyStatus`.
- [ ] `settings/VoiceTab.tsx:44` — `refresh`/`refreshSpeech`/`check`/`preview`
      → по смыслу; `:105` `deleteButton` → `renderDeleteButton`.
- [ ] `settings/VoiceTab.tsx:22` — `onChange`/`onTtsChange` →
      `onVoiceChange`/`onTtsChange`.
- [ ] `settings/PermissionRow.tsx:14` — проп `description` → `hint`.
- [ ] `settings/ApplyStatus.tsx:20` — `bad: boolean` → `isProblem`.
- [ ] `overlay/speechAudio.ts:38,42` — `key()` → `normalizeForLookup`;
      `byText` → `clipsByText`.
- [ ] `overlay/waiting.ts:9` — `waitingTips` → `WAITING_TIPS`; `:19` union
      стадии → `WaitStage`; `:7` `WAIT_VOICE_COOLDOWN_MS` относится к озвучке.
- [ ] `onboarding/App.tsx:50,90` — `request`/`finish` →
      `requestPermissions`/`completeOnboarding`.
- [ ] `overlay/App.tsx:589` — `reportRef`/`report` → `resizeWindowToLayout`.

**Магические числа**

- [ ] `overlay/App.tsx:485` — `0.62 + voice.level * 0.55`; `:1007` —
      `[0,1,2,3,4]`; `:550-554` — `FIELD_FONT.replace('13px','11px')` и
      `'11.5px'`.
- [ ] `overlay/speech.ts:24` — `ANSWER_FALLBACK` дублирует
      `speechBank.ts:108`; `:36` — 3 предложения и 420 символов.
- [ ] `overlay/recorder.ts:26` — `MAX_SECONDS = 120` повторяет
      `DEFAULT_VOICE.maxDurationMs`; `:147` — паддинги `-5`/`+6`; `:285` —
      гейн `6`.
- [ ] `overlay/useSpeech.ts:145,152` — 220 символов чанка и `1.3`.
- [ ] `settings/App.tsx:250,264,386,395` — четыре таймаута баннера без имён;
      `:299` — «450 мс» нигде не названо.
- [ ] `settings/VoiceTab.tsx:26` — `1024 * 1024` дважды.
- [ ] `onboarding/App.tsx:46` — `1500`.
- [ ] `pointer/draw.ts:59-191` — 14, 16, 0.42, 6, 4, 8, 240, 4/45; `:103` и
      `:110` два разных `gap` с одним именем.
- [ ] `presenter/presenter.ts:28` — `(5 / 26) * 20` с безымянными 20 и 26.

**Чистые извлечения**

- [ ] `overlay/markdown.ts:147` — `parseMarkdown` ~105 строк → `parseFence`,
      `parseTable`, `parseList`, `parseParagraph`.
- [ ] `pointer/draw.ts:110` — `placeLabel` 38 строк, `best!` в конце.
- [ ] `overlay/App.tsx:97` — `LiveThumb` → `overlay/LiveThumb.tsx`.
- [ ] `settings/VoiceTab.tsx:31` — 496 строк и четыре обязанности →
      `ModelList`, `TtsSection`, `ReadinessSection` (пропсы те же).

**Тесты**

- [ ] `overlay/viewFlags.test.ts:4` — «1300-line render», сейчас ~1474.
- [ ] `settings/applyGate.test.ts:31` — фикстура ставит `model: 'gpt-4o-mini'`,
      такого поля в `AppSettings` нет; каст `as AppSettings` это прячет.
- [ ] `overlay/cardWidth.test.ts:16` — `Partial<Parameters<...>>` вместо
      `WidthInputs`.
- [ ] `overlay/keyPolicy.test.ts:22` — передаёт `hasRequestId`.

**Отложено (RISKY)**

- [ ] `overlay/App.tsx:1150` vs `:939-949` — последовательность отмены написана
      дважды. Кнопка не закрывает карточку, когда id нет — сохранить.

### WP8 — Документация и комментарии-ссылки

Файлы: `docs/*.md`, `AGENTS.md`, `README`-подобные тексты.

- [ ] `docs/style.md:115` — ссылается на `src/renderer/hud/hud.css`, которого
      нет.
- [ ] `docs/agent-reliability.md` — сверить имена событий трассы с
      `agent/trace.ts` после WP3.
- [ ] `AGENTS.md` — сверить с фактическим поведением (сайдкар, `ToolPolicy`,
      `ActionPresenter`) после WP3/WP5.
- [ ] Комментарии, ссылающиеся на переименованные файлы/функции, обновляются
      **в том же пакете**, который переименовал, а не отдельным проходом.

## 5. Порядок и зависимости

Волны выбраны так, чтобы пакеты одной волны не трогали одни файлы.

| Волна | Пакеты | Почему вместе |
| --- | --- | --- |
| 1 | WP1 (Swift Core), WP3 (agent/TS + слои), WP4 (overlay/context), WP7 (renderer) | четыре непересекающихся дерева |
| 2 | WP2 (Swift Agent/LLM/Bridge), WP5 (остальной main), WP6 (shared/preload) | WP1 и WP3/WP4 закончили, Swift-пакеты не конкурируют за `.build` |
| 3 | WP8 (документация) | ссылается на итоговые имена |

Правила нарезки:

- `layerWindow.ts` целиком принадлежит WP3: этот файл трогают и агентские слои,
  и остальной main, поэтому один владелец лучше, чем два.
- Внутри пакета: сначала переименования, потом комментарии, потом удаление
  мёртвого кода. Один коммит на пакет.
- Пакет не коммитит сам: дифф проверяется и коммитится отдельно.

## 6. Проверка

После каждого пакета:

1. `npm run typecheck` — чисто.
2. `npm run lint` — чисто.
3. `npm test` — падений не больше 16, и только в двух integration-файлах.
4. `swift test` в `native/deskhand` (для WP1/WP2) — 0 падений.
5. `git diff --stat` — в пакете только его файлы.
6. Просмотр диффа: ни одного изменения строк, которые видит пользователь или
   модель, ни одного изменения JSON-ключа.

Финальная проверка после WP8:

- [ ] полный `npm test` + `swift test`
- [ ] `npm run build:agent` — сайдкар собирается
- [ ] `npm run build` — приложение собирается
- [ ] прогон по `docs/agent-acceptance-cases.json` — вне автоматики, отдельным
      шагом, если потребуется

## 8. Поведение, изменённое после прохода

Пункты ниже — не косметика. Они сделаны отдельно, тем же днём, потому что
косметический проход вскрыл причину.

### 8.1. Встроенных моделей нет

Было: у каждого провайдера в `PROVIDERS` стоял `defaultModel`, `DEFAULT_SETTINGS`
подставлял три имени, `resolveChatModel` падал на них, а `modelSupportsVision`
отвечал по флагу провайдера.

Проблема: имя модели в сборке — догадка о чужом аккаунте. Она устаревает, за
прокси означает совсем другую модель, и проваливается не как «модель не выбрана»,
а как «модель не найдена» — то есть пользователь чинит не то. Хуже: проверка
зрения для двух провайдеров из трёх возвращала константу, не глядя на модель,
поэтому текстовая модель на маршруте `openai` считалась зрячей.

Стало: `ProviderInfo` без `defaultModel` и `supportsVision`; `DEFAULT_SETTINGS.models`
пустые; `resolveChatModel` возвращает только введённое пользователем; модель
веб-поиска падает обратно на чат-модель, а не на встроенный id; списка моделей
для проверки зрения нет вообще.

### 8.2. Отказ модели от картинки не роняет ход

Раз списка нет, «видит ли модель картинки» до запроса неизвестно. Поэтому
картинка уходит, а отказ считается ответом: `ProviderError.imageRejected`
ставится в `toProviderError` по 400/422 и словам провайдера про image/vision/
multimodal; `runWriterTurn` повторяет тот же ход без снимка и пишет в карточку
`MODEL_REFUSED_IMAGE`; нативная петля делает то же самое внутри себя
(`AgentLoop.askModel` → повтор без изображений, `loopWarned`, и до конца прогона
скриншоты больше не прикладываются).

Остальные ошибки — 500, ключ, кривое тело — идут прежним путём и не повторяются.

**Проверки:** `npm test` — 1242 проходит, 16 предсуществующих падений в двух
integration-файлах; `swift test` — 92 + 45, одно предсуществующее падение;
`typecheck` и `lint` чистые; `npm run build` собирается.

## 9. Что осознанно не делается

- Никаких новых модулей, кроме `native/process.ts|ax.ts|input.ts|apps.ts`
  (WP5) и `test/layerWindowMock.ts` (WP3) — оба являются чистым разделением
  существующего кода.
- Никакой валидации настроек, никаких новых проверок, никаких новых ошибок.
- Никаких изменений в промптах, схемах инструментов, текстах интерфейса.
- Никаких изменений в протоколе, IPC-каналах и ключах хранения.
- Все находки, помеченные **RISKY**, остаются в этом документе как вход для
  следующего, поведенческого прохода.
