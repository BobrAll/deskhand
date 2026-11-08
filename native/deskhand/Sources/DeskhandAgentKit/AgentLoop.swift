import Foundation
import DeskhandCore
import DeskhandLLM

/// Drives one task to completion: ask the model, run its tool calls, feed the
/// results back, repeat.
///
/// Design notes:
///
/// * Wall time is dominated by model round trips, not by the work. Every
///   optimisation here therefore aims at *fewer turns* and *smaller history*,
///   not at faster tooling.
/// * Screenshots are the most expensive thing in the history. The loop keeps
///   the last few and drops older image blocks.
/// * Accessibility trees are the second most expensive thing, and worse, a
///   stale tree is a trap: its indices look usable but belong to an older
///   snapshot. Only the newest tree is kept in full; older ones are replaced by
///   a one-line marker.
/// * A repeated identical tool call with an unchanged screen is treated as a
///   stuck loop and reported, rather than burning the remaining budget.
/// * Every action is logged to stderr so the user can watch what is happening
///   on their machine.
public final class AgentLoop {
    public struct Options: Sendable {
        public var maxSteps: Int
        public var keepScreenshots: Int
        /// How many apps may keep a full tree in the history. Only the newest
        /// tree per app is kept; older ones are replaced by a marker.
        public var keepTrees: Int
        public var verbose: Bool
        /// Ask the executor to append an accessibility diff to the last action
        /// of each batch, so the model learns whether it worked without
        /// spending a whole turn on `get_app_state`.
        public var verifyActions: Bool
        /// Print how long each phase took: model round trip, accessibility
        /// walk, window capture, PNG encode.
        ///
        /// On by default. A run that feels slow is almost always waiting on one
        /// specific thing, and without the split every phase looks equally
        /// guilty. The cost is a few stderr lines per step.
        public var timings: Bool

        public init(
            maxSteps: Int = 40,
            keepScreenshots: Int = 2,
            keepTrees: Int = 3,
            verbose: Bool = true,
            verifyActions: Bool = true,
            timings: Bool = true
        ) {
            self.maxSteps = maxSteps
            self.keepScreenshots = keepScreenshots
            self.keepTrees = keepTrees
            self.verbose = verbose
            self.verifyActions = verifyActions
            self.timings = timings
        }
    }

    private let provider: ChatProvider
    private let executor: ToolExecutor
    private let options: Options
    private let tools: [ToolDefinition]
    private let timings = Timings()
    /// Set by the host for one run; nil when nobody is watching.
    public var observer: AgentObserver?

    public init(provider: ChatProvider, executor: ToolExecutor, options: Options = Options()) {
        self.provider = provider
        self.executor = executor
        self.options = options
        self.tools = ToolSurface.definitions()
    }

    public static let systemPrompt = """
        You are Deskhand, an agent that operates a macOS computer on the user's behalf.

        You act by calling tools. You cannot see the screen except through get_app_state, which \
        returns a screenshot and an indexed accessibility tree of the frontmost window of one app.

        ## Batch your actions

        Each answer you give costs a full model round trip — several seconds. The single largest \
        speed-up available to you is putting every step you can predict into one answer. Tools in \
        one answer run in order, and the batch stops only if a call fails.

        Default to batching. A lone tool call is the exception, not the pattern:

        - Sending a message: type_text with submit: true — it types and presses Return in one call.
        - Opening a URL: press_key "super+l", then type_text the URL with submit: true.
        - Searching: set_value the search field with submit: true.
        - Filling a form: set_value or type_text for every field, then press_key "Tab" between \
        them, then Return — one answer.
        - Typing into a field that is not focused: click it, then type_text, then Return.
        - Repeating a key: press_key with repeat set, instead of several calls.
        - Opening a known menu path: the clicks that get there, in order.

        Element indices stay valid across click, type_text, press_key and scroll: those do not \
        re-read the tree, so you can chain them without re-checking. Only get_app_state replaces \
        the indices. This is what makes batching safe — you do not have to look between steps.

        Read the tree once, then act in one answer: get_app_state, then every action the layout \
        implies. Only stop early when the next step genuinely depends on what you have not seen \
        yet — a new window, a filtered list, a value you must read first.

        ## Working without stealing focus

        Reading an app, pressing its elements, setting a value and sending it keys all work while \
        it stays in the background, so none of that moves the user's own window. Keep it that way: \
        it is faster and it does not interrupt whatever the user is doing.

        What does need the app in front is a real mouse gesture — a click at x/y, a scroll, a \
        drag — because the system delivers those to whatever is frontmost. The click tool raises \
        the window by itself in that case; you do not have to ask for it.

        Use activate_app only when the user asks to see or focus a window, or when a screenshot \
        has to show it unobscured. Do not call it as a warm-up before typing.

        The last action of a batch comes back with a short list of what changed in the \
        accessibility tree. That is usually enough to confirm success; call get_app_state only \
        when you need to see the screen or address an element that is new.

        ## Rules that matter

        - Call get_app_state when you do not know the app's layout, or when you need to see \
        something visual. Do not call it after every action just to confirm.
        - To verify cheaply, call get_app_state with include_screenshot: false. It skips the \
        screenshot (the slow part) and still refreshes the indices.
        - Prefer element indices over pixel coordinates. Use coordinates only for content that is \
        not in the tree: canvas, video, maps, games, images.
        - A node marked "(contents not exposed: ...)" is a region whose children the app refuses \
        to list — a chat list, a table, a canvas, a custom-drawn view. Its contents are on screen \
        but not addressable, so no index inside it exists. Do not read it as empty. When the \
        marker gives a count ("11 items not exposed"), the region is definitely not empty: there \
        are items there, you simply cannot address them by index. When it names an element \
        ("type into element 16 to reach them"), that field is your way in — use it and press \
        Return. Only when it says "no addressable way in" should you fall back to reading the \
        screenshot and clicking a pixel, and expect to verify the result then, because a pixel \
        inside such a region is a guess.
        - Prefer set_value over typing when you are replacing a field's contents; prefer type_text \
        when inserting at the caret.
        - To put text into a specific field, do not click a pixel and then type: if the click \
        misses, the typing lands in whatever really has focus and the result looks empty while \
        the text went somewhere else. Use set_value with the field's index — it addresses the \
        field directly, needs no focus, and works on an occluded window.
        - One key press is enough. Do not send Return twice "to be sure": the first one usually \
        did the job and the second submits an empty box or fires a shortcut. If you are unsure, \
        read the state instead of pressing again.
        - Keyboard shortcuts are usually more reliable than clicking menus. press_key uses \
        xdotool syntax, e.g. "super+s", "ctrl+shift+t", "Return".
        - The apps already running are listed below. Do not call list_apps to find an app you can \
        already see there; call it only when you need an app that is not running, and pass \
        include_installed: true.
        - When a tool reports "no change in the accessibility tree", that is a hint to look, not \
        a failure to retry. The effect may be visual only. Read the state once, decide, and do \
        not resend the same key or click more than twice.
        - Before any irreversible action (sending a message, deleting a file, making a purchase), \
        state what you are about to do.

        ## How to talk

        Alongside a tool call, write at most one short line naming what you are doing: two to four \
        words, no full sentences, no reasoning, no restating the task. It is a caption the user \
        reads while watching, not a plan.

        - "Открываю Telegram", "Запускаю видео", "Отправляю сообщение", "Ищу чат".
        - Answer in the user's language.

        Do not narrate what you have not done yet, and do not explain your reasoning — the tool \
        calls already show it. Say nothing at all rather than padding the line.

        When you have no more tools to call, reply with a short summary of what you did, in the \
        user's language. Two or three lines at most: what you did and what came of it.
        """

    /// Runs one task to completion.
    ///
    /// `cancel` is the host's stop button. It is checked at every point where
    /// the loop would otherwise start something expensive — a model request, a
    /// tool call, a capture — so "Стоп" takes effect within one step rather than
    /// at the end of the run. Cancellation is reported as a thrown
    /// `CancellationError`, never as an answer.
    public func run(task: String, cancel: CancelToken? = nil) async throws -> String {
        var messages: [ChatMessage] = [ChatMessage(role: .user, text: task)]
        var lastCallSignature: String?
        var repeatCount = 0
        let runClock = TimingClock()
        // Counted here rather than read back from `timings`: the timing table is
        // opt-in and grouped by label, so it cannot answer "how many calls
        // failed" without the host parsing strings.
        var stepsRun = 0
        var callsRun = 0
        var callsFailed = 0

        let systemPrompt = Self.systemPrompt + "\n\n" + environmentSummary()

        for step in 1...options.maxSteps {
            try Task.checkCancellation()
            try cancel?.check()
            observer?.stepStarted(step, of: options.maxSteps)
            stepsRun = step
            log("step \(step): asking \(provider.config.model)")

            let prompt = trim(messages)
            let promptBytes = prompt.reduce(0) { $0 + $1.text.utf8.count }
            let stepClock = TimingClock()
            let completion: Completion
            do {
                completion = try await provider.complete(
                    messages: prompt,
                    tools: tools,
                    systemPrompt: systemPrompt
                )
            } catch {
                timings.record("llm", milliseconds: stepClock.milliseconds)
                throw error
            }
            let llmMilliseconds = stepClock.milliseconds
            timings.record("llm", milliseconds: llmMilliseconds)
            // The host records this as the step's cost. It is emitted before the
            // branch below so the step that ends the run is timed too: the last
            // round trip is usually the most expensive one, and a timeline that
            // stops one line short of the answer is a timeline nobody trusts.
            observer?.stepTimed(step, timing: StepTiming(
                llmMilliseconds: llmMilliseconds,
                promptBytes: promptBytes,
                historyMessages: prompt.count,
                callCount: completion.toolCalls.count,
                inputTokens: completion.usage?.inputTokens,
                outputTokens: completion.usage?.outputTokens
            ))

            // Only narration that leads into tool calls is logged; the final
            // answer is printed once by the CLI, so echoing it here too would
            // duplicate it.
            if !completion.text.isEmpty, completion.wantsToolCalls {
                log("assistant: \(completion.text.prefix(400))")
            }
            if options.timings {
                logTiming(step: step, llm: llmMilliseconds, promptBytes: promptBytes,
                          history: prompt.count, completion: completion)
            }

            try cancel?.check()
            if !completion.wantsToolCalls {
                try Task.checkCancellation()
                timings.record("run total", milliseconds: runClock.milliseconds)
                observer?.stepAnswered(step, narration: completion.text, calls: [])
                reportRun(steps: stepsRun, calls: callsRun, failed: callsFailed, clock: runClock)
                return completion.text
            }

            observer?.stepAnswered(step, narration: completion.text, calls: completion.toolCalls)

            messages.append(ChatMessage(
                role: .assistant,
                text: completion.text,
                toolCalls: completion.toolCalls
            ))

            // The executor is asked to verify only the last call of the batch:
            // an intermediate step would pay for a tree walk nobody reads.
            let batch = completion.toolCalls
            batchLoop: for (position, call) in batch.enumerated() {
                try Task.checkCancellation()
                let isLast = position == batch.count - 1
                let signature = call.name + call.arguments.serialized()
                if signature == lastCallSignature {
                    repeatCount += 1
                } else {
                    repeatCount = 0
                    lastCallSignature = signature
                }

                if repeatCount >= 2 {
                    let warning = """
                        You have called \(call.name) with the same arguments three times without a \
                        change. Re-read the app state with get_app_state and try a different approach.
                        """
                    log("loop guard triggered on \(call.name)")
                    observer?.loopStopped("the same call repeated without a change")
                    messages.append(ChatMessage(
                        role: .tool,
                        text: warning,
                        toolCallID: call.id,
                        toolIsError: true
                    ))
                    continue
                }

                log("tool \(call.name) \(preview(call.arguments))")
                observer?.toolStarted(step, call: call, narration: completion.text)
                let callClock = TimingClock()
                let result = await executor.call(
                    name: call.name,
                    arguments: call.arguments,
                    verify: options.verifyActions && isLast,
                    narration: completion.text
                )
                let wall = callClock.milliseconds
                callsRun += 1
                if result.isError { callsFailed += 1 }
                recordToolTimings(result.timings, name: call.name)
                observer?.toolFinished(
                    step, call: call, text: result.plainText,
                    isError: result.isError, timings: result.timings)
                log("  -> \(result.isError ? "error: " : "")\(previewText(result.plainText))")
                if options.timings, !result.timings.describe().isEmpty {
                    log("  ~ \(TimingFormat.duration(wall)): \(result.timings.describe())")
                }

                let text = result.plainText
                messages.append(ChatMessage(
                    role: .tool,
                    text: text.isEmpty ? "(no output)" : text,
                    toolCallID: call.id,
                    toolIsError: result.isError
                ))

                // A failed step invalidates the assumptions the later steps in
                // the batch were built on: after a `super+l` that did not take,
                // typing the URL lands in whatever did have focus, and after a
                // missed click, typing goes nowhere. Running them anyway does
                // damage and then hides it, because each result reports "no
                // change" as if it were merely uninformative. Stop here and let
                // the model look again.
                if result.isError {
                    let remaining = batch.count - position - 1
                    if remaining > 0 {
                        let note = """
                            Stopped the batch here: this step failed, so the \(remaining) step(s)                             after it would run against a state they were not planned for. Re-read                             the app state before continuing.
                            """
                        for skipped in batch[(position + 1)...] {
                            messages.append(ChatMessage(
                                role: .tool,
                                text: note,
                                toolCallID: skipped.id,
                                toolIsError: true
                            ))
                        }
                        log("batch stopped after \(call.name) failed (\(remaining) skipped)")
                    }
                    break batchLoop
                }

                // Screenshots ride on their own user turn, right after the tool
                // result they belong to: the OpenAI and Anthropic schemas both
                // reject images inside tool messages, but both accept them in a
                // user message. `trim` drops the older ones.
                let images = result.isError ? [] : result.images
                if !images.isEmpty {
                    messages.append(ChatMessage(
                        role: .user,
                        text: "Screenshot of the current window:",
                        images: images
                    ))
                }
            }
        }

        timings.record("run total", milliseconds: runClock.milliseconds)
        observer?.loopStopped("the step budget ran out")
        reportRun(steps: stepsRun, calls: callsRun, failed: callsFailed, clock: runClock)
        return "Stopped after \(options.maxSteps) steps without finishing the task."
    }

    /// The timing table, for the CLI to print after the run.
    public func timingReport() -> String {
        timings.report()
    }

    /// Hands the host the run's totals exactly once.
    ///
    /// Called at both exits of the loop and nowhere else: a report emitted from a
    /// cancellation path as well would arrive twice, and the second one would
    /// describe a run that had already been accounted for.
    private func reportRun(steps: Int, calls: Int, failed: Int, clock: TimingClock) {
        let rows = timings.grouped()
        let llm = rows.first { $0.label == "llm" }?.total ?? 0
        let tools = rows.filter { $0.label.hasPrefix("tool ") }.reduce(0) { $0 + $1.total }
        observer?.runFinished(RunReport(
            steps: steps,
            calls: calls,
            failedCalls: failed,
            totalMilliseconds: clock.milliseconds,
            llmMilliseconds: llm,
            toolMilliseconds: tools,
            table: options.timings ? timings.report() : ""
        ))
    }

    private func recordToolTimings(_ tool: ToolTimings, name: String) {
        guard options.timings else { return }
        if tool.tree > 0 { timings.record("  tree walk", milliseconds: tool.tree) }
        if tool.capture > 0 { timings.record("  screenshot", milliseconds: tool.capture) }
        if tool.encode > 0 { timings.record("  png encode", milliseconds: tool.encode) }
        if tool.screenshotBytes > 0 {
            timings.record("  screenshot bytes", milliseconds: 0, bytes: tool.screenshotBytes)
        }
        timings.record("tool \(name)", milliseconds: tool.wall)
    }

    /// One line per step, so a stall can be attributed while it happens rather
    /// than reconstructed after the run.
    ///
    /// The interesting number is not any single phase but the ratio: when the
    /// model takes seconds and the tool takes milliseconds, the loop has to cut
    /// round trips; when the walk or the capture dominates, no prompt change
    /// will help. `SLOW` marks a step whose non-model work crossed the point
    /// where a user notices the pause.
    private func logTiming(
        step: Int,
        llm: Double,
        promptBytes: Int,
        history: Int,
        completion: Completion
    ) {
        var line = "timing step \(step): llm \(TimingFormat.duration(llm))"
        if !completion.toolCalls.isEmpty {
            line += ", \(completion.toolCalls.count) call\(completion.toolCalls.count == 1 ? "" : "s")"
        }
        line += ", prompt \(TimingFormat.bytes(promptBytes))/\(history) msg"
        if let usage = completion.usage, usage.outputTokens > 0 {
            line += ", \(usage.inputTokens)→\(usage.outputTokens) tok"
        }
        log(line)
    }

    /// Running apps, listed once in the system prompt.
    ///
    /// This exists so the model does not spend a turn on `list_apps` for the
    /// common case. It is generated per run, not cached, because a run may
    /// launch apps as it goes.
    private func environmentSummary() -> String {
        let apps = AppCatalog.runningApps()
        guard !apps.isEmpty else { return "" }
        var lines = ["## Apps running right now", ""]
        for app in apps {
            lines.append("- \(app.name)")
        }
        lines.append("")
        lines.append("Pass the app name to get_app_state and the other tools.")
        return lines.joined(separator: "\n")
    }

    /// Keeps the conversation bounded.
    ///
    /// Two kinds of bulk live in the history: screenshots and accessibility
    /// trees. Screenshots are capped by count. Trees are replaced by a marker
    /// once a newer tree exists, for two reasons: a browser tree is thousands
    /// of tokens, and every tree but the newest advertises indices that no
    /// longer resolve to what the model thinks they do.
    ///
    /// The tree cap is **per app**, not global. A run that moves between two
    /// windows — a browser and a chat client, say — would otherwise throw away
    /// the other app's tree on every switch and make the model re-read 500-node
    /// trees over and over to recover indices it already had. Keeping the
    /// newest tree of each app preserves the "indices stay valid" promise
    /// across switches while still bounding growth by `keepTrees` apps, most
    /// recently seen first.
    func trim(_ messages: [ChatMessage]) -> [ChatMessage] {
        var seenImages = 0
        var treesKeptPerApp: [String: Int] = [:]
        var keptApps: [String] = []
        var result: [ChatMessage] = []

        for message in messages.reversed() {
            var copy = message

            if !copy.images.isEmpty {
                seenImages += 1
                if seenImages > options.keepScreenshots {
                    copy.images = []
                    if copy.text.isEmpty { continue }
                }
            }

            if copy.role == .tool, copy.text.contains(Self.treeMarkerPrefix) {
                let app = Self.appKey(ofTreeMessage: copy.text)
                let seen = treesKeptPerApp[app, default: 0]
                let appAlreadyCounted = keptApps.contains(app)
                if !appAlreadyCounted {
                    if keptApps.count >= options.keepTrees {
                        copy.text = Self.compactTree(in: copy.text)
                        result.append(copy)
                        continue
                    }
                    keptApps.append(app)
                }
                treesKeptPerApp[app] = seen + 1
                if seen >= 1 {
                    // Only the newest tree per app is authoritative; an older
                    // one advertises indices that no longer resolve to what the
                    // model thinks they do.
                    copy.text = Self.compactTree(in: copy.text)
                }
            }

            result.append(copy)
        }
        return result.reversed()
    }

    /// Which app a `get_app_state` result came from.
    ///
    /// The header is `Name [bundle.id] — window "Title"`, so the bracketed
    /// bundle identifier is the stable key. Falling back to the whole header
    /// keeps unparseable results from all sharing one bucket.
    static func appKey(ofTreeMessage text: String) -> String {
        guard let close = text.firstIndex(of: "]"),
              let open = text[text.startIndex..<close].lastIndex(of: "[") else {
            return String(text.prefix(40))
        }
        return String(text[text.index(after: open)..<close])
    }

    static let treeMarkerPrefix = "Accessibility tree ("

    /// Cuts the tree section out of a tool result, keeping the cheap header.
    ///
    /// The tree is always the last block of a `get_app_state` result, so
    /// everything from the marker on can go.
    static func compactTree(in text: String) -> String {
        guard let range = text.range(of: treeMarkerPrefix) else { return text }
        let header = text[text.startIndex..<range.lowerBound]
        return header + "Accessibility tree omitted: it is stale, and its element indices no "
            + "longer resolve. Use the newest tree in the conversation."
    }

    private func preview(_ arguments: JSONValue) -> String {
        let text = arguments.serialized()
        return text.count > 220 ? String(text.prefix(220)) + "…" : text
    }

    private func previewText(_ text: String) -> String {
        let single = text.replacingOccurrences(of: "\n", with: " ⏎ ")
        return single.count > 200 ? String(single.prefix(200)) + "…" : single
    }

    private func log(_ message: String) {
        guard options.verbose else { return }
        FileHandle.standardError.write(Data(("[deskhand] " + message + "\n").utf8))
    }
}
