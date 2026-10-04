# Changelog

## 0.1.0 — first public release

- Unified `run/ask/fanout/race` API and `ab` CLI for Claude Code, Codex, OpenCode, Antigravity CLI (`agy`) and pi, plus HTTP endpoints (Ollama built in).
- MCP bridge: any agent can delegate to any other, with depth guard, permission ceiling and HMAC attestation.
- `RATE_LIMITED` error code and `fallback` chains (library, CLI, MCP tools, proxy).
- `pi` adapter (any provider/model configured in pi, including cloud and local Ollama models).
- OpenAI- and Anthropic-compatible local proxy.
- Telemetry, context policy, compaction and cross-agent handoff.
- `ab ui`: read-only live dashboard (runs, tokens, cost, success rate, fallbacks rescued, context pressure, per-run details). CLI, proxy and MCP `ask_*` runs are now recorded in the telemetry.
- `agentbridge-delegate` skill, installed by `ab install claude` (`--no-skill` to skip).
- `ab doctor`, `ab install claude`, hooks, structured output (`jsonSchema`), worktrees and budgets.
