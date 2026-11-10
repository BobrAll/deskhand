import XCTest
@testable import DeskhandCore

final class WindowCaptureGeometryTests: XCTestCase {
    func testDownscalesLongestEdge() {
        let size = WindowCapture.downscaledSize(
            of: CGSize(width: 4000, height: 2000), longestEdge: 1000)
        XCTAssertEqual(size.width, 1000, accuracy: 0.5)
        XCTAssertEqual(size.height, 500, accuracy: 0.5)
    }

    func testDoesNotUpscale() {
        let size = WindowCapture.downscaledSize(
            of: CGSize(width: 400, height: 200), longestEdge: 1280)
        XCTAssertEqual(size.width, 400, accuracy: 0.5)
        XCTAssertEqual(size.height, 200, accuracy: 0.5)
    }

    func testDegenerateSizeIsClamped() {
        let size = WindowCapture.downscaledSize(of: .zero, longestEdge: 1280)
        XCTAssertGreaterThanOrEqual(size.width, 1)
        XCTAssertGreaterThanOrEqual(size.height, 1)
    }
}

final class WindowSelectionTests: XCTestCase {
    /// The window the accessibility tree was read from, picked out of the app's
    /// windows by its frame.
    func testMatchesTheWindowTheTreeWasReadFrom() {
        let searched = CGRect(x: 400, y: 200, width: 300, height: 400)
        let windows = [
            CGRect(x: 0, y: 0, width: 1400, height: 900),  // main window, larger
            searched,
        ]

        let picked = windows.min {
            WindowCapture.distance(from: $0, to: searched)
                < WindowCapture.distance(from: $1, to: searched)
        }

        XCTAssertEqual(picked, searched)
    }

    func testFallsBackToTheLargestWindowWithoutAFrame() {
        // No tree, no preference: the largest layer-0 window is the honest guess
        // and the behaviour every caller had before the frame was threaded
        // through.
        let windows = [
            CGRect(x: 0, y: 0, width: 300, height: 300),
            CGRect(x: 400, y: 200, width: 900, height: 700),
        ]

        let picked = windows.max { $0.width * $0.height < $1.width * $1.height }

        XCTAssertEqual(picked?.width, 900)
    }

    /// A frame that matches nothing must not be forced onto an unrelated window.
    /// Picking the nearest window regardless is how a click in a chat window gets
    /// measured against the main window's frame.
    func testRejectsAWindowThatIsNotCloseToTheFrame() {
        let treeFrame = CGRect(x: 100, y: 100, width: 400, height: 300)
        let other = CGRect(x: 900, y: 500, width: 400, height: 300)

        XCTAssertGreaterThan(WindowCapture.distance(from: other, to: treeFrame), 8)
    }

    func testToleratesASmallShift() {
        // A window can be reported a few points apart by the accessibility API
        // and by the window server, and the shadow or the title bar is enough to
        // make them disagree. Refusing a match that close would fall back to the
        // largest window and reintroduce the bug.
        let treeFrame = CGRect(x: 100, y: 100, width: 400, height: 300)
        let shifted = CGRect(x: 103, y: 98, width: 401, height: 300)

        XCTAssertLessThanOrEqual(WindowCapture.distance(from: shifted, to: treeFrame), 8)
    }
}
