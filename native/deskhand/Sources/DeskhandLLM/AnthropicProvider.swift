import Foundation
import DeskhandCore

/// Anthropic messages wire format, including the `anthropic-version` header and
/// the block-based content array. `baseURL` is configurable so this also works
/// against Anthropic-compatible proxies.
public struct AnthropicProvider: StreamingChatProvider {
    public let config: ProviderConfig
    private let session: URLSession

    public static let apiVersion = "2023-06-01"

    public init(config: ProviderConfig, timeout: TimeInterval = 180) {
        self.config = config
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        self.session = URLSession(configuration: configuration)
    }

    /// Test seam: lets a URLProtocol answer the SSE request without a network.
    init(config: ProviderConfig, session: URLSession) {
        self.config = config
        self.session = session
    }

    public func complete(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String
    ) async throws -> Completion {
        try requireKey()
        let request = makeRequest(payload: makePayload(
            messages: messages, tools: tools, systemPrompt: systemPrompt, stream: false
        ))
        let exchange = ModelTrace.start(request)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            exchange?.failed(error)
            throw LLMError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw LLMError.transport("no HTTP response")
        }
        exchange?.response(data, status: http.statusCode)
        guard (200..<300).contains(http.statusCode) else {
            throw LLMError.http(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? "<binary>"
            )
        }

        return try decode(data)
    }

    public func complete(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String,
        onText: (String) -> Void
    ) async throws -> Completion {
        try requireKey()
        let request = makeRequest(payload: makePayload(
            messages: messages, tools: tools, systemPrompt: systemPrompt, stream: true
        ))
        let exchange = ModelTrace.start(request)

        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch {
            exchange?.failed(error)
            throw LLMError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw LLMError.transport("no HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = await bytes.prefixData(limit: 4096)
            exchange?.response(body, status: http.statusCode)
            // Same fallback as the OpenAI wire: a proxy that refuses `stream`
            // can still answer in one piece, and nothing has been shown yet.
            if ProviderHTTP.streamingFallbackStatuses.contains(http.statusCode) {
                return try await complete(messages: messages, tools: tools, systemPrompt: systemPrompt)
            }
            throw LLMError.http(
                status: http.statusCode,
                body: String(data: body, encoding: .utf8) ?? "<binary>"
            )
        }

        if let contentType = http.value(forHTTPHeaderField: "Content-Type"),
           contentType.lowercased().contains("application/json") {
            let body = await bytes.prefixData(limit: 16 * 1024 * 1024)
            exchange?.response(body, status: http.statusCode)
            return try decode(body)
        }

        return try await decodeStream(bytes, exchange: exchange, status: http.statusCode, onText: onText)
    }

    private func requireKey() throws {
        if config.apiKey == nil && !config.omitAuthHeader {
            throw LLMError.missingAPIKey("Set ANTHROPIC_API_KEY or add api_key to ~/.deskhand/config.toml")
        }
    }

    private func makePayload(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String,
        stream: Bool
    ) -> [String: JSONValue] {
        var payload: [String: JSONValue] = [
            "model": .string(config.model),
            "max_tokens": .number(Double(config.maxTokens)),
            "messages": .array(encodeMessages(messages)),
            "thinking": .object(["type": .string("disabled")]),
            "stream": .bool(stream),
        ]
        if !systemPrompt.isEmpty {
            payload["system"] = .string(systemPrompt)
        }
        if let temperature = config.temperature {
            payload["temperature"] = .number(temperature)
        }
        if !tools.isEmpty {
            payload["tools"] = .array(tools.map(\.anthropicJSON))
        }
        payload.merge(config.extraBody) { _, user in user }
        return payload
    }

    private func makeRequest(payload: [String: JSONValue]) -> URLRequest {
        var request = URLRequest(url: config.endpointURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(Self.apiVersion, forHTTPHeaderField: "anthropic-version")
        request.setValue(ProviderHTTP.userAgent, forHTTPHeaderField: "User-Agent")
        if let key = config.apiKey, !config.omitAuthHeader {
            request.setValue(key, forHTTPHeaderField: "x-api-key")
        }
        for (name, value) in config.extraHeaders {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.httpBody = JSONValue.object(payload).serializedData()
        return request
    }

    /// Reads Anthropic's block-based `text/event-stream`.
    ///
    /// Tool input arrives as `input_json_delta.partial_json` fragments inside a
    /// `tool_use` block, so the block index is the identity: text and tool calls
    /// can interleave, and the arguments are parsed only when the block ends.
    private func decodeStream(
        _ bytes: URLSession.AsyncBytes,
        exchange: ModelTrace.Exchange?,
        status: Int,
        onText: (String) -> Void
    ) async throws -> Completion {
        var text = ""
        var builders: [Int: ToolCallBuilder] = [:]
        var stopReason: String?
        var inputTokens: Int?
        var outputTokens: Int?
        var sawEnd = false

        var lines: [JSONValue] = []
        defer { exchange?.stream(lines, status: status) }
        for try await line in bytes.lines {
            if exchange != nil { lines.append(.string(line)) }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.hasPrefix("data:") else { continue }
            let raw = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if raw == "[DONE]" {
                // Some Anthropic-compatible proxies end with the OpenAI marker
                // instead of `message_stop`.
                sawEnd = true
                break
            }
            guard let value = try? JSONValue.parse(raw) else { continue }

            switch value["type"]?.stringValue {
            case "error":
                let message = value["error"]?["message"]?.stringValue ?? "stream error"
                throw LLMError.provider(message)

            case "message_start":
                let usage = value["message"]?["usage"]
                inputTokens = usage?["input_tokens"]?.intValue
                outputTokens = usage?["output_tokens"]?.intValue

            case "content_block_start":
                let index = value["index"]?.intValue ?? 0
                let block = value["content_block"]
                guard block?["type"]?.stringValue == "tool_use" else { continue }
                var builder = builders[index] ?? ToolCallBuilder()
                builder.id = block?["id"]?.stringValue ?? ""
                builder.name = block?["name"]?.stringValue ?? ""
                builders[index] = builder

            case "content_block_delta":
                let index = value["index"]?.intValue ?? 0
                let delta = value["delta"]
                switch delta?["type"]?.stringValue {
                case "text_delta":
                    if let chunk = delta?["text"]?.stringValue, !chunk.isEmpty {
                        text += chunk
                        onText(chunk)
                    }
                case "input_json_delta":
                    if let partial = delta?["partial_json"]?.stringValue, !partial.isEmpty {
                        var builder = builders[index] ?? ToolCallBuilder()
                        builder.arguments += partial
                        builders[index] = builder
                    }
                default:
                    continue
                }

            case "message_delta":
                if let reason = value["delta"]?["stop_reason"]?.stringValue {
                    stopReason = reason
                }
                if let output = value["usage"]?["output_tokens"]?.intValue {
                    outputTokens = output
                }

            case "message_stop":
                sawEnd = true

            default:
                continue
            }
        }

        // A cut connection is not a finished answer, even when some text
        // arrived before the cut: without a stop reason or `message_stop` the
        // text is half a reply, and the loop would show it as final.
        guard sawEnd || stopReason != nil else {
            throw LLMError.transport("the response stream ended before the model finished")
        }

        let calls = builders.keys.sorted().map { index -> ToolCall in
            let builder = builders[index]!
            return makeToolCall(
                id: builder.id.isEmpty ? UUID().uuidString : builder.id,
                name: builder.name,
                argumentsJSON: builder.arguments
            )
        }
        if stopReason == "tool_use" && calls.isEmpty {
            throw LLMError.decoding("the stream announced a tool use but none arrived")
        }

        let usage = (inputTokens == nil && outputTokens == nil)
            ? nil
            : TokenUsage(inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0)
        return Completion(text: text, toolCalls: calls, stopReason: stopReason, usage: usage)
    }

    /// Anthropic requires tool results to be `user` messages containing
    /// `tool_result` blocks, and consecutive same-role messages to be merged.
    func encodeMessages(_ messages: [ChatMessage]) -> [JSONValue] {
        var out: [JSONValue] = []

        func appendMerging(role: String, blocks: [JSONValue]) {
            if let last = out.last?.objectValue,
               last["role"]?.stringValue == role,
               let existing = last["content"]?.arrayValue {
                var merged = existing
                merged.append(contentsOf: blocks)
                out[out.count - 1] = .object([
                    "role": .string(role),
                    "content": .array(merged),
                ])
            } else {
                out.append(.object([
                    "role": .string(role),
                    "content": .array(blocks),
                ]))
            }
        }

        for message in messages {
            switch message.role {
            case .system:
                // System prompts travel in the top-level `system` field.
                continue

            case .user:
                var blocks: [JSONValue] = []
                for image in message.images {
                    blocks.append(.object([
                        "type": .string("image"),
                        "source": .object([
                            "type": .string("base64"),
                            "media_type": .string(WindowCapture.mimeType(of: image)),
                            "data": .string(image.base64EncodedString()),
                        ]),
                    ]))
                }
                if !message.text.isEmpty {
                    blocks.append(.object([
                        "type": .string("text"),
                        "text": .string(message.text),
                    ]))
                }
                appendMerging(role: "user", blocks: blocks)

            case .assistant:
                var blocks: [JSONValue] = []
                if !message.text.isEmpty {
                    blocks.append(.object([
                        "type": .string("text"),
                        "text": .string(message.text),
                    ]))
                }
                for call in message.toolCalls {
                    blocks.append(.object([
                        "type": .string("tool_use"),
                        "id": .string(call.id),
                        "name": .string(call.name),
                        "input": call.arguments,
                    ]))
                }
                if blocks.isEmpty { continue }
                appendMerging(role: "assistant", blocks: blocks)

            case .tool:
                let block = JSONValue.object([
                    "type": .string("tool_result"),
                    "tool_use_id": .string(message.toolCallID ?? ""),
                    "content": .string(message.text),
                    "is_error": .bool(message.isError),
                ])
                appendMerging(role: "user", blocks: [block])
            }
        }
        return out
    }

    func decode(_ data: Data) throws -> Completion {
        let root: JSONValue
        do {
            root = try JSONValue.parse(data)
        } catch {
            throw LLMError.decoding("response was not JSON: \(error)")
        }

        if let errorMessage = root["error"]?["message"]?.stringValue {
            throw LLMError.provider(errorMessage)
        }

        guard let content = root["content"]?.arrayValue else {
            throw LLMError.decoding("response has no content blocks")
        }

        var text = ""
        var calls: [ToolCall] = []
        for block in content {
            switch block["type"]?.stringValue {
            case "text":
                text += block["text"]?.stringValue ?? ""
            case "tool_use":
                calls.append(ToolCall(
                    id: block["id"]?.stringValue ?? UUID().uuidString,
                    name: block["name"]?.stringValue ?? "",
                    arguments: block["input"] ?? .object([:])
                ))
            default:
                continue
            }
        }

        var usage: TokenUsage?
        if let usageValue = root["usage"] {
            usage = TokenUsage(
                inputTokens: usageValue["input_tokens"]?.intValue ?? 0,
                outputTokens: usageValue["output_tokens"]?.intValue ?? 0
            )
        }

        return Completion(
            text: text,
            toolCalls: calls,
            stopReason: root["stop_reason"]?.stringValue,
            usage: usage
        )
    }
}

public enum ProviderFactory {
    public static func make(config: ProviderConfig) -> ChatProvider {
        switch config.wire {
        case .openAICompatible: return OpenAICompatibleProvider(config: config)
        case .anthropic: return AnthropicProvider(config: config)
        }
    }
}
