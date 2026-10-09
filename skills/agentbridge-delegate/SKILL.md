---
name: agentbridge-delegate
description: Delegate work to other coding agents (Codex, OpenCode, Antigravity/agy, pi, Ollama endpoints) through the AgentBridge MCP tools (mcp__agentbridge__ask_*, dispatch_*). Use when the user asks for a second opinion, to run something on another agent or model, to run agents in parallel, or when a task should go to a cheaper/different model.
---

# Delegating with AgentBridge

The MCP server `agentbridge` exposes other coding agents as tools. Each runs as a separate process with its own login; you get back its final text, session id and token usage.

## Tools

- `ask_<agent>`: run and wait. Agents: `codex`, `opencode`, `agy`, `pi`, plus any endpoint added with `ab endpoint add` (e.g. `ask_ollama`, custom OpenAI/Anthropic/OpenRouter endpoints).
- `dispatch_<agent>`: start asynchronously, returns a run id at once. Then `wait_run` (blocks, with `timeoutSeconds`), `check_run` (status, last events, tokens), `cancel_run`, `list_runs`.
- `send_message` / `check_messages`: inbox for a run id or agent name (no live injection into a running agent).
- **Git Checkpoint Tools (Fail-safe Workspace Snapshots):**
  - `checkpoint_create(message, cwd?)`: creates an instant non-destructive hidden-ref git snapshot (`refs/agentbridge/checkpoints/...`). Use **before** delegating risky code modifications.
  - `checkpoint_list(cwd?)`: lists recent workspace checkpoints with id, timestamp, message, and session id.
  - `checkpoint_diff(id, cwd?)`: returns unified git diff between current workspace and the checkpoint.
  - `checkpoint_rollback(id, cwd?)`: safely restores workspace to the checkpoint, recovering modified files and pruning untracked files created since the snapshot.

## When to use which

- **Short, bounded task (under ~2 min):** `ask_<agent>`.
- **Long task, or several in parallel:** `dispatch_<agent>` for each, keep working, then `wait_run` on every id. Use an `idempotencyKey` so a retry does not start a duplicate.
- **Risky refactor or complex changes:** First call `checkpoint_create(message="Before refactor")`, run the delegation with `ask_*` or `dispatch_*`, verify tests, and if broken, call `checkpoint_rollback(id)`.
- **Second opinion or review:** ask a *different* agent than the one that wrote the code; give it the file paths and the question, not your conclusion.
- **Cheap bulk work (summaries, searches, boilerplate):** pick a cheap model/agent; reserve strong models for hard problems.

## Writing the delegated prompt

The other agent has none of your context. Give it: the goal, the exact files/paths, constraints, and the form the answer should take. Set `cwd` to the project folder. Ask it to be concise.

## The Safety Lock (Trava de Segurança): How Edits are Blocked vs Allowed

AgentBridge is engineered with a **Zero-Accident Safety Lock**:
- **Why it exists:** Unrestricted subagent execution is dangerous. An autonomous agent asked to "audit this function" or "check tests" could hallucinate and overwrite source code or execute destructive bash commands.
- **The Safety Lock (Default: `read-only`):** By default, every delegation has its safety lock engaged. Subagents operate with read-only tools and cannot modify your files, branch state, or run shell mutations.
- **Intentional Unlocking:** When you *want* the agent to write code, refactor, or run tests, you must explicitly unlock it by passing `permissions: "edit"` or `permissions: "full"`.
- **The Inviolable Ceiling:** The Permission Ceiling defaults to `full` (so you can request whatever powers you need), but if you or the user configure a stricter ceiling (e.g. `ab config set permissions-ceiling edit`), AgentBridge acts as an unbypassable circuit-breaker: subagents cannot escalate privileges beyond that ceiling under any circumstances.
- **Configurability:** You can customize persistent defaults per project or globally via `ab config set default-permissions <level>`.

> ⚠️ **CRITICAL INSTRUCTION FOR DELEGATION:** Whenever you delegate a task that requires creating or modifying files, refactoring code, or running build/test commands, you **MUST explicitly unlock the safety lock by passing `permissions: "edit"` or `permissions: "full"`**. If you omit it, the subagent will safely run with the safety lock engaged in `read-only` mode and will refuse to modify files.

| Permission | Filesystem & Tools Allowed | When to Use | Under the Hood Enforcement |
|---|---|---|---|
| `full` | **All tools allowed**, including shell/bash execution. | Code edits, test runs, builds, package installs, automated fixes. | Bypasses permission prompts; full execution sandbox. |
| `edit` | Read, Grep, Glob, WebFetch, WebSearch + **File Write & Edit**. (Bash blocked). | Refactoring, bug fixes, file creation & code edits without arbitrary shell. | Unlocks Write/Edit tools; workspace-write sandbox restricted to cwd. |
| `plan` | Read, Grep, Glob, WebFetch, WebSearch. **No edits, no bash.** | Solution design, checklist proposals, diff reviews. | Read-only sandbox with plan prompt mode; writes blocked. |
| `read-only` *(default)* | Read, Grep, Glob, WebFetch, WebSearch. **No edits, no bash.** | Reviews, code audits, questions, file inspection. | Tool allowlists exclude Write/Edit/Bash; OS-level sandbox enforces read-only; write deny rules. |

> **How AgentBridge Prevents Edits:**
> In `read-only` and `plan` modes, write tools (`Write`, `Edit`, `Bash`) are physically omitted from tool definitions passed to Claude Code and Pi (`--tools Read,Glob,Grep,WebFetch,WebSearch` / `--exclude-tools write,edit,bash`). Codex is placed in an OS container sandbox (`--sandbox read-only`), and Antigravity gets a throwaway profile with explicit deny rules (`write_file(*)`). The model literally cannot mutate your files.

## Options that matter

- `permissions`: `read-only` (safe default), `edit`, `plan`, `full`. Use `edit` or `full` whenever files need to be modified.
- `harness`: `auto` (default), `claude`, `pi`, `none`.
  - For endpoints like Ollama or OpenRouter:
    - If `permissions` is `edit` or `full`, AgentBridge **automatically** drives the endpoint via a coding harness (`claude` or `pi`) so the model has tools to modify files.
    - If you want the model to **read files or search the web** without editing, pass `harness: "claude"` (or `harness: "pi"`) with `permissions: "read-only"`.
    - If you only want a quick text answer without filesystem access, omit `harness` under `read-only` (or set `harness: "none"`), and it runs as a fast direct HTTP API call.
- `model`: default is the cheapest model for that agent; set it only when asked or when the task needs more. Model names are **smart-resolved**: you can specify models with or without provider prefixes (e.g. `glm-5.3-flash:cloud` or `ollama/glm-5.3-flash:cloud`). AgentBridge automatically handles provider namespaces for Pi, Ollama, and other endpoints.
- `effort`: `low` ... `max`.
- `timeoutSeconds`: default 300; raise it for big tasks.
- `session`: `{mode:'continue', id}` to follow up in the same agent conversation (`new`, `ephemeral`, `continue`, `fork`).
- `fallback`: e.g. `["codex","ollama:glm-5.3-flash:cloud"]`. If the agent fails with `RATE_LIMITED` (or a code listed in `fallbackOn`), the next one answers. It is skipped if the first agent already ran tools under `edit`/`full`, to avoid redoing side effects. The result's `fallback` field says who answered and whether context was lost (fallback agents start a fresh session).
- `transport`: `auto` (default), `cli`, `app-server`.
  - Pass `transport: "app-server"` for **Codex** to run via a persistent JSON-RPC 2.0 daemon instead of batch process spawns.

## Execution Transports: CLI vs App-Server Mode

AgentBridge supports **Dual-Mode Execution** for OpenAI Codex:

1. **Batch CLI Mode (`transport: "cli"`, default):**
   - Each call spawns a one-off `codex exec` process.
   - Clean, fully isolated, and requires no daemon state.
   - Ideal for independent, single-turn tasks or when process teardown between runs is desired.

2. **Persistent Daemon Mode (`transport: "app-server"`):**
   - Spawns `codex app-server` once and communicates via JSON-RPC 2.0 frames over bidirectional stdio.
   - **What You Gain:**
     - **Zero Cold-Start:** The process stays warm in memory. Eliminates 2-5 seconds of process startup and auth bootstrapping on subsequent turns.
     - **Live Interactive Approval:** Codex proactively asks via RPC before mutating files or executing shell commands (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`). AgentBridge evaluates permissions programmatically (`read-only` denies immediately; `edit`/`full` approves) without ever blocking on an interactive terminal prompt.
     - **Structured Streaming:** Token-by-token deltas and granular tool lifecycle notifications without terminal scraping or ANSI parsing fragility.
     - **Clean Cancellation:** Turns can be aborted cleanly via `turn/cancel` notifications without `SIGKILL` or corrupting half-written files.
     - **Stateful Thread Continuity:** Native thread and turn tracking across multiple conversational steps.

> **Why Resource Linking & Config Mirroring were chosen over in-memory MCP injection:**
> Other systems (like Orca) abandon `config.toml` and inject MCPs entirely in-memory via `app-server` JSON-RPC calls, which forces users to run exclusively in `app-server` mode.
> AgentBridge instead combines **Resource Linking (Junctions)** for skills with **Config Mirroring (`config.toml` / `.mcp.json`)** for MCP servers. This ensures that your skills and MCPs are seamlessly available **in both modes** (`cli` and `app-server`), as well as across Pi, Claude Code, OpenCode, and Antigravity, without requiring complex memory hacks or breaking existing setups.

## Delegating to Subagents

When you instruct an agent (such as `pi` or `claude`) to spawn or coordinate subagents:
- The permission ceiling defaults to `full`, meaning subagents can run tools, shell commands, and file edits without being capped at read-only/edit.
- Model names specified for subagents (e.g. `glm-5.3-flash:cloud`) are automatically resolved so the child process maps them to the correct local or remote provider seamlessly.
- You can monitor running subagents and active agent counts in real time via `ab ui`.

## Harness Isolation: MCPs, Skills & Tool Availability

When delegating tasks via `ask_*` or `dispatch_*`, AgentBridge enforces **deterministic process isolation** for safety and stability:

- **The Isolation Mechanism:**
  - **Pi (`pi`):** Runs inside an ephemeral directory (`PI_CODING_AGENT_DIR`), stripping extensions/skills (`-ns -np -ne`) and replacing `mcp.json` with only the `agentbridge` connection. Any MCP server configured in `~/.pi/agent/mcp.json` (such as `rea`) is **hidden by default**.
  - **Claude Code (`claude`):** Invocations pass `--strict-mcp-config --mcp-config <temp>/mcp.json` and `--setting-sources ""`. Workspace `.mcp.json` and user `~/.claude.json` MCPs are **omitted by default**.
  - **Antigravity (`agy`):** Invocations use a disposable profile directory with `.gemini/config/mcp_config.json` restricted strictly to `mcp(agentbridge/*)`.
  - **OpenCode (`opencode`) & Codex (`codex`):** Configurations injected by bridge take precedence, and sandboxes (`read-only`, `plan`) block unauthorized system commands.

- **How to Control MCP & Skills Passthrough:**
  1. **The operator decides what is allowed (the ceiling).** Set it where the AgentBridge bridge is registered (`env` of the `agentbridge` MCP entry):
     - `AGENTBRIDGE_MCP_PASSTHROUGH=rea` (comma list such as `rea,playwright`, or `*` for every stdio server found). Unset means no passthrough at all.
     - `AGENTBRIDGE_MCP_SOURCE_DIR=/path` (dir holding the source `mcp.json`; default `~/.pi/agent`). The project's `.mcp.json` (nearest, up to the git root) is read too.
     - `AGENTBRIDGE_ENABLE_SKILLS=1` turns skills on for every Pi child.
  2. **The caller can only narrow it, per call (`ask_*` / `dispatch_*`):**
     ```json
     { "tool": "ask_pi", "arguments": { "prompt": "Analyze the binary", "permissions": "edit", "mcpPassthrough": ["rea"], "skills": true } }
     ```
     `mcpPassthrough` selects a subset of the operator allowlist (asking for something outside it, or `"*"`, never widens it). `skills: true` makes Pi discover your skills for that run.
  3. **Only stdio servers are passed** (entries with a `command`), always with `"exposure": "direct"` (a `deferred` server never shows its tools to the model). Works for Pi, Claude, OpenCode, Antigravity and Codex (env included).
  4. **Gates that cannot be overridden:**
     - `offline: true` blocks all passthrough.
     - `read-only` / `plan` get no passthrough; use `permissions: "edit"` or `"full"`.
  5. **Skills:** Pi's per-run home is empty, so with `skills: true` the bridge links your `~/.pi/agent/skills` into it (a junction on Windows, removed safely afterwards) and Pi also reads `~/.agents/skills` and the project's `.agents/skills` / `.claude/skills` up to the git root.
  6. **Worktrees (`--worktree`):** project skill folders that are not committed (`.agents/skills`, `.claude/skills`) are copied into the sandbox and kept out of the diff.
  7. **Accounts (`ab account add <agent> <name>`):** new profiles keep their own login and sessions but share your skills, prompts, plugins and, for Codex, your `[mcp_servers.*]` (via junction/symlink, copy as fallback). `--no-share` starts empty; `--copy-current` copies everything including the login.

- **Pre-Delegation Checklist (Verifying MCP & Tool Readiness):**
  - **Verify with `ab doctor`:** Run `ab doctor` to inspect which host MCPs are detected for each installed harness (`claude`, `codex`, `pi`, `opencode`, `agy`).
  - **Probe Tool Readiness:** If unsure whether a subagent can reach a specific tool, send a lightweight diagnostic probe first:
    `ask_pi({ "prompt": "List all your available tools.", "permissions": "read-only" })`
  - **Direct Host Execution:** If a task strictly requires an MCP server that is only present in your primary agent session and cannot be passed through, execute that task directly in the host agent rather than delegating to an isolated subagent.

- **Strict Security Guarantees & Sandboxes:**
  - **Default Permissions & Operator Ceiling:** By default, subagents run under `read-only`. The ceiling (`AGENTBRIDGE_PERMS_CEILING`) can never be widened by `extraArgs` or client options.
  - **Proxy Mode Tool Disablement:** Plain text API proxying automatically enforces `permissions: 'read-only'` and verifiably turns off tools (`--tools ""` for Claude, `--sandbox read-only` for Codex, `-ne -np -ns` for Pi).
  - **Time Machine (Checkpoints) Guard:** `checkpoint_rollback` is strictly forbidden under `read-only` or `plan` permissions and omitted from MCP tools under restricted ceilings. Workspaces are strictly confined to `AGENTBRIDGE_ROOT`. Rollback automatically purges both untracked and post-checkpoint staged files.
  - **Image Proxy SSRF & DNS Rebinding Protection:** Image fetching inspects both IPv4 and IPv6 representations (including mapped hex variants) and resolves hostnames to verified public IPs before connecting.
  - **Dashboard CSRF Protection:** The UI dashboard (`ab ui`) blocks cross-origin POST mutations via strict Origin and `Sec-Fetch-Site` verification.
  - **Worktree Baseline & Untracked Files Sync:** `createSandbox` faithfully replicates local untracked files (such as `.agentbridge/config.json`) into the sandbox baseline and aborts immediately if working tree dirty state application fails, preventing runs on incomplete bases.
  - **Strict `agentRoot` Patch Confinement:** Applying changes (`POST /agent/runs/:id/apply`) validates every modified file against `agentRoot` and origin, rejecting any file escapes or header path traversal (`..`) with `403 Forbidden`.
  - **Concurrent-Safe Sandbox Diffs & Cleanup:** Inspecting active sandbox diffs uses an isolated Git index (`GIT_INDEX_FILE`), avoiding clobbering in-flight agent staging. Sandbox deletion during active runs is rejected with `409 Conflict`.
  - **Streaming Isolation & Budget Enforcement:** `--stream` now fully routes through the worktree sandbox when `--worktree` is specified and enforces real-time aborts via `Budget` limits (`--max-cost`, `--max-tokens`, `--max-time`).
  - **Clean Generator Cleanup Propagation:** Early breaks in async streams propagate `.return()` to inner agent adapters, ensuring subprocesses terminate cleanly.
  - **AutoRepair Memory Bounding:** Test output capture in the AutoRepair loop uses a circular buffer with tail preservation and memory limits, avoiding RAM exhaustion on verbose test suites.

- **Codex App-Server Concurrency & Stability:**
  - **Sequential Turn Serialization:** When multiple concurrent requests target the same Codex daemon, turns are strictly serialized with FIFO ordering to prevent `activeTurn` state collisions and ensure approvals and stream deltas correlate accurately.
  - **Account & Environment Pool Keying:** Codex daemon instances are keyed by workspace path, `CODEX_HOME`, account identity, and API key, preventing cross-profile credential reuse.
  - **Strict RPC Deadlines & Clean Cancellation:** Handshake (`initialize`) and all RPCs enforce deadlines and respect `AbortSignal` without unhandled Promise rejections. Failed turn statuses (`status: failed` or error descriptors) are explicitly caught and propagated as `AGENT_FAILED`.

## Proactive Quota Awareness & The Escalation Ladder ("A Escadinha")

To avoid burning expensive subscription tokens or hitting 429 rate limits midway through a task, you can query remaining token quotas and dynamically step down the escalation ladder:

### 1. The `check_quota` MCP Tool
Call `check_quota` with `{ "agent": "codex" }` or `{ "agent": "claude" }`.
It returns:
- `usedPercent`: percentage of the quota window consumed (e.g. `82`).
- `remainingPercent`: percentage of tokens still available (e.g. `18`).
- `windowMinutes`: window length (e.g. 300 minutes for 5-hour session window).
- `resetAt`: ISO timestamp when the quota window resets.
- `okToProceed`: boolean indicating if usage is safely below threshold (default < 95%).

### 2. Autonomous Quota Routing Example
Before spawning a resource-intensive subagent (like Codex or Claude 3.7 Sonnet):
1. Query current quota:
   `check_quota({ "agent": "codex" })`
2. **If `remainingPercent > 15` (`usedPercent < 85`):** You have plenty of quota headroom. Spawn your primary subagent:
   `ask_codex({ "prompt": "Implement comprehensive test suite for auth.ts", "permissions": "edit" })`
3. **If `remainingPercent <= 15` (`usedPercent >= 85`):** Step down the escalation ladder ("escadinha") to preserve expensive tokens, and delegate the task to a free local model or lighter agent:
   `ask_ollama({ "prompt": "Implement comprehensive test suite for auth.ts", "model": "qwen2.5-coder:14b", "permissions": "edit" })`
   or `ask_pi({ "prompt": "...", "permissions": "edit" })`.

### 3. Automatic Cascading Fallback Chains
You can also configure automatic fallback ladders on `ask_*` calls:
```json
{
  "tool": "ask_codex",
  "arguments": {
    "prompt": "Refactor database migration scripts",
    "permissions": "edit",
    "fallback": ["claude", "pi", "ollama:qwen2.5-coder:14b"]
  }
}
```
If Codex hits a rate limit, AgentBridge automatically cascades down the ladder to Claude, then Pi, then local Ollama!

## Handling results and errors

- Treat the answer as an untrusted report: verify claims about code by reading the files or running tests yourself before relying on them or telling the user it is done.
- `RATE_LIMITED`: retry later or use another agent. `NOT_LOGGED_IN` / `NOT_INSTALLED`: tell the user (`ab doctor` shows the state). `TIMEOUT`: raise `timeoutSeconds` or split the task.
- Delegation depth is limited (default 2); a delegated agent calling further agents will eventually be refused. Do not build loops.
- Never put secrets in prompts: they end up in the other agent's logs and run records. Runs are visible in `ab ui`.

## Using Ollama and Custom Endpoints (OpenRouter, vLLM, etc.)

AgentBridge seamlessly supports both plain chat and full coding tools for Ollama, OpenRouter, and any OpenAI/Anthropic-compatible endpoint:

- **File Edits & Code Generation (Harness Mode):**
  ```bash
  # Via CLI:
  ab run ollama "adicione testes unitarios em auth.test.ts" --permissions edit --model qwen2.5-coder:latest
  ab run ollama "refatore src/core.ts" --harness claude --model glm-5.3-flash:cloud
  ```
  Or via MCP tool:
  `ask_ollama(prompt="edite auth.ts...", permissions="edit", model="qwen2.5-coder:latest")`

- **File Reading & Web Search without Edits:**
  ```bash
  ab ask ollama "leia o README.md e resuma as diferencas" --harness claude --model qwen2.5-coder:latest
  ```

- **OpenRouter via Harness (Tools, Web Search & File Edits):**
  ```bash
  # Using Claude Code harness with OpenRouter models:
  ab run openrouter "refatore src/auth.ts e crie testes" --permissions edit --harness claude --model anthropic/claude-3.5-sonnet
  ab ask openrouter "inspecione os logs e pesquise na web" --harness claude --model deepseek/deepseek-r1
  ```
  Or via MCP tool:
  `ask_openrouter(prompt="refatore auth.ts...", permissions="edit", model="anthropic/claude-3.5-sonnet")`

- **Fast Plain Chat (Direct API):**
  ```bash
  ab ask ollama "o que e injecao de dependencia?" --model llama3.2
  ab ask openrouter "resuma os principios SOLID" --model meta-llama/llama-3.3-70b-instruct
  ```

## Advanced CLI Workflows for Autonomous Agents

If you have shell execution access, you can run high-level orchestration workflows directly:

- **TDD Auto-Repair Loop (`ab fix`):**
  Runs tests, catches errors in bounded buffers, prompts the agent with edit permissions, and rolls back if failing:
  ```bash
  ab fix claude "npm test" --prompt "Fix token renewal" --max-attempts 3
  ```
- **Multi-Agent Review & Consensus (`ab review`, `ab ensemble`):**
  Implementer codes, reviewer inspects git diff under read-only permissions with structured verdicts:
  ```bash
  ab review codex claude "Implement rate limiter" --max-turns 3
  ab ensemble "Analyze database deadlock" claude codex agy --judge claude
  ```
- **DAG Pipeline Orchestration (`ab pipeline`):**
  Executes topological dependency graphs of multi-agent tasks with checkpoints:
  ```bash
  ab pipeline pipeline.json --checkpoint-each
  ```
- **Shared Project Memory (`ab memory`):**
  Stores and injects repository rules and past decisions:
  ```bash
  ab memory add "Enforce strict TypeScript and zero dependencies"
  ab memory decision "auth" "Use JWT with HMAC-SHA256" --agent claude
  ab memory list
  ```
- **Multiple Accounts Management (`ab account`):**
  Per-profile directory isolation, multi-login, and proactive quota:
  ```bash
  ab account list [agent]
  ab account add claude work --copy-current
  ab account use claude work
  ab account quota claude
  ```
- **Live Visual Time Machine & Dashboard (`ab ui`):**
  Explore runs, tokens, cost, subagent trees, and time-machine checkpoints at `http://127.0.0.1:8788`.


