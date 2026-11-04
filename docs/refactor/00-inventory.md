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
