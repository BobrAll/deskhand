import DeskhandCore
import Foundation

/// Captures the exchange at the provider boundary, without recording headers
/// or URLs that can carry credentials. Scoped to one sidecar task.
public enum ModelTrace {
    @TaskLocal public static var record: (@Sendable (String, [String: JSONValue]) -> Void)?

    static func start(_ request: URLRequest) -> Exchange? {
        guard let record, let body = request.httpBody else { return nil }
        let exchange = Exchange(id: UUID().uuidString, record: record)
        record(
            "model-request",
            [
                "exchange_id": .string(exchange.id),
                "body_bytes": .number(Double(body.count)),
                "body": (try? JSONValue.parse(body)) ?? .null,
            ])
        return exchange
    }

    struct Exchange: Sendable {
        let id: String
        let record: @Sendable (String, [String: JSONValue]) -> Void

        func response(_ body: Data, status: Int) {
            let text = String(decoding: body, as: UTF8.self)
            record(
                "model-response",
                [
                    "exchange_id": .string(id),
                    "status": .number(Double(status)),
                    "body": (try? JSONValue.parse(text)) ?? .string(text),
                ])
        }

        func stream(_ lines: [JSONValue], status: Int) {
            record(
                "model-response",
                [
                    "exchange_id": .string(id),
                    "status": .number(Double(status)),
                    "sse_lines": .array(lines),
                ])
        }

        func failed(_ error: Error) {
            record("model-error", ["exchange_id": .string(id), "message": .string(String(describing: error))])
        }
    }
}
