import Foundation
import CoreGraphics
import ApplicationServices

/// Mouse input: clicks, drags and scrolls, posted as real HID events so that
/// apps which ignore accessibility actions (games, canvases, most web content)
/// still respond.
///
/// Every gesture is bracketed by a mouse-move so the app's hover state is
/// correct before the button goes down; without that, many apps treat the click
/// as belonging to whatever was hovered previously.
public enum Mouse {
    public enum Button: String, Sendable {
        case left, right, middle

        var cgButton: CGMouseButton {
            switch self {
            case .left: return .left
            case .right: return .right
            case .middle: return .center
            }
        }

        var downType: CGEventType {
            switch self {
            case .left: return .leftMouseDown
            case .right: return .rightMouseDown
            case .middle: return .otherMouseDown
            }
        }

        var upType: CGEventType {
            switch self {
            case .left: return .leftMouseUp
            case .right: return .rightMouseUp
            case .middle: return .otherMouseUp
            }
        }

        var dragType: CGEventType {
            switch self {
            case .left: return .leftMouseDragged
            case .right: return .rightMouseDragged
            case .middle: return .otherMouseDragged
            }
        }
    }

    private static func source() -> CGEventSource? {
        let source = CGEventSource(stateID: .combinedSessionState)
        source?.setLocalEventsFilterDuringSuppressionState(
            [.permitLocalMouseEvents, .permitLocalKeyboardEvents],
            state: .eventSuppressionStateSuppressionInterval
        )
        return source
    }

    public static func move(to point: CGPoint) {
        WindowServer.prepare()
        guard let event = CGEvent(
            mouseEventSource: source(),
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else { return }
        SyntheticEvent.mark(event)
        event.post(tap: .cghidEventTap)
    }

    public static func click(
        at point: CGPoint,
        button: Button = .left,
        count: Int = 1,
        modifiers: CGEventFlags = []
    ) {
        WindowServer.prepare()
        let clicks = max(1, min(count, 3))
        move(to: point)
        // A short settle lets hover/focus handlers run before the press.
        Thread.sleep(forTimeInterval: 0.02)

        for index in 1...clicks {
            guard let down = CGEvent(
                mouseEventSource: source(),
                mouseType: button.downType,
                mouseCursorPosition: point,
                mouseButton: button.cgButton
            ), let up = CGEvent(
                mouseEventSource: source(),
                mouseType: button.upType,
                mouseCursorPosition: point,
                mouseButton: button.cgButton
            ) else { continue }

            down.flags = modifiers
            up.flags = modifiers
            down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            SyntheticEvent.mark(down)
            SyntheticEvent.mark(up)
            down.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.01)
            up.post(tap: .cghidEventTap)
            if index < clicks {
                Thread.sleep(forTimeInterval: 0.06)
            }
        }
    }

    /// Drags in small interpolated steps. A single jump from A to B reads as a
    /// teleport: drag-and-drop targets that require a hover or a threshold of
    /// movement never activate.
    public static func drag(
        from start: CGPoint,
        to end: CGPoint,
        button: Button = .left,
        steps: Int = 24
    ) {
        WindowServer.prepare()
        move(to: start)
        Thread.sleep(forTimeInterval: 0.05)

        guard let down = CGEvent(
            mouseEventSource: source(),
            mouseType: button.downType,
            mouseCursorPosition: start,
            mouseButton: button.cgButton
        ) else { return }
        SyntheticEvent.mark(down)
        down.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.08)

        let count = max(4, steps)
        for step in 1...count {
            let t = Double(step) / Double(count)
            // Ease-in-out so the first movements are slow enough for drag
            // thresholds, matching how a human hand accelerates.
            let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
            let point = CGPoint(
                x: start.x + (end.x - start.x) * eased,
                y: start.y + (end.y - start.y) * eased
            )
            guard let dragged = CGEvent(
                mouseEventSource: source(),
                mouseType: button.dragType,
                mouseCursorPosition: point,
                mouseButton: button.cgButton
            ) else { continue }
            SyntheticEvent.mark(dragged)
            dragged.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.012)
        }

        Thread.sleep(forTimeInterval: 0.05)
        guard let up = CGEvent(
            mouseEventSource: source(),
            mouseType: button.upType,
            mouseCursorPosition: end,
            mouseButton: button.cgButton
        ) else { return }
        SyntheticEvent.mark(up)
        up.post(tap: .cghidEventTap)
    }

    /// Scrolls at a point. `pages` is a scroll wheel unit count where 1 page
    /// equals a full viewport; we approximate that with a line count that feels
    /// right for AppKit and web content alike.
    public static func scroll(
        at point: CGPoint,
        direction: ScrollDirection,
        pages: Double
    ) {
        move(to: point)
        Thread.sleep(forTimeInterval: 0.03)

        let linesPerPage = 12.0
        let total = pages * linesPerPage
        let chunk = 3.0
        var remaining = abs(total)
        let sign: Double = total >= 0 ? 1 : -1

        while remaining > 0 {
            let step = min(chunk, remaining)
            remaining -= step
            let (dy, dx) = direction.delta(amount: step * sign)
            guard let event = CGEvent(
                scrollWheelEvent2Source: source(),
                units: .line,
                wheelCount: 2,
                wheel1: Int32(dy),
                wheel2: Int32(dx),
                wheel3: 0
            ) else { continue }
            event.location = point
            SyntheticEvent.mark(event)
            event.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.02)
        }
    }

    public enum ScrollDirection: String, Sendable {
        case up, down, left, right

        /// Positive wheel1 scrolls content up (towards the top of the document).
        func delta(amount: Double) -> (vertical: Double, horizontal: Double) {
            switch self {
            case .up: return (amount, 0)
            case .down: return (-amount, 0)
            case .left: return (0, amount)
            case .right: return (0, -amount)
            }
        }
    }

    public static func location() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }
}
