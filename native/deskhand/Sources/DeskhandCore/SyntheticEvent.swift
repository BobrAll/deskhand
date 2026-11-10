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

    /// The event source every agent-posted event comes from.
    ///
    /// `combinedSessionState` is the session the user is actually in, so an
    /// event reaches the same apps a real one would. Local mouse and keyboard
    /// events are permitted during the suppression interval, so posting does
    /// not filter itself out.
    static func eventSource() -> CGEventSource? {
        let source = CGEventSource(stateID: .combinedSessionState)
        source?.setLocalEventsFilterDuringSuppressionState(
            [.permitLocalMouseEvents, .permitLocalKeyboardEvents],
            state: .eventSuppressionStateSuppressionInterval
        )
        return source
    }
}
