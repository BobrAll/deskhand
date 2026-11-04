# Факты о проекте (разведка уже проведена; читай нужные разделы по grep)

## Стек
Electron 33.2.0, Node 24.3.0, TS 5.6.3 (strict, noUnused*, noImplicitOverride, isolatedModules,
moduleResolution bundler, ES2022), electron-vite 2.3.0 + Vite 5.4.10, alias @shared, React 18.3.1,
обычный CSS (7 файлов), electron-builder 25.1.8 (zip universal + dmg, identity null; extraResources:
smartcursor-helper, whisper-cli, trayTemplate*.png). Единственная runtime-зависимость: electron-store 8.2.0.
package.json: main=./out/main/index.js, build.files=["out/**/*","package.json"].
Скрипты: dev, build, preview, typecheck(+:node/:web), build:helper, build:whisper, pack, dist, test:gesture.
Git: один коммит, 120 файлов. out/, release/, корневой index.js — в .gitignore, не трекаются.
Корневой index.js (67 КБ) — устаревший локальный артефакт, ссылок на него нет.
resources/smartcursor-helper и whisper-cli не в git (собираются).

## Структура и размеры
44 модуля main (19 импортируют electron, 25 чистые), 75 TS/TSX всего. Крупнейшие: main/overlay.ts 1598,
renderer/overlay/App.tsx 1365, renderer/settings/App.tsx 934, renderer/overlay/overlay.css 764, main/windows.ts 747.
Fan-out: overlay.ts 18, main/index.ts 13, ipc.ts 12, agent/index.ts 7. Fan-in: native/helper.ts 10,
settings/store.ts 8, util.ts 5, llm/provider.ts 5.
Чистые (без electron): llm/*, agent/{protocol,plan,verdict,targeting,geometry,outline,keys}, annotations.ts,
prompt.ts, response.ts, util.ts, context/{activeApp,collect}, voice/{listen,index}, gesture/{listen,index}, settings/store.ts.
Циклов нет (madge). any/@ts-ignore/as unknown as — 0.

## helper (Obj-C, src/main/native/helper.m, 1529 строк)
runHelper() в native/helper.ts:57 — execFile(binary,args,{timeout,maxBuffer 8MB}), один процесс на вызов, ответ = один
JSON в stdout, аргументы argv (`type` — payload base64). Ошибка/невалидный JSON → null, вызывающий деградирует на osascript.
Долгоживущие: `watch [key|mouse]` (spawn+readline), `voice <keyCode> <flags> [swallow]` (CGEventTap),
`gesture <fingers> <holdMs>`. 20 команд: permissions, request-permissions, cursor, apps, front, copy, paste, activate,
voice, gesture, move, click, drag, scroll, key, type, probe, focused, watch, ping.
События: ready, press, release, cancel, reenabled, escape, mousemove, tap. Ошибки: {"ok":false,"error":"accessibility-denied"|
"tap-create-failed"|"bad-payload"|…}.

## Ответ LLM (осознанно НЕ JSON, prompt.ts:154)
Свободный текст со строчной разметкой: `@point arrow x y w h «label»`, `@click x y left «label»`, `@type`, `@key cmd+s`,
`@scroll 0 -420`, `@drag x1 y1 x2 y2`, `@wait 600`, `@look`, `@done «…»`.
Парсинг: response.ts (ResponseStream.push, построчно), agent/protocol.ts (parseAgentLine), annotations.ts (parseAnnotationLine).
Хвост, начинающийся с `@`, придерживается до `\n`. Строка без `@команда` → обычный текст. Строка распознана как маркер,
но с мусорными координатами → МОЛЧА проглатывается ([]). Лимиты: MAX_PLAN_STEPS=6, @type ≤4000 симв., @wait ≤10000 мс.

## Стриминг
LlmProvider.stream(): AsyncGenerator<{delta:string}>. llm/http.ts: readSse() (границы `\n\n`, комментарии `:` пропускаются),
toProviderError() (401/402/404/413/429/5xx → локализованный текст), toTransportError(). OpenAI и OpenRouter — один класс
OpenAIProvider (OpenRouter: другой baseUrl + HTTP-Referer/X-Title; конец по [DONE]). Anthropic — свой (system отдельным полем,
картинки как source, content_block_delta/text_delta, конец по message_stop, заголовки x-api-key + anthropic-version).
Поток: overlay.ts:~808 читает генератор → ResponseStream.push → paint() + emit(CH.overlay.stream). План исполняется после конца стрима.

## Хранилище
Два electron-store. `smart-cursor` → {settings: AppSettings} (provider, models, baseUrls, temperature, maxTokens, systemPrompt,
hotkey, captureScreenshotByDefault, screenshotMaxSide, screenshotQuality, quickActions[], excludedApps[],
launchAtLogin, onboardingCompleted, voice{…}, gestures{…}, agent{…}). `smart-cursor-secrets` → {secrets: Record<ProviderId,
"enc:<b64>"|"plain:<b64>">} через safeStorage. Миграций нет: normalizeSettings() (defaults.ts:~392) валидирует каждое поле с
fallback на дефолт (clamp, sanitize*); битый файл → пересоздание (clearInvalidConfig); полный отказ → memoryFallback.
Переименование ключа молча теряет значение — это поведение, фиксируется тестом.

## Renderer
6 окон: overlay, pointer, cursor, hud, settings, onboarding. Известные дубли: (а) overlay.css повторяет ~24 переменные палитры
из styles/base.css 1:1; (б) settings/App.tsx и onboarding/App.tsx повторяют цепочку провайдер→ключ→testKey→setKey→save;
(в) IPC-подписки в 5 точках без общего хука; (г) таблица клавиш agent/keys.ts ↔ voice/listen.ts (единственный клон jscpd, 37 строк).
Токены --cursor-*, --hud-* в cursor.css/hud.css — осознанные (docs/style.md), не унифицировать.

## Время и состояние (усложняет тесты)
Нет инжектируемых часов. setInterval слежения: agent/cursor.ts:262; setTimeout: agent/cursor.ts (171,310,373), hud.ts (268,362),
pointer.ts (118,230); pointer/draw.ts fade 240 мс; voice/listen.ts:~283 рестарт tap; overlay/useVoice.ts метр микрофона;
settings/App.tsx баннеры 2200/2600/3600; agent/index.ts кэш probe PROBE_FRESH_MS (~198); windows.ts:~660 polling до 1200 мс;
Promise-очереди: paste/clipboard.ts:~19, overlay.ts `painting` (~782); voice/whisper.ts:~182 tmpdir с Date.now().

## Среда
Права Accessibility/Screen Recording/Microphone выданы. Запуск приложения: `env -u ELECTRON_RUN_AS_NODE` + `--no-sandbox`.
Сеть для npx есть; madge и jscpd работали, knip и stryker не проверялись.
