# Proxy comparison: agentbridge vs CLIProxyAPI vs free-claude-code

Based on directory/config inspection of refs/ (not full source audit); claims marked (verify) are unconfirmed.

| Aspect | agentbridge (src/server) | CLIProxyAPI (Go) | free-claude-code (Python/FastAPI) |
|---|---|---|---|
| Backend | Spawns installed CLIs (claude/codex/opencode) via adapters; no tokens handled | Uses OAuth tokens from the CLI logins directly and calls provider HTTP APIs (executors/claude_executor, codex_executor) | Anthropic-in, many provider HTTP backends out (NIM, OpenRouter, opencode, openai_codex...) |
| Inbound formats | OpenAI chat + responses, Anthropic messages, models, count_tokens | OpenAI/Claude/Gemini/Codex via a translator matrix (internal/translator/*) | Anthropic messages, responses, count_tokens, models (api/routes.py) |
| Tool calling | Rejected with explicit 400 `tools_not_supported` (agents run own tools) | Full translation of tool calls between formats | Passed through to providers that support them |
| Multi-account / rotation | No (single local login) | Yes (credential rotation) | Provider config |
| Default bind | 127.0.0.1, refuses non-loopback without flag, optional bearer/x-api-key | `host: ""` = all interfaces by default (config.example.yaml); api-keys list | Configurable; auth dependencies (`require_proxy_auth`) |
| Streaming | SSE for all three endpoints, lazy header start so pre-output errors return real HTTP status | Full streaming, websockets for Codex | Anthropic SSE |
| Fidelity | Lower: text only, multi-turn flattened, sampling params ignored, latency = CLI startup | Higher: native API semantics, usage, tools, caching | Higher for supported providers |
| ToS exposure | Uses CLI as intended by vendor (real CLI binary), still warned in docs/PROXY.md | Extracts and reuses OAuth tokens outside the official client: higher ToS/ban risk | Depends on provider |
| Deps | Zero runtime deps | Go binary + many deps | FastAPI stack |

## Where theirs is stronger
CLIProxyAPI: true tool-call translation, Gemini surface, account rotation, native usage/caching, lower latency (no
process spawn). free-claude-code: model catalog/admin UI, provider breadth, tool passthrough.

## Where ours is stronger / different
No token extraction (drives the vendor CLI itself, so vendor-side behavior stays intact); loopback-by-default with
enforced refusal; honest, explicit rejection of unsupported features instead of silent drops; three agents behind
one model-id scheme (`agent/model`); zero dependencies; permission model read-only by default; real-SDK acceptance
tests (openai + @anthropic-ai/sdk) against real CLIs.

## Known gaps (would adopt from refs)
Tool-call translation (would need an agent-side tool bridge), real token counting, `finish_reason: length`,
image input, request logging/admin endpoints, per-request cwd/permissions opt-in.
