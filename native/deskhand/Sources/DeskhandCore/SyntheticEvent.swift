import Foundation
import CoreGraphics

/// Marks the events this agent posts as its own.
///
/// The host watches the mouse and the keyboard so the user can take control back
/// by moving the pointer. That watcher sees every event in the session, including
/// the ones the agent posts — so without a mark, the agent's own first mouse-move
/// would read as "the user grabbed the mouse" and cancel the run it just started.
///
/// The value is the host's own constant (`'SCGR'` in `helper.m`), shared on
/// purpose: it is the contract between the two processes, and a second, private
/// tag would make the host unable to tell whose event it is looking at.
public enum SyntheticEvent {
    public static let tag: Int64 = 0x5343_4752  // 'SCGR'

    /// Stamps an event as agent-originated. No-op on nil.
    public static func mark(_ event: CGEvent?) {
        event?.setIntegerValueField(.eventSourceUserData, value: tag)
    }

    /// True for an event this agent posted. Used by the tests and by any future
    /// listener that needs the same distinction.
    public static func isSynthetic(_ event: CGEvent?) -> Bool {
        guard let event else { return false }
        return event.getIntegerValueField(.eventSourceUserData) == tag
    }
}
