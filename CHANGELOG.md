# Changelog

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
