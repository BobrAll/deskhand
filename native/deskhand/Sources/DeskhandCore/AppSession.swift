import Foundation
import ApplicationServices
import CoreGraphics

/// How long to wait for an app to reflect an action in its accessibility tree.
///
/// Measured on Telegram: a click that opens a chat panel shows up in the tree
/// between 36 ms and 170 ms later. A diff taken immediately therefore reports
/// "no change" for an action that worked, which is worse than reporting
/// nothing: the model concludes its click missed and starts hunting.
public struct DiffSettle: Sendable {
    /// Stop polling after this long, even if the tree never stops moving.
    public var budgetMilliseconds: Double
    /// Gap between polls, in milliseconds.
    public var intervalMilliseconds: Double
    /// If a walk usually costs more than this, do not poll at all.
    ///
    /// The wait only pays for itself when a walk is cheap. Polling on a
    /// 900-node Finder window would add 1.3 s to every action to save a turn
    /// that costs 2-4 s of model time — but it would also make every action
    /// feel like molasses, so the expensive case is left alone.
    ///
    /// This is compared against the *baseline* walk (the last full refresh),
    /// not against the walk taken right after the action. Those are different
    /// numbers: an app that is mid-update answers slower, and judging by that
    /// would switch off the wait exactly when it is needed.
    public var maxWalkCostMilliseconds: Double

    public init(
        budgetMilliseconds: Double = 400,
        intervalMilliseconds: Double = 30,
        maxWalkCostMilliseconds: Double = 250
    ) {
        self.budgetMilliseconds = budgetMilliseconds
        self.intervalMilliseconds = intervalMilliseconds
        self.maxWalkCostMilliseconds = maxWalkCostMilliseconds
    }
}

/// An active session with one application.
///
/// The session owns the current snapshot and the index -> element table that
/// backs it. Actions that address an element by index must go through the
/// session, which guarantees the index belongs to the snapshot the model was
/// looking at when it decided to act.
public final class AppSession {
    public let app: AppHandle
    private(set) var snapshot: AXSnapshot?
    private(set) var elementTable: [Int: AXElement]
    private(set) var lastCapture: WindowCapture.Result?
    /// Why the last capture attempt produced no image, when it failed.
    ///
    /// Kept so the model is told what actually happened. Without it a failed
    /// capture is reported as a missing permission, which reads as
    /// "…may be missing: all permissions granted" on a Mac that has granted it,
    /// and sends the model looking for a setting that is already on.
    private(set) var lastCaptureError: String?
    private(set) var coordinateMapper: CoordinateMapper?
    /// Time spent inside the last refresh, split by phase, for the timings log.
    private(set) var lastTimings = ToolTimings()
    /// The tree the next diff is computed against. It advances after every
    /// diff, so each action's report covers only what that action changed.
    private var diffBaseline: AXSnapshot?
    /// The element table of the walk behind `diffBaseline`, kept so that the
    /// walk can be adopted as the current snapshot without walking again.
    private var diffBaselineTable: [Int: AXElement]?
    /// The numbers already given to controls in this app.
    ///
    /// Owned by the session, not by a walk: that is what makes an index mean the
    /// same control from one snapshot to the next, so an action planned a step
    /// ago still lands on what the model meant.
    private let indexBook = IndexBook()
    /// The accessibility window the current snapshot was read from.
    ///
    /// Kept as an element, not just as a frame, because bringing the app forward
    /// is not enough to put *this* window in front: an app with several windows
    /// raises its own main window and leaves the one being worked on behind. The
    /// element is what lets an action raise the window the indices belong to.
    var windowElement: AXElement?

    public init(app: AppHandle) {
        self.app = app
        self.elementTable = [:]
    }

    /// Rebuilds the accessibility tree and, unless disabled, captures a fresh
    /// screenshot.
    ///
    /// The coordinate mapper is always established, even without a screenshot:
    /// it falls back to the window's own frame with a scale of 1, which makes
    /// pixel coordinates equal to points inside the window. Without that, a
    /// model that skipped the screenshot would have no defined coordinate space
    /// for its x/y clicks.
    @discardableResult
    public func refresh(
        treeOptions: AXTreeWalker.Options = .init(),
        captureOptions: WindowCapture.Options = .init(),
        includeScreenshot: Bool = true
    ) async -> AXSnapshot {
        let clock = TimingClock()
        var timings = ToolTimings()

        var table: [Int: AXElement] = [:]
        let treeClock = TimingClock()
        let snap = AXTreeWalker.snapshot(
            app: app, options: treeOptions, elementTable: &table, indexBook: indexBook)
        timings.tree = treeClock.milliseconds
        snapshot = snap
        elementTable = table
        diffBaseline = snap
        diffBaselineTable = nil

        // A refresh without a screenshot must not change the coordinate space.
        // The model reads pixels off the last screenshot it was given, and that
        // screenshot was taken at the capture scale (0.87 here, not 1.0).
        // Resetting the scale to 1.0 makes the same pixel mean a different
        // point, so the click lands tens of points away from the target and the
        // model reads the empty diff as "I missed" — while it aimed correctly.
        // The scale is kept and only the window frame is updated, since the
        // window may have moved. With no mapper yet, a scale of 1 is the honest
        // fallback: pixels equal points inside the window.
        if let frame = snap.windowFrame {
            coordinateMapper = Self.mapperAfterTreeWalk(
                existing: coordinateMapper, windowFrame: frame)
        }
        // Resolved again rather than carried in the snapshot: the snapshot is
        // `Sendable` and describes a window, while an action needs a handle it
        // can raise. Re-resolving is one attribute read and cannot go stale
        // between the walk and the action.
        windowElement = AXTreeWalker.focusedWindow(of: AXElement.application(pid: app.pid))

        if includeScreenshot {
            do {
                let captureClock = TimingClock()
                // The screenshot must be of the window the tree was read from.
                // Otherwise an app with two windows gives the model indices from
                // one and pixels from the other, and every x/y click is measured
                // against a frame the target does not live in.
                let result = try await WindowCapture.capture(
                    pid: app.pid,
                    options: captureOptions,
                    preferredFrame: snap.windowFrame)
                timings.capture = captureClock.milliseconds
                timings.encode = result.encodeMilliseconds
                timings.screenshotBytes = result.imageData.count
                lastCapture = result
                lastCaptureError = nil
                coordinateMapper = CoordinateMapper(
                    windowFrame: result.windowFrame, scale: result.scale)
            } catch {
                lastCapture = nil
                lastCaptureError = "\(error)"
            }
        } else {
            lastCapture = nil
            lastCaptureError = nil
        }

        timings.wall = clock.milliseconds
        lastTimings = timings
        return snap
    }

    /// Re-reads the tree and reports what changed since the snapshot the model
    /// was last shown, **without** replacing that snapshot.
    ///
    /// Not replacing it is the point. `elementTable` holds live `AXUIElement`
    /// handles, so indices the model already has keep pointing at the same
    /// controls even after the UI changed — that is what makes "click, then
    /// type, then press Return" in a single answer safe. Rebuilding the table
    /// here would invalidate the very indices the model is still using.
    ///
    /// Numbers survive the walk for a second reason: `IndexBook` renumbers each
    /// fresh walk back onto the numbers already handed out, so a control that
    /// is still on screen keeps its index across snapshots. What is *not* yet
    /// addressable is a control that only just appeared — it has its number, but
    /// the number enters the element table when the walk is adopted
    /// (`adoptPreview`), which the executor does as part of the same result.
    @discardableResult
    public func previewDiff(
        treeOptions: AXTreeWalker.Options = .init(),
        settle: DiffSettle = DiffSettle()
    ) -> (diff: AXSnapshotDiff, timings: ToolTimings) {
        guard let previous = diffBaseline ?? snapshot else {
            return (AXSnapshotDiff(), ToolTimings())
        }

        // Decide whether polling is affordable from the last full refresh, not
        // from the walk below: the first walk after an action is the slowest
        // one (measured 258 ms on Telegram against a usual 40 ms), because the
        // app is mid-update. Judging by that number would disable the wait
        // exactly when it is needed.
        let pollAffordable = lastTimings.tree <= settle.maxWalkCostMilliseconds

        let clock = TimingClock()
        var treeMilliseconds = 0.0
        var latest = previous
        var latestTable: [Int: AXElement] = [:]
        var latestDiff = AXSnapshotDiff()
        var previousSignature: Int?
        var polls = 0

        // Poll until two consecutive walks describe the same tree: an app that
        // is still painting changes its tree between polls, one that has
        // finished does not. The budget bounds the worst case, and a minimum of
        // two polls guarantees the comparison is meaningful.
        while true {
            let walkClock = TimingClock()
            var scratch: [Int: AXElement] = [:]
            let current = AXTreeWalker.snapshot(
                app: app, options: treeOptions, elementTable: &scratch, indexBook: indexBook)
            treeMilliseconds += walkClock.milliseconds
            polls += 1

            latest = current
            latestTable = scratch
            latestDiff = current.diff(from: previous)

            let signature = current.settledSignature
            if polls >= 2, signature == previousSignature { break }
            previousSignature = signature

            if !pollAffordable { break }
            if clock.milliseconds >= settle.budgetMilliseconds { break }
            Thread.sleep(forTimeInterval: settle.intervalMilliseconds / 1000)
        }

        diffBaseline = latest
        diffBaselineTable = latestTable
        return (
            latestDiff,
            ToolTimings(wall: clock.milliseconds, tree: treeMilliseconds)
        )
    }

    /// Makes the walk taken by the last `previewDiff` the current snapshot.
    ///
    /// Called after the last action of a batch, when nothing else is still
    /// holding indices from the old tree. The model gets the new tree in the
    /// action's own result instead of spending a round trip on `get_app_state`,
    /// and the walk is reused rather than taken again. Returns nil when there
    /// is no preview walk to adopt.
    public func adoptPreview() -> AXSnapshot? {
        guard let latest = diffBaseline, let table = diffBaselineTable else { return nil }
        snapshot = latest
        elementTable = table
        diffBaselineTable = nil
        if let frame = latest.windowFrame {
            coordinateMapper = Self.mapperAfterTreeWalk(
                existing: coordinateMapper, windowFrame: frame)
        }
        windowElement = AXTreeWalker.focusedWindow(of: AXElement.application(pid: app.pid))
        return latest
    }

    /// The smallest node whose frame contains a screen point.
    ///
    /// Used to answer "where did that click land?" when a coordinate click
    /// changed nothing. That answer is what separates "the click missed" from
    /// "the click landed on an opaque region I cannot see inside": the model
    /// gets the control it actually hit instead of a bare "no change".
    public func smallestNode(containing point: CGPoint) -> AXNode? {
        snapshot?.smallestNode(containing: point)
    }

    public func element(at index: Int) throws -> AXElement {
        guard let element = elementTable[index] else {
            throw ElementActions.ActionError.staleIndex(index)
        }
        return element
    }

    public func node(at index: Int) throws -> AXNode {
        guard let node = snapshot?.node(index: index) else {
            throw ElementActions.ActionError.staleIndex(index)
        }
        return node
    }

    /// The coordinate mapper to use after a tree walk that took no screenshot.
    ///
    /// A capture knows its own scale and sets the coordinate mapper itself. A
    /// walk alone does not, so it must keep the scale the model is already
    /// working in: the pixels it reports come from the last screenshot it was
    /// shown, and resetting to 1.0 would silently move every later click by a
    /// few tens of points. The window frame is updated regardless, since the
    /// window may have moved. With no mapper yet, 1.0 is the honest fallback —
    /// pixels then equal points inside the window.
    static func mapperAfterTreeWalk(
        existing: CoordinateMapper?,
        windowFrame: CGRect
    ) -> CoordinateMapper {
        CoordinateMapper(windowFrame: windowFrame, scale: existing?.scale ?? 1)
    }

    /// Screen point at the centre of an element, if it has a frame.
    ///
    /// The centre is clamped to the visible part of the window. A scrollable
    /// container reports the full content size — a chat list can be 3592 pt
    /// tall inside an 855 pt window — so its true centre is thousands of points
    /// below the screen. Aiming there clicks whatever happens to be at that
    /// coordinate, or nothing at all, and the model reads the resulting
    /// no-change as "the click missed" rather than "the target was off-screen".
    public func centre(of index: Int) throws -> CGPoint {
        let node = try node(at: index)
        guard let frame = node.frame, frame.width > 0, frame.height > 0 else {
            throw ElementActions.ActionError.unsupported(
                "element \(index) has no on-screen frame; use its accessibility action instead")
        }
        let target = Self.visibleCentre(of: frame, within: snapshot?.windowFrame)
        guard let target else {
            throw ElementActions.ActionError.unsupported(
                "element \(index) is entirely off-screen; use its accessibility action,"
                    + " or scroll it into view first")
        }
        return target
    }

    /// The part of an element's centre that is actually reachable.
    ///
    /// Returns nil when the element lies wholly outside the window, which is
    /// the honest answer for a row scrolled far out of view. Pure, so the
    /// clamping can be tested without a live app.
    static func visibleCentre(of frame: CGRect, within windowFrame: CGRect?) -> CGPoint? {
        var visible = frame
        if let windowFrame {
            visible = visible.intersection(windowFrame)
        }
        guard !visible.isNull, visible.width > 0, visible.height > 0 else { return nil }
        return CGPoint(x: visible.midX, y: visible.midY)
    }

    public var pid: pid_t { app.pid }
}
