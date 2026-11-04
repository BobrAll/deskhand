# PROGRESS
## Current
T01 закрыта (00-inventory.md: IPC + окна). Следующая задача: T02.
## Last commit
cef6bbe docs(refactor): mark T01 done and update progress
## Log (одна строка на задачу: ID — hash — итог)
T01 — bd12743 — 56 каналов CH + `shell:open-external`: направление/payload/хендлер/потребитель; 6 окон с webPreferences и создателями; перепроверены 5 фактов CONTEXT.md.
## Blocked
## Open questions
- РЕШЕНО (Александр, сессия T01): 6 неиспользуемых методов моста (`settings.validateHotkey`, `onboarding.close`, `quickActions.defaults`, `permissions.microphone`, `voice.micPermission`, `voice.requestMicPermission`) и канал `shell:open-external` разрешено удалить в A2. Удалять с grep-доказательствами по правилу 7, отдельными коммитами.
## Заметки (посторонние находки)
- Расхождения с CONTEXT.md: helper.m 1356 строк (не 1529); overlay.css объявляет 6 кастом-свойств, ни одного общего имени с base.css (не «~24 1:1») — дедупликация (а) в A3 под вопросом; IPC-подписки в 6 файлах (не 5).
- `shell:open-external` (`ipc.ts:317`) — канал вне `CH`, в preload не экспортирован; по факту мёртвый (дублируется `setWindowOpenHandler` в 4 окнах). Кандидат в BUGS/A2, не удалял.
- `permissions:microphone` / `permissions:request-microphone` вызываются и напрямую, и через дубли в неймспейсе `voice` (`preload:111-112`).
