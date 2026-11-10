import XCTest
@testable import DeskhandCore

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
                childrenRefused: true
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
                   childrenRefused: true, declaredItemCount: 11),
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
                   childrenRefused: true, declaredItemCount: 3),
        ]
        let text = AXTreeRenderer.render(nodes)
        XCTAssertTrue(text.contains("element 4 (focused) is the way in"), text)
    }

    func testOpaqueContainerWithNoFieldFallsBackToCoordinates() {
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXWindow", title: "Canvas"),
            AXNode(index: 2, depth: 1, role: "AXList",
                   frame: CGRect(x: 0, y: 0, width: 300, height: 300),
                   childrenRefused: true),
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

    func testDeclaredItemCountTellsAnUnaddressableListFromAnEmptyOne() {
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
                childrenRefused: true,
                declaredItemCount: 11
            ),
        ]
        let text = AXTreeRenderer.render(nodes)
        XCTAssertTrue(text.contains("11 items not exposed"), text)
    }

    func testDeclaredItemCountIsSingularForOneItem() {
        let nodes = [
            AXNode(index: 0, depth: 0, role: "AXList",
                   frame: CGRect(x: 0, y: 0, width: 100, height: 100),
                   childrenRefused: true, declaredItemCount: 1),
        ]
        let text = AXTreeRenderer.render(nodes)
        XCTAssertTrue(text.contains("1 item not exposed"), text)
    }

    func testDeclaredItemCountParticipatesInVisibleState() {
        // A list that goes from "hidden, 11 rows" to "hidden, 12 rows" changed,
        // and the diff has to say so.
        let before = snapshot([AXNode(index: 0, depth: 0, role: "AXList",
                                      childrenRefused: true, declaredItemCount: 11)])
        let after = snapshot([AXNode(index: 0, depth: 0, role: "AXList",
                                     childrenRefused: true, declaredItemCount: 12)])
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
        // The number is part of the line: it is the same control for the whole
        // session, so a model can act on a dialog that just appeared without
        // spending a round trip re-reading the tree.
        XCTAssertTrue(diff.text().hasPrefix("+ 1 AXButton"), diff.text())
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
