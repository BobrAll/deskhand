import Foundation
import AppKit
import CoreGraphics

/// Guarantees the process has a connection to the window server.
///
/// CoreGraphics aborts the process with `CGS_REQUIRE_INIT` if an event is
/// posted or a window is captured before that connection exists. The assertion
/// is not catchable, so it has to be prevented rather than handled.
///
/// A normal GUI app gets the connection for free during launch. A command line
/// tool does not, and touching `NSApplication.shared` is the cheapest way to
/// create it. This used to happen by accident: every tool call began by
/// activating the target app, and `NSRunningApplication.activate` initialises
/// the connection as a side effect. Now that activation is lazy, that accident
/// is gone, so the guarantee is made explicit here and applied on the paths
/// that need it.
public enum WindowServer {
    private static let initialized: Bool = {
        _ = NSApplication.shared
        return true
    }()

    /// Creates the window server connection if it does not exist yet.
    /// Safe to call from any thread; the work happens once.
    public static func prepare() {
        _ = initialized
    }
}
