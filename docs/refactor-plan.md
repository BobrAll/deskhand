# План рефакторинга: чистый код, первый проход

Ветка: `refactor/clean-code-pass`. Скилл: `.agents/skills/refactoring/SKILL.md`,
правила — `.agents/skills/ub-mode-lite/SKILL.md`.

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
   `max_steps`, `verify_actions`, `timings`, `kind`, `timings`, …) — это
   контракт между Swift и TypeScript. Меняются только имена в памяти, никогда
   на проводе. Защищено `src/main/agent/sidecar.test.ts` (реальный транскрипт).
2. **IPC-каналы** (`settings.save`, `pointer.draw`, `agent.*`, …) — строки
   в `src/shared/ipc.ts` не переименовываются.
3. **Ключи настроек и хранилища** (`electron-store`, `agent-runs`, `secrets`) —
   ключи на диске не переименовываются.
4. **Текст промптов** (`src/main/prompt.ts`, `AgentLoop.systemPrompt`,
   `ToolSurface.definitions()`) — формулировки влияют на модель. Комментарии
   рядом можно править, строки — нет. Схемы инструментов побайтово
   зафиксированы в `InputTests.swift`.
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

- `src/main/agent/timing.integration.test.ts` — 10 тестов. Реальный бинарник
  `native/deskhand/.build/release/deskhand-agent` отвечает `error` на `run`
  вместо потока событий; тест ждёт `done`.
- `src/main/agent/trace.integration.test.ts` — 6 тестов, та же причина.

Эти два файла — единственные, которые запускают настоящий Swift-бинарник.
**Правило прохода:** падения не растут. Если после пакета число падений
больше 16 или список файлов шире этих двух — изменение откатывается.
Починить их — отдельная задача, не часть косметического прохода.

## 3. Пакеты работ

Пакеты нарезаны по владению файлами, чтобы субагенты не конфликтовали в
одном дереве. Порядок — от внутреннего к внешнему: сначала Swift (его
наблюдает TypeScript через протокол), потом main, потом shared/preload,
потом renderer.

### WP1 — Swift: `DeskhandCore`

Файлы: `native/deskhand/Sources/DeskhandCore/*.swift`,
`native/deskhand/Tests/DeskhandCoreTests/*.swift`.

Ключевые находки:

- `WindowCapture.swift:17` — `pngData` хранит JPEG (кодировщик JPEG-first).
  → `imageData`; `:25` doc «spent encoding the PNG» → «encoding the image»;
  `:41` текст ошибки про PNG. Те же имена в `Timings.swift:159,169,171`,
  `AgentObserver.swift:37`, `AgentLoop.swift:47,488`.
- `ToolExecutor.swift:9` — `case imagePNG(Data)` → `case image(Data)`
  (значение то же). Затрагивает `AgentLoop`, `ToolContent`.
- Один атрибут AX под тремя именами: `AXElement.descriptionText`
  (`AXElement.swift:126`), `AXWalkedValues.label` (`:323`), `AXNode.label`
  (`AXNode.swift:14`) → `label` везде.
- Одно число под двумя именами: `ChildrenResult.declaredCount`
  (`AXElement.swift:79,105`) → `AXNode.hiddenItemCount`
  (`AXNode.swift:32`) — выбрать одно имя (`declaredItemCount`).
- Один отказ под тремя именами: `ChildrenResult.refused`, `AXNode.childrenHidden`,
  `AXTreeWalker.isOpaqueContainer` — свести к `refusedChildren`.
- `AXTreeWalker.swift:187` vs `:224` — `isTransparentContainer` и
  `isOpaqueContainer` звучат как противоположности, но означают разное:
  → `isLayoutScaffolding(role:)` / `isContainerHidingChildren(role:frame:)`.
- `AppSession.swift:51,259` — `lastActionAt` пишется и никогда не читается,
  `noteAction()` вызывается 9 раз в `ToolExecutor` и ничего не делает.
  Комментарий `:257-258` описывает несуществующее поведение. Удалить поле,
  метод и 9 вызовов (мёртвый код, поведение не меняется).
- `AppSession.swift:50` `mapper` → `coordinateMapper`; `:49` `capture` →
  `lastCapture`; `:80` `currentSnapshot` дублирует `snapshot` — оставить одно.
- `ToolExecutor.swift:418-431` — два почти одинаковых doc-блока на одной
  функции; `:595-599` — то же на `bringToFront`; `:559-562` — комментарий
  противоречит коду (`includeScreenshot` передаётся дальше). Переписать.
- `ToolExecutor.swift:432` — `describe(name:arguments:narration:)`
  перегружает `describe(_ node:)` с другим смыслом → `policyContext(...)`.
- `ToolExecutor.swift:212` — `finish(_:session:action:...)` получает прозу
  (`"the click"`, `"the edit"`, 11 литералов) → параметр `actionLabel:`.
- `ToolSurface.swift:10-389` — один литерал на ~380 строк, дубли
  (`"additionalProperties": .bool(false)` ×11, блок `element_index` ×6).
  Вынести приватные хелперы схемы. **Вывод обязан остаться побайтово тем же**
  (`InputTests.swift:209-239`).
- `ToolSurface.swift:8` — `version` без читателя (мёртвое).
- `AppCatalog.swift:231-266` — один doc-блок на две функции, и он сам себе
  противоречит в порядке («raise window then activate» vs «activate then
  raise»). Разделить и исправить.
- `AppCatalog.swift:179` — `launch(_:)` без вызовов.
- `Mouse.swift:49-56` дублирует `Keyboard.swift:130-137` (фабрика
  `CGEventSource`) → один общий хелпер.
- `Mouse.swift` — девять безымянных пауз (0.02, 0.01, 0.06, …) → именованные
  константы темпа.
- `Timings.swift:129-151` — `bottleneck()` парсит префиксы `"  "`, `"tool "`,
  `"run total"`, которые собираются в `AgentLoop.swift:224-492`. Назвать
  протокол меток в одном месте.
- `Timings.swift:39-49` `measure` / `measureAsync` без вызовов;
  `AXElement.swift:18,197,210,141` `systemWide()`, `mainWindow()`, `pid()`,
  `attributeNames()` без вызовов; `JSONValue.swift:106` `isNumber` без
  вызовов; `SyntheticEvent.isSynthetic` без вызовов (и doc врёт про тесты).
  Удалить или задокументировать как публичный API.
- `Keyboard.swift:77-88` — `Destination.focusedApp` означает «системный поток,
  получает frontmost» → `.frontmostApp`.
- `Keyboard.swift:43-56` vs `ToolExecutor.swift:936-949` — две таблицы
  модификаторов с разными синонимами. **RISKY**: объединение меняет набор
  принимаемых строк. Только пометить, не делать.
- `WindowCapture.swift:165` `fit(size:longestEdge:)` → `downscaledSize(for:)`;
  `:157` `distance(_:_:)` → `distance(from:to:)`; `:89,96` магические 40 и 8.
- `AppSession.swift:11-27` `DiffSettle.budget/interval/maxWalkCost` без единиц.
- `ActionPresentation.swift:44` — `target`/`window` означают рамки элемента и
  окна → `elementFrame` / `windowFrame`. **Проверить**: поле сериализуется в
  bridge — переименование только в Swift-памяти, JSON-ключи не менять.
- `SystemPermissions.swift:47` `openPrivacySettings()` открывает только
  Accessibility → `openAccessibilityPrivacySettings()`.

Тесты: `InputTests.swift` содержит семь несвязанных наборов — разнести по
файлам по темам. `ToolExecutorTests.swift:147` `testDisambiguatesBySuffix`
не передаёт `suffix` и дублирует `testDisambiguatesByPrefix` — **RISKY**
(изменение покрытия), только пометить. `AgentLoopTests.swift:63` — два
объявления на одной строке.

### WP2 — Swift: `DeskhandAgentKit`, `DeskhandLLM`, `DeskhandAgent`

Файлы: `Sources/DeskhandAgentKit/*.swift`, `Sources/DeskhandLLM/*.swift`,
`Sources/DeskhandAgent/*.swift`, `Tests/DeskhandAgentTests/*.swift`,
`Tests/DeskhandLLMTests/*.swift`.

- `AgentLoop.swift:377-379` — в сообщении остановки пакета длинные серии
  пробелов из-за переноса строк без `\`. **Это текст, который читает модель**:
  исправление — только если считать это опечаткой форматирования; согласовать
  отдельно, пометить **RISKY**.
- `AgentLoop.swift:75` — `timings` (сборщик) конфликтует с `options.timings`
  (флаг) → `timingLog`.
- `AgentLoop.swift:469` — `reportRun(steps:calls:failed:)` → `failedCalls`
  (совпадает с `RunReport.failedCalls`).
- `AgentLoop.swift:553` `trim` → `trimmedHistory`; `:654,659`
  `preview`/`previewText` → `argumentPreview`/`textPreview`;
  `:615` `appKey(ofTreeMessage:)` → `appKey(forTreeMessage:)`.
- `AgentLoop.swift:444-447` — тройка «записать total → loopStopped →
  reportRun» повторена 4 раза → приватный `finishRun(reason:answer:)`.
  Чистое извлечение, порядок эффектов сохранить.
- `AgentObserver.swift:38` — `isError: Bool` в каждом вызове → переименовать
  параметр `didFail:` (тип не менять) или enum; выбрать первое, дешевле.
- `ChatProvider.swift:19` `toolIsError` / `ToolResult.isError` /
  `toolFinished(isError:)` — одно слово `isError`.
- `ChatProvider.swift:78` `Usage` → `TokenUsage`.
- `ProviderConfig.swift:56` `endpointURL()` — чистое чтение → свойство
  `endpointURL`; `:36-37` дефолты в именованные `defaultBaseURL`/`defaultModel`;
  `:139,190` список truthy дублирован; `:70` `redactedDescription` без вызовов.
- `AnthropicProvider.swift:157-161` и `OpenAICompatibleProvider.swift:166-170` —
  `ToolCallBuilder` скопирован дословно → один внутренний тип.
- `AnthropicProvider.swift:146` / `OpenAICompatibleProvider.swift:155` —
  `"Deskhand/0.1"` литерал дважды; `:90`/`:93` `[400, 404, 422]` дважды →
  общие константы DeskhandLLM.
- `AnthropicProvider.swift:30` `encodeBlocks` vs `openai.ts:34` `encodeParts` —
  выбрать одно имя (в Swift — `encodeBlocks`).
- `Bridge.swift:155,255,297` — русский и английский в одной ветке сообщений.
  **RISKY**: пользовательский текст, только пометить.
- `Bridge.swift:37-39` `RunHandle` оборачивает один `CancelToken` и ничего не
  добавляет; `:53` `ApprovalWait.value()` — чистое чтение → свойство;
  `:88` `handle(line:)` → `handleRequest(_:)`; `:291,299` таймауты в константы;
  `:478` `2000` → `maximumResultTextLength`.
- `main.swift:7-16` — doc-комментарий разрезан оператором
  `_ = NSApplication.shared`; `:88-93` — секция `USAGE` напечатана дважды.

### WP3 — TypeScript: агент, слои рисования

Файлы: `src/main/agent/**`, `src/main/pointer.ts`,
`src/main/annotations.ts`, `src/main/annotationGrounding.ts`,
`src/main/layerWindow.ts`.

- `agent/index.ts:87` `EMPTY` → `IDLE_EVENT`; `:226` `last` → `lastPublished`
  (и `last: () => last` → `lastEvent`); `:318` `rows()` → `actionRows()`;
  `:481` `handle(event)` → `handleSidecarEvent`.
- `agent/index.ts:151-176` — классификация остановок по подстрокам `'budget'`,
  `'token limit'`, `'repeated'`, `'returning to a screen'` → именованные
  константы. Строки не менять: они приходят от Swift.
- `agent/index.ts:329` `finish()` конфликтует с полем `current.finish`
  (`:257,402,771`) → локальная `settleRun()`.
- `agent/index.ts:377-478` `runTurn` ~100 строк: извлечь `subscribeToRun` и
  `releaseRun` (чистый move).
- `agent/index.ts:629` — `active.stopped ?? 'incomplete'` — строковый сентинел
  → `UNKNOWN_STOP`.
- `agent/index.ts:868` — `HISTORY_TURN_CHARS` объявлена после первого
  использования.
- `agent/approval.ts:37-38` — `CRITICAL` — расплывчатое имя и regex на 1000
  символов в одну строку → `COMMITTING_ACTION` + именованные фрагменты,
  склеенные `|` (тот же regex).
- `agent/approval.ts:68` `describe(request)` рядом с `describeCall(request)` —
  разные смыслы → `matchableText`.
- `agent/approval.ts:165-168` — inline regex и `'com.apple.finder'` →
  `COMMAND_MODIFIER`, `FINDER_DELETE_KEY`, `FINDER_BUNDLE_ID`.
- `agent/approval.ts:144` `remembered` хранит SHA-256 → `rememberedKeys`
  (только имя переменной; поле в `AgentSettings` не переименовывать).
- `agent/cursor.ts:60-61` — `held` и `turn` об одном владении ходом, 12 строк
  комментария компенсируют имена → `turnCount`/`glowOwner`, комментарий
  сокращается до «почему».
- `agent/cursor.ts:276` — `hide(force = false)`, вызовы `hide(true)` →
  `hide({ immediate: true })` или `hideNow()`.
- `agent/cursor.ts:335-398` — `updateAgentCursor` смешивает четыре политики →
  `paintSuccess` / `paintQuestion` / `paintStep`.
- `agent/presentation.ts:176,320-325` — публичный API смешивает префиксы
  (`presentAgentAction`, `showAgentPointer`, `hideAgentPresentation`).
  Привести к одному префиксу; механически, затронет `src/main/index.ts`,
  `overlay/index.ts`.
- `agent/presentation.ts:112,117,127` — `local`, `localRect`, `centre`
  → `toLayerPoint`, `toLayerRect`, `rectCenter`.
- `agent/cursor.ts:93`, `agent/presentation.ts:74`, `pointer.ts:58` —
  `ensureWindow()` написан трижды; `sameRect` трижды; `place` трижды.
  Вынести в `layerWindow.ts` (файл уже есть) как `ensureLayerWindow`,
  `sameScreenRect`, `placeLayer`. **RISKY**: `pointer.ts` округляет перед
  сравнением, остальные — нет; сохранить семантику каждого вызова.
- `agent/cursor.ts:13` `EXIT_MS = 160`, `agent/presentation.ts:33`
  `EXIT_MS = 240`, `pointer.ts:191` литерал `240` — одно имя, три значения →
  `CURSOR_FADE_MS`, `POINTER_FADE_MS`, `DRAWING_FADE_MS`. Значения не
  унифицировать.
- `agent/outline.ts:93-97` — `formatOutline(probe, bounds, area)`, где `area` —
  захват, а `bounds` — окно → `(probe, windowBounds, captureArea)`.
- `agent/outline.ts:102-123` vs `:156-161` — правило отбора элементов написано
  дважды, и копии уже разошлись (в фильтре нет проверки ролей для `editable`).
  Извлечь `isListable(...)`. **RISKY**: подтвердить, что различие намеренное.
- `agent/sidecar.ts:484-629` — `translate` 145 строк → по семействам событий.
  Транскрипт в `sidecar.test.ts` обязан пройти без правок.
- `agent/sidecar.ts:272,313,387,293` — таймауты `10_000`, `15_000`, `1_000`,
  `300` → именованные константы.
- `agent/trace.ts:29` `open` → `openTurns`; `:31` `writes` → `writeQueue`;
  `:92` `timed` → `traceTimed`; `:117` `schema: 2` → `TRACE_SCHEMA`.
- `annotations.ts:28-29` — комментарий **фактически неверен**: говорит «больше
  в одной оси», код проверяет «меньше в обеих». Переписать по факту.
- `annotations.ts:26` vs `:65` — словарь форм записан дважды (`KINDS` и regex)
  → вывести alternation из `KINDS`.
- `annotations.ts:130-131` — две ветки с одинаковым телом → одна.
- `annotations.ts:33-38,93,110,112` — `ParsedLine.text` всегда `''`, поле
  мёртвое, но читается в `response.ts:85` и тесте. **RISKY** (типы/тесты) —
  удалять отдельным шагом.
- `annotations.ts:98,101-102,133` — `1.5`, `0.03`, `0.95` → константы;
  `0.95` дублируется в `annotationGrounding.ts:23-24`.
- `annotationGrounding.ts:8` — `groundAnnotation` — жаргон → `snapToAxTarget`.
- `annotationGrounding.ts:21` — `matches[0].frame!` → type predicate в фильтре.
- `pointer.ts` — файл `pointer.ts`, окно «drawing layer», экспорты
  `showAnnotations`/`hideAnnotations`, тип `PointerShape`, канал `pointer.draw`,
  а оверлей зовёт это `setDrawing`. Канал не переименовывать; привести к
  «drawing» имена файла и типов.
- `pointer.ts:196` — `isPointerVisible()` есть только в тесте.
- `pointer.ts:40-47` vs `:200-208` — сброс состояния скопирован → `resetPointerState()`.
- `pointer.ts:73,191-193` — литералы `1500` и `240` → константы.
- `pointer.ts:121-122` — `minRadius = 16`, `padding = 6` внутри цикла → модульные.
- `layerWindow.ts:17` — «these two», хотя слоёв три; `:49-53` — placeholder
  без комментария; `:70-75` — третий дубль блока `webPreferences`.
- Тесты: `cursor.test.ts` и `presentation.test.ts` копируют весь мок
  `BrowserWindow` → общий `test/layerWindowMock.ts`.

### WP4 — TypeScript: оверлей и контекст

Файлы: `src/main/overlay/**`, `src/main/context/**`.

- `overlay/index.ts:1-9` — doc-модуля разрезан импортом; `node:crypto`
  импортирован дважды.
- `overlay/index.ts:291-307` — 16-строчный JSDoc про `captureFor` приклеен к
  переменной `captureInFlight` → перенести на `captureFor` (`:360`).
- `overlay/index.ts:941-942` vs `:993-994` — предикат маршрутизации
  `!refine && availability.ready && looksLikeAction(...)` написан дважды, и
  комментарий `:986-987` обещает, что свечение и маршрутизация не могут
  разойтись. Вынести `const isActionRequest`. **RISKY**: два чтения в разных
  точках хода — проверить, что настройки между ними не меняются.
- `overlay/index.ts:890-1196` — `sendTurn` ~300 строк, 12 обязанностей →
  `runAgentTurn()` / `runWriterTurn()`, чистое извлечение.
- `overlay/index.ts:606,624,630` — `const shownEarly = true` и два мёртвых
  `if` → удалить флаг.
- `overlay/index.ts:123-125` — два имени для одного бюджета в 1500 символов.
- `overlay/index.ts:339-350` — `b`/`o` и inline-сравнение рамок с `o!`/`b!` →
  `backgroundBounds`/`observedBounds` + общий `sameScreenRect`.
- `overlay/index.ts:1083-1099` — свойство `describeScreen` затеняет импорт;
  `windowStillMatches` вызывается дважды с дублированными блоками.
- `overlay/index.ts:1235` — параметр `session` затеняет внешнюю `session`;
  `:1289` — флаг `send` затеняет метод `send()`.
- `overlay/index.ts:1048-1063` — две цепочки тернарников в четыре уровня из
  одних и тех же флагов → `describeRunOutcome(run)`.
- `overlay/index.ts:228,250,256` — `state()`, `emit()`, `refresh()` →
  `overlayState()`, `sendToWindow()`, `publishState()`.
- `overlay/index.ts:755` — `clearPointer()` чистит аннотации →
  `clearAnnotations`.
- `overlay/index.ts:1219` — URL атрибуции OpenRouter — магическая строка.
- `overlay/history.ts:3,32,41` — `SavedCommand`, `write()`, `read()` → по
  смыслу одной записи; `:46-50` миграцию вынести.
- `overlay/host.ts:5-8` — doc ссылается на `windows.ts`, которого нет.
- `overlay/request.ts:69-80` — `TurnRequest.useImage`/`.screenshot` читаются
  только тестом. **RISKY** (контракт + тесты) — только пометить.
- `overlay/request.ts:241` — `WEB_LOOKUP_INSTRUCTION` объявлена после функции,
  которая её использует.
- `overlay/request.ts:227` — `Math.max(maxTokens * 2, 1024)` → константы.
- `overlay/emptyAnswer.ts:2` — параметр `annotations: number` — это счётчик →
  `annotationCount`.
- `context/collect.ts:6` — ссылка на `overlay.ts`, файл теперь
  `overlay/index.ts`; `:20` — `captureScreenshot: boolean` называется так же,
  как функция `captureScreenshot()` → `wantsScreenshot`; `:17`
  `onInputReady` vs `onCopySent` в `selection.ts:17` — одно слово.
- `context/selection.ts:15` — `MAX_SELECTION_CHARS = 24_000` конфликтует по
  имени с `prompt.ts:11` `MAX_SELECTION_CHARS = 12_000` → `MAX_SELECTED_TEXT_CHARS`.
  **RISKY**: обе импортируются тестами.
- `context/screenshot.ts:107-118` vs `:125-136` — `captureRegion` и
  `captureArea` — одна функция, разница только в `-o` → `captureRectangle(rect, file, { omitShadow })`.
- `context/screenshot.ts:148` — `compress` ещё и масштабирует и кодирует →
  `encodeScreenshot`.
- `context/screenshot.ts:152,221` — inline-тип placement дважды → `Placement`.
- `context/screenshot.ts:110,128,196` — минимум 2 pt трижды → `MIN_CAPTURE_SIDE`;
  `:245,255` — 12 попыток и 40 мс → константы.
- `visibility.test.ts` — файл называется «visibility», а покрывает
  маршрутизацию, веб-поиск, голос, историю и свечение → переименовать в
  `controller.test.ts` или разнести.

### WP5 — TypeScript: остальной main

Файлы: `src/main/index.ts`, `ipc.ts`, `prompt.ts`, `response.ts`,
`turnStream.ts`, `bubble.ts`, `tray.ts`, `hotkey.ts`, `util.ts`, `paths.ts`,
`permissions.ts`, `pageLoad.ts`, `denyExternalLinks.ts`, `src/main/llm/**`,
`src/main/voice/**`, `src/main/tts/**`, `src/main/settings/**`,
`src/main/windows/**`, `src/main/native/**`, `src/main/paste/**`.

Самые ценные:

- `src/main/native/helper.ts` — 513 строк, семь обязанностей (спавн процесса,
  маппинг AX, синтез ввода, перечисление приложений, права, watcher прерывания,
  курсор). Чистое разбиение на `native/process.ts`, `native/ax.ts`,
  `native/input.ts`, `native/apps.ts`. Внутренний модуль, экспорты те же.
- `settings/secrets.ts:35-46,76-87` — `getApiKey`/`getTtsKey` и ещё две пары
  функций идентичны кроме слота → `readSlot`/`writeSlot`/`deleteSlot`.
- `paste/index.ts:37-41` — `putOnClipboard` дословно равен `copyText`
  (`paste/clipboard.ts:58-62`) → удалить и вызывать `copyText`.
- `windows/settings.ts:12-66` vs `:68-90` — создание окна скопировано →
  `openAppWindow({ title, width, height, page, resizable })`.
- `windows/index.ts:470` — `passthrough` объявлена через ~250 строк после
  первого чтения (`:268`) → перенести к `drawing`/`voice` (`:61-65`).
- `windows/index.ts:41` — «три ширины» в `@shared/metrics`, а там пять.
- `ipc.ts:65-68` — `sanitizeSettings` ничего не валидирует, это голый каст →
  `asSettingsPatch`. (Настоящая валидация — вне прохода.)
- `ipc.ts:343-345` vs `index.ts:232-234` — `second-instance` зарегистрирован
  дважды. **RISKY**: удаление меняет число открытий оверлея.
- `ipc.ts:70-77` `bundle()` → `loadSettingsBundle()`; `:146-180` — извлечь
  `applySettingsSideEffects`; `:207` — канал `settings.hold`, обработчик
  `markSettingsBusy`, состояние `settingsBusy` — одно слово (канал не менять).
- `prompt.ts:24-25` — `includeScreenshot` и `hasImage` рядом и означают разное →
  `requestedScreenshot` / `imageAttached`.
- `prompt.ts:250-255` — четыре позиционных аргумента, два булевых →
  объект опций. Текст промпта не меняется.
- `response.ts:31-33,73,91` — одно понятие под тремя именами (`shapes`,
  `collected()`, `remember()`) → `annotations`.
- `turnStream.ts:1-16` — doc-модуля между двумя блоками импортов.
- `voice/index.ts:236-311` — `onTap` ~75 строк, три перехода состояния →
  `onPress`/`onRelease`/`onCancel`.
- `voice/index.ts:474-496,531` — `mode()`, `isBusy()`, `phase()` на публичном
  контроллере не используются вне тестов.
- `voice/whisper.ts:89` — `resolveModel` конфликтует по имени с
  `llm/index.ts:27`, который возвращает chat-модель → `resolveWhisperModel`.
- `voice/whisper.ts:39` — модуль `whisper.ts` запускает и `transcribe-cli` →
  `voice/recognizer.ts` (или `transcribe.ts`).
- `voice/listen.ts:16` — `VOICE_KEY_CODES as KEY_CODES` скрывает источник;
  `:72,80` — поле `current` и геттер `accelerator` об одном.
- `tts/index.ts` — четыре имени для одной способности (`speechBlockReason`,
  `requestSpeech`, `synthesize`, `speechStatus`) при папке `tts`; `:105` —
  динамический импорт `node:fs/promises` при статическом сверху.
- `llm/anthropic.ts:50-52` vs `openai.ts:64-66` — `endpoint()` идентичен →
  `apiRoot` в `http.ts`; `:107-118` vs `openai.ts:105-115` — разбор
  «malformed» дублирован.
- `llm/webSearch.ts:48` — `const responses = ...` — булево с именем коллекции →
  `useResponsesApi`.
- `llm/reasoning.ts:1` — комментарий говорит «не отправляем неподдерживаемые
  параметры», а функция отправляет `reasoning_effort: 'none'`.
- `llm/testKey.ts:24-33` — переписывает таблицу статусов из `http.ts:58-109`
  с другими формулировками. **RISKY**: тексты видны пользователю.
- `tray.ts:30-42` и `index.ts:125-153` — подписи меню и акселераторы
  дублированы → общие константы.
- `index.ts:4,206,239`, `tray.ts:2`, `windows/index.ts:474` — «tray-only
  (no Dock icon)», что противоречит `index.ts:35-39`. Переписать.
- `bubble.ts:38-48` — `BubblePoint`/`BubbleRect` дублируют `Point01`/`ScreenRect`
  → переиспользовать; `:87` `clamp` — общий хелпер, импортируется из
  `windows/index.ts` → в `util.ts`.
- `bubble.ts:186-193` — `resizeAnchor` с шестью позиционными аргументами →
  объект опций.
- `paths.ts:7-12`, `native/helper.ts:38-51`, `voice/whisper.ts:56-65` —
  список кандидатов ресурса трижды с *разными* фолбэками. **RISKY**.
- `permissions.ts:20-41` — три одинаковых try/catch → `safe(fn, fallback)`;
  `:95` inline-тип панели дублируется в `ipc.ts:216`.
- `layerWindow.ts` — см. WP3 (общий файл, поэтому все правки `layerWindow.ts`
  делает WP3, чтобы не конфликтовать).

### WP6 — TypeScript: `shared` и `preload`

Файлы: `src/shared/**`, `src/preload/**`.

Напоминание: поля интерфейсов в `shared/types.ts` — контракт IPC, не
переименовывать. Работа здесь — комментарии, мёртвый код, локальные имена,
экспорт типов.

- `shared/types.ts:424` — двойная пустая строка перед `TranscribeResult`.
- `shared/types.ts:18,627,662` — `VoiceAction`, `RefineRequest`, `OverlayNotice`
  не экспортируются, хотя входят в публичные интерфейсы. Экспортировать —
  это расширяет доступ, поведение не меняется.
- `shared/types.ts:271` — `AgentCursorFrame.phase` — inline-union, почти копия
  `AgentPhase` с другими словами. Вынести `type AgentCursorPhase` и описать
  соответствие одним комментарием. **Поле не переименовывать.**
- `shared/keycodes.ts:4` — заголовок описывает «agent parser» в
  `agent/keys.ts`, которого нет, и зовёт голосовой парсер `parseShortcut`
  (реально — `main/voice/listen.ts:parseAccelerator`). Переписать по факту.
  `:23` `KEY_CODES` экспортируется, но вне `VOICE_KEY_CODES` не используется.
- `shared/defaults.ts:343-344` — `MIN_SIDE`/`MAX_SIDE` — общие имена для границ
  скриншота → `SCREENSHOT_MIN_SIDE`/`SCREENSHOT_MAX_SIDE` и экспортировать.
  Те же границы записаны числами в `settings/sections/ProviderSection.tsx:246-247`
  (480/2400), `:258-259` (30/95), `:275-277` (0..2), и в
  `settings/applyGate.ts:24-25` (`MAX_TOKENS_MIN/MAX`), чей заголовок обещает,
  что границы «появляются один раз». Свести к одному источнику.
  **Проверить, что значения совпадают** — иначе это изменение поведения.
- `shared/defaults.ts:420` — `slice(-256)` → `MAX_REMEMBERED_APPROVALS`.
- `shared/defaults.ts:103` — три хоста инлайном → `PLUSVIBE_HOSTS`.
- `shared/defaults.ts:171` — `whisperModel` экспортируется и используется
  только тестом; продакшен берёт `voiceModel`.
- `shared/defaults.ts:360` — `sanitizeVoice` смешивает четыре приведения.
- `shared/metrics.ts:5,11` — ссылки на `main/windows.ts`, реальный путь
  `main/windows/index.ts`.
- `shared/api.ts:32,56` — `RunningAppInfo` и `AppPickResult` — идентичные формы
  для одного понятия. Оставить один тип с двумя именами только если имена
  что-то значат. **Поля не переименовывать.**
- `shared/api.ts:108,198` — позиционные булевы (`pin`, `allow`, `remember`).
  Сигнатуры — IPC-контракт, **не менять**.
- `shared/ipc.ts:87,96` — комментарии про «один план», хотя плана заранее нет.
- `shared/intent.ts:23,32,73` — основа глаголов записана трижды (`ACTION`,
  `ACTION_AT_START`, частично `FOLLOWING_ACTION`). Собрать один
  `ACTION_STEMS` и скомпоновать три regex из него. **RISKY**: якорность и
  лишний `сделай` должны сохраниться побайтово — если не выходит, оставить.
- `shared/intent.ts:70` — `BROWSER_COMMAND` и `FOLLOWING_ACTION` — единственные
  regex без объяснения; `allowsWebLookup` без doc-блока.
- `shared/speechBank.ts:15` — 20 из 21 групп `SpeechCue` (74 из 88 записанных
  фраз) не читаются нигде, кроме `acknowledge` (`overlay/waiting.ts:17`).
  **Не удалять** аудио и манифест — это незавершённая фича. Пометить
  комментарием, какие группы пока не произносятся.
- `shared/tts.ts:13` — `RECORDED.model` и `RECORDED.style` не читаются, хотя
  заголовок обещает проверку несовпадения. Либо проверка есть, либо
  комментарий врёт.
- `preload/index.ts:41` — `subscribe<null>(...)` использует бессмысленный тип
  payload, чтобы приспособить канал-сигнал → `subscribeSignal`.
- `preload/index.d.ts:3` — то же объявление `Window.deskhand`, что и в
  `renderer/env.d.ts:3`. Оставить одно.

### WP7 — Renderer

Файлы: `src/renderer/**`.

Инварианты: CSS-классы и токены (`--accent`, `--cursor-accent`, …) — контракт
`docs/style.md`, не переименовывать. Русские тексты на экране не меняются.
Пропсы компонентов переименовываются только если компонент используется в
одном месте внутри пакета.

Мёртвый код и враньё в комментариях:

- `overlay/keyPolicy.ts:54` — `KeyInput.hasRequestId` объявлен, передаётся из
  `App.tsx:972,1065` и тестов, но политика его не читает. Удалить поле и
  аргументы.
- `overlay/markdown.ts:5` — заголовок говорит, что таблиц нет («это был бы код,
  который никто не читает»), а `tableAt`/`Block.table`/`CellAlign` реализуют
  таблицы; там же «420-point bubble» при `FULL_WIDTH = 360`. Переписать.
- `overlay/viewFlags.ts:71` — `blocked` возвращается и не потребляется;
  `App.tsx:1026` заново выводит то же из `state.context.excluded`. Добавить
  `blocked` в деструктуризацию `deriveView` и удалить дубль.
- `settings/App.tsx:115` — doc-блок `ApplyState` висит над `export function App()`,
  а тип живёт в `ApplyStatus.tsx:14`.
- `settings/AgentTab.tsx:57` — комментарий про «сохраняется только по кнопке»,
  а кнопки сохранения в этом окне нет (автосейв).
- `settings/HotkeyField.tsx:84` — `buttonRef` присоединён и не читается.
- `settings/HotkeyField.tsx:72` — `prettyHotkey` — обёртка на одну строку вокруг
  `prettyAccelerator`, и её импортирует onboarding из модуля-компонента.
- `useVoice.ts:46` — `available` вычисляется, возвращается и никем не читается.
  Удалить поле, вызов `status()` оставить (он прогревает рекордер).
- `useVoice.ts:112` — JSDoc с отступом в один пробел, в отличие от всего файла.
- `cursor/cursor.ts:13` — третья копия `clamp` в renderer (ещё
  `overlay/metrics.ts:89`), и у этой другой guard (`Math.max(min, max)`).
  Свести к одному хелперу, сохранив поведение каждой копии.
- `presenter/presenter.ts:14` — `NS` дублирует `pointer/draw.ts:5`.

Одно имя на понятие:

- `overlay/App.tsx:639`, `useSpeech.ts:232`, `SendRequest.voice` — слово `voice`
  означает «промпт был произнесён», а `useVoice()`/`voice.phase` — микрофон, в
  одном компоненте. Внутренние имена → `spoken`/`fromSpeech`. Поле
  `SendRequest.voice` — IPC-контракт, **не трогать**.
- `overlay/metrics.ts:28` — `NARROW_WIDTH`/`VOICE_WIDTH`/`FULL_WIDTH` — алиасы
  `BUBBLE_*`, а `BUBBLE_MIN_WIDTH` импортируется напрямую. Переименовать модуль
  (например `cardMetrics.ts`) и использовать `BUBBLE_*` везде.
- `overlay/viewFlags.ts:50,54,76` — `actionAsk` (читается как глагол) →
  `promptLooksLikeAction`; `alert` → `needsAttention`; `agentNotice` живёт
  только чтобы попасть в `hint` → инлайн.
- `overlay/cardWidth.ts:31` `manualCeiling` → `userWidthCeiling`; `:72`
  `listening` (булево «рисовать только полоски») → `showingVoiceBars`.
- `overlay/markdown.ts:46,50` — `NUMBER` (это маркер упорядоченного списка) →
  `ORDERED`; `WORD` → `LETTER_OR_DIGIT`.
- `overlay/markdownText.tsx:19` — `tail?: boolean` означает «дорисовать каретку»
  → `withCaret`.
- `overlay/useVoice.ts:68` — `pendingStopRef` хранит флаг transcribe, а не
  «остановка в ожидании» → `pendingStopTranscribeRef`.
- `settings/App.tsx:135` — локальная `hotkeyError` — строка, а
  `SettingsBundle.hotkeyError` — булев флаг. Разные имена.
- `settings/App.tsx:129`, `onboarding/App.tsx:28` — `banner`/`notice`/`status` —
  четыре имени для временного сообщения.
- `settings/sections/ProviderSection.tsx:51` — `status` — это `KeyStatus` →
  `keyStatus`.
- `settings/VoiceTab.tsx:44` — `refresh`/`refreshSpeech`/`check`/`preview` →
  по смыслу; `:105` `deleteButton` возвращает JSX → `renderDeleteButton`.
- `settings/VoiceTab.tsx:22` — пропсы `onChange` (voice) и `onTtsChange` (tts)
  асимметричны → `onVoiceChange`/`onTtsChange`.
- `settings/PermissionRow.tsx:14` — проп `description` уходит в `hint` у `Row`
  → `hint`.
- `settings/ApplyStatus.tsx:20` — `bad: boolean` → `isProblem`.
- `overlay/speechAudio.ts:38,42` — `key()` → `normalizeForLookup`; `byText` →
  `clipsByText`.
- `overlay/waiting.ts:9` — `waitingTips` camelCase в файле, где всё остальное
  UPPER_SNAKE; `:19` union стадии инлайном → `WaitStage`; `:7`
  `WAIT_VOICE_COOLDOWN_MS` относится к озвучке, а не к ожиданию, и его значение
  продублировано словами «45 секунд» в `VoiceTab.tsx:315`.
- `onboarding/App.tsx:50,90` — `request`/`finish` → `requestPermissions`/
  `completeOnboarding`.
- `overlay/App.tsx:589` — `reportRef`/`report` → `resizeWindowToLayout`.
- `overlay/App.tsx:74` — `ruler` объявлен ниже `measureLine`, которая его
  использует; порядок читается как баг → поднять выше.

Магические числа:

- `overlay/App.tsx:485` — `0.62 + voice.level * 0.55`; `:1007` — `[0,1,2,3,4]`;
  `:550-554` — `FIELD_FONT.replace('13px','11px')` и `'11.5px'`.
- `overlay/speech.ts:24` — `ANSWER_FALLBACK = 'Ответ готов.'` дублирует
  `speechBank.ts:108`; `:36` — 3 предложения и 420 символов.
- `overlay/recorder.ts:26` — `MAX_SECONDS = 120` молча повторяет
  `DEFAULT_VOICE.maxDurationMs`; `:147` — паддинги `-5`/`+6`; `:285` — гейн `6`.
- `overlay/useSpeech.ts:145,152` — 220 символов чанка и `1.3`.
- `settings/App.tsx:250,264,386,395` — четыре разных таймаута баннера без имён;
  `:299` — «450 мс» описано в трёх комментариях и нигде не названо.
- `settings/VoiceTab.tsx:26` — `1024 * 1024` дважды.
- `onboarding/App.tsx:46` — `1500`.
- `pointer/draw.ts:59-191` — 14, 16, 0.42, 6, 4, 8, 240, 4/45; `:103` и `:110`
  два разных `gap` с одним именем.
- `presenter/presenter.ts:28` — `(5 / 26) * 20` с безымянными 20 и 26.

Чистые извлечения (только move, без переупорядочивания):

- `overlay/markdown.ts:147` — `parseMarkdown` ~105 строк, пять блочных парсеров
  → `parseFence`, `parseTable`, `parseList`, `parseParagraph`.
- `pointer/draw.ts:110` — `placeLabel` 38 строк, `best!` в конце → кандидаты,
  клампинг и выбор разнести.
- `overlay/App.tsx:97` — `LiveThumb` — самостоятельный компонент в файле карточки
  → `overlay/LiveThumb.tsx`.
- `overlay/App.tsx:1150` vs `:939-949` — последовательность отмены написана
  дважды. **RISKY**: кнопка не закрывает карточку, когда id нет — сохранить.
- `settings/VoiceTab.tsx:31` — 496 строк и четыре обязанности → `ModelList`,
  `TtsSection`, `ReadinessSection` (пропсы те же).

Тесты:

- `overlay/viewFlags.test.ts:4` — «1300-line render», сейчас ~1474.
- `shared/keycodes.test.ts:10` — повторяет несуществующую историю про
  `parseShortcut` (voice) и парсер агента.
- `settings/applyGate.test.ts:31` — фикстура ставит `model: 'gpt-4o-mini'`,
  такого поля в `AppSettings` нет; каст `as AppSettings` это прячет.
- `overlay/cardWidth.test.ts:16` — `Partial<Parameters<...>>` вместо
  экспортированного `WidthInputs`.
- `overlay/keyPolicy.test.ts:22` — передаёт `hasRequestId`, который политика
  игнорирует.
- `preload/index.test.ts:74` — `pendingName` присваивается и только `void`-ится.
- `shared/defaults.test.ts:38` — «see the note in PROGRESS» — файла нет.


### WP8 — Документация и комментарии-ссылки

Файлы: `docs/*.md`, `AGENTS.md`, `README`-подобные тексты.

- `docs/style.md:115` — ссылается на `src/renderer/hud/hud.css`, которого нет.
- `docs/agent-reliability.md` — сверить имена событий трассы с
  `agent/trace.ts` после WP3.
- `AGENTS.md` — сверить с фактическим поведением (сайдкар, `ToolPolicy`,
  `ActionPresenter`) после WP3/WP5.
- Комментарии, ссылающиеся на переименованные файлы/функции, обновляются
  **в том же пакете**, который переименовал, а не отдельным проходом.

## 4. Порядок и зависимости

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


## 5. Проверка

После каждого пакета:

1. `npm run typecheck` — чисто.
2. `npm run lint` — чисто.
3. `npm test` — падений не больше 16, и только в двух integration-файлах.
4. `swift test` в `native/deskhand` (для WP1/WP2) — 0 падений.
5. `git diff --stat` — в пакете только его файлы.
6. Просмотр диффа: ни одного изменения строк, которые видит пользователь или
   модель, ни одного изменения JSON-ключа.

Финальная проверка после WP8:

- полный `npm test` + `swift test`;
- `npm run build:agent` — сайдкар собирается;
- `npm run build` — приложение собирается;
- прогон по `docs/agent-acceptance-cases.json` — вне автоматики, отдельным
  шагом, если потребуется.

## 6. Что осознанно не делается

- Никаких новых модулей, кроме `native/process.ts|ax.ts|input.ts|apps.ts`
  (WP5) и `test/layerWindowMock.ts` (WP3) — оба являются чистым разделением
  существующего кода.
- Никакой валидации настроек, никаких новых проверок, никаких новых ошибок.
- Никаких изменений в промптах, схемах инструментов, текстах интерфейса.
- Никаких изменений в протоколе, IPC-каналах и ключах хранения.
- Все находки, помеченные **RISKY**, остаются в этом документе как вход для
  следующего, поведенческого прохода.
