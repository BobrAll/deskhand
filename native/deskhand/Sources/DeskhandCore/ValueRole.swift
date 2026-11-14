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
    /// Used wherever an editable field must be told from text that merely
    /// describes something: the approval question (typing into a field commits
    /// nothing), `set_value` (a text-entry role has a typing fallback), and a
    /// plain click (a field is clicked to place the caret).
    static func isTextEntry(_ role: String) -> Bool {
        role == kAXTextFieldRole
            || role == kAXTextAreaRole
            || role == kAXComboBoxRole
    }

    /// A control whose value is state rather than text that names it.
    ///
    /// A checked box reports 1, a slider its position, a pop-up its selected
    /// item. Keeping those out of the identity is what lets a toggle keep its
    /// number and be reported as a change instead of as a new control.
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
    /// True for text-describing roles — list rows, cells, static text, menu
    /// items, links — where two rows with the same role and no title are
    /// indistinguishable without their text.
    static func isIdentity(_ role: String) -> Bool {
        !isTextEntry(role) && !isState(role)
    }
}
