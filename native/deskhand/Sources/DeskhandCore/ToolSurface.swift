import Foundation

/// The tool contract exposed to models, over MCP and to the built-in agent.
///
/// Definitions live in one place so the MCP server, the agent loop and the
/// documentation can never drift apart.
public enum ToolSurface {
    public static let version = "2025-11-01"

    public static func definitions() -> [ToolDefinition] {
        [
            ToolDefinition(
                name: "list_apps",
                description: """
                List the applications available on this Mac. By default this returns running apps \
                only; pass include_installed to also get apps that are installed but not running. \
                Call this only when you do not know the exact app name.
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "include_installed": .object([
                            "type": .string("boolean"),
                            "description": .string(
                                "Include apps that are installed but not running. Defaults to false."),
                        ])
                    ]),
                    "additionalProperties": .bool(false),
                ])
            ),
            ToolDefinition(
                name: "get_app_state",
                description: """
                Return the state of an app's key window: a screenshot and the accessibility tree. \
                The tree lines are prefixed with an element index you can pass to the element-based \
                tools. Call this before interacting with an app, and again only when you need to see \
                the screen or address an element that is new. To check whether an action worked, \
                call it with include_screenshot: false: the screenshot is the slow part and the tree \
                is what carries the indices.

                This does not bring the app to the front. Reading the tree, pressing elements, \
                setting values and sending keys all work on a background window, so the user's \
                focus is left alone unless you explicitly ask for it with bring_to_front.
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app": .object([
                            "type": .string("string"),
                            "description": .string("App name, bundle identifier, or full app path."),
                        ]),
                        "include_screenshot": .object([
                            "type": .string("boolean"),
                            "description": .string("Include a screenshot. Defaults to true."),
                        ]),
                        "include_tree": .object([
                            "type": .string("boolean"),
                            "description": .string("Include the accessibility tree. Defaults to true."),
                        ]),
                        "bring_to_front": .object([
                            "type": .string("boolean"),
                            "description": .string(
                                """
                                Raise the app's window before reading its state. Defaults to false. \
                                Only needed when the user asks to see the window, or when a gesture \
                                has to land on what is visible on screen.
                                """),
                        ]),
                    ]),
                    "required": .array([.string("app")]),
                    "additionalProperties": .bool(false),
                ])
            ),
            ToolDefinition(
                name: "activate_app",
                description: """
                Bring an app to the front and give it keyboard focus. Most tasks do not need this: \
                accessibility actions, value changes and key events addressed to the app all work \
                while it stays in the background, and acting in the background leaves the user's \
                own window where it is. Use this when the user explicitly asks to show or focus an \
                app, or when a screenshot must show the window unobscured by another window.
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app": .object([
                            "type": .string("string"),
                            "description": .string("App name, bundle identifier, or full app path."),
                        ])
                    ]),
                    "required": .array([.string("app")]),
                    "additionalProperties": .bool(false),
                ])
            ),
            ToolDefinition(
                name: "click",
                description: """
                Click on an element by index, or at pixel coordinates from the most recent screenshot. \
                Prefer element indices: they survive window moves and are not affected by scaling.
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app": .object([
                            "type": .string("string"),
                            "description": .string("App name or bundle identifier."),
                        ]),
                        "element_index": .object([
                            "type": .string("integer"),
                            "description": .string("Element index from the accessibility tree."),
                        ]),
                        "x": .object([
                            "type": .string("number"),
                            "description": .string("X coordinate in screenshot pixels."),
                        ]),
                        "y": .object([
                            "type": .string("number"),
                            "description": .string("Y coordinate in screenshot pixels."),
                        ]),
                        "button": .object([
                            "type": .string("string"),
                            "enum": .array([.string("left"), .string("right"), .string("middle")]),
                            "description": .string("Mouse button. Defaults to left."),
                        ]),
                        "click_count": .object([
                            "type": .string("integer"),
                            "description": .string("Number of clicks, 1-3. Defaults to 1."),
                        ]),
                        "modifiers": .object([
                            "type": .string("array"),
                            "items": .object([
                                "type": .string("string"),
                                "enum": .array([
                                    .string("cmd"), .string("shift"), .string("alt"), .string("ctrl"),
                                ]),
                            ]),
                            "description": .string("Modifier keys held during the click."),
                        ]),
                    ]),
                    "required": .array([.string("app")]),
                    "additionalProperties": .bool(false),
                ])
            ),
            ToolDefinition(
                name: "perform_secondary_action",
                description: """
                Invoke a secondary accessibility action exposed by an element, for example a menu \
                item's "AXShowMenu" or a table row's "AXOpen". Use the action names printed in the \
                accessibility tree.
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app": .object([
                            "type": .string("string"),
                            "description": .string("App name or bundle identifier."),
                        ]),
                        "element_index": .object([
                            "type": .string("integer"),
                            "description": .string("Element index from the accessibility tree."),
                        ]),
                        "action": .object([
                            "type": .string("string"),
                            "description": .string("Accessibility action name, e.g. AXShowMenu."),
                        ]),
                    ]),
                    "required": .array([.string("app"), .string("element_index"), .string("action")]),
                    "additionalProperties": .bool(false),
                ])
            ),
            ToolDefinition(
                name: "set_value",
                description: """
                Set the value of a settable accessibility element, such as a text field or a slider. \
                This replaces the whole value; use type_text when the caret should insert text.
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app": .object([
                            "type": .string("string"),
                            "description": .string("App name or bundle identifier."),
                        ]),
                        "element_index": .object([
                            "type": .string("integer"),
                            "description": .string("Element index from the accessibility tree."),
                        ]),
                        "value": .object([
                            "type": .string("string"),
                            "description": .string("New value, as text."),
                        ]),
                        "submit": .object([
                            "type": .string("boolean"),
                            "description": .string(
                                "Press Return after setting the value, to commit it. Defaults to false."),
                        ]),
                    ]),
                    "required": .array([.string("app"), .string("element_index"), .string("value")]),
                    "additionalProperties": .bool(false),
                ])
            ),
            ToolDefinition(
                name: "select_text",
                description: """
                Select text inside a text element, or place the caret before or after it. Provide the \
                text exactly as it appears in the accessibility tree, including Markdown formatting. \
                If the text occurs more than once, disambiguate it with prefix or suffix text.
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app": .object([
                            "type": .string("string"),
                            "description": .string("App name or bundle identifier."),
                        ]),
                        "element_index": .object([
                            "type": .string("integer"),
                            "description": .string("Element index from the accessibility tree."),
                        ]),
                        "text": .object([
                            "type": .string("string"),
                            "description": .string("Target text as shown in the accessibility tree."),
                        ]),
                        "prefix": .object([
                            "type": .string("string"),
                            "description": .string("Optional text immediately before the target."),
                        ]),
                        "suffix": .object([
                            "type": .string("string"),
                            "description": .string("Optional text immediately after the target."),
                        ]),
                        "mode": .object([
                            "type": .string("string"),
                            "enum": .array([
                                .string("text"), .string("cursor_before"), .string("cursor_after"),
                            ]),
                            "description": .string("Select the text, or place the caret. Defaults to text."),
                        ]),
                    ]),
                    "required": .array([.string("app"), .string("element_index"), .string("text")]),
                    "additionalProperties": .bool(false),
                ])
            ),
            ToolDefinition(
                name: "scroll",
                description: """
                Scroll an element, or the window at a point, in a direction by a number of pages. \
                Fractional page counts are supported for small nudges.
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app": .object([
                            "type": .string("string"),
                            "description": .string("App name or bundle identifier."),
                        ]),
                        "element_index": .object([
                            "type": .string("integer"),
                            "description": .string("Element to scroll. Defaults to the window."),
                        ]),
                        "direction": .object([
                            "type": .string("string"),
                            "enum": .array([
                                .string("up"), .string("down"), .string("left"), .string("right"),
                            ]),
                            "description": .string("Scroll direction."),
                        ]),
                        "pages": .object([
                            "type": .string("number"),
                            "description": .string("Number of pages. Defaults to 1."),
                        ]),
                    ]),
                    "required": .array([.string("app"), .string("direction")]),
                    "additionalProperties": .bool(false),
                ])
            ),
            ToolDefinition(
                name: "drag",
                description: """
                Drag from one point to another using pixel coordinates from the most recent screenshot. \
                Useful for selecting text, moving sliders, or reordering items.
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app": .object([
                            "type": .string("string"),
                            "description": .string("App name or bundle identifier."),
                        ]),
                        "from_x": .object([
                            "type": .string("number"),
                            "description": .string("Start X in screenshot pixels."),
                        ]),
                        "from_y": .object([
                            "type": .string("number"),
                            "description": .string("Start Y in screenshot pixels."),
                        ]),
                        "to_x": .object([
                            "type": .string("number"),
                            "description": .string("End X in screenshot pixels."),
                        ]),
                        "to_y": .object([
                            "type": .string("number"),
                            "description": .string("End Y in screenshot pixels."),
                        ]),
                    ]),
                    "required": .array([
                        .string("app"), .string("from_x"), .string("from_y"), .string("to_x"),
                        .string("to_y"),
                    ]),
                    "additionalProperties": .bool(false),
                ])
            ),
            ToolDefinition(
                name: "press_key",
                description: """
                Press a key or key combination on the keyboard. Uses xdotool-style syntax: \
                "a", "Return", "Tab", "super+c", "ctrl+shift+t", "Up", "KP_0".
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app": .object([
                            "type": .string("string"),
                            "description": .string("App name or bundle identifier."),
                        ]),
                        "key": .object([
                            "type": .string("string"),
                            "description": .string("Key or key combination, e.g. \"super+s\"."),
                        ]),
                        "repeat": .object([
                            "type": .string("integer"),
                            "description": .string("How many times to press it. Defaults to 1."),
                        ]),
                    ]),
                    "required": .array([.string("app"), .string("key")]),
                    "additionalProperties": .bool(false),
                ])
            ),
            ToolDefinition(
                name: "type_text",
                description: """
                Type literal text using keyboard input. Text is delivered as unicode, so any language \
                and emoji work regardless of the active keyboard layout.

                Pass element_index to type into one specific field. Do that whenever the target is \
                not the only place on screen that accepts text: an app with both a message box and a \
                search box gives typing two candidates, and without an index the characters go to \
                whichever one happens to hold focus. Naming the field cannot land in the wrong one, \
                and it works without bringing the window forward.

                Set submit: true to press Return right after typing, which is what commits text in \
                a search box, an address bar or a message box. That is one call instead of two, and \
                the Return cannot overtake the typing.
                """,
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app": .object([
                            "type": .string("string"),
                            "description": .string("App name or bundle identifier."),
                        ]),
                        "text": .object([
                            "type": .string("string"),
                            "description": .string("Literal text to type."),
                        ]),
                        "element_index": .object([
                            "type": .string("integer"),
                            "description": .string(
                                "Focus this element from the accessibility tree before typing."),
                        ]),
                        "clear": .object([
                            "type": .string("boolean"),
                            "description": .string(
                                "Select the field's existing text first, so typing replaces it. "
                                + "Ignored when element_index is absent."),
                        ]),
                        "submit": .object([
                            "type": .string("boolean"),
                            "description": .string(
                                "Press Return after typing. Defaults to false."),
                        ]),
                    ]),
                    "required": .array([.string("app"), .string("text")]),
                    "additionalProperties": .bool(false),
                ])
            ),
        ]
    }
}

public struct ToolDefinition: Sendable {
    public let name: String
    public let description: String
    public let inputSchema: JSONValue

    public init(name: String, description: String, inputSchema: JSONValue) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
    }

    /// MCP `tools/list` representation.
    public var mcpJSON: JSONValue {
        .object([
            "name": .string(name),
            "description": .string(description),
            "inputSchema": inputSchema,
        ])
    }

    /// OpenAI chat-completions `tools` representation.
    public var openAIJSON: JSONValue {
        .object([
            "type": .string("function"),
            "function": .object([
                "name": .string(name),
                "description": .string(description),
                "parameters": inputSchema,
            ]),
        ])
    }

    /// Anthropic messages `tools` representation.
    public var anthropicJSON: JSONValue {
        .object([
            "name": .string(name),
            "description": .string(description),
            "input_schema": inputSchema,
        ])
    }
}
