# Architecture & Capability Comparison: AgentBridge vs. Orca vs. T3 Code

This document provides a comprehensive technical comparison of **AgentBridge**, **Orca** (Stably AI), and **T3 Code** (Ping.gg), detailing architectural paradigms, execution models, provider integrations, and comparative advantages.

---

## 1. Executive Summary

| Dimension | AgentBridge | Orca (Stably AI) | T3 Code (Ping.gg) |
| :--- | :--- | :--- | :--- |
| **Primary Paradigm** | Universal CLI & Protocol Bridge, Multi-Agent MCP Server & Drop-in HTTP Proxy | Electron Desktop Workspace with PTY Agent Runner | Effect-TS Web/Desktop Workspace with Agent Orchestration |
| **Runtime Dependencies** | **0 (Zero dependencies)** — Pure Node.js 22+ ESM standard library | 50+ npm packages (Electron, node-pty, sqlite3, etc.) | 40+ npm packages (Effect-TS, React, Tailwind, Vite, etc.) |
| **Agent Support** | Claude Code, Codex (CLI + App-Server), OpenCode, Antigravity, Pi, Cursor, Grok, Gemini, Devin, Generic ACP, Custom HTTP Endpoints (Ollama/vLLM) | Claude Code, Codex, OpenCode, Pi, Antigravity | Claude Code, Codex (App-Server), OpenCode, Cursor, Grok, Antigravity, ACP |
| **Orchestration Modality** | CLI (`ab`), Stdio MCP Server (`ab bridge`), Drop-in OpenAI/Anthropic HTTP Proxy (`ab serve`), and JS/TS API | GUI only (Electron Desktop) | GUI & Web workspace |
| **Agent-to-Agent Delegation** | Native MCP Tools (`ask_*`, `dispatch_*`, `wait_run`, `send_message`) | None (human-to-agent only) | Internal Effect runtime |
| **Workspace Safety** | Git Hidden-Ref Checkpoints (`refs/agentbridge/checkpoints/...`) + Isolated Git Worktrees | Ephemeral worktrees | Git Checkpoints (`refs/checkpoints/...`) |
| **Process Supervision** | OS process-tree escalation (Windows/POSIX) + 8 KiB bounded stderr tail buffer | Child process monitoring & hang watchdog | Effect-TS fiber process supervision |
| **Rate Limit / Quota** | In-flight detection + proactive Anthropic/Codex usage probing & auto-rotation pool | Anthropic OAuth usage API probing + Codex usage headers | Token quota tracking & budget limits |
| **Security / Attestation** | HMAC-SHA256 delegation attestation, loopback-bound server, strict permission tiers | OS credential manager | Client token storage |

---

## 2. Deep Architectural Breakdown

### 2.1 Agent Execution & Process Supervision

#### AgentBridge
- **Zero-Dependency Native Architecture:** Relies solely on Node.js `child_process.spawn` without native compilation bindings (`node-pty` or C++ addons). Runs universally on Windows (PowerShell/cmd), macOS, and Linux without build toolchains.
- **Bounded Tail Ring Buffer:** Standard process pipes deadlock when subagent stderr overflows the OS pipe buffer (typically 4–64 KiB). AgentBridge implements a circular 8 KiB tail buffer (`STDERR_TAIL_MAX_CHARS`), guaranteeing that high-volume debug logs never stall agent execution while preserving the critical tail for error diagnostics.
- **Cross-Platform Process Tree Termination:** On POSIX, escalates through process groups (`-pid` SIGTERM $\to$ SIGKILL); on Windows, invokes `taskkill.exe /pid <pid> /T /F` (degrading to a SIGKILL of the leader alone if taskkill is missing or fails), ensuring child CLI worker processes never leak as zombie background tasks.
- **Dual-Mode Codex Execution:** Supports both standard batch CLI execution (`codex exec`) and persistent JSON-RPC 2.0 stdio server mode (`codex app-server`), minimizing cold-start overhead and maintaining stateful turn execution.

#### Orca (Stably AI)
- Uses `node-pty` for pseudo-terminal emulation. While this allows ANSI color capture and terminal-like UI display, it requires native build bindings (`node-gyp`), making cross-platform updates fragile.
- Employs an external hang watchdog that checks activity timestamps and kills stalled processes.

#### T3 Code (Ping.gg)
- Built on **Effect-TS** fibers. Manages child process lifecycles through functional effect streams.
- Relies heavily on ACP (Agent Client Protocol) and the `codex app-server` JSON-RPC transport for modern streaming interactions.

---

### 2.2 Workspace Isolation & Git Checkpointing

#### AgentBridge
- **Git Hidden-Ref Checkpoints:** Uses low-level git plumbing (`git write-tree`, `git commit-tree`, `git update-ref`) isolated inside a dedicated temporary index file (`GIT_INDEX_FILE` in `os.tmpdir()`).
  - Checkpoints are saved under `refs/agentbridge/checkpoints/<session>/<id>`.
  - Staging and snapshotting never touch the user's primary `.git/index` or modify the current branch `HEAD`.
  - Non-destructive rollback restores both tracked and untracked files while preserving intermediate state.
  - Exposes both CLI commands (`ab checkpoint create|list|rollback|diff`) and MCP agent tools (`checkpoint_create`, `checkpoint_rollback`, `checkpoint_list`).
- **Sandboxed Ephemeral Worktrees:** The `--worktree` flag spawns agents in a dedicated, disposable git worktree branch, discarding or merging changes only after validation.

#### Orca
- Supports git worktree isolation for agent edits, but lacks non-destructive hidden-ref git snapshot rollback within an existing repository session.

#### T3 Code
- Implements checkpointing using dedicated git refs (`refs/checkpoints/...`). Works similarly to AgentBridge's plumbing approach, but is tightly coupled to T3 Code's server and UI layer.

---

### 2.3 Quota Probing, Account Pooling & In-Flight Fallback

#### AgentBridge
- **Proactive & Reactive Hybrid Rate Limiting:**
  1. *In-Flight Fallback:* When a CLI hits a rate limit or token exhaustion during a run, AgentBridge automatically fails over to the next configured fallback provider/model (e.g., `claude -> codex -> opencode -> ollama`) without crashing the calling workflow.
  2. *Proactive Quota Probing:* Directly queries Anthropic's OAuth usage endpoint (`GET https://api.anthropic.com/api/oauth/usage`) and Codex's usage backend (`GET https://chatgpt.com/backend-api/wham/usage`).
  3. *Pool Auto-Cooldown:* Accounts reaching $\ge 95\%$ quota utilization or receiving 429 responses are automatically placed in a cooling-down queue with fixed cooldowns (30 min for quota, 30 s for overloaded, 60 s for rate; a provider-provided `retry-after` wins), and a throttled account is held until its quota reset time.
- **Drop-In HTTP Proxy:** The `ab serve` command turns the account pool into a local OpenAI/Anthropic compatible HTTP proxy. Any tool (Cursor, VS Code extensions, Continue, Cline) can transparently leverage CLI logins and pooled multi-account rotation without manual token management.

#### Orca
- Implements proactive Anthropic OAuth rate limit polling and Codex token counting, showing visual gauge meters in the desktop application.
- Supports multi-account rotation for Claude and Codex.

#### T3 Code
- Tracks usage contracts and limits through Effect-TS schemas and provider-specific telemetry endpoints.

---

### 2.4 Multi-Agent Delegation & Lineage Hierarchy

#### AgentBridge Superpower: Native Recursive MCP & Delegation Roster
- **MCP Bridge (`ab bridge`):** Any AI coding agent (Claude Code, Codex, Antigravity, OpenCode, Cursor, Devin) can discover and call other agents through standard Model Context Protocol tools (`ask_claude`, `ask_codex`, `dispatch_opencode`, etc.).
- **Subagent Roster & Lineage:** Every subagent dispatched is recorded as a `subagents[]` entry (`id`, `name`, `parentId`, `parentToolId`, `task`, `state`, start/end timestamps, token usage) on the **parent's** run record, which also carries the delegation `root` (`src/bridge/runs.ts`). Delegation depth is tracked with the `AGENTBRIDGE_DEPTH` environment variable (the bridge's recursion guard), and inbox messages carry a `{root, depth, pid}` sender identity.
  - Child runs automatically stream events and token usage into the parent run record.
  - Atomic persistence in `~/.agentbridge/runs/<runId>.json`.
  - Visualized as an interactive hierarchy tree in the AgentBridge Web UI (`ab ui`).
- **Cryptographic HMAC Attestation:** When subagents return code or answers, AgentBridge generates an HMAC-SHA256 signature binding the agent identity, model, session, depth, and output hash. The parent agent can verify that output was not spoofed.

---

## 3. Detailed Feature Comparison Matrix

| Feature | AgentBridge | Orca | T3 Code |
| :--- | :---: | :---: | :---: |
| **Core Architecture** | | | |
| Zero External Dependencies | **YES** | NO | NO |
| CLI First (`ab run`, `ab ask`, `ab fanout`, `ab race`) | **YES** | NO | NO |
| Headless Server / Daemon Mode | **YES** | NO | YES |
| Local Web Dashboard UI | **YES** (Vanilla HTML/CSS/JS) | NO (Electron) | YES (React/Vite) |
| Native Stdio MCP Server | **YES** | NO | NO |
| Drop-in OpenAI API Proxy (`/v1/chat/completions`) | **YES** | NO | NO |
| Drop-in Anthropic API Proxy (`/v1/messages`) | **YES** | NO | NO |
| **Provider Support** | | | |
| Anthropic Claude Code (`claude`) | **YES** | **YES** | **YES** |
| OpenAI Codex (`codex`) CLI batch | **YES** | **YES** | **YES** |
| OpenAI Codex `app-server` (JSON-RPC) | **YES** | NO | **YES** |
| OpenCode (`opencode`) | **YES** | **YES** | **YES** |
| Antigravity (`agy`) | **YES** | **YES** | **YES** |
| Pi (`pi`) | **YES** | **YES** | NO |
| Cursor Agent CLI (`cursor`) | **YES** | NO | **YES** |
| xAI Grok CLI (`grok`) | **YES** | NO | **YES** |
| Google Gemini CLI (`gemini`) | **YES** | NO | NO |
| Devin CLI (`devin`) | **YES** | NO | NO |
| Generic Agent Client Protocol (`acp`) | **YES** | NO | **YES** |
| Custom HTTP Endpoints (Ollama, vLLM, OpenRouter) | **YES** | NO | NO |
| **Resilience & State Safety** | | | |
| Git Hidden-Ref Checkpointing | **YES** | NO | **YES** |
| Git Ephemeral Worktrees | **YES** | **YES** | **YES** |
| Circular Bounded Stderr Tail Ring Buffer (Deadlock-Free) | **YES** | NO | NO |
| Process Tree / Process Group Escalation Kill | **YES** | **YES** | **YES** |
| In-Flight Rate Limit Fallback Chain | **YES** | NO | NO |
| Proactive Quota Probing (Anthropic & Codex) | **YES** | **YES** | **YES** |
| Account Pool Auto-Cooldown on Exhaustion | **YES** | **YES** | NO |
| **Multi-Agent Capabilities** | | | |
| Agent-to-Agent Delegation via MCP | **YES** | NO | NO |
| Subagent Tree & Lineage Tracking | **YES** | NO | **YES** |
| Cross-Process Run Registry & Event Streaming | **YES** | NO | **YES** |
| Cryptographic HMAC Delegation Attestation | **YES** | NO | NO |

---

## 4. Why AgentBridge Wins

1. **True Interoperability:** Orca and T3 Code are isolated applications where a human talks to an agent. AgentBridge is an orchestration bridge: an agent running in Claude Code can invoke Codex or Gemini via MCP, fallback to Ollama when quotas run out, rollback code using git checkpoints, and cryptographically attest its output.
2. **Minimal Footprint & Longevity:** With zero runtime dependencies, AgentBridge installs in seconds, has no node-gyp native compilation issues, and will run stably across future Node.js releases without dependency rot.
3. **Seamless IDE Integration:** With `ab serve`, AgentBridge behaves like a local AI gateway. You can point Cursor, Aider, Cline, or any OpenAI-compatible client directly at your local CLI logins.
4. **Git Safety Without Branch Pollution:** Hidden-ref checkpoints give complete rollback security without cluttering git branches or creating dirty commits.
