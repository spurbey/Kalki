# Kalki

Kalki is a single-user agentic research workbook built on the TrueForge harness. It turns a natural-language task into reviewed schemas, sandboxed source operators, a bounded test run, explicit production consent, durable workbook tables, and reusable workflow artifacts.

The repository is being built specification-first for the TrueForge Agent Harness Hackathon. The architecture is settled; implementation is entering the reviewed pull-request phase.

## Core Constraints

- TrueForge remains an external dependency pinned to commit `a3a13956e99c2f90cca37b48c324812ad03b493a`.
- Agent-authored code runs in Daytona and never assumes a fixed workspace root.
- Test rows never enter formal workbook tables.
- Production requires an explicit `ask_user_question` answer matching current task, schema, and pipeline hashes.
- Full records stay in sandbox files; model and tool responses use compact manifests.
- Substantive changes go through Qodo-reviewed pull requests before merge.

## Development Status

Implementation is in progress and will land through reviewed pull requests. Shared contracts and the control-plane foundation come first, followed by the sandbox runtime, web application, bootstrap scripts, and end-to-end acceptance coverage.

## Pull Request Workflow

1. Branch from `main`.
2. Keep one coherent change in each commit and stage only related files or hunks.
3. Open a pull request and wait for Qodo review.
4. Fix valid High-severity findings or explain why a finding is intentionally dismissed.
5. Run `/agentic_review` after the final push, then merge manually.

## Qodo Code Review Evidence

Representative reviewed PR: pending the first substantive Qodo-reviewed merge.

This section will link that public pull request and record what Qodo surfaced, what changed, and any finding intentionally dismissed before hackathon submission.
