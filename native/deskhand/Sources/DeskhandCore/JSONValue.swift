import Foundation

/// Minimal dynamic JSON representation used for tool arguments, MCP payloads and
/// model responses. Kept dependency-free so the core has no third-party code.
public enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(any value: Any) {
        switch value {
        case let number as NSNumber:
            // NSNumber bridges to Bool, Int and Double alike, so it must be
            // inspected first and disambiguated by its Objective-C type
            // encoding. Checking `as Bool` first would turn every 1 into true,
            // which silently corrupts JSON-RPC ids and integer arguments.
            if JSONValue.isBooleanNumber(number) {
                self = .bool(number.boolValue)
            } else {
                self = .number(number.doubleValue)
            }
        case let v as Bool:
            self = .bool(v)
        case let v as Int:
            self = .number(Double(v))
        case let v as Double:
            self = .number(v)
        case let v as String:
            self = .string(v)
        case let v as [Any]:
            self = .array(v.map(JSONValue.init(any:)))
        case let v as [String: Any]:
            self = .object(v.mapValues(JSONValue.init(any:)))
        case is NSNull:
            self = .null
        default:
            self = .null
        }
    }

    /// True only for numbers that carry the Objective-C `c` (char) encoding,
    /// which is how `JSONSerialization` represents `true` and `false`.
    static func isBooleanNumber(_ number: NSNumber) -> Bool {
        String(cString: number.objCType) == "c"
    }

    public static func parse(_ data: Data) throws -> JSONValue {
        let obj = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return JSONValue(any: obj)
    }

    public static func parse(_ text: String) throws -> JSONValue {
        guard let data = text.data(using: .utf8) else {
            throw JSONValueError.notUTF8
        }
        return try parse(data)
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var doubleValue: Double? {
        if case .number(let d) = self { return d }
        return nil
    }

    public var intValue: Int? {
        if case .number(let d) = self { return Int(d) }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    public var isBool: Bool {
        if case .bool = self { return true }
        return false
    }

    /// Renders back to compact JSON text.
    public func serialized() -> String {
        switch self {
        case .null:
            return "null"
        case .bool(let b):
            return b ? "true" : "false"
        case .number(let d):
            if d == d.rounded(), abs(d) < 1e15 {
                return String(Int64(d))
            }
            return String(d)
        case .string(let s):
            return JSONValue.quote(s)
        case .array(let items):
            return "[" + items.map { $0.serialized() }.joined(separator: ",") + "]"
        case .object(let obj):
            let body = obj.keys.sorted().map { key in
                JSONValue.quote(key) + ":" + (obj[key]?.serialized() ?? "null")
            }
            return "{" + body.joined(separator: ",") + "}"
        }
    }

    public func serializedData() -> Data {
        Data(serialized().utf8)
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

public enum JSONValueError: Error, CustomStringConvertible {
    case notUTF8

    public var description: String {
        switch self {
        case .notUTF8: return "payload is not valid UTF-8"
        }
    }
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let d = try? container.decode(Double.self) {
            self = .number(d)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let b): try container.encode(b)
        case .number(let d): try container.encode(d)
        case .string(let s): try container.encode(s)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }
}
