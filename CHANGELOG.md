# Changelog

## [0.3.1] - 2026-10-09

### Documentation, Proxy Code Samples & Concurrency Stability

- **Proxy Ready-to-Run Code Examples:** Added comprehensive, production-ready code examples in `docs/PROXY.md`, `README.md`, and `README_AI.md` covering Python (`openai` and `anthropic` SDKs, streaming, LangChain, and Agent Sandbox Mode), TypeScript/Node.js (`openai` and `@anthropic-ai/sdk`), and cURL.
- **AI Agent Integration Reference:** Updated `README_AI.md` with complete MCP checkpoint tools, agent sandbox mode invocation, and practical code snippets for autonomous workflows.
- **Test Suite Concurrency Tuning:** Improved timing assertions in endpoint tests under high concurrency.
- **Synchronized npm Distribution:** Guaranteed identical package parity across GitHub Releases and the official npm registry.

## [0.3.0] - 2026-10-09

### Managed Multiple Accounts, Time-Machine Checkpoints, TDD Auto-Repair & Zero-Remote Telemetry

- **Managed Multiple Accounts & Profiles (`ab account`):**
  - Full directory isolation for accounts inspired by Orca (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, etc.).
  - Interactive multi-login commands: `ab account list [agent]`, `ab account add <agent> <name> [--copy-current] [--login]`, `ab account use <agent> <name>`, `ab account remove <agent> <name> [--purge]`.
  - Zero-friction integration with `--account <name>` on CLI runs and automatic conversion to rotating pools for `ab serve --accept-tos-risk`.
  - Proactive per-account quota inspection via `ab account quota [agent]`.
- **Git Hidden-Ref Checkpoint Engine & Visual Time Machine:**
  - Non-destructive workspaces snapshots stored under `refs/agentbridge/checkpoints/` using an isolated `GIT_INDEX_FILE`.
  - Visual Time Machine tab integrated into `ab ui` (`http://127.0.0.1:8788`) with split diff viewing and instant one-click rollback.
  - MCP Bridge tools exposed for AI agents: `checkpoint_create`, `checkpoint_list`, `checkpoint_diff`, `checkpoint_rollback`.
- **TDD Auto-Repair Loop (`ab fix`):**
  - Autonomous test-driven repair loop with bounded stdout/stderr capture.
  - Automated pre-execution checkpointing and safe rollback on persistent failure.
- **Multi-Agent Review Loop & Consensus (`ab review`, `ab ensemble`):**
  - Implementer-reviewer feedback cycles with structured JSON/Markdown verdicts and git diff inspection under `read-only` ceiling.
  - Parallel multi-agent ensemble runs with plurality consensus voting and optional synthesizer judge.
- **DAG Pipeline Task Orchestrator (`ab pipeline`):**
  - Directed Acyclic Graph runner with topological wave execution, concurrency limits, and wave checkpoints.
- **Zero-Friction MCP Installers (`ab install <ide>`):**
  - Instant zero-dependency setup for Cursor, VS Code, Zed, Windsurf, Claude Desktop, Claude Code, Codex, Pi, OpenCode, and Antigravity.
- **Shared Project Memory (`ab memory`):**
  - Machine-readable persistent repository conventions and decisions in `.agentbridge/memory.json`.
- **Proactive Quota Probing (`ab quota`):**
  - Proactive querying of Anthropic OAuth 5-hour/7-day windows and ChatGPT Wham usage limits, auto-throttling credentials at $\ge 95\%$ before encountering HTTP 429 penalties.
- **CommonMark Boundary-Aware Streaming:**
  - Throttled Markdown stream filter ensuring UI/WebSocket streams split only on clean Markdown boundaries (closing code fences, list items, blank lines).
- **Subagent Native Roster:**
  - Complete hierarchical parent-child subagent tree tracking with token usage aggregation and status transitions.
- **Audited 100% Local Privacy Guarantee:**
  - Verified and documented zero remote analytics/tracking policy: all run logs, token counts, and metrics remain on-device in `~/.agentbridge/`.

## [0.2.0] - 2026-10-09

### Smart Model Resolution, Real-Time Active Agent Tracking & Agent Autonomy

- **Smart Model Resolver (`resolvePiModel` & endpoint auto-mapping):** Seamlessly normalizes model names between bare format (`glm-5.3-flash:cloud`) and provider-namespaced format (`ollama/glm-5.3-flash:cloud`) for Pi, Ollama, and custom endpoints. No more 5-minute timeouts on subagent/agent calls.
- **Active Agent Monitoring in Web UI (`ab ui`):**
  - Live header indicator displaying active processes and unique agents (`● X active across Y agents`).
  - Dedicated "Active Agents" KPI card breaking down real-time active runs per agent (e.g. `ollama (2) · pi (1)`).
  - New "Active" status filter tab in the Recent Runs table.
  - Inline error diagnostics directly under badges for failed runs (e.g. `timeout (5m)`, `lost (process exited)`).
  - Subagent count and lineage inspection in the run details drawer.
- **Full Autonomy by Default (`permissions: 'full'`):** Default permissions ceiling across `ab install`, `ab setup`, MCP server bridge, and proxy sandbox updated to `full` so agents and subagents can run tools, shell commands, and builds without being rejected by an arbitrary ceiling.
- **Proxy Bare Model Routing (`ab serve`):** The OpenAI/Anthropic-compatible proxy server now automatically detects and routes bare Ollama model names (like `glm-5.3-flash:cloud`) directly to the Ollama runner.
- **Agent Skill & Onboarding Documentation:**
  - Updated `agentbridge-delegate` skill with smart model resolution and subagent delegation guidance.
  - Added `README_AI.md` / `AGENTS.md` specifying architecture, commands, and workflows for autonomous coding agents.

## [0.1.0] - 2026-10-08

### First Official Public Release of AgentBridge (`ab`)

- **Interactive Terminal Setup Wizard:** Modern ANSI setup wizard (`ab setup` / `ab wizard`) with automatic environment detection for Claude Code, Codex, OpenCode, Pi, Antigravity, and Ollama.
- **TypeScript Migration:** 100% strict TypeScript (`.ts`) architecture with zero external runtime dependencies (`"dependencies": {}`). All source compiled and packaged in `dist/`.
- **Unified Multi-Agent Interface:** Seamlessly drive `claude`, `codex`, `opencode`, `agy`, `pi`, `cursor`, `grok`, `gemini`, `devin`, and Agent Client Protocol (`acp`) using existing local authentications.
- **Endpoint Coding Harnesses (`--harness auto|claude|pi|none`):** Drive HTTP endpoints (local Ollama, OpenRouter, vLLM) via Claude Code or Pi harnesses to execute workspace edits, tool calls, and tests.
- **Git Hidden-Ref Checkpoints:** Zero-risk snapshots stored in isolated `refs/agentbridge/checkpoints/<session>/<id>` without branch pollution (`ab checkpoint create|list|diff|rollback`).
- **Proactive Quota Probing & Pool Cooldown:** Real-time quota polling for Anthropic and Codex usage limits with automatic pool cooldown and rotation.
- **Subagent Hierarchy Roster:** Parent-child delegation tracking with interactive lineage tree visualization in `ab ui`.
- **Dual-Mode Codex Execution:** Persistent JSON-RPC 2.0 stdio server mode (`codex app-server`) alongside batch CLI execution (`codex exec`).
- **MCP Bridge Server:** Any agent can delegate tasks to any other agent (`ask_claude`, `ask_codex`, `ask_opencode`, `ask_agy`, `ask_pi`, `ask_ollama`) with recursion depth guard, permission ceiling, and HMAC attestation.
- **Automatic Fallback on Rate Limits:** `RATE_LIMITED` error detection with automatic fallback chains across agents.
- **Local Proxy Server:** OpenAI- and Anthropic-compatible local proxy (`ab serve`) with streaming, tool calling, and account rotation.
- **Telemetry & Context Policies:** Context window tracking (`ab context`), real-time terminal monitor (`ab top`), and auto-compaction policies (`autoCompact`) with cross-agent handoffs (`ab handoff`).
- **Visual Web Dashboard:** Live read-only dashboard (`ab ui`) on `http://127.0.0.1:8788`.
