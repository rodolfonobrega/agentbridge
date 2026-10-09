# AgentBridge Architectural Contract (all builders MUST follow)

TypeScript native (ESM, strict typecheck, compiled to `dist/`), Node >= 22. Zero external runtime dependencies for core workflows.
No API keys required for local agents: orchestrate *installed* coding CLIs (`claude`, `codex`, `opencode`, `agy`, `pi`) using their existing local authentications.
Windows + POSIX safe (resolve `.cmd` shims, UTF-8 code page enforcement, explicit quoting without vulnerable `shell: true`).

---

## 1. Adapter Interface (`src/adapters/<agent>.ts`)
All agent adapters must satisfy the unified interface:
```typescript
export interface AgentAdapter {
  name: 'claude' | 'codex' | 'opencode' | 'agy' | 'pi' | string;
  models(): Promise<string[]>;                    // Best-effort discoverable models
  run(opts: RunOptions): AsyncGenerator<AgentEvent, AgentResult>; // Streaming generator yielding events and returning result
}
```

### RunOptions (`src/types/index.ts`)
- `prompt`: string
- `model`?: string
- `effort`?: `'low'` | `'medium'` | `'high'` | `'xhigh'` | `'max'` (mapped per agent backend)
- `permissions`?: `'read-only'` | `'plan'` | `'edit'` | `'full'` (default `'read-only'`)
- `transport`?: `'cli'` | `'app-server'` (Codex dual transport)
- `cwd`?: string
- `timeoutMs`?: number
- `signal`?: AbortSignal
- `session`?: `{ mode: 'new' | 'ephemeral' | 'continue' | 'fork', id?: string }`
- `systemPrompt`?: string
- `mcpServers`?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
- `env`?: Record<string, string>
- `jsonSchema`?: object
- `extraArgs`?: string[]

### Normalized AgentEvent
- `{ type: 'session', id: string }`
- `{ type: 'text', delta: string }`
- `{ type: 'thinking', delta: string }`
- `{ type: 'tool', name: string, input: any, output?: any }`
- `{ type: 'usage', input: number, output: number, cost?: number }`
- `{ type: 'error', message: string }`
- `{ type: 'raw', data: any }`

### Normalized AgentResult
- `{ text: string, sessionId?: string, usage: { input: number, output: number, cost?: number }, exitCode: number, model?: string, durationMs: number, timedOut: boolean }`

---

## 2. Core Pillars & Architecture

### A. Dual Transport Architecture (OpenAI Codex)
- **CLI Transport (`transport: 'cli'`):** Standard one-shot process execution via `codex exec`.
- **App-Server Transport (`transport: 'app-server'`):** Warm JSON-RPC daemon over stdio (`codex app-server`). Eliminates cold start overhead, maintains persistent workspace state, and enables low-latency interactive tool approvals.

### B. Shared Resource Mirroring & Worktree Isolation
- Worktree execution (`--worktree`) isolates workspace changes into temporary Git branches.
- To prevent loss of skills and MCP tools during directory isolation, AgentBridge utilizes NTFS Junctions (Windows) or Symlinks (POSIX) combined with config merging (`~/.codex/config.toml`, `~/.claude/settings.json`, `~/.pi/agent/mcp.json`).

### C. Zero-Accident Git Checkpoints
- Automated snapshots via Git dangling commits / trees (`checkpoint_create`, `checkpoint_rollback`, `checkpoint_list`).
- Invisible to branch history, enabling risk-free autonomous edits and instant rollbacks on test failures.

### D. Centralized Agent Roster & Catalog
- Centralized registry in `src/core/catalog.ts`: `BUILTIN_AGENTS` (`claude`, `codex`, `opencode`, `agy`, `pi`) and `VALID_ACCOUNT_AGENTS`.
- Prevents desynchronization between CLI commands, account management, proxy router, and MCP tools.

### E. Proactive Quotas & Rate-Limit Tracking
- Tracks usage, tokens, and rate limits dynamically per agent.
- Provides `check_quota` MCP tool and `ab quota` CLI command to inspect limits before launching heavy tasks.

### F. Real-time Telemetry & Web Dashboard
- Embedded HTTP web dashboard (`ab ui`) provides live visualization of multi-agent runs, token consumption, execution timelines, and subagent trees.

### G. MCP Timeout Propagation & 60s Cutoff Elimination
- `McpServerConfig.timeout` is fully typed, validated, and propagated across all adapters (Codex, Pi, OpenCode, Antigravity, Claude).
- Installers (`install`, `setup`, `install-ide`) configure standard `"timeout": 300` across all registered client configurations (Pi, OpenCode, Claude, Codex, Cursor, VS Code, Zed, Windsurf), completely eliminating the MCP SDK default 60-second execution cutoff.
- `ask_*` and `dispatch_*` tool schemas support both `timeout` and `timeoutSeconds`.

### H. Universal Open Agent Skills & Collision Guard
- Universal canonical skill path is `.agents/skills/agentbridge-delegate/SKILL.md`.
- Shared simultaneously across Pi, Codex, OpenCode, and Antigravity without redundant per-harness installations.
- Installer detects existing global installations (`~/.agents/skills`) and avoids redundant project-level duplicates that trigger Pi collision alerts (`[Skill conflicts] collision`).

---

## 3. Directory Structure
```
src/
├── adapters/       # Agent-specific drivers (claude, codex, opencode, agy, pi, endpoint)
├── bridge/         # Stdio MCP server exposing tools (ask_*, dispatch_*, checkpoints, quota)
├── cli/            # Command line commands (run, ask, fanout, install, setup, quota, ui)
├── core/           # Catalog, spawn, errors, events, sandboxing, shared resources
├── extras/         # Environment diagnostics (ab doctor)
├── quota/          # Rate limits, token counters, quota trackers
├── server/         # OpenAI / Anthropic proxy compatibility server
├── storage/        # Storage, memory retention, workspace state
├── types/          # Strict TypeScript interfaces and schemas
└── ui/             # Web dashboard server and assets
```

---

## 4. Error Handling Contract
All runtime errors must instantiate `AgentError` with normalized codes:
- `NOT_INSTALLED`: Agent binary not found in PATH or environment.
- `NOT_LOGGED_IN`: Agent has not completed authentication.
- `TIMEOUT`: Execution exceeded configured timeout limit.
- `ABORTED`: Execution aborted via `AbortSignal`.
- `BAD_OPTION`: Option unsupported by target agent or invalid argument passed.
- `AGENT_FAILED`: Process crashed or exited with non-zero status.
