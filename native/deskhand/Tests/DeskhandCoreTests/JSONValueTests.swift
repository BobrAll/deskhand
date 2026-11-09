import XCTest
@testable import DeskhandCore

final class JSONValueTests: XCTestCase {
    func testParsesScalarsWithCorrectTypes() throws {
        let value = try JSONValue.parse(#"{"id":1,"flag":true,"off":false,"name":"x","pi":3.5,"nil":null}"#)
        XCTAssertEqual(value["id"]?.intValue, 1)
        XCTAssertEqual(value["flag"]?.boolValue, true)
        XCTAssertEqual(value["off"]?.boolValue, false)
        XCTAssertEqual(value["name"]?.stringValue, "x")
        XCTAssertEqual(value["pi"]?.doubleValue, 3.5)
        XCTAssertEqual(value["nil"]?.isNull, true)
    }

    /// Regression: `NSNumber` bridges to `Bool`, so a naive `as Bool` check
    /// turned every 1 into `true` and broke JSON-RPC ids and integer arguments.
    func testNumbersAreNotCoercedToBooleans() throws {
        let value = try JSONValue.parse(#"{"one":1,"zero":0,"big":9000}"#)
        XCTAssertEqual(value["one"]?.intValue, 1)
        XCTAssertFalse(value["one"]?.isBool ?? true)
        XCTAssertEqual(value["zero"]?.intValue, 0)
        XCTAssertEqual(value["big"]?.intValue, 9000)
    }

    func testRoundTripsThroughSerialization() throws {
        let source = #"{"a":[1,2,3],"b":{"c":"d"},"e":true,"f":null}"#
        let parsed = try JSONValue.parse(source)
        let reparsed = try JSONValue.parse(parsed.serialized())
        XCTAssertEqual(parsed, reparsed)
    }

    func testEscapesControlCharactersAndQuotes() throws {
        let value = JSONValue.object(["k": .string("line\nbreak\t\"quoted\"")])
        let text = value.serialized()
        let reparsed = try JSONValue.parse(text)
        XCTAssertEqual(reparsed["k"]?.stringValue, "line\nbreak\t\"quoted\"")
    }

    func testIntegerSerializationHasNoDecimalPoint() {
        XCTAssertEqual(JSONValue.number(42).serialized(), "42")
        XCTAssertEqual(JSONValue.number(42.5).serialized(), "42.5")
    }

    func testNullSerialization() {
        XCTAssertEqual(JSONValue.null.serialized(), "null")
    }
}
