import ApplicationServices

/// Roles whose value is text the user can edit.
///
/// One predicate for everything that has to tell an editable field from text
/// that merely describes something: node identity (editing a field must not
/// turn it into a different control), the approval question (typing into a
/// field commits nothing), and `set_value` (a text-entry role has a typing
/// fallback when the app refuses `AXValue`).
enum TextEntryRole {
    static func isTextEntry(_ role: String) -> Bool {
        role == kAXTextFieldRole
            || role == kAXTextAreaRole
            || role == kAXComboBoxRole
    }
}
