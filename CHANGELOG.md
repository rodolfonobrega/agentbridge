# Changelog

## Unreleased

- Proxy: real `finish_reason`/`stop_reason` and usage, `max_tokens`/`stop` enforced, `x-agentbridge-ignored`, sessions via `x-ab-session`, config file (aliases, payload rules, effort suffix), early-stream fallback.
- Proxy agent mode (`agent/` prefix or `/agent/v1`): the agent edits an isolated worktree, the diff comes back, `apply` is explicit. Needs `--agent-root` and a token.
- Proxy client tool calling (OpenAI, Responses, Anthropic): claude through an MCP bridge, other agents through validated prompt emulation.
- Opt-in account pool (`--accounts` + `--accept-tos-risk`), `/admin/status`, `/admin/usage`, `--log`.
- Proxy images for claude (stream-json input), codex (`-i`) and opencode (file parts), with an SSRF-safe URL fetch; `run()` accepts `images: [{mediaType, data}]`.
- `ab install pi`: registers the bridge in pi (`pi mcp add`, direct exposure) and installs the skill in the shared `.agents/skills/` folder.
- opencode: bootstrap requests are bounded (health 3 s, warm-up 20 s with one retry, session create 30 s), which fixes a ~300 s stall.
- Missing/unconfigured agents are never silent: `NOT_INSTALLED`/`NOT_LOGGED_IN` messages carry install/login hints, `ab serve` prints which agent CLIs are present at startup, `/v1/models` lists only installed agents, and `ab install all` exits 1 when nothing was installed.
- `RATE_LIMITED` errors carry `kind` (quota / overloaded / rate).

## 0.1.0 — first public release

- Unified `run/ask/fanout/race` API and `ab` CLI for Claude Code, Codex, OpenCode, Antigravity CLI (`agy`) and pi, plus HTTP endpoints (Ollama built in).
- MCP bridge: any agent can delegate to any other, with depth guard, permission ceiling and HMAC attestation.
- `RATE_LIMITED` error code and `fallback` chains (library, CLI, MCP tools, proxy).
- `pi` adapter (any provider/model configured in pi, including cloud and local Ollama models).
- OpenAI- and Anthropic-compatible local proxy.
- Telemetry, context policy, compaction and cross-agent handoff.
- `ab ui`: read-only live dashboard (runs, tokens, cost, success rate, fallbacks rescued, context pressure, per-run details). CLI, proxy and MCP `ask_*` runs are now recorded in the telemetry.
- `agentbridge-delegate` skill, installed by `ab install` (`--no-skill` to skip).
- `ab install codex|opencode|agy|all`: register the bridge and the skill in the other agents, so any of them can call any other.
- `ab doctor`, `ab install claude`, hooks, structured output (`jsonSchema`), worktrees and budgets.
