---
name: ux-research
description: Research the interface, identify real usability issues, and propose improvements backed by interactive before/after mockups. Use only when the user explicitly asks for UX research or a UX review, and never for feature work, bug fixes, or refactoring.
---

# UX Research

A structured way to find real usability problems in the product and show concrete fixes.

**Core principle: Show the problem and the fix, not a list of opinions.**

## 1. Study the Interface

- Inspect the actual UI, user flows, and the existing design system (components, tokens, spacing, typography, copy tone).
- Walk the flows the way a user would, including empty, loading, error, and success states.
- Read the existing code and copy to learn what the interface really does.
- Check what the user asked for: a whole-product review or one specific flow.

## 2. Identify Real Issues

Look for friction, not taste:

- Friction: steps, clicks, and decisions that could be removed.
- Clutter: competing elements, redundant copy, and visual noise.
- Inconsistency: patterns, labels, spacing, and states that differ without a reason.
- Unclear interactions: ambiguous actions, missing feedback, and invisible next steps.
- Accessibility: contrast, target size, focus, keyboard paths, and readable labels.
- Edge cases: empty, long, or broken states the design ignores.

Do not invent problems. Every finding needs a concrete place in the product and a concrete consequence for the user.

## 3. Propose Fixes

- Tie each proposal to a UX principle or a well-known practice.
- Prefer the smallest change that removes the friction.
- Keep proposals consistent with the project's design system and copy tone.
- Drop weak findings instead of padding the list.
- Change nothing in the real interface until the user approves.

## 4. Build One Interactive Report

Create a single HTML file inside the project (a temporary path, not shipped code):

- One card per proposal with a title and a "Before → After" comparison built from visual mockups, not text descriptions.
- Mockups must reproduce the current and proposed interfaces accurately: same components, spacing, typography, and copy. Reuse the project's real styles where possible.
- Keep details and rationale hidden by default, revealed by a button.
- Keep the visual language minimal and modern, consistent with the project's style.
- Make it work offline in a browser with no build step.

## 5. Present Findings

- Open the report and summarize the proposals briefly, most impactful first.
- For each: what is wrong, for whom, and what changes.
- Skip deep implementation details unless asked.

## 6. Clean Up

- After the discussion is finished, delete the temporary HTML file and any assets created for it.
- Leave the interface untouched unless the user approved specific changes.

## Definition of Done

- Findings are grounded in the real interface, not in assumptions.
- Every proposal has an accurate before/after mockup.
- The report is a single self-contained HTML file.
- Temporary files are removed once the discussion ends.

**Final Rule: Find real friction. Show the fix. Change nothing without approval.**
