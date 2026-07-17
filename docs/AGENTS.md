# Documentation Guidelines

## Purpose

`docs/` records protocol behavior, parity boundaries, and measured validation results for the extension.

## Key Files

- `codex-cli-parity.md`: transport compatibility baseline, latency behavior, and benchmark interpretation.
- `codex-transport-architecture.md`: HTTP/WebSocket lifecycle architecture.

## Constraints

- Distinguish verified behavior from planned or backend-dependent behavior.
- Do not publish fabricated benchmark values; identify the model, workload, and environment for measured results.
- Preserve the `store: false` full-replay requirement for tool outputs unless a repeatable backend capability test proves a safe alternative.
- Never include credentials, prompts, tool arguments/results, Turn State, or reasoning content in examples or logs.
