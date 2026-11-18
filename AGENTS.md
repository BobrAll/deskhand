# Deskhand

## Skills

- [Clean Code](.agents/skills/clean-code/SKILL.md) is always active: read and follow it before every code change.
- Read and follow [Refactoring](.agents/skills/refactoring/SKILL.md) only when the user asks for a refactor or invokes it by name.
- Read and follow [Bug and Issue Detection](.agents/skills/bug-and-issue-detection/SKILL.md) only when the user asks to find bugs, audit code, or invokes it by name.
- Read and follow [UX Research](.agents/skills/ux-research/SKILL.md) only when the user asks to run UX research or a UX review, or invokes it by name.

## Git Worktree Isolation

- Each independent task MUST use its own Git worktree, branch, and agent session.
- Before editing, create a worktree with a new branch and move the session into it.
- The worktree tool leaves the checkout on a detached HEAD: `worktree_create` returns a directory, not a branch, and `npm run worktree` then lists a commit hash instead of a name. Create the branch immediately — `git checkout -b <task-slug>` — before the first edit and before the first commit.
- Name the branch after the task itself, in kebab-case: `auto-update`, `voice-warmup`, `settings-search`. The name must say what the work is about; a tool-generated name (`glowing-planet`, `shiny-rocket`) is not one, and neither is the task number alone.
- Reuse the existing worktree when continuing the same task.
- Never edit files outside the task's worktree or share a working directory with another coding agent.
- If isolation fails, stop before editing.
- Commit completed changes to the task branch.
- Once the user confirms the task is finished, offer a code review by a separate subagent.
- Propose merging into `dev`. Never merge without explicit user approval.
- After a successful merge into `dev`, delete the task branch and remove its worktree immediately — the approval to merge covers the cleanup, so do not ask again.
- Never delete a worktree whose branch is not merged into `dev`.
- Mechanically: `tools.opencode.worktree_create` for the worktree, `git checkout -b <task-slug>` for its branch, and `tools.opencode.session_move` to move the session into it. If those tools are unavailable, ask before touching files.

## Copy and tone

- Every user-facing Russian string addresses the user as «ты»: «нажми», «попробуй ещё раз», «твой ключ». No «вы» forms in UI text, errors, approvals, notifications or recorded voice lines.
- Imperative mood over polite formulas: «Проверь ключ» instead of «Пожалуйста, проверьте ключ». No «пожалуйста», no «извините», no diminutives.
- Voice lines follow [docs/voice-phrases.md](docs/voice-phrases.md); that document is the source of truth for what may be spoken. When a card string is also spoken, both must already be on «ты».
- Text the model reads (tool results, prompts) is English and unaffected by this rule.
- The rule is enforced: `src/shared/copyTone.test.ts` scans `src/` for polite forms and fails the suite.

## Agent behavior

- Fix the underlying capability or decision rule. Use specific apps, sites, and prompts as regression cases. Keep names and aliases out of runtime routing and tool instructions.
- Use web search for public information, browser navigation for an explicitly requested destination, and screen input for an observed interface.
- After the active app changes, confirm which app received input and verify the result on a fresh screen before continuing.
- Log timings and tool decisions. The aggregate trace (`agent-trace.jsonl`) excludes queries, typed content and screenshots; the per-run trace (`agent-runs/`, `agent-dialogs/`) is opt-in, off by default, keeps the exact request bodies on purpose, so it is gitignored and never shared.

## Sidecar contracts

- Swift (`native/deskhand`) owns the agent loop and machine interaction. TypeScript owns UI, settings, keys, and approval decisions.
- Spawn `deskhand-agent --serve` on the first action request and reuse it. It inherits Accessibility and Screen Recording grants from the app.
- Use newline-delimited JSON over stdin/stdout. Keep both sides compatible with the real transcript replayed by `src/main/agent/sidecar.test.ts`.
- The policy lives in Swift: the `ToolPolicy` protocol in `native/deskhand/Sources/DeskhandCore/ToolPolicy.swift` blocks before each mutating call and waits for an answer. TypeScript only answers that question — keep the decision in `src/main/agent/approval.ts`.
- Install `ActionPresenter` only with `options.visualize`. Pass geometry after approval and before execution. Return immediately. Background runs use the same tool path without a presenter.
- Keep `SyntheticEvent.tag` (`0x53434752`) equal to `kAgentEventTag` in `src/main/native/helper.m` so synthetic input does not abort the run.
- Keep the card click-through during actions. Escape stops the run. Only inline approval captures clicks.

## Formatting and lint

- `npm run check` is the gate before a commit: types, ESLint, Prettier, both test suites and Swift style. CI runs the same checks except the Swift style comparison.
- `npm run format` rewrites every file Prettier owns — TypeScript, scripts, JSON, CSS, HTML, Markdown, YAML — and Swift. `npm run format:check` only reports, and that is what the gate uses.
- ESLint is where the bug-finding rules live: `react-hooks` catches a missed dependency and a conditional hook, `no-floating-promises` and `no-misused-promises` catch a promise nobody reads. Fix the call instead of silencing the rule; when dropping a promise is the intent, write `void`.
- `npm run prepare` points `core.hooksPath` at `.githooks/`, so `npm install` enables a pre-commit hook that formats staged files and lints staged `src/**/*.{ts,tsx}`. A file that still has unstaged edits is skipped: staging it whole would pull those edits into the commit. The hook is a convenience; the gate is `npm run check`.
- The one-time style migration is listed in `.git-blame-ignore-revs`. Make `git blame` skip it once per clone: `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

## Build and test

- Build the sidecar with `npm run build:agent` (universal) or `AGENT_ARCH=arm64 npm run build:agent`.
- Both suites must pass for code changes. Run `npm run check`, or `npm test` and `npm run test:swift` separately.
- `src/main/agent/timing.integration.test.ts` and `trace.integration.test.ts` need a built binary and the Accessibility grant. Without either they are reported as _skipped_, not failed: `agentAcceptsRuns` in `src/main/agent/grant.ts` sends one `run` to the real sidecar and reads the answer, and a refusal (`code: "accessibility"`) or a timeout turns both files into `describe.skipIf`. The wire contract still has `src/main/agent/sidecar.test.ts`, which replays a recorded transcript and needs neither.
