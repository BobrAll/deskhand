import XCTest
@testable import DeskhandCore
@testable import DeskhandAgentKit
@testable import DeskhandLLM

/// A provider that answers from a script, so the agent loop can be exercised
/// without a network or a real model.
final class ScriptedProvider: ChatProvider {
    struct Step {
        var text: String
        var toolCalls: [ToolCall]
    }

    let config = ProviderConfig(apiKey: "test")
    private var steps: [Step]
    private(set) var calls: [([ChatMessage], [ToolDefinition])] = []

    init(steps: [Step]) {
        self.steps = steps
    }

    func complete(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String
    ) async throws -> Completion {
        calls.append((messages, tools))
        guard !steps.isEmpty else {
            return Completion(text: "script exhausted", toolCalls: [], stopReason: "stop")
        }
        let step = steps.removeFirst()
        return Completion(text: step.text, toolCalls: step.toolCalls, stopReason: nil)
    }
}

/// An executor that answers from a script, so the loop's own decisions can be
/// exercised without a window or an accessibility tree.
final class ScriptedExecutor: ToolRunning {
    private var script: [ToolResult]
    private let repeating: ToolResult?
    private(set) var calls: [String] = []

    /// Answers every call with the same result — a run that never moves.
    init(repeating result: ToolResult) {
        self.script = []
        self.repeating = result
    }

    /// Answers each call with the next result, in order.
    init(steps: [ToolResult]) {
        self.script = steps
        self.repeating = nil
    }

    func call(name: String, arguments: JSONValue, verify: Bool, narration: String?) async -> ToolResult {
        calls.append(name)
        if let repeating { return repeating }
        guard !script.isEmpty else { return .text("script exhausted") }
        return script.removeFirst()
    }
}

final class AgentLoopTests: XCTestCase {    func testATruncatedReplyIsNotMistakenForAFinishedRun() async throws {
        // The provider cut the answer off at `max_tokens`. The tool call it was
        // writing never finished, so the reply arrives with no calls and no text
        // — the exact shape of "the model said it is done". Taking that at face
        // value ended a real run with an empty answer and threw away every step
        // already taken, so the task had to be asked for twice.
        let provider = TruncatingProvider()
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(verbose: false)
        )
        let answer = try await loop.run(task: "do the thing")
        XCTAssertFalse(loop.finished, "a cut-off reply is not the model finishing")
        XCTAssertTrue(answer.contains("token limit"), "got: \(answer)")
        XCTAssertEqual(provider.calls, 1, "there is nothing to retry: the same limit would cut it again")
    }

    func testReturnsFinalAnswerWhenNoToolCalls() async throws {
        let provider = ScriptedProvider(steps: [
            .init(text: "All done.", toolCalls: [])
        ])
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(verbose: false)
        )
        let answer = try await loop.run(task: "do nothing")
        XCTAssertEqual(answer, "All done.")
        XCTAssertEqual(provider.calls.count, 1)
        XCTAssertEqual(provider.calls[0].1.count, 11, "all tools are offered")
    }

    func testExecutesToolCallsThenFinishes() async throws {
        let provider = ScriptedProvider(steps: [
            .init(text: "", toolCalls: [
                ToolCall(id: "c1", name: "list_apps", arguments: .object(["include_installed": .bool(false)]))
            ]),
            .init(text: "Listed the apps.", toolCalls: []),
        ])
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(verbose: false)
        )
        let answer = try await loop.run(task: "list apps")
        XCTAssertEqual(answer, "Listed the apps.")
        XCTAssertEqual(provider.calls.count, 2)

        // The second request must contain the assistant turn with the call and
        // the tool result that answers it.
        let secondMessages = provider.calls[1].0
        XCTAssertTrue(secondMessages.contains { $0.role == .assistant && !$0.toolCalls.isEmpty })
        let toolMessage = try XCTUnwrap(secondMessages.first { $0.role == .tool })
        XCTAssertEqual(toolMessage.toolCallID, "c1")
        XCTAssertFalse(toolMessage.text.isEmpty)
    }

    func testSeveralCallsInOneAnswerAllRun() async throws {
        // Batching is the main lever on run time, so the loop must actually
        // execute every call in one answer — in order, and answering each with
        // its own tool message.
        let provider = ScriptedProvider(steps: [
            .init(text: "", toolCalls: [
                ToolCall(id: "a", name: "list_apps", arguments: .object(["include_installed": .bool(false)])),
                ToolCall(id: "b", name: "list_apps", arguments: .object(["include_installed": .bool(true)])),
            ]),
            .init(text: "done", toolCalls: []),
        ])
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(verbose: false)
        )
        _ = try await loop.run(task: "batch")

        // Two calls plus the final answer: one round trip for both actions.
        XCTAssertEqual(provider.calls.count, 2)
        let toolMessages = provider.calls[1].0.filter { $0.role == .tool }
        XCTAssertEqual(toolMessages.count, 2, "each call needs its own result message")
        XCTAssertEqual(toolMessages.map(\.toolCallID), ["a", "b"], "results follow call order")
    }

    func testAFailedCallStopsTheBatchAndMarksTheRestSkipped() async throws {
        // A failure invalidates what the later calls were planned against: after
        // a `super+l` that did not take, typing the URL goes into whatever had
        // focus. Running them anyway does damage and then hides it, because each
        // reports "no change" as if it were merely uninformative. So the batch
        // stops, and every skipped call still gets an answer, because the
        // protocol requires a result for each.
        let provider = ScriptedProvider(steps: [
            .init(text: "", toolCalls: [
                ToolCall(id: "bad", name: "no_such_tool", arguments: .object([:])),
                ToolCall(id: "skipped", name: "list_apps", arguments: .object([:])),
            ]),
            .init(text: "done", toolCalls: []),
        ])
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(verbose: false)
        )
        _ = try await loop.run(task: "batch with a failure")

        let toolMessages = provider.calls[1].0.filter { $0.role == .tool }
        XCTAssertEqual(toolMessages.count, 2, "every call still needs a result message")
        XCTAssertTrue(toolMessages[0].isError, "unknown tool reported as an error")
        XCTAssertTrue(toolMessages[1].isError, "the skipped call is marked as not run")
        XCTAssertTrue(
            toolMessages[1].text.contains("Stopped the batch"),
            "the skipped call says why it did not run"
        )
    }

    func testASuccessfulBatchDoesNotStopEarly() async throws {
        // The guard must be about failures only. Two good calls in one answer
        // both run, or batching would be pointless.
        let provider = ScriptedProvider(steps: [
            .init(text: "", toolCalls: [
                ToolCall(id: "a", name: "list_apps", arguments: .object(["include_installed": .bool(false)])),
                ToolCall(id: "b", name: "list_apps", arguments: .object(["include_installed": .bool(true)])),
            ]),
            .init(text: "done", toolCalls: []),
        ])
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(verbose: false)
        )
        _ = try await loop.run(task: "batch")

        let toolMessages = provider.calls[1].0.filter { $0.role == .tool }
        XCTAssertEqual(toolMessages.count, 2)
        XCTAssertFalse(toolMessages.contains { $0.isError })
    }

    func testLoopGuardStopsRepeatedIdenticalCalls() async throws {
        let repeated = ToolCall(
            id: "same",
            name: "list_apps",
            arguments: .object(["include_installed": .bool(false)])
        )
        // Four identical turns: the guard should inject warnings rather than
        // executing the same tool forever.
        let provider = ScriptedProvider(steps: [
            .init(text: "", toolCalls: [repeated]),
            .init(text: "", toolCalls: [repeated]),
            .init(text: "", toolCalls: [repeated]),
            .init(text: "gave up", toolCalls: []),
        ])
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(maxSteps: 6, verbose: false)
        )
        let answer = try await loop.run(task: "loop")
        XCTAssertEqual(answer, "gave up")

        // The third call should have produced a warning instead of a result.
        let lastMessages = provider.calls.last!.0
        let warnings = lastMessages.filter { $0.role == .tool && $0.isError }
        XCTAssertFalse(warnings.isEmpty, "expected the loop guard to inject a warning")
        XCTAssertTrue(warnings.contains { $0.text.contains("without a change") })
    }

    func testStopsAfterMaxSteps() async throws {
        let provider = ScriptedProvider(steps: Array(repeating:
            .init(text: "", toolCalls: [
                ToolCall(id: UUID().uuidString, name: "list_apps", arguments: .object([:]))
            ]), count: 10))
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(maxSteps: 3, verbose: false)
        )
        let answer = try await loop.run(task: "spin")
        XCTAssertTrue(answer.contains("Stopped after 3 steps"))
    }

    func testStopsWhenTheRunKeepsReturningToTheSameScreen() async throws {
        // The real failure: a run of 30 steps where no two consecutive calls
        // were identical — `super+l`, read, click, read — so the identical-call
        // guard never fired, and the step budget was the only bound. Every step
        // here lands on the same screen.
        let executor = ScriptedExecutor(repeating: .init(
            content: [.text("ok")], stateFingerprint: "Chrome|Filters|42"))
        let provider = ScriptedProvider(steps: (0..<40).map { step in
            .init(text: "", toolCalls: [
                ToolCall(id: UUID().uuidString, name: "press_key",
                         arguments: .object(["key": .string("key-\(step)")]))
            ])
        })
        let loop = AgentLoop(
            provider: provider,
            executor: executor,
            options: .init(maxSteps: 40, verbose: false)
        )
        let answer = try await loop.run(task: "get stuck")
        XCTAssertFalse(loop.finished, "a run that went in circles did not finish")
        XCTAssertTrue(answer.contains("without a new screen"), answer)
        XCTAssertLessThan(executor.calls.count, 20, "the loop must stop long before the budget")
    }

    func testAWarningComesBeforeTheStop() async throws {
        let executor = ScriptedExecutor(repeating: .init(
            content: [.text("ok")], stateFingerprint: "same"))
        let provider = ScriptedProvider(steps: (0..<40).map { step in
            .init(text: "", toolCalls: [
                ToolCall(id: UUID().uuidString, name: "press_key",
                         arguments: .object(["key": .string("key-\(step)")]))
            ])
        })
        let loop = AgentLoop(
            provider: provider,
            executor: executor,
            options: .init(maxSteps: 40, verbose: false)
        )
        _ = try await loop.run(task: "get stuck")

        // The model is told what it is doing wrong while it still has steps left,
        // so a task that was one correction from finishing is not cut short.
        let sawWarning = provider.calls.contains { call in
            call.0.contains { $0.role == .user && $0.text.contains("the same screen") }
        }
        XCTAssertTrue(sawWarning, "the model must be told it is going in circles")
    }

    func testANewScreenResetsTheStallCounter() async throws {
        let executor = ScriptedExecutor(steps: (0..<30).map { step in
            ToolResult(content: [.text("ok")], stateFingerprint: "screen-\(step / 5)")
        })
        let provider = ScriptedProvider(steps: (0..<30).map { step in
            .init(text: "", toolCalls: [
                ToolCall(id: UUID().uuidString, name: "press_key",
                         arguments: .object(["key": .string("key-\(step)")]))
            ])
        })
        let loop = AgentLoop(
            provider: provider,
            executor: executor,
            options: .init(maxSteps: 12, verbose: false)
        )
        let answer = try await loop.run(task: "make progress")
        // A run that moves to a new screen every few steps is not stuck, so the
        // only bound that applies is the step budget.
        XCTAssertTrue(answer.contains("Stopped after 12 steps"), answer)
        XCTAssertEqual(executor.calls.count, 12)
    }

    func testScreenshotsAreTrimmedToKeepContextBounded() {
        let provider = ScriptedProvider(steps: [])
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(keepScreenshots: 1, verbose: false)
        )
        let messages: [ChatMessage] = [
            ChatMessage(role: .user, text: "start"),
            ChatMessage(role: .tool, text: "state 1", toolCallID: "a"),
            ChatMessage(role: .user, text: "shot 1", images: [Data([1])]),
            ChatMessage(role: .tool, text: "state 2", toolCallID: "b"),
            ChatMessage(role: .user, text: "shot 2", images: [Data([2])]),
        ]
        let trimmed = loop.trimmedHistory(messages)
        let images = trimmed.filter { !$0.images.isEmpty }
        XCTAssertEqual(images.count, 1)
        XCTAssertEqual(images.first?.text, "shot 2", "the newest screenshot survives")
    }

    func testTheTreeOfEachAppSurvivesSwitchingBetweenThem() {
        // Alternating between a browser and a chat client is the common shape of
        // a real task. With a global cap, every switch discarded the other
        // app's tree and the model re-read 500-node trees just to recover
        // indices it already had — measured as six extra reads in one run.
        let provider = ScriptedProvider(steps: [])
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(keepTrees: 3, verbose: false)
        )
        func tree(_ app: String, bundle: String, node: String) -> String {
            """
            \(app) [\(bundle)] — window "W"
            Accessibility tree (1 nodes):
            0 \(node)
            """
        }
        let messages: [ChatMessage] = [
            ChatMessage(role: .user, text: "start"),
            ChatMessage(role: .tool, text: tree("Chrome", bundle: "com.google.Chrome", node: "AXButton \"Address\""), toolCallID: "1"),
            ChatMessage(role: .tool, text: tree("Telegram", bundle: "ru.keepcoder.Telegram", node: "AXTextArea \"Composer\""), toolCallID: "2"),
            ChatMessage(role: .tool, text: tree("Chrome", bundle: "com.google.Chrome", node: "AXButton \"NewAddress\""), toolCallID: "3"),
        ]
        let trimmed = loop.trimmedHistory(messages)
        let bodies = trimmed.map(\.text)
        XCTAssertTrue(
            bodies[2].contains("AXTextArea"),
            "the other app's tree is still there after switching away and back"
        )
        XCTAssertTrue(
            bodies[3].contains("AXButton"),
            "the newest tree of the app just read is kept in full"
        )
        XCTAssertFalse(
            bodies[1].contains("AXButton"),
            "the older tree of the same app is stale and gets cut"
        )
    }

    func testStaleTreesAreReplacedByAMarker() {
        let provider = ScriptedProvider(steps: [])
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(keepTrees: 1, verbose: false)
        )
        let first = """
            Telegram — window "Saved Messages"
            Accessibility tree (2 nodes):
            0 AXWindow "Saved Messages"
            1   AXTextArea
            """
        let second = """
            Telegram — window "Saved Messages"
            Accessibility tree (3 nodes):
            0 AXWindow "Saved Messages"
            1   AXTextArea "hi"
            2   AXButton "Send"
            """
        let messages: [ChatMessage] = [
            ChatMessage(role: .user, text: "start"),
            ChatMessage(role: .tool, text: first, toolCallID: "a"),
            ChatMessage(role: .tool, text: second, toolCallID: "b"),
        ]
        let trimmed = loop.trimmedHistory(messages)
        let trees = trimmed.filter { $0.text.contains("Accessibility tree") }
        XCTAssertEqual(trees.count, 2, "both messages survive")

        let oldest = trees[0]
        XCTAssertFalse(oldest.text.contains("AXButton"), "the old tree body is gone")
        XCTAssertTrue(oldest.text.contains("Telegram — window"), "the cheap header is kept")
        XCTAssertTrue(oldest.text.contains("omitted to keep the prompt small"))
        // Numbers stay with their control across walks, so a trimmed tree does
        // not invalidate anything the model already knows.
        XCTAssertTrue(oldest.text.contains("still mean the same controls"))

        let newest = trees[1]
        XCTAssertTrue(newest.text.contains("AXButton \"Send\""), "the newest tree is intact")
    }

    func testOnlyTheNewestDiffIsKeptInFull() {
        // A diff describes a transition. Once a later action has changed the
        // screen again, its lines describe something that is not there any more
        // — and on a long run they were a quarter of the whole prompt.
        let loop = AgentLoop(
            provider: ScriptedProvider(steps: []),
            executor: ToolExecutor(),
            options: .init(verbose: false)
        )
        let messages: [ChatMessage] = [
            ChatMessage(role: .tool, text: """
                Chrome — window "Filters"
                Pressed element 1 (AXButton "Create").
                Changed after the click (1 added):
                + 7 AXButton "Confirm"
                """, toolCallID: "a"),
            ChatMessage(role: .tool, text: """
                Chrome — window "Filters"
                Pressed element 7 (AXButton "Confirm").
                Changed after the click (1 added):
                + 9 AXTextField "Label"
                """, toolCallID: "b"),
        ]
        let trimmed = loop.trimmedHistory(messages)

        XCTAssertTrue(trimmed[0].text.contains("superseded by a later action"))
        XCTAssertFalse(trimmed[0].text.contains("AXButton \"Confirm\""),
                       "the superseded diff body is gone")
        XCTAssertTrue(trimmed[0].text.contains("Pressed element 1"),
                      "what the action was stays")
        XCTAssertTrue(trimmed[1].text.contains("+ 9 AXTextField \"Label\""),
                      "the newest diff is intact")
    }

    func testTextOnlyMessagesArePreservedWhenImagesAreDropped() {
        let provider = ScriptedProvider(steps: [])
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(keepScreenshots: 0, verbose: false)
        )
        let messages: [ChatMessage] = [
            ChatMessage(role: .tool, text: "important output", toolCallID: "a"),
            ChatMessage(role: .user, text: "", images: [Data([1])]),
        ]
        let trimmed = loop.trimmedHistory(messages)
        XCTAssertTrue(trimmed.contains { $0.text == "important output" })
        XCTAssertTrue(trimmed.allSatisfy { $0.images.isEmpty })
    }
}

/// A provider whose reply was cut off at the token limit.
///
/// Both wires report it in `finish_reason`/`stop_reason`, but the half-written
/// tool call does not survive parsing, so the completion looks like an empty
/// final answer.
private final class TruncatingProvider: ChatProvider {
    let config = ProviderConfig(apiKey: "test")
    private(set) var calls = 0

    func complete(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String
    ) async throws -> Completion {
        calls += 1
        return Completion(text: "", toolCalls: [], stopReason: "length")
    }
}

/// A provider may finish after cancellation (some transports cannot abort a response).
/// No tool from that response should be allowed to execute.
private struct CancellingProvider: ChatProvider {
    let config = ProviderConfig(apiKey: "test")
    let toolCalls: [ToolCall]
    func complete(messages: [ChatMessage], tools: [ToolDefinition], systemPrompt: String) async throws -> Completion {
        withUnsafeCurrentTask { $0?.cancel() }
        return Completion(text: "late response", toolCalls: toolCalls, stopReason: nil)
    }
}

final class AgentCancellationTests: XCTestCase {
    func testCancellationRejectsLateFinalAnswer() async {
        await assertCancelled(toolCalls: [])
    }
    func testCancellationRejectsLateToolBatch() async {
        await assertCancelled(toolCalls: [ToolCall(id: "late", name: "list_apps", arguments: .object([:]))])
    }
    private func assertCancelled(toolCalls: [ToolCall]) async {
        let task = Task {
            let loop = AgentLoop(provider: CancellingProvider(toolCalls: toolCalls),
                                 executor: ToolExecutor(), options: .init(verbose: false))
            return try await loop.run(task: "cancel")
        }
        do {
            _ = try await task.value
            XCTFail("A cancelled run must not return a final answer or execute another batch")
        } catch is CancellationError {
            // Expected, including when the provider itself ignores cancellation.
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }
}

/// A provider that writes its answer in pieces, the way a streaming wire does.
private final class StreamingScriptedProvider: StreamingChatProvider {
    struct Step {
        var chunks: [String]
        var toolCalls: [ToolCall]
    }

    let config = ProviderConfig(apiKey: "test")
    private var steps: [Step]

    init(steps: [Step]) {
        self.steps = steps
    }

    func complete(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String
    ) async throws -> Completion {
        try await complete(messages: messages, tools: tools, systemPrompt: systemPrompt, onText: { _ in })
    }

    func complete(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String,
        onText: (String) -> Void
    ) async throws -> Completion {
        guard !steps.isEmpty else {
            return Completion(text: "script exhausted", toolCalls: [], stopReason: "stop")
        }
        let step = steps.removeFirst()
        for chunk in step.chunks where !chunk.isEmpty {
            onText(chunk)
        }
        return Completion(text: step.chunks.joined(), toolCalls: step.toolCalls, stopReason: nil)
    }
}

/// Records what the card would have drawn.
private final class RecordingObserver: AgentObserver, @unchecked Sendable {
    var streams: [Int: [String]] = [:]
    var captions: [Int: String] = [:]

    func stepStreamed(_ step: Int, text: String) {
        streams[step, default: []].append(text)
    }

    func stepAnswered(_ step: Int, narration: String, calls: [ToolCall]) {
        captions[step] = narration
    }
}

final class AgentStreamingTests: XCTestCase {
    func testStreamsTheCaptionWhileTheStepIsStillRunning() async throws {
        let provider = StreamingScriptedProvider(steps: [
            .init(chunks: ["Открываю", " Telegram"], toolCalls: [
                ToolCall(id: "c1", name: "list_apps", arguments: .object(["include_installed": .bool(false)]))
            ]),
            .init(chunks: ["Готово"], toolCalls: []),
        ])
        let observer = RecordingObserver()
        let loop = AgentLoop(
            provider: provider,
            executor: ToolExecutor(),
            options: .init(verbose: false)
        )
        loop.observer = observer

        let answer = try await loop.run(task: "open it")

        XCTAssertEqual(answer, "Готово")
        // The first delta goes out immediately, and the throttle's last gap is
        // closed after the provider returns: the card ends on the full caption.
        XCTAssertEqual(observer.streams[1]?.first, "Открываю")
        XCTAssertEqual(observer.streams[1]?.last, "Открываю Telegram")
        XCTAssertEqual(observer.captions[1], "Открываю Telegram")
        XCTAssertEqual(observer.streams[2]?.last, "Готово")
    }
}
