import Foundation
import DeskhandCore

/// Anthropic messages wire format, including the `anthropic-version` header and
/// the block-based content array. `baseURL` is configurable so this also works
/// against Anthropic-compatible proxies.
public struct AnthropicProvider: ChatProvider {
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

    public func complete(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String
    ) async throws -> Completion {
        if config.apiKey == nil && !config.omitAuthHeader {
            throw LLMError.missingAPIKey("Set ANTHROPIC_API_KEY or add api_key to ~/.deskhand/config.toml")
        }

        var payload: [String: JSONValue] = [
            "model": .string(config.model),
            "max_tokens": .number(Double(config.maxTokens)),
            "messages": .array(encodeMessages(messages)),
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

        var request = URLRequest(url: config.endpointURL())
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(Self.apiVersion, forHTTPHeaderField: "anthropic-version")
        request.setValue("Deskhand/0.1", forHTTPHeaderField: "User-Agent")
        if let key = config.apiKey, !config.omitAuthHeader {
            request.setValue(key, forHTTPHeaderField: "x-api-key")
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
                            "media_type": .string("image/png"),
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
                    "is_error": .bool(message.toolIsError),
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

        var usage: Usage?
        if let usageValue = root["usage"] {
            usage = Usage(
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
