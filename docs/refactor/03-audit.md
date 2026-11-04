# 03 — Аудит (фаза 2)

Только чтение. Код не менялся: все цифры ниже сняты `grep -n` / `sed -n` / `wc` по текущему дереву,
плюс `knip` через `npx` (в devDependencies не добавлялся — правило 3).

- Дата: 2026-11-04
- HEAD на снятии: `773ae81` — docs(refactor): propose the order for the three defects
- Формат пункта: `файл:строки` · проблема · доказательство · риск · покрыто тестами?
- Заполнено: **A1**. A2 (мусор), A3 (дубли), A4 (архитектура/гигиена) — отдельными задачами, в том же
  формате, дописываются ниже.

Легенда риска: **низкий** — вынос механический, поведение измениться не может; **средний** — меняется
порядок вызовов или точка отказа, нужен прогон тестов и MANUAL_SMOKE по затронутому разделу;
**высокий** — правка задевает состояние, которое держится только дисциплиной вызовов
(`session === target`, `generation`, `suppressed`, `writtenRef`).

---

## A1 — Крупные модули

### A1.0 Сводка

| Файл | Строк | Ответственностей | Хуков / `let` | Выносимо механически | Держится только состоянием |
| --- | ---: | --- | --- | --- | --- |
| `src/main/overlay.ts` | 1 578 | 10 | 4 `let` + `agent` | сборка запроса (212 строк), 3 копии разбора data URL, 3 копии system-сообщения | `session` (135 упоминаний), `generation`, `held`/`suppressed` |
| `src/main/windows.ts` | 747 | 6 | 11 `let` | геометрия — 154 строки чистых решений; 4 копии загрузки страницы; 5 копий `setWindowOpenHandler` | флаги `drawing`/`voice`/`passthrough`/`anchor` |
| `src/renderer/overlay/App.tsx` | 1 365 | 8 | 55 | редьюсер чанков, политика клавиш, производные флаги, метрики, `measureLine` | 4 ref'а маршрутизации стрима, `busyRef`, `heldWidthRef` |
| `src/renderer/settings/App.tsx` | 934 | 6 | 27 | `holdReasonFor`+`writable`+`unsaved`, конвейер 450 мс, 3 дочерних компонента | `draft`↔`bundle`↔`writtenRef`/`failedRef`↔`applyState` |

Три из четырёх файлов **не покрыты тестами вообще** (`02-test-plan.md` §4.3–4.4). Но прецедент в проекте
есть, и он определяет цену выноса: `pointer.ts` (245 строк, импортирует `electron`) покрыт на 96.6 % —
`pointer.test.ts:23` подменяет `BrowserWindow` классом-фейком и проверяет **решения** (куда встанет слой,
каким будет минимальное кольцо), а не вызовы Electron. Тот же приём в `hud.test.ts:26` и
`agent/cursor.test.ts:24`. То есть «Electron-связан» ≠ «непроверяем»: значит «нужен фейк ~40 строк и шов
в правильном месте».

---

### A1.1 `src/main/overlay.ts` (1 578 строк, один экспорт)

| Место | Проблема | Доказательство | Риск | Покрыто тестами? |
| --- | --- | --- | --- | --- |
| `overlay.ts:825-1482` | `send` — самая крупная единица в проекте: **658 строк (41.7 % файла)**, три независимых подпроцесса в одном теле | `1482-825+1 = 658`; `try` с 1036, `catch` 1467, `finally` 1474. Границы уже прочерчены автором комментариями `// ---- agent rounds ----` (1038) и `// ---- verification ----` (1219), но не выражены кодом | высокий — нарезка проходит через 11 guard'ов `abort.signal.aborted \|\| !session`; пропущенный guard = запись в закрытую сессию | нет — `overlay.ts` 0 % |
| `overlay.ts:825-1036` | Подготовка запроса — 212 строк, **единственная часть `send`, которая не двигает экран**: чистое решение из `request` + `snapshot` + `history` + `settings` | 16 `const` подряд (828–1001); 3 `await` (859 `ensureFreshScreenshot`, 916 `describeScreen`, 1025 `streamRound`). Внутри: `refine`/`baseAnswer` 848–851, `wantImage`/`useImage`/`area`/`canDraw`/`canAct`/`actReason` 866–891, `holdFirstRound` 926, `buildRefine`/`buildRequest` 928–958, `parts` 958–963, `historyMessages` 971–976, `messages` 978–991, `maxTokens` 994–1001 | низкий — вынос как есть: те же входы, тот же порядок, те же `await` | нет, но ровно этот шов и станет тестируемым (A1.5 п.1) |
| `overlay.ts:1286-1444` | `verify()` объявлена **внутри** `send`: замыкается на 11 внешних имён, из которых 3 мутирует | `async function verify()` 1286 → 1444 = 159 строк. Имена по частоте: `session` 7, `request` 7, `abort` 6, `area` 4, `settings` 3, `apiKey` 3, `performedLines` 2, `held` 2, `suppressed` 1, `maxTokens` 1, `canDraw` 1. Мутирует: `performedLines.push` (1418), `suppressed = false` (1441), `held = evidence` (1442) | высокий — вынос требует явного входа из 11 полей и выхода из 3 значений; ошибка в списке = «молча непроверенный ход» | нет |
| `overlay.ts:960, 1181, 1360` | Три дословные копии извлечения base64 из data URL | `/^data:(image\/[\w+.-]+);base64,(.*)$/i` + `parts.push({type:'image',…})` — 960 (основной запрос), 1181 (продолжение), 1360 (проверка) | низкий — механический вынос в одну функцию | нет |
| `overlay.ts:985, 1193, 1373` | Три копии сборки system-сообщения | `` `${settings.systemPrompt.trim()}\n\n${X.modeInstruction}` `` — 985, 1193, 1373 | низкий | нет |
| `overlay.ts:1025, 1186, 1366` | Три вызова `streamRound` с почти одинаковыми аргументами (7 из 9 полей совпадают) | Вызовы 1025, 1186, 1366; различаются `canDraw` (1366 → `false`) и `holdText` | низкий — параметры не меняются, склеивается форма вызова | нет |
| `overlay.ts:286` | `emit` принимает `string`, а не ключ `CH` — единственная точка, где типобезопасность каналов теряется | `function emit(channel: string, payload: unknown)`; через него **12 вызовов по 7 каналам**: `overlay.state` ×3, `overlay.stream` ×4, `agent.event`, `overlay.annotations`, `overlay.contextUpdate`, `overlay.preparing`, `voice.transcript` | низкий — сужение типа ловит `tsc` | косвенно — `ipc.test.ts` сверяет набор каналов, но не сигнатуру `emit` |
| `overlay.ts:171-201` | Пять переменных замыкания с разным временем жизни; `session` — 135 упоминаний | `session` 171, `typing` 173, `generation` 181, `opening` 191, `agent` 201. `session` встречается **135 раз** в 127 строках | высокий — причина, по которой файл нельзя резать «по функциям»: любой вынос требует протаскивать `Session` | нет |
| `overlay.ts:343-460` | Скриншоты и live-обновление: 118 строк со своим `let captureInFlight` и константой посреди контроллера | `captureFor` 345–390, `MAX_SHOT_AGE_MS` 399 (единственная константа вне блока 119–168), `ensureFreshScreenshot` 401–417, `startLive` 420–455, `stopLive` 457–460 | средний — `captureFor` дёргает `host.window()` (7 из 21 вызова `host.*`) и `setContentProtection`; вынос тянет `host` целиком | нет |
| `overlay.ts:502-624` | `openInternal` — 123 строки, четыре ветки; проверка `generation` трижды в одном теле | Ветки: уже открыта и видима 505–537, ранний показ 555–563, сбор контекста 565–600, первый захват + `startLive` 604–622. `startedIn === generation` на 523, 537, 570 | высокий — инвариант «карточка открылась после закрытия» держится только этой парой | нет |
| `overlay.ts:692-744` | Рисунок/флаги/размер — 53 строки; `setFlags` в одиночку делает четыре вещи | `emitAnnotations` 692, `clearPointer` 701, `setFlags` 708–732 (`refresh` → `ensureFreshScreenshot` → `startLive` **или** `stopLive` + сброс аннотаций + `emitAnnotations`), `resize` 734 | средний — `setFlags` связывает флаги, скриншоты и рисунок | нет |
| `overlay.ts:1022-1023, 1441-1442, 1451` | Проза хода управляется двумя переменными тела, которые видят и `send`, и вложенная `verify` | `held`/`suppressed` объявлены 1022–1023; `suppressed` ставится 1048, 1114, 1214, 1240 и один раз снимается (1441); `held` накапливается 1036/1210, обнуляется там же, подменяется вердиктом 1442, отдаётся 1451 | высокий — вынести `verify`, не вынеся эти две, значит получить два мнения о том, что уже показано | нет |

---

### A1.2 `src/main/windows.ts` (747 строк)

| Место | Проблема | Доказательство | Риск | Покрыто тестами? |
| --- | --- | --- | --- | --- |
| `windows.ts:74-731` | Одиннадцать модульных `let` — состояние процесса, разделённое между шестью ответственностями | 74 `overlayWindow`, 75 `overlayVisible`, 85 `overlayReady`, 87 `drawing`, 89 `voice`, 232 `anchor`, 366 `pendingShow`, 597 `passthrough`, 599 `settingsWindow`, 600 `onboardingWindow`, 731 `settingsBusy` | высокий — модульное состояние переживает всё, кроме `vi.resetModules` | нет |
| `windows.ts:597, 731` | Две переменные объявлены **после** первых обращений к ним | `passthrough` объявлена 597, читается 400 (`win.setAlwaysOnTop(passthrough,'floating')`); `settingsBusy` объявлена 731, читается 653 и 663 | низкий по факту (читаются при вызове, не при инициализации), но хрупко: первая инициализация сверху даст TDZ | нет |
| `windows.ts:204-357` | Геометрия — **154 строки чистых решений**, запертых в Electron-модуле: единственный по-настоящему отделимый кусок | `BubbleAnchor` 213–230, `roomAround` 235–241, `placeAnchor` 249–264, `xFor` 275–281, `yFor` 283–287, `positionOverlay` 289–297, `resizeAtAnchor` 312–353. Зависимость от Electron — 4 вызова `screen.*` (250, 251, 321, 327) и `win.setBounds` | низкий при выносе как функций над `(point, area, height, width, bounds)`; **прецедент** — `pointer.ts` тестируется так же | нет — 0 %, хотя цена покрытия та же, что у `pointer.ts` (96.6 %) |
| `windows.ts:181-184, 675-678` | `setWindowOpenHandler` (только http(s) → `shell.openExternal`) — **5 копий** по `main/` | В файле 2 (181, 675); ещё 3: `pointer.ts:87`, `hud.ts:238`, `agent/cursor.ts:139`. У двух копий флаг `/i`, у трёх — нет: копии уже разошлись | низкий — вынос в `denyExternalLinks(win)`; расхождение `/i` при этом исчезает | нет |
| `windows.ts:403, 640, 695` | `try { app.focus({steal:true}) } catch {}` — 3 копии с идентичной заглушкой | 403 (`performShow`), 640 (settings `ready-to-show`), 695 (onboarding `ready-to-show`) | низкий | нет |
| `windows.ts:195, 637, 692` | Три блока `once('ready-to-show')`; у settings и onboarding тела совпадают дословно | 195–200, 637–645, 692–700 | низкий | нет |
| `windows.ts:64` | Загрузка страницы (`dev ? loadURL : loadFile`) — **4 копии** в `main/` | `windows.ts:64 load()`, `pointer.ts:34 loadPage()`, `agent/cursor.ts:84 loadPage()`, `hud.ts:188 loadPage()`. Первые три принимают имя страницы, четвёртый зашит на `'hud'` | низкий — вынос в `main/pageLoad.ts` с одним параметром `page` | нет |
| `windows.ts:711-724` | `closeSettingsWindowWhenSettled()` — синоним `closeSettingsWindow()`: своей логики нет | Тело 711–713 — `win.close()` при живости; тело 722–724 — один вызов первой. `ipc.ts:203` зовёт именно `…WhenSettled` | низкий — удаление синонима, поведение не меняется | нет |
| `windows.ts:456-589` | Порт `OverlayHost`: 9 методов, 134 строки — тонкий, кроме `setPassthrough` и `hide` | `prewarm` 467, `show` 472, `showInactive` 476, `resize` 480, `setDrawing` 503, `setVoice` 515, `setPassthrough` 534–557 (24 строки), `hide` 559–584 (26 строк — сброс пяти величин), `window` 586 | средний — `hide` сбрасывает `passthrough`/`overlayVisible`/`pendingShow`/`anchor`; вынос порта = вынос четырёх `let` | нет |
| `windows.ts:624-681` | `openSettingsWindow`: singleton + создание + `ready-to-show` + `close`-хук с грейс-периодом (1200 мс, шаг 80 мс) — 58 строк | 624–681; грейс-период 648–670: `preventDefault` → `deadline = Date.now() + 1200` → `setTimeout(attempt, 80)` до `!settingsBusy \|\| Date.now() >= deadline` | средний — защита недописанного черновика (A1.4); сломать молча легко | нет |

---

### A1.3 `src/renderer/overlay/App.tsx` (1 365 строк)

| Место | Проблема | Доказательство | Риск | Покрыто тестами? |
| --- | --- | --- | --- | --- |
| `overlay/App.tsx:182-1365` | Один компонент `App()` на 1 184 строки держит все восемь групп A–H: IPC/сессии, стриминг, отправку, геометрию окна, голос, агента, клавиатуру, разметку | `App()` 182–1365 = 1 184 строки: логика 182–1064 (**883**), JSX 1065–1365 (**301**). Хуков в теле — **55**: 13 `useState`, **18 `useRef`**, 10 `useEffect`, 14 `useCallback` | высокий — правка JSX меняет зависимости эффектов; `App` ререндерится на каждый чанк стрима | нет — jsdom/RTL в проекте отсутствует (`vitest.config.ts`, `environment: 'node'`), `02-test-plan.md` §4.4 |
| `overlay/App.tsx:917-925` ↔ `996-1001` | **Один Enter обслуживают два независимых обработчика**: глобальный `keydown` на `window` (по `target.tagName === 'TEXTAREA'`) и `onKeyDown` самой textarea; оба зовут `send(prompt)` | 2 обработчика, **0** `stopPropagation` в файле. `preventDefault` всплытие не останавливает. Порядок фиксирован: React слушает на контейнере `#root`, поэтому `onKeyDown` идёт первым, `window` — вторым. Барьер `if (busyRef.current) return` (677) не спасает: `busyRef` пишется только в рендере (303), а оба вызова происходят в одном тике | высокий — два `overlay:send` на одно нажатие; второй отменяет первый (`overlay.ts:854`), поэтому на экране один ответ. Подробности и цена — `BUGS.md` R8 | нет — и MANUAL_SMOKE §2.3 не видит: виден один ответ |
| `overlay/App.tsx:340-355` ↔ `:432-447` | Две вручную скопированные процедуры обнуления сессии: «новая сессия» (`reset`) и «идёт сбор контекста» (`onPreparing`) | 12 против 13 присваиваний; расходятся только `setState(null)`, `spokenPromptRef`, `setTyping(false / typedWhileEmpty)`, `focus(30)`, `resumePendingSend()`; общее — 10 сеттеров + `requestIdRef` + `replaceOnChunkRef` | высокий — ячейка, добавленная в один блок и забытая во втором, даёт «старый ответ на новой сессии» | нет |
| `overlay/App.tsx:489-500`, `:872-895`, `:1081-1088` | Протокол «бросить запрос» реализован трижды, и три версии неодинаковы | `requestIdRef.current = null` в 6 местах (351, 403, 445, 496, 880, 1085); `ignoredRequestRef` — 4 упоминания. Из трёх «бросить» **два** помечают запрос игнорируемым (голос 496, Escape 880), а кнопка «Стоп» (1085) — **нет** | высокий — поздний чанк после «Стоп» может дописать карточку; сейчас прикрыто контрактом main «после abort ничего не пишет» | нет — MANUAL_SMOKE §2.4/§7 вручную |
| `overlay/App.tsx:857-930` | Политика клавиатуры: 74 строки в одном `keydown`; Escape разветвляется на три случая плюс три одиночные комбинации | Ветки: `checking` 870–897 (cancel по `requestIdRef` + `setAgent(aborted)`), `arming`/`acting` 898–901 (`agent.stop()`), иначе `close()` 902. Плюс ⌘⏎ 906–909, ⌘C 910–916, Enter 917–925. Зависимости `[answer, copy, paste, prompt, send]` (929) — пересоздаются на каждый символ, т.к. `copy`/`paste` зависят от `[answer]` (849, 855) | средний — единственный обработчик, который видит Escape; порядок веток менять нельзя (Escape во время плана ≠ Escape на карточке) | нет |
| `overlay/App.tsx:673-729` ↔ `:740-768` | `send` и `refine` — один конвейер, скопированный с расхождениями | 22 против 11 операторов; 5 из 7 полей payload совпадают дословно (721–728 ↔ 758–765); пролог `setBusy(true)`/`setFailure(null)`/`setNotice(null)`/`setLast` повторён (689–695 ↔ 748–757); `newRequestId()` в обоих (687, 745); различие — `replaceOnChunkRef.current = !base` (748) есть только в `refine` | средний — порядок сеттеров и `replaceOnChunkRef` задают, что видно в момент ответа | нет |
| `overlay/App.tsx:413-468` | Один эффект = 1 invoke + 6 подписок + 6 отписок; полная переподписка на каждой новой сессии | 56 строк, 7 обращений к bridge, 6 `off*` (461–466), зависимости `[applyState, onStream]` (468), а `applyState` пересоздаётся вместе с `reset` (370). Седьмая подписка отдельно: `voice.onTranscript` 820 | высокий — забытый `off` даёт двойные чанки и двойной `paint` разметки | нет |
| `overlay/App.tsx:377-407` | `onStream` смешивает маршрутизацию по `requestId` и три независимых правила видимости текста | 31 строка, 8 ячеек, 4 ref-протокола (`ignoredRequestRef`, `requestIdRef`, `replaceOnChunkRef`, `spokenPromptRef`); блок «стереть озвученную фразу» продублирован дословно (385–388 и 399–402) | высокий — маршрутизация стрима: чужой `requestId` допишет карточку | нет |
| `overlay/App.tsx:503-596, 604-639` | Геометрия на клиенте: 7 производных величин + 4-веточный `cardWidth` + 36-строчный эффект ресайза; числа продублированы с main и CSS без единого источника | 7 производных 508–571; `cardWidth` — 4 ветви 587–595; 112/80/360 (50, 58, 60) совпадают с `windows.ts:22,23,47`; `heldWidthRef.current = composedWidth` пишется **в теле рендера** (585); 2 подписки (`ResizeObserver` + `window.focus`) в одном эффекте 616–628 | высокий — ширины заморожены; правка «на глаз» ломает совпадение с `windows.ts` | нет; MANUAL_SMOKE §2.1 визуально; `palette.test.ts` — только CSS-переменные |
| `overlay/App.tsx:105-129` | `ruler` — единственное модульное мутабельное состояние renderer, спрятанное внутри функции измерения | `let ruler: CanvasRenderingContext2D \| null` (129), `measureLine` 13 строк, 1 вызов (528), шрифт берётся из `fontRef` (269–276) | средний — ширина поедет при чужом шрифте в контексте; сейчас прикрыто `if (ruler.font !== font)` (118) | нет — нужен canvas-мок, которого в проекте нет |
| `overlay/App.tsx:301-305` | Зеркалирование состояния в ref выполняется **в теле рендера**, а не в эффекте; `sendRef` пересоздаётся на каждом рендере | 5 присваиваний 301–305; `sendRef.current = …` (738); `main.tsx` монтирует в `<StrictMode>` (10–11) → каждый проход дважды | средний — перенос в эффект меняет момент, когда `send` и клавиши видят свежее состояние | нет |
| `overlay/App.tsx:185, 304` | Состояние `mode` — запись без читателей: пишется, зеркалируется в `modeRef` и больше нигде не читается | 6 упоминаний: установка `setMode` (1169), зеркало (304), **0** чтений в разметке; все потребители идут через `modeRef.current` (686, 753, 761). Свести к ref можно без смены поведения, но пару `setMode`↔`modeRef` удалять нельзя | низкий | нет |

---

### A1.4 `src/renderer/settings/App.tsx` (934 строки)

| Место | Проблема | Доказательство | Риск | Покрыто тестами? |
| --- | --- | --- | --- | --- |
| `settings/App.tsx:80-823` | `App()` = 744 строки: **27 хуков** в одном теле, из них 418 строк — JSX вкладок | Логика 80–403, JSX 405–822 (`822-405+1 = 418`). Хуки: 10 `useState` (81–91), 2 `useRef` (150, 160), 4 `useEffect` (93, 222, 257, 324), 8 `useCallback` (122, 170, 262, 284, 306, 337, 362, 370), 3 `useMemo` (114, 126, 135) | высокий — правка разметки вкладки перезапускает зависимости эффекта дебаунса | нет |
| `settings/App.tsx:140-259` | Конвейер автоприменения размазан по 4 хукам и 5 ячейкам: сравнение снапшота → 450 мс → `save` → `hold` | `writtenRef` 150, `failedRef` 160, `flush` 170–213 (4 сеттера: `setApplyState`/`setBundle`/`setDraft`/`setBanner`), дебаунс 222–247 (таймер `450` на 245), `hold` 257–259. Цепочка: `draft` → сравнение 224 → таймер 245 → `save` 174 → `bundle`+`writtenRef` → `applyState` → `settings.hold` → `markSettingsBusy` (`windows.ts:727`) → грейс-период закрытия | высокий — разрыв даёт либо перезапись каждые 450 мс, либо закрытие окна с недописанным черновиком | нет — эффект держится на реальном IPC и таймерах |
| `settings/App.tsx:65-78, 270-303` | Граница `64…8192` записана трижды, правило «пустой quickAction отбрасывается» — дважды | `64`/`8192`: `holdReasonFor` 69, `writable` 295, атрибуты `min`/`max` JSX 559–560. Пустой quickAction: 74 и 289–291 | высокий — расхождение копий → стор клампит значение → `draft ≠ bundle` → тихий цикл записи каждые 450 мс | нет — `holdReasonFor` (65–78) чистая и была бы тестируема, но `grep holdReasonFor` вне файла даёт 0 |
| `settings/App.tsx:262-268` | Ветка `!bundle` в `unsaved` недостижима | `unsaved` начинается с `!bundle \|\| …`; вызывается только из 307 и 328 под `if (draft && …)`; `setDraft` только 100/123/179, в `null` не сбрасывается и выставляется исключительно вместе с `bundle` (99–100) | низкий — мёртвое условие (кандидат в A2) | нет |
| `settings/App.tsx:178-198` | Контракт `hotkeyError` живёт вне типа и вытаскивается приведением | `(saved as SettingsBundle & { hotkeyError?: boolean }).hotkeyError` (178); в `shared/api.ts` поля нет, `save()` обещает `Promise<SettingsBundle>`; источник — `ipc.ts:149`. На приведении висит вся ветка 181–198: сброс `writtenRef` (192), таймер `2600` (196), `applyState='error'` | высокий — переименование флага в main не поймает `tsc`; ветка молча перестанет срабатывать, отклонённый хоткей будет ретраиться бесконечно | нет |
| `settings/App.tsx:306-335` | Блок «записать сейчас, мимо дебаунса» продублирован дословно | `failedRef.current = null` + `flush(writable(draft))` на 310–311 (закрытие окна) и 329–330 (⌘S); оба хука с одинаковым списком `[draft, unsaved, writable, flush]` (314, 335) | высокий — единственный путь записи в обход таймера; правка в одном месте оставит второй с другим поведением при ошибке | нет |
| `settings/App.tsx:337-368` | Цепочка `provider → key → testKey → setKey` дублирована в двух окнах, и хвосты уже разошлись | settings `saveKey` 337–360: `testKey` → `setKey` → `setBundle` → `setKeyInput('')` → баннер `3600`. onboarding `App.tsx:57-84`: `testKey` → `setKey` → **`settings.save`** → `setKeyInput('')` → статус без таймера. Плюс копия key-row: settings 517–529 ↔ onboarding 195–208 | средний — расхождение уже есть: один путь сохраняет настройки, другой нет; вынос обязан сохранить это различие, а не «привести к общему виду» | нет |
| `settings/App.tsx:711-747` | Три `PermissionRow` с копипастой тел обработчиков; два сеттера идентичны дословно | `setBundle((prev) => (prev ? { ...prev, permissions: next } : prev))` на 722 и 732; третий (742–744) собирает `{ ...prev.permissions, microphone: granted }`. Каналы разные: `permissions.request()` 721/731 против `requestMicrophone()` 741 | низкий — копия без ветвлений | нет |
| `settings/App.tsx:405-822` | Логика внутри JSX: 21 из 22 вызовов `patch(` — в разметке | `patch(` всего 22 раза, из них 21 в диапазоне 405–822. `agent.setEnabled` + `setBundle` в пропе 686–693, `onRequest` 720–723 / 730–733 / 740–745, `pickApp`+`addExcluded` 792–796 | средний — обход черновика (`agent:set-enabled` идёт мимо `draft`) живёт в пропе; перенос вкладки «как есть» утащит его вместе с ошибкой | нет |
| `settings/App.tsx:825-934` | Три локальных компонента в конце файла, вне файла не используемые | `ApplyStatus` 832–850, `PermissionRow` 852–877, `QuickActionsEditor` 879–934; импортов этих имён вне файла — 0. `ApplyStatus` — чистая функция от `ApplyState` (833–844) | низкий — входы уже равны текущим пропсам, перенос механический | нет, хотя `ApplyStatus` тестируем без DOM |

---

### A1.5 Выносимо без смены поведения

Порядок — от самого выгодного к самому мелкому. Для каждого: что владеет, что получает/отдаёт, какие
ячейки передаются явно и почему это механический перенос.

1. **`main/overlayRequest.ts`** — «собрать один запрос»: `(request, snapshot, history, settings,
   capabilities)` → `{ messages, maxTokens, useImage, area, canDraw, canAct, actReason, outline }`.
   Забирает `overlay.ts:825-1036` (212 строк). Ничего не мутирует, окно не трогает; `buildRequest`/
   `buildRefine` уже чистые и покрыты golden-снапшотами (T16), так что шов встаёт ровно между ними и
   `streamRound`. Два `await` передаются колбэками — как `isAlive` в `turnStream.ts`. Первый кусок
   `overlay.ts`, который станет тестируемым без Electron.
2. **`main/windowsGeometry.ts`** — `roomAround`, `placeAnchor`, `xFor`, `yFor`, `resizeAtAnchor` как
   чистые функции над `(point, area, height, width, bounds)` → `{ x, y, above, right }`. Забирает
   `windows.ts:204-357` (154 строки); вызовы `screen.*` (250, 251, 321, 327) поднимаются к вызывающему.
   Тестируется как `pointer.ts`: фейк окна, настоящие числа.
3. **`renderer/overlay/metrics.ts`** — `NARROW_WIDTH`/`VOICE_WIDTH`/`FULL_WIDTH`/`CHROME_WIDTH`/
   `STOP_CHROME`/`CARET_SLACK`/`MAX_FIELD_HEIGHT`/`FIELD_FONT` (50–103), `REFINE_LABEL`/`REFINE_HINT`
   (131–139). Ячеек не требует — константы остаются константами, числа не трогаются.
4. **`renderer/settings/applyGate.ts`** — `HOLD_REASON`, `holdReasonFor`, `unsaved`, `writable` и одна
   пара границ вместо трёх копий (`settings/App.tsx:59-78, 262-303`). Вход: `draft`, `bundle.settings`,
   `writtenRef.current`, `invalidBaseUrls`; выход: `string | null` / `AppSettings` / `boolean`. В теле
   нет ни хуков, ни `window` — только аргументы.
5. **`renderer/settings/useAutosave.ts`** — сравнение снапшота, таймер 450 мс, `writtenRef`/`failedRef`,
   переходы `applyState`. Вход явно: `draft`, `bundle.settings`, `holdReason`, `save(snapshot)`;
   выход: `{ applyState, flushNow }`. Связь с React только через переданные сеттеры; тексты и `2600`
   остаются в вызывающем. Закрывает и дубль «записать сейчас» (306–335).
6. **`renderer/overlay/streamRouting.ts`** — редьюсер чанков (`overlay/App.tsx:377-407`):
   `(event, { requestId, ignoredRequest, replaceOnChunk, spokenPrompt })` → список действий. Чистая
   функция; DOM не нужен, поэтому проверяема в `env: node`.
7. **`renderer/overlay/viewFlags.ts`** — `deriveView(state, expanded, hasAnswer, failure, last)` →
   `{ blocked, showMeta, canPaste, agentOff, agentBlocked, agentNotice, actionAsk, hint, alert }`
   (`overlay/App.tsx:971, 1033-1064`). Чистые выражения, ни одного ref.
8. **`renderer/overlay/keyPolicy.ts`** — `(key, meta, shift, tagName, agentPhase, hasRequestId)` →
   `'close' | 'cancel' | 'stopAgent' | 'paste' | 'copy' | 'send' | null`. Забирает 857–930. Порядок
   веток Escape сохраняется дословно. **Важно:** двойной Enter (A1.3, `BUGS.md` R8) при этом обязан
   сохраниться как есть — иначе вынос превратится в незаметный багфикс (правило 2).
9. **`main/pageLoad.ts`** и **`main/denyExternalLinks.ts`** — 4 копии «dev ? loadURL : loadFile»
   (`windows.ts:64`, `pointer.ts:34`, `cursor.ts:84`, `hud.ts:188`) и 5 копий `setWindowOpenHandler`.
   Обе — по 4–5 строк с одним параметром; расхождение флага `/i` при этом исчезает.
10. **`renderer/settings/{ApplyStatus,PermissionRow,QuickActionsEditor}.tsx`** — перенос
    `settings/App.tsx:825-934` один-в-один; пропсы не меняются.
11. **`main/turnVerify.ts`** — `verify()` из `overlay.ts:1286-1444`. Идёт последним и только после п. 1:
    вход из 11 полей и выход из 3 значений, а `streamRound`/`captureFor`/`agent.execute`/`publishAgent`
    иначе пришлось бы передавать дважды.

### A1.6 Связано состоянием — резать нельзя

- **`session` в `overlay.ts`** — 135 упоминаний; на нём висят три инварианта, которые держатся только
  дисциплиной вызовов: `session === target` после каждого `await` (`publishContext` 324, `captureFor` 373,
  `ensureFreshScreenshot` 417), `generation` против «открылась после закрытия» (523/537/570), пара
  `abort.signal.aborted || !session` (11 мест). Разрезание по функциям без явного контекста ломает все три.
- **`held`/`suppressed`/`performedLines` внутри `send`** — объявлены 1022–1023; `suppressed` ставится в
  четырёх местах (1048, 1114, 1214, 1240) и снимается один раз (1441); `held` подменяется вердиктом
  (1442) и отдаётся (1451); `performedLines` пишется из двух мест (1139, 1418). Пока `send` и `verify` —
  одна область видимости, инвариант «прозу этого хода не показывать» держится на глазах.
- **Флаги `drawing`/`voice`/`passthrough`/`anchor` (`windows.ts`)** — `applyWindowChrome` (108) читает
  два первых, `performShow` (400) — третий, `hide` (559–582) сбрасывает четыре. Порт `OverlayHost`
  (456–589) — их единственный писатель, поэтому порт и флаги переезжают только вместе.
- **`draft` ↔ `bundle` ↔ `writtenRef`/`failedRef` ↔ `applyState` (settings)** — сравнение (224), refs
  (150/160) и `hold` (257–259) переезжают вместе. Порознь: перезапись каждые 450 мс, либо повтор упавшей
  записи по таймеру, либо закрытие окна с недописанным черновиком.
- **`bundle` как «сторона диска», в которую пишут пять мест** (`settings/App.tsx:175`, 351, 365,
  690–693, 722/732/742) — любая ячейка, меняющая `bundle` в обход `flush`, обязана остаться в `App`,
  иначе футер объявит `pending` для уже записанного значения.
- **Маршрутизация стрима (`overlay/App.tsx`)** — `requestIdRef` (14 обращений), `ignoredRequestRef` (4),
  `replaceOnChunkRef` (7), `spokenPromptRef` (8) плюс `setAnswer`/`setBusy`/`setFailure`. Порознь: поздние
  чанки брошенного запроса допишут карточку, ответ прошлой сессии ляжет под новую фразу.
- **Барьер двойной отправки (`overlay/App.tsx`)** — `busy` + `busyRef` (пишется только в рендере, 303),
  `stateRef`, `modeRef`, `requestIdRef`, `last{refine, base, voice}`. Самый опасный узел файла: правка
  вокруг `send`/`setBusy` меняет число запросов к провайдеру.
- **Непрерывность ширины (`overlay/App.tsx`)** — `heldWidthRef`, `widthRef`, `cardWidth`, `rootNode`.
  Порознь: карточка прыгнет на `send`, окно померится по отсоединённому узлу при свапе бары↔карточка.
- **Политика Escape (`overlay/App.tsx`)** — `agentRef`, `requestIdRef`, `ignoredRequestRef`,
  `setAgent(aborted)`. Порознь Escape начнёт закрывать карточку вместо остановки плана, и строка
  «Проверка остановлена.» не появится.

### A1.7 Побочные находки (не про размер файлов)

- **Найден дефект: Enter в поле карточки даёт два `overlay:send`** (A1.3, вторая строка). Записан
  `BUGS.md` R8, не чинился (правило 2). Он же — единственное место, где вынос `keyPolicy.ts` может
  молча изменить поведение, поэтому порядок в A1.5 важен: R8 решается до выноса или после, но не в нём.
- `knip` (через `npx knip@5`, в devDeps не добавлялся): **2 unused files**, **5 unused exports**,
  **22 unused exported types**. Пересечение с согласованным к удалению в A2 — только `AnnotationStream`.
  Новое: `windows.ts` отдаёт **6 экспортов без потребителей** (`OVERLAY_WIDTH`, `OVERLAY_NARROW_WIDTH`,
  `OVERLAY_VOICE_WIDTH`, `OVERLAY_MIN_HEIGHT`, `OVERLAY_MAX_HEIGHT`, `closeSettingsWindow`), причём
  значения первых трёх продублированы в `overlay/App.tsx:50,58,60` **своими** константами. Это не
  публичный API, а непрочитанная копия. В A2 — с оговоркой: снять экспорт легко, а дубль значений в
  renderer — отдельная правка A3.
- `context/screenshot.ts:275 dataUrlToFile` и `util.ts:27 errorMessage` — экспорты без потребителей
  (A2). `errorMessage` стоит посмотреть глазами: в `overlay.ts:1472` та же логика написана руками
  (`error instanceof Error ? error.message : 'Неизвестная ошибка запроса.'`).
- `renderer/settings/HotkeyField.tsx:46 toAccelerator` — `knip` считает непотреблённым, но он
  вызывается из того же файла на 98. Ложное срабатывание: инструмент видит только межфайловые импорты.
  Вывод для A2: список `knip` идёт в работу только после ручной проверки по правилу 7.
- `overlay.css` объявляет 6 кастом-свойств (`--panel`, `--panel-edge`, `--panel-drawing` × две темы),
  `base.css` — 42 уникальных, **общих имён ноль**. Подтверждает T04: пункт (а) «overlay.css повторяет
  ~24 переменные из base.css 1:1» в текущем дереве не воспроизводится. Дедупликация (а) в A3 не нужна.
- Пункт (г) инвентаря подтверждён как реальный клон: `MODIFIER_FLAGS` в `agent/keys.ts:106-121`
  (9 ключей) и `voice/listen.ts:113-124` (7 ключей), плюс одинаковый keycode-массив на 20 элементов в
  обоих файлах. Разбор — в A3.
- Пункт (в) уточнён: подписок **7 в одном файле** (6 в эффекте 419–462, 1 отдельно на 820) и по одной
  в четырёх других — всего 5 файлов, 11 подписок.