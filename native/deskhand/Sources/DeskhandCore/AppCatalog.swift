import AppKit
import Foundation

/// A running (or launchable) macOS application, resolved from a user-supplied
/// string: display name, full path, or bundle identifier.
public struct AppHandle: Sendable, Identifiable, Equatable {
    public let pid: pid_t
    public let name: String
    public let bundleIdentifier: String?
    public let path: String?

    public var id: pid_t { pid }

    public init(pid: pid_t, name: String, bundleIdentifier: String?, path: String?) {
        self.pid = pid
        self.name = name
        self.bundleIdentifier = bundleIdentifier
        self.path = path
    }

    public init?(runningApp: NSRunningApplication) {
        guard let name = runningApp.localizedName ?? runningApp.bundleIdentifier else { return nil }
        self.pid = runningApp.processIdentifier
        self.name = name
        self.bundleIdentifier = runningApp.bundleIdentifier
        self.path = runningApp.bundleURL?.path
    }
}

public enum AppResolutionError: Error, CustomStringConvertible {
    case notFound(String)
    case ambiguous(String, [String])

    public var description: String {
        switch self {
        case .notFound(let query):
            return "no running or installed app matches \"\(query)\""
        case .ambiguous(let query, let candidates):
            return "app query \"\(query)\" is ambiguous: " + candidates.joined(separator: ", ")
        }
    }
}

public enum AppCatalog {
    /// Resolves a query against running apps first, then installed apps.
    /// Exact bundle identifier and exact display name win over fuzzy matches,
    /// so "Safari" never resolves to "Safari Technology Preview" by accident.
    public static func resolve(_ query: String) throws -> AppHandle {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw AppResolutionError.notFound(query) }

        let running = runningApps()

        if let exact = running.first(where: { $0.bundleIdentifier == trimmed })
            ?? running.first(where: { $0.name.caseInsensitiveCompare(trimmed) == .orderedSame })
            ?? running.first(where: { $0.path == trimmed })
        {
            return exact
        }

        let fuzzyRunning = running.filter {
            $0.name.localizedCaseInsensitiveContains(trimmed)
                || ($0.bundleIdentifier?.localizedCaseInsensitiveContains(trimmed) ?? false)
        }
        if fuzzyRunning.count == 1 { return fuzzyRunning[0] }
        if fuzzyRunning.count > 1 {
            throw AppResolutionError.ambiguous(trimmed, fuzzyRunning.map(\.name))
        }

        let installed = installedApps()
        let matches = installed.filter {
            $0.name.caseInsensitiveCompare(trimmed) == .orderedSame
                || $0.bundleIdentifier == trimmed
                || $0.path == trimmed
        }
        if matches.count == 1 { return matches[0] }
        if matches.count > 1 {
            throw AppResolutionError.ambiguous(trimmed, matches.map(\.name))
        }

        let fuzzyInstalled = installed.filter {
            $0.name.localizedCaseInsensitiveContains(trimmed)
        }
        if fuzzyInstalled.count == 1 { return fuzzyInstalled[0] }
        if fuzzyInstalled.count > 1 {
            throw AppResolutionError.ambiguous(trimmed, fuzzyInstalled.map(\.name))
        }

        throw AppResolutionError.notFound(trimmed)
    }

    public static func runningApps() -> [AppHandle] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .compactMap(AppHandle.init(runningApp:))
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private static let installedAppsLock = NSLock()
    private static var installedAppsCache: [AppHandle]?

    /// Installed apps are discovered from the standard Applications folders
    /// plus `~/Applications`. This is deliberately not a Spotlight query: it
    /// works without extra entitlements and is fast enough for a listing.
    ///
    /// The scan opens a `Bundle` per app, which costs tens of milliseconds for
    /// the ~100 apps on a typical Mac. The list does not change during a run,
    /// so it is cached for the lifetime of the process.
    public static func installedApps() -> [AppHandle] {
        installedAppsLock.lock()
        if let cached = installedAppsCache {
            installedAppsLock.unlock()
            return cached
        }
        installedAppsLock.unlock()

        let scanned = scanInstalledApps()

        installedAppsLock.lock()
        installedAppsCache = scanned
        installedAppsLock.unlock()
        return scanned
    }

    private static func scanInstalledApps() -> [AppHandle] {
        let fm = FileManager.default
        var roots = [
            "/Applications",
            "/Applications/Utilities",
            "/System/Applications",
            "/System/Applications/Utilities",
        ]
        roots.append(fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path)

        var seen = Set<String>()
        var result: [AppHandle] = []
        for root in roots {
            guard let entries = try? fm.contentsOfDirectory(atPath: root) else { continue }
            for entry in entries where entry.hasSuffix(".app") {
                let path = (root as NSString).appendingPathComponent(entry)
                guard seen.insert(path).inserted else { continue }
                guard let bundle = Bundle(path: path) else { continue }
                let name =
                    (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
                    ?? (entry as NSString).deletingPathExtension
                let handle = AppHandle(
                    pid: 0,
                    name: name,
                    bundleIdentifier: bundle.bundleIdentifier,
                    path: path
                )
                result.append(handle)
            }
        }
        return result.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Makes sure the app is running, without changing which app is frontmost.
    ///
    /// Most of what an agent does — reading the accessibility tree, pressing
    /// buttons, setting values, sending key events to one process — works
    /// whether or not the window is in front. Bringing the window forward is
    /// therefore an explicit step that only the pixel-level input paths need,
    /// and it is a costly one: it takes focus away from whatever the user was
    /// doing.
    @discardableResult
    public static func ensureRunning(_ handle: AppHandle) throws -> AppHandle {
        if handle.pid > 0,
            let running = NSRunningApplication(processIdentifier: handle.pid),
            !running.isTerminated
        {
            return handle
        }
        guard let path = handle.path else {
            throw AppResolutionError.notFound(handle.name)
        }
        let url = URL(fileURLWithPath: path)
        let configuration = NSWorkspace.OpenConfiguration()
        // Launch in the background. A freshly launched app usually has no
        // window yet, so it cannot steal focus in a disruptive way, but the
        // flag keeps this path consistent with the rest: activation is decided
        // by the caller, not as a side effect of launching.
        configuration.activates = false

        let semaphore = DispatchSemaphore(value: 0)
        var launched: NSRunningApplication?
        var failure: Error?
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
            launched = app
            failure = error
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 15)

        if let failure { throw failure }
        guard let app = launched, let resolved = AppHandle(runningApp: app) else {
            throw AppResolutionError.notFound(handle.name)
        }
        // Give the app a moment to build its first window and accessibility tree.
        waitUntilRunning(resolved.pid, timeout: 8)
        Thread.sleep(forTimeInterval: 0.35)
        return resolved
    }

    /// Brings one of the app's windows to the front, and the app with it.
    ///
    /// `activate` alone raises whichever window the app considers main, which is
    /// not necessarily the one the tree was read from: an app with a chat window
    /// and a main window will come forward showing the wrong one, and the click
    /// that follows lands in the window the user is not looking at.
    ///
    /// The app is activated first, because a raise on a fully background app is
    /// ignored by several apps, and then the specific window is raised to
    /// correct whichever window the app chose to bring forward by itself.
    ///
    /// Returns the milliseconds spent activating, or nil when the app never
    /// became active. A caller about to post a mouse event must check that: the
    /// event goes to whichever process is frontmost.
    @discardableResult
    public static func activate(pid: pid_t, raising window: AXElement?, timeout: TimeInterval = 1.0) -> Double? {
        let elapsed = activate(pid: pid, timeout: timeout)
        if let window {
            // Best effort: a raise is a no-op for some windows, and that is not a
            // reason to fail an action the activation already made possible.
            _ = window.perform(kAXRaiseAction)
            // The window server processes a raise asynchronously; give it a
            // chance to land before the synthetic event is posted, or the click
            // races the raise and lands in the window that is still in front.
            MainRunLoop.pump(for: 0.03)
        }
        return elapsed
    }

    /// Brings an already-running app to the front. Synthetic input events are
    /// delivered to the focused app, so this must happen before any gesture
    /// that goes through the system event stream.
    ///
    /// Returns milliseconds spent waiting, so a caller can attribute the cost, or
    /// `nil` when the app never became active.
    ///
    /// The wait is the important part. Activation is asynchronous in the window
    /// server and its reply is delivered *to the main run loop*, so a caller
    /// that waits with `Thread.sleep` never lets the reply be delivered: the
    /// wait runs to its one-second deadline and the app is often still not in
    /// front afterwards. Measured on the same call: **1016 ms and
    /// `isActive == false` while sleeping, 29 ms and `isActive == true` while
    /// pumping the loop**. The difference is not the activation itself, it is
    /// who is allowed to run during the wait.
    ///
    /// A GUI host reaches this path with the tools on its main thread, so the
    /// difference is visible there and not on the command line, which already
    /// keeps its loop alive: the same run does strictly more work per gesture
    /// in the app than in the terminal.
    @discardableResult
    public static func activate(pid: pid_t, timeout: TimeInterval = 1.0) -> Double? {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return nil }
        if app.isActive { return 0 }
        let clock = TimingClock()

        // Activation must be requested on the main thread: that is where the
        // window server talks back. Off the main thread we hand the request
        // over instead of making it ourselves, because an activation requested
        // from a background thread blocks for about a second and frequently
        // does not activate the app at all.
        if Thread.isMainThread {
            app.activate(options: [.activateAllWindows])
        } else {
            // Hand the request over and stop waiting for the hand-off itself.
            // A blocking wait here used to time out at 200 ms on a merely busy
            // main thread and then re-request the activation from this thread,
            // which blocks for a second and usually fails anyway. The wait for
            // `isActive` below already covers the honest case: if the main
            // thread is alive the request lands and `isActive` flips; if it is
            // parked, nothing can activate the app and returning `nil` after
            // the timeout is the truth.
            DispatchQueue.main.async {
                app.activate(options: [.activateAllWindows])
            }
        }

        // Then wait, without ever sleeping on the main thread.
        //
        // There used to be a 200 ms semaphore here with a fallback that
        // re-requested the activation from the calling thread. Both parts were
        // worse than doing nothing: the semaphore made a merely-busy main
        // thread look like a dead one, and the fallback then turned that into a
        // one-second blocking call that still failed to activate. The timeout
        // below is the honest answer, and pumping the run loop is what actually
        // lets the reply arrive.
        let deadline = Date().addingTimeInterval(timeout)
        MainRunLoop.wait(until: { app.isActive }, deadline: deadline)
        guard app.isActive else { return nil }
        return clock.milliseconds
    }

    static func waitUntilRunning(_ pid: pid_t, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated {
                if !app.isFinishedLaunching {
                    Thread.sleep(forTimeInterval: 0.1)
                    continue
                }
                return
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
    }
}
