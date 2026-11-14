import XCTest
@testable import DeskhandCore

/// The fingerprint is what "разрешить всегда" remembers, so it has to name the
/// action precisely enough that one approval cannot silently cover another.
final class ToolPolicyTests: XCTestCase {
    private func context(
        tool: String,
        arguments: [String: JSONValue],
        bundle: String? = "com.apple.Safari",
        role: String? = nil,
        title: String? = nil,
        label: String? = nil
    ) -> ToolCallContext {
        ToolCallContext(
            tool: tool,
            arguments: .object(arguments),
            appName: "Safari",
            bundleIdentifier: bundle,
            role: role,
            title: title,
            label: label
        )
    }

    func testLabelledElementClickFingerprintIsUnchanged() {
        // Existing remembered approvals are keyed by this exact string; adding
        // the point must not rewrite the fingerprint of an indexed click.
        let click = context(
            tool: "click",
            arguments: [
                "element_index": .number(5),
                "click_count": .number(2),
                "button": .string("right"),
            ],
            role: "AXButton",
            title: "Отправить"
        )
        XCTAssertEqual(
            click.fingerprint,
            ["click", "com.apple.Safari", "AXButton", "Отправить", "x2", "right"]
                .joined(separator: "\u{1}"))
    }

    func testCoordinateClickFingerprintCarriesItsQuantisedPoint() {
        let near = context(
            tool: "click",
            arguments: ["x": .number(100.4), "y": .number(200.6), "button": .string("left")]
        )
        let sameGrid = context(
            tool: "click",
            arguments: ["x": .number(103.0), "y": .number(198.0), "button": .string("left")]
        )
        let elsewhere = context(
            tool: "click",
            arguments: ["x": .number(500), "y": .number(600), "button": .string("left")]
        )

        XCTAssertTrue(near.fingerprint.hasSuffix("@10,20"), near.fingerprint)
        XCTAssertEqual(
            near.fingerprint, sameGrid.fingerprint,
            "the same control re-measured a few pixels off is the same action")
        XCTAssertNotEqual(
            near.fingerprint, elsewhere.fingerprint,
            "a different point is a different action")
    }

    func testCoordinateClickWithoutAPointIsNeverRemembered() {
        // The bug: a fingerprint of `click\u{1}bundle` let one approval cover
        // every later plain click in the app. An empty fingerprint is what the
        // host refuses to store.
        let missingY = context(tool: "click", arguments: ["x": .number(100)])
        let noPoint = context(tool: "click", arguments: [:])
        let absurd = context(
            tool: "click", arguments: ["x": .number(1e300), "y": .number(10)])

        XCTAssertEqual(missingY.fingerprint, "")
        XCTAssertEqual(noPoint.fingerprint, "")
        XCTAssertEqual(absurd.fingerprint, "")
    }

    func testDragFingerprintNamesBothEnds() {
        let drag = context(
            tool: "drag",
            arguments: [
                "from_x": .number(10), "from_y": .number(20),
                "to_x": .number(300), "to_y": .number(400),
            ])
        XCTAssertEqual(
            drag.fingerprint,
            ["drag", "com.apple.Safari", "from@1,2", "to@30,40"].joined(separator: "\u{1}"))

        let other = context(
            tool: "drag",
            arguments: [
                "from_x": .number(10), "from_y": .number(20),
                "to_x": .number(300), "to_y": .number(900),
            ])
        XCTAssertNotEqual(drag.fingerprint, other.fingerprint)
    }

    func testDragWithoutBothEndsIsNeverRemembered() {
        let incomplete = context(
            tool: "drag",
            arguments: ["from_x": .number(10), "from_y": .number(20)])
        XCTAssertEqual(incomplete.fingerprint, "")
    }
}
