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
    /// Gesture pacing. These gaps are what a real hand leaves behind: hover
    /// handlers need a moment before the press, drag targets need to see the
    /// button go down before the pointer moves, and a multi-click needs a gap
    /// between its clicks to be read as one gesture.
    private enum Pace {
        static let hoverSettle: TimeInterval = 0.02
        static let clickDownToUp: TimeInterval = 0.01
        static let betweenClicks: TimeInterval = 0.06
        static let dragStartSettle: TimeInterval = 0.05
        static let dragPressSettle: TimeInterval = 0.08
        static let dragStep: TimeInterval = 0.012
        static let dragEndSettle: TimeInterval = 0.05
        static let scrollSettle: TimeInterval = 0.03
        static let betweenScrollChunks: TimeInterval = 0.02
    }

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

    public static func move(to point: CGPoint) {
        WindowServer.prepare()
        guard let event = CGEvent(
            mouseEventSource: SyntheticEvent.eventSource(),
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else { return }
        SyntheticEvent.mark(event)
        event.post(tap: .cghidEventTap)
    }

    /// The number of clicks a mouse event can carry.
    ///
    /// macOS encodes a multiple click as a count of 1...3, and a value outside
    /// that range is not a gesture it can express. Callers clamp once through
    /// this and report the same number they sent, so a model's `click_count: 5`
    /// is honestly described as a triple click rather than as five clicks.
    static func clampedClickCount(_ count: Int) -> Int {
        max(1, min(count, 3))
    }

    public static func click(
        at point: CGPoint,
        button: Button = .left,
        count: Int = 1,
        modifiers: CGEventFlags = []
    ) {
        WindowServer.prepare()
        let clicks = clampedClickCount(count)
        move(to: point)
        // A short settle lets hover/focus handlers run before the press.
        Thread.sleep(forTimeInterval: Pace.hoverSettle)

        for index in 1...clicks {
            guard let down = CGEvent(
                mouseEventSource: SyntheticEvent.eventSource(),
                mouseType: button.downType,
                mouseCursorPosition: point,
                mouseButton: button.cgButton
            ), let up = CGEvent(
                mouseEventSource: SyntheticEvent.eventSource(),
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
            Thread.sleep(forTimeInterval: Pace.clickDownToUp)
            up.post(tap: .cghidEventTap)
            if index < clicks {
                Thread.sleep(forTimeInterval: Pace.betweenClicks)
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
        Thread.sleep(forTimeInterval: Pace.dragStartSettle)

        guard let down = CGEvent(
            mouseEventSource: SyntheticEvent.eventSource(),
            mouseType: button.downType,
            mouseCursorPosition: start,
            mouseButton: button.cgButton
        ) else { return }
        SyntheticEvent.mark(down)
        down.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: Pace.dragPressSettle)

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
                mouseEventSource: SyntheticEvent.eventSource(),
                mouseType: button.dragType,
                mouseCursorPosition: point,
                mouseButton: button.cgButton
            ) else { continue }
            SyntheticEvent.mark(dragged)
            dragged.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: Pace.dragStep)
        }

        Thread.sleep(forTimeInterval: Pace.dragEndSettle)
        guard let up = CGEvent(
            mouseEventSource: SyntheticEvent.eventSource(),
            mouseType: button.upType,
            mouseCursorPosition: end,
            mouseButton: button.cgButton
        ) else { return }
        SyntheticEvent.mark(up)
        up.post(tap: .cghidEventTap)
    }

    /// The most pages one scroll gesture may move.
    ///
    /// A page is 12 wheel lines emitted in chunks 20 ms apart, so a page count
    /// is a duration as much as a distance: 10 000 pages is roughly 13 minutes
    /// of events. The bound is applied here as well as at the tool surface, so
    /// even a direct caller cannot turn one call into an unbounded gesture.
    static let maxScrollPages = 20.0

    /// Scrolls at a point. `pages` is a scroll wheel unit count where 1 page
    /// equals a full viewport; we approximate that with a line count that feels
    /// right for AppKit and web content alike.
    public static func scroll(
        at point: CGPoint,
        direction: ScrollDirection,
        pages: Double
    ) {
        move(to: point)
        Thread.sleep(forTimeInterval: Pace.scrollSettle)

        let linesPerPage = 12.0
        let bounded = min(max(pages, -Self.maxScrollPages), Self.maxScrollPages)
        let total = bounded * linesPerPage
        let chunk = 3.0
        var remaining = abs(total)
        let sign: Double = total >= 0 ? 1 : -1

        while remaining > 0 {
            let step = min(chunk, remaining)
            remaining -= step
            let (dy, dx) = direction.delta(amount: step * sign)
            guard let event = CGEvent(
                scrollWheelEvent2Source: SyntheticEvent.eventSource(),
                units: .line,
                wheelCount: 2,
                wheel1: Int32(dy),
                wheel2: Int32(dx),
                wheel3: 0
            ) else { continue }
            event.location = point
            SyntheticEvent.mark(event)
            event.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: Pace.betweenScrollChunks)
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
