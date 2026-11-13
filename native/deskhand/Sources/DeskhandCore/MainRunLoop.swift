import Foundation
import AppKit

/// A blocking wait that keeps the main run loop alive.
///
/// This exists because of a measured, surprising cost: `NSRunningApplication
/// .activate` takes **1016 ms** when the main run loop is parked and **13 ms**
/// when it is pumped. Activation is asynchronous in the window server — the
/// reply is delivered to the main run loop — so a process that blocks the main
/// thread on a semaphore waits out a one-second timeout on every single call
/// that brings an app to the front.
///
/// `DispatchSemaphore.wait()` is the obvious way to bridge an async task into a
/// synchronous `main`, and it is exactly what starves the loop. Pumping the run
/// loop instead costs nothing and removes a second of dead time from every
/// `get_app_state`.
public enum MainRunLoop {
    /// Runs the main run loop until `isDone` returns true.
    ///
    /// The slice length bounds the latency of noticing completion; 20 ms is
    /// below the cost of a single tool call and keeps the loop responsive.
    public static func run(
        until isDone: () -> Bool,
        slice: TimeInterval = 0.02
    ) {
        while !isDone() {
            RunLoop.main.run(until: Date().addingTimeInterval(slice))
        }
    }

    /// Waits until `condition` is true, keeping the main run loop alive when
    /// the caller is on it.
    ///
    /// This is the difference between a window-server round trip and a full
    /// timeout. Replies from the window server are delivered *to the main run
    /// loop*: a main-thread caller that waits with `Thread.sleep` never sees
    /// them arrive, so the wait always runs to its deadline. Measured on
    /// `NSRunningApplication.activate`: 1016 ms while sleeping, 29 ms while
    /// pumping. Off the main thread there is no loop to pump, so this sleeps.
    ///
    /// Returns true if the condition became true before the deadline.
    @discardableResult
    public static func wait(
        until condition: () -> Bool,
        deadline: Date,
        slice: TimeInterval = 0.02
    ) -> Bool {
        while !condition() {
            if Date() >= deadline { return false }
            if Thread.isMainThread {
                RunLoop.main.run(until: Date().addingTimeInterval(slice))
            } else {
                Thread.sleep(forTimeInterval: slice)
            }
        }
        return true
    }

    /// Lets the main run loop run for `seconds` so a window-server round trip
    /// started just before can land. Off the main thread there is no loop to
    /// pump, so this sleeps.
    public static func pump(for seconds: TimeInterval) {
        wait(until: { false }, deadline: Date().addingTimeInterval(seconds))
    }

    /// Bridges an async operation into a synchronous entry point without
    /// parking the main thread.
    ///
    /// `body` is started on a task; the main run loop keeps pumping until it
    /// finishes, so window-server replies continue to arrive while we wait.
    public static func await<T>(_ body: @escaping () async throws -> T) throws -> T {
        let box = ResultBox<T>()
        let task = Task {
            do {
                box.finish(.success(try await body()))
            } catch {
                box.finish(.failure(error))
            }
        }
        run(until: { box.isFinished })
        task.cancel()
        return try box.value().get()
    }
}

/// Thread-safe slot for a result crossing from a task back to `main`.
private final class ResultBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<T, Error>?

    var isFinished: Bool {
        lock.lock()
        defer { lock.unlock() }
        return result != nil
    }

    func finish(_ value: Result<T, Error>) {
        lock.lock()
        result = value
        lock.unlock()
    }

    func value() -> Result<T, Error> {
        lock.lock()
        defer { lock.unlock() }
        return result ?? .failure(CancellationError())
    }
}
