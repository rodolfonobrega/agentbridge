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

## When to use which

- **Short, bounded task (under ~2 min):** `ask_<agent>`.
- **Long task, or several in parallel:** `dispatch_<agent>` for each, keep working, then `wait_run` on every id. Use an `idempotencyKey` so a retry does not start a duplicate.
- **Second opinion or review:** ask a *different* agent than the one that wrote the code; give it the file paths and the question, not your conclusion.
- **Cheap bulk work (summaries, searches, boilerplate):** pick a cheap model/agent; reserve strong models for hard problems.

## Writing the delegated prompt

The other agent has none of your context. Give it: the goal, the exact files/paths, constraints, and the form the answer should take. Set `cwd` to the project folder. Ask it to be concise.

## Permissions and Sandboxing: How Edits are Blocked vs Allowed

AgentBridge enforces strict permissions at the runtime level. An agent cannot exceed your permission ceiling:

| Permission | Filesystem & Tools Allowed | When to Use | Under the Hood Enforcement |
|---|---|---|---|
| `full` *(default)* | **All tools allowed**, including shell/bash execution. | Code edits, test runs, builds, package installs, automated fixes. | Bypasses permission prompts; full execution sandbox. |
| `edit` | Read, Grep, Glob, WebFetch, WebSearch + **File Write & Edit**. (Bash blocked). | Refactoring, bug fixes, file creation & code edits without arbitrary shell. | Unlocks Write/Edit tools; workspace-write sandbox restricted to cwd. |
| `plan` | Read, Grep, Glob, WebFetch, WebSearch. **No edits, no bash.** | Solution design, checklist proposals, diff reviews. | Read-only sandbox with plan prompt mode; writes blocked. |
| `read-only` | Read, Grep, Glob, WebFetch, WebSearch. **No edits, no bash.** | Reviews, code audits, questions, file inspection. | Tool allowlists exclude Write/Edit/Bash; OS-level sandbox enforces read-only; write deny rules. |

> **How AgentBridge Prevents Edits:**
> In `read-only` and `plan` modes, write tools (`Write`, `Edit`, `Bash`) are physically omitted from tool definitions passed to Claude Code and Pi (`--tools Read,Glob,Grep,WebFetch,WebSearch` / `--exclude-tools write,edit,bash`). Codex is placed in an OS container sandbox (`--sandbox read-only`), and Antigravity gets a throwaway profile with explicit deny rules (`write_file(*)`). The model literally cannot mutate your files.

## Options that matter

- `permissions`: `full` (default), `edit`, `plan`, `read-only`. Use `full` to give the agent unrestricted powers; downgrade only when sandboxing is requested.
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

## Delegating to Subagents

When you instruct an agent (such as `pi` or `claude`) to spawn or coordinate subagents:
- The permission ceiling defaults to `full`, meaning subagents can run tools, shell commands, and file edits without being capped at read-only/edit.
- Model names specified for subagents (e.g. `glm-5.3-flash:cloud`) are automatically resolved so the child process maps them to the correct local or remote provider seamlessly.
- You can monitor running subagents and active agent counts in real time via `ab ui`.

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

