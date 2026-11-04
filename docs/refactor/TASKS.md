# Очередь задач. Одна сессия = одна задача. `[x]` ставит агент после коммита.
Каждая тест-задача: тесты зелёные на НЕизменённом коде; в конце — быстрая «мутация» 2–3 ключевых строк
(сломал → тест красный → откатил) без отдельных отчётов; в PROGRESS.md — одна строка.

## Фаза 0 — документы (без правок кода)
- [x] T01 IPC-таблица: канал → направление → payload → хендлер → потребитель (+ webPreferences и создатель каждого из 6 окон)
      → docs/refactor/00-inventory.md (раздел IPC/окна). Выборочно перепроверь 3–4 факта из CONTEXT.md, расхождения — в PROGRESS.
- [x] T02 Таблица helper-контракта: команда → argv → формат ответа → кто вызывает → fallback → 00-inventory.md. Прочитай `probe` в helper.m
      на побочные эффекты и запиши вывод.
- [x] T03 Карта overlay.ts: ответственности, границы секций (строки), разделяемое внутреннее состояние → 00-inventory.md.
- [x] T04 Карты windows.ts, renderer/overlay/App.tsx, renderer/settings/App.tsx — так же → 00-inventory.md.

## Фаза 1 — базовая линия и тесты
- [x] T10 Baseline: `typecheck`, чистый `build`, метрики (файлы/строки по директориям, размеры бандлов, время сборки, jscpd, knip),
      список файлов и размеров `out/` → 01-baseline.md. Если что-то не проходит — стоп и вопрос мне.
- [x] T11 Vitest (devDep), конфиг с алиасом @shared, env node, скрипты test/test:watch/test:coverage; тесты не ломают typecheck/build.
      Один дымовой тест. Один коммит `chore: add vitest`.
- [x] T12 Тесты response.ts (ResponseStream): хвост `@po`/`@cl` на границе чанков, строка с `@` но не командой, проглатывание мусорных
      координат, CRLF/пустые строки, `«»`. ИНВАРИАНТ: любая нарезка на чанки (по символу, по 2, по строкам, целиком) → идентичный результат.
- [x] T13 Тесты agent/protocol.ts + annotations.ts: все команды, процентные/мусорные числа, лимиты 6/4000/10000, label.
- [x] T14 Тесты normalizeSettings(): пустой/null/не-объект, частичные данные, лишние ключи, ПЕРЕИМЕНОВАННЫЙ ключ (значение теряется —
      закрепить), clamp, мусорные массивы (quickActions, excludedApps), невалидный provider, вложенные voice/gestures/agent.
- [x] T15 Тесты settings/store.ts (битый файл → пересоздание, memoryFallback) и secrets.ts (мок safeStorage: enc:/plain:, залоченный Keychain,
      нет ключа). Только in-memory/tmp, без реальных данных.
- [x] T16 Golden-снапшоты prompt.ts по матрице: провайдер × агент вкл/выкл × скриншот есть/нет × язык × quickAction.
- [x] T17 Тесты agent/plan.ts (normalizePlan, лимиты), verdict.ts («нельзя верить @done вместе с действиями»), targeting.ts.
- [x] T18 Тесты agent/geometry.ts, outline.ts, keys.ts; shared/ (intent, defaults, guard'ы); СНАПШОТ набора IPC-каналов.
- [x] T19 Тесты llm/http.ts: readSse (чанки посреди события, комментарии `:`), toProviderError (401/402/404/413/429/5xx → точные тексты),
      toTransportError, abort/таймаут. fetch — мок с SSE-фикстурами.
- [x] T20 Тесты OpenAIProvider и OpenRouter: URL, заголовки, golden тела запроса, [DONE], невалидный JSON; OpenRouter = OpenAI + 2 заголовка.
- [x] T21 Тесты Anthropic: system отдельно, картинки как source, text_delta, message_stop, заголовки, ошибки.
- [x] T22 Тесты native/helper.ts: runHelper на моке execFile (успех, невалидный JSON → null, таймаут, maxBuffer, base64 для `type`),
      парсинг строк `watch`.
- [x] T23 Тесты context/{collect,selection,activeApp} на моке helper'а, включая деградацию на osascript. Busy-loop — мок.
- [x] T24 Тесты paste/clipboard.ts: ПОРЯДОК вызовов (сохранить → записать → Cmd+V → восстановить), Promise-очередь, fallback.
- [x] T25 Тесты voice/listen.ts (парсинг событий, рестарт tap) и voice/whisper.ts (аргументы, разбор вывода; child_process мок).
- [x] T26 Тесты voice/index.ts (стейт-машина: press → запись → release → whisper → вставка, Escape-cancel, reenabled) и gesture/*.
- [x] T27 Тесты agent/index.ts и agent/cursor.ts на fake helper'е: план → выполнение → @look → верификация → «Готово», кэш probe,
      abort при движении мыши. Fake timers аккуратно.
- [x] T28 Шов для сквозного сценария №1: найди в overlay.ts логику «стрим → ResponseStream → paint/emit» и, если её нельзя тестировать
      как есть, вынеси ДОСЛОВНЫМ переносом (отдельный коммит `refactor(seam)`), затем тест с фейковым провайдером. Не получилось за
      разумное число шагов → стоп и вопрос.
- [x] T29 Тесты IPC: у каждого канала есть хендлер (мок ipcMain); снапшот набора методов preload против api.ts.
- [x] T30 Тест палитры CSS: зафиксировать итоговые значения CSS-переменных светлой/тёмной тем для каждого окна (страховка дедупликации).
- [x] T31 Отдельный скрипт `test:native`: контракт helper'а только на ping/permissions/front/apps/cursor (macOS, не входит в `test`).
- [x] T32 Тесты отделимой логики hotkey/permissions/tray/hud/pointer (только состояния, расчёты, решения). Окна не создавать.
- [x] T33 Сквозная проверка качества: для P0-модулей убедись, что мутации ловятся; Stryker — только если ставится быстро (иначе пропусти).
- [x] T34 MANUAL_SMOKE.md (пошагово с ожидаемым результатом: onboarding, права, хоткей, 3+ приложения, поток в overlay, @point/@click,
      агентный сценарий, вставка, push-to-talk, Escape, жесты, смена провайдера/testKey, сохранение настроек, tray, обе темы, hud/pointer/cursor)
      и 02-test-plan.md (что покрыто, что нет и почему).
- [x] T35 [STOP] Контрольная точка №1. Сводка для меня: baseline, список тестов, BUGS.md, вопросы. Жди, пока я прогоню MANUAL_SMOKE.md.
      Сводка выдана в PROGRESS.md; Александр прогнал MANUAL_SMOKE (три дефекта → BUGS R5–R7) и ответил на все
      4 вопроса («РЕШЕНО… сессия T35»). Починка R5–R7 ждёт отдельного «ок» — в задачи не берётся.

## Фаза 2 — аудит (только чтение, итог в 03-audit.md; формат пункта: файл:строки · проблема · доказательство · риск · покрыто тестами?)
- [x] A1 Крупные модули: overlay.ts, windows.ts, оба App.tsx — независимые ответственности, что выносимо без смены поведения,
      что связано состоянием и резать нельзя. → `03-audit.md` A1.0–A1.7 (коммит 1c35276)
- [x] A2 Мусор: knip/depcheck/ts-prune + ручная проверка по правилу 7; оценить `test:gesture`; корневой index.js (удалить с диска).
      Уже согласовано к удалению (решение T01 + T35): 6 неиспользуемых методов моста и канал `shell:open-external`;
      окно `hud` целиком (411 строк + 20 тестов, `update()` без вызовов); `AnnotationStream` из `annotations.ts`.
      Отдельно решить: `hideOverlayOnBlur` — дореализовать (`on('blur')` в `windows.ts`) или убрать тик (BUGS R4).
- [x] A3 Дубли (проверить каждое из известных а–г + повтор helper/osascript + создание окон): оправдан ли вынос
      → `03-audit.md` A3.0–A3.11 (коммит 436cfe8).
- [x] A4 Архитектура и гигиена: логика внутри Electron-обвязки, глобальное состояние, расхождения ipc.ts/preload/хендлеры, обработка
      ошибок; helper.m — только анализ; минимальный ESLint+Prettier (предложение, решаю я).
      → `03-audit.md` A4.0–A4.8 (коммит f35b082). Проводка IPC образцовая (50/37/13, расхождений 0), слои чистые,
      циклов нет; 8 мелких дефектов гигиены + 4 долга (overlay.ts, геометрия пузыря, разнос windows.ts, ESLint);
      5 вопросов — в PROGRESS «Open questions».

## Фаза 3 — план
- [x] P1 04-refactor-plan.md: целевая структура и правила зависимостей, решения (проблема/варианты/выбор/цена), упорядоченные шаги
      (цель, файлы, страхующие тесты, критерий, риск, откат), порядок: механическое → дедупликация → вынос из крупных → git mv →
      рискованное в конце; контрольные точки; честные метрики; список «нужно подтверждение». Каждый шаг плана оформи
      ОТДЕЛЬНОЙ задачей R01, R02… в TASKS.md (одна сессия каждая).
- [x] P2 [STOP] Жди утверждения плана. Без него код не трогать.
      → 11cc70c: утверждение Александром уже записано в PROGRESS.md Current; статус плана синхронизирован.

## Фаза 4 — выполнение: R01…R21 (подробности — 04-refactor-plan.md §3). Каждая: тесты есть и зелёные → минимальное изменение →
typecheck/test/build → коммит → PROGRESS. После крупных групп — [STOP] на мой MANUAL_SMOKE (план §4).

### Волна 1 — механическое (КТ1 после R05)
- [x] R01 Гигиена `main/`: `PROVIDER_IDS` из `PROVIDERS` + снять `void PROVIDERS` (ipc.ts:42,298), `Number.isFinite` в `clamp`
      (windows.ts:70), `let settingsBusy` выше пользователя, снять синоним `closeSettingsWindowWhenSettled` (+ ipc.ts:203),
      пробелы в index.ts:87. Поведение не меняется. → fa8b283. A4.8 #1 и #8 не вошли (правки поведения, ждут вопроса 4).
- [x] R02 Контракт `hotkeyError`: поле в `SettingsBundle` (shared/api.ts), убрать приведение в settings/App.tsx:178. → fb0d190
- [x] R03 `main/pageLoad.ts`: три копии «dev ? loadURL : loadFile» (windows.ts:64, pointer.ts:34, cursor.ts:83) → одна функция. → 6bf9dab
- [x] R04 `main/denyExternalLinks.ts`: четыре копии `setWindowOpenHandler` → одна, флаг `/i` остаётся параметром (без унификации). → 7782649
- [x] R05 Внутрифайловые дубли: `imagePart()` вместо трёх regex (overlay.ts:960,1181,1360) и `resolveArea()` вместо второго
      блока `bounds → area` (screenshot.ts:234-244). Два коммита. → a8a6cb8 + 5c39196 (вынесен `areaFromBounds`, не
      `resolveArea`: при `fullDisplay: true` он вернул бы область дисплея вместо `bounds`).

### Волна 2 — дедупликация данных и окон (КТ2 после R09)
- [x] R06 `shared/keycodes.ts`: ТОЛЬКО данные. `KEY_CODES` 64 и отдельная `VOICE_KEY_CODES` 62 (без `esc`/`forwarddelete` —
      иначе они станут валидными хоткеями), `FUNCTION_CODES` 20 на всех. `MODIFIER_FLAGS` не сливать. Парсеры не трогать. → 3a83524 (фактические размеры — 64 и 62, не 64/62 из аудита: сверено скриптом)
- [x] R07 `shared/metrics.ts`: ширины 360/112/80 — один источник для windows.ts и overlay/App.tsx; страж-тест на возврат литерала. → 81e1fdf
- [x] R08 `main/layerWindow.ts`: окна-слои pointer+cursor (20 из 23 строк совпадают); `acceptFirstMouse` — параметр.
      → 7940fa7 (различия — параметры: `acceptFirstMouse`, `caseless`, `onClosed`; +8 тестов, 3 мутации ловятся)
- [x] R09 `main/native/tapListener.ts`: общий слушатель CGEventTap для voice/gesture; различия (launch/args/тексты/stop) сохранить
      дословно, тесты `listen.test.ts` ×2 не менять. → c3b10cb (оба тест-файла зелёные без правок; R2 переехал в общий класс)

### Волна 3 — вынос из крупных, main (КТ3 после R12)
- [x] R10 `main/bubble.ts`: геометрия пузыря (clamp/roomAround/placeAnchor/xFor/yFor/positionOverlay/resizeAtAnchor,
      windows.ts:204-357) чистыми функциями + тест без Electron. → 7d601e1 (26 тестов, `windows.ts` −151 строка)
- [x] R11 `main/overlay/request.ts`: сборка запроса (overlay.ts:825-1036, 212 строк) с двумя колбэками вместо await;
      доказательство — `prompt.test.ts` зелёный без правки снапшотов. → 9ab9769 (17 тестов, снапшоты не сдвинулись)
- [x] R12 `main/overlay/verify.ts`: `verify()` (overlay.ts:1286-1444, 159 строк), вход 11 полей, выход 3 значений. Риск высокий.
      → eafb799 + 89159ed (20 тестов, `held`/`suppressed` остались в `send`, `overlay.ts` 1463 → 1303 строки)

### Волна 4 — вынос из крупных, renderer (КТ4 после R17; только чистые модули, jsdom нет)
- [x] R13 `overlay/metrics.ts` + `overlay/viewFlags.ts`: константы размеров и `deriveView()` — чистые выражения.
      → ae6ab18 + 3bca0cb + dda9380 (10 + 18 тестов; страж R07 переадресован на новый модуль)
- [x] R14 `overlay/keyPolicy.ts`: политика клавиш (Escape ×3, ⌘⏎, ⌘C, Enter). ОБА обработчика Enter сохранить.
      → eb32169 (18 тестов; оба вызова `keyPolicy` на месте — A1.7 соблюдён)
- [x] R15 `overlay/streamRouting.ts`: маршрутизация чанков по requestId; refs остаются в App.
      → e44f1d0 (14 тестов; refs не переезжали)
- [x] R16 `settings/applyGate.ts`: `holdReasonFor`/`unsaved`/`writable` + одна пара границ вместо трёх копий 64…8192.
      → b0080ac (26 тестов; литералов 64/8192 в `App.tsx` не осталось)
- [x] R17 `settings/{ApplyStatus,PermissionRow,QuickActionsEditor}.tsx`: перенос один-в-один, пропсы не меняются.
      → 82110fd (8 тестов; **критерий «≤520 строк» не выполнен**: 762 строки — см. PROGRESS, остаток ниже)
- [x] R17-остаток `settings/App.tsx` 762 строки: шесть секций JSX (`:381-760`) → `sections/*.tsx`. Только после КТ4.
      → a078ef3 (четыре файла в `sections/`, `App.tsx` 762 → 456; `VoiceTab`/`AgentTab` уже были компонентами
      и остались вызовами в `App` — обёртка на три строки была бы файлом ради файла)

### Волна 5 — структура (КТ5 после R19)
- [x] R18 `git mv main/overlay.ts → main/overlay/index.ts` + вынос `OverlayHost` в `overlay/host.ts`. Два коммита (правило 5).
      → 0ded440 (перенос + 19 строк импортов; `windows.ts`/`ipc.ts`/`index.ts` правок не потребовали —
      каталог резолвится как модуль) + 3523a7d (`host.ts`; `windows.ts` импортирует тип из него, а не из контроллера)

### Волна 6 — рискованное (КТ6 после R21)
- [x] R19 Разнос `windows.ts`: `windows/index.ts` (карточка) + `windows/settings.ts` (настройки/онбординг) + `base.ts`. Высокий риск.
      → 83c8fcc + a749c46; 6 тестов жизненного цикла, 54 файла / 1145 тестов. КТ5: ручной прогон ожидается.
- [ ] R20 Остаток `send`: агентные раунды (overlay/index.ts:1038-1218) → `overlay/rounds.ts`. Только после R11/R12, риск высокий.
- [ ] R21 ESLint 9 + `typescript-eslint` 8 + `.editorconfig` + скрипт `lint` (ждёт «ок»). Prettier — после фазы 5 отдельным `style:`.

## Фаза 5 — приёмка
- [ ] F1 Сравнить out/ и extraResources с baseline, снапшоты без диффов; 05-report.md (метрики до/после, что удалено/объединено/
      разбито, что не покрыто, открытые баги, что не трогал и почему). [STOP] Финальный прогон MANUAL_SMOKE — мной.
