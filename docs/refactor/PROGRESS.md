# PROGRESS
## Current
Фаза 0 закрыта (T01–T04), T10 закрыта: baseline снят в 01-baseline.md. T11–T17 закрыты: vitest поднят, 302 теста
в 10 файлах, `npm test` зелёный, typecheck/build не тронуты. Дальше: T18.
## Last commit
3171a2b test(agent): cover plan normalisation, verdict and targeting
## Log (одна строка на задачу: ID — hash — итог)
T01 — bd12743 — 56 каналов CH + `shell:open-external`: направление/payload/хендлер/потребитель; 6 окон с webPreferences и создателями; перепроверены 5 фактов CONTEXT.md.
T04 — f416865 — карты windows.ts (секции, `OverlayHost`, 10 модульных `let`, грейс-период), overlay/App.tsx (13 state + 18 ref, 7 подписок), settings/App.tsx (черновик↔диск, дебаунс 450 мс → `settings:hold` → грейс-период); сквозные дубли — в §8.
T02 — dcd00ba — 20 команд helper'а (argv/ответ/обёртка/вызывающий/fallback), 3 потока событий, тайминги и лимиты `probe`; побочный эффект `probe` — запись AXEnhancedUserInterface/AXManualAccessibility в целевое приложение; расхождения с CONTEXT.md — в §9.6.
T03 — f0d2d6a — карта overlay.ts (§10): 11 секций с номерами строк, `send` = 658 строк (41 % файла), 6 переменных замыкания с временем жизни и писателем/читателем, 5 инвариантов «на дисциплине вызовов»; `verify()` внутри `send` замыкается на 6 величин и мутирует 3.
T10 — 4c70051 — baseline: typecheck pass, build pass (1.03 с real, 680 КБ out/), `src/` 82 файла / 18 760 строк, jscpd 1.42 % (242 строки, 20 клонов), knip (с добавленным `knip.json`) — 2 unused files / 35 exports / 42 types; расхождение: заявленные «jscpd 0.22 %» невоспроизводимы — 01-baseline.md §4.
T11 — dfc6867 — vitest 2.1.9 + @vitest/coverage-v8 (devDeps), `vitest.config.ts` (env node, алиас `@shared`, include `src/**/*.test.ts`), скрипты `test`/`test:watch`/`test:coverage`; дымовой тест `shared/ipc.test.ts` на карту каналов; typecheck и build не задеты, `coverage/` уже в .gitignore.
T12 — fa3baaf — `response.ts`: 28 тестов; инвариант «любая нарезка → тот же результат» (по символу/по 2/по строке/целиком + 20 псевдослучайных нарезок на 13 входах), хвост `@po`/`@cl`, строка с `@` не командой, проглатывание мусора, CRLF/пустые строки, `«»`. Инвариант держится только для маркеров с колонки 0 — 2 расхождения закреплены как known bug (BUGS.md R1). Мутации: отключение удержания хвоста → 10 красных, отключение `parseAgentLine` → 8 красных.
T13 — ce27733 — `annotations.ts` 34 теста + `agent/protocol.ts` 41 тест: все маркеры и команды, проценты и мусорные координаты, лимиты 60/90/4000/10000/±2000, чистка label (`«»`, `""`, `''`, `()`, `[]`), `isDrawable`. Мутации лимитов (10000→20000, 90→120, 4000→5000) ловятся. Побочно: запятая-разделитель съедает десятичную запятую — в known bug.
T14 — 57fa9ec — `normalizeSettings()` 50 тестов: пустой/null/примитив/массив, частичные данные, лишние ключи отбрасываются, ПЕРЕИМЕНОВАННЫЙ ключ молча теряется (3 случая), все clamp'ы и `sanitize*`. Найдено: `normalizeSettings({})` НЕ равен `DEFAULT_SETTINGS` — `models` заполняется пустыми строками (см. Заметки).
T15 — 4addc4f — `settings/store.ts` 12 тестов (in-memory electron-store: битый файл → `clearInvalidConfig` → флаг recovered → memoryFallback, нечитаемый `get`, падение `set`) и `secrets.ts` 18 тестов (мок safeStorage: enc:/plain:, залоченный Keychain, пустой payload, `keyStatuses`). Мутации: `clearInvalidConfig:false` и снятый `trim` ключа ловятся.
T16 — e01cb65 — golden-снапшоты `prompt.ts`: 16 вариантов `buildRequest` (mode × act × image × язык) + `buildContinue`/`buildVerify`/`buildRefine`, плюс проверки блока контекста, порядка инструментов (@click до @point), лимитов 12000/8000 и заметок про историю/недоступное управление. Провайдер в промпт не входит (он в заголовках) — ось «провайдер» из T16 неприменима.
T17 — 3171a2b — `agent/plan.ts` + `verdict.ts` (33 теста) и `targeting.ts` (33 теста): лимиты 6/600, отключённые печать и клавиши (с приоритетом над мусорным шагом), координаты вне кадра, `@done`/`@look` обрывают план, «@done вместе с действиями — не пропуск»; в targeting — три правила (точка внутри / label / snap), conflict-путь, отбраковка нецелей. Мутации ловятся.
## Blocked
## Open questions
- РЕШЕНО (Александр, сессия T01): 6 неиспользуемых методов моста (`settings.validateHotkey`, `onboarding.close`, `quickActions.defaults`, `permissions.microphone`, `voice.micPermission`, `voice.requestMicPermission`) и канал `shell:open-external` разрешено удалить в A2. Удалять с grep-доказательствами по правилу 7, отдельными коммитами.
- T14: `normalizeSettings({})` возвращает `models: {openrouter:'', openai:'', anthropic:''}`, а не модели из `DEFAULT_SETTINGS`. Практически безопасно (`llm/index.ts:resolveModel` падает на `providerInfo().defaultModel`), но это единственный блок, который не совпадает с дефолтами. Тесты закрепляют как есть; менять — по твоему «ок».
## Заметки (посторонние находки)
- T03: `emit` в overlay.ts принимает `string`, а не ключ `CH` (`overlay.ts:287`) — единственная точка, где типобезопасность каналов теряется; поведение не менял.
- T03: `MAX_SHOT_AGE_MS` (`overlay.ts:400`) — единственная константа объявлена в теле контроллера, а не в блоке 114–169. Не баг, но при разрезании файла её место придётся выбирать.
- Расхождения с CONTEXT.md: helper.m 1356 строк (не 1529); overlay.css объявляет 6 кастом-свойств, ни одного общего имени с base.css (не «~24 1:1») — дедупликация (а) в A3 под вопросом; IPC-подписки в 6 файлах (не 5).
- `shell:open-external` (`ipc.ts:317`) — канал вне `CH`, в preload не экспортирован; по факту мёртвый (дублируется `setWindowOpenHandler` в 4 окнах). Кандидат в BUGS/A2, не удалял.
- `permissions:microphone` / `permissions:request-microphone` вызываются и напрямую, и через дубли в неймспейсе `voice` (`preload:111-112`).
- T04: `let passthrough` (`windows.ts:597`) и `let settingsBusy` (`windows.ts:731`) объявлены ниже первых обращений (`:400`, `:653`) — работает только потому, что читаются в вызовах; хрупко, но поведение верное. Не трогал.
- T04: `closeSettingsWindowWhenSettled()` (`windows.ts:722`) — синоним `closeSettingsWindow()`; вся логика ожидания в `close`-хуке окна. Кандидат в A2/A3.
- T04: `app.focus({steal:true})` в try/catch — 3 копии (`windows.ts:403,640,695`); `setWindowOpenHandler` — 2 копии в файле + 3 вне. Кандидат в A3.
- T04: ширины 112/80/360 продублированы в `windows.ts:22,23,47` и `overlay/App.tsx:50,58,60` (совпадают); `OVERLAY_MIN_WIDTH` 44 и `OVERLAY_MAX_HEIGHT` 520 в renderer не дублируются.
- T02: `ping` — единственная команда helper'а без обёртки в `native/helper.ts` и без единого вызова; `helperCursor()` экспортируется, но не вызывается никем. Оба — кандидаты в A2 (правило 7: не удалял).
- T02: `payload.error` не читает ни одна обёртка, кроме `voice`/`gesture`; «нет прав Accessibility» и «нет бинаря» для вызывающего неразличимы (оба → `null`/`false`). Поведение сохраняем, но при тестах helper'а (T22) это надо фиксировать.
- T02: `runHelper` возвращает `null` на любом `exit ≠ 0`, поэтому ошибки `missing-arguments`/`bad-arguments`/`unknown-command` (helper печатает JSON и делает `return 1`) до JS не доходят.
- T10: `knip` без конфига бесполезен (70 «unused files» = весь `src/`) — добавлен `knip.json` (коммит 45b8c34, по решению Александра).
- T12: `ResponseStream.finish()` прогоняет хвост через `consume()`, поэтому текст без перевода строки на конце получает `\n` — единственная асимметрия с `push()`. Зафиксировано тестом, не чинил.
- T13: разделитель `,` в `parseAnnotationLine`/`readPoint` срабатывает раньше `replace(',', '.')`, поэтому `@point 0,5 0,2` читается как `0`, `5`, `0`, `2`. Модель так не пишет, но это тихий баг разбора — закреплено тестом.
- T15: `patchSettings` при упавшем `set` возвращает новое значение, но `memoryFallback` не выставляется (он читается только когда стор не открылся), поэтому следующий `getSettings()` отдаёт старое. Известный баг, закреплён тестом.
- T16: `buildRefine` не передаёт `draw`/`act` — refine никогда не предлагает инструменты. Похоже на задуманное, но не задокументировано.
- T11: `vitest run` печатает предупреждение «CJS build of Vite's Node API is deprecated» — версия vite 5.4.10, обновлять по правилу 3 нельзя, на результат не влияет.
