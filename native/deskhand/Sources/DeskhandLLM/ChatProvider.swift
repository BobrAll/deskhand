import Foundation
import DeskhandCore

/// One turn in a conversation, in a provider-neutral shape.
public struct ChatMessage: Sendable {
    public enum Role: String, Sendable {
        case system, user, assistant, tool
    }

    public var role: Role
    public var text: String
    /// Images attached to a user message, as PNG or JPEG data.
    public var images: [Data]
    /// Tool calls requested by the assistant.
    public var toolCalls: [ToolCall]
    /// Identifier of the tool call this message answers.
    public var toolCallID: String?
    /// Set when a tool call failed, so providers that support it can mark it.
    public var isError: Bool

    public init(
        role: Role,
        text: String = "",
        images: [Data] = [],
        toolCalls: [ToolCall] = [],
        toolCallID: String? = nil,
        isError: Bool = false
    ) {
        self.role = role
        self.text = text
        self.images = images
        self.toolCalls = toolCalls
        self.toolCallID = toolCallID
        self.isError = isError
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

/// A tool call being assembled from stream fragments.
///
/// Both wires send the id, the name and the arguments in separate chunks, so
/// each stream reader collects them into one of these and parses the arguments
/// only once the stream ends.
struct ToolCallBuilder {
    var id = ""
    var name = ""
    var arguments = ""
}

public struct Completion: Sendable {
    public var text: String
    public var toolCalls: [ToolCall]
    public var stopReason: String?
    public var usage: TokenUsage?

    public init(text: String, toolCalls: [ToolCall], stopReason: String?, usage: TokenUsage? = nil) {
        self.text = text
        self.toolCalls = toolCalls
        self.stopReason = stopReason
        self.usage = usage
    }

    public var wantsToolCalls: Bool { !toolCalls.isEmpty }

    /// Whether the provider cut the answer off at the token limit.
    ///
    /// The two wires spell it differently — OpenAI says `length`, Anthropic says
    /// `max_tokens` — and the loop has to recognise it, because a truncated
    /// answer is not a finished one. A tool call that was cut in half does not
    /// parse, so it arrives as no calls at all, and a loop that only asks "did
    /// the model call a tool?" reads a cut-off step as the model saying it is
    /// done: the run ends with an empty answer and every step behind it is lost.
    public var truncated: Bool {
        stopReason == "length" || stopReason == "max_tokens"
    }
}

public struct TokenUsage: Sendable, Equatable {
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

/// A provider that can also report the assistant's prose while it is produced.
///
/// The loop asks for this capability rather than requiring it: a local server
/// without SSE support still speaks the old `ChatProvider` and works, it just
/// arrives in one piece. The callback carries *deltas*, not the growing text, so
/// a provider never has to decide what the caller already knows.
public protocol StreamingChatProvider: ChatProvider {
    func complete(
        messages: [ChatMessage],
        tools: [ToolDefinition],
        systemPrompt: String,
        onText: (String) -> Void
    ) async throws -> Completion
}
