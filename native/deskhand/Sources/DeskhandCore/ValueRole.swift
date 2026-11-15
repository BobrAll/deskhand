import ApplicationServices

/// What a role's `AXValue` means.
///
/// `AXValue` is not one kind of thing: in a text field it is content the user
/// edits, in a checkbox or a slider it is state the user toggles or drags, and
/// in a list row it is the text that names the row. Each meaning calls for a
/// different answer, so they live in one place instead of being re-derived at
/// every call site.
enum ValueRole {
    /// A field whose value is text the user can edit.
    ///
    /// The call sites are the decisions that depend on "the user can type
    /// here": the approval question (typing into a field commits nothing),
    /// `set_value` (a text-entry role has a typing fallback), and a plain click
    /// (a field is clicked to place the caret). Identity deliberately does not
    /// use this predicate: it goes through `isIdentity`, because a field's
    /// value is content, not its name.
    static func isTextEntry(_ role: String) -> Bool {
        role == kAXTextFieldRole
            || role == kAXTextAreaRole
            || role == kAXComboBoxRole
    }

    /// A control whose value is state rather than text that names it.
    ///
    /// A checked box reports 1, a slider its position, a pop-up its selected
    /// item. This list is the one place those roles are enumerated for value
    /// semantics; keeping their values out of the identity is what lets a
    /// toggle keep its number and be reported as a change instead of as a new
    /// control.
    static func isState(_ role: String) -> Bool {
        switch role {
        case kAXCheckBoxRole, kAXRadioButtonRole, kAXSliderRole,
            kAXScrollBarRole, kAXIncrementorRole, kAXPopUpButtonRole,
            kAXMenuButtonRole, kAXProgressIndicatorRole, kAXDisclosureTriangleRole:
            return true
        default:
            return false
        }
    }

    /// Whether the value names the element, so it belongs in its identity.
    ///
    /// True for every role whose value is neither editable text nor state —
    /// list rows, cells, static text, menu items, links — where two rows with
    /// the same role and no title are indistinguishable without their text.
    /// Both exceptions are answered by their own predicate, so a caller never
    /// has to repeat the role lists to ask this question.
    static func isIdentity(_ role: String) -> Bool {
        !isTextEntry(role) && !isState(role)
    }
}
