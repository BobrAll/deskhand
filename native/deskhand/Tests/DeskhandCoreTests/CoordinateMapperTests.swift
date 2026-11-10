import XCTest
@testable import DeskhandCore

final class CoordinateMapperTests: XCTestCase {
    func testImagePixelToScreenPoint() {
        let mapper = CoordinateMapper(
            windowFrame: CGRect(x: 100, y: 50, width: 400, height: 300),
            scale: 2.0
        )
        // A click at image pixel (200,100) is 100x50 points into a window
        // whose origin is (100,50), so it lands at (200,100) on screen.
        let point = mapper.screenPoint(fromImagePixel: CGPoint(x: 200, y: 100))
        XCTAssertEqual(point.x, 200, accuracy: 0.001)
        XCTAssertEqual(point.y, 100, accuracy: 0.001)
    }

    func testRoundTrip() {
        let mapper = CoordinateMapper(
            windowFrame: CGRect(x: 30, y: 70, width: 800, height: 600),
            scale: 1.5
        )
        let original = CGPoint(x: 123, y: 456)
        let screen = mapper.screenPoint(fromImagePixel: original)
        let back = mapper.imagePixel(fromScreenPoint: screen)
        XCTAssertEqual(back.x, original.x, accuracy: 0.001)
        XCTAssertEqual(back.y, original.y, accuracy: 0.001)
    }

    func testTreeWalkKeepsTheScaleTheModelIsWorkingIn() {
        // A refresh with include_screenshot:false must not move the coordinate
        // space. The model reads pixels off the last screenshot, which was
        // captured at 0.87, not 1.0; resetting the scale shifts every later
        // click by tens of points and the model reads the resulting empty diff
        // as its own aiming error.
        let existing = CoordinateMapper(
            windowFrame: CGRect(x: 0, y: 33, width: 1470, height: 855),
            scale: 0.87
        )
        let next = AppSession.mapperAfterTreeWalk(
            existing: existing,
            windowFrame: CGRect(x: 0, y: 33, width: 1470, height: 855)
        )
        XCTAssertEqual(next.scale, 0.87, accuracy: 0.0001)
        let before = existing.screenPoint(fromImagePixel: CGPoint(x: 114, y: 202))
        let after = next.screenPoint(fromImagePixel: CGPoint(x: 114, y: 202))
        XCTAssertEqual(before.x, after.x, accuracy: 0.001)
        XCTAssertEqual(before.y, after.y, accuracy: 0.001)
    }

    func testTreeWalkUpdatesTheWindowFrameWithoutTouchingScale() {
        let existing = CoordinateMapper(windowFrame: CGRect(x: 0, y: 0, width: 800, height: 600), scale: 2)
        let next = AppSession.mapperAfterTreeWalk(
            existing: existing,
            windowFrame: CGRect(x: 50, y: 60, width: 900, height: 700)
        )
        XCTAssertEqual(next.scale, 2, accuracy: 0.0001)
        XCTAssertEqual(next.windowFrame.origin.x, 50, accuracy: 0.001)
        XCTAssertEqual(next.windowFrame.origin.y, 60, accuracy: 0.001)
    }

    func testFirstMapperWithoutScreenshotDefaultsToOne() {
        // No screenshot has ever been shown, so pixels and points are the same
        // thing inside the window. Pretending otherwise would be inventing a
        // scale.
        let mapper = AppSession.mapperAfterTreeWalk(
            existing: nil,
            windowFrame: CGRect(x: 10, y: 20, width: 300, height: 200)
        )
        XCTAssertEqual(mapper.scale, 1, accuracy: 0.0001)
    }

    func testZeroScaleIsTreatedAsOne() {
        let mapper = CoordinateMapper(windowFrame: .zero, scale: 0)
        let point = mapper.screenPoint(fromImagePixel: CGPoint(x: 10, y: 10))
        XCTAssertEqual(point.x, 10, accuracy: 0.001)
    }
}
