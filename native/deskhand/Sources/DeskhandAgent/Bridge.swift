import Foundation
import AppKit
import ApplicationServices
import DeskhandCore
import DeskhandLLM
import DeskhandAgentKit

/// The sidecar protocol.
///
/// One JSON object per line, in both directions. Requests come from the app and
/// carry an `id`; events go the other way and carry an `event` name. There is no
/// handshake beyond `ready`, because the only peer is the app that spawned this
/// process.
///
/// The split of responsibility is the point of this file: the app owns the
/// window, the settings, the API key and every decision about what the agent may
/// do; this process owns everything that touches the machine — the accessibility
/// tree, the screenshot, the mouse and the keyboard. Nothing here decides
/// policy. Before a mutating tool runs, the bridge asks the app and waits, so a
/// question in the app's own card is the only thing between the model and the
/// click.
final class Bridge: @unchecked Sendable {
    @TaskLocal private static var traceRunID: String?

    private let writer = LineWriter()
    private let lock = NSLock()

    /// The run in flight, if any. One at a time: two agents driving the same
    /// pointer would interleave clicks, and the second would be acting on a
    /// screen the first had already changed. A cancelled run keeps the slot
    /// until it has actually unwound — a drag, a scroll or a `type_text` is
    /// already in the window server when the token is raised.
    private var activeRun: ActiveRun?

    /// A run and the signal that it has let go of the machine.
    ///
    /// The token stops the loop; the semaphore tells the next `run` when the
    /// stopped task has finished its last call and released the slot.
    private struct ActiveRun {
        let token: CancelToken
        let finished: DispatchSemaphore
    }

    /// Approvals waiting for the app's answer, keyed by request id.
    private var pendingApprovals: [String: ApprovalWait] = [:]
    private var approvalCounter = 0

    /// How long a question waits for the app before it is denied.
    private static let approvalTimeout: TimeInterval = 600
    /// How often the wait wakes up, so a cancel lands while a question is open.
    private static let approvalPollInterval: TimeInterval = 0.1

    /// How long a new run waits for a cancelled one to finish its last call.
    ///
    /// The loop checks the token between steps and tool calls, so a cancel can
    /// land in the middle of a drag, a scroll or a `type_text` that is already
    /// inside the window server. The wait only has to cover one such call; if
    /// it expires, the new run is rejected as before, which is safer than two
    /// agents on one pointer. Five seconds stays well inside the host's own
    /// ten-second wait for `started`.
    private static let runUnwindTimeout: TimeInterval = 5

    /// What a run request is told when another run still owns the machine.
    ///
    /// Reached only for a genuinely concurrent run, or when a stopped one took
    /// longer than `runUnwindTimeout` to let go.
    private static let runBusyMessage = "a run is already in progress"

    /// The model-facing refusal when the user stops the run.
    ///
    /// English like every other tool result: the model reads this string, not
    /// the user, and a Russian refusal in an English conversation is noise the
    /// model has to interpret.
    private static let cancelledMessage = "The run was cancelled by the user."

    private final class ApprovalWait: @unchecked Sendable {
        let semaphore = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var decision: ToolPolicyDecision = .deny("The user did not answer.")

        func resolve(_ value: ToolPolicyDecision) {
            lock.lock()
            decision = value
            lock.unlock()
            semaphore.signal()
        }

        var value: ToolPolicyDecision {
            lock.lock()
            defer { lock.unlock() }
            return decision
        }
    }

    // MARK: - Reading

    /// Reads requests until the app closes the pipe.
    ///
    /// Runs on its own thread: the main thread has to keep the run loop pumping
    /// for the window server, and a read loop sharing it would never see a
    /// `cancel` arrive while a tool was running.
    func readLoop() {
        var buffer = Data()
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer[buffer.startIndex..<newline]
                buffer.removeSubrange(buffer.startIndex...newline)
                guard var line = String(data: lineData, encoding: .utf8) else { continue }
                if line.hasSuffix("\r") { line.removeLast() }
                if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                handleRequest(line)
            }
        }
        // stdin closed: the app is gone, and a run with nobody watching is a run
        // nobody can stop.
        cancelRun()
        exit(0)
    }

    private func handleRequest(_ line: String) {
        guard let value = try? JSONValue.parse(line), let message = value.objectValue else {
            emit(["event": .string("error"), "params": .object([
                "message": .string("could not parse a request line"),
            ])])
            return
        }
        let id = message["id"]
        let method = message["method"]?.stringValue ?? ""
        let params = message["params"] ?? .object([:])

        switch method {
        case "ping":
            respond(id: id, result: .object(["pong": .bool(true)]))
        case "permissions":
            let status = SystemPermissions.current()
            respond(id: id, result: .object([
                "accessibility": .bool(status.accessibility),
                "screen_recording": .bool(status.screenRecording),
            ]))
        case "run":
            startRun(id: id, params: params)
        case "cancel":
            cancelRun()
            respond(id: id, result: .object(["cancelled": .bool(true)]))
        case "approval":
            resolveApproval(params: params)
            respond(id: id, result: .object(["ok": .bool(true)]))
        case "shutdown":
            cancelRun()
            exit(0)
        default:
            respond(id: id, error: "unknown method \"\(method)\"")
        }
    }

    // MARK: - Run

    private func startRun(id: JSONValue?, params: JSONValue) {
        guard let task = params["task"]?.stringValue, !task.isEmpty else {
            respond(id: id, error: "run needs a task")
            return
        }

        lock.lock()
        // Escape stopped the previous run, but its task may still be inside a
        // tool call. Wait for it to let go of the pointer instead of rejecting
        // a run the user just asked for with a message they cannot act on.
        if let running = activeRun, running.token.isCancelled {
            lock.unlock()
            if running.finished.wait(timeout: .now() + Self.runUnwindTimeout) == .timedOut {
                respond(id: id, error: Self.runBusyMessage)
                return
            }
            lock.lock()
        }
        if activeRun != nil {
            lock.unlock()
            respond(id: id, error: Self.runBusyMessage)
            return
        }
        let handle = CancelToken()
        activeRun = ActiveRun(token: handle, finished: DispatchSemaphore(value: 0))
        lock.unlock()

        let config: ProviderConfig
        do {
            config = try providerConfig(from: params["provider"])
        } catch {
            finishRun(handle)
            respond(id: id, error: "\(error)")
            return
        }

        let permissions = SystemPermissions.current()
        guard permissions.accessibility else {
            finishRun(handle)
            emit(["event": .string("error"), "params": .object([
                "message": .string("Нет разрешения «Универсальный доступ»."),
                "code": .string("accessibility"),
            ])])
            respond(id: id, error: "accessibility permission is required")
            return
        }

        let options = loopOptions(from: params["options"])
        let excluded = Set((params["options"]?["excluded_apps"]?.arrayValue ?? [])
            .compactMap(\.stringValue))
        let executor = ToolExecutor(excludedBundleIds: excluded)
        let provider = ProviderFactory.make(config: config)
        let loop = AgentLoop(provider: provider, executor: executor, options: options)
        loop.observer = BridgeObserver(bridge: self)
        executor.policy = BridgePolicy(bridge: self, cancel: handle)
        // A run with nobody watching is the same run without a presenter. The
        // app asks for one explicitly, so the background mode that comes later
        // is the absence of this flag rather than a different code path.
        if params["options"]?["visualize"]?.boolValue ?? false {
            executor.presenter = BridgePresenter(bridge: self)
        }

        respond(id: id, result: .object(["started": .bool(true)]))

        // The run lives on its own task and the main thread keeps the run loop
        // pumping: `NSRunningApplication.activate` and ScreenCaptureKit both
        // deliver their replies to it, and parking the main thread turns every
        // activation into a one-second timeout.
        let traceRunID = params["options"]?["trace_run_id"]?.stringValue
        let record = modelTraceRecorder(runID: traceRunID)
        Task.detached { [weak self] in
            await Self.$traceRunID.withValue(traceRunID) {
                await ModelTrace.$record.withValue(record) {
                    await self?.executeRun(loop: loop, executor: executor, handle: handle, task: task)
                }
            }
        }
    }

    /// Where the providers report what they sent and received, or nil when the
    /// host did not ask for a per-run trace.
    ///
    /// The recorder is the same event pipe as everything else, so the trace
    /// arrives with the run's own `trace_run_id` and the host can file it in the
    /// right run without a second protocol.
    private func modelTraceRecorder(
        runID: String?
    ) -> (@Sendable (String, [String: JSONValue]) -> Void)? {
        guard runID != nil else { return nil }
        return { [weak self] event, fields in
            self?.emit(["event": .string(event), "params": .object(fields)])
        }
    }

    private func executeRun(loop: AgentLoop, executor: ToolExecutor, handle: CancelToken, task: String) async {
        var answer: String?
        var failure: String?
        do {
            answer = try await loop.run(
                task: task,
                cancel: handle,
                finalResponseInstruction: """
                    When the requested action succeeded as requested and there is nothing else the user \
                    needs to know, reply with exactly [[ACTION_DONE]]. If the user asked for information, \
                    the outcome is uncertain or partial, or there is a caveat or follow-up the user needs, \
                    give that information briefly in the user's language. Do not repeat the completed steps.
                    """
            )
        } catch is CancellationError {
            answer = nil
        } catch {
            failure = "\(error)"
        }
        executor.shutdown()
        finishRun(handle)
        if let answer {
            // `complete` is the verdict, not an inference from the sentence.
            // The loop returns a closing line on every path, so a host that
            // only had the text could not tell "the model finished" from
            // "the budget ran out" — and the app drew a checkmark over the
            // second one.
            self.emit(["event": .string("done"), "params": .object([
                "answer": .string(answer),
                "complete": .bool(loop.finished),
            ])])
        } else if let failure {
            self.emit(["event": .string("error"), "params": .object([
                "message": .string(failure),
            ])])
        } else {
            self.emit(["event": .string("cancelled"), "params": .object([:])])
        }
    }

    private func finishRun(_ handle: CancelToken) {
        lock.lock()
        // Only the run that still owns the slot may clear it, and only it may
        // close the questions: a cancelled run unwinds asynchronously, and by
        // then the user may already have started another one.
        let ownsSlot = activeRun?.token === handle
        var finished: DispatchSemaphore?
        if ownsSlot {
            finished = activeRun?.finished
            activeRun = nil
        }
        let waits = ownsSlot ? pendingApprovals : [:]
        if ownsSlot { pendingApprovals.removeAll() }
        lock.unlock()
        // A run that ended while a question was open must not leave the app
        // waiting for an answer that will never come.
        for (_, wait) in waits { wait.resolve(.deny("The run ended.")) }
        // Wakes a `run` that is waiting for this one to let go of the machine.
        // Signalled outside the lock: the waiter takes the same lock next.
        finished?.signal()
    }

    /// Stops the run.
    ///
    /// The slot stays with the cancelled run until its task has actually
    /// unwound: the loop checks the token between steps and calls, so a drag,
    /// a scroll or a `type_text` can still be in flight. `startRun` waits that
    /// out (bounded) rather than pointing a second agent at the same pointer.
    private func cancelRun() {
        lock.lock()
        let running = activeRun?.token
        lock.unlock()
        running?.cancel()
        resolveAllApprovals(.deny(Self.cancelledMessage))
    }

    // MARK: - Approval

    func requestApproval(
        _ context: ToolCallContext,
        cancel: CancelToken
    ) -> ToolPolicyDecision {
        // A stopped run must not put a question in front of the user: it would
        // be for a call nobody is waiting on any more.
        if cancel.isCancelled { return .deny(Self.cancelledMessage) }

        let id = nextApprovalId()
        let wait = ApprovalWait()
        lock.lock()
        pendingApprovals[id] = wait
        lock.unlock()

        emit(["event": .string("approval"), "params": .object(approvalParams(context, id: id))])

        // A question nobody answers must not hang the run forever: the app is
        // the only one who can answer it, and if it stopped, so did the reason
        // to keep waiting. The poll exists so a cancel lands within 100 ms.
        let deadline = Date().addingTimeInterval(Self.approvalTimeout)
        while Date() < deadline {
            if cancel.isCancelled {
                forgetApproval(id)
                return .deny(Self.cancelledMessage)
            }
            if wait.semaphore.wait(timeout: .now() + Self.approvalPollInterval) == .success {
                forgetApproval(id)
                return wait.value
            }
        }
        forgetApproval(id)
        return .deny("The user did not answer in time.")
    }

    private func forgetApproval(_ id: String) {
        lock.lock()
        pendingApprovals.removeValue(forKey: id)
        lock.unlock()
    }

    /// What the card needs to ask the question, in the field names
    /// `AgentToolRequest` reads on the other side of the pipe.
    ///
    /// A field is present only when the tool resolved it: an absent `role` means
    /// "the call was not about an element", which is different from an empty one.
    private func approvalParams(_ context: ToolCallContext, id: String) -> [String: JSONValue] {
        var params: [String: JSONValue] = [
            "id": .string(id),
            "tool": .string(context.tool),
            "arguments": context.arguments,
            "fingerprint": .string(context.fingerprint),
        ]
        if let app = context.appName { params["app"] = .string(app) }
        if let bundle = context.bundleIdentifier { params["bundle_id"] = .string(bundle) }
        if let role = context.role { params["role"] = .string(role) }
        if let title = context.title { params["title"] = .string(title) }
        if let label = context.label { params["label"] = .string(label) }
        if context.isTextField { params["text_field"] = .bool(true) }
        if let narration = context.narration, !narration.isEmpty {
            params["narration"] = .string(narration)
        }
        return params
    }

    private func resolveApproval(params: JSONValue) {
        guard let id = params["id"]?.stringValue else { return }
        let allow = params["allow"]?.boolValue ?? false
        let reason = params["reason"]?.stringValue ?? "The user did not allow this action."
        lock.lock()
        let wait = pendingApprovals[id]
        lock.unlock()
        wait?.resolve(allow ? .allow : .deny(reason))
    }

    private func resolveAllApprovals(_ decision: ToolPolicyDecision) {
        lock.lock()
        let waits = pendingApprovals
        pendingApprovals.removeAll()
        lock.unlock()
        for (_, wait) in waits { wait.resolve(decision) }
    }

    private func nextApprovalId() -> String {
        lock.lock()
        defer { lock.unlock() }
        approvalCounter += 1
        return "a\(approvalCounter)"
    }

    // MARK: - Output

    func emit(_ payload: [String: JSONValue]) {
        var event = payload
        if let traceRunID = Self.traceRunID { event["trace_run_id"] = .string(traceRunID) }
        writer.write(JSONValue.object(event).serialized())
    }

    private func respond(id: JSONValue?, result: JSONValue) {
        guard let id, !id.isNull else { return }
        writer.write(JSONValue.object(["id": id, "result": result]).serialized())
    }

    private func respond(id: JSONValue?, error: String) {
        guard let id, !id.isNull else {
            emit(["event": .string("error"), "params": .object(["message": .string(error)])])
            return
        }
        writer.write(JSONValue.object(["id": id, "error": .object([
            "message": .string(error),
        ])]).serialized())
    }

    // MARK: - Configuration

    private func providerConfig(from value: JSONValue?) throws -> ProviderConfig {
        guard let value else {
            throw ConfigError.invalidValue("run needs provider settings")
        }
        var config = ProviderConfig()
        if let wire = value["wire"]?.stringValue {
            guard let parsed = ProviderConfig.Wire(rawValue: wire) else {
                throw ConfigError.invalidValue("unknown wire \"\(wire)\"")
            }
            config.wire = parsed
        }
        if let base = value["base_url"]?.stringValue {
            // The default is api.openai.com. Dropping a base URL that does not
            // parse would send the user's key there instead of the endpoint they
            // configured, so a bad value is an error, not a fallback.
            guard let url = URL(string: base), url.scheme != nil, url.host != nil else {
                throw ConfigError.invalidValue("base_url \"\(base)\" is not a URL")
            }
            config.baseURL = url
        }
        if let model = value["model"]?.stringValue { config.model = model }
        if let key = value["api_key"]?.stringValue, !key.isEmpty { config.apiKey = key }
        if let tokens = value["max_tokens"]?.intValue { config.maxTokens = tokens }
        if let temperature = value["temperature"]?.doubleValue { config.temperature = temperature }
        if let omit = value["omit_auth"]?.boolValue { config.omitAuthHeader = omit }
        if let extra = value["extra_body"]?.objectValue {
            // The conversation and the stream flag belong to the agent.
            let reserved: Set<String> = ["model", "messages", "stream", "tools", "system"]
            config.extraBody = extra.filter { !reserved.contains($0.key) }
        }
        if let headers = value["headers"]?.objectValue {
            for (name, header) in headers {
                if let text = header.stringValue { config.extraHeaders[name] = text }
            }
        }
        return config
    }

    private func loopOptions(from value: JSONValue?) -> AgentLoop.Options {
        var options = AgentLoop.Options()
        if let steps = value?["max_steps"]?.intValue, steps > 0 { options.maxSteps = steps }
        if let verify = value?["verify_actions"]?.boolValue { options.verifyActions = verify }
        if let timings = value?["timings"]?.boolValue { options.timings = timings }
        if let verbose = value?["verbose"]?.boolValue { options.verbose = verbose }
        return options
    }
}

/// Serialises lines written from several threads (the loop, the approval path,
/// the reader's error replies).
private final class LineWriter: @unchecked Sendable {
    private let lock = NSLock()

    func write(_ line: String) {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
    }
}

/// Turns loop progress into events for the app.
private final class BridgeObserver: AgentObserver, @unchecked Sendable {
    private let bridge: Bridge
    /// The card shows a result line, not a transcript; the model already has the
    /// full text in its history.
    private static let maximumResultTextLength = 2000
    /// Steps whose prose already reached the card as a stream. The final
    /// `stepAnswered` must not send the same caption again: the card would
    /// replace a growing line with a shorter, identical one for a frame.
    private var streamedSteps = Set<Int>()

    init(bridge: Bridge) {
        self.bridge = bridge
    }

    func stepStarted(_ step: Int, of total: Int) {
        bridge.emit(["event": .string("step"), "params": .object([
            "step": .number(Double(step)),
            "total": .number(Double(total)),
        ])])
    }

    func stepStreamed(_ step: Int, text: String) {
        guard !text.isEmpty else { return }
        streamedSteps.insert(step)
        bridge.emit(["event": .string("stream"), "params": .object([
            "step": .number(Double(step)),
            "text": .string(text),
        ])])
    }

    func stepAnswered(_ step: Int, narration: String, calls: [ToolCall]) {
        guard !calls.isEmpty, !narration.isEmpty, !streamedSteps.contains(step) else { return }
        bridge.emit(["event": .string("narration"), "params": .object([
            "step": .number(Double(step)),
            "text": .string(narration),
        ])])
    }

    func toolStarted(_ step: Int, call: ToolCall, narration: String) {
        var params: [String: JSONValue] = [
            "step": .number(Double(step)),
            "name": .string(call.name),
            "arguments": call.arguments,
        ]
        if !narration.isEmpty { params["narration"] = .string(narration) }
        bridge.emit(["event": .string("tool"), "params": .object(params)])
    }

    func stepTimed(_ step: Int, timing: StepTiming) {
        var params: [String: JSONValue] = [
            "step": .number(Double(step)),
            "llm_ms": .number(timing.llmMilliseconds),
            "prompt_bytes": .number(Double(timing.promptBytes)),
            "history": .number(Double(timing.historyMessages)),
            "calls": .number(Double(timing.callCount)),
        ]
        if let input = timing.inputTokens { params["input_tokens"] = .number(Double(input)) }
        if let output = timing.outputTokens { params["output_tokens"] = .number(Double(output)) }
        bridge.emit(["event": .string("step-timing"), "params": .object(params)])
    }

    func toolFinished(_ step: Int, call: ToolCall, text: String, didFail: Bool, timings: ToolTimings) {
        var params: [String: JSONValue] = [
            "step": .number(Double(step)),
            "name": .string(call.name),
            "ok": .bool(!didFail),
            "text": .string(
                text.count > Self.maximumResultTextLength
                    ? String(text.prefix(Self.maximumResultTextLength)) + "…"
                    : text
            ),
        ]
        // Only the phases that actually ran, so the host does not have to tell
        // "0 ms" from "did not happen". Sent unrounded: a tool that takes 0.4 ms
        // is not the same as one that takes 0, and rounding here would make the
        // cheap tools — which is most of them — indistinguishable from free.
        if timings.wall > 0 { params["wall_ms"] = .number(timings.wall) }
        if timings.tree > 0 { params["tree_ms"] = .number(timings.tree) }
        if timings.capture > 0 { params["capture_ms"] = .number(timings.capture) }
        if timings.encode > 0 { params["encode_ms"] = .number(timings.encode) }
        if timings.screenshotBytes > 0 {
            params["image_bytes"] = .number(Double(timings.screenshotBytes))
        }
        bridge.emit(["event": .string("result"), "params": .object(params)])
    }

    func loopWarned(_ reason: String) {
        bridge.emit(["event": .string("warning"), "params": .object([
            "reason": .string(reason),
        ])])
    }

    func loopStopped(_ reason: String) {
        bridge.emit(["event": .string("stopped"), "params": .object([
            "reason": .string(reason),
        ])])
    }

    func runFinished(_ report: RunReport) {
        var params: [String: JSONValue] = [
            "steps": .number(Double(report.steps)),
            "calls": .number(Double(report.calls)),
            "failed_calls": .number(Double(report.failedCalls)),
            "total_ms": .number(report.totalMilliseconds),
            "llm_ms": .number(report.llmMilliseconds),
            "tool_ms": .number(report.toolMilliseconds),
        ]
        if !report.table.isEmpty { params["table"] = .string(report.table) }
        bridge.emit(["event": .string("run-report"), "params": .object(params)])
    }
}

/// Draws an action for the app and, when the target is not already in front,
/// brings its window forward.
///
/// This is the whole visible half of the agent, and it is deliberately thin:
/// it reports what the executor is about to do and raises a window. It never
/// decides what the action is, never waits for the drawing to finish, and never
/// changes the call's arguments or timing. The event is written on the caller's
/// thread (a pipe write, not a round trip); the window work is queued, so a
/// slow or unresponsive app cannot delay the action it is about to receive.
private final class BridgePresenter: ActionPresenter, @unchecked Sendable {
    private let bridge: Bridge
    private let queue = DispatchQueue(label: "deskhand.present", qos: .utility)

    init(bridge: Bridge) {
        self.bridge = bridge
    }

    func present(_ action: ActionPresentation) {
        var params: [String: JSONValue] = [
            "tool": .string(action.tool),
            "gesture": .string(action.gesture.rawValue),
        ]
        if let app = action.appName { params["app"] = .string(app) }
        if let bundle = action.bundleIdentifier { params["bundle_id"] = .string(bundle) }
        if let pid = action.pid { params["pid"] = .number(Double(pid)) }
        if let point = action.point {
            params["x"] = .number(Double(point.x))
            params["y"] = .number(Double(point.y))
        }
        // These two keys are the wire contract with `src/main/agent/sidecar.ts`
        // (`AgentPresentation.target` and `.window`), so they keep their names
        // while the properties they carry are named for what they measure.
        if let elementFrame = action.elementFrame { params["target"] = Self.rect(elementFrame) }
        if let windowFrame = action.windowFrame { params["window"] = Self.rect(windowFrame) }
        bridge.emit(["event": .string("present"), "params": .object(params)])

        queue.async {
            Self.raise(action)
        }
    }

    /// Brings the window into view, without waiting for it.
    ///
    /// The activation is requested on the main thread because that is where the
    /// window server answers, and it is not awaited: the agent's next action is
    /// allowed to run against the background window exactly as before. Only the
    /// window a person is supposed to watch is moved; the action itself still
    /// works whether or not this lands.
    private static func raise(_ action: ActionPresentation) {
        guard let pid = action.pid, pid > 0 else { return }
        DispatchQueue.main.async {
            guard let app = NSRunningApplication(processIdentifier: pid) else { return }
            if !app.isActive {
                app.activate(options: [.activateAllWindows])
            }
            guard let window = AXElement.application(pid: pid).focusedWindow() else { return }
            // A minimised window is not "shown" by activation alone; clear the
            // flag before raising so the user actually sees the target.
            _ = window.setValue(false, for: kAXMinimizedAttribute)
            _ = window.perform(kAXRaiseAction)
        }
    }

    private static func rect(_ value: CGRect) -> JSONValue {
        .object([
            "x": .number(Double(value.origin.x)),
            "y": .number(Double(value.origin.y)),
            "width": .number(Double(value.size.width)),
            "height": .number(Double(value.size.height)),
        ])
    }
}

/// The app's veto over every mutating call.
private final class BridgePolicy: ToolPolicy, @unchecked Sendable {
    private let bridge: Bridge
    private let cancel: CancelToken

    init(bridge: Bridge, cancel: CancelToken) {
        self.bridge = bridge
        self.cancel = cancel
    }

    func authorize(_ call: ToolCallContext) -> ToolPolicyDecision {
        bridge.requestApproval(call, cancel: cancel)
    }
}
