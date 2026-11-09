import Foundation
import ApplicationServices
import CoreGraphics

/// Element-level actions that go through the accessibility API rather than
/// synthetic mouse events. These are more reliable than pixel clicks when the
/// target is occluded or scrolled off-screen, and they work for controls that
/// are not hittable at all (menu items, background windows).
public enum ElementActions {
    public enum ActionError: Error, CustomStringConvertible {
        case staleIndex(Int)
        case unsupported(String)
        case failed(String)

        public var description: String {
            switch self {
            case .staleIndex(let index):
                return "element index \(index) is not part of the current snapshot; call get_app_state again"
            case .unsupported(let what): return what
            case .failed(let what): return what
            }
        }
    }

    /// Gives an element keyboard focus, so the next typed characters land in it.
    ///
    /// This is the reliable way to aim text at one field. A synthetic click
    /// only focuses the field if its window is in front and the pixel is right;
    /// `AXFocused` asks the app directly, so it works on a background window,
    /// at any scroll position, and cannot land on the wrong control.
    ///
    /// `AXFocused` is tried before `AXPress` on purpose: an app may read a
    /// press on a field as "run the search" or "open the menu", while focus has
    /// no meaning other than where typing goes. Measured on one search field,
    /// `AXPress` answered `true` on one call and `false` on the next, while
    /// `AXFocused` succeeded every time.
    @discardableResult
    public static func focus(_ element: AXElement) -> Bool {
        if element.setValue(true, for: kAXFocusedAttribute) {
            Thread.sleep(forTimeInterval: 0.03)
            if element.focused() { return true }
        }
        // A few AppKit controls only take focus as a side effect of a press.
        if element.actionNames().contains(kAXPressAction), element.perform(kAXPressAction) {
            Thread.sleep(forTimeInterval: 0.05)
            if element.focused() { return true }
        }
        return element.focused()
    }

    @discardableResult
    public static func press(_ element: AXElement) throws -> Bool {
        let actions = element.actionNames()
        if actions.contains(kAXPressAction) {
            if element.perform(kAXPressAction) { return true }
        }
        if actions.contains(kAXConfirmAction) {
            if element.perform(kAXConfirmAction) { return true }
        }
        if element.setValue(true, for: kAXFocusedAttribute) {
            return true
        }
        throw ActionError.failed(
            "element does not support a press action (actions: \(actions.joined(separator: ", ")))")
    }

    public static func perform(_ element: AXElement, action: String) throws {
        let actions = element.actionNames()
        guard actions.contains(action) else {
            throw ActionError.unsupported(
                "element has no action \"\(action)\" (available: \(actions.joined(separator: ", ")))")
        }
        guard element.perform(action) else {
            throw ActionError.failed("action \"\(action)\" was rejected by the app")
        }
    }

    /// Selects everything the element currently holds, so the next typed
    /// character replaces the old text instead of appending to it.
    ///
    /// `AXSelectedTextRange` is attempted first: it is instant, needs no key
    /// event, and does not depend on the field being the first responder in
    /// the app's key window. `cmd+a` posted to the process only works in that
    /// latter case, and when it silently does nothing the result is duplicated
    /// text rather than an error.
    @discardableResult
    public static func selectAll(_ element: AXElement) -> Bool {
        let length = (element.value ?? "").utf16.count
        if length > 0, element.setSelectedTextRange(NSRange(location: 0, length: length)) != nil {
            return true
        }
        return false
    }

    /// Sets an element's value, focusing it first when the app only makes the
    /// value settable once the field has focus.
    ///
    /// This is the common case for AppKit and Electron search fields: `AXValue`
    /// is not settable while the field is unfocused and becomes settable right
    /// after focusing. Asking once, reading "not settable", and giving up sent
    /// the model on a long detour of clicks and retries through a field that
    /// one extra call fills.
    public static func setValue(_ element: AXElement, text: String, pid: pid_t? = nil) throws {
        let isTextEntry = element.role == kAXTextFieldRole || element.role == kAXComboBoxRole
        if !element.isSettable(kAXValueAttribute), isTextEntry {
            // Focusing can flip the settability, so re-check rather than
            // assume the first answer was final.
            focus(element)
        }
        if element.isSettable(kAXValueAttribute) {
            try setValueDirect(element, text: text)
            return
        }
        guard isTextEntry else { throw unsupportedValueHint(element) }
        // Still no settable value: type into it, which needs a process to post
        // the keys to and a focused field to receive them.
        guard focus(element) else { throw unsupportedValueHint(element) }
        guard let pid else { throw unsupportedValueHint(element) }
        selectAll(element)
        Keyboard.typeString(text, to: .process(pid))
    }

    private static func unsupportedValueHint(_ element: AXElement) -> ActionError {
        // Say what the element is and what it can do instead. "not settable"
        // alone leaves the model guessing whether the index was wrong or the
        // approach was; naming the role and the actions turns it into a
        // decision it can act on.
        let role = element.role
        let actions = element.actionNames()
        var hint = "\(role.isEmpty ? "this element" : role) has no settable value."
        if actions.contains(kAXPressAction) {
            hint += " It can be pressed instead (click it)."
        } else if !actions.isEmpty {
            hint += " Its actions are: \(actions.joined(separator: ", "))."
        }
        return .unsupported(hint)
    }

    private static func setValueDirect(_ element: AXElement, text: String) throws {
        let role = element.role
        if role == kAXCheckBoxRole || role == kAXRadioButtonRole {
            let truthy = ["1", "true", "yes", "on", "checked"]
            if element.setValue(truthy.contains(text.lowercased()), for: kAXValueAttribute) {
                return
            }
        }
        if role == kAXSliderRole || role == kAXScrollBarRole || role == kAXIncrementorRole {
            if let number = Double(text), element.setValue(number, for: kAXValueAttribute) {
                return
            }
        }
        if element.setValue(text, for: kAXValueAttribute) { return }
        throw ActionError.failed("the app rejected the new value")
    }

    public enum TextSelection: String, Sendable {
        case text, cursorBefore, cursorAfter

        init?(raw: String) {
            switch raw.lowercased() {
            case "text", "select": self = .text
            case "cursor_before", "before": self = .cursorBefore
            case "cursor_after", "after": self = .cursorAfter
            default: return nil
            }
        }
    }

    /// Selects text inside an element or places the caret relative to it.
    ///
    /// Strategy: focus the element, move the caret to the start, then drive the
    /// selection with keyboard navigation. This works across AppKit, web views
    /// and Electron, all of which implement the standard text editing commands
    /// but expose inconsistent accessibility ranges.
    public static func selectText(
        _ element: AXElement,
        target: String,
        prefix: String?,
        suffix: String?,
        mode: TextSelection
    ) throws {
        let fullText = element.value ?? ""
        guard !fullText.isEmpty else {
            throw ActionError.unsupported("element has no text to select")
        }
        guard let range = locate(target, in: fullText, prefix: prefix, suffix: suffix) else {
            throw ActionError.failed("text \"\(target)\" was not found in the element")
        }

        _ = element.setValue(true, for: kAXFocusedAttribute)
        Thread.sleep(forTimeInterval: 0.05)

        let nsRange = NSRange(location: range.lowerBound, length: range.count)
        // Try the precise accessibility range first: it is instant and does not
        // disturb the user's selection elsewhere.
        if let selected = element.setSelectedTextRange(nsRange) {
            if mode == .text { return }
            // For caret placement, collapse the selection.
            let caret = mode == .cursorBefore ? range.lowerBound : range.upperBound
            if element.setSelectedTextRange(NSRange(location: caret, length: 0)) != nil {
                return
            }
            _ = selected
        }

        // Fallback: keyboard navigation from a known caret position.
        try navigateToRange(
            start: range.lowerBound,
            length: mode == .text ? range.count : 0
        )
    }

    static func locate(
        _ target: String,
        in text: String,
        prefix: String?,
        suffix: String?
    ) -> Range<Int>? {
        var searchStart = text.startIndex
        var matches: [Range<String.Index>] = []
        while let found = text.range(of: target, range: searchStart..<text.endIndex) {
            matches.append(found)
            searchStart = found.upperBound
            if matches.count > 64 { break }
        }
        guard !matches.isEmpty else { return nil }

        func satisfiesContext(_ match: Range<String.Index>) -> Bool {
            if let prefix {
                let before = text[text.startIndex..<match.lowerBound]
                if !before.hasSuffix(prefix) { return false }
            }
            if let suffix {
                let after = text[match.upperBound..<text.endIndex]
                if !after.hasPrefix(suffix) { return false }
            }
            return true
        }

        let chosen = matches.first(where: satisfiesContext) ?? matches[0]
        let lower = text.distance(from: text.startIndex, to: chosen.lowerBound)
        let upper = text.distance(from: text.startIndex, to: chosen.upperBound)
        return lower..<upper
    }

    /// Keyboard fallback for elements that do not expose `AXSelectedTextRange`
    /// (some Electron and canvas-based editors).
    ///
    /// Arrow keys are capped: driving a 40 000 character document one keypress
    /// at a time would take minutes and flood the event queue. Beyond the cap we
    /// report the limitation instead of hanging.
    private static func navigateToRange(start: Int, length: Int) throws {
        let cap = 400
        guard start + length <= cap else {
            throw ActionError.unsupported(
                """
                this element does not support setting a text range, and the target is \(start) \
                characters into the document, beyond the \(cap)-character limit for keyboard-based \
                selection. Select the text by dragging instead.
                """)
        }

        // Cmd+Up moves to the very start of the document in AppKit text views;
        // Home is the fallback for views that only implement line navigation.
        try Keyboard.press("super+Up")
        try Keyboard.press("super+Left")
        Thread.sleep(forTimeInterval: 0.05)

        for _ in 0..<start {
            try Keyboard.press("Right")
        }
        for _ in 0..<length {
            try Keyboard.press("shift+Right")
        }
    }
}

extension AXElement {
    /// Sets `AXSelectedTextRange` when the element supports it.
    /// Returns the applied range, or nil when unsupported.
    func setSelectedTextRange(_ range: NSRange) -> NSRange? {
        guard isSettable(kAXSelectedTextRangeAttribute) else { return nil }
        var mutable = CFRange(location: range.location, length: range.length)
        guard let value = AXValueCreate(.cfRange, &mutable) else { return nil }
        guard setValue(value, for: kAXSelectedTextRangeAttribute) else { return nil }
        return range
    }
}
