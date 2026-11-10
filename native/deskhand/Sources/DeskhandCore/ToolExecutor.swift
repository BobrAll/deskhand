import Foundation
import ApplicationServices
import CoreGraphics

/// Content returned by a tool call, in a transport-neutral form that maps
/// directly onto MCP content blocks.
public enum ToolContent: Sendable {
    case text(String)
    case imagePNG(Data)

    public var mcpJSON: JSONValue {
        switch self {
        case .text(let text):
            return .object(["type": .string("text"), "text": .string(text)])
        case .imagePNG(let data):
            return .object([
                "type": .string("image"),
                "data": .string(data.base64EncodedString()),
                "mimeType": .string(WindowCapture.mimeType(of: data)),
            ])
        }
    }
}

public struct ToolResult: Sendable {
    public var content: [ToolContent]
    public var isError: Bool
    /// Where this call spent its time, for `--timings`. Not sent to the model.
    public var timings: ToolTimings
    /// A cheap fingerprint of the screen this call left behind.
    ///
    /// Two results with the same fingerprint describe the same window in the
    /// same state. The agent loop uses that to tell "the task moved on" from
    /// "the model is going in circles": a run that keeps returning to a state it
    /// has already been in is not making progress, however busy it looks.
    public var stateFingerprint: String?

    public init(
        content: [ToolContent],
        isError: Bool = false,
        timings: ToolTimings = ToolTimings(),
        stateFingerprint: String? = nil
    ) {
        self.content = content
        self.isError = isError
        self.timings = timings
        self.stateFingerprint = stateFingerprint
    }

    public static func text(_ text: String, timings: ToolTimings = ToolTimings()) -> ToolResult {
        ToolResult(content: [.text(text)], timings: timings)
    }

    public static func failure(_ message: String) -> ToolResult {
        ToolResult(content: [.text(message)], isError: true)
    }

    /// Plain-text projection, used by the agent loop and by logs.
    public var plainText: String {
        content.compactMap { block -> String? in
            if case .text(let text) = block { return text }
            return nil
        }.joined(separator: "\n")
    }

    public var images: [Data] {
        content.compactMap { block -> Data? in
            if case .imagePNG(let data) = block { return data }
            return nil
        }
    }
}

/// Executes tool calls against live applications.
///
/// One executor owns the session table: an app keeps its snapshot and element
/// index space for as long as the session lives, so a model can act on indices
/// it read a few calls ago.
public final class ToolExecutor: @unchecked Sendable {
    private var sessions: [pid_t: AppSession] = [:]
    private let lock = NSLock()

    /// Asked before every mutating tool. Set by the host for the duration of a
    /// run; nil means "no policy installed", which is what the tests and the
    /// command-line tool use.
    public var policy: ToolPolicy?

    /// Told about an action just before it runs, when the host is drawing one.
    ///
    /// Nil for a run with nobody watching. The command-line tool and the
    /// background mode leave it unset, and the tools themselves do not know or
    /// care whether a presenter exists.
    public var presenter: ActionPresenter?

    public init() {}

    public func session(for pid: pid_t) -> AppSession? {
        lock.lock()
        defer { lock.unlock() }
        return sessions[pid]
    }

    public func allSessions() -> [AppSession] {
        lock.lock()
        defer { lock.unlock() }
        return Array(sessions.values)
    }

    private func session(for handle: AppHandle) -> AppSession {
        lock.lock()
        defer { lock.unlock() }
        if let existing = sessions[handle.pid], existing.app.name == handle.name {
            return existing
        }
        let created = AppSession(app: handle)
        sessions[handle.pid] = created
        return created
    }

    public func shutdown() {
        lock.lock()
        sessions.removeAll()
        lock.unlock()
    }

    /// Runs one tool call.
    ///
    /// When `verify` is true, mutating tools append a compact accessibility
    /// diff to their result. That turns "act, then spend a whole model round
    /// trip on get_app_state to see whether it worked" into a single step, at
    /// the price of one tree walk (measured: 20 ms for Telegram, 120 ms for
    /// Chrome, 1.3 s for Finder) instead of a 2-4 s model call.
    public func call(
        name: String,
        arguments: JSONValue,
        verify: Bool = false,
        narration: String? = nil
    ) async -> ToolResult {
        let clock = TimingClock()

        // The host decides whether this call may run. It is asked before the
        // tool touches anything, and it may block — Deskhand puts a question
        // in front of the user and waits for the answer. A refusal is reported
        // as a failed step, so the model learns it was not allowed rather than
        // believing it acted.
        if let policy, MutatingTools.isMutating(name) {
            let context = await describe(name: name, arguments: arguments, narration: narration)
            switch policy.authorize(context) {
                case .allow:
                    break
                case .deny(let reason):
                    var denied = ToolResult.failure(reason.isEmpty
                        ? "The user did not allow this action."
                        : reason)
                    denied.timings.wall = clock.milliseconds
                    return denied
            }
        }

        // After the policy allowed the call and before the tool runs. The
        // presentation is best effort: it resolves the session the tool is about
        // to use but never launches an app, refreshes a tree or captures a
        // screen, so the only cost is a few dictionary lookups. The presenter
        // returns immediately by contract; anything it draws happens elsewhere.
        if MutatingTools.isMutating(name), let presenter,
           let action = presentation(for: name, arguments: arguments) {
            presenter.present(action)
        }

        var result: ToolResult
        do {
            switch name {
            case "list_apps":
                result = try listApps(arguments)
            case "get_app_state":
                result = try await getAppState(arguments)
            case "click":
                result = try await click(arguments, verify: verify)
            case "perform_secondary_action":
                result = try await secondaryAction(arguments, verify: verify)
            case "set_value":
                result = try await setValue(arguments, verify: verify)
            case "select_text":
                result = try await selectText(arguments, verify: verify)
            case "scroll":
                result = try await scroll(arguments, verify: verify)
            case "drag":
                result = try await drag(arguments, verify: verify)
            case "press_key":
                result = try await pressKey(arguments, verify: verify)
            case "type_text":
                result = try await typeText(arguments, verify: verify)
            case "activate_app":
                result = try activateApp(arguments)
            default:
                result = .failure("unknown tool \"\(name)\"")
            }
        } catch {
            result = .failure("\(name) failed: \(errorMessage(error))")
        }
        result.timings.wall = clock.milliseconds
        return result
    }

    /// Builds an action result, optionally followed by "what changed".
    ///
    /// The diff costs one accessibility walk and saves a whole model round
    /// trip, which is the expensive part of the loop. It is opt-in because a
    /// model that is about to fire several actions in a row does not need a
    /// verification between each of them: the loop only asks for it on the last
    /// call of a batch.
    private func finish(
        _ message: String,
        session: AppSession,
        action: String,
        verify: Bool,
        clickedAt point: CGPoint? = nil
    ) -> ToolResult {
        guard verify else {
            return ToolResult(
                content: [.text(message)],
                stateFingerprint: session.currentSnapshot.map { fingerprint(of: $0) })
        }
        let (diff, timings) = session.previewDiff()

        if diff.isEmpty {
            return ToolResult(
                content: [.text(message), .text(noChangeExplanation(action, session: session, point: point))],
                timings: timings,
                stateFingerprint: session.currentSnapshot.map { fingerprint(of: $0) })
        }

        let diffText = "Changed after \(action) (\(diff.summary)):\n" + diff.text()
        // The screen changed, so the model's next move almost always needs the
        // new indices. The diff's walk is already in hand: adopting it and
        // sending the tree here saves the `get_app_state` round trip that
        // would otherwise follow nearly every action. Only the last call of a
        // batch is verified, so no later call still holds the old indices.
        guard let snapshot = session.adoptPreview() else {
            var text = diffText
            if !diff.added.isEmpty {
                text += "\nIndices from the last tree still work for elements that existed. "
                    + "Call get_app_state to address a node that just appeared."
            }
            return ToolResult(
                content: [.text(message), .text(text)],
                timings: timings,
                stateFingerprint: session.currentSnapshot.map { fingerprint(of: $0) })
        }
        return ToolResult(
            content: [
                // The header goes first: the loop keys stale-tree trimming on the
                // first bracketed bundle identifier in the result.
                .text(stateHeader(snapshot)),
                .text(message),
                .text(diffText + "\nThe tree below is fresh. Element numbers are stable for the"
                    + " whole run, so the ones you already used still mean the same controls."
                    + " Call get_app_state only for a screenshot."),
                .text(treeBlock(snapshot)),
            ],
            timings: timings,
            stateFingerprint: fingerprint(of: snapshot))
    }

    /// The identity of "this screen, in this state", as the loop sees it.
    ///
    /// Window title plus the tree's resting signature: two actions that leave
    /// the app in the same place produce the same string, which is what makes
    /// "back here again" detectable without comparing whole trees.
    private func fingerprint(of snapshot: AXSnapshot) -> String {
        "\(snapshot.appName)|\(snapshot.windowTitle ?? "")|\(snapshot.restSignature)"
    }

    private func stateHeader(_ snapshot: AXSnapshot) -> String {
        var header = "\(snapshot.appName)"
        if let bundle = snapshot.bundleIdentifier { header += " [\(bundle)]" }
        if let title = snapshot.windowTitle { header += " — window \"\(title)\"" }
        return header
    }

    private func treeBlock(_ snapshot: AXSnapshot) -> String {
        var treeText = snapshot.nodes.isEmpty ? "Accessibility tree is empty." : snapshot.text
        if snapshot.truncated {
            treeText += "\n… tree truncated at \(snapshot.nodes.count) nodes."
        }
        return "Accessibility tree (\(snapshot.nodes.count) nodes):\n" + treeText
    }

    /// Explains an action that changed nothing.
    ///
    /// "No change" on its own is a dead end: the model cannot tell a miss from
    /// a visual-only effect, so it re-reads the screen and often clicks again.
    /// When a coordinate click is involved we can do better and name the
    /// control the point landed on, which turns a guess into information. If
    /// that control is an opaque container, the message says the content is
    /// there but not addressable — the one case where clicking again will
    /// never help.
    private func noChangeExplanation(_ action: String, session: AppSession, point: CGPoint?) -> String {
        var text = "No change in the accessibility tree after \(action)."

        if let point, let hit = session.smallestNode(containing: point) {
            text += " The point landed on " + describe(hit)
            if let frame = hit.frame {
                text += " at \(Int(frame.origin.x)),\(Int(frame.origin.y)) "
                    + "\(Int(frame.width))x\(Int(frame.height))"
            }
            text += "."
            if hit.childrenHidden {
                if let count = hit.hiddenItemCount {
                    text += " That node holds \(count) item\(count == 1 ? "" : "s") but does not"
                        + " expose them, so nothing inside it has an index."
                } else {
                    text += " That node does not expose its contents, so nothing inside it has an"
                        + " index."
                }
                text += " A different pixel may work, but reaching the item by name (a"
                    + " search or filter field) is more reliable than aiming by position."
                text += " Such lists also often need a second click or Return to open an item,"
                    + " so try click_count: 2 before giving up on this point."
            }
        }

        text += " The effect may also be visual only: call get_app_state to look at the screen."
        return text
    }

    /// Names a node without repeating its role when the role is all it has.
    private func describe(_ node: AXNode) -> String {
        let name = node.title ?? node.label ?? node.value ?? node.identifier
        guard let name, name != node.role else { return node.role }
        return "\(node.role) \"\(name)\""
    }

    // MARK: - Argument helpers

    private func requireApp(_ args: JSONValue) throws -> String {
        guard let app = args["app"]?.stringValue, !app.isEmpty else {
            throw ToolError.missing("app")
        }
        return app
    }

    private func optionalInt(_ args: JSONValue, _ key: String) -> Int? {
        args[key]?.intValue
    }

    private func requireInt(_ args: JSONValue, _ key: String) throws -> Int {
        guard let value = args[key]?.intValue else { throw ToolError.missing(key) }
        return value
    }

    private func optionalDouble(_ args: JSONValue, _ key: String) -> Double? {
        args[key]?.doubleValue
    }

    private func requireDouble(_ args: JSONValue, _ key: String) throws -> Double {
        guard let value = args[key]?.doubleValue else { throw ToolError.missing(key) }
        return value
    }

    private func requireString(_ args: JSONValue, _ key: String) throws -> String {
        guard let value = args[key]?.stringValue else { throw ToolError.missing(key) }
        return value
    }

    private func errorMessage(_ error: Error) -> String {
        if let custom = error as? CustomStringConvertible {
            return custom.description
        }
        return error.localizedDescription
    }

    // MARK: - Tools

    private func listApps(_ args: JSONValue) throws -> ToolResult {
        // Running apps are what an agent can act on, and they are already in the
        // system prompt. The full installed list is ~100 lines of context for
        // something the model needs only when it must *launch* something, so it
        // is opt-in rather than the default.
        let includeInstalled = args["include_installed"]?.boolValue ?? false
        let running = AppCatalog.runningApps()

        var lines = ["Running applications:"]
        for app in running {
            var line = "- \(app.name)"
            if let bundle = app.bundleIdentifier { line += " (\(bundle))" }
            line += " pid=\(app.pid)"
            lines.append(line)
        }

        if includeInstalled {
            let runningPaths = Set(running.compactMap(\.path))
            let installed = AppCatalog.installedApps().filter { !runningPaths.contains($0.path ?? "") }
            lines.append("")
            lines.append("Installed, not running:")
            for app in installed {
                var line = "- \(app.name)"
                if let bundle = app.bundleIdentifier { line += " (\(bundle))" }
                lines.append(line)
            }
        }
        return .text(lines.joined(separator: "\n"))
    }

    /// Resolves an app to a session, launching it if needed.
    ///
    /// Deliberately does not activate the app. Reading the accessibility tree,
    /// pressing buttons, setting values and posting keys to one process all
    /// work on a background window, so activation is left to the few paths that
    /// genuinely need it — real mouse events, which the system delivers to
    /// whatever is frontmost. See `bringToFront(_:)`.
    private func resolveSession(appQuery: String) throws -> AppSession {
        let handle = try AppCatalog.resolve(appQuery)
        let running = try AppCatalog.ensureRunning(handle)
        return session(for: running)
    }

    /// Everything the policy needs to judge a call, resolved from the same state
    /// the tool itself will use.
    ///
    /// Resolution is best effort on purpose: an index that does not resolve is
    /// not a reason to skip the question, it is a reason to ask it with less
    /// information. The app is looked up without launching it — a policy check
    /// must not have the side effect of starting an application.
    /// Everything the policy needs to judge a call, resolved from the same
    /// state the tool itself is about to use.
    ///
    /// Resolution is best effort on purpose: an index that does not resolve is
    /// not a reason to skip the question, it is a reason to ask it with less
    /// information. Nothing here launches an app — a policy check must not have
    /// the side effect of starting something.
    private func describe(
        name: String,
        arguments: JSONValue,
        narration: String?
    ) async -> ToolCallContext {
        var context = ToolCallContext(tool: name, arguments: arguments, narration: narration)
        guard let query = arguments["app"]?.stringValue, !query.isEmpty else { return context }

        guard let session = knownSession(for: query) else { return context }
        context.appName = session.app.name
        context.bundleIdentifier = session.app.bundleIdentifier
        context.pid = session.pid

        guard let index = arguments["element_index"]?.intValue else { return context }
        // The tool is about to read this tree anyway when there is no snapshot,
        // and the difference it makes is between "click something" and
        // "click «Отправить»".
        if session.currentSnapshot == nil { await session.refresh(includeScreenshot: false) }
        guard let node = try? session.node(at: index) else { return context }
        context.role = node.role
        context.title = node.title
        context.label = node.label
        context.isTextField = node.role == kAXTextFieldRole
            || node.role == kAXComboBoxRole
            || node.role == kAXTextAreaRole
        return context
    }

    /// The session for an app query, without launching anything.
    private func knownSession(for query: String) -> AppSession? {
        let existing = allSessions()
        if let match = existing.first(where: { $0.app.name == query })
            ?? existing.first(where: { $0.app.bundleIdentifier == query }) {
            return match
        }
        // A query nothing has touched yet: resolve it against the running apps
        // only, so the policy can name the app before the first tool ran.
        guard let handle = try? AppCatalog.resolve(query),
              let running = AppCatalog.runningApps().first(where: { $0.pid == handle.pid })
        else { return nil }
        return session(for: running)
    }

    /// Turns one call into the picture a host can draw, without side effects.
    ///
    /// Everything here is read from state the tool already has: the session, its
    /// snapshot and its coordinate mapper. It never refreshes the tree, captures
    /// a screenshot or activates an app — those are the expensive parts, and a
    /// visualisation that paid for them would be a visualisation that made the
    /// agent slower. A missing snapshot costs the picture its point, not the
    /// action its speed.
    ///
    /// Returns nil only when the call names no app at all. A call that names an
    /// app but has no geometry still returns a presentation: the host can raise
    /// the window and say "here", which is useful on its own.
    private func presentation(for name: String, arguments: JSONValue) -> ActionPresentation? {
        guard let query = arguments["app"]?.stringValue, !query.isEmpty,
              let session = knownSession(for: query) else { return nil }

        var action = ActionPresentation(
            tool: name,
            gesture: ActionPresentation.gesture(forTool: name),
            appName: session.app.name,
            bundleIdentifier: session.app.bundleIdentifier,
            pid: session.pid,
            window: session.currentSnapshot?.windowFrame
        )

        if let index = arguments["element_index"]?.intValue,
           let node = try? session.node(at: index) {
            action.target = node.frame
            action.point = try? session.centre(of: index)
        }

        switch name {
        case "click":
            // A coordinate click has no element index, so the screenshot mapper
            // is the only thing that can turn its pixels into screen points.
            if action.point == nil,
               let x = arguments["x"]?.doubleValue,
               let y = arguments["y"]?.doubleValue,
               let mapper = session.mapper {
                action.point = mapper.screenPoint(fromImagePixel: CGPoint(x: x, y: y))
            }
        case "drag":
            if let x = arguments["from_x"]?.doubleValue,
               let y = arguments["from_y"]?.doubleValue,
               let mapper = session.mapper {
                action.point = mapper.screenPoint(fromImagePixel: CGPoint(x: x, y: y))
            }
        case "scroll", "press_key", "type_text":
            // No element named: the gesture belongs to the window as a whole,
            // so the middle of it is the honest place to point.
            if action.point == nil, let frame = action.window {
                action.point = CGPoint(x: frame.midX, y: frame.midY)
            }
        case "activate_app":
            if let frame = action.window {
                action.point = CGPoint(x: frame.midX, y: frame.midY)
            }
        default:
            break
        }

        return action
    }

    private func getAppState(_ args: JSONValue) async throws -> ToolResult {
        let appQuery = try requireApp(args)
        let includeScreenshot = args["include_screenshot"]?.boolValue ?? true
        let includeTree = args["include_tree"]?.boolValue ?? true

        let permissions = SystemPermissions.current()
        guard permissions.accessibility else {
            SystemPermissions.requestAccessibility()
            return .failure(
                """
                Accessibility permission is not granted yet. Ask the user to enable Deskhand in \
                System Settings > Privacy & Security > Accessibility, then call get_app_state again.
                """)
        }

        let session = try resolveSession(appQuery: appQuery)
        if args["bring_to_front"]?.boolValue ?? false {
            bringToFront(session)
        }

        // The capture always runs at full quality, even when the caller does not
        // want the image: it is what establishes the mapping between screenshot
        // pixels and screen points. Capturing a degenerate image would leave the
        // mapper with a nonsense scale and make later x/y clicks land nowhere.
        let snapshot = await session.refresh(includeScreenshot: includeScreenshot)

        var blocks: [ToolContent] = []
        blocks.append(.text(stateHeader(snapshot)))

        if includeScreenshot {
            if let capture = session.capture {
                blocks.append(.imagePNG(capture.pngData))
                let frame = capture.windowFrame
                blocks.append(.text(
                    """
                    Screenshot: \(capture.pixelWidth)x\(capture.pixelHeight) px, window at \
                    \(Int(frame.origin.x)),\(Int(frame.origin.y)) size \(Int(frame.width))x\(Int(frame.height)) pt, \
                    scale \(String(format: "%.2f", capture.scale)). Click coordinates are in screenshot pixels.
                    """))
            } else {
                blocks.append(.text(
                    "No screenshot available. Screen Recording permission may be missing: \(permissions.summary)."))
            }
        }

        if includeTree {
            blocks.append(.text(treeBlock(snapshot)))
        }

        return ToolResult(
            content: blocks,
            timings: session.lastTimings,
            stateFingerprint: fingerprint(of: snapshot)
        )
    }

    /// Brings the app to the front before a synthetic input event: CGEvents go
    /// to whatever is focused, so an unfocused window would swallow the input.
    /// Brings the window forward. Only for paths that post events to the
    /// system stream, which the window server delivers to the frontmost app.
    /// Accessibility actions and per-process key events do not need this.
    private func bringToFront(_ session: AppSession) {
        AppCatalog.activate(pid: session.pid, raising: session.windowElement)
    }

    /// Brings the window forward and says so when that did not work.
    ///
    /// A mouse event goes to whatever is frontmost, so an app that refuses to
    /// come forward means the click is about to land somewhere else. Silence
    /// here is expensive: the model sees a click that "changed nothing" and
    /// spends turns re-aiming at a window that was never going to receive the
    /// event.
    private func bringToFrontChecked(_ session: AppSession, action: String) -> String? {
        guard AppCatalog.activate(pid: session.pid, raising: session.windowElement) == nil else { return nil }
        return " Warning: \(session.app.name) did not come to the front, so \(action) may have"
            + " landed in another window. Check the screen before repeating it."
    }

    /// Makes sure the app has somewhere for a key event to go, without
    /// activating it when that is not necessary.
    ///
    /// A key event posted to a process is routed to that app's key window and
    /// then to its focused element. A window that was never focused can still
    /// have a focused element (the app keeps it across deactivation), and then
    /// the event lands correctly with the user's focus untouched. Only when
    /// there is nothing focused do we have to raise the window, because the
    /// event would otherwise be dropped.
    private func ensureKeyboardTarget(_ session: AppSession) {
        let app = AXElement.application(pid: session.pid)
        if let focused = app.focusedElement() {
            _ = focused
            return
        }
        if let window = app.focusedWindow() {
            // Focus the window itself first: some apps expose no focused
            // element until their key window has been told it is key.
            if window.setFocused(true) {
                Thread.sleep(forTimeInterval: 0.05)
                if app.focusedElement() != nil { return }
            }
        }
        bringToFront(session)
    }

    private func activateApp(_ args: JSONValue) throws -> ToolResult {
        let appQuery = try requireApp(args)
        let session = try resolveSession(appQuery: appQuery)
        bringToFront(session)
        return .text("Brought \(session.app.name) to the front.")
    }

    private func click(_ args: JSONValue, verify: Bool) async throws -> ToolResult {
        let appQuery = try requireApp(args)
        let session = try resolveSession(appQuery: appQuery)
        if session.currentSnapshot == nil {
            await session.refresh()
        }

        let button = Mouse.Button(rawValue: args["button"]?.stringValue ?? "left") ?? .left
        let count = args["click_count"]?.intValue ?? 1
        let modifiers = parseModifiers(args["modifiers"])

        // A single, unmodified left click on a pressable element is the case
        // where the accessibility action is strictly better than a mouse event:
        // it works when the element is occluded or off-screen, and it cannot
        // land on the wrong pixel. Anything else (right click, double click,
        // modifier-held click) must be a real mouse event, because those carry
        // semantics the AX press action cannot express.
        let isPlainLeftClick = button == .left && count == 1 && modifiers.isEmpty

        let point: CGPoint
        if let index = optionalInt(args, "element_index") {
            let node = try session.node(at: index)
            // A text field is clicked to put the caret in it, not to press it.
            // Reaching it through accessibility works whether or not the window
            // is in front; a pixel click only focuses it when the app is
            // frontmost *and* the point is not covered by another window, which
            // is exactly the case a background agent cannot rely on. Measured:
            // a pixel click on a background search field left the app's focus
            // where it was, so the following type_text went into the message
            // box instead.
            if isPlainLeftClick, node.role == kAXTextFieldRole || node.role == kAXComboBoxRole {
                if ElementActions.focus(try session.element(at: index)) {
                    session.noteAction()
                    return finish(
                        "Focused element \(index) (\(describe(node))), so typing now goes there.",
                        session: session, action: "the click", verify: verify)
                }
            }
            if isPlainLeftClick, node.actions.contains(kAXPressAction) {
                if (try? ElementActions.press(session.element(at: index))) == true {
                    session.noteAction()
                    return finish(
                        "Pressed element \(index) (\(describe(node))) via its accessibility action.",
                        session: session, action: "the click", verify: verify)
                }
                // Fall through to a pixel click if the app refused the action.
            }
            point = try session.centre(of: index)
        } else if let x = optionalDouble(args, "x"), let y = optionalDouble(args, "y") {
            guard let mapper = session.mapper else {
                throw ToolError.message(
                    "no screenshot coordinates available; call get_app_state with a screenshot first")
            }
            point = mapper.screenPoint(fromImagePixel: CGPoint(x: x, y: y))
        } else {
            throw ToolError.message("click needs either element_index or both x and y")
        }

        let warning = bringToFrontChecked(session, action: "the click")
        Mouse.click(at: point, button: button, count: count, modifiers: modifiers)
        let clickedAt = optionalInt(args, "element_index") == nil ? point : nil
        session.noteAction()
        var message = "Clicked \(button.rawValue) at screen \(Int(point.x)),\(Int(point.y)) x\(count)."
            + (warning ?? "")
        // Clicking a container is aiming at a region, not at an item: the
        // index carried no target of its own, so whatever sat under the
        // point is what reacted. Say so, otherwise a step that happened to
        // work looks like the index did something meaningful.
        if let index = optionalInt(args, "element_index"),
           let clicked = try? session.node(at: index), clicked.childrenHidden {
            if let count = clicked.hiddenItemCount {
                message += " Element \(index) is a container holding \(count)"
                    + " item\(count == 1 ? "" : "s") it does not expose, so the click landed on"
                    + " whatever was at that point rather than on an indexed item."
            } else {
                message += " Element \(index) is a container that does not expose its contents,"
                    + " so the click landed on whatever was at that point."
            }
            // Lists drawn by the app itself (chat lists, tables, custom views)
            // commonly treat a single click as a selection and need a second
            // one, or a Return, to open the item. Saying so here saves the model
            // from concluding that its aim was wrong and starting over.
            message += " A single click in such a list often only selects; if nothing opened,"
                + " try click_count: 2, or press Return."
        }
        return finish(
            message,
            session: session, action: "the click", verify: verify, clickedAt: clickedAt)
    }

    private func secondaryAction(_ args: JSONValue, verify: Bool) async throws -> ToolResult {
        let appQuery = try requireApp(args)
        let index = try requireInt(args, "element_index")
        let action = try requireString(args, "action")
        let session = try resolveSession(appQuery: appQuery)
        if session.currentSnapshot == nil { await session.refresh() }

        let element = try session.element(at: index)
        try ElementActions.perform(element, action: action)
        session.noteAction()
        return finish(
            "Performed \(action) on element \(index).",
            session: session, action: "the action", verify: verify)
    }

    private func setValue(_ args: JSONValue, verify: Bool) async throws -> ToolResult {
        let appQuery = try requireApp(args)
        let index = try requireInt(args, "element_index")
        let value = try requireString(args, "value")
        let session = try resolveSession(appQuery: appQuery)
        if session.currentSnapshot == nil { await session.refresh() }

        let element = try session.element(at: index)
        let role = element.role
        let isTextField = role == kAXTextFieldRole || role == kAXComboBoxRole
        var message: String
        do {
            try ElementActions.setValue(element, text: value, pid: session.pid)
            message = "Set element \(index) to \"\(value)\"."
        } catch {
            // Text entry is the one case worth a second route: apps that
            // refuse a programmatic value usually accept typing, and the model
            // should not have to discover that by trial and error.
            guard isTextField else { throw error }
            guard ElementActions.focus(element) else { throw error }
            ElementActions.selectAll(element)
            Keyboard.typeString(value, to: .process(session.pid))
            message = "Typed \"\(value)\" into element \(index), which does not accept a value"
                + " directly but accepts typing."
        }
        session.noteAction()
        let submitted = (args["submit"]?.boolValue ?? false) && isTextField
        if submitted {
            ensureKeyboardTarget(session)
            try Keyboard.press("Return", to: .process(session.pid))
            message += " Pressed Return to commit it."
        } else if isTextField {
            // A field's value can be set without the app acting on it. In an
            // address bar or a search box, setting the text is only half the
            // job — the page does not change until Return. Saying it here stops
            // the model from reading "no change in the tree" as a failed edit
            // and typing again.
            message += " A text field keeps the value without acting on it: pass submit: true,"
                + " or press Return, to commit it if this was an address bar or a search box."
        }
        return finish(
            message,
            session: session, action: "the edit", verify: verify)
    }

    private func selectText(_ args: JSONValue, verify: Bool) async throws -> ToolResult {
        let appQuery = try requireApp(args)
        let index = try requireInt(args, "element_index")
        let target = try requireString(args, "text")
        let mode = ElementActions.TextSelection(raw: args["mode"]?.stringValue ?? "text") ?? .text
        let session = try resolveSession(appQuery: appQuery)
        if session.currentSnapshot == nil { await session.refresh() }

        let element = try session.element(at: index)
        try ElementActions.selectText(
            element,
            target: target,
            prefix: args["prefix"]?.stringValue,
            suffix: args["suffix"]?.stringValue,
            mode: mode
        )
        session.noteAction()
        return finish(
            "\(mode == .text ? "Selected" : "Placed the caret at") \"\(target)\" in element \(index).",
            session: session, action: "the selection", verify: verify)
    }

    private func scroll(_ args: JSONValue, verify: Bool) async throws -> ToolResult {
        let appQuery = try requireApp(args)
        let directionName = try requireString(args, "direction")
        guard let direction = Mouse.ScrollDirection(rawValue: directionName.lowercased()) else {
            throw ToolError.message("invalid scroll direction \"\(directionName)\"; use up, down, left or right")
        }
        let pages = optionalDouble(args, "pages") ?? 1
        let session = try resolveSession(appQuery: appQuery)
        if session.currentSnapshot == nil { await session.refresh() }

        let point: CGPoint
        if let index = optionalInt(args, "element_index") {
            point = try session.centre(of: index)
        } else if let frame = session.currentSnapshot?.windowFrame {
            point = CGPoint(x: frame.midX, y: frame.midY)
        } else {
            point = Mouse.location()
        }

        bringToFront(session)
        Mouse.scroll(at: point, direction: direction, pages: pages)
        session.noteAction()
        return finish(
            "Scrolled \(direction.rawValue) \(pages) page(s) at \(Int(point.x)),\(Int(point.y)).",
            session: session, action: "the scroll", verify: verify)
    }

    private func drag(_ args: JSONValue, verify: Bool) async throws -> ToolResult {
        let appQuery = try requireApp(args)
        let fromX = try requireDouble(args, "from_x")
        let fromY = try requireDouble(args, "from_y")
        let toX = try requireDouble(args, "to_x")
        let toY = try requireDouble(args, "to_y")
        let session = try resolveSession(appQuery: appQuery)
        if session.currentSnapshot == nil { await session.refresh() }
        guard let mapper = session.mapper else {
            throw ToolError.message("no screenshot coordinates available; call get_app_state first")
        }

        let start = mapper.screenPoint(fromImagePixel: CGPoint(x: fromX, y: fromY))
        let end = mapper.screenPoint(fromImagePixel: CGPoint(x: toX, y: toY))

        bringToFront(session)
        Mouse.drag(from: start, to: end)
        session.noteAction()
        return finish(
            "Dragged from \(Int(start.x)),\(Int(start.y)) to \(Int(end.x)),\(Int(end.y)).",
            session: session, action: "the drag", verify: verify)
    }

    private func pressKey(_ args: JSONValue, verify: Bool) async throws -> ToolResult {
        let appQuery = try requireApp(args)
        let key = try requireString(args, "key")
        let repeatCount = max(1, min(args["repeat"]?.intValue ?? 1, 100))
        let session = try resolveSession(appQuery: appQuery)

        // Delivered to the app's own event queue: the key arrives whether or
        // not the window is in front, and the user's focus is left alone.
        ensureKeyboardTarget(session)
        for _ in 0..<repeatCount {
            try Keyboard.press(key, to: .process(session.pid))
        }
        session.noteAction()
        return finish(
            "Pressed \"\(key)\"" + (repeatCount > 1 ? " \(repeatCount) times." : "."),
            session: session, action: "the key press", verify: verify)
    }

    private func typeText(_ args: JSONValue, verify: Bool) async throws -> ToolResult {
        let appQuery = try requireApp(args)
        let text = try requireString(args, "text")
        let session = try resolveSession(appQuery: appQuery)

        // Addressing a field by index removes the guesswork about where the
        // characters land. Without it we can only ask "does this app have
        // somewhere focused", and an app with two focused nodes at once — a
        // message box and a search box, which is common — answers yes while
        // the text goes to the wrong one. Focusing the named field first makes
        // the destination explicit and works on a background window.
        var target = ""
        if let index = optionalInt(args, "element_index") {
            // Only an indexed call reads the tree. Refreshing it for plain
            // typing would make the cheapest tool in the surface pay for a walk
            // it never looks at.
            if session.currentSnapshot == nil { await session.refresh() }
            let node = try session.node(at: index)
            let element = try session.element(at: index)
            guard ElementActions.focus(element) else {
                throw ToolError.message(
                    "could not focus element \(index) (\(describe(node))) to type into it")
            }
            target = " into element \(index) (\(describe(node)))"
            if args["clear"]?.boolValue ?? false {
                ElementActions.selectAll(element)
            }
        } else {
            // Same reasoning as pressKey: address the process, not the screen.
            ensureKeyboardTarget(session)
        }
        Keyboard.typeString(text, to: .process(session.pid))
        // Committing in the same call, not as a second tool call: typing and
        // Return are one intention, and splitting them costs a model round trip
        // for a step the model already knows it wants.
        let submitted = args["submit"]?.boolValue ?? false
        if submitted {
            try Keyboard.press("Return", to: .process(session.pid))
        }
        session.noteAction()
        return finish(
            "Typed \(text.count) character(s)\(target)"
                + (submitted ? " and pressed Return." : "."),
            session: session, action: submitted ? "typing and Return" : "typing", verify: verify)
    }

    private func parseModifiers(_ value: JSONValue?) -> CGEventFlags {
        guard let items = value?.arrayValue else { return [] }
        var flags: CGEventFlags = []
        for item in items {
            switch item.stringValue?.lowercased() {
            case "cmd", "command", "super": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: break
            }
        }
        return flags
    }
}

public enum ToolError: Error, CustomStringConvertible {
    case missing(String)
    case message(String)

    public var description: String {
        switch self {
        case .missing(let name): return "missing required argument: \(name)"
        case .message(let text): return text
        }
    }
}

