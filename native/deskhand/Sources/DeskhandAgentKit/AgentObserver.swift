import Foundation
import DeskhandCore
import DeskhandLLM

/// What happened during a run, as it happens.
///
/// The loop is usable without one — the command-line tool prints to stderr and
/// the answer — but a window needs more: which step is running, what the model
/// said it was doing, and what each tool answered. Every method has a default
/// implementation so a host only overrides what it draws.
///
/// The timings carried by these calls are the loop's own measurements, passed
/// through rather than re-derived. A host that re-timed a step around these
/// callbacks would be measuring its own pipe, not the work.
public protocol AgentObserver: AnyObject, Sendable {
    /// A model turn is about to start.
    func stepStarted(_ step: Int, of total: Int)
    /// The model's prose so far, while the turn is still running.
    ///
    /// The text is the whole prefix, not a delta: a host can replace its caption
    /// without keeping a buffer of its own, and a dropped callback costs a word
    /// rather than the sentence.
    func stepStreamed(_ step: Int, text: String)
    /// The model answered: `narration` is its caption, `calls` what it wants to run.
    func stepAnswered(_ step: Int, narration: String, calls: [ToolCall])
    /// What the round trip cost, once per step, whether or not it had anything to say.
    ///
    /// Separate from `stepAnswered` because a step with no narration is still a
    /// step the user waited through, and a timeline that only records the talkative
    /// ones is a timeline with holes in it.
    func stepTimed(_ step: Int, timing: StepTiming)
    /// One tool call is about to run.
    func toolStarted(_ step: Int, call: ToolCall, narration: String)
    /// One tool call finished. `text` is what the model will see.
    ///
    /// `timings` splits the call into the phases that have different fixes: the
    /// accessibility walk, the window capture and the PNG encode.
    func toolFinished(_ step: Int, call: ToolCall, text: String, isError: Bool, timings: ToolTimings)
    /// The loop stopped for a reason other than success.
    ///
    /// Only ever emitted when the run actually ends: a host can treat it as a
    /// verdict.
    func loopStopped(_ reason: String)
    /// The loop guard fired, but the run continues.
    ///
    /// A separate event from `loopStopped` because it is not a stop. Folding the
    /// two together — which is what this used to be — made a run that warned and
    /// then finished look abandoned, and the host had no way to tell.
    func loopWarned(_ reason: String)
    /// The run is over. `report` is the same table the CLI prints to stderr.
    func runFinished(_ report: RunReport)
}

/// What one model round trip cost, and what it was asked with.
///
/// The history size is here because it is the number that explains a slow step
/// better than the duration does: a 4-second round trip on a 3-message history
/// is the network; the same 4 seconds on a 40-message one is the prompt.
public struct StepTiming: Sendable, Equatable {
    /// Wall time of the provider call.
    public var llmMilliseconds: Double
    /// Bytes of prompt text sent, after history trimming.
    public var promptBytes: Int
    /// How many messages survived trimming.
    public var historyMessages: Int
    /// Tokens the provider reported, when it reported any.
    public var inputTokens: Int?
    public var outputTokens: Int?
    /// Tool calls the model asked for in this answer.
    public var callCount: Int

    public init(
        llmMilliseconds: Double,
        promptBytes: Int,
        historyMessages: Int,
        callCount: Int = 0,
        inputTokens: Int? = nil,
        outputTokens: Int? = nil
    ) {
        self.llmMilliseconds = llmMilliseconds
        self.promptBytes = promptBytes
        self.historyMessages = historyMessages
        self.callCount = callCount
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }
}

/// The run's totals, for the host to record once.
public struct RunReport: Sendable {
    public var steps: Int
    public var calls: Int
    public var failedCalls: Int
    /// Total wall time of the loop, model time included.
    public var totalMilliseconds: Double
    /// Time spent waiting on the model, summed over steps.
    public var llmMilliseconds: Double
    /// Time spent inside tool calls, summed.
    public var toolMilliseconds: Double
    /// The grouped table, for a log line or a diagnostics panel.
    public var table: String

    public init(
        steps: Int,
        calls: Int,
        failedCalls: Int,
        totalMilliseconds: Double,
        llmMilliseconds: Double,
        toolMilliseconds: Double,
        table: String
    ) {
        self.steps = steps
        self.calls = calls
        self.failedCalls = failedCalls
        self.totalMilliseconds = totalMilliseconds
        self.llmMilliseconds = llmMilliseconds
        self.toolMilliseconds = toolMilliseconds
        self.table = table
    }
}

public extension AgentObserver {
    func stepStarted(_ step: Int, of total: Int) {}
    func stepStreamed(_ step: Int, text: String) {}
    func stepAnswered(_ step: Int, narration: String, calls: [ToolCall]) {}
    func stepTimed(_ step: Int, timing: StepTiming) {}
    func toolStarted(_ step: Int, call: ToolCall, narration: String) {}
    func toolFinished(_ step: Int, call: ToolCall, text: String, isError: Bool, timings: ToolTimings) {}
    func loopStopped(_ reason: String) {}
    func loopWarned(_ reason: String) {}
    func runFinished(_ report: RunReport) {}
}
