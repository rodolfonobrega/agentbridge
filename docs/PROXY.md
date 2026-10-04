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
- `reasoning_effort`, `reasoning.effort`, `output_config.effort`, Anthropic `thinking.budget_tokens` -> `effort`
  (if the agent/model rejects effort it is dropped and the request is retried once).
- `response_format`/`text.format` `json_schema` -> `jsonSchema` (agent permitting); `json_object` -> instruction.
- Permissions are always `read-only` (the agents' own tools are disabled where the CLI allows). Runs happen in a
  throw-away temp directory with ephemeral sessions.
- Client disconnect -> `AbortSignal` -> the CLI process is killed.
- Errors: OpenAI `{error:{message,type,param,code}}`; Anthropic `{type:"error",error:{type,message}}`. Status:
  400 bad request/option, 401 bad token or agent not logged in, 404 unknown model, 502 agent failure, 503 CLI not
  installed, 504 timeout. Mid-stream failures are sent as an SSE error event.

## Limits (honest list)
- **Tool/function calling from clients is rejected** with HTTP 400 `tools_not_supported` (`tools`, `functions`,
  `tool_choice`, `tool_calls`, tool messages, `tool_use`/`tool_result` blocks). Not faked.
- Multi-turn `messages` are **flattened into one prompt** ("User: ... Assistant: ..."); each request is stateless,
  there is no real conversation state or prompt caching. Long histories cost the full prompt each time.
- Ignored sampling params: `temperature`, `top_p`, `max_tokens`, `stop`, `seed`, penalties, `logprobs`. `n` must be 1.
  Anthropic `max_tokens` is required (validated) but not enforced. Assistant prefill is rejected.
- Images are replaced by `[image omitted]`.
- Token usage is what the CLI reports, or an estimate (chars/4). `count_tokens` is always an estimate.
- Streaming granularity depends on the CLI (some emit large chunks). Latency is CLI start-up time (seconds).
- `stop_reason` is always `end_turn`/`stop`; no `length`.
- Binds `127.0.0.1` only; other hosts are refused unless `allowNonLoopback` / `--allow-non-loopback`.
  Optional bearer token (`Authorization: Bearer` or `x-api-key`), `--token` or `AGENTBRIDGE_TOKEN`.

## Rate limits
A `RATE_LIMITED` failure is answered with HTTP 429 and a `retry-after` header (seconds) in both the OpenAI and Anthropic shapes. `ab serve --fallback a,b` applies a fallback chain to every request; a limit hit after streaming has started cannot be re-routed and ends the stream with the error.
