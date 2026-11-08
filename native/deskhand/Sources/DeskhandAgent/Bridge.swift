import Foundation
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
    private let writer = LineWriter()
    private let lock = NSLock()

    /// The run in flight, if any. One at a time: two agents driving the same
    /// pointer would interleave clicks, and the second would be acting on a
    /// screen the first had already changed.
    private var activeRun: RunHandle?

    /// Approvals waiting for the app's answer, keyed by request id.
    private var pendingApprovals: [String: ApprovalWait] = [:]
    private var approvalCounter = 0

    private final class RunHandle: @unchecked Sendable {
        let cancel = CancelToken()
    }

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

        func value() -> ToolPolicyDecision {
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
                handle(line: line)
            }
        }
        // stdin closed: the app is gone, and a run with nobody watching is a run
        // nobody can stop.
        cancelRun()
        exit(0)
    }

    private func handle(line: String) {
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
        if activeRun != nil {
            lock.unlock()
            respond(id: id, error: "a run is already in progress")
            return
        }
        let handle = RunHandle()
        activeRun = handle
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
        let executor = ToolExecutor()
        let provider = ProviderFactory.make(config: config)
        let loop = AgentLoop(provider: provider, executor: executor, options: options)
        loop.observer = BridgeObserver(bridge: self)
        executor.policy = BridgePolicy(bridge: self, cancel: handle.cancel)

        respond(id: id, result: .object(["started": .bool(true)]))

        // The run lives on its own task and the main thread keeps the run loop
        // pumping: `NSRunningApplication.activate` and ScreenCaptureKit both
        // deliver their replies to it, and parking the main thread turns every
        // activation into a one-second timeout.
        Task.detached { [weak self] in
            var answer: String?
            var failure: String?
            do {
                answer = try await loop.run(task: task, cancel: handle.cancel)
            } catch is CancellationError {
                answer = nil
            } catch {
                failure = "\(error)"
            }
            executor.shutdown()
            self?.finishRun(handle)
            guard let self else { return }
            if let answer {
                self.emit(["event": .string("done"), "params": .object([
                    "answer": .string(answer),
                ])])
            } else if let failure {
                self.emit(["event": .string("error"), "params": .object([
                    "message": .string(failure),
                ])])
            } else {
                self.emit(["event": .string("cancelled"), "params": .object([:])])
            }
        }
    }

    private func finishRun(_ handle: RunHandle) {
        lock.lock()
        if activeRun === handle { activeRun = nil }
        let waits = pendingApprovals
        pendingApprovals.removeAll()
        lock.unlock()
        // A run that ended while a question was open must not leave the app
        // waiting for an answer that will never come.
        for (_, wait) in waits { wait.resolve(.deny("The run ended.")) }
    }

    private func cancelRun() {
        lock.lock()
        let running = activeRun
        lock.unlock()
        running?.cancel.cancel()
        resolveAllApprovals(.deny("Отменено."))
    }

    // MARK: - Approval

    func requestApproval(
        _ context: ToolCallContext,
        cancel: CancelToken
    ) -> ToolPolicyDecision {
        let id = nextApprovalId()
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

        let wait = ApprovalWait()
        lock.lock()
        pendingApprovals[id] = wait
        lock.unlock()

        emit(["event": .string("approval"), "params": .object(params)])

        // A question nobody answers must not hang the run forever: the app is
        // the only one who can answer it, and if it stopped, so did the reason
        // to keep waiting. The poll exists so a cancel lands within 100 ms.
        let deadline = Date().addingTimeInterval(600)
        while Date() < deadline {
            if cancel.isCancelled {
                lock.lock()
                pendingApprovals.removeValue(forKey: id)
                lock.unlock()
                return .deny("Отменено.")
            }
            if wait.semaphore.wait(timeout: .now() + 0.1) == .success {
                lock.lock()
                pendingApprovals.removeValue(forKey: id)
                lock.unlock()
                return wait.value()
            }
        }
        lock.lock()
        pendingApprovals.removeValue(forKey: id)
        lock.unlock()
        return .deny("The user did not answer in time.")
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
        writer.write(JSONValue.object(payload).serialized())
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
        if let wire = value["wire"]?.stringValue, let parsed = ProviderConfig.Wire(rawValue: wire) {
            config.wire = parsed
        }
        if let base = value["base_url"]?.stringValue, let url = URL(string: base) {
            config.baseURL = url
        }
        if let model = value["model"]?.stringValue { config.model = model }
        if let key = value["api_key"]?.stringValue, !key.isEmpty { config.apiKey = key }
        if let tokens = value["max_tokens"]?.intValue { config.maxTokens = tokens }
        if let temperature = value["temperature"]?.doubleValue { config.temperature = temperature }
        if let omit = value["omit_auth"]?.boolValue { config.omitAuthHeader = omit }
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

    init(bridge: Bridge) {
        self.bridge = bridge
    }

    func stepStarted(_ step: Int, of total: Int) {
        bridge.emit(["event": .string("step"), "params": .object([
            "step": .number(Double(step)),
            "total": .number(Double(total)),
        ])])
    }

    func stepAnswered(_ step: Int, narration: String, calls: [ToolCall]) {
        guard !narration.isEmpty else { return }
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

    func toolFinished(_ step: Int, call: ToolCall, text: String, isError: Bool) {
        bridge.emit(["event": .string("result"), "params": .object([
            "step": .number(Double(step)),
            "name": .string(call.name),
            "ok": .bool(!isError),
            "text": .string(text.count > 2000 ? String(text.prefix(2000)) + "…" : text),
        ])])
    }

    func loopStopped(_ reason: String) {
        bridge.emit(["event": .string("stopped"), "params": .object([
            "reason": .string(reason),
        ])])
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
