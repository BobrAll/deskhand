import Foundation
import ApplicationServices
import AppKit

/// Thin, safe wrapper around `AXUIElement`. All attribute reads are defensive:
/// other applications can return arbitrary types, or fail mid-traversal.
public struct AXElement {
    public let raw: AXUIElement

    public init(_ raw: AXUIElement) {
        self.raw = raw
    }

    public static func application(pid: pid_t) -> AXElement {
        AXElement(AXUIElementCreateApplication(pid))
    }

    private func copy(_ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(raw, attribute as CFString, &value)
        guard err == .success else { return nil }
        return value
    }

    /// Reads an attribute that is expected to hold a single `AXUIElement`.
    public func element(_ attribute: String) -> AXElement? {
        guard let value = copy(attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return AXElement(value as! AXUIElement)
    }

    public func string(_ attribute: String) -> String? {
        guard let v = copy(attribute) else { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    public func bool(_ attribute: String) -> Bool? {
        guard let v = copy(attribute) else { return nil }
        if let n = v as? NSNumber { return n.boolValue }
        if let b = v as? Bool { return b }
        return nil
    }

    public func int(_ attribute: String) -> Int? {
        guard let v = copy(attribute) else { return nil }
        if let n = v as? NSNumber { return n.intValue }
        return nil
    }

    /// The outcome of asking an element for its children.
    ///
    /// "No children" and "this element will not say" are different facts, and
    /// the difference matters to an agent. Telegram's chat list is an `AXList`
    /// that advertises `AXChildren` but answers `kAXErrorAttributeUnsupported`
    /// (-25200): its rows exist on screen but not in the accessibility tree.
    /// A model that cannot tell the two apart reads "AXList" with nothing under
    /// it, assumes the list is empty, and starts clicking blind coordinates.
    public struct ChildrenResult {
        public let elements: [AXElement]
        /// True when the element would not enumerate its children, so the tree
        /// below it is missing rather than empty.
        public let childrenRefused: Bool
        /// How many items the element says it holds, when it will not list
        /// them. A container can refuse `AXChildren` and still answer
        /// `AXRowCount`, which turns "this list is empty" into "this list has
        /// 11 rows you cannot address" — a different problem with a different
        /// fix. Measured on a chat list that hides its rows: `AXChildren`,
        /// `AXRows` and `AXVisibleRows` all answer `-25200`, while `AXRowCount`
        /// answers 11.
        public let declaredItemCount: Int?

        public init(elements: [AXElement], childrenRefused: Bool, declaredItemCount: Int? = nil) {
            self.elements = elements
            self.childrenRefused = childrenRefused
            self.declaredItemCount = declaredItemCount
        }
    }

    public func childrenResult() -> ChildrenResult {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(raw, kAXChildrenAttribute as CFString, &value)
        guard err == .success, let arr = value as? [AXUIElement] else {
            // Anything but success means the element declined to enumerate.
            // Ask the count attributes before giving up: they are often
            // answered even when the children are not.
            return ChildrenResult(
                elements: [], childrenRefused: true, declaredItemCount: declaredItemCount())
        }
        return ChildrenResult(elements: arr.map(AXElement.init), childrenRefused: false)
    }

    /// The item count a container advertises, if any.
    ///
    /// `AXRowCount` and `AXColumnCount` are the standard ones for lists,
    /// tables and outlines. Values arrive as numbers or as the string form of
    /// a number depending on the app, so both are accepted.
    public func declaredItemCount() -> Int? {
        for attribute in ["AXRowCount", "AXColumnCount"] {
            guard let v = copy(attribute) else { continue }
            if let n = v as? NSNumber, n.intValue > 0 { return n.intValue }
            if let s = v as? String, let n = Int(s), n > 0 { return n }
        }
        return nil
    }

    public var role: String {
        string(kAXRoleAttribute) ?? ""
    }

    public var subrole: String {
        string(kAXSubroleAttribute) ?? ""
    }

    public var title: String? {
        nonEmpty(string(kAXTitleAttribute))
    }

    public var label: String? {
        nonEmpty(string(kAXDescriptionAttribute))
    }

    public var value: String? {
        guard let v = copy(kAXValueAttribute) else { return nil }
        switch v {
        case let s as String: return nonEmpty(s)
        case let n as NSNumber: return n.stringValue
        default: return nil
        }
    }

    public func actionNames() -> [String] {
        var names: CFArray?
        let err = AXUIElementCopyActionNames(raw, &names)
        guard err == .success, let list = names as? [String] else { return [] }
        return list
    }

    public func isSettable(_ attribute: String) -> Bool {
        var settable: DarwinBoolean = false
        let err = AXUIElementIsAttributeSettable(raw, attribute as CFString, &settable)
        return err == .success && settable.boolValue
    }

    @discardableResult
    public func setValue(_ value: Any, for attribute: String) -> Bool {
        let err = AXUIElementSetAttributeValue(raw, attribute as CFString, value as CFTypeRef)
        return err == .success
    }

    @discardableResult
    public func perform(_ action: String) -> Bool {
        let err = AXUIElementPerformAction(raw, action as CFString)
        return err == .success
    }

    /// Screen-space frame, if the element exposes position and size.
    public func frame() -> CGRect? {
        guard let posValue = copy(kAXPositionAttribute),
              let sizeValue = copy(kAXSizeAttribute),
              CFGetTypeID(posValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(posValue as! AXValue, .cgPoint, &point) else { return nil }
        guard AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }

    public func focused() -> Bool {
        bool(kAXFocusedAttribute) ?? false
    }

    /// The element that would receive a key event, if the app reports one.
    public func focusedElement() -> AXElement? {
        element(kAXFocusedUIElementAttribute)
    }

    public func focusedWindow() -> AXElement? {
        element(kAXFocusedWindowAttribute)
    }

    @discardableResult
    public func setFocused(_ focused: Bool) -> Bool {
        setValue(focused, for: kAXFocusedAttribute)
    }

    public func isEnabled() -> Bool {
        bool(kAXEnabledAttribute) ?? true
    }

    /// Element identifier: `AXIdentifier` when present, which many AppKit apps
    /// expose and which stays stable across layout changes.
    public var identifier: String? {
        nonEmpty(string("AXIdentifier"))
    }

    private func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }

    // MARK: - Batched reads

    /// Attributes the tree walker needs from every node.
    public static let walkedAttributes: [String] = [
        kAXRoleAttribute,
        kAXSubroleAttribute,
        kAXTitleAttribute,
        kAXDescriptionAttribute,
        kAXValueAttribute,
        "AXIdentifier",
        kAXPositionAttribute,
        kAXSizeAttribute,
        kAXEnabledAttribute,
        kAXFocusedAttribute,
    ]

    /// Reads every attribute the walker needs in **one** IPC round trip.
    ///
    /// A real tree walk is otherwise dominated by round trips, not by work: a
    /// browser window costs ten `AXUIElementCopyAttributeValue` calls per node,
    /// and each one is a synchronous mach message to another process. Measured
    /// on a 900-node Chrome window, batching took the walk from 300 ms to
    /// 120 ms; on Finder's 900 nodes, from 3.4 s to 1.3 s.
    ///
    /// The batch call reports a missing attribute as an `AXValue` of type
    /// `kAXValueTypeAXError` rather than by failing, so that case is mapped
    /// back to `nil` to keep behaviour identical to the one-at-a-time reads.
    public func walkedValues() -> AXWalkedValues {
        let names = AXElement.walkedAttributes as CFArray
        var values: CFArray?
        let error = AXUIElementCopyMultipleAttributeValues(
            raw,
            names,
            AXCopyMultipleAttributeOptions(rawValue: 0),
            &values
        )

        guard error == .success, let list = values as? [Any], list.count == AXElement.walkedAttributes.count
        else {
            return AXWalkedValues(element: self, batched: nil)
        }
        return AXWalkedValues(element: self, batched: list)
    }
}

/// The attributes the walker needs, resolved either from one batched call or,
/// as a fallback, from individual reads.
public struct AXWalkedValues {
    private let element: AXElement
    private let batched: [Any]?

    init(element: AXElement, batched: [Any]?) {
        self.element = element
        self.batched = batched
    }

    private func raw(_ attribute: String) -> CFTypeRef? {
        guard let batched,
              let position = AXElement.walkedAttributes.firstIndex(of: attribute),
              position < batched.count
        else {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element.raw, attribute as CFString, &value) == .success
            else { return nil }
            return value
        }

        let value = batched[position]
        if CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() {
            // A missing attribute arrives wrapped in an AXValue carrying the
            // error, which is not a real value.
            let axValue = value as! AXValue
            if AXValueGetType(axValue) == .axError || AXValueGetType(axValue) == .illegal {
                return nil
            }
        }
        return value as CFTypeRef
    }

    private func text(_ attribute: String) -> String? {
        guard let value = raw(attribute) else { return nil }
        let string: String?
        switch value {
        case let s as String: string = s
        case let n as NSNumber: string = n.stringValue
        default: string = nil
        }
        guard let string, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return string
    }

    public var role: String { text(kAXRoleAttribute) ?? "" }
    public var subrole: String { text(kAXSubroleAttribute) ?? "" }
    public var title: String? { text(kAXTitleAttribute) }
    public var label: String? { text(kAXDescriptionAttribute) }
    public var value: String? { text(kAXValueAttribute) }
    public var identifier: String? { text("AXIdentifier") }

    public var enabled: Bool {
        if let value = raw(kAXEnabledAttribute) as? NSNumber { return value.boolValue }
        return true
    }

    public var focused: Bool {
        if let value = raw(kAXFocusedAttribute) as? NSNumber { return value.boolValue }
        return false
    }

    public var frame: CGRect? {
        guard let positionValue = raw(kAXPositionAttribute),
              let sizeValue = raw(kAXSizeAttribute),
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID()
        else { return nil }

        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        else { return nil }
        return CGRect(origin: point, size: size)
    }

    public var actions: [String] { element.actionNames() }
    public var settable: Bool { element.isSettable(kAXValueAttribute) }
}

extension AXElement: Equatable {
    public static func == (lhs: AXElement, rhs: AXElement) -> Bool {
        CFEqual(lhs.raw, rhs.raw)
    }
}

extension AXElement: Hashable {
    public func hash(into hasher: inout Hasher) {
        hasher.combine(CFHash(raw))
    }
}
