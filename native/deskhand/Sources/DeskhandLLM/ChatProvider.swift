import Foundation
import DeskhandCore

/// One turn in a conversation, in a provider-neutral shape.
public struct ChatMessage: Sendable {
    public enum Role: String, Sendable {
        case system, user, assistant, tool
    }

    public var role: Role
    public var text: String
    /// Images attached to a user message, as PNG data.
    public var images: [Data]
    /// Tool calls requested by the assistant.
    public var toolCalls: [ToolCall]
    /// Identifier of the tool call this message answers.
    public var toolCallID: String?
    /// Set when a tool call failed, so providers that support it can mark it.
    public var toolIsError: Bool

    public init(
        role: Role,
        text: String = "",
        images: [Data] = [],
        toolCalls: [ToolCall] = [],
        toolCallID: String? = nil,
        toolIsError: Bool = false
    ) {
        self.role = role
        self.text = text
        self.images = images
        self.toolCalls = toolCalls
        self.toolCallID = toolCallID
        self.toolIsError = toolIsError
    }
}

public struct ToolCall: Sendable, Equatable {
    public var id: String
    public var name: String
    public var arguments: JSONValue

    public init(id: String, name: String, arguments: JSONValue) {
        self.id = id
        self.name = name
        self.arguments = arguments
    }
}

public struct Completion: Sendable {
    public var text: String
    public var toolCalls: [ToolCall]
    public var stopReason: String?
    public var usage: Usage?

    public init(text: String, toolCalls: [ToolCall], stopReason: String?, usage: Usage? = nil) {
        self.text = text
        self.toolCalls = toolCalls
        self.stopReason = stopReason
        self.usage = usage
    }

    public var wantsToolCalls: Bool { !toolCalls.isEmpty }
}

public struct Usage: Sendable, Equatable {
    public var inputTokens: Int
    public var outputTokens: Int

    public init(inputTokens: Int, outputTokens: Int) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }
}

public enum LLMError: Error, CustomStringConvertible {
    case http(status: Int, body: String)
    case transport(String)
    case decoding(String)
    case missingAPIKey(String)
    case provider(String)

    public var description: String {
        switch self {
        case .http(let status, let body):
            let trimmed = body.count > 1200 ? String(body.prefix(1200)) + "…" : body
            return "provider returned HTTP \(status): \(trimmed)"
        case .transport(let message): return "network error: \(message)"
        case .decoding(let message): return "could not decode the provider response: \(message)"
        case .missingAPIKey(let hint): return "no API key configured. \(hint)"
        case .provider(let message): return message
        }
    }
}

/// A chat model that can call tools. Implemented once per wire format.
public protocol ChatProvider: Sendable {
    var config: ProviderConfig { get }

    func complete(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String
    ) async throws -> Completion
}
