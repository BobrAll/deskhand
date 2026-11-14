import XCTest
import ApplicationServices
@testable import DeskhandCore

/// Records what the executor offered the policy before a mutating call.
private final class SpyToolPolicy: ToolPolicy, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [ToolCallContext] = []

    func authorize(_ call: ToolCallContext) -> ToolPolicyDecision {
        lock.lock()
        seen.append(call)
        lock.unlock()
        return .allow
    }

    var calls: [ToolCallContext] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }
}

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

    func testClickRejectsOutOfRangeCoordinate() async {
        let executor = ToolExecutor()
        let result = await executor.call(
            name: "click",
            arguments: .object([
                "app": .string("Finder"),
                "x": .number(1e300),
                "y": .number(10),
            ])
        )
        XCTAssertTrue(result.isError, "a huge pixel must not reach the coordinate mapper")
        XCTAssertTrue(
            result.plainText.contains("x must be a screenshot pixel between 0 and 1280"),
            "got: \(result.plainText)"
        )
    }

    func testDragRejectsOutOfRangeCoordinate() async {
        let executor = ToolExecutor()
        let result = await executor.call(
            name: "drag",
            arguments: .object([
                "app": .string("Finder"),
                "from_x": .number(1e300),
                "from_y": .number(10),
                "to_x": .number(20),
                "to_y": .number(30),
            ])
        )
        XCTAssertTrue(result.isError, "a huge pixel must not reach the coordinate mapper")
        XCTAssertTrue(
            result.plainText.contains("from_x must be a screenshot pixel between 0 and 1280"),
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

    func testScrollPagesAreCappedAndNonPositiveRejected() {
        // Pages are 12 wheel lines each, emitted in chunks 20 ms apart, so an
        // uncapped 10 000 is minutes on a tool the host treats as harmless.
        XCTAssertEqual(ToolExecutor.effectiveScrollPages(0.5), 0.5)
        XCTAssertEqual(ToolExecutor.effectiveScrollPages(1), 1)
        XCTAssertEqual(ToolExecutor.effectiveScrollPages(20), 20)
        XCTAssertEqual(ToolExecutor.effectiveScrollPages(10_000), 20)
        XCTAssertNil(ToolExecutor.effectiveScrollPages(0))
        XCTAssertNil(ToolExecutor.effectiveScrollPages(-3))
        XCTAssertNil(ToolExecutor.effectiveScrollPages(.nan))
        XCTAssertNil(ToolExecutor.effectiveScrollPages(.infinity))
    }

    func testScrollRejectsNonPositivePagesBeforeTouchingTheApp() async {
        for pages in [0.0, -1.0] {
            let executor = ToolExecutor()
            let result = await executor.call(
                name: "scroll",
                arguments: .object([
                    "app": .string("Finder"),
                    "direction": .string("down"),
                    "pages": .number(pages),
                ]))
            XCTAssertTrue(result.isError)
            XCTAssertTrue(
                result.plainText.contains("pages must be greater than 0"),
                "got: \(result.plainText)")
        }
    }

    func testClickPlanClampsCountBeforeDecidingAndReporting() {
        // This is the path `click` runs: the plan feeds the accessibility-press
        // branch, the mouse gesture and the result message, so its count is
        // what "Clicked … x5" may no longer claim when the mouse can send three.
        let five = ToolExecutor.clickPlan(buttonName: "left", clickCount: 5, modifiers: [])
        XCTAssertEqual(five.count, 3)
        XCTAssertEqual(five.button, .left)
        XCTAssertFalse(
            five.isPlainLeftClick,
            "a capped multi-click must not take the single-click accessibility branch")

        let zero = ToolExecutor.clickPlan(buttonName: "left", clickCount: 0, modifiers: [])
        XCTAssertEqual(zero.count, 1)
        XCTAssertTrue(zero.isPlainLeftClick, "zero becomes the one plain click the mouse sends")

        let doubleClick = ToolExecutor.clickPlan(buttonName: "left", clickCount: 2, modifiers: [])
        XCTAssertEqual(doubleClick.count, 2)
        XCTAssertFalse(doubleClick.isPlainLeftClick)
    }

    func testValueRolesIncludeTextAreasAndExcludeState() {
        // A text area is a text field for every decision that matters: its
        // value is editable text, so typing into it commits nothing, `submit`
        // applies to it, and an app that refuses AXValue gets the typing
        // fallback. The executor used to test only AXTextField and AXComboBox.
        XCTAssertTrue(ValueRole.isTextEntry(kAXTextFieldRole))
        XCTAssertTrue(ValueRole.isTextEntry(kAXTextAreaRole))
        XCTAssertTrue(ValueRole.isTextEntry(kAXComboBoxRole))
        XCTAssertFalse(ValueRole.isTextEntry(kAXButtonRole))
        XCTAssertFalse(ValueRole.isTextEntry(kAXStaticTextRole))

        // A value that names a row is identity; a value that is state is not.
        XCTAssertTrue(ValueRole.isIdentity(kAXStaticTextRole))
        XCTAssertTrue(ValueRole.isIdentity(kAXCellRole))
        XCTAssertTrue(ValueRole.isIdentity(kAXRowRole))
        XCTAssertTrue(ValueRole.isIdentity(kAXMenuItemRole))
        XCTAssertFalse(ValueRole.isIdentity(kAXCheckBoxRole))
        XCTAssertFalse(ValueRole.isIdentity(kAXRadioButtonRole))
        XCTAssertFalse(ValueRole.isIdentity(kAXSliderRole))
        XCTAssertFalse(ValueRole.isIdentity(kAXScrollBarRole))
        XCTAssertFalse(ValueRole.isIdentity(kAXIncrementorRole))
        XCTAssertFalse(ValueRole.isIdentity(kAXPopUpButtonRole))
        XCTAssertFalse(ValueRole.isIdentity(kAXMenuButtonRole))
        XCTAssertFalse(ValueRole.isIdentity(kAXProgressIndicatorRole))
        XCTAssertFalse(ValueRole.isIdentity(kAXDisclosureTriangleRole))
        XCTAssertFalse(ValueRole.isTextEntry(kAXCheckBoxRole))
    }

    func testBundleLessAppIsExcludedByTheGate() throws {
        // The exclusion list names bundle identifiers. An app resolved by path
        // that cannot read its bundle reports none, and used to pass the gate
        // untouched; resolving the excluded identifiers to paths closes that.
        // Exercise the gate itself, not only the path helper.
        let target = try resolvableApp()
        let bundle = try XCTUnwrap(target.bundleIdentifier)
        let path = try XCTUnwrap(target.path)
        let bundleless = AppHandle(
            pid: target.pid, name: target.name, bundleIdentifier: nil, path: path)

        let excluded = ToolExecutor(excludedBundleIds: [bundle])
        XCTAssertTrue(excluded.isExcluded(bundleless), "the gate must hold a bundle-less app")

        let allowed = ToolExecutor(excludedBundleIds: ["com.example.not-\(bundle)"])
        XCTAssertFalse(allowed.isExcluded(bundleless))

        let noPath = AppHandle(pid: 0, name: "Unreadable", bundleIdentifier: nil, path: nil)
        XCTAssertFalse(excluded.isExcluded(noPath), "no identifier and no path is nothing to match")
    }

    func testExcludedAppIsRefusedBeforeItCanRun() async throws {
        // Finder is the intended target, but a test runner without a GUI cannot
        // resolve it; any installed app proves the same gate.
        let target = try resolvableApp()
        let bundle = try XCTUnwrap(target.bundleIdentifier)
        let executor = ToolExecutor(excludedBundleIds: [bundle])
        // `activate_app` resolves the app before any permission check, so this
        // path reaches the exclusion gate on a machine without Accessibility.
        let result = await executor.call(
            name: "activate_app",
            arguments: .object(["app": .string(bundle)])
        )
        XCTAssertTrue(result.isError, "an excluded app must not be activated")
        XCTAssertTrue(
            result.plainText.contains("exclusion list"),
            "expected the exclusion message, got: \(result.plainText)"
        )
        XCTAssertTrue(result.plainText.contains(target.name))
        XCTAssertTrue(
            executor.allSessions().isEmpty,
            "an excluded app must not get a session or be launched"
        )
    }

    func testAllowedAppIsNotAffectedByOthersExclusions() async throws {
        let target = try resolvableApp()
        let bundle = try XCTUnwrap(target.bundleIdentifier)
        let executor = ToolExecutor(excludedBundleIds: ["com.example.not-\(bundle)"])
        let result = await executor.call(
            name: "activate_app",
            arguments: .object(["app": .string(bundle)])
        )
        XCTAssertFalse(
            result.plainText.contains("exclusion list"),
            "a different app's exclusion must not match \(target.name), got: \(result.plainText)"
        )
    }

    func testExcludedAppIsNotReadBeforeThePolicyRefusesIt() async throws {
        let target = try resolvableApp()
        let bundle = try XCTUnwrap(target.bundleIdentifier)
        let executor = ToolExecutor(excludedBundleIds: [bundle])
        // Seed a session the way an earlier call would have, so this exercises
        // the cached-session branch of `knownSession` without needing a GUI app
        // to already be running.
        let session = executor.session(for: target)
        let policy = SpyToolPolicy()
        executor.policy = policy
        let result = await executor.call(
            name: "click",
            arguments: .object([
                "app": .string(bundle),
                "element_index": .number(0),
            ])
        )

        // The tool is still refused by `resolveSession`…
        XCTAssertTrue(result.isError)
        XCTAssertTrue(
            result.plainText.contains("exclusion list"),
            "expected the exclusion message, got: \(result.plainText)"
        )
        // …but the policy never got a description of the app or its controls,
        // and the pre-action lookup did not walk the tree for one.
        let context = try XCTUnwrap(policy.calls.first)
        XCTAssertNil(context.appName)
        XCTAssertNil(context.bundleIdentifier)
        XCTAssertNil(context.pid)
        XCTAssertNil(context.role)
        XCTAssertNil(context.title)
        XCTAssertNil(context.label)
        XCTAssertFalse(context.isTextField)
        XCTAssertNil(session.snapshot, "the policy path must not refresh the tree")
    }

    private func resolvableApp() throws -> AppHandle {
        if let finder = try? AppCatalog.resolve("Finder") { return finder }
        if let calculator = try? AppCatalog.resolve("Calculator") { return calculator }
        guard let fallback = AppCatalog.installedApps().first(where: { $0.bundleIdentifier != nil })
        else { throw XCTSkip("no resolvable app on this machine") }
        return fallback
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

    func testCursorAfterStartsPastTheTarget() {
        // On an element without `AXSelectedTextRange` the keyboard fallback
        // started at `lowerBound` with length 0 for both caret modes, so
        // `cursor_after` behaved exactly like `cursor_before`. The caret after
        // the target means walking to the target's end, and the 400-character
        // cap then counts the text before the caret, including the target.
        let fallback = ElementActions.keyboardFallback(for: 10..<15, mode: .cursorAfter)
        XCTAssertEqual(fallback.start, 15)
        XCTAssertEqual(fallback.length, 0)
    }

    func testCursorBeforeStartsAtTheTarget() {
        let fallback = ElementActions.keyboardFallback(for: 10..<15, mode: .cursorBefore)
        XCTAssertEqual(fallback.start, 10)
        XCTAssertEqual(fallback.length, 0)
    }

    func testTextModeWalksFromTheTargetOverItsLength() {
        let fallback = ElementActions.keyboardFallback(for: 10..<15, mode: .text)
        XCTAssertEqual(fallback.start, 10)
        XCTAssertEqual(fallback.length, 5)
    }
}
