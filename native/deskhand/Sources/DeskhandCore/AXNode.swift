import Foundation
import CoreGraphics
import ApplicationServices

/// One node of the flattened accessibility tree that gets handed to the model.
/// Indices are assigned during a single traversal and are only valid for the
/// snapshot that produced them.
public struct AXNode: Sendable {
    public var index: Int
    public var depth: Int
    public var role: String
    public var subrole: String?
    public var title: String?
    public var label: String?
    public var value: String?
    public var identifier: String?
    public var actions: [String]
    public var settable: Bool
    public var frame: CGRect?
    public var enabled: Bool
    public var focused: Bool
    /// True when the element would not enumerate its children, so the tree
    /// below it is missing rather than empty. Rendered as a marker because the
    /// model must not read "no children" as "nothing here".
    public var childrenHidden: Bool
    /// How many items the element claims to hold when it will not list them.
    ///
    /// This is the difference between "an empty list" and "a list of 11 rows
    /// you cannot address": the first needs nothing, the second needs a
    /// different route in. `AXRowCount` is answered by containers that refuse
    /// `AXChildren`, so the number is usually available.
    public var hiddenItemCount: Int?
    public init(
        index: Int,
        depth: Int,
        role: String,
        subrole: String? = nil,
        title: String? = nil,
        label: String? = nil,
        value: String? = nil,
        identifier: String? = nil,
        actions: [String] = [],
        settable: Bool = false,
        frame: CGRect? = nil,
        enabled: Bool = true,
        focused: Bool = false,
        childrenHidden: Bool = false,
        hiddenItemCount: Int? = nil
    ) {
        self.index = index
        self.depth = depth
        self.role = role
        self.subrole = subrole
        self.title = title
        self.label = label
        self.value = value
        self.identifier = identifier
        self.actions = actions
        self.settable = settable
        self.frame = frame
        self.enabled = enabled
        self.focused = focused
        self.childrenHidden = childrenHidden
        self.hiddenItemCount = hiddenItemCount
    }

    /// Everything about the node that the model can see, except its index and
    /// depth. Two snapshots agree on a node when these agree.
    var visibleState: String {
        [
            role, subrole ?? "", title ?? "", label ?? "", value ?? "", identifier ?? "",
            enabled ? "1" : "0", focused ? "1" : "0",
            actions.joined(separator: ","), settable ? "1" : "0",
            childrenHidden ? "hidden" : "",
            hiddenItemCount.map(String.init) ?? "",
        ].joined(separator: "\u{1}")
    }

    /// Position and size, compared separately from `visibleState` so that a
    /// scroll or a window move is reported as movement, not as a change.
    var geometry: String {
        guard let frame else { return "none" }
        return "\(Int(frame.origin.x)),\(Int(frame.origin.y)),\(Int(frame.width)),\(Int(frame.height))"
    }
}

/// Renders a flat node list as compact indented text.
///
/// The format is intentionally line-oriented and cheap for a model to read:
///
///     0  AXWindow  "Inbox"  @0,0 1200x800
///     1    AXButton  "Send"  #sendButton  [press]
///
/// Roles that carry no information on their own (groups, scroll areas) are kept
/// because their nesting is what tells the model where things live.
public enum AXTreeRenderer {
    public static func render(_ nodes: [AXNode], includeFrames: Bool = true) -> String {
        // A region that hides its rows usually has a way in that the tree *can*
        // address — a search or filter field. Naming its index turns "you
        // cannot reach this list" into "type here instead", which is the step
        // the model would otherwise have to guess.
        let entry = entryField(in: nodes)
        var lines: [String] = []
        lines.reserveCapacity(nodes.count)
        for node in nodes {
            lines.append(line(for: node, includeFrames: includeFrames, entry: entry))
        }
        return lines.joined(separator: "\n")
    }

    /// A text field that can act as a way into unaddressable content.
    ///
    /// Deliberately generic: any settable text field in the tree qualifies,
    /// because the property that matters is "the model can type into it and
    /// the app will filter by what it types", not the field's name.
    /// Prefers an already-focused field, then a search-looking one.
    static func entryField(in nodes: [AXNode]) -> AXNode? {
        // A search field is an AXTextField with the AXSearchField subrole,
        // not a role of its own.
        let fields = nodes.filter { node in
            node.role == kAXTextFieldRole && node.settable && !node.childrenHidden
        }
        return fields.first(where: { $0.focused })
            ?? fields.first(where: { looksLikeSearch($0) })
            ?? fields.first
    }

    static func looksLikeSearch(_ node: AXNode) -> Bool {
        let haystack = [node.role, node.subrole ?? "", node.label ?? "", node.title ?? ""]
            .joined(separator: " ").lowercased()
        return ["search", "поиск", "filter", "фильтр"].contains { haystack.contains($0) }
    }

    static func line(for node: AXNode, includeFrames: Bool, entry: AXNode? = nil) -> String {
        String(repeating: " ", count: min(node.depth, 40) * 2)
            + "\(node.index) " + describe(node, includeFrames: includeFrames, entry: entry)
    }

    static func clip(_ s: String, limit: Int = 180) -> String {
        let collapsed = s
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\t", with: " ")
            .replacingOccurrences(of: "\"", with: "'")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if collapsed.count <= limit { return collapsed }
        return String(collapsed.prefix(limit)) + "…"
    }

    /// The node without its index or indentation: the part that describes what
    /// the node *is*. Used both for diffing and for printing changed nodes.
    public static func describe(
        _ node: AXNode,
        includeFrames: Bool = true,
        entry: AXNode? = nil
    ) -> String {
        var out = node.role
        if let subrole = node.subrole, !subrole.isEmpty {
            out += "/\(subrole)"
        }
        if let title = node.title {
            out += " \"\(clip(title))\""
        }
        if let label = node.label, label != node.title {
            out += " ~\"\(clip(label))\""
        }
        if let value = node.value, value != node.title, value != node.label {
            out += " = \"\(clip(value))\""
        }
        if let identifier = node.identifier {
            out += " #\(identifier)"
        }
        if includeFrames, let frame = node.frame, frame.width > 0, frame.height > 0 {
            out += " @\(Int(frame.origin.x)),\(Int(frame.origin.y)) \(Int(frame.width))x\(Int(frame.height))"
        }
        if !node.enabled {
            out += " [disabled]"
        }
        if node.focused {
            out += " [focused]"
        }
        if node.settable {
            out += " [settable]"
        }
        if !node.actions.isEmpty {
            out += " [" + node.actions.joined(separator: ",") + "]"
        }
        if node.childrenHidden {
            // Naming the count matters: "empty" and "eleven rows I will not
            // describe" call for opposite next moves, and a bare "no children"
            // reads as the first when it means the second. Naming the field
            // matters more: it turns "you cannot reach this" into an index the
            // model can actually type into.
            let what = node.hiddenItemCount.map { "\($0) item\($0 == 1 ? "" : "s")" }
            if let entry, entry.index != node.index {
                let field = entry.focused
                    ? "element \(entry.index) (focused) is the way in"
                    : "type into element \(entry.index) to reach them"
                out += " (\(what ?? "contents") not exposed: \(field), or click coordinates)"
            } else {
                let subject = what.map { "\($0) not exposed" } ?? "contents not exposed"
                out += " (\(subject): no addressable way in, use coordinates)"
            }
        }
        return out
    }
}

/// What changed between two snapshots of the same window.
///
/// Re-reading the whole tree after every action is the most expensive habit an
/// agent can have: on a browser it is thousands of tokens to learn that one
/// line changed. A diff answers "did my action land, and what did it reveal"
/// in a few dozen tokens.
public struct AXSnapshotDiff: Sendable {
    public var added: [AXNode]
    public var removed: [AXNode]
    public var changed: [(before: AXNode, after: AXNode)]
    /// Nodes that kept their content but moved: a scroll or a window drag.
    public var moved: Int

    public init(
        added: [AXNode] = [],
        removed: [AXNode] = [],
        changed: [(before: AXNode, after: AXNode)] = [],
        moved: Int = 0
    ) {
        self.added = added
        self.removed = removed
        self.changed = changed
        self.moved = moved
    }

    public var isEmpty: Bool {
        added.isEmpty && removed.isEmpty && changed.isEmpty && moved == 0
    }

    /// A one-line count of what moved, spelled out rather than as `+20 -830`.
    ///
    /// The numbers alone read as noise; the words at least say which direction
    /// the screen moved in, which is what tells a navigation apart from a
    /// checkbox.
    public var summary: String {
        var parts: [String] = []
        if !added.isEmpty { parts.append("\(added.count) added") }
        if !removed.isEmpty { parts.append("\(removed.count) removed") }
        if !changed.isEmpty { parts.append("\(changed.count) changed") }
        if moved > 0 { parts.append("\(moved) moved") }
        return parts.isEmpty ? "no visible change" : parts.joined(separator: ", ")
    }

    /// Compact text for the model: added and changed nodes are printed by role,
    /// label and value, removed ones by role and title only.
    ///
    /// Added and changed nodes carry their element number, because a number is
    /// the same control for the whole session (`IndexBook`) and the walk that
    /// produced this diff is the one the model is given. That is what lets a
    /// model act on a dialog that just appeared without spending a round trip
    /// on `get_app_state`. Removed nodes carry none: their number is dead, and
    /// naming it would invite a click on nothing. Frames are left out for the
    /// same reason as before: on a web page every node has one, so they bury the
    /// one line that actually changed.
    public func text(limit: Int = 12) -> String {
        var lines: [String] = []
        for node in added.prefix(limit) {
            lines.append("+ \(node.index) " + AXTreeRenderer.describe(node, includeFrames: false))
        }
        for change in changed.prefix(limit) {
            var line = "~ \(change.after.index) "
                + AXTreeRenderer.describe(change.after, includeFrames: false)
            if change.before.value != change.after.value {
                let before = AXTreeRenderer.clip(change.before.value ?? "∅", limit: 60)
                let after = AXTreeRenderer.clip(change.after.value ?? "∅", limit: 60)
                line += "\n    value: \(before) → \(after)"
            }
            lines.append(line)
        }
        for node in removed.prefix(limit) {
            lines.append("- " + AXTreeRenderer.describe(node, includeFrames: false))
        }

        let shown = min(added.count, limit) + min(changed.count, limit) + min(removed.count, limit)
        let total = added.count + changed.count + removed.count
        if total > shown {
            lines.append("… and \(total - shown) more changed node(s)")
        }
        if moved > 0 {
            lines.append("(\(moved) node(s) only moved)")
        }
        return lines.joined(separator: "\n")
    }
}
