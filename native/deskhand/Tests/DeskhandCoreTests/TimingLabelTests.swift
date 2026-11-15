import XCTest

@testable import DeskhandCore

/// The timing labels are a contract between the producer in `AgentLoop` and the
/// report in `Timings`: `bottleneck()` recognises a row by its exact spelling.
final class TimingLabelTests: XCTestCase {
    func testTheSpellingsTheReportRecognises() {
        XCTAssertEqual(TimingLabel.model, "llm")
        XCTAssertEqual(TimingLabel.runTotal, "run total")
        XCTAssertEqual(TimingLabel.tool("click"), "tool click")
        XCTAssertEqual(TimingLabel.treeWalk, "  tree walk")
        XCTAssertEqual(TimingLabel.screenshot, "  screenshot")
        XCTAssertEqual(TimingLabel.imageEncode, "  image encode")
        XCTAssertEqual(TimingLabel.screenshotBytes, "  screenshot bytes")
    }

    func testAPhaseRowIsNotABottleneckCandidate() {
        // A phase is already counted inside the tool row that contains it. If
        // the phase prefix stopped matching, this row would be weighed twice
        // and would be the only candidate left.
        let timings = Timings()
        timings.record(TimingLabel.treeWalk, milliseconds: 1000)
        timings.record(TimingLabel.model, milliseconds: 10)

        XCTAssertNil(timings.bottleneck())
    }

    func testTheToolRowWinsOverItsOwnPhases() {
        let timings = Timings()
        timings.record(TimingLabel.tool("click"), milliseconds: 200)
        timings.record(TimingLabel.treeWalk, milliseconds: 900)
        timings.record(TimingLabel.model, milliseconds: 100)

        let verdict = timings.bottleneck()
        XCTAssertTrue(
            verdict?.hasPrefix("bottleneck: \(TimingLabel.tool("click"))") == true,
            "expected the tool row to win, got \(verdict ?? "nil")"
        )
    }

    func testTheRunTotalIsNotABottleneckCandidate() {
        let timings = Timings()
        timings.record(TimingLabel.runTotal, milliseconds: 5000)
        timings.record(TimingLabel.model, milliseconds: 100)
        timings.record(TimingLabel.tool("click"), milliseconds: 100)

        XCTAssertEqual(timings.bottleneck()?.hasPrefix("bottleneck: \(TimingLabel.model)"), true)
    }
}
