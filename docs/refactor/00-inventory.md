# 00 — Inventory

Инвентарь контрактов, которые по правилу 1 менять нельзя. Задача T01: IPC-таблица и окна.
Формат строки: канал → направление → payload → хендлер/эмиттер → потребитель.
Строки в `src/shared/ipc.ts` (далее `CH`) — 56 каналов: overlay 15, pointer 1, hud 2, settings 11,
permissions 5, onboarding 3, quickActions 1, agent 5, voice 13. Плюс один канал вне `CH` (`shell:open-external`).

## 1. IPC: каналы

Обозначения направления: **invoke** — `renderer -> main`, ответ промисом (`ipcMain.handle`);
**send** — `renderer -> main`, без ответа (`ipcMain.on`); **push** — `main -> renderer` (`webContents.send`).

### 1.1 overlay (15 каналов)

| Канал | Строка `CH` | Направление | Payload | Хендлер / эмиттер | Потребитель |
|---|---|---|---|---|---|
| `overlay:get-state` | 8 | invoke | → `OverlayState \| null` | `ipc.ts:111` | `overlay/App.tsx:419` |
| `overlay:state` | 10 | push | `OverlayState` | `overlay.ts:295,610,621` | `overlay/App.tsx:423` (`onState`) |
| `overlay:preparing` | 20 | push | `null` | `overlay.ts:560` | `overlay/App.tsx:424` (`onPreparing`) |
| `overlay:context-update` | 22 | push | `ContextSnapshot` | `overlay.ts:325` | `overlay/App.tsx:449` |
| `overlay:stream` | 24 | push | `StreamEvent` (`chunk`/`done`/`error`) | `overlay.ts:805,842,853,1486` | `overlay/App.tsx:452` |
| `overlay:annotations` | 26 | push | `AnnotationsEvent {count,visible}` | `overlay.ts:698` | `overlay/App.tsx:453` |
| `overlay:send` | 27 | send | `SendRequest` | `ipc.ts:113` | `overlay/App.tsx:721,758` |
| `overlay:cancel` | 28 | send | `requestId: string` | `ipc.ts:116` | `overlay/App.tsx:500,684,894,1087` |
| `overlay:set-flags` | 29 | send | `ContextFlags` | `ipc.ts:117` | `overlay/App.tsx:780` |
| `overlay:resize` | 30 | send | `height: number, width?: number` | `ipc.ts:120` | `overlay/App.tsx:613` |
| `overlay:copy` | 31 | invoke | `text: string` → `ActionResult` | `ipc.ts:125` | `overlay/App.tsx:853` |
| `overlay:paste` | 32 | invoke | `text: string` → `PasteResult` | `ipc.ts:133` | `overlay/App.tsx:847` |
| `overlay:clear-pointer` | 34 | send | — | `ipc.ts:118` | `overlay/App.tsx:784` |
| `overlay:typing` | 39 | send | `boolean` | `ipc.ts:119` | `overlay/App.tsx:476` |
| `overlay:close` | 40 | send | — | `ipc.ts:123` | `overlay/App.tsx:873,901` |

### 1.2 pointer / hud / agent-cursor (4 канала)

| Канал | Строка `CH` | Направление | Payload | Хендлер / эмиттер | Потребитель |
|---|---|---|---|---|---|
| `pointer:draw` | 44 | push | `PointerPayload` | `pointer.ts:209,228` | `pointer/main.ts:17` |
| `hud:state` | 53 | push | `HudFrame` | `hud.ts:306` | `hud/main.ts:19` |
| `hud:get-state` | 58 | invoke | → `HudFrame \| null` | `ipc.ts:108` | `hud/main.ts:25` |
| `agent:cursor` | 116 | push | `AgentCursorFrame` | `agent/cursor.ts:220,371` | `cursor/main.ts:20` |

### 1.3 settings (11 каналов)

| Канал | Строка `CH` | Направление | Payload | Хендлер | Потребитель |
|---|---|---|---|---|---|
| `settings:load` | 61 | invoke | → `SettingsBundle` | `ipc.ts:136` | `settings/App.tsx:96`, `onboarding/App.tsx:31` |
| `settings:save` | 62 | invoke | `AppSettings` → `SettingsBundle` (+`hotkeyError`) | `ipc.ts:138` | `settings/App.tsx:174`, `onboarding/App.tsx:73` |
| `settings:set-key` | 63 | invoke | `(provider, key)` → `SettingsBundle` | `ipc.ts:174` | `settings/App.tsx:350`, `onboarding/App.tsx:72` |
| `settings:delete-key` | 64 | invoke | `provider` → `SettingsBundle` | `ipc.ts:180` | `settings/App.tsx:364` |
| `settings:test-key` | 65 | invoke | `(provider, key, baseUrl?)` → `TestKeyResult` | `ipc.ts:186` | `settings/App.tsx:341`, `onboarding/App.tsx:63` |
| `settings:running-apps` | 66 | invoke | → `RunningAppInfo[]` | `ipc.ts:191` | `settings/App.tsx:109` |
| `settings:pick-app` | 67 | invoke | → `AppPickResult \| null` | `ipc.ts:192` | `settings/App.tsx:794` |
| `settings:validate-hotkey` | 68 | invoke | `accelerator` → `ActionResult` | `ipc.ts:194` | **нет потребителя** (только preload) |
| `settings:open` | 69 | send | — | `ipc.ts:202` | `overlay/App.tsx:1191` |
| `settings:close` | 70 | send | — | `ipc.ts:203` | `settings/App.tsx:313` |
| `settings:hold` | 79 | send | `busy: boolean` | `ipc.ts:207` | `settings/App.tsx:258` |

### 1.4 permissions (5 каналов)

| Канал | Строка `CH` | Направление | Payload | Хендлер | Потребитель |
|---|---|---|---|---|---|
| `permissions:status` | 82 | invoke | → `PermissionState` | `ipc.ts:210` | `onboarding/App.tsx:30,41` |
| `permissions:request` | 83 | invoke | → `PermissionState` | `ipc.ts:211` | `onboarding/App.tsx:47`, `settings/App.tsx:721,731` |
| `permissions:open` | 84 | send | `'accessibility' \| 'screenRecording' \| 'microphone'` | `ipc.ts:214` | `settings/App.tsx:724,734,746`, `settings/AgentTab.tsx:114`, `overlay/App.tsx:1228` |
| `permissions:microphone` | 86 | invoke | → `boolean` | `ipc.ts:212` | **нет потребителя**; продублирован в `voice.micPermission` (preload:111) |
| `permissions:request-microphone` | 87 | invoke | → `boolean` | `ipc.ts:213` | `onboarding/App.tsx:53`, `settings/App.tsx:741`; дубль в `voice.requestMicPermission` (preload:112) |

### 1.5 onboarding / quickActions (4 канала)

| Канал | Строка `CH` | Направление | Payload | Хендлер | Потребитель |
|---|---|---|---|---|---|
| `onboarding:complete` | 90 | invoke | → `void` | `ipc.ts:222` | `onboarding/App.tsx:87` |
| `onboarding:open-settings` | 91 | send | — | `ipc.ts:226` | `onboarding/App.tsx:260` |
| `onboarding:close` | 92 | send | — | `ipc.ts:230` | **нет потребителя** (только preload:89) |
| `quick-actions:defaults` | 95 | invoke | → `QuickAction[]` | `ipc.ts:314` | **нет потребителя** (только preload:99) |

### 1.6 agent (4 канала; `agent:cursor` — в §1.2)

| Канал | Строка `CH` | Направление | Payload | Хендлер / эмиттер | Потребитель |
|---|---|---|---|---|---|
| `agent:event` | 107 | push | `AgentEvent` | `overlay.ts:222` | `overlay/App.tsx:456` |
| `agent:stop` | 118 | invoke | → `void` | `ipc.ts:309` | `overlay/App.tsx:898` |
| `agent:availability` | 125 | invoke | → `AgentAvailability` | `ipc.ts:303` | `settings/AgentTab.tsx:44` |
| `agent:set-enabled` | 136 | invoke | `boolean` → `AgentAvailability` | `ipc.ts:306` | `settings/App.tsx:686`, `overlay/App.tsx:798` |

### 1.7 voice (13 каналов)

| Канал | Строка `CH` | Направление | Payload | Хендлер / эмиттер | Потребитель |
|---|---|---|---|---|---|
| `voice:event` | 141 | push | `VoiceEvent {phase,level,text?,error?}` | `voice/index.ts:123` | `overlay/useVoice.ts:241` |
| `voice:record` | 143 | push | `{maxDurationMs}` | `voice/index.ts:264` | `overlay/useVoice.ts:232` |
| `voice:attach` | 149 | invoke | → `{phase, maxDurationMs}` | `ipc.ts:241` | `overlay/useVoice.ts:260` |
| `voice:transcript` | 154 | push | `{text, send}` | `overlay.ts:1567` | `overlay/App.tsx:820` |
| `voice:stop` | 156 | push | `{transcribe: boolean}` | `voice/index.ts:197,276,288,296,301` | `overlay/useVoice.ts:237` |
| `voice:recorded` | 158 | invoke | `(wavBase64, durationMs)` → `TranscribeResult` | `ipc.ts:243` | `overlay/useVoice.ts:172,224` |
| `voice:failed` | 160 | send | `message: string` | `ipc.ts:247` | `overlay/useVoice.ts:185` |
| `voice:level` | 162 | send | `number` | `ipc.ts:251` | `overlay/useVoice.ts:160` |
| `voice:status` | 164 | invoke | → `VoiceStatus` + `gestureError` | `ipc.ts:233` | `settings/VoiceTab.tsx:39` |
| `voice:download` | 165 | invoke | `model` → `VoiceStatus` | `ipc.ts:255` | `settings/VoiceTab.tsx:68` |
| `voice:download-progress` | 166 | push | `DownloadProgress` | `ipc.ts:260` (адресно: `event.sender`) | `settings/VoiceTab.tsx:47` |
| `voice:import-model` | 167 | invoke | → `VoiceStatus \| null` | `ipc.ts:270` | `settings/VoiceTab.tsx:249` |
| `voice:test` | 168 | invoke | → `TranscribeResult` | `ipc.ts:287` | `settings/VoiceTab.tsx:80` |

### 1.8 Вне `CH`

| Канал | Направление | Payload | Хендлер | Потребитель |
|---|---|---|---|---|
| `shell:open-external` | invoke | `url: string` (только `http(s)`) | `ipc.ts:317` (строка-литерал, не в `CH`) | **нет потребителя**: не экспортирован в preload; ту же роль играет `webContents.setWindowOpenHandler` (`windows.ts:675`, `pointer.ts:87`, `hud.ts:238`, `agent/cursor.ts:139`) |

`registerIpc` также вешает `app.on('second-instance')` → `overlay.open()` (`ipc.ts:321`) — не канал, но часть той же точки сборки.

## 2. Окна: создатель, страница, webPreferences

Все 6 окон грузят один и тот же preload (`join(__dirname, '../preload/index.js')`) и имеют одинаковые
`webPreferences: { preload, sandbox: false, contextIsolation: true, nodeIntegration: false }`.
`sandbox: false` — не ослаблять дальше; `contextIsolation: true` + `nodeIntegration: false` — базовая линия.

| # | Окно | Страница | Создатель | Размер | Особенности |
|---|---|---|---|---|---|
| 1 | overlay | `renderer/overlay` | `createOverlayWindow()` — `windows.ts:115` (единственный экземпляр, `overlayWindow`) | 112×31 (`OVERLAY_NARROW_WIDTH`/`OVERLAY_MIN_HEIGHT`), `resize` → до `OVERLAY_MAX_HEIGHT` 520 | `frame:false`, `transparent:true`, `vibrancy:'under-window'`, `hasShadow:!voice`, `roundedCorners`, + `spellcheck:true` (единственное окно со spellcheck) |
| 2 | pointer | `renderer/pointer` | `createWindow()` — `pointer.ts:40` | 400×300 | `focusable:false`, `skipTaskbar`, `setIgnoreMouseEvents(true,{forward:true})`, `alwaysOnTop 'screen-saver'`, `setContentProtection(true)` |
| 3 | cursor | `renderer/cursor` | `createWindow()` — `agent/cursor.ts:90` | 400×300 | те же флаги, что у pointer (картинка, не окно) |
| 4 | hud | `renderer/hud` | `createWindow()` — `hud.ts:194` | 320×160 (`WIDTH`/`HEIGHT`) | `focusable:false`, `skipTaskbar`, `setIgnoreMouseEvents(true)` без `forward`, `setContentProtection(true)` |
| 5 | settings | `renderer/settings` | `openSettingsWindow()` — `windows.ts:624` | 980×760, min 820×560 | `baseOptions()` (`windows.ts:602`): `titleBarStyle:'hiddenInset'`, `trafficLightPosition`, `backgroundColor:'#0f1115'`; `close`-хук с грейс-периодом до 1200 мс при `settingsBusy` |
| 6 | onboarding | `renderer/onboarding` | `openOnboardingWindow()` — `windows.ts:683` | 760×660, `resizable:false` | `baseOptions()`, один экземпляр |

Загрузка страниц: `load()` (`windows.ts:64`) и три локальные копии `loadPage()` (`pointer.ts:34`, `hud.ts:188`,
`agent/cursor.ts:84`) — в dev `ELECTRON_RENDERER_URL`, иначе `../renderer/<page>/index.html`.

## 3. Что видит renderer

`window.smartCursor` (preload:35, контракт `shared/api.ts:56`) — 58 методов в 10 неймспейсах.
Вызываются из renderer 52; **не вызываются ниоткуда** (только объявлены в preload/api.ts):
`settings.validateHotkey`, `onboarding.close`, `quickActions.defaults`, `permissions.microphone`,
`voice.micPermission`, `voice.requestMicPermission`. Последние два — дубли каналов `permissions:*`.

Подписки (`onXxx` → `ipcRenderer.on`): 14 мест в 6 файлах — `overlay/App.tsx` (7), `overlay/useVoice.ts` (3,
через локальный алиас `api`), `pointer/main.ts` (1), `cursor/main.ts` (1), `hud/main.ts` (1),
`settings/VoiceTab.tsx` (1). Общего хука нет.

## 4. Перепроверка фактов из CONTEXT.md (T01)

| Факт в CONTEXT.md | Проверка | Итог |
|---|---|---|
| «6 окон: overlay, pointer, cursor, hud, settings, onboarding» (стр. 55) | `grep new BrowserWindow` → 6, по одному создателю на окно | подтверждено |
| «helper.m, 1529 строк» (стр. 23) | `wc -l src/main/native/helper.m` → **1356** | расхождение (−173) |
| «(а) overlay.css повторяет ~24 переменные палитры из base.css 1:1» (стр. 55) | `overlay.css` объявляет **6** кастом-свойств (3 имени × 2 темы: `--panel`, `--panel-edge`, `--panel-drawing`); в `base.css` этих имён нет, значения расходятся (`--bg: rgba(28,29,34,.94)` vs `--panel: rgba(21,23,29,.94)`) | не подтверждено: ни «24», ни «1:1» |
| «(в) IPC-подписки в 5 точках без общего хука» (стр. 55) | 14 подписок в **6** файлах (см. §3) | расхождение: точек 6, а не 5 |
| «overlay.ts 1598 / App.tsx 1365 / settings/App.tsx 934 / overlay.css 764 / windows.ts 747» (стр. 15–16) | `wc -l` совпал по всем пяти | подтверждено |

## 5. Карта `src/main/windows.ts` (747 строк, T04)

### 5.1 Границы секций

| Строки | Что | Ответственность |
|---|---|---|
| 1–9 | шапка + импорты | `node:path`, `electron` (`app`, `BrowserWindow`, `screen`, `shell`), **только тип** `OverlayHost` из `./overlay` |
| 11–60 | геометрия | `OVERLAY_WIDTH` 360, `OVERLAY_NARROW_WIDTH` 112, `OVERLAY_MIN_WIDTH` 44, `OVERLAY_VOICE_WIDTH` 80, `OVERLAY_MIN_HEIGHT` 31, `OVERLAY_MAX_HEIGHT` 520, `GAP` 10, `MARGIN` 8 |
| 62–72 | загрузка страниц | `preload` (путь), `load(win, page)` (dev: `ELECTRON_RENDERER_URL`, prod: `../renderer/<page>/index.html`), `clamp` |
| 74–113 | состояние overlay + хром | флаги `overlayWindow`/`overlayVisible`/`overlayReady`/`drawing`/`voice`; `applyWindowChrome()` — единственное место, где `vibrancy`/`hasShadow` выводятся из флагов |
| 115–203 | создание окна | `createOverlayWindow()`: опции, permission-хендлеры (`media` только здесь), `closed` (сброс состояния), `setWindowOpenHandler`, `ready-to-show` → `pendingShow` |
| 204–297 | размещение | `BubbleAnchor` (point/area/x/above/right), `roomAround`, `placeAnchor` (вниз-вправо, флип у краёв), `xFor`, `yFor`, `positionOverlay` |
| 299–357 | изменение размера | `resizeAtAnchor()`: пересчёт от запомненного якоря, ветка `dragged` (пользователь перетащил) vs anchored |
| 359–454 | показ | `pendingShow`, `performShow()` (размер уже видимой карточки не перебивается), `presentOverlay()` (clamp + создание + гейт `overlayReady`) |
| 456–589 | порт | `overlayHost: OverlayHost` — 9 методов, см. §5.2 |
| 591–597 | флаг | `passthrough` |
| 599–622 | окна-спутники | `settingsWindow`, `onboardingWindow`, `baseOptions()` (980×760-база, `hiddenInset`, `#0f1115`, webPreferences) |
| 624–681 | settings | `openSettingsWindow()`: singleton, грейс-период на `close` (см. §5.3) |
| 683–705 | onboarding | `openOnboardingWindow()`: singleton, `resizable:false` |
| 707–713 | закрытие | `closeOnboardingWindow`, `closeSettingsWindow` |
| 715–724 | закрытие с ожиданием | `closeSettingsWindowWhenSettled()` — **тонкая обёртка** над `closeSettingsWindow()` |
| 726–731 | флаг занятости | `markSettingsBusy`, `let settingsBusy` |
| 733–747 | реактивация | `showActiveWindow()`: overlay → settings → onboarding, первое видимое |

### 5.2 `OverlayHost` — единственный канал «overlay.ts → окно»

Реализация в `windows.ts:456–589`; интерфейс объявлен в `overlay.ts:46`. Зависимость **только типовая**
(`import type`), поэтому цикла модулей нет.

| Метод | Строки | Дефолты | Что делает |
|---|---|---|---|
| `prewarm()` | 467 | — | создаёт окно, не показывает (idempotent) |
| `show(h, w?)` | 472 | `w = 112` | `presentOverlay(..., activate=true)` |
| `showInactive(h, w?)` | 476 | `w = 112` | `presentOverlay(..., activate=false)` — для push-to-talk |
| `resize(h, w?)` | 480 | `w = 360` | clamp → `resizeAtAnchor`, ранний выход при совпадении bounds |
| `setDrawing(on)` | 503 | — | флаг → `applyWindowChrome()` |
| `setVoice(on)` | 515 | — | флаг → `applyWindowChrome()` |
| `setPassthrough(on)` | 534 | — | `setIgnoreMouseEvents(on,{forward:true})` + `setAlwaysOnTop(on,'floating')` + `blur()` при включении |
| `hide()` | 559 | — | сбрасывает `passthrough`, `alwaysOnTop`, `overlayVisible`, `pendingShow`, `anchor` |
| `window()` | 586 | — | `BrowserWindow \| null` (не уничтоженный) |

### 5.3 Разделяемое состояние (модульные `let`)

| Переменная | Строка | Пишут | Читают | Смысл |
|---|---|---|---|---|
| `overlayWindow` | 74 | 172, 439, 469 | везде | единственный экземпляр |
| `overlayVisible` | 75 | 387, 575 | 381, 386 | «на экране» |
| `overlayReady` | 85 | 173, 196 | 448 | «первая отрисовка была» — отдельно от видимости |
| `drawing` | 87 | 177, 505 | 111, 144 | тонкая карточка во время рисования |
| `voice` | 89 | 178, 517 | 112, 140, 144, 433 | голосовой турн: бары без нативного хрома |
| `anchor` | 232 | 290, 582 | 313, 317 | якорь размещения на время одного показа |
| `pendingShow` | 366 | 440, 449, 579, 197 | 197 | показ, ждущий первой отрисовки (последний выигрывает) |
| `passthrough` | 597 | 538, 563 | 400, 537, 562 | карточка прозрачна для мыши (идёт план агента) |
| `settingsWindow` / `onboardingWindow` | 599–600 | 636, 672, 691, 701 | 625, 684, 708, 712, 740 | singleton-окна |
| `settingsBusy` | 731 | 728, 673 | 653, 663 | незаписанные правки: закрытие ждёт |

**Грейс-период закрытия настроек** (652–670): `close`-хук; при `settingsBusy` — `preventDefault()`,
опрос каждые 80 мс до `deadline = Date.now() + 1200`, затем `win.close()`. Покрывает ⌘W и красный
светофор, не только кнопку «Закрыть».

### 5.4 Ответственности (кандидаты на разделение, без решения)

1. **Жизненный цикл overlay** (создание/prewarm/hide/destroy) — 74–203, 456–470, 559–588.
2. **Геометрия и якорь** (размещение у курсора, флип у краёв, детект перетаскивания) — 204–357, 480–488.
3. **Нативный хром как состояние** (drawing/voice/passthrough → vibrancy/shadow/alwaysOnTop/ignoreMouse) — 91–113, 503–557.
4. **Порт `OverlayHost`** — 456–589 (тонкий, без логики, кроме clamp).
5. **Окна-спутники** (settings/onboarding: singleton + грейс-период) — 599–731.
6. **Реактивация из tray** — 733–747.

Связаны состоянием: (1) и (3) делят флаги `drawing`/`voice`/`passthrough`; (2) держит `anchor`, который
сбрасывает (1) в `hide()`. Резать (1)–(3) можно только вместе с этими флагами.

## 6. Карта `src/renderer/overlay/App.tsx` (1365 строк, T04)

### 6.1 Границы секций

| Строки | Что |
|---|---|
| 1–13 | шапка: карточка, клавиши (Enter / ⌘⏎ / Esc / ⌘C) |
| 15–35 | импорты, `Failure`, `newRequestId()` |
| 37–103 | ширины и метрики: `NARROW_WIDTH` 112, `VOICE_WIDTH` 80, `FULL_WIDTH` 360, `CHROME_WIDTH`, `STOP_CHROME`, `CARET_SLACK`, `MAX_FIELD_HEIGHT` 84, `FIELD_FONT`, `clamp` |
| 105–129 | `measureLine()` + **модульный** `ruler` (единственное модульное состояние в renderer) |
| 131–139 | `REFINE_LABEL`, `REFINE_HINT` |
| 141–180 | `LiveThumb` — единственный дочерний компонент (прелоад нового data URL, чтобы миниатюра не мигала) |
| 182–306 | состояние `App()`: 13 `useState` + 18 `useRef` + зеркалирование в refs (301–305) |
| 307–371 | сессии: `resumePendingSend`, `reset` (новая сессия), `applyState` (та же сессия → не сбрасывать) |
| 373–411 | `onStream` — маршрутизация чанков по `requestId` |
| 413–468 | **подписки IPC** (6: `getState` + `onState`/`onPreparing`/`onContextUpdate`/`onStream`/`onAnnotations`/`onAgent`) + снятие |
| 470–477 | `typing` → `overlay:typing` |
| 479–501 | `useVoice()`; при `phase==='listening'` текущий запрос помечается игнорируемым и отменяется |
| 503–571 | производные: `listening`, `amp`, `hasAnswer`, `textWidth`, `wantsWide`, `chromeWidth`, `composedWidth`, `wrapped` |
| 573–596 | `widthRef`, `heldWidthRef`, `cardWidth` (голос → wide → busy(hold) → composed) |
| 598–639 | `ResizeObserver` → `overlay:resize`; повторный `report` на `focus` окна |
| 641–660 | `autosize()` поля ввода (кап 84) |
| 662–671 | скролл ответа вниз; авторазворот при `failure`/`setupNotice` |
| 673–729 | `send` (+ присвоение `sendRef.current` на 738) |
| 731–768 | `refine` |
| 770–785 | `toggleFlag`, `clearPointer` |
| 787–816 | `setAgentEnabled` |
| 818–843 | подписка `voice:transcript` (7-я) |
| 845–855 | `paste`, `copy` |
| 857–930 | глобальный `keydown`: политика Escape (`checking`/`arming`/`acting`), ⌘⏎, ⌘C, Enter |
| 932–934 | гейт `!voice.ready` → `null` |
| 936–958 | ветка `listening` — только бары (`data-voice`) |
| 960–1031 | `composer` (textarea) + ветка «сессии ещё нет» (с `reserve` под шеврон) |
| 1033–1063 | вывод из `state`: `showMeta`, `canPaste`, `agentOff`/`agentBlocked`/`agentNotice`, `actionAsk`, `hint`, `alert` |
| 1065–1364 | разметка: `bar` (stop, toggle) · ошибка голоса · `drawer` (meta+suggestions) · blocked/setupNotice/hint · предложение включить агента · панель агента · `failure`+«Повторить» · `answer` · `foot` (вставка / короче-длиннее-копировать) · `notice` |

### 6.2 Разделяемое внутреннее состояние

Всё в одной замыкающей области — границы между ответственностями проходят **через неё**.

| Ячейка | Строка | Роль |
|---|---|---|
| `stateRef` | 226 | императивное чтение сессии из `send`/`refine`/`toggleFlag` (вне рендера) |
| `promptRef` | 234 | текст поля для колбэков вне рендера |
| `sessionIdRef` | 312 | «новая сессия» vs «переотправка той же» — решает `reset`/`applyState` |
| `requestIdRef` / `ignoredRequestRef` | 239/246 | маршрутизация чанков; брошенный запрос не дописывает карточку |
| `replaceOnChunkRef` | 289 | refine: старый ответ держится до первого нового чанка |
| `heldWidthRef` / `widthRef` | 584/574 | непрерывность ширины через `send`; последняя отданная в main ширина |
| `pendingAutoSendRef` | 257 | транскрипт пришёл раньше сессии |
| `spokenPromptRef` | 299 | произнесённая фраза живёт в поле до первого чанка |
| `busyRef`/`modeRef`/`agentRef` | 237/238/236 | зеркала состояния для клавиатурного хендлера без переподписки |
| `rootNode`/`rootRef` | 286/287 | корень как **state**: при смене бары↔карточка React монтирует новый узел |
| `fontRef`/`fieldRef` | 269/270 | шрифт из живого элемента для `measureLine` |

### 6.3 Ответственности

A. **IPC/сессии** — 413–468, 307–371. B. **Стриминг ответа** — 373–411, 662–665.
C. **Отправка/refine** — 673–768. D. **Геометрия окна** — 573–660 (измерение, ширины, ResizeObserver).
E. **Голос** — 479–501, 818–843, 936–958. F. **Агент** — 456–458, 787–816, 1241–1297.
G. **Клавиатура** — 857–930. H. **Разметка/подсказки** — 960–1364.

`App()` — один компонент на ~1150 строк; ни одна из групп не изолирована, все читают `stateRef`,
`requestIdRef` и `busy`. Разделение (A)+(B)+(C) невозможно без выноса этих трёх ячеек.

## 7. Карта `src/renderer/settings/App.tsx` (934 строки, T04)

### 7.1 Границы секций

| Строки | Что |
|---|---|
| 1–11 | шапка: 6 разделов, «кнопки Сохранить нет» |
| 13–19 | импорты (`@shared/types`, `@shared/defaults`, `@shared/api`, `HotkeyField`, `AgentTab`, `VoiceTab`) |
| 21–30 | `Tab` (6 значений) + `TABS` (Модель/Поведение/Голос/Агент/Быстрые действия/Приватность) |
| 32–35 | `Banner` |
| 37–63 | `ApplyState` (`idle`/`pending`/`saving`/`saved`/`held`/`error`) + `HOLD_REASON` (5 текстов) |
| 65–78 | `holdReasonFor(draft, invalidBaseUrls)` — **чистая функция**, тестируема без DOM |
| 80–91 | состояние: `bundle`, `draft`, `tab`, `banner`, `applyState`, `keyInput`, `testing`, `apps`, `hotkeyError`, `loadError` |
| 93–112 | начальная загрузка: `settings.load()` (с `catch` → `loadError`) + `runningApps()` |
| 114–120 | `providerKeys` (useMemo по `bundle.keys`) |
| 122–138 | `patch`, `invalidBaseUrls`, `holdReason` |
| 140–213 | `writtenRef`, `failedRef`, **`flush(snapshot)`** — одна запись снапшота; обработка `hotkeyError` |
| 215–247 | авто-применение: дебаунс **450 мс**, ветки `idle`/`held`/`error`/`pending` |
| 249–259 | `settings.hold(applyState === 'pending' \|\| 'saving')` → `windows.ts: settingsBusy` |
| 261–268 | `unsaved(value)` |
| 270–303 | `writable(value)` — санитайз перед явной записью (пустые quickActions отбрасываются, поля в середине правки откатываются к тому, что на диске) |
| 305–314 | `closeWindow` |
| 316–335 | ⌘S = «записать сейчас, мимо дебаунса» |
| 337–368 | `saveKey` (testKey → setKey), `removeKey` |
| 370–377 | `addExcluded` |
| 379–403 | гейты: `loadError` → экран ошибки; нет `draft`/`bundle` → «Загрузка…»; `info`, `status`, `baseUrlError` |
| 405–822 | разметка: `sidebar` (навигация + бейджи хоткеев) и 6 вкладок |
| 433–589 | provider: провайдер, модель, base URL, ключ, температура/maxTokens, системный промпт |
| 591–664 | behavior: `HotkeyField`, 3 чекбокса, `screenshotMaxSide`/`screenshotQuality` |
| 666–675 | voice → `VoiceTab` |
| 677–698 | agent → `AgentTab` (вкл/выкл идёт **через `agent:set-enabled`**, мимо черновика) |
| 700–709 | actions → `QuickActionsEditor` |
| 711–809 | privacy: 3 `PermissionRow` + список исключений + предупреждение о Keychain |
| 811–819 | footer: `banner` или `ApplyStatus` + «Закрыть» |
| 825–850 | `ApplyStatus` — единственная замена кнопки «Сохранить» |
| 852–877 | `PermissionRow` |
| 879–934 | `QuickActionsEditor` |

### 7.2 Разделяемое состояние и инварианты

| Ячейка | Строка | Роль |
|---|---|---|
| `bundle` | 81 | **то, что на диске**; левая часть сравнения авто-применения |
| `draft` | 82 | **то, что на экране**; правая часть сравнения |
| `writtenRef` | 150 | последний записанный снапшот, verbatim — иначе нормализация стора даёт бесконечную перезапись каждые 450 мс |
| `failedRef` | 160 | снапшот, который уже упал — не повторять по таймеру |
| `applyState` | 85 | `pending`/`saving` → `settings:hold(true)` → `settingsBusy` → грейс-период закрытия |
| `invalidBaseUrls` | 126 | блокирует запись base URL (ошибка вместо молчаливой замены) |

**Сквозная цепочка записи** (её нельзя разрывать при рефакторинге):
`patch` → `draft` → эффект 222 → 450 мс → `flush` → `settings:save` → `bundle` + `writtenRef`
→ `applyState` → `settings:hold` → `markSettingsBusy` (`windows.ts:727`) → `close`-хук с грейс-периодом.

### 7.3 Ответственности

A. **Модель черновика** — 81–138, 261–303. B. **Запись и её состояния** — 140–259, 825–850.
C. **Ключи API** — 337–368, 510–541. D. **Права/исключения** — 370–377, 711–809.
E. **Разметка вкладок** — 405–822 (тонкая, состояние только читает). F. **Дочерние компоненты** — 825–934.

`App()` ≈ 750 строк, но почти всё — JSX вкладок (E); логика сосредоточена в (A)+(B) и уже вынесена
в чистые функции (`holdReasonFor`) и колбэки. Разделение по вкладкам — механическое, без смены поведения.

## 8. Сквозное по трём файлам (T04)

| Наблюдение | Где | Следствие |
|---|---|---|
| Ширины продублированы, общего источника нет | `windows.ts:22,23,47` ↔ `overlay/App.tsx:50,58,60` (112/80/360) | значения совпадают; `OVERLAY_MIN_WIDTH` 44 и `OVERLAY_MAX_HEIGHT` 520 в renderer не продублированы |
| `app.focus({steal:true})` в try/catch — 3 копии | `windows.ts:403,640,695` | кандидат в A3 |
| `setWindowOpenHandler` (только http(s) → `shell.openExternal`) — 2 копии в файле | `windows.ts:181,675` | плюс 3 копии вне файла (см. §1.8) |
| `load()` + 3 копии `loadPage()` | `windows.ts:64`, `pointer.ts:34`, `hud.ts:188`, `agent/cursor.ts:84` | уже зафиксировано в §2 |
| `let passthrough` (597) и `let settingsBusy` (731) объявлены **после** первых текстовых обращений (400, 653) | `windows.ts` | работает только потому, что читаются при вызове, а не при инициализации модуля — хрупко, но поведение верное |
| `closeSettingsWindowWhenSettled()` — синоним `closeSettingsWindow()` | `windows.ts:711,722` | ожидание живёт в `close`-хуке окна, у функции нет своей логики |
| `mode` в overlay читается только через `modeRef` (304) в разметке не участвует | `overlay/App.tsx:185` | не баг; при выносе отправки `mode` можно свести к ref |
| `ruler` — единственное модульное состояние в renderer | `overlay/App.tsx:129` | влияет на тестируемость `measureLine` (нужен мок canvas) |
| Оба `App.tsx` не имеют общего слоя с `main` кроме `@shared/*` и `window.smartCursor` | — | границы для Фазы 2 заданы: renderer ↔ main только через preload-контракт |
