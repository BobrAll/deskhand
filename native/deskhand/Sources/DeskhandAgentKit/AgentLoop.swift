import Foundation
import DeskhandCore
import DeskhandLLM

/// What the loop needs from the tool layer.
///
/// A protocol rather than the concrete executor so the loop's own decisions —
/// when to warn, when to stop, what to keep in the history — can be tested
/// against scripted results instead of a real window.
public protocol ToolRunning: AnyObject, Sendable {
    func call(name: String, arguments: JSONValue, verify: Bool, narration: String?) async -> ToolResult
}

extension ToolExecutor: ToolRunning {}

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
        /// walk, window capture, image encode.
        ///
        /// On by default. A run that feels slow is almost always waiting on one
        /// specific thing, and without the split every phase looks equally
        /// guilty. The cost is a few stderr lines per step.
        public var timings: Bool

        public init(
            maxSteps: Int = 40,
            keepScreenshots: Int = 1,
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
    private let executor: ToolRunning
    private let options: Options
    private let tools: [ToolDefinition]
    private let timingLog = Timings()

    /// How long a run may keep landing on a screen it has already seen.
    ///
    /// A step is 3–6 s of model time, so a stall is expensive long before the
    /// step budget notices. Six steps is enough for a legitimate back-and-forth
    /// (open a dialog, cancel it, open it another way); twelve is not a detour,
    /// it is a loop. Measured on a real run: 19 steps of `super+l`, read,
    /// click, read — none of them the same call twice, so the identical-call
    /// guard never fired.
    private static let stallWarnSteps = 6
    private static let stallStopSteps = 12

    /// What the card is told when a provider refuses the screenshot.
    ///
    /// A notice rather than a stop: the same step is asked again without the
    /// image, so the run continues and only the drawing is lost.
    static let imageRefusalNotice = "Модель не принимает изображения — продолжаю без скриншотов."

    /// The provider's own words for "this model cannot take an image".
    ///
    /// There is no standard code for it, so this reads the body of a 400 or 422.
    /// A miss costs a failed step, not silence — the ordinary error path still
    /// reports it.
    private static func isImageRefusal(_ error: Error) -> Bool {
        guard case let LLMError.http(status, body) = error, status == 400 || status == 422 else {
            return false
        }
        let lower = body.lowercased()
        return ["image", "vision", "multimodal", "modality"].contains { lower.contains($0) }
    }

    private static func hasImages(_ messages: [ChatMessage]) -> Bool {
        messages.contains { !$0.images.isEmpty }
    }

    /// The same history with every image dropped. Text stays: it is what the
    /// model can still read, and the screenshot's description lives there.
    private static func strippedImages(_ messages: [ChatMessage]) -> [ChatMessage] {
        messages.map { message in
            guard !message.images.isEmpty else { return message }
            var copy = message
            copy.images = []
            return copy
        }
    }

    /// Set by the host for one run; nil when nobody is watching.
    public var observer: AgentObserver?

    public init(provider: ChatProvider, executor: ToolRunning, options: Options = Options()) {
        self.provider = provider
        self.executor = executor
        self.options = options
        self.tools = ToolSurface.definitions()
    }

    public static let systemPrompt = """
        You are Deskhand, an agent operating macOS for the user. Act through tools; use get_app_state \
        for the screenshot and indexed accessibility tree.

        Batch predictable actions in one answer: send with type_text(submit: true), open URLs with \
        super+l then type_text(submit: true), fill fields with set_value/type_text and Tab, and use \
        press_key(repeat:) for repeated keys. Element numbers are stable for the whole run: a \
        number always means the same control, and a control that is gone leaves a dead number the \
        tools reject. Read once, then act; refresh only when a new window, filtered list, or \
        unknown value changes what you must do.
        When the last action of a batch changes the screen, its result already carries the fresh \
        tree: act on those indices directly, without calling get_app_state again.
        Calls execute in order; a failure stops the batch. After switching active apps, check which \
        app received input and verify the result on a fresh screen before continuing.

        Accessibility actions work in the background. Real mouse clicks, scrolling, and drags need \
        the target in front; the click tool raises it. Use activate_app only when the user asks to \
        focus/show a window or an unobscured screenshot is needed.

        Prefer indices and set_value over coordinates and pixel clicks. Coordinates are for canvas, \
        video, maps, games, and other content absent from the tree. Treat "contents not exposed" as \
        non-empty but inaccessible; use the suggested field, or inspect the screenshot and verify a \
        pixel action when no addressable route exists. Use get_app_state(include_screenshot: false) \
        for a cheap verification. Do not resend a key/click just because the tree did not change.
        A hidden-item count confirms items exist; a suggested field is the route in: use it and \
        submit. Use set_value to replace a specific field without relying on focus, and type_text \
        to insert at the caret. Prefer keyboard shortcuts to menus; press_key uses xdotool syntax \
        ("super+s", "ctrl+shift+t", "Return"). The last action's tree diff usually verifies success; \
        refresh for new elements, visual-only effects, or uncertainty. Never repeat the same click \
        or key more than twice. For an app absent from the running list, use \
        list_apps(include_installed: true).

        Do not list_apps for an already listed app. Send each key once. State irreversible actions \
        before doing them. Alongside tools, write at most one short 2–4 word caption in the user's \
        language, with no reasoning, plans, or repetition.

        A screen you have already seen is a sign the route is wrong, not a place to try again: \
        when the same window and content come back, change the approach instead of repeating the \
        sequence that led back here.

        """

    /// Runs one task to completion.
    ///
    /// `cancel` is the host's stop button. It is checked at every point where
    /// the loop would otherwise start something expensive — a model request, a
    /// tool call, a capture — so "Стоп" takes effect within one step rather than
    /// at the end of the run. Cancellation is reported as a thrown
    /// `CancellationError`, never as an answer.
    public func run(
        task: String,
        cancel: CancelToken? = nil,
        finalResponseInstruction: String = "When you have no more tools to call, briefly summarize what you did and the outcome in the user's language."
    ) async throws -> String {
        var messages: [ChatMessage] = [ChatMessage(role: .user, text: task)]
        var lastCallSignature: String?
        var repeatCount = 0
        let runClock = TimingClock()
        // Progress, as distinct from activity. A run that keeps landing on the
        // same screen is not doing anything, however many calls it makes, and
        // without this the only bound on that is the step budget — which a real
        // run spent 20 steps of before the user gave up and grabbed the mouse.
        var seenStates = Set<String>()
        var lastProgressStep = 1
        var warnedStall = false
        // Set once a provider refuses images. From then on the run stops asking
        // for screenshots: the model cannot see them anyway, and every call that
        // carried one would pay for a failed request before the retry.
        var imagesRefused = false
        // Counted here rather than read back from `timingLog`: the timing table is
        // opt-in and grouped by label, so it cannot answer "how many calls
        // failed" without the host parsing strings.
        var stepsRun = 0
        var callsRun = 0
        var callsFailed = 0
        // Set by the loop guard. Its own variable rather than a flag on the
        // return value: the run still returns a sentence, and the caller needs
        // to tell "the model finished" from "the guard cut it short" without
        // matching on English text.
        finished = false

        let systemPrompt = Self.systemPrompt + "\n\n" + finalResponseInstruction + "\n\n" + environmentSummary()

        for step in 1...options.maxSteps {
            try Task.checkCancellation()
            try cancel?.check()
            observer?.stepStarted(step, of: options.maxSteps)
            stepsRun = step
            log("step \(step): asking \(provider.config.model)")

            // Mutable because a provider that refuses images is asked the same step
            // again without them, rather than the run ending on a request the
            // user could not have known was impossible.
            var prompt = trimmedHistory(messages)
            var promptBytes = prompt.reduce(0) { $0 + $1.text.utf8.count }
            let stepClock = TimingClock()
            var completion: Completion
            // Streaming is reported as a growing prefix, throttled so a host
            // that resizes a window for every token does not spend the saved
            // latency on layout. The first delta goes out immediately: that is
            // the one the user is waiting for.
            var streamed = ""
            var lastStreamAt = -1.0
            var lastStreamLength = 0
            let onText: (String) -> Void = { delta in
                streamed += delta
                let now = stepClock.milliseconds
                if lastStreamAt < 0 || now - lastStreamAt >= 80 {
                    lastStreamAt = now
                    lastStreamLength = streamed.count
                    self.observer?.stepStreamed(step, text: streamed)
                }
            }
            do {
                completion = try await askModel(prompt, systemPrompt: systemPrompt, onText: onText)
                // The last delta may have arrived inside the throttle window.
                if !streamed.isEmpty, streamed.count != lastStreamLength {
                    self.observer?.stepStreamed(step, text: streamed)
                }
            } catch {
                // The provider refused the picture. Whether a model takes images
                // is not knowable before the call — the user names it, and it may
                // sit behind a proxy — so the refusal itself is the answer. Drop
                // the images, say so once, and keep the run alive.
                guard !imagesRefused, Self.hasImages(prompt), Self.isImageRefusal(error) else {
                    timingLog.record(TimingLabel.model, milliseconds: stepClock.milliseconds)
                    throw error
                }
                imagesRefused = true
                prompt = Self.strippedImages(prompt)
                promptBytes = prompt.reduce(0) { $0 + $1.text.utf8.count }
                streamed = ""
                lastStreamAt = -1
                lastStreamLength = 0
                observer?.loopWarned(Self.imageRefusalNotice)
                log("provider refused images; asking again without them")
                do {
                    completion = try await askModel(prompt, systemPrompt: systemPrompt, onText: onText)
                } catch {
                    timingLog.record(TimingLabel.model, milliseconds: stepClock.milliseconds)
                    throw error
                }
                if !streamed.isEmpty, streamed.count != lastStreamLength {
                    self.observer?.stepStreamed(step, text: streamed)
                }
            }
            let llmMilliseconds = stepClock.milliseconds
            if let record = ModelTrace.record {
                record("model-completion", [
                    "step": .number(Double(step)),
                    "text": .string(completion.text),
                    "stop_reason": completion.stopReason.map(JSONValue.string) ?? .null,
                    "tool_calls": .array(completion.toolCalls.map { call in
                        .object(["id": .string(call.id), "name": .string(call.name), "arguments": call.arguments])
                    }),
                ])
            }
            timingLog.record(TimingLabel.model, milliseconds: llmMilliseconds)
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
            // A reply cut off at the token limit is not a decision to stop. The
            // tool call it was in the middle of did not parse, so it arrives
            // here with no calls and often no text — and the branch below would
            // read that as "the model finished" and end the run with an empty
            // answer, silently throwing away every step already taken. Stopping
            // as unfinished is the honest outcome: the host can say so, and the
            // fix on the user's side is one number in the settings.
            if completion.truncated {
                log("reply truncated at the token limit")
                return finishRun(
                    reason: "the model's reply was cut off at the token limit",
                    answer: "Stopped: the model's reply was cut off at the token limit.",
                    steps: stepsRun, calls: callsRun, failedCalls: callsFailed, clock: runClock)
            }
            if !completion.wantsToolCalls {
                try Task.checkCancellation()
                timingLog.record(TimingLabel.runTotal, milliseconds: runClock.milliseconds)
                observer?.stepAnswered(step, narration: completion.text, calls: [])
                // The only exit where the model decided it was done. Both other
                // exits fall through to the return below.
                finished = true
                reportRun(steps: stepsRun, calls: callsRun, failedCalls: callsFailed, clock: runClock)
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
            var stepFingerprint: String?
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
                    // A warning, not a stop. The model is told what it did wrong
                    // and gets the next step to recover — by then it has seen a
                    // failure it can act on, and cutting the run short would
                    // throw away a task that was one correction from finishing.
                    //
                    // It is reported as its own event rather than `loopStopped`:
                    // this branch does not stop the loop, and a host that took
                    // the old call at its word recorded a run as abandoned when
                    // it went on to succeed.
                    observer?.loopWarned("the same call repeated without a change")
                    messages.append(ChatMessage(
                        role: .tool,
                        text: warning,
                        toolCallID: call.id,
                        isError: true
                    ))
                    continue
                }

                log("tool \(call.name) \(argumentPreview(call.arguments))")
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
                    didFail: result.isError, timings: result.timings)
                log("  -> \(result.isError ? "error: " : "")\(textPreview(result.plainText))")
                if options.timings, !result.timings.describe().isEmpty {
                    log("  ~ \(TimingFormat.duration(wall)): \(result.timings.describe())")
                }

                let text = result.plainText
                messages.append(ChatMessage(
                    role: .tool,
                    text: text.isEmpty ? "(no output)" : text,
                    toolCallID: call.id,
                    isError: result.isError
                ))
                if let fingerprint = result.stateFingerprint { stepFingerprint = fingerprint }

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
                                isError: true
                            ))
                        }
                        log("batch stopped after \(call.name) failed (\(remaining) skipped)")
                    }
                    break batchLoop
                }

                // Screenshots ride on their own user turn, right after the tool
                // result they belong to: the OpenAI and Anthropic schemas both
                // reject images inside tool messages, but both accept them in a
                // user message. `trimmedHistory` drops the older ones.
                let images = (result.isError || imagesRefused) ? [] : result.images
                if !images.isEmpty {
                    messages.append(ChatMessage(
                        role: .user,
                        text: "Screenshot of the current window:",
                        images: images
                    ))
                }
            }

            // Did that step take the task anywhere? A screen the run has already
            // stood on is the cheapest honest answer: an action that leaves the
            // same window in the same state has not moved the task forward, and
            // a run that keeps doing it is not going to finish. A step with no
            // fingerprint at all (a list of apps, a refusal) says nothing about
            // the screen, so it neither counts as progress nor as a stall.
            if let stepFingerprint {
                if seenStates.insert(stepFingerprint).inserted {
                    lastProgressStep = step
                    warnedStall = false
                }
                let stalled = step - lastProgressStep
                if stalled >= Self.stallStopSteps {
                    log("stopping: \(stalled) steps without a new screen")
                    return finishRun(
                        reason: "the run kept returning to a screen it had already seen",
                        answer: "Stopped: \(stalled) steps in a row without a new screen. "
                            + "The same route was taken again, so repeating it will not finish the task.",
                        steps: stepsRun, calls: callsRun, failedCalls: callsFailed, clock: runClock)
                }
                if stalled >= Self.stallWarnSteps, !warnedStall {
                    log("warning: \(stalled) steps without a new screen")
                    observer?.loopWarned("the run keeps returning to the same screen")
                    warnedStall = true
                    messages.append(ChatMessage(
                        role: .user,
                        text: """
                            This is the same screen you have been on for \(stalled) steps. Nothing \
                            has moved, so the next repetition will not move it either: try a \
                            different route — a menu, a keyboard shortcut, or opening the page \
                            directly — or say what is blocking the task.
                            """
                    ))
                }
            }
        }

        return finishRun(
            reason: "the step budget ran out",
            answer: "Stopped after \(options.maxSteps) steps without finishing the task.",
            steps: stepsRun, calls: callsRun, failedCalls: callsFailed, clock: runClock)
    }

    /// Whether the last run ended because the model finished, rather than
    /// because the loop cut it short.
    ///
    /// Read by the host after `run` returns. The loop returns a closing sentence
    /// on every path, so the answer alone cannot carry this: a run that stopped
    /// at its budget and a run that finished both produce one, and only this
    /// tells them apart.
    public private(set) var finished = false

    /// The timing table, for the CLI to print after the run.
    public func timingReport() -> String {
        timingLog.report()
    }

    /// Ends the run on a path the loop chose rather than one the model chose.
    ///
    /// The order is the contract: the total is recorded before the report reads
    /// it back, and the verdict reaches the host before the report does.
    private func finishRun(
        reason: String,
        answer: String,
        steps: Int,
        calls: Int,
        failedCalls: Int,
        clock: TimingClock
    ) -> String {
        timingLog.record(TimingLabel.runTotal, milliseconds: clock.milliseconds)
        observer?.loopStopped(reason)
        reportRun(steps: steps, calls: calls, failedCalls: failedCalls, clock: clock)
        return answer
    }

    /// Hands the host the run's totals exactly once.
    ///
    /// Called at every exit of the loop and nowhere else: a report emitted from a
    /// cancellation path as well would arrive twice, and the second one would
    /// describe a run that had already been accounted for.
    private func reportRun(steps: Int, calls: Int, failedCalls: Int, clock: TimingClock) {
        let rows = timingLog.grouped()
        let llm = rows.first { $0.label == TimingLabel.model }?.total ?? 0
        let tools = rows.filter { $0.label.hasPrefix(TimingLabel.toolPrefix) }
            .reduce(0) { $0 + $1.total }
        observer?.runFinished(RunReport(
            steps: steps,
            calls: calls,
            failedCalls: failedCalls,
            totalMilliseconds: clock.milliseconds,
            llmMilliseconds: llm,
            toolMilliseconds: tools,
            table: options.timings ? timingLog.report() : ""
        ))
    }

    private func recordToolTimings(_ tool: ToolTimings, name: String) {
        guard options.timings else { return }
        if tool.tree > 0 { timingLog.record(TimingLabel.treeWalk, milliseconds: tool.tree) }
        if tool.capture > 0 { timingLog.record(TimingLabel.screenshot, milliseconds: tool.capture) }
        if tool.encode > 0 { timingLog.record(TimingLabel.imageEncode, milliseconds: tool.encode) }
        if tool.screenshotBytes > 0 {
            timingLog.record(TimingLabel.screenshotBytes, milliseconds: 0, bytes: tool.screenshotBytes)
        }
        timingLog.record(TimingLabel.tool(name), milliseconds: tool.wall)
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
    /// One model call, streaming when the provider supports it.
    ///
    /// Extracted so the step can be asked twice: once with the screenshots the
    /// run has accumulated, and once without them after a provider refuses an
    /// image. The retry is the same question, so nothing about the call changes.
    private func askModel(
        _ messages: [ChatMessage],
        systemPrompt: String,
        onText: @escaping (String) -> Void
    ) async throws -> Completion {
        if let streaming = provider as? StreamingChatProvider {
            return try await streaming.complete(
                messages: messages,
                tools: tools,
                systemPrompt: systemPrompt,
                onText: onText
            )
        }
        return try await provider.complete(
            messages: messages,
            tools: tools,
            systemPrompt: systemPrompt
        )
    }

    func trimmedHistory(_ messages: [ChatMessage]) -> [ChatMessage] {
        var seenImages = 0
        var treesKeptPerApp: [String: Int] = [:]
        var keptApps: [String] = []
        var diffsKept = 0
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

            // What an action changed is only worth its lines until the next
            // action changes something else: a diff describes a transition, and
            // a transition three steps back is history that no longer matches
            // anything on screen. They are also the second-biggest thing in a
            // long run — measured 44 KB of a 169 KB prompt on a 30-step run —
            // and every byte is paid again on every following round trip.
            if copy.role == .tool, copy.text.contains(Self.diffMarkerPrefix) {
                diffsKept += 1
                if diffsKept > 1 {
                    copy.text = Self.compactDiff(in: copy.text)
                }
            }

            if copy.role == .tool, copy.text.contains(Self.treeMarkerPrefix) {
                let app = Self.appKey(forTreeMessage: copy.text)
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
    static func appKey(forTreeMessage text: String) -> String {
        guard let close = text.firstIndex(of: "]"),
              let open = text[text.startIndex..<close].lastIndex(of: "[") else {
            return String(text.prefix(40))
        }
        return String(text[text.index(after: open)..<close])
    }

    static let treeMarkerPrefix = "Accessibility tree ("

    /// Where a tool result starts describing what the action changed.
    static let diffMarkerPrefix = "Changed after "

    /// Cuts the "what changed" block out of a result that a later action has
    /// already superseded.
    ///
    /// The tree below it, if any, is left alone: it is either the newest tree of
    /// its app — which the model still needs — or it is compacted by its own
    /// rule a few lines down.
    static func compactDiff(in text: String) -> String {
        guard let start = text.range(of: diffMarkerPrefix) else { return text }
        let tree = text.range(of: treeMarkerPrefix, range: start.lowerBound..<text.endIndex)
        let end = tree?.lowerBound ?? text.endIndex
        return String(text[text.startIndex..<start.lowerBound])
            + "Changed after that: the details are superseded by a later action.\n"
            + String(text[end...])
    }

    /// Cuts the tree section out of a tool result, keeping the cheap header.
    ///
    /// The tree is always the last block of a `get_app_state` result, so
    /// everything from the marker on can go.
    static func compactTree(in text: String) -> String {
        guard let range = text.range(of: treeMarkerPrefix) else { return text }
        let header = text[text.startIndex..<range.lowerBound]
        return header + "Accessibility tree omitted to keep the prompt small. Element numbers "
            + "are stable, so the indices you already used still mean the same controls."
    }

    private func argumentPreview(_ arguments: JSONValue) -> String {
        let text = arguments.serialized()
        return text.count > 220 ? String(text.prefix(220)) + "…" : text
    }

    private func textPreview(_ text: String) -> String {
        let single = text.replacingOccurrences(of: "\n", with: " ⏎ ")
        return single.count > 200 ? String(single.prefix(200)) + "…" : single
    }

    private func log(_ message: String) {
        guard options.verbose else { return }
        FileHandle.standardError.write(Data(("[deskhand] " + message + "\n").utf8))
    }
}
