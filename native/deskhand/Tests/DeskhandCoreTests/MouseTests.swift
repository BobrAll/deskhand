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

    func testScrollGestureIsBoundedAtTheSharedMaximum() {
        // The tool surface clamps too; the bound is repeated at this layer so
        // no direct caller can turn one call into minutes of wheel events.
        XCTAssertEqual(Mouse.maxScrollPages, 20)
        XCTAssertEqual(ToolExecutor.effectiveScrollPages(Mouse.maxScrollPages), Mouse.maxScrollPages)
        XCTAssertEqual(ToolExecutor.effectiveScrollPages(Mouse.maxScrollPages * 100), Mouse.maxScrollPages)
    }
}
