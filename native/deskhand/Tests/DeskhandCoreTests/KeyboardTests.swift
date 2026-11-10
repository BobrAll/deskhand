import XCTest
@testable import DeskhandCore

final class KeyboardTests: XCTestCase {
    func testDestinationNamesTheProcessItAddresses() {
        // The distinction the whole lazy-activation design rests on: a key can
        // be addressed to one process, or to whatever happens to be frontmost.
        XCTAssertEqual(Keyboard.Destination.frontmostApp, .frontmostApp)
        XCTAssertEqual(Keyboard.Destination.process(42), .process(42))
        XCTAssertNotEqual(Keyboard.Destination.process(42), .process(43))
        XCTAssertNotEqual(Keyboard.Destination.process(42), .frontmostApp)
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
