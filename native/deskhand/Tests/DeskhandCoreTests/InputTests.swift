import XCTest
@testable import DeskhandCore

final class KeyboardTests: XCTestCase {
    func testDestinationNamesTheProcessItAddresses() {
        // The distinction the whole lazy-activation design rests on: a key can
        // be addressed to one process, or to whatever happens to be frontmost.
        XCTAssertEqual(Keyboard.Destination.focusedApp, .focusedApp)
        XCTAssertEqual(Keyboard.Destination.process(42), .process(42))
        XCTAssertNotEqual(Keyboard.Destination.process(42), .process(43))
        XCTAssertNotEqual(Keyboard.Destination.process(42), .focusedApp)
    }

    func testSingleCharacterResolvesToKeyCode() throws {
        let parsed = try Keyboard.parse("a")
        XCTAssertEqual(parsed.keyCode, 0)
        XCTAssertTrue(parsed.flags.isEmpty)
    }

    func testModifierCombination() throws {
        let parsed = try Keyboard.parse("super+c")
        XCTAssertEqual(parsed.keyCode, 8)
        XCTAssertTrue(parsed.flags.contains(.maskCommand))
    }

    func testMultipleModifiers() throws {
        let parsed = try Keyboard.parse("ctrl+shift+t")
        XCTAssertEqual(parsed.keyCode, 17)
        XCTAssertTrue(parsed.flags.contains(.maskControl))
        XCTAssertTrue(parsed.flags.contains(.maskShift))
    }

    func testNamedKeys() throws {
        XCTAssertEqual(try Keyboard.parse("Return").keyCode, 36)
        XCTAssertEqual(try Keyboard.parse("Tab").keyCode, 48)
        XCTAssertEqual(try Keyboard.parse("Up").keyCode, 126)
        XCTAssertEqual(try Keyboard.parse("KP_0").keyCode, 82)
    }

    func testNamedKeysAreCaseInsensitive() throws {
        XCTAssertEqual(try Keyboard.parse("RETURN").keyCode, 36)
        XCTAssertEqual(try Keyboard.parse("Esc").keyCode, 53)
    }

    func testUnknownKeyThrows() {
        XCTAssertThrowsError(try Keyboard.parse("NotAKeyName"))
    }

    func testEmptySequenceThrows() {
        XCTAssertThrowsError(try Keyboard.parse("   "))
    }

    func testNonASCIICharacterFallsBackToUnicode() throws {
        let parsed = try Keyboard.parse("ж")
        XCTAssertEqual(parsed.unicode, "ж")
    }
}

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

final class WindowCaptureGeometryTests: XCTestCase {
    func testDownscalesLongestEdge() {
        let size = WindowCapture.fit(size: CGSize(width: 4000, height: 2000), longestEdge: 1000)
        XCTAssertEqual(size.width, 1000, accuracy: 0.5)
        XCTAssertEqual(size.height, 500, accuracy: 0.5)
    }

    func testDoesNotUpscale() {
        let size = WindowCapture.fit(size: CGSize(width: 400, height: 200), longestEdge: 1280)
        XCTAssertEqual(size.width, 400, accuracy: 0.5)
        XCTAssertEqual(size.height, 200, accuracy: 0.5)
    }

    func testDegenerateSizeIsClamped() {
        let size = WindowCapture.fit(size: .zero, longestEdge: 1280)
        XCTAssertGreaterThanOrEqual(size.width, 1)
        XCTAssertGreaterThanOrEqual(size.height, 1)
    }
}

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
        let nodes = [AXNode(
            index: 3, depth: 0, role: "AXTextField",
            value: "hello", settable: true, enabled: false
        )]
        let line = AXTreeRenderer.render(nodes)
        XCTAssertTrue(line.contains("[disabled]"))
        XCTAssertTrue(line.contains("[settable]"))
        XCTAssertTrue(line.contains("hello"))
    }
}

final class ToolSurfaceTests: XCTestCase {
    func testTypeAndSetValueCanCommitInTheSameCall() {
        // Typing and Return are a single intention. Exposing `submit` lets the
        // model express both in one call, which is the difference between one
        // model round trip and three (key, type, Return).
        let tools = ToolSurface.definitions()
        for name in ["type_text", "set_value"] {
            guard let tool = tools.first(where: { $0.name == name }) else {
                return XCTFail("missing tool \(name)")
            }
            let props = tool.inputSchema["properties"]
            XCTAssertNotNil(props?["submit"], "\(name) should accept submit")
            XCTAssertEqual(props?["submit"]?["type"]?.stringValue, "boolean")
        }
    }

    func testEveryToolHasValidSchema() {
        let tools = ToolSurface.definitions()
        XCTAssertEqual(tools.count, 11)
        for tool in tools {
            XCTAssertEqual(tool.inputSchema["type"]?.stringValue, "object", tool.name)
            XCTAssertNotNil(tool.inputSchema["properties"], tool.name)
            XCTAssertFalse(tool.description.isEmpty, tool.name)
        }
    }

    func testRequiredArgumentsExistInProperties() throws {
        for tool in ToolSurface.definitions() {
            let properties = tool.inputSchema["properties"]?.objectValue ?? [:]
            let required = tool.inputSchema["required"]?.arrayValue ?? []
            for name in required {
                let key = try XCTUnwrap(name.stringValue, tool.name)
                XCTAssertNotNil(properties[key], "\(tool.name) requires missing property \(key)")
            }
        }
    }

    func testEncodingsMatchWireFormats() throws {
        let tool = try XCTUnwrap(ToolSurface.definitions().first { $0.name == "click" })
        XCTAssertEqual(tool.mcpJSON["name"]?.stringValue, "click")
        XCTAssertNotNil(tool.mcpJSON["inputSchema"])
        XCTAssertEqual(tool.openAIJSON["type"]?.stringValue, "function")
        XCTAssertEqual(tool.openAIJSON["function"]?["name"]?.stringValue, "click")
        XCTAssertNotNil(tool.openAIJSON["function"]?["parameters"])
        XCTAssertNotNil(tool.anthropicJSON["input_schema"])
        XCTAssertNil(tool.anthropicJSON["inputSchema"])
    }
}

/// The diff is what lets the agent confirm an action without re-reading a whole
/// tree, so it has to distinguish "value changed" from "node replaced" and from
/// "everything scrolled".
final class AXSnapshotDiffTests: XCTestCase {
    private func snapshot(_ nodes: [AXNode], title: String = "Inbox") -> AXSnapshot {
        AXSnapshot(
            pid: 1,
            appName: "Test",
            bundleIdentifier: nil,
            windowTitle: title,
            windowFrame: CGRect(x: 0, y: 0, width: 800, height: 600),
            nodes: nodes,
            createdAt: Date(),
            truncated: false
        )
    }

    func testRestSignatureIsStableForAnUnchangedTree() {
        // The settle loop stops when two consecutive walks agree. If the
        // signature were unstable, it would poll until the budget expired on
        // every action; if it were too coarse, it would stop mid-update and
        // report a half-drawn tree.
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox"),
            AXNode(index: 1, depth: 1, role: "AXButton", title: "Send"),
        ]
        XCTAssertEqual(snapshot(nodes).restSignature, snapshot(nodes).restSignature)
    }

    func testRestSignatureChangesWhenANodeAppears() {
        let before = [AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox")]
        let after = before + [AXNode(index: 1, depth: 1, role: "AXButton", title: "Send")]
        XCTAssertNotEqual(snapshot(before).restSignature, snapshot(after).restSignature)
    }

    func testRestSignatureChangesWhenGeometryMoves() {
        let before = [AXNode(
            index: 0, depth: 0, role: "AXButton", title: "Send",
            frame: CGRect(x: 0, y: 0, width: 40, height: 20)
        )]
        let after = [AXNode(
            index: 0, depth: 0, role: "AXButton", title: "Send",
            frame: CGRect(x: 0, y: 40, width: 40, height: 20)
        )]
        XCTAssertNotEqual(snapshot(before).restSignature, snapshot(after).restSignature)
    }

    func testSmallestNodeFindsTheInnermostMatch() {
        // A click is reported by the control it hit, not by the window that
        // contains everything, so nested frames must resolve to the child.
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow",
                   frame: CGRect(x: 0, y: 0, width: 800, height: 600)),
            AXNode(index: 1, depth: 1, role: "AXButton", title: "Send",
                   frame: CGRect(x: 10, y: 10, width: 100, height: 40)),
        ]
        let snapshot = snapshot(nodes)
        XCTAssertEqual(snapshot.smallestNode(containing: CGPoint(x: 20, y: 20))?.index, 1)
        XCTAssertEqual(snapshot.smallestNode(containing: CGPoint(x: 400, y: 400))?.index, 0)
        XCTAssertNil(snapshot.smallestNode(containing: CGPoint(x: 900, y: 900)))
    }

    func testSmallestNodeIgnoresZeroSizedFrames() {
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow",
                   frame: CGRect(x: 0, y: 0, width: 800, height: 600)),
            AXNode(index: 1, depth: 1, role: "AXGroup",
                   frame: CGRect(x: 10, y: 10, width: 0, height: 0)),
        ]
        XCTAssertEqual(snapshot(nodes).smallestNode(containing: CGPoint(x: 10, y: 10))?.index, 0)
    }

    func testOpaqueContainerIsMarkedInTheRenderedTree() {
        // Telegram's chat list answers kAXErrorAttributeUnsupported for
        // AXChildren. Without a marker the line reads as an empty list, and a
        // model concludes the region has nothing to click.
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Telegram"),
            AXNode(
                index: 1,
                depth: 1,
                role: "AXList",
                frame: CGRect(x: 97, y: 40, width: 294, height: 3592),
                childrenHidden: true
            ),
        ]
        let text = AXTreeRenderer.render(nodes)
        XCTAssertTrue(text.contains("contents not exposed"), text)
        XCTAssertTrue(text.contains("no addressable way in"), text)
    }

    func testOpaqueContainerNamesTheFieldThatLeadsIntoIt() {
        // A region that hides its rows is usually reachable through a search
        // field the tree *can* address. Naming that index is the difference
        // between "you cannot reach this" and a working next step.
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Chats"),
            AXNode(index: 5, depth: 1, role: "AXTextField", subrole: "AXSearchField",
                   label: "Search", settable: true),
            AXNode(index: 7, depth: 1, role: "AXList",
                   frame: CGRect(x: 0, y: 100, width: 300, height: 900),
                   childrenHidden: true, hiddenItemCount: 11),
        ]
        let text = AXTreeRenderer.render(nodes)
        XCTAssertTrue(text.contains("type into element 5"), text)
    }

    func testFocusedEntryFieldIsReportedAsTheWayIn() {
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Chats"),
            AXNode(index: 4, depth: 1, role: "AXTextField", settable: true, focused: true),
            AXNode(index: 9, depth: 1, role: "AXList",
                   frame: CGRect(x: 0, y: 100, width: 300, height: 900),
                   childrenHidden: true, hiddenItemCount: 3),
        ]
        let text = AXTreeRenderer.render(nodes)
        XCTAssertTrue(text.contains("element 4 (focused) is the way in"), text)
    }

    func testOpaqueContainerWithNoFieldFallsBackToCoordinates() {
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Canvas"),
            AXNode(index: 2, depth: 1, role: "AXList",
                   frame: CGRect(x: 0, y: 0, width: 300, height: 300),
                   childrenHidden: true),
        ]
        let text = AXTreeRenderer.render(nodes)
        XCTAssertTrue(text.contains("no addressable way in"), text)
    }

    func testClickTargetIsClampedIntoTheVisibleWindow() {
        // A scrollable container reports its full content height. A chat list
        // 3592 pt tall in an 855 pt window has its geometric centre thousands
        // of points below the screen, and clicking there hits nothing.
        let list = CGRect(x: 97, y: 40, width: 294, height: 3592)
        let window = CGRect(x: 0, y: 33, width: 1470, height: 855)
        let point = AppSession.visibleCentre(of: list, within: window)
        XCTAssertNotNil(point)
        XCTAssertTrue(window.contains(point!), "clamped point must be inside the window")
        XCTAssertGreaterThan(point!.y, window.minY)
        XCTAssertLessThan(point!.y, window.maxY)
    }

    func testOffscreenElementHasNoClickTarget() {
        // Wholly below the window: there is no honest pixel to click, and the
        // caller needs to say so instead of aiming at nothing.
        let row = CGRect(x: 100, y: 5000, width: 200, height: 40)
        let window = CGRect(x: 0, y: 0, width: 800, height: 600)
        XCTAssertNil(AppSession.visibleCentre(of: row, within: window))
    }

    func testElementFullyInsideKeepsItsOwnCentre() {
        let button = CGRect(x: 100, y: 100, width: 80, height: 30)
        let window = CGRect(x: 0, y: 0, width: 800, height: 600)
        let point = AppSession.visibleCentre(of: button, within: window)
        XCTAssertEqual(point?.x ?? 0, 140, accuracy: 0.001)
        XCTAssertEqual(point?.y ?? 0, 115, accuracy: 0.001)
    }

    func testElementStraddlingTheEdgeIsClampedNotDropped() {
        // Partly visible still means clickable, at the visible part.
        let row = CGRect(x: 100, y: 550, width: 200, height: 200)
        let window = CGRect(x: 0, y: 0, width: 800, height: 600)
        let point = AppSession.visibleCentre(of: row, within: window)
        XCTAssertEqual(point?.y ?? 0, 575, accuracy: 0.001)
    }

    func testHiddenItemCountTellsAnUnaddressableListFromAnEmptyOne() {
        // A container can refuse AXChildren and still answer AXRowCount. The
        // count is what separates "nothing here" from "eleven rows you cannot
        // address", and the two call for opposite next moves.
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Chats"),
            AXNode(
                index: 1,
                depth: 1,
                role: "AXList",
                frame: CGRect(x: 97, y: 40, width: 294, height: 3592),
                childrenHidden: true,
                hiddenItemCount: 11
            ),
        ]
        let text = AXTreeRenderer.render(nodes)
        XCTAssertTrue(text.contains("11 items not exposed"), text)
    }

    func testHiddenItemCountIsSingularForOneItem() {
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXList",
                   frame: CGRect(x: 0, y: 0, width: 100, height: 100),
                   childrenHidden: true, hiddenItemCount: 1),
        ]
        let text = AXTreeRenderer.render(nodes)
        XCTAssertTrue(text.contains("1 item not exposed"), text)
    }

    func testHiddenCountParticipatesInVisibleState() {
        // A list that goes from "hidden, 11 rows" to "hidden, 12 rows" changed,
        // and the diff has to say so.
        let before = snapshot([AXNode(index: 0, depth: 0, role: "AXList",
                                      childrenHidden: true, hiddenItemCount: 11)])
        let after = snapshot([AXNode(index: 0, depth: 0, role: "AXList",
                                     childrenHidden: true, hiddenItemCount: 12)])
        XCTAssertFalse(before.diff(from: after).isEmpty)
    }

    func testOrdinaryContainersAreNotMarked() {
        let nodes = [AXNode(index: 0, depth: 0, role: "AXList", title: "Chats")]
        XCTAssertFalse(AXTreeRenderer.render(nodes).contains("contents not exposed"))
    }

    func testIdenticalSnapshotsProduceAnEmptyDiff() {
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox"),
            AXNode(index: 1, depth: 1, role: "AXButton", title: "Send"),
        ]
        let diff = snapshot(nodes).diff(from: snapshot(nodes))
        XCTAssertTrue(diff.isEmpty)
        XCTAssertEqual(diff.summary, "no visible change")
    }

    func testValueChangeIsReportedAsAChangeNotAsAReplacement() {
        let before = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox"),
            AXNode(index: 1, depth: 1, role: "AXTextField", value: ""),
        ]
        let after = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox"),
            AXNode(index: 1, depth: 1, role: "AXTextField", value: "тест"),
        ]
        let diff = snapshot(after).diff(from: snapshot(before))
        XCTAssertEqual(diff.added.count, 0)
        XCTAssertEqual(diff.removed.count, 0)
        XCTAssertEqual(diff.changed.count, 1)
        XCTAssertTrue(diff.text().contains("тест"))
    }

    func testNewNodeIsReportedAsAdded() {
        let before = [AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox")]
        let after = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox"),
            AXNode(index: 1, depth: 1, role: "AXButton", title: "Send"),
        ]
        let diff = snapshot(after).diff(from: snapshot(before))
        XCTAssertEqual(diff.added.count, 1)
        XCTAssertEqual(diff.added.first?.title, "Send")
        XCTAssertTrue(diff.text().hasPrefix("+ AXButton"))
    }

    func testDiffOmitsCoordinatesSoTheChangeIsReadable() {
        // A web page gives every node a frame, so printing them buries the one
        // line that changed — and a frame is useless anyway, since the diff
        // carries no index to act on. The change itself must still be there.
        let before = [AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox")]
        let after = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox"),
            AXNode(index: 1, depth: 1, role: "AXButton", title: "Send",
                   frame: CGRect(x: 402, y: 836, width: 40, height: 40)),
        ]
        let diff = snapshot(after).diff(from: snapshot(before))
        let text = diff.text()
        XCTAssertTrue(text.contains("AXButton"))
        XCTAssertTrue(text.contains("Send"))
        XCTAssertFalse(text.contains("@402,836"), "coordinates are noise in a diff")
    }

    func testDiffSummaryIsSpelledOut() {
        let before = [AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox")]
        let after = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Inbox"),
            AXNode(index: 1, depth: 1, role: "AXButton", title: "Send"),
        ]
        let diff = snapshot(after).diff(from: snapshot(before))
        XCTAssertEqual(diff.summary, "1 added")
    }

    func testPureScrollingIsCountedAsMovement() {
        let before = [AXNode(index: 0, depth: 0, role: "AXButton", title: "Row",
                             frame: CGRect(x: 0, y: 0, width: 10, height: 10))]
        let after = [AXNode(index: 0, depth: 0, role: "AXButton", title: "Row",
                            frame: CGRect(x: 0, y: 40, width: 10, height: 10))]
        let diff = snapshot(after).diff(from: snapshot(before))
        XCTAssertEqual(diff.moved, 1)
        XCTAssertTrue(diff.changed.isEmpty)
        XCTAssertTrue(diff.added.isEmpty)
        XCTAssertTrue(diff.removed.isEmpty)
    }

    func testIdenticalSiblingsStayDistinct() {
        let before = [
            AXNode(index: 0, depth: 0, role: "AXList"),
            AXNode(index: 1, depth: 1, role: "AXStaticText", value: "a"),
            AXNode(index: 2, depth: 1, role: "AXStaticText", value: "a"),
        ]
        let after = [
            AXNode(index: 0, depth: 0, role: "AXList"),
            AXNode(index: 1, depth: 1, role: "AXStaticText", value: "a"),
        ]
        let diff = snapshot(after).diff(from: snapshot(before))
        XCTAssertEqual(diff.removed.count, 1, "one of two identical rows really disappeared")
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
            WindowCapture.distance($0, searched) < WindowCapture.distance($1, searched)
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

        XCTAssertGreaterThan(WindowCapture.distance(other, treeFrame), 8)
    }

    func testToleratesASmallShift() {
        // A window can be reported a few points apart by the accessibility API
        // and by the window server, and the shadow or the title bar is enough to
        // make them disagree. Refusing a match that close would fall back to the
        // largest window and reintroduce the bug.
        let treeFrame = CGRect(x: 100, y: 100, width: 400, height: 300)
        let shifted = CGRect(x: 103, y: 98, width: 401, height: 300)

        XCTAssertLessThanOrEqual(WindowCapture.distance(shifted, treeFrame), 8)
    }
}
