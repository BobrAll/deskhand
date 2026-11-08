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

final class AgentLoopTests: XCTestCase {
    func testATruncatedReplyIsNotMistakenForAFinishedRun() async throws {
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
        XCTAssertTrue(toolMessages[0].toolIsError, "unknown tool reported as an error")
        XCTAssertTrue(toolMessages[1].toolIsError, "the skipped call is marked as not run")
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
        XCTAssertFalse(toolMessages.contains { $0.toolIsError })
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
        let warnings = lastMessages.filter { $0.role == .tool && $0.toolIsError }
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
        let trimmed = loop.trim(messages)
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
        let trimmed = loop.trim(messages)
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
        let trimmed = loop.trim(messages)
        let trees = trimmed.filter { $0.text.contains("Accessibility tree") }
        XCTAssertEqual(trees.count, 2, "both messages survive")

        let oldest = trees[0]
        XCTAssertFalse(oldest.text.contains("AXButton"), "the stale tree body is gone")
        XCTAssertTrue(oldest.text.contains("Telegram — window"), "the cheap header is kept")
        XCTAssertTrue(oldest.text.contains("stale"))

        let newest = trees[1]
        XCTAssertTrue(newest.text.contains("AXButton \"Send\""), "the newest tree is intact")
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
        let trimmed = loop.trim(messages)
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
