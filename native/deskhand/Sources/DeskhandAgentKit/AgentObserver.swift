import Foundation
import DeskhandCore
import DeskhandLLM

/// What happened during a run, as it happens.
///
/// The loop is usable without one — the command-line tool prints to stderr and
/// the answer — but a window needs more: which step is running, what the model
/// said it was doing, and what each tool answered. Every method has a default
/// implementation so a host only overrides what it draws.
public protocol AgentObserver: AnyObject, Sendable {
    /// A model turn is about to start.
    func stepStarted(_ step: Int, of total: Int)
    /// The model answered: `narration` is its caption, `calls` what it wants to run.
    func stepAnswered(_ step: Int, narration: String, calls: [ToolCall])
    /// One tool call is about to run.
    func toolStarted(_ step: Int, call: ToolCall, narration: String)
    /// One tool call finished. `text` is what the model will see.
    func toolFinished(_ step: Int, call: ToolCall, text: String, isError: Bool)
    /// The loop stopped for a reason other than success.
    func loopStopped(_ reason: String)
}

public extension AgentObserver {
    func stepStarted(_ step: Int, of total: Int) {}
    func stepAnswered(_ step: Int, narration: String, calls: [ToolCall]) {}
    func toolStarted(_ step: Int, call: ToolCall, narration: String) {}
    func toolFinished(_ step: Int, call: ToolCall, text: String, isError: Bool) {}
    func loopStopped(_ reason: String) {}
}
