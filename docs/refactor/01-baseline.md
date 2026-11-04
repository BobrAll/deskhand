# 01 — Baseline (T10)

Снимок «до». Всё измерено на рабочем дереве без правок кода.

- Дата: 2026-11-04
- Ветка: `refactor/baseline`
- HEAD: `960fadc` — docs(refactor): mark T03 done and update progress
- Окружение: macOS (darwin), Node v24.3.0, npm 11.4.2
- Инструменты: jscpd 4.3.0, knip 5.88.1 (`npx`, `npm_config_cache=/tmp/npm-cache`; в `devDependencies` не добавлялись)

## 1. Проверки

| Команда | Результат | Время |
| --- | --- | --- |
| `npm run typecheck` (`tsc --noEmit` × node + web) | **pass**, 0 ошибок | ~4 с |
| `npm run build` на пустом `out/` | **pass**, 47 + 2 + 59 модулей | **1.03 с** real (1.61 user, 0.20 sys) |

Разбивка сборки: main — 230 мс (47 модулей), preload — 11 мс (2 модуля), renderer — 372 мс (59 модулей).
Повторный прогон без очистки — 1.13 с: холодная и тёплая сборки неразличимы (Vite пересобирает всё).

Стоп-условие T10 не сработало: всё зелёное, вопросов нет.

## 2. Исходники: файлы и строки по директориям

`src/` — 82 файла, 18 760 строк (`*.ts`, `*.tsx`, `*.css`, `*.html`).
Расширения: 60 `.ts`, 9 `.tsx`, 7 `.css`, 6 `.html`.

| Директория | Файлов | Строк |
| --- | ---: | ---: |
| `src/main` (корень) | 14 | 4 729 |
| `src/main/agent` | 9 | 2 537 |
| `src/main/context` | 4 | 415 |
| `src/main/gesture` | 2 | 286 |
| `src/main/llm` | 7 | 551 |
| `src/main/native` (`*.ts`, без `helper.m`) | 1 | 413 |
| `src/main/paste` | 2 | 141 |
| `src/main/settings` | 2 | 160 |
| `src/main/voice` | 3 | 1 194 |
| **`src/main` итого** | **44** | **10 426** |
| `src/preload` | 2 | 129 |
| `src/renderer/cursor` | 4 | 416 |
| `src/renderer/hud` | 4 | 381 |
| `src/renderer/onboarding` | 4 | 491 |
| `src/renderer/overlay` | 6 | 2 670 |
| `src/renderer/pointer` | 4 | 404 |
| `src/renderer/settings` | 7 | 2 088 |
| `src/renderer/styles` | 1 | 205 |
| `src/renderer` (корень: `env.d.ts`) | 1 | 8 |
| **`src/renderer` итого** | **31** | **6 663** |
| `src/shared` | 5 | 1 542 |
| **Всего** | **82** | **18 760** |

Вне `src/`: `src/main/native/helper.m` — **1 356 строк** (Objective-C, собирается `scripts/build-helper.mjs`);
скрипты — `build-helper.mjs` 41, `build-whisper.mjs` 86, `test-gesture.mjs` 32 строки.
`index.js` в корне — 1 919 строк, **не отслеживается git** (в `.gitignore`, это собранный бандл) — см. A2.

### Крупнейшие файлы (кандидаты фазы A1)

| Строк | Файл |
| ---: | --- |
| 1 598 | `src/main/overlay.ts` |
| 1 365 | `src/renderer/overlay/App.tsx` |
| 934 | `src/renderer/settings/App.tsx` |
| 764 | `src/renderer/overlay/overlay.css` |
| 747 | `src/main/windows.ts` |
| 643 | `src/shared/types.ts` |
| 625 | `src/main/agent/targeting.ts` |
| 603 | `src/main/agent/index.ts` |
| 578 | `src/main/prompt.ts` |
| 520 | `src/main/voice/index.ts` |

Пять крупнейших файлов — 5 408 строк, 29 % всего `src/`.

## 3. Бандлы `out/`

`out/` — 24 файла, **680 КБ**. main 228 КБ, preload 12 КБ, renderer 440 КБ.

| Байт | Файл |
| ---: | --- |
| 231 148 | `out/main/index.js` |
| 214 055 | `out/renderer/assets/client-GSw2dXbr.js` (React + общий чанк) |
| 57 149 | `out/renderer/assets/settings-qL4IJe1d.js` |
| 40 148 | `out/renderer/assets/overlay-XxAr50e9.js` |
| 18 396 | `out/renderer/assets/overlay-ZaY1bNK_.css` |
| 12 867 | `out/renderer/assets/onboarding-BgpKQbjC.js` |
| 11 661 | `out/preload/index.js` |
| 8 025 | `out/renderer/assets/settings-Amlg7Dcg.css` |
| 7 525 | `out/renderer/assets/HotkeyField-nBOaEwgJ.js` |
| 6 580 | `out/renderer/assets/hud-D5_IbXIi.css` |
| 6 342 | `out/renderer/assets/cursor-BFmrOffF.css` |
| 5 736 | `out/renderer/assets/pointer-1cyYgDNq.js` |
| 4 982 | `out/renderer/assets/recorder-Bv_Zo8l9.js` |
| 4 270 | `out/renderer/assets/base-DSCr6hc4.css` |
| 3 209 | `out/renderer/assets/pointer-DS-Uu2Xm.css` |
| 2 976 | `out/renderer/assets/cursor-DGlo1skm.js` |
| 2 756 | `out/renderer/assets/onboarding-C_lodRzN.css` |
| 2 400 | `out/renderer/assets/hud-lKd8bsVD.js` |
| 586–775 × 6 | `out/renderer/{cursor,hud,overlay,pointer,onboarding,settings}/index.html` |

Renderer JS суммарно 347 838 Б, CSS — 49 578 Б. `client-*.js` — 62 % JS рендерера, из него ~61 % React runtime.

`out/` в `.gitignore`; хеши в именах ассетов меняются от сборки к сборке, поэтому для сравнения «до/после» (F1)
годится сумма по файлу, а не имя.

## 4. jscpd (дубли)

Базовая команда: `npx jscpd@4 src` (по умолчанию: min-tokens 50, min-lines 5).

| Формат | Файлов | Строк | Клонов | Дубль-строк |
| --- | ---: | ---: | ---: | ---: |
| css | 7 | 2 218 | 1 | 11 (0.5 %) |
| tsx | 8 | 1 899 | 1 | 5 (0.26 %) |
| javascript | 11 | 998 | 0 | 0 |
| markup | 6 | 96 | 6 | 50 (52.08 %) |
| typescript | 60 | 11 883 | 12 | 176 (1.48 %) |
| **Итого** | **92** | **17 096** | **20** | **242 (1.42 %)**, 2 220 токенов (1.7 %) |

`markup` — шесть почти одинаковых `renderer/*/index.html` (CSP + `<div id="root">`): структурный дубль, не копипаста.

Клоны в TS/TSX (12): `voice/listen.ts` ×4 (крупнейший — 37 строк / 258 токенов, пара с `agent/keys.ts`,
тот самый единственный клон из CONTEXT.md), `gesture/listen.ts` ×3, `agent/keys.ts` ×2, `pointer.ts` ×2,
`hud.ts` ↔ `agent/cursor.ts`, `annotations.ts` ↔ `agent/protocol.ts`, `llm/anthropic.ts`,
`context/screenshot.ts`, `renderer/pointer/draw.ts`, `renderer/settings/App.tsx`.

**Расхождение с RULES/CONTEXT**: там заявлено «jscpd 0.22 %», по факту при дефолтном конфиге — **1.42 %**.
Конфига `.jscpd.json` в репозитории нет, поэтому 0.22 % невоспроизводимо (вероятно, мерили с другим `--min-tokens`).
Для F1 фиксирую эталон **1.42 % / 242 строки** при дефолтном конфиге: любое уменьшение — улучшение.

## 5. knip

**Без конфига (`npx knip@5`) результат непригоден**: 70 «unused files» — это все файлы `src/`, включая
`src/main/index.ts`, плюс `electron.vite.config.ts`. Knip не знает entry points: их задают `electron.vite.config.ts`
(main/preload) и шесть `src/renderer/*/index.html`, а конфиг knip не парсит. Плюс 5 ложных «unused devDependencies»
(`react`, `react-dom`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`) — они используются в `.tsx`.
Файл `knip.json` в репозиторий не добавлял (в задаче его нет) — **вопрос к тебе**, нужен ли он как постоянный инструмент.

**С временным конфигом** (entry: `electron.vite.config.ts`, `src/main/index.ts`, `src/preload/index.ts`,
6 × `src/renderer/*/index.html` + `main.ts*`, `scripts/*.mjs`; project: `src/**/*.{ts,tsx,css}`):

- **unused files — 2**: `src/preload/index.d.ts`, `src/renderer/env.d.ts`. Оба — декларации типов,
  на них ссылается `tsconfig`; удалять нельзя (исключение для knip).
- **unused exports — 19** (снимок для A2; требует ручной проверки по правилу 7):
  `agent/geometry.ts:toFramePoint`, `agent/outline.ts:formatOutline`, `agent/plan.ts:MAX_PLAN_STEPS`,
  `agent/plan.ts:MAX_TYPE_CHARS`, `agent/targeting.ts:centerOf`, `agent/targeting.ts:normalizeText`,
  `agent/targeting.ts:textMatchScore`, `annotations.ts:AnnotationStream`, `context/screenshot.ts:dataUrlToFile`,
  `context/selection.ts:MAX_SELECTION_CHARS`, `hotkey.ts:currentHotkey`, `native/helper.ts:helperCursor`,
  `permissions.ts:openMicrophonePane`, `pointer.ts:isPointerVisible`, `prompt.ts:MAX_SELECTION_CHARS`,
  `prompt.ts:MAX_ANSWER_CHARS`, `settings/store.ts:settingsWereRecovered`, `util.ts:errorMessage`,
  `voice/listen.ts:parseAccelerator`, `voice/whisper.ts:{modelsDir,resolveBinary,installedModels,resolveModel,isDownloading}`,
  `windows.ts:{OVERLAY_WIDTH,OVERLAY_NARROW_WIDTH,OVERLAY_VOICE_WIDTH,OVERLAY_MIN_HEIGHT,OVERLAY_MAX_HEIGHT,closeSettingsWindow}`,
  `renderer/settings/HotkeyField.tsx:toAccelerator`, `shared/defaults.ts:{DEFAULT_EXCLUDED_APPS,DEFAULT_VOICE,DEFAULT_GESTURES,DEFAULT_AGENT}`.
- **unused exported types — 29**: в основном `*Options`/`*Host` для внедрения зависимостей; для тестов T11–T32
  они понадобятся — не трогать до появления тестов.
- unlisted / unresolved dependencies — **0**.

Пересечения с PROGRESS подтверждают прежние заметки: `helperCursor` (T02) и `closeSettingsWindow` (T04) уже
отмечены как кандидаты в A2; экспортируемые `OVERLAY_*` из `windows.ts` подтверждают дублирование ширин (T04).

## 6. Прочее состояние дерева

- `0` вхождений `any` в `src/` (грубый `grep`), как заявлено в RULES п. 8.
- Тестового раннера нет: vitest в `devDependencies` отсутствует, скриптов `test`/`test:watch` в `package.json` нет
  (есть только `test:gesture`) — это вход в T11.
- `release/` — 782 МБ локально (2 артефакта от 2026-11-02), в `.gitignore`; для F1 не эталон.
- `node_modules/` — 589 МБ.
- Бинари на месте: `resources/smartcursor-helper` (144 816 Б), `resources/whisper-cli` (3 885 512 Б); оба в `.gitignore`.
- Git: 126 отслеживаемых файлов, из них 84 в `src/`.

## 7. Команды для воспроизведения

```
npm run typecheck
npm run build            # предварительно очистить out/
find src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.html' \) -exec wc -l {} +
npm_config_cache=/tmp/npm-cache npx --yes jscpd@4 src
npm_config_cache=/tmp/npm-cache npx --yes knip@5        # без конфига — шум, см. §5
```
