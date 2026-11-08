import Foundation
import ApplicationServices
import CoreGraphics

/// A flattened, index-addressable view of an application's accessibility tree.
public struct AXSnapshot: Sendable {
    public let pid: pid_t
    public let appName: String
    public let bundleIdentifier: String?
    public let windowTitle: String?
    public let windowFrame: CGRect?
    public let nodes: [AXNode]
    public let createdAt: Date
    public let truncated: Bool

    public var text: String { AXTreeRenderer.render(nodes) }

    public func node(index: Int) -> AXNode? {
        nodes.first { $0.index == index }
    }

    /// A content-based key that survives a re-walk.
    ///
    /// Element indices cannot be used: they are assigned by traversal order and
    /// shift whenever anything above a node is inserted or removed. The key is
    /// therefore built from what the node *is* — role, identifier and text —
    /// with an occurrence counter so that two identical list rows stay distinct.
    /// Geometry is deliberately excluded: it is compared separately, because a
    /// scroll moves everything without changing anything.
    func identities() -> [String] {
        var seen: [String: Int] = [:]
        return nodes.map { node in
            let base = [
                node.role, node.subrole ?? "", node.identifier ?? "",
                node.title ?? "", node.label ?? "",
            ].joined(separator: "|")
            let occurrence = seen[base, default: 0]
            seen[base] = occurrence + 1
            return "\(base)|\(occurrence)"
        }
    }

    /// The smallest node whose frame contains a point, in screen coordinates.
    ///
    /// Answers "where did that click land?" for a coordinate click that changed
    /// nothing. Smallest rather than first because a window contains everything:
    /// the innermost match is the control the user aimed at.
    public func smallestNode(containing point: CGPoint) -> AXNode? {
        nodes
            .filter { node in
                guard let frame = node.frame, frame.width > 0, frame.height > 0 else { return false }
                return frame.contains(point)
            }
            .min { lhs, rhs in
                let a = (lhs.frame?.width ?? 0) * (lhs.frame?.height ?? 0)
                let b = (rhs.frame?.width ?? 0) * (rhs.frame?.height ?? 0)
                return a < b
            }
    }

    /// A fingerprint of the whole tree as the model would see it.
    ///
    /// Two walks with the same signature describe the same screen, which is how
    /// the session knows an app has finished reacting to an action instead of
    /// catching it mid-update.
    var restSignature: Int {
        var hasher = Hasher()
        hasher.combine(nodes.count)
        for node in nodes {
            hasher.combine(node.visibleState)
            hasher.combine(node.geometry)
        }
        return hasher.finalize()
    }

    /// What changed since an earlier snapshot of the same window.
    ///
    /// Identity is content-based, so a node that merely changed its value is
    /// reported as changed rather than as one node disappearing and an
    /// identical one appearing.
    public func diff(from previous: AXSnapshot) -> AXSnapshotDiff {
        let previousIDs = previous.identities()
        let currentIDs = identities()

        var beforeByID: [String: AXNode] = [:]
        for (position, identity) in previousIDs.enumerated() where beforeByID[identity] == nil {
            beforeByID[identity] = previous.nodes[position]
        }

        var afterIDs = Set<String>()
        afterIDs.reserveCapacity(currentIDs.count)

        var added: [AXNode] = []
        var changed: [(before: AXNode, after: AXNode)] = []
        var moved = 0
        for (position, identity) in currentIDs.enumerated() {
            afterIDs.insert(identity)
            let node = nodes[position]
            guard let before = beforeByID[identity] else {
                added.append(node)
                continue
            }
            if before.visibleState != node.visibleState {
                changed.append((before, node))
            } else if before.geometry != node.geometry {
                moved += 1
            }
        }

        var removed: [AXNode] = []
        for (position, identity) in previousIDs.enumerated() where !afterIDs.contains(identity) {
            removed.append(previous.nodes[position])
        }

        return AXSnapshotDiff(added: added, removed: removed, changed: changed, moved: moved)
    }
}

/// Walks an application's accessibility tree and produces a flattened,
/// index-addressable snapshot.
///
/// Two properties matter when driving a real UI:
///
/// * **Stability.** Indices must mean the same thing between `get_app_state`
///   and the next `click`. A snapshot therefore owns its element table, and
///   the session refuses actions whose index came from an older snapshot.
/// * **Bounded cost.** Real trees are huge (browsers: tens of thousands of
///   nodes). The walk stops at a node budget and a depth limit, and prunes
///   subtrees that can never be seen or clicked.
public enum AXTreeWalker {
    public struct Options: Sendable {
        public var maxNodes: Int
        public var maxDepth: Int
        public var maxChildrenPerNode: Int

        public init(maxNodes: Int = 900, maxDepth: Int = 40, maxChildrenPerNode: Int = 250) {
            self.maxNodes = maxNodes
            self.maxDepth = maxDepth
            self.maxChildrenPerNode = maxChildrenPerNode
        }
    }

    /// Roles that are pure layout scaffolding. We still descend into them, but
    /// a group with no text, no identifier and no actions gets no line of its
    /// own: the model does not need to know a div exists.
    static func isTransparentContainer(_ role: String) -> Bool {
        switch role {
        case "AXGroup", "AXLayoutArea", "AXUnknown", "AXGenericElement", "AXSplitter":
            return true
        default:
            return false
        }
    }

    public static func snapshot(
        app: AppHandle,
        options: Options = Options(),
        elementTable: inout [Int: AXElement]
    ) -> AXSnapshot {
        let axApp = AXElement.application(pid: app.pid)
        let window = focusedWindow(of: axApp)

        var nodes: [AXNode] = []
        nodes.reserveCapacity(min(options.maxNodes, 512))
        var truncated = false
        var index = 0
        var visited = 0

        /// Roles that are containers by definition: something should be inside.
        ///
        /// Role-based rather than size-based on purpose. A leaf control refuses
        /// to list children too — every window button answers the same error as
        /// a chat list — so flagging every refusal would bury the tree in
        /// noise. A container role that refuses is the real signal: the app is
        /// saying "there is content here and I will not describe it", which is
        /// exactly what a model must not read as "empty".
        let containerRoles: Set<String> = [
            kAXListRole, kAXTableRole, kAXOutlineRole, kAXGridRole,
            kAXScrollAreaRole, kAXGroupRole, "AXWebArea", "AXTree",
        ]

        func isOpaqueContainer(role: String, frame: CGRect?) -> Bool {
            guard containerRoles.contains(role) else { return false }
            // A zero-sized container has nothing to hide.
            guard let frame else { return false }
            return frame.width > 0 && frame.height > 0
        }

        func visit(_ element: AXElement, depth: Int) {
            if index >= options.maxNodes || visited >= options.maxNodes * 4 {
                truncated = true
                return
            }
            if depth > options.maxDepth {
                truncated = true
                return
            }
            visited += 1

            // One IPC round trip per node instead of one per attribute: a
            // browser window otherwise costs ten synchronous mach messages per
            // node, and that, not the tree itself, is what makes a walk slow.
            let values = element.walkedValues()
            let role = values.role
            let title = values.title
            let label = values.label
            let value = values.value
            let identifier = values.identifier
            let frame = values.frame
            let actions = values.actions
            let settable = values.settable

            let hasText = title != nil || label != nil || value != nil
            let hasArea = (frame?.width ?? 0) > 0 && (frame?.height ?? 0) > 0
            let isInteractive = !actions.isEmpty || settable

            let emit = !(isTransparentContainer(role) && !hasText && identifier == nil && !isInteractive)
                && (hasArea || hasText)

            var childDepth = depth
            if emit {
                let node = AXNode(
                    index: index,
                    depth: depth,
                    role: role.isEmpty ? "AXUnknown" : role,
                    subrole: values.subrole.isEmpty ? nil : values.subrole,
                    title: title,
                    label: label,
                    value: value,
                    identifier: identifier,
                    actions: actions,
                    settable: settable,
                    frame: frame,
                    enabled: values.enabled,
                    focused: values.focused
                )
                nodes.append(node)
                elementTable[index] = element
                index += 1
                childDepth = depth + 1
            }

            let childResult = element.childrenResult()
            if childResult.refused, emit, isOpaqueContainer(role: role, frame: frame) {
                // Record that the subtree is missing, not empty. Only patch the
                // node this element just produced: when it was filtered out,
                // `nodes.last` belongs to an ancestor.
                nodes[nodes.count - 1].childrenHidden = true
                // The container may still say how many items it holds, which
                // is the difference between an empty region and an
                // unaddressable one.
                nodes[nodes.count - 1].hiddenItemCount = childResult.declaredCount
            }
            let children = childResult.elements
            if children.count > options.maxChildrenPerNode {
                truncated = true
            }
            for child in children.prefix(options.maxChildrenPerNode) {
                visit(child, depth: childDepth)
            }
        }

        if let window {
            visit(window, depth: 0)
        } else {
            visit(axApp, depth: 0)
        }

        return AXSnapshot(
            pid: app.pid,
            appName: app.name,
            bundleIdentifier: app.bundleIdentifier,
            windowTitle: window.flatMap { $0.title ?? $0.string("AXDocument") },
            windowFrame: window?.frame(),
            nodes: nodes,
            createdAt: Date(),
            truncated: truncated
        )
    }

    /// Resolves the window a user would call "the app's window": the focused
    /// one if the app exposes it, otherwise the first standard window.
    public static func focusedWindow(of app: AXElement) -> AXElement? {
        if let focused = app.element(kAXFocusedWindowAttribute) {
            if !focused.role.isEmpty { return focused }
        }
        if let main = app.element(kAXMainWindowAttribute) {
            if !main.role.isEmpty { return main }
        }
        let windows = app.children().filter { $0.role == kAXWindowRole }
        return windows.first
    }
}
