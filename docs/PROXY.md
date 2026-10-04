# agentbridge compat proxy

Serves the models of your locally installed and logged-in agent CLIs (`claude`, `codex`, `opencode`) as an
OpenAI-compatible and Anthropic-compatible HTTP API. Point an app's base URL at it; no API keys needed.

```
node src/server/index.mjs --port 8787 [--token SECRET]
# OpenAI SDK:    baseURL = http://127.0.0.1:8787/v1
# Anthropic SDK: baseURL = http://127.0.0.1:8787
```
Programmatic: `import { startProxy } from './src/server/index.mjs'; const p = await startProxy({ port: 0 });`

## WARNING: terms of service
This routes requests made with your **subscription logins** (Claude, ChatGPT/Codex, etc.) through a local proxy.
Providers may consider that a violation of their terms (automated/programmatic use of consumer plans, account
sharing, third-party harnesses). Use it for **personal, local use only**. Never expose it to other people or the
network, do not resell or share access, and use API keys if you need a supported programmatic path. You are
responsible for compliance.

## Endpoints
| Route | Notes |
|---|---|
| `POST /v1/chat/completions` | stream (SSE, `[DONE]`, `stream_options.include_usage`) and non-stream |
| `POST /v1/responses` | stream (`response.*` events) and non-stream; `instructions`, `reasoning.effort`, `text.format` |
| `POST /v1/messages` | Anthropic; full event sequence `message_start, content_block_start, ping, content_block_delta*, content_block_stop, message_delta, message_stop` |
| `POST /v1/messages/count_tokens` | estimate only (~chars/4) |
| `GET /v1/models` | OpenAI list, or Anthropic list when `anthropic-version`/`x-api-key` header is present |

## Model routing
`claude/<model>`, `codex/<model>`, `agy/<model>`, `pi/<provider>/<model>`, `opencode/<provider>/<model>`, and `<endpoint>/<model>` for configured HTTP endpoints (e.g. `ollama/qwen3:14b`). Bare names by heuristics: `sonnet|haiku|opus|claude-*`
-> claude; `gpt-*|o1/o3/o4|codex*` -> codex; anything with a `/` -> opencode. Otherwise 404
(`model_not_found` / Anthropic `not_found_error`).

## Parameter mapping
- `system`/`developer` messages, Anthropic `system`, Responses `instructions` -> agent `systemPrompt`.
- `reasoning_effort`, `reasoning.effort`, `output_config.effort`, Anthropic `thinking.budget_tokens`, or a model suffix
  (`claude/sonnet(high)`, `codex/gpt-5(16384)`) -> `effort` (if the agent/model rejects it, it is dropped and the request retried once).
- `response_format`/`text.format` `json_schema` -> `jsonSchema` (agent permitting); `json_object` -> instruction.
- `max_tokens` / `max_output_tokens` and `stop` are **enforced by the proxy** (about chars/4 for tokens): the CLI is stopped and the
  reply ends with `finish_reason: length` / `stop_reason: max_tokens` / `stop_sequence`. `temperature`, `top_p`, `seed` and penalties are
  accepted and ignored (never rejected); the ignored names are listed in the `x-agentbridge-ignored` response header.
- Usage and `stop_reason` come from the CLI when it reports them (claude does), else they are estimated.
- Sessions: send `x-ab-session: <id>` and the proxy resumes the CLI session (claude/codex) and sends only the new turns. The key is
  scoped to your credential. Without it every request is stateless (the history is flattened into one prompt, trimmed to
  `historyBudgetTokens` of the config).
- Client disconnect -> `AbortSignal` -> the CLI process is killed.
- Errors: OpenAI `{error:{message,type,param,code}}`; Anthropic `{type:"error",error:{type,message}}`. Status:
  400 bad request/option, 401 bad token or agent not logged in, 403 agent mode refused, 404 unknown model, 429 rate limited,
  502 agent failure, 503 CLI not installed, 504 timeout. Mid-stream failures are sent as an SSE error event.

## Config file (`--config file.json`, hot reloaded)
```json
{ "aliases": { "fast": "claude/haiku" },
  "payload": [{ "match": "codex/*", "defaults": { "effort": "medium" } }],
  "agentRoot": "C:/work", "maxPermission": "edit", "historyBudgetTokens": 0 }
```
A bad reload keeps the previous config. Requests in flight keep the config they started with.

## Two modes
**API mode** (default): plain chat. Read-only, throw-away temp dir, the agent's own tools are off.

**Agent mode**: the agent edits files. Select it with the model prefix `agent/` (`agent/claude/sonnet`) or the base path
`/agent/v1`. It works in an **isolated copy** (git worktree, or a temp copy of a non-git folder), never in your folder:
- Off unless the server was started with `--agent-root <dir>` **and** a token. Always loopback.
- `x-ab-cwd`: folder to work on, inside the agent root; anything resolving outside it is a 403.
- `x-ab-permissions`: `read-only|edit|full`, never above `--agent-max-permission` (default `edit`).
- `x-ab-session`: reuse the same sandbox and CLI session across requests.
- The reply carries `agentbridge: { runId, filesChanged, diff }` (and the header `x-agentbridge-run`). Routes: `GET /agent/runs`,
  `GET /agent/runs/:id`, `GET /agent/runs/:id/diff`, `POST /agent/runs/:id/apply` (git apply into the real folder; 409 on conflict),
  `DELETE /agent/runs/:id`. Nothing touches your folder until you call `apply`. Runs expire after 30 minutes.
- Client `tools` are refused in agent mode (the agent has its own).

## Tool calling
Whenever a request carries `tools` (OpenAI `tools`/`tool_choice`, Responses `function` tools, Anthropic `tools`), the proxy answers with
`tool_calls` / `function_call` items / `tool_use` blocks, and accepts the tool results on the next request.
- **claude**: the schemas are served to the CLI through a small MCP stub; when it calls one, the proxy stops the CLI and hands the call to you.
- **codex, opencode, agy, pi, endpoints**: prompt emulation (`<tool_call>{...}</tool_call>`), validated against your JSON schema, one corrective
  retry. If the output still cannot be parsed it is returned as plain text with `x-agentbridge-warning`. Best effort; quality varies by model.
- Replies are buffered in tool mode (no live token streaming), and a fallback chain is not used with claude's bridge. Hosted tools
  (`web_search` ...) are a 400 `tools_not_supported`.

## Account pool (off by default, at your own risk)
`--accounts accounts.json --accept-tos-risk` (or `AGENTBRIDGE_ACCEPT_TOS_RISK=1`) spreads requests over several logins of **your own**,
each one a CLI config dir. Without the second flag the server refuses to start. Rotating accounts can violate a provider's terms of
service; that is your decision and risk. Nothing is hidden or faked toward the provider. Remove the flag to turn it off.
```json
{ "strategy": "round-robin",
  "claude": [{ "name": "work", "env": { "CLAUDE_CONFIG_DIR": "C:/cfg/work" } }, { "name": "home", "env": { "CLAUDE_CONFIG_DIR": "C:/cfg/home" } }],
  "codex":  [{ "name": "a", "env": { "CODEX_HOME": "C:/cfg/codex-a" } }] }
```
Strategies: `round-robin`, `fill-first`, `sticky` (per `x-ab-session`). A `RATE_LIMITED` account goes into cooldown (its `retry-after`, else
30 min for quota, 60 s for rate, 30 s for overloaded) and the request moves to the next account before any fallback agent.
When every account is cooling down the answer is 429. The pool is read at startup (no hot reload).

## Observability
`GET /admin/status` (pool and cooldowns, no secrets) and `GET /admin/usage` (requests, tokens, latency per agent/model/account/mode).
Without a token they are only served on loopback. `--log file.jsonl` appends one line per run (no prompts or replies).

## Limits (honest list)
- Tool mode is buffered; emulated tool calls depend on the model. Usage is an estimate when the CLI had to be stopped early.
- `max_tokens` is approximate (chars/4). `n` must be 1. Assistant prefill is rejected.
- Images (data: or public http(s) URLs, up to 8 x 10 MB, png/jpeg/gif/webp) reach **claude, codex and opencode**; URLs are fetched with an SSRF guard (private, loopback and link-local addresses refused, redirects re-checked). Other agents get a `[image]` placeholder and an `x-agentbridge-warning: images_not_supported` header. With a resumed session the images of the request are sent again.
- `count_tokens` is always an estimate.
- Streaming granularity depends on the CLI (some emit large chunks). Latency is CLI start-up time (seconds).
- Binds `127.0.0.1` only; other hosts are refused unless `allowNonLoopback` / `--allow-non-loopback`.
  Optional bearer token (`Authorization: Bearer` or `x-api-key`), `--token` or `AGENTBRIDGE_TOKEN`.

## Rate limits
A `RATE_LIMITED` failure is answered with HTTP 429 and a `retry-after` header (seconds) in both the OpenAI and Anthropic shapes. `ab serve --fallback a,b` applies a fallback chain to every request. A limit hit after text was already streamed cannot be re-routed and ends the stream with the error (the first ~160 chars / 1.5 s are held back when a chain exists, so early limits still fall back cleanly).
