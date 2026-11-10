import XCTest
@testable import DeskhandCore

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
