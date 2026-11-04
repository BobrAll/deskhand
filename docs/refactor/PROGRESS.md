# PROGRESS
## Current
T02 закрыта (00-inventory.md §9: helper-контракт). Дальше: T03, затем T10.
## Last commit
dcd00ba docs(refactor): add helper command contract inventory
## Log (одна строка на задачу: ID — hash — итог)
T01 — bd12743 — 56 каналов CH + `shell:open-external`: направление/payload/хендлер/потребитель; 6 окон с webPreferences и создателями; перепроверены 5 фактов CONTEXT.md.
T04 — f416865 — карты windows.ts (секции, `OverlayHost`, 10 модульных `let`, грейс-период), overlay/App.tsx (13 state + 18 ref, 7 подписок), settings/App.tsx (черновик↔диск, дебаунс 450 мс → `settings:hold` → грейс-период); сквозные дубли — в §8.
T02 — dcd00ba — 20 команд helper'а (argv/ответ/обёртка/вызывающий/fallback), 3 потока событий, тайминги и лимиты `probe`; побочный эффект `probe` — запись AXEnhancedUserInterface/AXManualAccessibility в целевое приложение; расхождения с CONTEXT.md — в §9.6.
## Blocked
## Open questions
- РЕШЕНО (Александр, сессия T01): 6 неиспользуемых методов моста (`settings.validateHotkey`, `onboarding.close`, `quickActions.defaults`, `permissions.microphone`, `voice.micPermission`, `voice.requestMicPermission`) и канал `shell:open-external` разрешено удалить в A2. Удалять с grep-доказательствами по правилу 7, отдельными коммитами.
## Заметки (посторонние находки)
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
