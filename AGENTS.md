# Smart Cursor

## Agent changes

- Fix the capability or the decision rule behind a failed run. Use individual apps, sites, and prompts as regression cases. Keep their names and aliases out of runtime routing and prompts that define tool behavior.
- Choose tools by the requested outcome. Use web search for public information, browser navigation for an explicitly requested destination, and screen input for interaction with an observed interface.
- Treat a change of active app as a new observation boundary. Check which app received input and verify the result on a fresh screen before continuing.
- Record timings and tool decisions without recording queries, typed content, or screenshots.

## The agent is a separate process, and it is the only one that acts

`native/deskhand` is a vendored Swift package. `deskhand-agent --serve` is a
sidecar that the main process spawns on the first action request and keeps
alive; the two speak newline-delimited JSON over stdin/stdout.

The split is not a matter of taste:

- **Swift owns everything that touches the machine** — the accessibility tree,
  ScreenCaptureKit, CGEvent, and the agent loop. It is the part that was measured
  to be fast and accurate, and rewriting it in TypeScript would be a rewrite of
  the thing that works.
- **TypeScript owns everything that touches the user** — the card, the wording,
  the settings, the keys, and the decision to ask before an action. A question
  about sending money is a judgement about a person, not a fact about a window,
  so it lives next to the settings rather than inside the agent.

Consequences worth knowing before changing either side:

- The sidecar is spawned lazily and never at launch. It inherits the app's
  Accessibility and Screen Recording grants by descent, so a missing grant is a
  property of the app, not of the binary.
- `ToolPolicy` is the seam. The agent asks before every mutating call and blocks;
  `src/main/agent/approval.ts` answers most of them with "да" without troubling
  the user. Moving that decision into Swift would make it unchangeable without a
  rebuild, and moving it into a model call would make every click cost a round
  trip.
- `ActionPresenter` is the *visual* half of the same seam. It is installed only
  when the host asked for it (`options.visualize`), receives geometry after the
  approval and before the tool runs, and must return immediately — the action
  never waits for a window to be raised or a pointer to travel. A background run
  is the same run with no presenter, not a second code path, so nothing in the
  tools may assume a picture exists.
- The protocol is a contract between two languages. `src/main/agent/sidecar.test.ts`
  replays a transcript recorded from the real binary; if a field is renamed on
  one side, that test is what notices.
- `SyntheticEvent.tag` (`0x53434752`) must stay equal to `kAgentEventTag` in
  `src/main/native/helper.m`. If they drift, the agent's own clicks abort the run
  as if the user had grabbed the mouse.
- The card is click-through while the agent acts. Escape is the stop, and the
  inline approval is the only thing that takes the mouse back.

Build the binary with `npm run build:agent` (universal; `AGENT_ARCH=arm64` for
just this Mac). The tests are `npm test` here and `swift test` in
`native/deskhand`; both must pass, because neither covers the other's half.
