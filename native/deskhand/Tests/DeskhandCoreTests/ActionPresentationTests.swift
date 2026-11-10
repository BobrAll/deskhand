import XCTest
@testable import DeskhandCore

/// The picture of an action is a vocabulary, and a vocabulary has to stay
/// closed: every tool the surface exposes must map to a gesture a host can draw.
///
/// This is not a test of the tools. It is the test that a tool added to
/// `ToolSurface` cannot silently fall through to the default animation without
/// anyone noticing — the default exists so an unknown name still draws *something*,
/// not so a known one can be forgotten.
final class ActionPresentationTests: XCTestCase {
    func testEveryMutatingToolMapsToItsOwnGesture() {
        let expected: [String: ActionPresentation.Gesture] = [
            "click": .click,
            "perform_secondary_action": .secondary,
            "type_text": .type,
            "set_value": .value,
            "select_text": .select,
            "press_key": .key,
            "scroll": .scroll,
            "drag": .drag,
            "activate_app": .activate,
        ]

        for tool in MutatingTools.names {
            XCTAssertNotNil(expected[tool], "\(tool) is mutating but has no gesture")
            XCTAssertEqual(ActionPresentation.gesture(forTool: tool), expected[tool])
        }
        XCTAssertEqual(Set(expected.keys), MutatingTools.names)
    }

    func testReadingToolsAreNotPresentedAsGestures() {
        // A read has nothing to animate: it changes nothing on screen, and a
        // pointer travelling for `get_app_state` would be a lie about what is
        // happening.
        XCTAssertFalse(MutatingTools.isMutating("get_app_state"))
        XCTAssertFalse(MutatingTools.isMutating("list_apps"))
    }

    func testAnUnknownToolStillDrawsAClick() {
        // A new tool must not make the layer disappear: the fallback is the least
        // surprising animation, not an empty frame.
        XCTAssertEqual(ActionPresentation.gesture(forTool: "not_a_tool"), .click)
    }

    func testAPresentationCarriesNoElementHandleAndNoArguments() {
        // The picture is geometry and names. Anything that could act — an
        // `AXElement`, a tool argument — would make the layer a second executor.
        let action = ActionPresentation(
            tool: "click",
            gesture: .click,
            appName: "Safari",
            bundleIdentifier: "com.apple.Safari",
            pid: 42,
            point: CGPoint(x: 10, y: 20),
            elementFrame: CGRect(x: 0, y: 0, width: 30, height: 40),
            windowFrame: CGRect(x: 0, y: 0, width: 800, height: 600)
        )

        XCTAssertEqual(action.tool, "click")
        XCTAssertEqual(action.gesture, .click)
        XCTAssertEqual(action.appName, "Safari")
        XCTAssertEqual(action.bundleIdentifier, "com.apple.Safari")
        XCTAssertEqual(action.pid, 42)
        XCTAssertEqual(action.point, CGPoint(x: 10, y: 20))
        XCTAssertEqual(action.elementFrame, CGRect(x: 0, y: 0, width: 30, height: 40))
        XCTAssertEqual(action.windowFrame, CGRect(x: 0, y: 0, width: 800, height: 600))
    }

    func testGeometryIsOptional() {
        // A key press into an app that was never read has no point and no frame.
        // The action is still valid, and the picture simply has less to say.
        let action = ActionPresentation(tool: "press_key", gesture: .key, appName: "Notes")
        XCTAssertNil(action.point)
        XCTAssertNil(action.elementFrame)
        XCTAssertNil(action.windowFrame)
    }
}
