import Foundation
import DeskhandCore

/// OpenAI chat-completions wire format.
///
/// This is the widest compatibility target in the industry: OpenRouter, Groq,
/// Together, Fireworks, DeepSeek, Mistral, xAI, Ollama, LM Studio, vLLM,
/// llama.cpp's server, and most corporate gateways all speak it. Anything that
/// deviates gets handled through `extraHeaders` and `omitAuthHeader`.
public struct OpenAICompatibleProvider: ChatProvider {
    public let config: ProviderConfig
    private let session: URLSession

    public init(config: ProviderConfig, timeout: TimeInterval = 180) {
        self.config = config
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        self.session = URLSession(configuration: configuration)
    }

    public func complete(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String
    ) async throws -> Completion {
        if config.apiKey == nil && !config.omitAuthHeader {
            throw LLMError.missingAPIKey("Set DESKHAND_API_KEY or add api_key to ~/.deskhand/config.toml")
        }

        var payload: [String: JSONValue] = [
            "model": .string(config.model),
            "messages": .array(encodeMessages(messages, systemPrompt: systemPrompt)),
            "max_tokens": .number(Double(config.maxTokens)),
            "stream": .bool(false),
        ]
        if let temperature = config.temperature {
            payload["temperature"] = .number(temperature)
        }
        if !tools.isEmpty {
            payload["tools"] = .array(tools.map(\.openAIJSON))
            payload["tool_choice"] = .string("auto")
        }

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

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw LLMError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw LLMError.transport("no HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw LLMError.http(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? "<binary>"
            )
        }

        return try decode(data)
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
                                "url": .string("data:image/png;base64," + image.base64EncodedString()),
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
