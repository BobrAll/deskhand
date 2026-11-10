import Foundation
import CoreGraphics

/// One action described in screen terms: what it is, where it lands, and which
/// window it belongs to.
///
/// This is a *picture* of an action, not a second implementation of it. It
/// carries no element handle and no arguments, and nothing here can perform
/// anything — the executor has already decided what to do, and the presentation
/// exists only so a host can show it. That separation is what keeps a visible
/// agent and a headless one the same agent: a host that draws nothing simply
/// never installs a presenter.
///
/// Coordinates are global screen points, the same space the mouse and the
/// accessibility tree use. Frames are optional because a tool can be valid
/// without a snapshot: a key press into an app that was never read has no
/// element to point at, and a missing point must not become a missing action.
public struct ActionPresentation: Sendable {
    /// What the action will look like, rather than which tool implements it.
    ///
    /// A host uses this to choose a gesture animation; it must not use it to
    /// decide whether the action is allowed. That decision has already been made
    /// by the time a presentation is emitted.
    public enum Gesture: String, Sendable {
        case click
        case secondary
        case type
        case value
        case select
        case key
        case scroll
        case drag
        case activate
    }

    public var tool: String
    public var gesture: Gesture
    public var appName: String?
    public var bundleIdentifier: String?
    public var pid: pid_t?
    /// Where the action is aimed, in screen points.
    public var point: CGPoint?
    /// The element's frame in screen points, when it has one.
    public var elementFrame: CGRect?
    /// The window the action belongs to, in screen points.
    public var windowFrame: CGRect?

    public init(
        tool: String,
        gesture: Gesture,
        appName: String? = nil,
        bundleIdentifier: String? = nil,
        pid: pid_t? = nil,
        point: CGPoint? = nil,
        elementFrame: CGRect? = nil,
        windowFrame: CGRect? = nil
    ) {
        self.tool = tool
        self.gesture = gesture
        self.appName = appName
        self.bundleIdentifier = bundleIdentifier
        self.pid = pid
        self.point = point
        self.elementFrame = elementFrame
        self.windowFrame = windowFrame
    }

    /// The gesture a tool name stands for.
    ///
    /// A pure mapping, kept here rather than in the executor's switch so the
    /// vocabulary a host draws is one list. An unknown tool is shown as a click:
    /// that is the least surprising animation, and a new tool must not be able
    /// to make the layer disappear by being unrecognised.
    public static func gesture(forTool name: String) -> Gesture {
        switch name {
        case "click": return .click
        case "perform_secondary_action": return .secondary
        case "type_text": return .type
        case "set_value": return .value
        case "select_text": return .select
        case "press_key": return .key
        case "scroll": return .scroll
        case "drag": return .drag
        case "activate_app": return .activate
        default: return .click
        }
    }
}

/// A host that wants to show actions before they happen.
///
/// The contract is deliberately one-way and non-blocking: `present` is called on
/// the thread that is about to act, and must return immediately. A presenter
/// that waited for an animation, an activation or a window server reply would
/// make "show what I am doing" cost more than doing it, which is the one thing
/// this layer must never do.
///
/// Not installed means not shown. The background mode of the app is exactly the
/// absence of a presenter, not a flag threaded through the tools.
public protocol ActionPresenter: AnyObject, Sendable {
    func present(_ action: ActionPresentation)
}
