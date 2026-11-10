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
        // `get_app_state` checks the Accessibility grant before it resolves the
        // app, so both messages are legitimate: without the grant the call never
        // reaches the lookup, and with it the lookup reports the missing app.
        // The test is about reporting rather than crashing, not about which of
        // the two preconditions this machine happens to meet.
        let text = result.plainText.lowercased()
        XCTAssertTrue(
            text.contains("no running or installed app")
                || text.contains("accessibility permission is not granted"),
            "expected the not-found or the permission message, got: \(result.plainText)"
        )
    }

    func testClickRequiresCoordinatesOrIndex() async {
        let executor = ToolExecutor()
        // Finder always exists on a logged-in Mac; the assertion here is about
        // argument validation, not about Finder specifically.
        let result = await executor.call(
            name: "click",
            arguments: .object(["app": .string("Finder")])
        )
        // Both outcomes are assertions: with an app the call must be rejected
        // for having no target, and without one (a headless runner, or a
        // missing Accessibility grant) it must be rejected before clicking.
        // A success would mean a click happened with no coordinates and no
        // index, which is the one thing this call may never do.
        XCTAssertTrue(result.isError, "a click with no target must not succeed")
        XCTAssertTrue(
            result.plainText.contains("element_index")
                || result.plainText.contains("both x and y")
                || result.plainText.contains("no running or installed app")
                || result.plainText.contains("Accessibility permission"),
            "got: \(result.plainText)"
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
            result.plainText.contains("is not on screen any more")
                || result.plainText.contains("no running or installed app")
        )
    }

    func testANumberNeverBecomesADifferentControl() {
        // The failure this prevents, measured on a real run: a model pressed a
        // filter button, the result carried a renumbered tree, and its second
        // click on the same number landed on a message row and navigated away
        // from a half-filled form.
        let book = IndexBook()
        let create = book.number(for: "AXButton|Create")
        XCTAssertEqual(book.number(for: "AXButton|Create"), create, "same control, same number")

        let confirm = book.number(for: "AXButton|Confirm")
        XCTAssertNotEqual(confirm, create, "a new control gets a number of its own")

        // The create button is gone from the next walk; its number must not be
        // handed to anything else, or an action planned from memory would hit
        // the wrong control instead of failing honestly.
        let other = book.number(for: "AXCell|")
        XCTAssertNotEqual(other, create)
        XCTAssertNotEqual(other, confirm)
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
        let text = "cat, cat dog"
        let first = ElementActions.locate("cat", in: text, prefix: nil, suffix: nil)
        XCTAssertEqual(first, 0..<3, "without context the first match wins")
        let bySuffix = ElementActions.locate("cat", in: text, prefix: nil, suffix: " dog")
        XCTAssertEqual(bySuffix, 5..<8)
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

    func testSelectionRangeIsConvertedFromCharactersToUTF16() throws {
        // `locate` counts Characters (grapheme clusters), while
        // `AXSelectedTextRange` counts UTF-16 code units. "😀" is one Character
        // but two code units, so the target starts at Character 2 and at UTF-16
        // 3. Passing the Character offset through unchanged selected the wrong
        // text in any field with an emoji before the target.
        let text = "😀 cat"
        let characters = try XCTUnwrap(
            ElementActions.locate("cat", in: text, prefix: nil, suffix: nil))
        XCTAssertEqual(characters, 2..<5, "locate reports Character offsets")

        let range = ElementActions.utf16Range(characters, in: text)
        XCTAssertEqual(range.location, 3, "not 2: the emoji takes two UTF-16 units")
        XCTAssertEqual(range.length, 3)
        XCTAssertEqual(
            (text as NSString).substring(with: range), "cat",
            "the range must still select the target text")
    }

    func testSelectionRangeMatchesCharactersForPlainText() throws {
        let text = "hello world"
        let characters = try XCTUnwrap(
            ElementActions.locate("world", in: text, prefix: nil, suffix: nil))
        let range = ElementActions.utf16Range(characters, in: text)
        XCTAssertEqual(range, NSRange(location: 6, length: 5))
    }
}
