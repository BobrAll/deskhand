import Foundation

/// Wall-clock instrumentation for one agent run.
///
/// The loop is dominated by three very different costs: model round trips,
/// accessibility walks and window captures. A single "step took 3 s" number
/// cannot tell them apart, so every phase records its own sample and the run
/// ends with a grouped report.
public final class Timings: @unchecked Sendable {
    public struct Sample: Sendable {
        public let label: String
        public let milliseconds: Double
        public let bytes: Int?
    }

    private let lock = NSLock()
    private var samples: [Sample] = []

    public init() {}

    public func record(_ label: String, milliseconds: Double, bytes: Int? = nil) {
        lock.lock()
        samples.append(Sample(label: label, milliseconds: milliseconds, bytes: bytes))
        lock.unlock()
    }

    public func snapshot() -> [Sample] {
        lock.lock()
        defer { lock.unlock() }
        return samples
    }

    public var totalMilliseconds: Double {
        snapshot().reduce(0) { $0 + $1.milliseconds }
    }

    /// Groups samples by label, preserving first-seen order.
    public func grouped() -> [(label: String, count: Int, total: Double, max: Double, bytes: Int?)] {
        var order: [String] = []
        var counts: [String: Int] = [:]
        var totals: [String: Double] = [:]
        var maxima: [String: Double] = [:]
        var byteTotals: [String: Int] = [:]
        var byteCounts: [String: Int] = [:]

        for sample in snapshot() {
            if counts[sample.label] == nil { order.append(sample.label) }
            counts[sample.label, default: 0] += 1
            totals[sample.label, default: 0] += sample.milliseconds
            maxima[sample.label] = max(maxima[sample.label] ?? 0, sample.milliseconds)
            if let bytes = sample.bytes {
                byteTotals[sample.label, default: 0] += bytes
                byteCounts[sample.label, default: 0] += 1
            }
        }

        return order.map { label in
            let avgBytes = byteCounts[label].map { byteTotals[label]! / $0 }
            return (label, counts[label] ?? 0, totals[label] ?? 0, maxima[label] ?? 0, avgBytes)
        }
    }

    /// A compact table, meant for stderr at the end of a run.
    public func report() -> String {
        let rows = grouped()
        guard !rows.isEmpty else { return "no timing samples recorded" }

        var lines: [String] = []
        let widest = rows.map(\.label.count).max() ?? 0
        lines.append("timings (total \(TimingFormat.duration(totalMilliseconds)))")
        for row in rows {
            var line = "  " + row.label.padding(toLength: max(widest, 4), withPad: " ", startingAt: 0)
            line += "  " + String(row.count).leftPadded(3) + "×"
            // A row that only carries sizes (the screenshot payload) has no
            // meaningful duration; printing "<1 ms" there would be noise.
            if row.total > 0 {
                line += "  " + TimingFormat.duration(row.total).leftPadded(9)
                if row.count > 1 {
                    line += "  avg " + TimingFormat.duration(row.total / Double(row.count))
                    line += "  max " + TimingFormat.duration(row.max)
                }
            }
            if let bytes = row.bytes {
                line += "  ~" + TimingFormat.bytes(bytes)
            }
            lines.append(line)
        }
        if let verdict = bottleneck() {
            lines.append("")
            lines.append(verdict)
        }
        return lines.joined(separator: "\n")
    }

    /// One sentence naming what actually dominated the run.
    ///
    /// A table of numbers still leaves the reader to do the division. The whole
    /// point of measuring is to know which fix is worth making, so say it: a
    /// loop dominated by `llm` is fixed by batching and shorter prompts, one
    /// dominated by `tree` or `screenshot` is fixed in the tool layer, and no
    /// prompt change touches those.
    public func bottleneck() -> String? {
        // Phase rows are already counted inside their tool, and `run total`
        // contains everything, so both would double-count here.
        let rows = grouped().filter {
            $0.total > 0
                && !$0.label.hasPrefix(TimingLabel.phasePrefix)
                && $0.label != TimingLabel.runTotal
        }
        guard rows.count >= 2 else { return nil }
        let total = rows.reduce(0) { $0 + $1.total }
        guard total > 0, let worst = rows.max(by: { $0.total < $1.total }) else { return nil }
        let share = Int((worst.total / total * 100).rounded())
        guard share >= 40 else { return nil }

        let advice: String
        switch worst.label {
        case TimingLabel.model:
            advice = "the model round trips dominate — batch more actions per answer and keep the prompt small"
        case TimingLabel.tool("get_app_state"):
            advice = "reading state dominates — rely on the post-action diff instead of re-reading"
        default:
            if worst.label.hasPrefix(TimingLabel.toolPrefix) {
                advice = "one tool dominates — look at its tree walk or capture in the breakdown above"
            } else {
                advice = "this phase dominates the run"
            }
        }
        return "bottleneck: \(worst.label) \(share)% of measured time — \(advice)"
    }
}

/// The label vocabulary the run loop records and the report reads back.
///
/// The two sides live in different files — and, for the producers, in a
/// different module — so the strings are named once here rather than spelled
/// out in each of them. `bottleneck()` recognises a row by these exact
/// prefixes, so a producer that invents a spelling silently drops out of the
/// verdict.
public enum TimingLabel {
    /// Model round trips.
    public static let model = "llm"
    /// The whole run. It contains everything else, so it is not a bottleneck.
    public static let runTotal = "run total"
    /// Prefix of a whole tool call: `tool <name>`.
    public static let toolPrefix = "tool "
    /// Prefix of a phase row inside a tool, e.g. `  tree walk`. The row is
    /// already counted inside that tool's total.
    public static let phasePrefix = "  "

    /// Accessibility tree walk inside a tool call.
    public static let treeWalk = phasePrefix + "tree walk"
    /// Window capture inside a tool call.
    public static let screenshot = phasePrefix + "screenshot"
    /// Encoding of the captured image inside a tool call.
    public static let imageEncode = phasePrefix + "image encode"
    /// Size of the image handed to the model. A size row, not a duration.
    public static let screenshotBytes = phasePrefix + "screenshot bytes"

    /// The row for one whole tool call.
    public static func tool(_ name: String) -> String {
        toolPrefix + name
    }
}

/// Where a single tool call spent its time.
///
/// The split matters because the phases have completely different fixes:
/// `tree` is accessibility IPC, `capture` is ScreenCaptureKit, `encode` is
/// image compression. In a single "tool took 1.9 s" number they are
/// indistinguishable — and on this machine the 1.9 s is almost entirely one of
/// them.
public struct ToolTimings: Sendable, Equatable {
    /// Total wall time of the tool call.
    public var wall: Double
    /// Accessibility tree walk.
    public var tree: Double
    /// Window capture (ScreenCaptureKit).
    public var capture: Double
    /// Encoding of the captured image.
    public var encode: Double
    /// Size of the encoded image handed to the model, before base64.
    public var screenshotBytes: Int

    public init(
        wall: Double = 0,
        tree: Double = 0,
        capture: Double = 0,
        encode: Double = 0,
        screenshotBytes: Int = 0
    ) {
        self.wall = wall
        self.tree = tree
        self.capture = capture
        self.encode = encode
        self.screenshotBytes = screenshotBytes
    }

    /// "tree 120 ms, capture 340 ms, 148 kB" — only the phases that ran.
    public func describe() -> String {
        var parts: [String] = []
        if tree > 0 { parts.append("tree \(TimingFormat.duration(tree))") }
        if capture > 0 { parts.append("capture \(TimingFormat.duration(capture))") }
        if encode > 0 { parts.append("encode \(TimingFormat.duration(encode))") }
        if screenshotBytes > 0 { parts.append(TimingFormat.bytes(screenshotBytes)) }
        return parts.joined(separator: ", ")
    }
}

/// A monotonic stopwatch. `ProcessInfo.systemUptime` is immune to wall-clock
/// changes, unlike `Date()`.
public struct TimingClock: Sendable {
    private let start: TimeInterval

    public init() {
        self.start = ProcessInfo.processInfo.systemUptime
    }

    public var milliseconds: Double {
        (ProcessInfo.processInfo.systemUptime - start) * 1000
    }
}

public enum TimingFormat {
    public static func duration(_ milliseconds: Double) -> String {
        if milliseconds < 1 { return "<1 ms" }
        if milliseconds < 1000 { return "\(Int(milliseconds.rounded())) ms" }
        return String(format: "%.2f s", milliseconds / 1000)
    }

    public static func bytes(_ count: Int) -> String {
        if count < 1024 { return "\(count) B" }
        if count < 1024 * 1024 { return String(format: "%.1f kB", Double(count) / 1024) }
        return String(format: "%.1f MB", Double(count) / (1024 * 1024))
    }
}

extension String {
    func leftPadded(_ width: Int) -> String {
        count >= width ? self : String(repeating: " ", count: width - count) + self
    }
}
