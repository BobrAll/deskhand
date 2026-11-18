---
name: bug-and-issue-detection
description: Identify bugs, logical errors, vulnerabilities, and potential issues in code. Use for code audits and targeted problem detection.
---

# Bug and issue Detection

Core principle: Find real defects, not reasons to change code.

## 1. Understand the Context

- Understand the code's purpose and expected behavior.
- Inspect related files, dependencies, types, configuration, and tests.
- Trace relevant execution paths and component interactions.
- Do not draw conclusions from isolated code fragments.

## 2. Look for Issues

Check applicable categories:

- Logic: Incorrect conditions, calculations, states, and business rules.
- Data: Data loss, corruption, and improper data handling.
- Runtime: Exceptions, unhandled errors, and failures.
- Edge cases: Empty values, null, undefined, and unusual inputs.
- Concurrency: Race conditions, synchronization issues, and operation lifecycle problems.
- Integrations: API incompatibilities, contract violations, and component interaction issues.
- Security: Authorization bypasses, data leaks, and vulnerabilities.
- Performance: Unnecessary computations, queries, and resource leaks.

## 3. Validate Suspicions

- Trace the cause of each suspected issue and its potential consequences.
- Inspect related calls, dependencies, and usages.
- Use tests, logs, and available analysis tools.
- Reproduce issues when possible.
- Distinguish confirmed defects from potential risks.

## 4. Report Findings

For each issue, provide:

- Severity: Critical, high, medium, or low.
- Location: File and specific lines.
- Description: Explain conceptually what is wrong and why it is a problem.
- Impact: Describe the potential consequences.
- Solution: Suggest how to address it.

By default, explain issues clearly and concisely, without excessive technical details or low-level implementation analysis. Provide additional details upon request.

List the most severe issues first. Exclude duplicates and subjective observations.

## Constraints

- Do not modify files or fix issues without explicit permission.
- Do not execute destructive commands.
- Do not weaken tests or checks.
- Do not invent issues, reproduction scenarios, consequences, or evidence.
- Do not present assumptions as confirmed defects.
- Do not claim to have audited the entire project if only part was examined.
- If no issues are found, state this and explain the limitations of the review.
