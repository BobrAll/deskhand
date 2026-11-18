import XCTest

@testable import DeskhandCore

final class AXTreeRendererTests: XCTestCase {
    func testRendersIndicesAndIndentation() {
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox"),
            AXNode(index: 1, depth: 1, role: "AXButton", title: "Send", actions: ["AXPress"]),
        ]
        let text = AXTreeRenderer.render(nodes)
        let lines = text.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.count, 2)
        XCTAssertTrue(lines[0].hasPrefix("0 AXWindow"))
        XCTAssertTrue(lines[1].hasPrefix("  1 AXButton"))
        XCTAssertTrue(lines[1].contains("AXPress"))
    }

    func testClipsLongText() {
        let long = String(repeating: "x", count: 500)
        let nodes = [AXNode(index: 0, depth: 0, role: "AXStaticText", title: long)]
        let line = AXTreeRenderer.render(nodes)
        XCTAssertLessThan(line.count, 260)
        XCTAssertTrue(line.contains("…"))
    }

    func testCollapsesNewlinesInText() {
        let nodes = [AXNode(index: 0, depth: 0, role: "AXStaticText", title: "a\nb")]
        XCTAssertFalse(AXTreeRenderer.render(nodes).contains("\n b"))
    }

    func testMarksDisabledAndSettable() {
        let nodes = [
            AXNode(
                index: 3, depth: 0, role: "AXTextField",
                value: "hello", settable: true, enabled: false
            )
        ]
        let line = AXTreeRenderer.render(nodes)
        XCTAssertTrue(line.contains("[disabled]"))
        XCTAssertTrue(line.contains("[settable]"))
        XCTAssertTrue(line.contains("hello"))
    }
}
