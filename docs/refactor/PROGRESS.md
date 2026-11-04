# PROGRESS
## Current
T04 закрыта (00-inventory.md §5–8: карты windows.ts и обоих App.tsx). Дальше: T02, T03 (в работе у другого агента), затем T10.
## Last commit
d6b90df docs(refactor): record A2 decision on unused bridge methods
## Log (одна строка на задачу: ID — hash — итог)
T01 — bd12743 — 56 каналов CH + `shell:open-external`: направление/payload/хендлер/потребитель; 6 окон с webPreferences и создателями; перепроверены 5 фактов CONTEXT.md.
T04 — f416865 — карты windows.ts (секции, `OverlayHost`, 10 модульных `let`, грейс-период), overlay/App.tsx (13 state + 18 ref, 7 подписок), settings/App.tsx (черновик↔диск, дебаунс 450 мс → `settings:hold` → грейс-период); сквозные дубли — в §8.
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
