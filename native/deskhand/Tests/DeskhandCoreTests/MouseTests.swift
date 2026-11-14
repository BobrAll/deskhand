import XCTest
@testable import DeskhandCore

final class MouseTests: XCTestCase {
    func testClickCountIsClampedIntoWhatTheMouseCanSend() {
        // `click_count: 0` used to send one click and report zero; `5` sent
        // three and reported five. The executor now clamps once through this,
        // so its message and the gesture cannot disagree.
        XCTAssertEqual(Mouse.clampedClickCount(0), 1)
        XCTAssertEqual(Mouse.clampedClickCount(-2), 1)
        XCTAssertEqual(Mouse.clampedClickCount(1), 1)
        XCTAssertEqual(Mouse.clampedClickCount(2), 2)
        XCTAssertEqual(Mouse.clampedClickCount(3), 3)
        XCTAssertEqual(Mouse.clampedClickCount(5), 3)
        XCTAssertEqual(Mouse.clampedClickCount(10_000), 3)
    }

    func testCancelledScrollReturnsWithoutEmittingItsChunks() {
        // A scroll is wheel chunks 20 ms apart, so cancelling only between tool
        // calls meant Escape did not stop a long scroll. A pre-cancelled token
        // must return before the first chunk: 10 000 pages is otherwise minutes
        // of events.
        let token = CancelToken()
        token.cancel()

        let clock = Date()
        Mouse.scroll(
            at: CGPoint(x: 10, y: 10),
            direction: .down,
            pages: 10_000,
            cancel: token)
        XCTAssertLessThan(
            Date().timeIntervalSince(clock), 1.0,
            "a cancelled scroll must not keep emitting wheel events")
    }
}
