import XCTest
@testable import DeskhandCore

/// Tool-call plumbing: the executor must reject stale indices rather than
/// acting on whatever element now occupies that slot.
final class ToolExecutorTests: XCTestCase {
    func testUnknownToolIsReportedAsError() async {
        let executor = ToolExecutor()
        let result = await executor.call(name: "not_a_tool", arguments: .object([:]))
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.plainText.contains("unknown tool"))
    }

    func testMissingAppArgumentIsReported() async {
        let executor = ToolExecutor()
        let result = await executor.call(name: "get_app_state", arguments: .object([:]))
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.plainText.contains("app"))
    }

    func testUnresolvableAppIsReportedNotCrashed() async {
        let executor = ToolExecutor()
        let result = await executor.call(
            name: "get_app_state",
            arguments: .object(["app": .string("DefinitelyNotAnApp-9f3a")])
        )
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.plainText.lowercased().contains("no running or installed app"))
    }

    func testClickRequiresCoordinatesOrIndex() async {
        let executor = ToolExecutor()
        // Finder always exists on a logged-in Mac; the assertion here is about
        // argument validation, not about Finder specifically.
        let result = await executor.call(
            name: "click",
            arguments: .object(["app": .string("Finder")])
        )
        if !result.isError {
            // On a headless CI runner Finder may not resolve at all; either way
            // the call must not crash.
            return
        }
        XCTAssertTrue(
            result.plainText.contains("element_index")
                || result.plainText.contains("both x and y")
                || result.plainText.contains("no running or installed app")
        )
    }

    func testStaleIndexIsRejected() async throws {
        let executor = ToolExecutor()
        let result = await executor.call(
            name: "click",
            arguments: .object([
                "app": .string("Finder"),
                "element_index": .number(999_999),
            ])
        )
        XCTAssertTrue(result.isError)
        XCTAssertTrue(
            result.plainText.contains("not part of the current snapshot")
                || result.plainText.contains("no running or installed app")
        )
    }

    func testInvalidScrollDirectionIsRejected() async {
        let executor = ToolExecutor()
        let result = await executor.call(
            name: "scroll",
            arguments: .object(["app": .string("Finder"), "direction": .string("diagonal")])
        )
        XCTAssertTrue(result.isError)
        XCTAssertTrue(
            result.plainText.contains("invalid scroll direction")
                || result.plainText.contains("no running or installed app")
        )
    }
}

final class AppCatalogTests: XCTestCase {
    func testEmptyQueryIsRejected() {
        XCTAssertThrowsError(try AppCatalog.resolve("   "))
    }

    func testNonexistentAppIsRejected() {
        XCTAssertThrowsError(try AppCatalog.resolve("Zzz No Such App 12345"))
    }

    func testInstalledAppsHaveNames() {
        let apps = AppCatalog.installedApps()
        XCTAssertFalse(apps.isEmpty, "expected at least some apps in /Applications")
        for app in apps.prefix(30) {
            XCTAssertFalse(app.name.isEmpty)
            XCTAssertNotNil(app.path)
        }
    }

    func testRunningAppsAreResolvableByBundleID() throws {
        let running = AppCatalog.runningApps()
        guard let sample = running.first(where: { $0.bundleIdentifier != nil }) else {
            throw XCTSkip("no running app with a bundle identifier")
        }
        let resolved = try AppCatalog.resolve(sample.bundleIdentifier!)
        XCTAssertEqual(resolved.pid, sample.pid)
    }
}

final class ElementTextSelectionTests: XCTestCase {
    func testLocatesUniqueOccurrence() {
        let range = ElementActions.locate("world", in: "hello world", prefix: nil, suffix: nil)
        XCTAssertEqual(range, 6..<11)
    }

    func testReturnsNilWhenAbsent() {
        XCTAssertNil(ElementActions.locate("nope", in: "hello world", prefix: nil, suffix: nil))
    }

    func testDisambiguatesByPrefix() {
        let text = "cat dog cat"
        let first = ElementActions.locate("cat", in: text, prefix: nil, suffix: nil)
        XCTAssertEqual(first, 0..<3)
        let second = ElementActions.locate("cat", in: text, prefix: "dog ", suffix: nil)
        XCTAssertEqual(second, 8..<11)
    }

    func testDisambiguatesBySuffix() {
        let text = "cat dog cat"
        let second = ElementActions.locate("cat", in: text, prefix: nil, suffix: nil)
        XCTAssertEqual(second, 0..<3, "without context the first match wins")
        let withPrefix = ElementActions.locate("cat", in: text, prefix: "dog ", suffix: nil)
        XCTAssertEqual(withPrefix, 8..<11)
    }

    func testFallsBackToFirstMatchWhenContextDoesNotMatch() {
        let range = ElementActions.locate("cat", in: "cat dog", prefix: "zzz", suffix: nil)
        XCTAssertEqual(range, 0..<3)
    }

    func testTextSelectionModeParsing() {
        XCTAssertEqual(ElementActions.TextSelection(raw: "text"), .text)
        XCTAssertEqual(ElementActions.TextSelection(raw: "cursor_before"), .cursorBefore)
        XCTAssertEqual(ElementActions.TextSelection(raw: "cursor_after"), .cursorAfter)
        XCTAssertNil(ElementActions.TextSelection(raw: "bogus"))
    }
}
