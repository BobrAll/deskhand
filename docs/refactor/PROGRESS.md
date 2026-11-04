# PROGRESS
## Current
Фаза 0 закрыта (T01–T04), T10 закрыта: baseline снят в 01-baseline.md. Дальше: T11 (vitest).
## Last commit
4c70051 docs(refactor): record baseline metrics, bundles and duplication
## Log (одна строка на задачу: ID — hash — итог)
T01 — bd12743 — 56 каналов CH + `shell:open-external`: направление/payload/хендлер/потребитель; 6 окон с webPreferences и создателями; перепроверены 5 фактов CONTEXT.md.
T04 — f416865 — карты windows.ts (секции, `OverlayHost`, 10 модульных `let`, грейс-период), overlay/App.tsx (13 state + 18 ref, 7 подписок), settings/App.tsx (черновик↔диск, дебаунс 450 мс → `settings:hold` → грейс-период); сквозные дубли — в §8.
T02 — dcd00ba — 20 команд helper'а (argv/ответ/обёртка/вызывающий/fallback), 3 потока событий, тайминги и лимиты `probe`; побочный эффект `probe` — запись AXEnhancedUserInterface/AXManualAccessibility в целевое приложение; расхождения с CONTEXT.md — в §9.6.
T03 — f0d2d6a — карта overlay.ts (§10): 11 секций с номерами строк, `send` = 658 строк (41 % файла), 6 переменных замыкания с временем жизни и писателем/читателем, 5 инвариантов «на дисциплине вызовов»; `verify()` внутри `send` замыкается на 6 величин и мутирует 3.
T10 — 4c70051 — baseline: typecheck pass, build pass (1.03 с real, 680 КБ out/), `src/` 82 файла / 18 760 строк, jscpd 1.42 % (242 строки, 20 клонов), knip с конфигом — 2 unused files / 19 exports / 29 types; расхождение: заявленные «jscpd 0.22 %» невоспроизводимы — 01-baseline.md §4.
## Blocked
## Open questions
- РЕШЕНО (Александр, сессия T01): 6 неиспользуемых методов моста (`settings.validateHotkey`, `onboarding.close`, `quickActions.defaults`, `permissions.microphone`, `voice.micPermission`, `voice.requestMicPermission`) и канал `shell:open-external` разрешено удалить в A2. Удалять с grep-доказательствами по правилу 7, отдельными коммитами.
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
- T10: `knip` без конфига бесполезен (70 «unused files» = весь `src/`): entry points заданы в `electron.vite.config.ts` и 6 `index.html`. Нужен `knip.json` или запуск с `-c` — решай ты.
