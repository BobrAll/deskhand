import Foundation

/// A cancellation flag that can be raised from another thread.
///
/// `Task.cancel()` is not enough here: the loop is started from a synchronous
/// entry point (`MainRunLoop.await`), so the process that answers "stop" — the
/// app on the other end of a pipe — has no handle on the `Task` itself. This is
/// the handle it can hold instead.
public final class CancelToken: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    public init() {}

    public var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    public func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    /// Throws `CancellationError` when the token has been raised.
    public func check() throws {
        if isCancelled { throw CancellationError() }
    }
}
