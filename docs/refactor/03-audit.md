# 03 — Аудит (фаза 2)

Только чтение. Код не менялся: все цифры ниже сняты `grep -n` / `sed -n` / `wc` по текущему дереву,
плюс `knip` через `npx` (в devDependencies не добавлялся — правило 3).

- Дата: 2026-11-04
- HEAD на снятии: `773ae81` (A1), `b95c99d` (A2/A3) — см. PROGRESS.md
- Формат пункта: `файл:строки` · проблема · доказательство · риск · покрыто тестами?
- Заполнено: **A1**, **A3**, **A4**. A2 (мусор) закрыта кодом и записана в PROGRESS/TASKS.

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
| `overlay/App.tsx:917-925` ↔ `996-1001` | **Один Enter обслуживают два независимых обработчика**: глобальный `keydown` на `window` (по `target.tagName === 'TEXTAREA'`) и `onKeyDown` самой textarea; оба зовут `send(prompt)` | 2 обработчика, **0** `stopPropagation` в файле. `preventDefault` всплытие не останавливает. Барьер `if (busyRef.current) return` (677) не спасает: `busyRef` пишется только в рендере (303), а React флашит синхронную работу **микрозадачей** (`react-dom.development.js:25673`, `scheduleMicrotask(flushSyncCallbacks)`) — то есть уже после того, как событие добралось до `window`. Проверено чтением `react-dom`, не догадка | средний — два вызова `send` на одно нажатие, второй отменяет первый (`overlay.ts:854`). **Дефектом не является**: при `captureScreenshotByDefault: true` (дефолт) первый `send` отменяется на `await ensureFreshScreenshot` до сети, а на экране виден один ответ (`onStream` фильтрует по `requestId`). Потребительской цены нет — только лишний IPC. **Важно для выноса:** `keyPolicy.ts` не должен «оптимизировать» это в один вызов, иначе это будет смена поведения | нет — и не увидит: симптома нет |
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
   веток Escape сохраняется дословно. **Важно:** два обработчика Enter (A1.3) при этом обязаны
   сохраниться как есть — «свести к одному» здесь было бы сменой поведения, а не рефакторингом.
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

- **Enter в поле карточки обслуживают два обработчика** (A1.3, вторая строка) — сначала `onKeyDown`
  textarea, затем глобальный `keydown`. Проверено и по коду, и запуском: это не дефект (см. риск в
  A1.3), но единственное место, где вынос `keyPolicy.ts` может молча изменить поведение, поэтому в A1.5
  п. 8 стоит требование сохранить оба вызова.
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

---

## A3 — Дубли

Снято на HEAD `b95c99d`, после A2 (окно `hud` уже удалено). Только чтение.
Инструменты: `npx jscpd@4 --min-lines 8 --min-tokens 60 src` (по умолчанию в devDeps не добавлен,
правило 3), `grep -n`, `sed -n`, плюс два одноразовых python-скрипта сверки таблиц и опций окон
(оба — чтение, в репозиторий не попали).

### A3.0 Что показал jscpd

19 клонов, 270 дублированных строк из 28 123 (**0.96 %**; typescript 235 = 1.03 %, markup 35 = 43.75 %,
css **0**). Из 19 клонов 8 — тестовые обвязки (`llm/*.test.ts` ×3, `gesture ↔ voice listen.test.ts`
×3, `gesture ↔ voice index.test.ts` ×1, `ipc.test.ts ↔ shared/ipc.test.ts` ×1), 4 — шапки
`index.html`, 7 — боевой код (`agent/keys.ts ↔ voice/listen.ts` ×2, `gesture ↔ voice listen.ts` ×2,
`pointer.ts ↔ agent/cursor.ts` ×1, `screenshot.ts` внутри файла ×1, `annotations.ts ↔ agent/protocol.ts`
×1).
То есть «проект чистый» (правило 8) подтверждается: 0.96 % против заявленных в ТЗ 0.22 % — цифры не
сошлись ещё в T10, но порядок тот же.

### A3.1 Пункт (а): `overlay.css` ↔ `base.css` — дубля нет

`base.css` — 23 уникальных `--*`; `overlay.css` — **3** своих (`--panel`, `--panel-edge`,
`--panel-drawing` в `:root`, `:24-39`, по две темы); `cursor.css` — 8 (`--cursor-*`, `--x`, `--y`),
`pointer.css` — 2 (`--delay`, `--ink`), у `settings.css`/`onboarding.css` своих нет. Пересечение имён
с `base.css` — **0**, разбор jscpd по css — **0 клонов**. Значения тоже разные
(`--bg: rgba(28,29,34,.94)` против `--panel: rgba(21,23,29,.94)`). Отдельно: `palette.test.ts`
(8 тестов, снапшот 12 наборов) уже фиксирует итоговые значения на каждое из 6 окон. **Вердикт:**
выносить нечего; заявление из CONTEXT.md снять. Перенос `--panel*` в `base.css` — смена каскада
(глобальные вместо локальных), то есть не дедупликация.

### A3.2 Пункт (б): `settings/App.tsx` ↔ `onboarding/App.tsx` — цепочка ключа

`settings/App.tsx:337-357` против `onboarding/App.tsx:57-83`. Совпадает форма: `testKey(provider, key,
baseUrl)` → ранний выход по `!test.ok` с текстом модели → `setKey(...)` → `setKeyInput('')` →
сообщение об успехе; исключение ловится одним и тем же текстом «Не удалось сохранить ключ.».
Построчная сверка: **10 идентичных строк** из 21 и 27. Различия — не косметика: settings пишет
`setBundle(next)` (ответ `setKey`) и живёт на `draft`/баннере с таймером 3600 мс, onboarding **дополнительно**
зовёт `settings.save({...bundle, provider})` и держит `busy`/`status` без таймера (и после успеха
`bundle` не перезагружает — заметка T34). Общий хук вынужден был бы принимать и `setBundle`, и `save`,
и политику таймера — то есть три параметра на две реализации. **Вердикт:** не выносить; допустимая
мелочь на будущее — `testAndSaveKey(provider, key, baseUrl) → { ok, message }` (7 строк, только
`testKey`+`setKey`), но это C-приоритет.

### A3.3 Пункт (в): IPC-подписки — 13 штук в 5 файлах, общего хука не заслуживают

`overlay/App.tsx` — 7 (`:423,424,449,452,453,456,820`), `overlay/useVoice.ts` — 3 (`:232,237,241`),
`settings/VoiceTab.tsx` — 1 (`:47`), `pointer/main.ts` — 1 (`:17`), `cursor/main.ts` — 1 (`:20`).
Итого **13 подписок в 5 файлах**; в `settings/App.tsx` подписок нет (в инвентаре он попал по ошибке:
`.onChange`/`.onRequest` там — DOM и пропсы). Общая у них только форма `const off = api.onX(cb); …
return () => off()`; наборы каналов не пересекаются, состояния не связаны, а два файла
(`pointer/main.ts`, `cursor/main.ts`) не React — `off()` там некуда сохранять. Хук сэкономит 1–2
строки на место и спрячет порядок подписок, который в `overlay/App.tsx:419-462` важен (комментарий
на `:415-422` объясняет, почему `getState` идёт до подписок). **Вердикт:** не выносить.

### A3.4 Пункт (г): таблицы клавиш — данные совпадают, политики нет

| Таблица | `agent/keys.ts` | `voice/listen.ts` | Общих | Расхождений |
|---|---|---|---|---|
| `KEY_CODES` | `:15-80`, 64 | `:26-89`, 62 | 62 | **0** |
| `FUNCTION_CODES` | `:83-104`, 20 | `:92-113`, 20 | 20 | **0** |
| `MODIFIER_FLAGS` | `:106-118`, 10 | `:115-124`, 7 | 7 | **0** |

`keys.ts` знает лишние `esc`, `forwarddelete` (алиасы) и лишние модификаторы `meta`, `super`, `opt`.
jscpd: `keys.ts:24-61 ↔ voice:33-70` (38 строк) и `83-107 ↔ 92-116` (25 строк) — тот самый «клон
37 строк» из CONTEXT.md (после A2 он виден как два блока).

Парсеры при этом разные по контракту, и это осознанно: `parseAccelerator` требует `parts.length >= 2`
и `flags !== 0` (голая клавиша — ошибка) и отбрасывает неизвестный `F<n>` через `?? null`;
`parseShortcut` разрешает одиночную клавишу (`'esc' → {53, 0}`) и `super`/`meta`.

**Вердикт:** выносить **только данные** (`KEY_CODES` + `FUNCTION_CODES`) в `shared/keycodes.ts`,
парсеры оставить в файлах. `MODIFIER_FLAGS` — **не объединять**: в `keys.ts` это надмножество, и если
`voice` начнёт читать его за компанию, `Super+Space` перестанет быть ошибкой ввода и станет
работающим хоткеем (смена поведения, правило 1). **Риск:** низкий. **Покрыто:** `keys.test.ts`
(20 тестов, включая `super`/`esc`) и `listen.test.ts` (59, включая `Alt+Shift` → `null`).

### A3.5 Повтор helper/osascript — дубля нет

`runOsascript` объявлен один раз (`native/helper.ts:75-87`) и вызывается 6 раз из того же файла
(`:122,126,129,149,165,405`). Вне `helper.ts` `osascript` не запускает никто: прочие `execFile` — это
`defaults read` (`ipc.ts:66`) и `screencapture` (`context/screenshot.ts:88`), `spawn` — слушатели
(`voice/listen.ts:215`, `gesture/listen.ts:79`, `whisper.ts:221`) и `watch` (`helper.ts:338`).
**Вердикт:** выносить нечего; «повтор helper/osascript» из формулировки задачи — ложная цель.
osascript-фолбэки у четырёх команд (`front` `:122-131`, `copy`/`paste` `:149-152`, `activate`
`:165-166`, `apps` `:405-410`) — осознанная деградация без бинаря и без Automation-прав, каждый со
своим разбором ответа, не клон.

### A3.6 Создание окон: три настоящих клона

1. **`loadPage(win, page)` — 3 копии по 5 строк**: `windows.ts:64-68` (имя `load`),
   `pointer.ts:34-38`, `agent/cursor.ts:83-87` (там `page` зашит — `'cursor'`). Тела идентичны
   (`process.env['ELECTRON_RENDERER_URL']` → `loadURL`, иначе `loadFile(join(__dirname,
   '../renderer/<page>/index.html'))`). **Риск:** низкий. **Выносить:** да, `main/pageLoad.ts`.
   **Покрыто:** нет — окна в тестах не создаются; проверка `MANUAL_SMOKE §12`.
2. **`setWindowOpenHandler` — 4 копии по 4 строки**: `windows.ts:181-184`, `windows.ts:675-678`,
   `pointer.ts:87-90`, `agent/cursor.ts:138-141`. Расхождение уже есть: у `cursor` regex с флагом
   `/i`, у трёх других — без. **Риск:** низкий для выноса «как есть» (с параметром), но **средний**,
   если все четыре привести к одному виду: это смена поведения в трёх окнах. **Выносить:** да, но
   унификацию `/i` — **на подтверждение**.
3. **Окно-«слой» + хром**: `pointer.ts:41-66` ↔ `cursor.ts:90-115` (23 и 22 строки, совпадают 20;
   отличия — `acceptFirstMouse: true/false` и имя переменной) плюс хром `pointer.ts:71-78` ↔
   `cursor.ts:122-128` (`setIgnoreMouseEvents(true,{forward:true})`, `setAlwaysOnTop(true,
   'screen-saver')`, `setVisibleOnAllWorkspaces(…)`, `setContentProtection(true)`). **Риск:** средний —
   это фокус, клики и попадание окна в скриншот; тестов нет, проверка глазами. **Выносить:** да,
   `createLayerWindow({ page, acceptFirstMouse })` в `main/layerWindow.ts`, ≈40 строк в минус.
4. **Не клоны**: `baseOptions()` (`windows.ts:602-620`) уже один на settings/onboarding; три
   `new BrowserWindow` в `windows.ts` (`:116`, `:631`, `:690`) — разные окна с разными опциями.
   `app.focus({steal:true})` в try/catch — 3 копии по 5 строк в одном файле (`:403`, `:640`, `:695`);
   микро-клон, уходит локальным `focusSteal()` при следующей правке файла, отдельной задачи не стоит.

### A3.7 Ширины пузыря: одно число в двух процессах

`windows.ts:22-23,47` — `360`, `112`, `80`; `overlay/App.tsx:50,58,60` — те же три числа под именами
`FULL_WIDTH`, `NARROW_WIDTH`, `VOICE_WIDTH`. Значения обязаны совпадать: main задаёт размер окна,
renderer по ним решает перенос строки (`App.tsx:551-571`) и какую ширину просить. Расхождение =
обрезанная или «прыгающая» карточка. **Риск:** средний (видно только глазами).
**Выносить:** да — `shared/metrics.ts`, три значения, импорт в оба процесса (`@shared` уже
используется обоими). **Покрыто:** нет; проверка `MANUAL_SMOKE §4` (короткий и длинный ответ).

### A3.8 `clamp01` и `cleanLabel` — клон тела, разные политики

- `clamp01` — три идентичных тела по 4 строки: `agent/geometry.ts:21-24`, `agent/protocol.ts:49-52`,
  `annotations.ts:40-43`. Вынос в `shared/math.ts` даёт −8 строк и +1 модуль ради
  `Math.min(1, Math.max(0, v))`. **Вердикт:** не выносить (правило 8: проблемы нет).
- `cleanLabel` — `annotations.ts:45-55` ↔ `agent/protocol.ts:54-63`: одинаковое снятие одной пары
  кавычек/скобок, но лимиты **разные** (90 против 60). Два разных контракта для двух разметок
  (`@label` против `@click`). **Вердикт:** не выносить; параметр `maxLength` спрятал бы это различие.
- **Внутри `overlay.ts`** — разбор data URL ×3 (`:960`, `:1181`, `:1360`): один regex
  `/^data:(image\/[\w+.-]+);base64,(.*)$/i` и одно и то же `parts.push({type:'image', …})`. Вынос в
  локальный `imagePart(dataUrl)` — 6 строк, риск низкий. А префикс system-сообщения ×3
  (`:985,1193,1373`) выносить **не надо**: это ровно те строки, что защищены правилом 1.
- **`screenshot.ts`** — `bounds → area` дважды (`:59-69` в `resolveArea`, `:234-244` в фолбэке).
  Второй блок дословный: заменяется на `resolveArea({ bounds: target.bounds })`. Риск низкий;
  `screenshot.ts`-специфичных тестов нет (`context/*.test.ts` — 33 теста по `activeApp`/`collect`/
  `selection`), проверка `MANUAL_SMOKE §3`.

### A3.9 Дубль, которого jscpd почти не видит: слушатели голоса и жестов

`gesture/listen.ts:70-152` ↔ `voice/listen.ts:209-291`: `spawn` в try/catch → `createInterface` по
stdout → `JSON.parse` с проглатыванием мусора → `reader.on('line')` с ветками `error`/`ready`/`event` →
`child.on('exit')` с `reader.close()` и проверкой `stopped` → `scheduleRestart` (1→2→4…30 с) → `stop()`
с `SIGTERM`. jscpd: 19 + 15 строк; по факту совпадает и форма класса. Отличия, которые нельзя
потерять: у `voice` `launch(parsed)` зависит от акселератора, у `gesture` — свой `args`; при
`!reportedReady` `voice` пишет текст про «Универсальный доступ» и зовёт `onError`, `gesture` молча
выходит; тексты ошибок разные (`describeTapError`/`describeGestureError`); `voice.stop()` чистит
`current`. Общий баг **R2** (backoff недостижим: `ready` сбрасывает `failures`) живёт в обоих.
**Риск:** средний (процессы, рестарты, `stopped`). **Покрыто:** `voice/listen.test.ts` (59),
`gesture/listen.test.ts` (42; файлы сами клонируются — 11+22+11 строк). **Выносить:** да, последним:
`main/native/tapListener.ts` с абстрактными `args()`, `describeError()`, `onStartupFailure()`.
Минус ≈90 строк в двух классах и столько же в тестах.

### A3.10 Что сознательно оставлено

- **`index.html` ×5** (8–11 строк шапки, markup 43.75 %): это входные точки electron-vite, у каждой
  свой `<script type="module">`, `title`, а у onboarding ещё `body.window`. Общий шаблон = плагин
  сборки ради 10 строк; CSP лучше видеть глазами в каждом окне. **Не трогать.**
- **Клоны в тестах** (`llm/*.test.ts` ×3, `gesture ↔ voice listen.test.ts` ×4, `ipc.test.ts ↔
  shared/ipc.test.ts`): одинаковая обвязка (мок `fetch`, сборка SSE). Обобщение свяжет независимые
  наборы и спрячет, какой из них упал. **Не трогать.**
- **Токены окон** (`--panel*`, `--cursor-*`, `--ink`, `--delay`): осознанно локальны (`docs/style.md`).
- **`settings/App.tsx` ↔ `overlay/App.tsx`** — общего кода нет: пару связывает состояние (A1.6),
  а не текст.

### A3.11 Итог и порядок

Оправдан вынос **семи** кусков, по возрастанию риска: `main/pageLoad.ts` (низкий),
`main/denyExternalLinks.ts` (низкий «как есть»), `resolveArea()` в `screenshot.ts` (низкий),
`imagePart()` в `overlay.ts` (низкий), `shared/metrics.ts` (средний — видно только глазами),
`main/layerWindow.ts` (средний — видно только глазами), `main/native/tapListener.ts` (средний, есть
тесты), `shared/keycodes.ts` — только данные таблиц (низкий, есть тесты). Пункт (г) — **не** сливать таблицы:
`MODIFIER_FLAGS` в `voice` обязан остаться 7-элементным, иначе `super+s` станет допустимым хоткеем.

Потолок после всех выносов: jscpd ≈ 0.4 % — останутся тестовые обвязки, `index.html` и мелочи
(`clamp01` ×3, `cleanLabel` ×2, system-префикс ×3), которые решено не трогать.

Проверка после работ: `npm test` (940) должен остаться зелёным без правки тестов, кроме нового теста
на совпадение таблиц клавиш; `MANUAL_SMOKE` — §12 (оба окна-слоя: рисунок и кольцо агента), §4
(перенос строки в карточке при 112/80/360), §9 (ключ в настройках), §2 (хоткей) и §8 (жесты/голос).

**Нужно подтверждение Александра** (смена поведения, а не дедупликация): привести все четыре
`setWindowOpenHandler` к одному regex с `/i`; разрешить `super`/`meta`/`opt` в настройках хоткея
(сейчас — ошибка ввода).

---

## A4 — Архитектура и гигиена

Только чтение, код не менялся. Инструменты: `madge@8`, `knip`-подобная сверка экспортов своим скриптом,
`eslint@9` + `typescript-eslint@8` и `prettier@3` — **все через `npx` из `/tmp`, в `package.json` ничего
не добавлялось** (правило 3). `helper.m` — только анализ, по правилу «Objective-C не трогаем».

Размеры сняты по дереву без тестов: `main` 44 файла / 9 990 строк, `preload` 2 / 117, `shared` 5 / 1 456,
`renderer` 16 / 4 205. Всего 67 файлов / 15 768 строк.

### A4.0 Направление зависимостей — здорова

| проверка | результат |
|---|---|
| `shared` импортирует `electron` | **0** — слой чистый, тестируем без моков |
| `main` импортирует `renderer` | **0** (совпадения только в `__dirname`-путях) |
| `preload` импортирует `main` | **0** |
| `renderer` импортирует `main` | **0**; только `@shared/{api,defaults,intent,types}` (17 импортов) |
| циклы (`madge --circular`, 111 файлов) | **нет** |
| `: any` / `as any` / non-null `!` в prod | **0 / 0 / 0**; приведений типов `as X` — 38 на весь код (больше всех `agent/targeting.ts` 10, `shared/defaults.ts` 7) |

Строгость: `strict` + `noUnusedLocals` + `noUnusedParameters` + `noImplicitOverride` +
`noFallthroughCasesInSwitch`. Это редкость для проекта такого возраста — фиксирую как факт, а не как долг.

### A4.1 Логика внутри Electron-обвязки

Четыре места, где обвязка содержит настоящую логику — то, что нельзя проверить без Electron и что сейчас
не проверяется ничем. Риск A4.1.1 — **высокий**, остальных трёх — **средний**.

**A4.1.1 `src/main/overlay.ts:170-1578` · 1 409 строк и 29 функций в одном замыкании · доказательство:
`grep -n "^  function "` даёт 29 вхождений от `publishAgent` до `deliver`; из `electron` файл берёт только
`app` и `BrowserWindow` (`:9`), и использует их ровно в двух местах — `:684` (`BrowserWindow.getAllWindows()`)
и `:688` (`app.hide()`) · риск высокий · тестов нет (файла `overlay.test.ts` не существует).**

Внутри замыкания живут: сборка контекста, окно и фокус, живой скриншот, стриминг LLM, прогон плана агента,
рисунки, диктовка, копирование/вставка, удержание ответа, `generation`-логика. То есть **весь смысл
продукта**. `turnStream.ts` — единственный кусок, который уже вынесен (и он покрыт тестами), это доказывает,
что направление верное: вынос возможен, просто сделан на один шаг.

Почему это дорого: 1 579 строк = **16 % всего `main`**, и они непокрыты, тогда как `agent/index.ts` (603)
и `voice/index.ts` покрыты. Любая правка в `send`/`streamRound`/`remember` сегодня проверяется только
руками.

**A4.1.2 `src/main/windows.ts:70-72,235-240,275-287` · чистая математика заперта в модуле окон ·
доказательство: `clamp` (3 строки, `:70-72`), `roomAround` (6, `:235-240`), `xFor` (6, `:275-280`),
`yFor` (5, `:283-287`) = **20 строк**, единственный
вход — `screen.getCursorScreenPoint()` внутри `placeAnchor:249` · риск средний · тестов нет.**

`xFor`/`yFor` решают, куда встанет карточка и как она растёт при наборе текста — самое заметное для
пользователя поведение в приложении, и оно не покрыто ничем. При этом функции детерминированы: если
передавать точку и `workArea` параметрами (а не читать `screen` внутри), они тестируются как обычная
арифметика. Остальные 728 строк файла — жизненный цикл окон, их вынос дал бы мало (см. A3: `layerWindow`
уже назван отдельно).

**A4.1.3 `src/main/index.ts:86-182` · `bootstrap()` — 97 строк последовательного императива · риск
средний · тестов нет.** Внутри: `Menu.buildFromTemplate` (28 строк литерала), `registerIpc`, `createTray`,
`applyHotkey` с фолбэком на `Alt+Space`, `applyLaunchAtLogin`, `voice.applySettings`, `gestures.applySettings`,
`overlayHost.prewarm`, `readPermissions`, логика онбординга и ручного запуска. Порядок здесь **значим** и
записан только комментарием (`:116-118`: «IPC registration must happen before anything that can throw»).
Тест на этот порядок невозможен без Electron — но и без теста он держится на честном слове.

**A4.1.4 `src/renderer/settings/App.tsx` · 925 строк, 11 `useState`, автопис вшит в компонент · риск
средний · тестов нет (в renderer вообще один тест — `palette.test.ts`, и тот про палитру, а не про окна).**
Дебаунс 450 мс, `writtenRef`/`failedRef`, откат отклонённого хоткея, `hold(true/false)` вокруг записи,
баннеры — всё в одном компоненте с разметкой на 600 строк. `overlay/App.tsx` — 1 365 строк и 16 `useState`,
`onboarding/App.tsx` — 273. Это не «логика в обвязке» в смысле Electron, но это та же болезнь: состояние
и побочные эффекты не отделены от представления.

### A4.2 Глобальное состояние — 38 модульных `let`

| файл | `let` | что держат |
|---|---|---|
| `main/agent/cursor.ts` | **12** | окно кольца, готовность, кадр, таймеры, поколение |
| `main/windows.ts` | **11** | `overlayWindow`, `overlayVisible`, `overlayReady`, `drawing`, `voice`, `anchor`, `pendingShow`, `passthrough`, `settingsWindow`, `onboardingWindow`, `settingsBusy` |
| `main/pointer.ts` | 5 | окно слоя, видимость, `placedOn`, поколение |
| `main/settings/store.ts` | 3 | `store`, `storeRecovered`, `memoryFallback` |
| `main/tray.ts` | 2 | `tray`, `actions` |
| `main/hotkey.ts` | 1 | `current` |
| `main/paste/clipboard.ts` | 1 | `queue` |
| `main/settings/secrets.ts` | 1 | `store` |
| `main/native/helper.ts` | 1 | `cachedHelperPath` |
| `renderer/overlay/App.tsx` | 1 | `ruler` |

Плюс состояние в замыканиях фабрик: `voice/index.ts` 11, `agent/index.ts` 8, `overlay.ts` 5,
`gesture/index.ts` 3.

Вердикт: **это не то, что надо чинить**. Оконные синглтоны — следствие модели Electron (одно окно на
процесс); класс с полями вместо `let` не уберёт ни одной переменной, а добавит церемонии. Замыкания
контроллеров — наоборот, уже инкапсуляция. Единственное, что здесь действительно стоит поправить, —
**порядок объявления**: `src/main/windows.ts:727-731` — `markSettingsBusy` пишет `settingsBusy`, а сам
`let settingsBusy = false` объявлен **ниже** функции, которая его использует (`:731`), и ниже `close`-хука
(`:653,663`), который его читает. Работает (вызовы позже объявления), но читателю приходится искать
объявление вниз по файлу. Риск низкий, тестами не покрыто.

### A4.3 Расхождения `ipc.ts` / `preload` / хендлеры

**Проводка — эталонная, расхождений нет.** Сверено скриптом:

- `CH` — **50** каналов; `ipc.ts` — **37** хендлеров (23 `handle` + 14 `on`), все на константах `CH`;
- **13** каналов — только main→renderer push: `overlay.state`, `overlay.preparing`, `overlay.contextUpdate`,
  `overlay.stream`, `overlay.annotations`, `pointer.draw`, `agent.event`, `agent.cursor`, `voice.event`,
  `voice.record`, `voice.stop`, `voice.transcript`, `voice.downloadProgress`;
- `preload` использует **все 50**; `invoke`↔`handle` = 23↔23 и `send`↔`on` = 14↔14 — множества **совпадают
  побайтово**, хендлера вне `CH` нет, канала без хендлера (кроме push) нет;
- это же зафиксировано тестом `ipc.test.ts:200-260` («every channel has exactly one handler»).

Найденные расхождения — не в проводке, а в **типах и в шести местах, где логика или данные продублированы**:

**A4.3.1 `src/main/ipc.ts:294-296` ↔ `src/main/index.ts:188-190` · `app.on('second-instance')` повешен
дважды · доказательство: `grep -rn "second-instance" src/main` → ровно два обработчика, оба делают
`overlay.open()`; единственный `requestSingleInstanceLock` — в `index.ts:185` · риск средний · тестов нет
(`ipc.test.ts:34` мокает `app.on` как no-op).** Второй запуск `.app` вызывает `open()` дважды. `open()`
идемпотентен по замыслу (`overlay.ts:468-482`), поэтому пользователь, скорее всего, увидит одну карточку —
но второй вход проходит `helperFront` + `collectContext` заново, то есть платит лишние ~450 мс чтения
выделения. Класс дефекта тот же, что тест ловит для каналов («never registers one channel twice»), но для
событий `app` инварианта нет.

**A4.3.2 `src/main/ipc.ts:140` ↔ `src/shared/api.ts:34-39` · `hotkeyError` живёт вне контракта ·
доказательство: хендлер возвращает `{ ...(await bundle()), settings, hotkeyError: true }`, а
`SettingsBundle` такого поля не имеет; рендерер достаёт его приведением
`renderer/settings/App.tsx:178`: `(saved as SettingsBundle & { hotkeyError?: boolean }).hotkeyError` ·
риск низкий · покрыто косвенно (`ipc.test.ts` не проверяет форму ответа).** Единственное место в `api.ts`,
где реальный ответ шире объявленного; остальные 49 методов совпадают с реализацией. Лечение — объявить
`hotkeyError?: boolean` в `SettingsBundle` и убрать приведение; поведение не меняется.

**A4.3.3 `src/main/ipc.ts:42` ↔ `src/shared/defaults.ts:62` · список провайдеров продублирован руками ·
доказательство: `const PROVIDER_IDS: ProviderId[] = ['openrouter', 'openai', 'anthropic']` против
`PROVIDERS` из `defaults.ts`, где те же три id; совпадают сейчас, но ничем не связаны · риск низкий ·
покрыто тестом? нет.** Вторая копия одного списка — то, что разойдётся молча при добавлении четвёртого
провайдера. Выводится одной строкой: `PROVIDERS.map((p) => p.id)`.

**A4.3.4 `src/main/ipc.ts:298-299` · мёртвый костыль `void PROVIDERS` · доказательство: `PROVIDERS`
импортируется (`:12`) и больше в файле не используется — только в `void PROVIDERS` с комментарием
«Referenced so the providers list stays part of the shared contract» · риск низкий · тестов нет.**
Попытка заглушить `noUnusedLocals`, а не осмысленная зависимость: контракт держится типом `ProviderId`.
Заодно единственное `void`-выражение в конце функции в `main`.

**A4.3.5 `src/main/ipc.ts:165-180` · два стиля отказа на одной границе · доказательство: `setKey` (`:166`)
и `deleteKey` (`:172`) **бросают** `new Error('unknown-provider')`, а `testKey` (`:178`) в той же ситуации
**возвращает** `{ ok: false, message }` · риск низкий · покрыто тестом? нет.** Рендерер обязан помнить,
какой метод какой: `App.tsx:341` (`testKey`) читает значение, `App.tsx:350` (`setKey`) — в `try`. Для
`unknown-provider` состояние недостижимо (селект строится из `PROVIDERS`), поэтому на практике вреда нет —
но как контракт это развилка, которую каждый новый хендлер будет решать заново.

**A4.3.6 `src/main/settings/store.ts:85-87` · `settingsWereRecovered()` вычисляется, тестируется и нигде
не показывается · доказательство: `grep -rn settingsWereRecovered src` → объявление, 5 проверок в
`store.test.ts` и **ноль** вызовов в prod-коде · риск низкий · покрыто тестом (сама функция).** Состояние
«файл настроек был испорчен и сброшен» известно, но пользователю не сообщается — ни в окне настроек, ни в
трее. Либо это забытый индикатор, либо мёртвый код; решение — за Александром.

### A4.4 Обработка ошибок

Инвентарь (`}` + `catch` по `src/`, без тестов): **58** блоков в **25** файлах. Больше всех
`context/screenshot.ts` 7, `permissions.ts` 6, `windows.ts` 4, `settings/store.ts` 4, `voice/whisper.ts` 4,
`ipc.ts` 3, `index.ts` 3, `overlay.ts` 2. `console.*` — 22 вызова в 11 файлах (больше всех `index.ts` 5,
`store.ts` 4, `voice/index.ts` 3).

**Пустых/только-комментарий — 15**, и это **не** дефект: в каждом отказ осмысленно проглатывается, и
комментарий объясняет почему (`catch { /* ignore */ }` честнее, чем лог на каждый отказ). Полный список:

`renderer/overlay/recorder.ts:190` · `main/windows.ts:404,553,641,696` · `main/permissions.ts:73,83` ·
`main/ipc.ts:245` · `main/index.ts:171` · `main/overlay.ts:679` · `main/llm/http.ts:70` ·
`main/context/screenshot.ts:259` · `main/voice/whisper.ts:76,112` · `renderer/settings/App.tsx:202`.

Проблема — в **асимметрии**, а не в пустых `catch`:

**A4.4.1 `overlay.open()` вызывается 7 раз, ни один без `.catch`, и внутри `open()` нет `try` ·
доказательство: `ipc.ts:295`, `index.ts:38,55,72,122,180,189`; `openInternal` (`overlay.ts:502-624`)
целиком без `try`/`catch`; `process.on('unhandledRejection'|'uncaughtException')` в проекте **нет**
(`grep` → 0) · риск средний · тестов нет.** Любое исключение из `collectContext`/`helperFront`/
`ensureFreshScreenshot` даёт unhandled rejection: карточка остаётся пустой, в консоли одна строка,
пользователь видит «нажал и ничего не произошло». Это же объясняет, почему отказы такого рода невозможно
диагностировать постфактум.

**A4.4.2 `src/renderer/settings/App.tsx:711,721,731,784` · четыре `async`-обработчика без `try`/`catch` ·
доказательство: `onRequest`/`onClick` с `await window.smartCursor.…` — `permissions.request()` ×2,
`permissions.requestMicrophone()`, `settings.pickApp()`; рядом, в том же файле, `saveKey` (`:337-360`) и
`flush` (`:170-213`) сделаны правильно · риск низкий · тестов нет.** Отказ `invoke` даёт unhandled
rejection в renderer и **никакого** сообщения: кнопка «просто не сработала». Тот же класс —
`removeKey` (`:362-368`): `deleteApiKey` бросает (`secrets.ts:61-65`, `db().set` без `try`), а вызывающий
не ловит.

**A4.4.3 нет `ErrorBoundary` ни в одном из 5 окон · доказательство: `grep componentDidCatch` → 0;
`renderer/{overlay,settings,onboarding}/main.tsx` — по 12 строк, `createRoot(...).render(<StrictMode><App/></StrictMode>)`
без обёртки; `cursor/main.ts` (22) и `pointer/main.ts` (19) — тоже без неё · риск низкий · тестов нет.** Падение рендера в
`settings/App.tsx` (925 строк, 11 `useState`) оставляет пустое белое окно без подсказки и без кнопки
«Перезагрузить».

Вердикт: обработка ошибок есть, но она **по месту**, а не системная. Все три пункта сейчас не
воспроизводятся в обычной работе — это цена отсутствия общего правила, а не список багов.

### A4.5 `src/main/native/helper.m` — только анализ

1 356 строк: 43 `static`-функции + `main` (157 строк, `:1201-1356`), 5 глобальных переменных
(`kAgentEventTag`, `kVoiceModifierMask`, `gGestureDebug`, `gGestureJsonFd`, `gGestureState`), 5 секций
`// MARK:`. Наблюдения, без правок:

- **`main` — диспетчер на 20 `strcmp`**, и в каждой ветке один и тот же каркас: проверка `argc` →
  парсинг → `agentRequireAccessibility()` → вызов → `emit`. Повторы: `@"missing-arguments"` — **8**,
  `agentRequireAccessibility()` — **7**, `emit(@{@"ok":@YES})` — **6**. Табличный диспетчер (массив
  `{имя, argc, обработчик}`) сократил бы `main` примерно вдвое, но это правка C-кода, а не рефакторинг
  на JS — в эту фазу не входит.
- **Две политики на один отказ доступа**: `agentRequireAccessibility` (`:356-360`) возвращает `1` и ветка
  выходит с кодом 1, а `commandVoice` (`:606-609`) при том же `AXIsProcessTrusted() == NO` печатает
  `accessibility-denied` и возвращает **0**. Родитель (`native/helper.ts:57-72`) в обоих случаях получает
  `null`, так что различие не наблюдаемо — но оно есть в протоколе и в exit code.
- **`commandGesture` — 83 строки** (самая большая после `main`) с `dlopen` приватного
  `MultitouchSupport` и подменой `fd 1` на `/dev/null`. Классификация вынесена в `gesture.h` и
  проверяется `npm run test:gesture` — это единственный кусок helper-а с тестами, и он вынесен правильно.
- **`emit` (`:24-34`) не экранирует ввод** (правильно — `NSJSONSerialization`), но пишет `fwrite` +
  `fputc('\n')` + `fflush` на каждый кадр; при `SMARTCURSOR_GESTURE_DEBUG` поток становится построчным на
  каждый край контакта. Пропускная способность не измерялась.
- Дублей **внутри** `helper.m`, которые стоило бы выносить, не найдено — это подтверждает A3: клоны
  helper-обвязки живут в `voice/listen.ts` ↔ `gesture/listen.ts`, а не в C.

### A4.6 Гигиена: ESLint и Prettier — предложение, решаю я

В репозитории **нет** ни `.eslintrc*` / `eslint.config.*`, ни `.prettierrc*`, ни `.editorconfig`, ни
`lint`/`format` в `scripts` (`package.json:5-20`), ни CI (`.github` отсутствует), ни git-хуков
(`.husky`, `lint-staged`, `commitlint` — нет). Единственный формальный контроль — два `tsc --noEmit` и
940 тестов.

Замер (временная установка в `/tmp/a4lint`, в проект не добавлялась):

- **ESLint 9 + `typescript-eslint` 8, набор `recommended`** по `src` — 106 файлов (включая 9 `.tsx`):
  **2 замечания, оба в тестах** — `agent/cursor.test.ts:27` (`_handler`) и `voice/listen.test.ts:60`
  (`_options`), правило `no-unused-vars` не прощает `_`-префикс. То есть код **уже почти проходит**
  строгий набор: включение даст реальный инвариант почти бесплатно.
- **Prettier 3** с настройками, максимально близкими к текущему стилю
  (`--single-quote --no-semi --print-width 100 --trailing-comma none`): **84 файла из 106** и
  **1 377 изменённых строк**. Расхождения системные, двух видов: (1) многострочные объектные литералы,
  которые Prettier схлопывает или переразбивает (`tray.ts:31-49`, `index.ts:87-114`); (2) висячие запятые
  в многострочных литералах (`shared/ipc.ts` — 50 каналов, почти каждый).

Моя рекомендация: **ESLint — да; Prettier — не сейчас**. ESLint даёт 2 находки и ноль переформатирования;
Prettier даёт 1 377 строк диффа в коммите, где поведение не меняется, — а по правилу 1 такой коммит не
ревьюится глазами, то есть это «зелёный» шум, который невозможно проверить. Если Prettier всё же нужен,
безопасный порядок один: отдельный коммит `style: apply prettier` **после** фазы 3 (когда выносы уже
сделаны), с `git diff -w` как доказательством, что изменились только пробелы, и строкой в
`.git-blame-ignore-revs`. `.editorconfig` (5 строк) стоит добавить в любом случае — он бесплатен и не
создаёт диффа.

### A4.7 Мелкое, что видно при чтении

- `src/main/index.ts:87` — `Menu.setApplicationMenu(    Menu.buildFromTemplate([`: артефакт форматирования
  (4 пробела внутри вызова), единственная такая строка в проекте. Поведение не меняет.
- `src/main/windows.ts:722-724` — `closeSettingsWindowWhenSettled()` целиком сводится к
  `closeSettingsWindow()`; «ожидание» живёт в `win.on('close')` (`:652-672`). Имя обещает больше, чем
  делает: чтобы понять, где решена гонка записи, надо уйти в `close`-хук. Риск низкий, тестов нет.
- `src/main/windows.ts:70-72` — `clamp` не защищает от `NaN`: `clamp(NaN, 44, 360) → NaN`,
  `Math.round(NaN) → NaN`, а `win.setBounds({ width: NaN })` — исключение из нативного слоя. Вход идёт из
  IPC (`overlay:resize`, `ipc.ts:111-113`) **без проверки типа**. Риск низкий (источник — свой рендерер),
  но `Number.isFinite` в `clamp` — одна строка.
- **6 экспортов используются только тестами** (сверка 149 экспортов): `pointer.ts:235 isPointerVisible`,
  `hotkey.ts:58 currentHotkey`, `settings/store.ts:85 settingsWereRecovered`,
  `native/helper.ts:379 helperCursor`, `agent/geometry.ts:47 toFramePoint`,
  `voice/whisper.ts:281 isDownloading`. Это не мусор (они покрыты), но `settingsWereRecovered` — см. A4.3.6.

### A4.8 Итог и порядок

Архитектура **здорова там, где её легче всего было испортить, и больна там, где этого не видно**:
проводка IPC (50 каналов, 37 хендлеров, preload 1:1, 13 push-only) — образцовая и защищена тестом; слои
чистые, циклов нет; строгость TS высокая. А самый большой и самый важный файл — `overlay.ts`, 1 579 строк
с логикой всего продукта, — не покрыт ничем и держит Electron в двух строках.

Дефекты гигиены, которые **стоит** починить (мелкие, механические, поведение не меняется):

| # | файл:строки | что | риск |
|---|---|---|---|
| 1 | `main/ipc.ts:294-296` | убрать второй `app.on('second-instance')` (оставить в `index.ts`) | низкий |
| 2 | `main/ipc.ts:42,298-299` | `PROVIDER_IDS` вывести из `PROVIDERS`, убрать `void PROVIDERS` | низкий |
| 3 | `shared/api.ts:34-39` + `renderer/settings/App.tsx:178` | `hotkeyError?: boolean` в контракт, убрать приведение | низкий |
| 4 | `main/windows.ts:70-72` | `Number.isFinite` в `clamp` | низкий |
| 5 | `main/windows.ts:727-731` | `let settingsBusy` объявить до использующей функции | низкий |
| 6 | `main/windows.ts:722-724` | убрать обёртку `closeSettingsWindowWhenSettled` (имя врёт) | низкий |
| 7 | `main/index.ts:87` | убрать лишние пробелы | низкий |
| 8 | `renderer/settings/App.tsx:711,721,731,784,362-368` | `try`/`catch` по образцу `saveKey` | низкий |

Долг, который **не** решается мелкой правкой и должен стать задачами фазы 3:

| # | что | почему | риск |
|---|---|---|---|
| A | продолжить вынос из `createOverlayController` (1 409 строк, 29 функций) по образцу `turnStream.ts` | 16 % `main` без единого теста; из Electron нужны только `app.hide` и `BrowserWindow.getAllWindows` | **высокий** |
| B | вынести геометрию пузыря (`clamp`/`roomAround`/`xFor`/`yFor`, 20 строк) в `main/bubble.ts`, точка и `workArea` — параметрами | первое, что видит пользователь, и ни одного теста | средний |
| C | разнести `windows.ts` на «окно-карточка» и «окна настроек/онбординга» | два независимых жизненных цикла и 11 `let` в одном модуле | средний |
| D | ESLint + `.editorconfig`; Prettier — отдельным `style:`-коммитом после фазы 3 | 2 находки против 1 377 строк диффа | низкий |

**Нужно подтверждение Александра:**

1. **ESLint (9 + `typescript-eslint` 8, `recommended`, `argsIgnorePattern: '^_'`) и `.editorconfig` —
   добавляем?** Правило 3 разрешает (devDependencies), 2 находки в тестах.
2. **Prettier — после фазы 3 отдельным коммитом, или не добавляем вовсе?**
3. **`settingsWereRecovered` — забытый индикатор (тогда задача в фазу 5) или мёртвый код (тогда удаляем
   вместе с тестами)?**
4. **Дефекты 1 и 8 — это исправления поведения (второй запуск перестанет открывать карточку дважды;
   ошибки в настройках начнут показываться). По правилу 2 чиню только с «ок». Записывать их в `BUGS.md`
   как R8/R9 или сразу в план фазы 3?**
5. **Задачи A–C — в план фазы 3?** Порядок предлагаю B → C → A: от самого локального к самому
   рискованному, и A — только после того, как B и C покажут, что тесты на вынесенном пишутся без моков
   Electron.
