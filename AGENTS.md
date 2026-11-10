# Smart Cursor

## Skills

- Before every code change, read and follow [UB Mode Lite](.agents/skills/ub-mode-lite/SKILL.md).
- Read and follow [Refactoring](.agents/skills/refactoring/SKILL.md) only on an explicit refactoring request or invocation by name.

## Agent behavior

- Fix the underlying capability or decision rule. Use specific apps, sites, and prompts as regression cases. Keep names and aliases out of runtime routing and tool instructions.
- Use web search for public information, browser navigation for an explicitly requested destination, and screen input for an observed interface.
- After the active app changes, confirm which app received input and verify the result on a fresh screen before continuing.
- Log timings and tool decisions. Exclude queries, typed content, and screenshots.

## Sidecar contracts

- Swift (`native/deskhand`) owns the agent loop and machine interaction. TypeScript owns UI, settings, keys, and approval decisions.
- Spawn `deskhand-agent --serve` on the first action request and reuse it. It inherits Accessibility and Screen Recording grants from the app.
- Use newline-delimited JSON over stdin/stdout. Keep both sides compatible with the real transcript replayed by `src/main/agent/sidecar.test.ts`.
- `ToolPolicy` blocks before each mutating call until `src/main/agent/approval.ts` answers. Keep the decision in TypeScript.
- Install `ActionPresenter` only with `options.visualize`. Pass geometry after approval and before execution. Return immediately. Background runs use the same tool path without a presenter.
- Keep `SyntheticEvent.tag` (`0x53434752`) equal to `kAgentEventTag` in `src/main/native/helper.m` so synthetic input does not abort the run.
- Keep the card click-through during actions. Escape stops the run. Only inline approval captures clicks.

## Build and test

- Build the sidecar with `npm run build:agent` (universal) or `AGENT_ARCH=arm64 npm run build:agent`.
- Both suites must pass for code changes. Run `npm test` from the root and `swift test` from `native/deskhand`.
