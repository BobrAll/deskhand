import XCTest
import Foundation
@testable import DeskhandLLM
import DeskhandCore

final class MiniTOMLTests: XCTestCase {
    func testParsesSectionsAndKeys() throws {
        let parsed = try MiniTOML.parse("""
            # leading comment
            [provider]
            wire = "openai"
            base_url = "https://api.example.com/v1"
            model = 'my-model'
            max_tokens = 2048
            temperature = 0.3
            omit_auth = true
            """)
        let provider = try XCTUnwrap(parsed["provider"])
        XCTAssertEqual(provider["wire"], "openai")
        XCTAssertEqual(provider["base_url"], "https://api.example.com/v1")
        XCTAssertEqual(provider["model"], "my-model")
        XCTAssertEqual(provider["max_tokens"], "2048")
        XCTAssertEqual(provider["temperature"], "0.3")
        XCTAssertEqual(provider["omit_auth"], "true")
    }

    func testIgnoresCommentsInsideQuotedValues() throws {
        let parsed = try MiniTOML.parse(#"model = "has # hash""#)
        XCTAssertEqual(parsed[""]?["model"], "has # hash")
    }

    func testHandlesEqualsInsideValue() throws {
        let parsed = try MiniTOML.parse(#"base_url = "https://x.test/v1?a=b""#)
        XCTAssertEqual(parsed[""]?["base_url"], "https://x.test/v1?a=b")
    }

    func testSkipsBlankAndMalformedLines() throws {
        let parsed = try MiniTOML.parse("""

            not a pair
            key = value
            """)
        XCTAssertEqual(parsed[""]?["key"], "value")
    }
}

final class ProviderConfigTests: XCTestCase {
    func testOpenAIEndpointNormalization() {
        let cases = [
            ("https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"),
            ("https://api.openai.com/v1/", "https://api.openai.com/v1/chat/completions"),
            ("https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"),
            ("http://localhost:11434/v1", "http://localhost:11434/v1/chat/completions"),
            ("https://proxy.example/v1/?tenant=deskhand#docs", "https://proxy.example/v1/chat/completions?tenant=deskhand"),
        ]
        for (input, expected) in cases {
            let config = ProviderConfig(baseURL: URL(string: input)!)
            XCTAssertEqual(config.endpointURL.absoluteString, expected, input)
        }
    }

    func testAnthropicEndpointNormalization() {
        let config = ProviderConfig(
            wire: .anthropic,
            baseURL: URL(string: "https://api.anthropic.com/v1")!
        )
        XCTAssertEqual(config.endpointURL.absoluteString, "https://api.anthropic.com/v1/messages")
    }

    func testLoadsFromFileAndEnvironment() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskhand-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("config.toml")
        try """
            [provider]
            wire = "anthropic"
            base_url = "https://proxy.example.com"
            model = "file-model"
            api_key = "file-key"
            """.write(to: path, atomically: true, encoding: .utf8)

        let config = try ConfigLoader.load(path: path.path, environment: [:])
        XCTAssertEqual(config.wire, .anthropic)
        XCTAssertEqual(config.baseURL.absoluteString, "https://proxy.example.com")
        XCTAssertEqual(config.model, "file-model")
        XCTAssertEqual(config.apiKey, "file-key")
    }

    func testEnvironmentOverridesFile() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskhand-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("config.toml")
        try """
            [provider]
            base_url = "https://file.example.com/v1"
            model = "file-model"
            """.write(to: path, atomically: true, encoding: .utf8)

        let config = try ConfigLoader.load(
            path: path.path,
            environment: [
                "DESKHAND_BASE_URL": "https://env.example.com/v1",
                "DESKHAND_MODEL": "env-model",
                "DESKHAND_API_KEY": "env-key",
            ]
        )
        XCTAssertEqual(config.baseURL.absoluteString, "https://env.example.com/v1")
        XCTAssertEqual(config.model, "env-model")
        XCTAssertEqual(config.apiKey, "env-key")
    }

    func testRejectsABaseURLThatWouldFallBackToOpenAI() {
        // The default base URL is api.openai.com, so a value that does not parse
        // must fail loudly: dropping it would send the user's key to a provider
        // they never chose.
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskhand-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("config.toml")
        try? """
            [provider]
            base_url = "not a url"
            """.write(to: path, atomically: true, encoding: .utf8)

        XCTAssertThrowsError(try ConfigLoader.load(path: path.path, environment: [:])) { error in
            XCTAssertTrue("\(error)".contains("base_url"))
        }
        try? FileManager.default.removeItem(at: directory)
    }

    func testRejectsAnUnknownWire() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskhand-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("config.toml")
        try? """
            [provider]
            wire = "gemini"
            """.write(to: path, atomically: true, encoding: .utf8)

        XCTAssertThrowsError(try ConfigLoader.load(path: path.path, environment: [:])) { error in
            XCTAssertTrue("\(error)".contains("gemini"))
        }
        try? FileManager.default.removeItem(at: directory)
    }

    func testKeyDiscoveryPerWire() {
        let openAI = ProviderConfig(wire: .openAICompatible)
        XCTAssertEqual(
            ConfigLoader.discoverKey(for: openAI, environment: ["OPENAI_API_KEY": "sk-1"]),
            "sk-1"
        )
        let anthropic = ProviderConfig(wire: .anthropic)
        XCTAssertEqual(
            ConfigLoader.discoverKey(for: anthropic, environment: ["ANTHROPIC_API_KEY": "sk-a"]),
            "sk-a"
        )
        XCTAssertNil(ConfigLoader.discoverKey(for: openAI, environment: [:]))
    }

    func testDeskhandKeyBeatsProviderKey() {
        let config = ProviderConfig(wire: .openAICompatible)
        XCTAssertEqual(
            ConfigLoader.discoverKey(
                for: config,
                environment: ["DESKHAND_API_KEY": "first", "OPENAI_API_KEY": "second"]
            ),
            "first"
        )
    }
}

final class OpenAIEncodingTests: XCTestCase {
    func testToolCallEncodingRoundTrip() throws {
        let provider = OpenAICompatibleProvider(config: ProviderConfig(apiKey: "x"))
        let messages: [ChatMessage] = [
            ChatMessage(role: .user, text: "do it"),
            ChatMessage(
                role: .assistant,
                text: "",
                toolCalls: [ToolCall(id: "call_9", name: "click", arguments: .object(["x": .number(5)]))]
            ),
            ChatMessage(role: .tool, text: "ok", toolCallID: "call_9"),
        ]
        let encoded = provider.encodeMessages(messages, systemPrompt: "sys")
        XCTAssertEqual(encoded.count, 4)
        XCTAssertEqual(encoded[0]["role"]?.stringValue, "system")

        let assistant = try XCTUnwrap(encoded[2].objectValue)
        XCTAssertEqual(assistant["content"]?.isNull, true)
        let call = try XCTUnwrap(assistant["tool_calls"]?.arrayValue?.first)
        XCTAssertEqual(call["id"]?.stringValue, "call_9")
        let argumentsText = try XCTUnwrap(call["function"]?["arguments"]?.stringValue)
        XCTAssertEqual(try JSONValue.parse(argumentsText)["x"]?.intValue, 5)

        XCTAssertEqual(encoded[3]["tool_call_id"]?.stringValue, "call_9")
    }

    func testImageIsSentAsDataURL() throws {
        let provider = OpenAICompatibleProvider(config: ProviderConfig(apiKey: "x"))
        let png = Data([0x89, 0x50, 0x4E, 0x47])
        let encoded = provider.encodeMessages(
            [ChatMessage(role: .user, text: "look", images: [png])],
            systemPrompt: ""
        )
        let parts = try XCTUnwrap(encoded[0]["content"]?.arrayValue)
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(parts[1]["type"]?.stringValue, "image_url")
        let url = try XCTUnwrap(parts[1]["image_url"]?["url"]?.stringValue)
        XCTAssertTrue(url.hasPrefix("data:image/png;base64,"))
    }

    func testJPEGScreenshotIsLabelledAsJPEG() throws {
        let provider = OpenAICompatibleProvider(config: ProviderConfig(apiKey: "x"))
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])
        let encoded = provider.encodeMessages(
            [ChatMessage(role: .user, text: "", images: [jpeg])],
            systemPrompt: ""
        )
        let parts = try XCTUnwrap(encoded[0]["content"]?.arrayValue)
        let url = try XCTUnwrap(parts[0]["image_url"]?["url"]?.stringValue)
        XCTAssertTrue(url.hasPrefix("data:image/jpeg;base64,"))
    }

    func testExtraBodyIsMergedAndWinsOverDefaults() {
        var config = ProviderConfig(apiKey: "x", temperature: 0.3)
        config.extraBody = [
            "reasoning_effort": .string("none"),
            "temperature": .number(1),
        ]
        let payload = OpenAICompatibleProvider(config: config)
            .makePayload(messages: [], tools: [], systemPrompt: "", stream: true)
        XCTAssertEqual(payload["reasoning_effort"]?.stringValue, "none")
        XCTAssertEqual(payload["temperature"]?.doubleValue, 1)
        XCTAssertEqual(payload["stream"]?.boolValue, true)
    }

    func testDecodesToolCallsAndUsage() throws {
        let provider = OpenAICompatibleProvider(config: ProviderConfig(apiKey: "x"))
        let json = """
            {"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,
            "tool_calls":[{"id":"c1","type":"function","function":{"name":"scroll",
            "arguments":"{\\"direction\\":\\"down\\",\\"pages\\":2}"}}]}}],
            "usage":{"prompt_tokens":12,"completion_tokens":3}}
            """
        let completion = try provider.decode(Data(json.utf8))
        XCTAssertEqual(completion.toolCalls.count, 1)
        XCTAssertEqual(completion.toolCalls[0].name, "scroll")
        XCTAssertEqual(completion.toolCalls[0].arguments["pages"]?.intValue, 2)
        XCTAssertEqual(completion.usage?.inputTokens, 12)
        XCTAssertEqual(completion.stopReason, "tool_calls")
    }

    func testDecodesProviderErrorEnvelope() {
        let provider = OpenAICompatibleProvider(config: ProviderConfig(apiKey: "x"))
        let json = #"{"error":{"message":"bad key","type":"invalid_request_error"}}"#
        XCTAssertThrowsError(try provider.decode(Data(json.utf8))) { error in
            XCTAssertTrue("\(error)".contains("bad key"))
        }
    }

    func testDecodesPlainTextAnswer() throws {
        let provider = OpenAICompatibleProvider(config: ProviderConfig(apiKey: "x"))
        let json = #"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"hi"}}]}"#
        let completion = try provider.decode(Data(json.utf8))
        XCTAssertEqual(completion.text, "hi")
        XCTAssertFalse(completion.wantsToolCalls)
    }
}

final class AnthropicEncodingTests: XCTestCase {
    func testSystemPromptIsTopLevelNotAMessage() {
        let provider = AnthropicProvider(config: ProviderConfig(wire: .anthropic, apiKey: "x"))
        let encoded = provider.encodeMessages([ChatMessage(role: .system, text: "sys")])
        XCTAssertTrue(encoded.isEmpty)
    }

    func testToolResultsBecomeUserToolResultBlocks() throws {
        let provider = AnthropicProvider(config: ProviderConfig(wire: .anthropic, apiKey: "x"))
        let encoded = provider.encodeMessages([
            ChatMessage(role: .assistant, text: "", toolCalls: [
                ToolCall(id: "t1", name: "click", arguments: .object([:]))
            ]),
            ChatMessage(role: .tool, text: "clicked", toolCallID: "t1", isError: false),
        ])
        XCTAssertEqual(encoded.count, 2)
        XCTAssertEqual(encoded[0]["role"]?.stringValue, "assistant")
        XCTAssertEqual(encoded[1]["role"]?.stringValue, "user")
        let block = try XCTUnwrap(encoded[1]["content"]?.arrayValue?.first)
        XCTAssertEqual(block["type"]?.stringValue, "tool_result")
        XCTAssertEqual(block["tool_use_id"]?.stringValue, "t1")
    }

    func testConsecutiveSameRoleMessagesAreMerged() throws {
        let provider = AnthropicProvider(config: ProviderConfig(wire: .anthropic, apiKey: "x"))
        let encoded = provider.encodeMessages([
            ChatMessage(role: .tool, text: "a", toolCallID: "1"),
            ChatMessage(role: .tool, text: "b", toolCallID: "2"),
        ])
        XCTAssertEqual(encoded.count, 1)
        XCTAssertEqual(encoded[0]["content"]?.arrayValue?.count, 2)
    }

    func testImageUsesBase64SourceBlock() throws {
        let provider = AnthropicProvider(config: ProviderConfig(wire: .anthropic, apiKey: "x"))
        let encoded = provider.encodeMessages([
            ChatMessage(role: .user, text: "see", images: [Data([1, 2, 3])])
        ])
        let blocks = try XCTUnwrap(encoded[0]["content"]?.arrayValue)
        XCTAssertEqual(blocks[0]["type"]?.stringValue, "image")
        XCTAssertEqual(blocks[0]["source"]?["media_type"]?.stringValue, "image/png")
    }

    func testDecodesTextAndToolUse() throws {
        let provider = AnthropicProvider(config: ProviderConfig(wire: .anthropic, apiKey: "x"))
        let json = """
            {"content":[{"type":"text","text":"thinking"},
            {"type":"tool_use","id":"u1","name":"press_key","input":{"key":"Return"}}],
            "stop_reason":"tool_use","usage":{"input_tokens":9,"output_tokens":4}}
            """
        let completion = try provider.decode(Data(json.utf8))
        XCTAssertEqual(completion.text, "thinking")
        XCTAssertEqual(completion.toolCalls.count, 1)
        XCTAssertEqual(completion.toolCalls[0].arguments["key"]?.stringValue, "Return")
        XCTAssertEqual(completion.usage?.outputTokens, 4)
    }
}

/// Answers any request with one scripted body, without a network.
///
/// `URLSession.bytes(for:)` still speaks to a URLProtocol, so this exercises the
/// real SSE reader: the lines, the `[DONE]`, the fragmented tool arguments and
/// the usage chunk all pass through the same code the agent uses.
final class StreamingURLProtocol: URLProtocol {
    nonisolated(unsafe) static var responses: [(status: Int, body: String)] = []
    nonisolated(unsafe) static var contentType = "text/event-stream"

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let next = Self.responses.isEmpty
            ? (status: 500, body: #"{"error":{"message":"no scripted response"}}"#)
            : Self.responses.removeFirst()
        let data = Data(next.body.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: next.status,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": Self.contentType,
                "Content-Length": "\(data.count)",
            ]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class StreamingProviderTests: XCTestCase {
    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StreamingURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override func tearDown() {
        StreamingURLProtocol.responses = []
        StreamingURLProtocol.contentType = "text/event-stream"
        super.tearDown()
    }

    func testOpenAIStreamsTextAndAssemblesFragmentedToolCalls() async throws {
        StreamingURLProtocol.responses = [(200, """
            data: {"choices":[{"delta":{"content":"Открываю"},"finish_reason":null}]}

            data: {"choices":[{"delta":{"content":" Telegram"},"finish_reason":null}]}

            data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"click","arguments":"{\\"x\\":"}}]},"finish_reason":null}]}

            data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"5}"}}]},"finish_reason":"tool_calls"}]}

            data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}

            data: [DONE]

            """)]

        let provider = OpenAICompatibleProvider(
            config: ProviderConfig(apiKey: "x", maxTokens: 64),
            session: session()
        )
        var deltas: [String] = []
        let completion = try await provider.complete(
            messages: [ChatMessage(role: .user, text: "go")],
            tools: [],
            systemPrompt: "sys"
        ) { deltas.append($0) }

        XCTAssertEqual(deltas, ["Открываю", " Telegram"])
        XCTAssertEqual(completion.text, "Открываю Telegram")
        XCTAssertEqual(completion.stopReason, "tool_calls")
        XCTAssertEqual(completion.toolCalls.count, 1)
        XCTAssertEqual(completion.toolCalls[0].id, "c1")
        XCTAssertEqual(completion.toolCalls[0].name, "click")
        XCTAssertEqual(completion.toolCalls[0].arguments["x"]?.intValue, 5)
        XCTAssertEqual(completion.usage?.inputTokens, 12)
        XCTAssertEqual(completion.usage?.outputTokens, 3)
    }

    func testOpenAIFallsBackWhenTheGatewayRejectsStreaming() async throws {
        // The first response is the refusal; the fallback is a normal JSON
        // completion, exactly as a gateway that never implemented SSE answers.
        StreamingURLProtocol.responses = [
            (400, #"{"error":{"message":"stream not supported"}}"#),
            (200, #"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Готово"}}]}"#),
        ]

        let provider = OpenAICompatibleProvider(
            config: ProviderConfig(apiKey: "x", maxTokens: 64),
            session: session()
        )
        var deltas: [String] = []
        let completion = try await provider.complete(
            messages: [ChatMessage(role: .user, text: "go")],
            tools: [],
            systemPrompt: "sys"
        ) { deltas.append($0) }

        XCTAssertTrue(deltas.isEmpty)
        XCTAssertEqual(completion.text, "Готово")
        XCTAssertEqual(completion.stopReason, "stop")
    }

    func testOpenAIReadsAPlainJSONAnswerToAStreamRequest() async throws {
        // Some gateways accept `stream: true` and answer in one piece. The
        // content type is the only honest signal; parsing JSON as SSE would
        // otherwise end the run with an empty answer.
        StreamingURLProtocol.contentType = "application/json"
        StreamingURLProtocol.responses = [
            (200, #"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Готово"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}"#),
        ]

        let provider = OpenAICompatibleProvider(
            config: ProviderConfig(apiKey: "x", maxTokens: 64),
            session: session()
        )
        var deltas: [String] = []
        let completion = try await provider.complete(
            messages: [ChatMessage(role: .user, text: "go")],
            tools: [],
            systemPrompt: "sys"
        ) { deltas.append($0) }

        XCTAssertTrue(deltas.isEmpty)
        XCTAssertEqual(completion.text, "Готово")
        XCTAssertEqual(completion.usage?.inputTokens, 5)
    }

    func testAnthropicStreamsTextAndToolInputFragments() async throws {
        StreamingURLProtocol.responses = [(200, """
            event: message_start
            data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}

            event: content_block_start
            data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

            event: content_block_delta
            data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Привет"}}

            event: content_block_start
            data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"click","input":{}}}

            event: content_block_delta
            data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":5}"}}

            event: message_delta
            data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}

            event: message_stop
            data: {"type":"message_stop"}

            """)]

        let provider = AnthropicProvider(
            config: ProviderConfig(wire: .anthropic, apiKey: "x", maxTokens: 64),
            session: session()
        )
        var deltas: [String] = []
        let completion = try await provider.complete(
            messages: [ChatMessage(role: .user, text: "go")],
            tools: [],
            systemPrompt: "sys"
        ) { deltas.append($0) }

        XCTAssertEqual(deltas, ["Привет"])
        XCTAssertEqual(completion.text, "Привет")
        XCTAssertEqual(completion.stopReason, "tool_use")
        XCTAssertEqual(completion.toolCalls.count, 1)
        XCTAssertEqual(completion.toolCalls[0].id, "t1")
        XCTAssertEqual(completion.toolCalls[0].name, "click")
        XCTAssertEqual(completion.toolCalls[0].arguments["x"]?.intValue, 5)
        XCTAssertEqual(completion.usage?.inputTokens, 10)
        XCTAssertEqual(completion.usage?.outputTokens, 7)
    }
}
