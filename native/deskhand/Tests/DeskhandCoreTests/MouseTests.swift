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

    func testScrollPagesAreCappedAndNonPositiveRejected() {
        // Pages are 12 wheel lines each, emitted in chunks 20 ms apart, so an
        // uncapped 10 000 is minutes on a tool the host treats as harmless.
        // The cap and its validation live together here; the executor only
        // turns the nil answer into a tool error.
        XCTAssertEqual(Mouse.maxScrollPages, 20)
        XCTAssertEqual(Mouse.effectiveScrollPages(0.5), 0.5)
        XCTAssertEqual(Mouse.effectiveScrollPages(1), 1)
        XCTAssertEqual(Mouse.effectiveScrollPages(Mouse.maxScrollPages), Mouse.maxScrollPages)
        XCTAssertEqual(Mouse.effectiveScrollPages(10_000), Mouse.maxScrollPages)
        XCTAssertNil(Mouse.effectiveScrollPages(0))
        XCTAssertNil(Mouse.effectiveScrollPages(-3))
        XCTAssertNil(Mouse.effectiveScrollPages(.nan))
        XCTAssertNil(Mouse.effectiveScrollPages(.infinity))
    }
}
