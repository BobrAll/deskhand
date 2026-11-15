import DeskhandCore
import Foundation

/// What every request from both wires has in common.
enum ProviderHTTP {
    /// Identifies the client on every request.
    static let userAgent = "Deskhand/0.1"
    /// Statuses that mean the endpoint does not implement streaming, so the same
    /// request can be retried in one piece.
    static let streamingFallbackStatuses = [400, 404, 422]
}

/// Configuration for any OpenAI-compatible or Anthropic-compatible endpoint.
///
/// Deskhand is BYOK by design: there is no bundled key, no proxy, and no
/// account. `baseURL` is a first-class setting so the same binary works with
/// OpenAI, Azure-style gateways, OpenRouter, Ollama, LM Studio, vLLM, or a
/// self-hosted router.
public struct ProviderConfig: Sendable, Equatable {
    public enum Wire: String, Sendable {
        /// `POST {base}/chat/completions` — OpenAI, OpenRouter, Groq, Together,
        /// Ollama, LM Studio, vLLM, most gateways.
        case openAICompatible = "openai"
        /// `POST {base}/messages` — Anthropic and Anthropic-compatible proxies.
        case anthropic = "anthropic"
    }

    public var wire: Wire
    public var baseURL: URL
    public var model: String
    public var apiKey: String?
    public var maxTokens: Int
    public var temperature: Double?
    /// Extra headers, for gateways that need them (e.g. `HTTP-Referer`).
    public var extraHeaders: [String: String]
    /// Some local servers ignore the auth header entirely; when true we omit it.
    public var omitAuthHeader: Bool
    /// Fields merged into every request body, as the host passed them. This is
    /// how a gateway-specific switch reaches the wire without the agent knowing
    /// the gateway. Applied after the agent's own fields, so a user value wins.
    public var extraBody: [String: JSONValue] = [:]

    /// The endpoint used when a caller does not override it.
    public static let defaultBaseURL = URL(string: "https://api.openai.com/v1")!
    public static let defaultModel = "gpt-5"

    public init(
        wire: Wire = .openAICompatible,
        baseURL: URL = defaultBaseURL,
        model: String = defaultModel,
        apiKey: String? = nil,
        maxTokens: Int = 4096,
        temperature: Double? = nil,
        extraHeaders: [String: String] = [:],
        omitAuthHeader: Bool = false
    ) {
        self.wire = wire
        self.baseURL = baseURL
        self.model = model
        self.apiKey = apiKey
        self.maxTokens = maxTokens
        self.temperature = temperature
        self.extraHeaders = extraHeaders
        self.omitAuthHeader = omitAuthHeader
    }

    /// Resolves the final endpoint, tolerating both `https://host/v1` and
    /// `https://host/v1/chat/completions` styles of input.
    public var endpointURL: URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: true)!
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        let suffix = wire == .openAICompatible ? "/chat/completions" : "/messages"
        components.percentEncodedPath = path.hasSuffix(suffix) ? path : path + suffix
        components.fragment = nil
        return components.url!
    }
}

public enum ConfigError: Error, CustomStringConvertible {
    case missingAPIKey(String)
    case invalidValue(String)
    case unreadable(String)

    public var description: String {
        switch self {
        case .missingAPIKey(let variable):
            return """
                no API key found. Set \(variable), or put `api_key` in the config file, \
                or pass --api-key. Local servers can set `omit_auth = true`.
                """
        case .invalidValue(let detail): return "invalid configuration: \(detail)"
        case .unreadable(let path): return "could not read config file at \(path)"
        }
    }
}

/// Loads configuration from, in increasing priority:
///
/// 1. built-in defaults
/// 2. `~/.deskhand/config.toml` (or `$DESKHAND_CONFIG`)
/// 3. environment variables
/// 4. command-line flags
///
/// The file format is a small TOML subset: `key = value` pairs and `[section]`
/// headers, with strings, numbers, and booleans.
public enum ConfigLoader {
    public static var defaultPath: String {
        if let override = ProcessInfo.processInfo.environment["DESKHAND_CONFIG"] {
            return override
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".deskhand/config.toml")
    }

    public static func load(
        path: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> ProviderConfig {
        var config = ProviderConfig()

        let filePath = path ?? defaultPath
        if FileManager.default.fileExists(atPath: filePath) {
            guard let text = try? String(contentsOfFile: filePath, encoding: .utf8) else {
                throw ConfigError.unreadable(filePath)
            }
            let parsed = try MiniTOML.parse(text)
            try apply(parsed, to: &config)
        }

        if let wire = environment["DESKHAND_WIRE"] {
            guard let parsed = ProviderConfig.Wire(rawValue: wire) else {
                throw ConfigError.invalidValue(
                    "DESKHAND_WIRE \"\(wire)\" — use \"openai\" or \"anthropic\"")
            }
            config.wire = parsed
        }
        if let base = environment["DESKHAND_BASE_URL"] {
            guard let url = URL(string: base), url.scheme != nil, url.host != nil else {
                throw ConfigError.invalidValue("DESKHAND_BASE_URL \"\(base)\" is not a URL")
            }
            config.baseURL = url
        }
        if let model = environment["DESKHAND_MODEL"] {
            config.model = model
        }
        if let key = environment["DESKHAND_API_KEY"], !key.isEmpty {
            config.apiKey = key
        }
        if let omit = environment["DESKHAND_OMIT_AUTH"] {
            config.omitAuthHeader = isTruthy(omit)
        }

        if config.apiKey == nil {
            config.apiKey = discoverKey(for: config, environment: environment)
        }

        return config
    }

    /// Standard key variable per provider, so the common case needs no config
    /// file at all.
    public static func discoverKey(
        for config: ProviderConfig,
        environment: [String: String]
    ) -> String? {
        let candidates: [String]
        switch config.wire {
        case .openAICompatible:
            candidates = ["DESKHAND_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY"]
        case .anthropic:
            candidates = ["DESKHAND_API_KEY", "ANTHROPIC_API_KEY"]
        }
        for name in candidates {
            if let value = environment[name], !value.isEmpty { return value }
        }
        return nil
    }

    /// The config file and the environment spell booleans loosely.
    private static func isTruthy(_ value: String) -> Bool {
        ["1", "true", "yes"].contains(value.lowercased())
    }

    static func apply(_ parsed: [String: [String: String]], to config: inout ProviderConfig) throws {
        let provider = parsed["provider"] ?? parsed[""] ?? [:]
        if let wireName = provider["wire"] ?? provider["type"] ?? provider["provider"] {
            guard let wire = ProviderConfig.Wire(rawValue: wireName) else {
                throw ConfigError.invalidValue(
                    "unknown wire \"\(wireName)\" — use \"openai\" or \"anthropic\"")
            }
            config.wire = wire
        }
        if let base = provider["base_url"] ?? provider["base"] {
            // A base URL that does not parse must not be dropped: the default is
            // api.openai.com, so ignoring a typo would send the user's key to a
            // provider they did not choose.
            guard let url = URL(string: base), url.scheme != nil, url.host != nil else {
                throw ConfigError.invalidValue(
                    "base_url \"\(base)\" is not a URL (expected something like https://host/v1)")
            }
            config.baseURL = url
        }
        if let model = provider["model"] {
            config.model = model
        }
        if let key = provider["api_key"], !key.isEmpty {
            config.apiKey = key
        }
        if let maxTokens = provider["max_tokens"], let value = Int(maxTokens) {
            config.maxTokens = value
        }
        if let temperature = provider["temperature"], let value = Double(temperature) {
            config.temperature = value
        }
        if let omit = provider["omit_auth"] {
            config.omitAuthHeader = isTruthy(omit)
        }
        if let headers = parsed["headers"] {
            config.extraHeaders = headers
        }
    }
}

/// A deliberately small TOML reader: sections, `key = value`, strings (single
/// and double quoted), integers, floats, booleans, and `#` comments. Enough for
/// a config file, with no dependency and no surprises.
public enum MiniTOML {
    public static func parse(_ text: String) throws -> [String: [String: String]] {
        var result: [String: [String: String]] = ["": [:]]
        var section = ""

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var line = String(rawLine)
            if let hashIndex = indexOfUnquoted(line, character: "#") {
                line = String(line[line.startIndex..<hashIndex])
            }
            line = line.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }

            if line.hasPrefix("[") && line.hasSuffix("]") {
                section = String(line.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
                if result[section] == nil { result[section] = [:] }
                continue
            }

            guard let equalsIndex = indexOfUnquoted(line, character: "=") else { continue }
            let key = String(line[line.startIndex..<equalsIndex]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: equalsIndex)...])
                .trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { continue }
            result[section, default: [:]][key] = unquote(value)
        }
        return result
    }

    static func indexOfUnquoted(_ line: String, character: Character) -> String.Index? {
        var inSingle = false
        var inDouble = false
        var index = line.startIndex
        while index < line.endIndex {
            let c = line[index]
            if c == "'" && !inDouble {
                inSingle.toggle()
            } else if c == "\"" && !inSingle {
                inDouble.toggle()
            } else if c == character && !inSingle && !inDouble {
                return index
            }
            index = line.index(after: index)
        }
        return nil
    }

    static func unquote(_ value: String) -> String {
        if value.count >= 2 {
            if value.hasPrefix("\"") && value.hasSuffix("\"") {
                return String(value.dropFirst().dropLast())
                    .replacingOccurrences(of: "\\\"", with: "\"")
                    .replacingOccurrences(of: "\\n", with: "\n")
            }
            if value.hasPrefix("'") && value.hasSuffix("'") {
                return String(value.dropFirst().dropLast())
            }
        }
        return value
    }
}
