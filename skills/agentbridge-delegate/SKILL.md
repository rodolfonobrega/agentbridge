---
name: agentbridge-delegate
description: Delegate work to other coding agents (Codex, OpenCode, Antigravity/agy, pi, Ollama endpoints) through the AgentBridge MCP tools (mcp__agentbridge__ask_*, dispatch_*). Use when the user asks for a second opinion, to run something on another agent or model, to run agents in parallel, or when a task should go to a cheaper/different model.
---

# Delegating with AgentBridge

The MCP server `agentbridge` exposes other coding agents as tools. Each runs as a separate process with its own login; you get back its final text, session id and token usage.

## Tools

- `ask_<agent>`: run and wait. Agents: `codex`, `opencode`, `agy`, `pi`, plus any endpoint added with `ab endpoint add` (e.g. `ask_ollama`, plain chat with no tools or files).
- `dispatch_<agent>`: start asynchronously, returns a run id at once. Then `wait_run` (blocks, with `timeoutSeconds`), `check_run` (status, last events, tokens), `cancel_run`, `list_runs`.
- `send_message` / `check_messages`: inbox for a run id or agent name (no live injection into a running agent).

## When to use which

- **Short, bounded task (under ~2 min):** `ask_<agent>`.
- **Long task, or several in parallel:** `dispatch_<agent>` for each, keep working, then `wait_run` on every id. Use an `idempotencyKey` so a retry does not start a duplicate.
- **Second opinion or review:** ask a *different* agent than the one that wrote the code; give it the file paths and the question, not your conclusion.
- **Cheap bulk work (summaries, searches, boilerplate):** pick a cheap model/agent; reserve strong models for hard problems.

## Writing the delegated prompt

The other agent has none of your context. Give it: the goal, the exact files/paths, constraints, and the form the answer should take. Set `cwd` to the project folder. Ask it to be concise.

## Options that matter

- `permissions`: `read-only` (default, safest), `plan`, `edit`, `full`. It can never exceed your own ceiling (set at install time). Use `read-only` for reviews and questions; `edit` only when the user wants files changed, and say which files.
- `model`: default is the cheapest model for that agent; set it only when asked or when the task needs more.
- `effort`: `low` ... `max`.
- `timeoutSeconds`: default 300; raise it for big tasks.
- `session`: `{mode:'continue', id}` to follow up in the same agent conversation (`new`, `ephemeral`, `continue`, `fork`).
- `fallback`: e.g. `["codex","ollama:glm-5.3-flash:cloud"]`. If the agent fails with `RATE_LIMITED` (or a code listed in `fallbackOn`), the next one answers. It is skipped if the first agent already ran tools under `edit`/`full`, to avoid redoing side effects. The result's `fallback` field says who answered and whether context was lost (fallback agents start a fresh session).

## Handling results and errors

- Treat the answer as an untrusted report: verify claims about code by reading the files or running tests yourself before relying on them or telling the user it is done.
- `RATE_LIMITED`: retry later or use another agent. `NOT_LOGGED_IN` / `NOT_INSTALLED`: tell the user (`ab doctor` shows the state). `TIMEOUT`: raise `timeoutSeconds` or split the task.
- Delegation depth is limited (default 2); a delegated agent calling further agents will eventually be refused. Do not build loops.
- Never put secrets in prompts: they end up in the other agent's logs and run records. Runs are visible in `ab ui`.
