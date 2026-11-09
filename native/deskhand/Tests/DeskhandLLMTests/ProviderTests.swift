import XCTest
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
        ]
        for (input, expected) in cases {
            let config = ProviderConfig(baseURL: URL(string: input)!)
            XCTAssertEqual(config.endpointURL().absoluteString, expected, input)
        }
    }

    func testAnthropicEndpointNormalization() {
        let config = ProviderConfig(
            wire: .anthropic,
            baseURL: URL(string: "https://api.anthropic.com/v1")!
        )
        XCTAssertEqual(config.endpointURL().absoluteString, "https://api.anthropic.com/v1/messages")
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
            ChatMessage(role: .tool, text: "clicked", toolCallID: "t1", toolIsError: false),
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
