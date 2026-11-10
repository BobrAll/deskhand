import Foundation
import ApplicationServices

/// One tool call offered to the policy, with everything a decision needs.
///
/// The policy is the *host's* business: Deskhand decides what is risky and
/// whether to ask the user, so the description here has to be rich enough for
/// that decision and no richer. It deliberately carries the resolved target —
/// a click on "Отправить" in a messenger is a different thing from a click on
/// the same words in a settings window, and the raw arguments cannot tell them
/// apart.
public struct ToolCallContext: Sendable {
    public var tool: String
    public var arguments: JSONValue
    /// The app the call is about, when it resolved.
    public var appName: String?
    public var bundleIdentifier: String?
    public var pid: pid_t?
    /// The element an index-based call addresses, when one was given.
    public var role: String?
    public var title: String?
    public var label: String?
    /// True when the target is a text field, so typing into it commits nothing.
    public var isTextField: Bool
    /// What the model said it was doing, in the user's language.
    public var narration: String?

    public init(
        tool: String,
        arguments: JSONValue,
        appName: String? = nil,
        bundleIdentifier: String? = nil,
        pid: pid_t? = nil,
        role: String? = nil,
        title: String? = nil,
        label: String? = nil,
        isTextField: Bool = false,
        narration: String? = nil
    ) {
        self.tool = tool
        self.arguments = arguments
        self.appName = appName
        self.bundleIdentifier = bundleIdentifier
        self.pid = pid
        self.role = role
        self.title = title
        self.label = label
        self.isTextField = isTextField
        self.narration = narration
    }

    /// A stable fingerprint of what this call would do, so "разрешить всегда"
    /// can remember the action and not the sentence around it.
    public var fingerprint: String {
        var parts: [String] = [tool]
        if let bundleIdentifier { parts.append(bundleIdentifier) }
        if let role { parts.append(role) }
        if let title, !title.isEmpty { parts.append(title) }
        else if let label, !label.isEmpty { parts.append(label) }
        switch tool {
        case "press_key":
            if let key = arguments["key"]?.stringValue { parts.append(key) }
        case "click":
            if let count = arguments["click_count"]?.intValue { parts.append("x\(count)") }
            if let button = arguments["button"]?.stringValue { parts.append(button) }
        case "type_text", "set_value":
            // The text itself is never part of the fingerprint: it is the user's
            // content, and it must not be remembered, logged, or used to decide
            // whether an earlier approval covers this call.
            parts.append("<text>")
        default:
            break
        }
        return parts.joined(separator: "\u{1}")
    }
}

public enum ToolPolicyDecision: Sendable {
    case allow
    case deny(String)
}

/// The host's veto over a tool call.
///
/// Called before every mutating tool, on the thread that is running the loop.
/// It may block — the Deskhand host uses exactly that to put a question in
/// front of the user and wait for the answer.
public protocol ToolPolicy: AnyObject, Sendable {
    func authorize(_ call: ToolCallContext) -> ToolPolicyDecision
}

/// Tools that change the machine, as opposed to reading it.
///
/// `get_app_state` and `list_apps` are not here: they only read, they are called
/// on every step, and a policy round trip between a look and the action it
/// informs would add latency to the one path that has none to spare.
public enum MutatingTools {
    public static let names: Set<String> = [
        "activate_app", "click", "perform_secondary_action", "set_value",
        "select_text", "scroll", "drag", "press_key", "type_text",
    ]

    public static func isMutating(_ name: String) -> Bool {
        names.contains(name)
    }
}
