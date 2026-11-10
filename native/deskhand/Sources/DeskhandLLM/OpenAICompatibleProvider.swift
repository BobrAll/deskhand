import Foundation
import DeskhandCore

/// OpenAI chat-completions wire format.
///
/// This is the widest compatibility target in the industry: OpenRouter, Groq,
/// Together, Fireworks, DeepSeek, Mistral, xAI, Ollama, LM Studio, vLLM,
/// llama.cpp's server, and most corporate gateways all speak it. Anything that
/// deviates gets handled through `extraHeaders` and `omitAuthHeader`.
public struct OpenAICompatibleProvider: StreamingChatProvider {
    public let config: ProviderConfig
    private let session: URLSession

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
            let body = await collect(bytes, limit: 4096)
            exchange?.response(body, status: http.statusCode)
            // A gateway that does not implement SSE is still a working
            // chat-completions endpoint. Nothing has been shown yet, so falling
            // back to the one-shot shape is invisible to the user and keeps
            // local servers and older proxies usable.
            if [400, 404, 422].contains(http.statusCode) {
                return try await complete(messages: messages, tools: tools, systemPrompt: systemPrompt)
            }
            throw LLMError.http(
                status: http.statusCode,
                body: String(data: body, encoding: .utf8) ?? "<binary>"
            )
        }

        // Some gateways accept `stream: true` and answer with one ordinary JSON
        // completion anyway. Trust the content type rather than spending the
        // body on an SSE parser that will find no `data:` lines in it.
        if let contentType = http.value(forHTTPHeaderField: "Content-Type"),
           contentType.lowercased().contains("application/json") {
            let body = await collect(bytes, limit: 16 * 1024 * 1024)
            exchange?.response(body, status: http.statusCode)
            return try decode(body)
        }

        return try await decodeStream(bytes, exchange: exchange, status: http.statusCode, onText: onText)
    }

    private func requireKey() throws {
        if config.apiKey == nil && !config.omitAuthHeader {
            throw LLMError.missingAPIKey("Set DESKHAND_API_KEY or add api_key to ~/.deskhand/config.toml")
        }
    }

    func makePayload(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String,
        stream: Bool
    ) -> [String: JSONValue] {
        var payload: [String: JSONValue] = [
            "model": .string(config.model),
            "messages": .array(encodeMessages(messages, systemPrompt: systemPrompt)),
            "max_tokens": .number(Double(config.maxTokens)),
            "stream": .bool(stream),
        ]
        if config.baseURL.host == "openrouter.ai" {
            payload["reasoning"] = .object(["enabled": .bool(false)])
        } else if config.model.components(separatedBy: "/").last?.range(
            of: #"^gpt-(?:5\.[1-9]|[6-9])"#, options: .regularExpression
        ) != nil {
            payload["reasoning_effort"] = .string("none")
        }
        if let temperature = config.temperature {
            payload["temperature"] = .number(temperature)
        }
        if !tools.isEmpty {
            payload["tools"] = .array(tools.map(\.openAIJSON))
            payload["tool_choice"] = .string("auto")
        }
        payload.merge(config.extraBody) { _, user in user }
        return payload
    }

    private func makeRequest(payload: [String: JSONValue]) -> URLRequest {
        var request = URLRequest(url: config.endpointURL())
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Deskhand/0.1", forHTTPHeaderField: "User-Agent")
        if let key = config.apiKey, !config.omitAuthHeader {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        for (name, value) in config.extraHeaders {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.httpBody = JSONValue.object(payload).serializedData()
        return request
    }

    private struct ToolCallBuilder {
        var id = ""
        var name = ""
        var arguments = ""
    }

    /// Reads the `text/event-stream` body.
    ///
    /// Tool calls arrive in fragments — an id in one chunk, a name in another,
    /// and the arguments as a string that only parses once the last piece lands —
    /// so they are collected by stream index and parsed at the end.
    private func decodeStream(
        _ bytes: URLSession.AsyncBytes,
        exchange: ModelTrace.Exchange?,
        status: Int,
        onText: (String) -> Void
    ) async throws -> Completion {
        var text = ""
        var builders: [Int: ToolCallBuilder] = [:]
        var stopReason: String?
        var usage: Usage?
        var sawDone = false

        var lines: [JSONValue] = []
        defer { exchange?.stream(lines, status: status) }
        for try await line in bytes.lines {
            if exchange != nil { lines.append(.string(line)) }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.hasPrefix("data:") else { continue }
            let raw = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if raw == "[DONE]" {
                sawDone = true
                break
            }
            guard let value = try? JSONValue.parse(raw) else { continue }
            if let message = value["error"]?["message"]?.stringValue {
                throw LLMError.provider(message)
            }
            if let usageValue = value["usage"] {
                usage = Usage(
                    inputTokens: usageValue["prompt_tokens"]?.intValue ?? 0,
                    outputTokens: usageValue["completion_tokens"]?.intValue ?? 0
                )
            }
            guard let choice = value["choices"]?.arrayValue?.first else { continue }
            if let reason = choice["finish_reason"]?.stringValue {
                stopReason = reason
            }
            let delta = choice["delta"]
            if let content = delta?["content"]?.stringValue, !content.isEmpty {
                text += content
                onText(content)
            }
            if let rawCalls = delta?["tool_calls"]?.arrayValue {
                for rawCall in rawCalls {
                    let index = rawCall["index"]?.intValue ?? 0
                    var builder = builders[index] ?? ToolCallBuilder()
                    if let id = rawCall["id"]?.stringValue, !id.isEmpty {
                        builder.id = id
                    }
                    if let name = rawCall["function"]?["name"]?.stringValue, !name.isEmpty {
                        builder.name += name
                    }
                    if let arguments = rawCall["function"]?["arguments"]?.stringValue {
                        builder.arguments += arguments
                    }
                    builders[index] = builder
                }
            }
        }

        if stopReason == nil && !sawDone && text.isEmpty && builders.isEmpty {
            throw LLMError.transport("the response stream ended before the model answered")
        }

        let calls = builders.keys.sorted().map { index -> ToolCall in
            let builder = builders[index]!
            let arguments = (try? JSONValue.parse(builder.arguments)) ?? .object([:])
            return ToolCall(
                id: builder.id.isEmpty ? UUID().uuidString : builder.id,
                name: builder.name,
                arguments: arguments
            )
        }
        if stopReason == "tool_calls" && calls.isEmpty {
            throw LLMError.decoding("the stream announced tool calls but none arrived")
        }

        return Completion(text: text, toolCalls: calls, stopReason: stopReason, usage: usage)
    }

    private func collect(_ bytes: URLSession.AsyncBytes, limit: Int) async -> Data {
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count >= limit { break }
            }
        } catch {
            // The body is only used for the error message; a broken read must not
            // replace the HTTP error with a transport one.
        }
        return data
    }

    func encodeMessages(_ messages: [ChatMessage], systemPrompt: String) -> [JSONValue] {
        var out: [JSONValue] = []
        if !systemPrompt.isEmpty {
            out.append(.object([
                "role": .string("system"),
                "content": .string(systemPrompt),
            ]))
        }

        for message in messages {
            switch message.role {
            case .system:
                out.append(.object([
                    "role": .string("system"),
                    "content": .string(message.text),
                ]))

            case .user:
                if message.images.isEmpty {
                    out.append(.object([
                        "role": .string("user"),
                        "content": .string(message.text),
                    ]))
                } else {
                    var parts: [JSONValue] = []
                    if !message.text.isEmpty {
                        parts.append(.object([
                            "type": .string("text"),
                            "text": .string(message.text),
                        ]))
                    }
                    for image in message.images {
                        parts.append(.object([
                            "type": .string("image_url"),
                            "image_url": .object([
                                "url": .string("data:\(WindowCapture.mimeType(of: image));base64," + image.base64EncodedString()),
                            ]),
                        ]))
                    }
                    out.append(.object([
                        "role": .string("user"),
                        "content": .array(parts),
                    ]))
                }

            case .assistant:
                var object: [String: JSONValue] = [
                    "role": .string("assistant"),
                    "content": message.text.isEmpty ? .null : .string(message.text),
                ]
                if !message.toolCalls.isEmpty {
                    object["tool_calls"] = .array(message.toolCalls.map { call in
                        .object([
                            "id": .string(call.id),
                            "type": .string("function"),
                            "function": .object([
                                "name": .string(call.name),
                                "arguments": .string(call.arguments.serialized()),
                            ]),
                        ])
                    })
                }
                out.append(.object(object))

            case .tool:
                out.append(.object([
                    "role": .string("tool"),
                    "tool_call_id": .string(message.toolCallID ?? ""),
                    "content": .string(message.text),
                ]))
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

        guard let choices = root["choices"]?.arrayValue, let first = choices.first else {
            throw LLMError.decoding("response has no choices")
        }
        let message = first["message"]
        let text = message?["content"]?.stringValue ?? ""
        let stopReason = first["finish_reason"]?.stringValue

        var calls: [ToolCall] = []
        if let rawCalls = message?["tool_calls"]?.arrayValue {
            for raw in rawCalls {
                let id = raw["id"]?.stringValue ?? UUID().uuidString
                let name = raw["function"]?["name"]?.stringValue ?? ""
                let argumentText = raw["function"]?["arguments"]?.stringValue ?? "{}"
                let arguments = (try? JSONValue.parse(argumentText)) ?? .object([:])
                calls.append(ToolCall(id: id, name: name, arguments: arguments))
            }
        }

        var usage: Usage?
        if let usageValue = root["usage"] {
            usage = Usage(
                inputTokens: usageValue["prompt_tokens"]?.intValue ?? 0,
                outputTokens: usageValue["completion_tokens"]?.intValue ?? 0
            )
        }

        return Completion(text: text, toolCalls: calls, stopReason: stopReason, usage: usage)
    }
}
