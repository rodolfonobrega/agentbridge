# README_AI.md — The AI Agent Guide for AgentBridge

> **Target Audience:** This document is written specifically for **AI Agents** (Claude Code, OpenAI Codex, Antigravity, OpenCode, Pi, Cursor, Devin, and autonomous frameworks like GEPA). If you are an AI assistant or autonomous agent operating in or interacting with this codebase, read this document to understand your capabilities, how to use the CLI and MCP tools, how to delegate tasks to subagents, and how to avoid common pitfalls.

---

## 1. Core Philosophy: "O Agent Pode Tudo" (Full Freedom by Default)

AgentBridge is built on the philosophy that autonomous coding agents should not be artificially handcuffed:
- **`permissions` defaults to `read-only`:** The safety lock is engaged on every run unless you (or the operator) elevate it (`src/core/config.ts`). You can read files and search the web, but you cannot edit files or run shell commands until the task is granted more.
- **Elevate deliberately, not arbitrarily:** Request `permissions: "edit"` or `"full"` explicitly when a task needs it, or configure a persistent default via `AGENTBRIDGE_DEFAULT_PERMS` (the installer's `--default-permissions`). The ceiling (`AGENTBRIDGE_PERMS` / `AGENTBRIDGE_PERMS_CEILING`, default `full`) is the hard circuit-breaker no request can exceed.
- **Fail-safe isolation available on demand:** When safety is needed for risky refactors, AgentBridge provides **Git Checkpoints** (`ab checkpoint`) and **Git Worktrees** (`--worktree`) so you can experiment freely with instant rollback.

---

## 2. What AgentBridge Is & What It Does

AgentBridge is a unified hub and orchestration bridge that connects every coding agent and LLM installed on the machine:

```
                      ┌────────────────────────────────────────┐
                      │   Orchestrator Agent (You) / Scripts   │
                      └───────────────────┬────────────────────┘
                                          │
                      ┌───────────────────▼────────────────────┐
                      │              agentbridge               │
                      │  CLI · MCP Bridge · Compat Proxy · Git │
                      └─┬─────────┬─────────┬────────┬────────┬┘
                        │         │         │        │        │
                     Claude     Codex    OpenCode   pi     Ollama /
                      Code      (OAI)               (Dev)  Endpoints
```

### Key Capabilities:
1. **Zero API Keys Needed:** Drives your locally installed agent CLIs (`claude`, `codex`, `opencode`, `agy`, `pi`) using the user's existing consumer/subscription logins (ChatGPT Plus/Pro, Claude Pro/Team/Max, etc.).
2. **Agent-to-Agent Delegation (MCP Bridge):** Any agent can spawn and control any other agent as a subagent (`ask_codex`, `ask_claude`, `ask_pi`, `ask_ollama`, etc.).
3. **OpenAI & Anthropic Compatible Proxy (`ab serve`):** Serves local subscriptions as an HTTP API on `http://127.0.0.1:8787/v1` for BYOK (Bring Your Own Key) apps and frameworks (GEPA, Cursor, LibreChat).
4. **Resilience & Fallbacks:** Automatic detection of rate limits / quota lockouts (`RATE_LIMITED`) and automatic handover to fallback agents.
5. **Git Checkpoints:** Non-destructive snapshots in hidden git refs (`refs/agentbridge/checkpoints/...`) for 1-second rollbacks of modified and untracked files.

---

## 3. Quick Reference for Agents

### CLI Commands You Can Run

| Command | What it does | When to run it |
|---|---|---|
| `ab doctor` | Probes all installed CLIs, logins, and endpoints | First diagnostic step if a delegation fails |
| `ab doctor --live` | Probes CLIs and performs a real live test ping on each | Verify that tokens and accounts are currently working |
| `ab ask <agent> "<prompt>"` | Executes a synchronous run on `<agent>` and prints the output | Quick second opinion or targeted subtask |
| `ab run <agent> "<prompt>" --stream` | Runs `<agent>` streaming live tokens and tool events | Interactive or detailed executions |
| `ab race "<prompt>" <agent1> <agent2>` | First agent with an accepted answer wins, cancels others | Hedging fast models against complex prompts |
| `ab fanout "<prompt>" <agent1> <agent2>` | Runs prompt across multiple agents and collects all answers | Code reviews, contrasting architecture plans |
| `ab fix <agent> "<test-cmd>"` | Autonomous TDD auto-repair loop with rollback on failure | Self-healing broken code or tests automatically |
| `ab review <coder> <reviewer> "<task>"` | Two-agent implementer/reviewer loop with git diff inspection | High-assurance code generation with peer critique |
| `ab ensemble "<task>" <a1> <a2>...` | Parallel multi-agent execution with plurality voting / judge | Critical consensus decision-making |
| `ab pipeline <pipeline.json>` | Executes DAG task workflows with topological wave parallelization | Multi-step agent dependency plans |
| `ab checkpoint create "<msg>"` | Takes an instant zero-overhead git snapshot | **Before** making large or risky file refactors |
| `ab checkpoint rollback <id>` | Restores repository state to checkpoint (untracked + modified) | If your changes break tests and you need a clean reset |
| `ab memory add "<rule>"` / `decision` | Records conventions and architectural decisions in project | Enforcing persistent team standards |
| `ab account list` / `add` / `use` | Manages isolated multiple account profiles per agent CLI | Rotating accounts or multi-identity testing |
| `ab quota [agent]` | Queries proactive token/time usage limits | Pre-checking quotas before long jobs |
| `ab serve --port 8787` | Starts the OpenAI/Anthropic compat proxy server | Connecting BYOK applications or GEPA |
| `ab ui --open` | Launches the local telemetry dashboard (`http://127.0.0.1:8788`) | Inspecting real-time tokens, costs, run lineage |
| `ab install all --permissions full` | Installs/updates the MCP bridge across all agents | Registering MCP server or resetting permission ceiling to full |

---

## 4. MCP Delegation: Calling Other Agents as Subagents

When the user or another agent asks you to delegate work, use the `agentbridge` MCP tools:

### Available Tools:
- **`ask_<agent>(prompt, model?, effort?, permissions?, cwd?, timeoutSeconds?, transport?, mcpPassthrough?, skills?)`**:
  Synchronous tool call. Blocks until the target agent finishes, returning the text, usage, and session ID.
  Available agents: `ask_claude`, `ask_codex`, `ask_opencode`, `ask_agy`, `ask_pi`, `ask_ollama` (and any custom endpoints).
  - Use `transport: "app-server"` for Codex to run a persistent warm JSON-RPC daemon (zero cold start, real-time approval handling).
- **`dispatch_<agent>(prompt, ...)`**:
  Asynchronous dispatch. Returns a `runId` immediately.
- **`wait_run(id, timeoutSeconds?)`**:
  Waits for an async run to finish.
- **`check_run(id)`**:
  Polls progress, status, tokens, and recent events of an async run.
- **`cancel_run(id)`**:
  Kills the child agent process (or cleanly cancels active turn in `app-server` mode).
- **`checkpoint_create(message, cwd?)`**, **`checkpoint_list(cwd?)`**, **`checkpoint_diff(id, cwd?)`** & **`checkpoint_rollback(id, cwd?)`**:
  Git hidden-ref snapshots callable directly from MCP for fail-safe code modification.

### Delegation Best Practices for Agents:
1. **Write self-contained prompts:** The subagent does NOT share your conversation history. Provide exact file paths, desired behavior, and constraints.
2. **Always set `cwd`:** Pass the absolute path of the target repository so the subagent operates in the right directory.
3. **Pass `permissions: "edit"` or `"full"` when modifying code:** For security, the system default is `read-only`. When delegating tasks that require modifying code, creating files, or executing shell commands, you **must explicitly pass `permissions: "edit"` or `permissions: "full"`**. The permission ceiling defaults to `full`.
4. **Parallel execution with `dispatch`:** If you need 3 independent tasks done (e.g. tests for module A, B, and C), call `dispatch_*` 3 times and then `wait_run` on each.
5. **Verify results:** Never blindly accept code claims from a subagent. Inspect the modified files and run test suites before presenting the task as complete to the user.

---

## 5. The Safety Lock & Permission Ceilings

### Why Safe-by-Default Matters
Most autonomous agent frameworks run in unrestricted or "yolo" mode by default. This creates catastrophic risk: a routine prompt asking "Audit auth.ts" or an unmonitored subagent hallucination can overwrite working code or run destructive shell scripts.

AgentBridge implements an active **Zero-Accident Safety Lock**:
1. **Engaged by Default (`read-only`):** All delegations and CLI calls run with the safety lock engaged. Write tools and shell execution are physically omitted or sandboxed.
2. **Intentional Unlocking:** When a subagent needs to modify files or execute build/test commands, you must explicitly pass `permissions: "edit"` or `permissions: "full"`.
3. **Inviolable Ceiling Circuit-Breaker:** The ceiling defaults to `full`, but if configured to `edit` or `read-only`, no subagent can ever break out of or elevate past that ceiling.

| Permission Level | Rank | Capabilities | Default Role |
|---|---|---|---|
| `read-only` | 0 | Can read files and search web. **Cannot edit files. Cannot run shell.** | **Safety Lock Engaged (Default)** |
| `plan` | 1 | Can read files and plan solutions. **Cannot edit files. Cannot run shell.** | Explicit opt-in |
| `edit` | 2 | Can read and **edit/write workspace files**. **Cannot run arbitrary shell.** | Intentional Unlock (File Edits) |
| `full` | 3 | **Unrestricted.** Can run bash/PowerShell, edit files, install packages, run tests. | **Default Ceiling** (Full Unlock) |

You can customize the persistent default per project or globally:
```bash
ab config set default-permissions edit   # Sets default to edit
ab config get default-permissions       # Prints active default
ab config set permissions-ceiling edit  # Hard ceiling circuit-breaker
```

### The "Exceeds the permission ceiling" Error
If you or a subagent request `permissions: "full"` and receive an error like:
```
permissions "full" exceeds the configured permission ceiling "edit" (increase ceiling or configure permission)
```
(the same applies against a `"read-only"` ceiling), this means the MCP server in the host agent configuration was previously registered with a restricted ceiling (`AGENTBRIDGE_PERMS` / `AGENTBRIDGE_PERMS_CEILING="edit"` or `"read-only"`).

### How to Fix It:
Run this command in the terminal to elevate the ceiling to `full`:
```bash
ab install all --permissions full
```
Or for a specific agent:
```bash
ab install claude --permissions full
ab install codex --permissions full
```
Once updated, all subagents can freely execute `permissions: "full"`.

---

## 6. Harness Isolation: MCPs, Skills & Tool Readiness Check

### Why Subagents Don't Inherit All Host MCPs By Default
When delegating to subagents via `ask_*` or `dispatch_*`:
1. **Isolated Sandboxes:** Harnesses like **Pi (`pi`)**, **Claude Code (`claude`)**, and **Antigravity (`agy`)** are spawned inside isolated ephemeral directories.
2. **Hidden Third-Party MCPs:** By default, their configuration files are replaced with a minimal config that contains **only** the `agentbridge` connection. Local MCP servers (e.g. `rea`, custom database tools) and user plugins/skills in `~/.pi/agent/mcp.json` or `.mcp.json` are **omitted from child runs**.
3. **Pi Exposure Mode (`direct` vs `deferred`):** If configuring Pi with custom MCP tools, always ensure `"exposure": "direct"`. The `"deferred"` exposure mode does not advertise tool definitions to the LLM.
4. **Offline and Permission Gates:**
   - Passing `offline: true` strictly blocks external MCP passthrough.
   - Restricting permissions to `read-only` or `plan` suppresses mutating tools and arbitrary command execution.

### How to Let a Child Use Your MCPs and Skills
- **Operator (ceiling):** register the bridge with `AGENTBRIDGE_MCP_PASSTHROUGH=rea` (list, or `*`), optionally `AGENTBRIDGE_MCP_SOURCE_DIR` and `AGENTBRIDGE_ENABLE_SKILLS=1`. Without it, nothing is passed.
- **Caller (per call):** `ask_pi({ prompt, permissions: "edit", mcpPassthrough: ["rea"], skills: true })`. The call can only pick a subset of the operator allowlist.
- Only stdio servers are passed, with `exposure: "direct"`. The project `.mcp.json` (up to the git root) is a source too.
- Skills: Pi gets your skills linked into its per-run home; project `.agents/skills` / `.claude/skills` are found up to the git root, and uncommitted ones are copied into `--worktree` sandboxes.
- New accounts (`ab account add`) share skills, prompts, plugins and Codex MCP servers with your main setup but keep their own login (`--no-share` to start empty).

### Pre-Flight Checklist Before Delegating Tasks Needing Special Tools:
- [ ] **Check with `ab doctor`:** Run `ab doctor` to see all host MCP servers detected across local agent configurations.
- [ ] **Probe Subagent Tools:** Run `ask_<agent>({ "prompt": "List your available tools", "permissions": "read-only" })` to verify what tools the child agent can see.
- [ ] **Direct Execution Rule:** If a critical tool (like `rea` or a proprietary browser MCP) is only registered in your host agent and cannot be passed through, execute that task directly in your current session rather than delegating it to an isolated subagent.

---

## 7. Proactive Quota Routing & The Escalation Ladder ("A Escadinha")

### How to Check Quota Proactively
You do not need to wait for an HTTP 429 error or a rate limit exception to occur. When connected via MCP or executing CLI tasks, you can query real-time remaining token quotas:

- **Via MCP Tool (`check_quota`):**
  ```json
  {
    "tool": "check_quota",
    "arguments": {
      "agent": "codex"
    }
  }
  ```
  Returns structured quota health:
  ```json
  {
    "agent": "codex",
    "usedPercent": 82,
    "remainingPercent": 18,
    "windowMinutes": 300,
    "resetAt": "2026-10-09T18:00:00.000Z",
    "okToProceed": true,
    "formatted": "[codex] 82% used (300m window, reset: 2026-10-09T18:00:00.000Z) - OK"
  }
  ```

### The Autonomous Routing Pattern
When coordinating complex workflows or spawning subagents, follow this pattern:
1. **Query Quota:** Call `check_quota({ agent: "codex" })` (or `claude`).
2. **Evaluate Remaining Capacity:**
   - **Above 15% Remaining (`usedPercent < 85`):** You have sufficient headroom. Spawn your primary subagent:
     `ask_codex({ prompt: "Write unit tests for auth.ts", permissions: "edit" })`
   - **15% or Less Remaining (`usedPercent >= 85`):** Preserve your expensive quota for critical architectural decisions. Step down the escalation ladder ("escadinha") and delegate the task to a local zero-cost model:
     `ask_ollama({ prompt: "Write unit tests for auth.ts", model: "qwen2.5-coder:14b", permissions: "edit" })`
     or `ask_pi({ prompt: "...", permissions: "edit" })`.

### The Automatic Escalation Ladder ("A Escadinha")
AgentBridge automatically executes this cascade if you configure fallback targets:
- **In CLI:**
  ```bash
  ab ask codex "Refactor the module" --fallback claude,pi,ollama:qwen2.5-coder:14b
  ```
- **In MCP Tool calls:**
  ```json
  {
    "tool": "ask_codex",
    "arguments": {
      "prompt": "Refactor the module",
      "permissions": "edit",
      "fallback": ["claude", "pi", "ollama:qwen2.5-coder:14b"]
    }
  }
  ```

---

## 8. Using Local Endpoints & Models (Ollama, OpenRouter, vLLM)

AgentBridge can run local models (e.g., `qwen2.5-coder`, `glm-5.3-flash:cloud`, `deepseek-r1`) as full coding agents via **harness mode**:

- **Plain Chat vs Harness:**
  - A plain endpoint (`ab ask ollama "hello"`) only does text generation with no tool capabilities.
  - Passing `--permissions full` or `--permissions edit` automatically activates the **agent execution harness** (`claude` or `pi`), giving the local model file editing, bash, grep, and terminal tools!
- **Example via CLI:**
  ```bash
  ab run ollama "Fix failing tests in auth.test.ts" --model qwen2.5-coder:32b --permissions full
  ```
- **Example via MCP Tool:**
  ```json
  {
    "tool": "ask_ollama",
    "arguments": {
      "prompt": "Inspect src/auth.ts and add missing unit tests",
      "model": "glm-5.3-flash:cloud",
      "harness": "pi",
      "permissions": "full"
    }
  }
  ```

---

## 9. The Compat Proxy (`ab serve`) for BYOK & Agentic Frameworks (e.g. GEPA)

If you are integrating AgentBridge with an external BYOK application (Cursor, LibreChat, Continue.dev) or an autonomous prompt optimization engine like **GEPA**:

Start the proxy:
```bash
ab serve --port 8787
```

### Modes & Code Examples:
1. **API Mode (Default - `/v1/chat/completions`):**
   - Base URL: `http://127.0.0.1:8787/v1`
   - Model name: `claude/haiku`, `codex/gpt-5`, `agy/gemini-3.8-flash-low`, `pi/ollama/qwen3:14b`, etc.
   - Operates as a standard OpenAI/Anthropic LLM API, using the user's subscription behind the scenes.

   **Python (Official `openai` SDK):**
   ```python
   from openai import OpenAI

   client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
   stream = client.chat.completions.create(
       model="claude/haiku",
       messages=[{"role": "user", "content": "Write a distributed task worker in Go."}],
       stream=True,
   )
   for chunk in stream:
       print(chunk.choices[0].delta.content or "", end="", flush=True)
   ```

   **TypeScript / Node.js (Official `openai` SDK):**
   ```typescript
   import OpenAI from 'openai';

   const client = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'not-needed' });
   const response = await client.chat.completions.create({
     model: 'codex/gpt-5.6-luna',
     messages: [{ role: 'user', content: 'Generate database migration for PostgreSQL.' }],
   });
   console.log(response.choices[0]?.message?.content);
   ```

2. **Agent Mode (`/agent/v1` or model `agent/<agent>/<model>`):**
   - Executes in an isolated **git worktree** pointing to the workspace folder (`x-ab-cwd`).
   - The agent receives native file-editing tools; permissions default to `edit` and can be raised with the `x-ab-permissions` header (e.g. `full`).
   - Returns structured diffs and run metadata:
     ```json
     {
       "agentbridge": {
         "runId": "run-abc123",
         "filesChanged": ["src/auth.ts"],
         "diff": "diff --git a/src/auth.ts b/src/auth.ts\n..."
       }
     }
     ```
   - Diff endpoints: `GET /agent/runs/:id/diff` and `POST /agent/runs/:id/apply` to merge changes back to the main repository.

   **Python (Agent Sandbox Mode):**
   ```python
   from openai import OpenAI

   client = OpenAI(base_url="http://127.0.0.1:8787/agent/v1", api_key="token-if-configured")
   res = client.chat.completions.create(
       model="agent/claude/sonnet",
       messages=[{"role": "user", "content": "Implement structured logging across src/"}],
       extra_headers={
           "x-ab-cwd": "/path/to/my-repo",
           "x-ab-permissions": "edit"
       }
   )
   # Inspect generated git diff returned in res.model_extra["agentbridge"]["diff"]
   ```

---

## 10. Summary Checklist for AI Agents

- [ ] Need to make risky changes? Run `ab checkpoint create "before refactor"`.
- [ ] Need a second opinion on code? Call `ask_codex` or `ask_claude` with `permissions: "full"`.
- [ ] Need to run tasks in parallel? Call `dispatch_*` and collect with `wait_run`.
- [ ] Hit an error `permissions exceeds the configured permission ceiling`? Run `ab install all --permissions full`.
- [ ] Need to verify what agents and host MCPs are available? Run `ab doctor`.
- [ ] Delegating a task requiring special MCP tools (e.g. `rea`)? Confirm the destination harness has the MCP configured with `"exposure": "direct"` and proper permissions (`permissions: "edit"` / `"full"`), or execute directly on the host agent.
- [ ] Want low-latency, warm multi-turn execution with Codex? Use `transport: "app-server"`.
- [ ] Want to monitor real-time runs and tokens? Check `ab ui` at `http://127.0.0.1:8788`.
