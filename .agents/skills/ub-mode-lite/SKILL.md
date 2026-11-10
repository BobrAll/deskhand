---
name: ub-mode-lite
description: Apply the standing engineering rules before every code change in this repository, including bug fixes, features, tests, and refactoring.
---

# UB Mode Lite

A compact set of engineering principles inspired by Uncle Bob, Clean Code, and pragmatic software craftsmanship.

**Core philosophy: Write understandable code, solve real problems, and prove that the result works.**

## 1. Understand Before Changing

- Understand the problem and inspect the existing implementation.
- Trace the actual execution path.
- Verify assumptions and respect the existing architecture and conventions.

## 2. Strive for Clarity and Simplicity

- Prefer clarity over cleverness.
- Avoid unnecessary abstractions, layers, dependencies, and complexity.
- Do not solve hypothetical future problems.
- If the code is already clear and works, leave it alone.

## 3. Write Clean Code

- Use meaningful, intention-revealing names.
- Keep functions focused, with clear responsibilities.
- Reduce duplication without introducing unnecessary abstractions.
- Make dependencies and side effects explicit.
- Prefer strong typing and clear domain models over implicit assumptions.
- Optimize for readability and maintainability.

## 4. Make It Work, Then Make It Right

- First establish correct behavior, then improve the design.
- Use TDD when appropriate: failing test → implementation → refactoring.
- Fix root causes rather than masking symptoms.
- Refactor incrementally while preserving existing behavior.

## 5. Minimize Comments

- Prefer clear code and meaningful names over comments.
- Do not comment on obvious behavior or use comments as a substitute for good code.
- Add comments only to explain non-obvious decisions, business constraints, architectural invariants, side effects, and complex algorithms.
- Keep comments accurate and remove outdated ones.
- Treat comments as additional context, not unquestionable truth.

**Code explains WHAT happens. Comments explain WHY something non-obvious exists.**

## 6. Respect Change Boundaries

- Make the changes necessary to solve the task.
- Preserve existing behavior unless explicitly required to change it.
- Never damage or overwrite unrelated user changes.
- Avoid modifying unrelated code without a reason.

## 7. Verify the Result

- Test behavior, not implementation details.
- Add or update tests for meaningful changes.
- Run relevant tests and checks.
- Consider edge cases and potential regressions.
- Never weaken tests or suppress errors just to make them pass.
- Never claim checks were performed if they were not.
- Report anything that remains unverified and any known limitations.
