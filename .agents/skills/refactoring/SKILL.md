---
name: refactoring
description: Improve existing code structure while preserving behavior. Use only when the user explicitly requests a refactor or invokes this skill.
disable-model-invocation: true
---

# Refactoring

A disciplined approach to improving existing code structure without changing its behavior.

**Core principle: Change the structure, not the behavior.**

## 1. Understand

- Understand the code's purpose, behavior, dependencies, and execution paths.
- Identify actual structural problems worth solving.
- Inspect existing tests and identify gaps in behavioral coverage.

## 2. Protect Behavior

- Treat existing behavior as a contract.
- Use existing tests as a safety net.
- Add characterization tests when important behavior is insufficiently covered.
- Preserve public APIs, interfaces, data formats, error handling, side effects, and integration contracts.
- Do not silently change business rules or introduce new functionality.

## 3. Refactor Incrementally

- Make small, focused changes, addressing one structural concern at a time.
- Prefer incremental transformations over large rewrites.
- Introduce, remove, or reorganize abstractions only when they improve the design.
- Preserve unrelated user changes.
- Keep changes easy to review and reverse.

## 4. Verify

- Run relevant tests after meaningful changes.
- Run the full relevant test suite when refactoring is complete.
- Run other relevant project checks when available.
- Review the final diff for unintended behavioral changes.
- Never claim verification that was not performed.
- Report failures, limitations, and unverified behavior.

## Definition of Done

- The intended structural improvements are achieved.
- Existing externally observable behavior is preserved.
- Relevant checks pass, or remaining risks are explicitly reported.
- The resulting code is easier to understand or maintain.

**Final Rule: Improve the structure. Preserve the behavior. Verify the result.**
