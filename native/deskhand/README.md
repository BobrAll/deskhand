# Deskhand — the agent, vendored

This is the agent that drives the mouse and the keyboard, taken from the standalone
Deskhand package and kept here as part of Smart Cursor. It is the only code in the
repository that touches the accessibility tree, ScreenCaptureKit and CGEvent, and
it is built into `resources/deskhand-agent` by `npm run build:agent`.

**It is not a dependency.** There is no pinned version to update and no upstream to
track: this directory *is* the source, and changes to how the agent works are made
here. The standalone package it came from was a workbench for exactly this — the
speed and accuracy were tuned there and are carried over unchanged.

## Layout

- `DeskhandCore` — the machine: accessibility walking, window capture, synthetic
  input, the tool surface. `ToolPolicy` is the hook the host uses to veto a call.
- `DeskhandLLM` — the two provider wires, OpenAI-compatible and Anthropic.
- `DeskhandAgentKit` — `AgentLoop`, which asks the model, runs its tool calls, and
  feeds the results back.
- `DeskhandAgent` — the executable. Run with `--serve` it becomes the sidecar that
  Smart Cursor talks to over stdin/stdout; without it, it is a CLI.

## The bridge

`Sources/DeskhandAgent/Bridge.swift` is the only file that knows about Smart Cursor.
It reads newline-delimited JSON requests, runs one task at a time, and emits
events. Two things about it are load-bearing:

- **The main thread runs the Cocoa run loop.** `MainRunLoop.await` keeps pumping it
  while a task runs, because `NSRunningApplication.activate` and the accessibility
  calls are main-thread APIs that misbehave (or take a second instead of
  milliseconds) on a parked thread.
- **`SyntheticEvent.tag` must equal `kAgentEventTag` in the host's `helper.m`.**
  The host uses the tag to tell the agent's own clicks from a real hand on the
  mouse; if the two constants drift, every click the agent makes looks like the
  user taking control, and the run aborts itself.

## Building

```sh
cd native/deskhand && swift build -c release --product deskhand-agent
```

or, from the repository root, `npm run build:agent` — which also copies the result
into `resources/` and builds both architectures. `swift test` runs the package's own
tests; they cover the loop's batching, history trimming and loop guard, which the
TypeScript suite cannot see.

Licensed under the MIT license in `LICENSE`.
