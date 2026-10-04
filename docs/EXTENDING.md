# Extending agentbridge with new providers

There are two kinds of provider, with very different effort.

| Kind | Examples | What you do | Effort |
|---|---|---|---|
| **HTTP model endpoint** (OpenAI- or Anthropic-compatible) | Ollama, vLLM, LM Studio, LiteLLM, OpenRouter, a company gateway | Add a config entry | One minute, no code |
| **Agent CLI** (a program that runs its own agent loop with tools) | a new coding-agent CLI | Write an adapter and register it | A few hours to a couple of days, depending on the CLI |

First check whether your provider is really the second kind. Many tools that look like new agents also expose an OpenAI-compatible API, in which case you only need an endpoint.

---

## 1. HTTP endpoints (no code)

```bash
ab endpoint add mygateway https://gw.example.com/v1 --api-key-env GW_KEY --model some-model
ab endpoint add anth_proxy https://proxy.example.com --type anthropic --model my-model
ab endpoint list
```

or edit `~/.agentbridge/endpoints.json` (see the README section "HTTP endpoints"). From that moment the name works in `ab ask/run/fanout/race`, in the library (`ask('mygateway', ...)`), and through the bridge as `ask_mygateway` / `dispatch_mygateway` for any other agent. Run `ab install claude` again to get a matching relay subagent in Claude Code.

Endpoints are plain chat: no tools, no MCP, no file access, sessions replayed from a local history file. If you need the provider to act on files, it must be an agent CLI (section 2) or sit behind one.

If a provider speaks a protocol other than OpenAI chat-completions or Anthropic messages (for example Gemini's native API), add a third `type` in `src/adapters/endpoint.mjs`: build the request body, parse the stream into `text` / `thinking` / usage, and add the type to the allowed list in `normalize()`. The request, SSE reading, error mapping, timeout/abort and session handling are already shared.

---

## 2. A new agent CLI

### 2.1 Decide if it is feasible

A CLI is a good candidate only if it has all of these:

1. **A headless mode** that takes a prompt and exits (a "print" or "exec" mode).
2. **Structured output**, ideally a JSON event stream, so you can tell text from tool calls and read usage. Scraping human-formatted text is fragile.
3. **Local login reuse** (no API key needed), if you want the "no API keys" property.
4. **Resumable sessions** with a session id you can read from the output. Without this you can only implement `new` and `ephemeral`, and the others must throw `BAD_OPTION`.
5. A way to set the model, a working directory, and a sandbox/permission level non-interactively.

Run `<cli> --help` and one real headless call before writing code. The output format and session handling decide most of the work. The existing adapters are a good size reference: Claude 175 lines, Codex 230 lines, agy about 200 lines, OpenCode 570 lines (it needed an HTTP server mode for real streaming and session safety).

`src/adapters/agy.mjs` is the best worked example of a CLI that is **not** well-behaved: no flag restricts file writes, its config is global, and an unknown session id silently starts a new conversation. It shows how to enforce permissions with a throw-away HOME and per-run rules, how to share state across those homes, and how to verify claims about the CLI before trusting them (every workaround is justified in `acceptance/ADAPTER_NOTES.md`). Probe the CLI with real calls before designing around its documentation.

### 2.2 The contract

Read [CONTRACT.md](../CONTRACT.md). The short version: an adapter is a default export

```js
export default {
  name: 'myagent',
  async models() { return ['model-a', 'model-b']; },   // best effort
  async *run(opts) { /* yield events; return a Result */ },
};
```

- `opts` are validated RunOptions (`prompt`, `model`, `effort`, `permissions`, `cwd`, `timeoutMs`, `signal`, `session`, `systemPrompt`, `mcpServers`, `env`, `jsonSchema`, `extraArgs`, `isolated`). Call `validateOptions(opts)` from `src/index.mjs` first.
- Yield events built with `ev` from `src/core/events.mjs`: `ev.session(id)`, `ev.text(delta)`, `ev.thinking(delta)`, `ev.tool(name, input, output?)`, `ev.usage(input, output, cost?)`, `ev.error(msg)`, `ev.raw(obj)`.
- Return `{ text, sessionId, usage:{input,output,cost?}, exitCode, model, durationMs, timedOut:false }`.
- Throw `AgentError` (`src/core/errors.mjs`) with one of `NOT_INSTALLED`, `NOT_LOGGED_IN`, `TIMEOUT`, `ABORTED`, `BAD_OPTION`, `AGENT_FAILED`.
- **Anything the CLI cannot do must throw `BAD_OPTION`, never be silently ignored.** For example, if it has no read-only sandbox, `permissions: 'read-only'` must not quietly run with write access.
- Session semantics are the same for every agent: `new` (persisted), `ephemeral` (nothing persisted), `continue` (append, by id or the most recent for this cwd), `fork` (new id branching from the old history; original untouched). Concurrent `continue` on one session should be rejected with `BAD_OPTION 'session busy'`.

### 2.3 Skeleton

Use the shared process helper. It resolves `.cmd` shims on Windows, never uses a shell with user input, and kills the whole process tree on abort or timeout, even if a tool leaves a detached background process holding the pipes.

```js
// src/adapters/myagent.mjs
import { spawnProc, runCollect } from '../core/spawn.mjs';
import { AgentError } from '../core/errors.mjs';
import { ev, parseJsonLine } from '../core/events.mjs';
import { validateOptions } from '../index.mjs';

const bad = (m) => new AgentError('BAD_OPTION', m, { agent: 'myagent' });

function buildArgs(o) {
  const a = ['exec', '--json'];                       // the CLI's headless + JSON flags
  if (o.model) a.push('--model', o.model);
  // map permissions to the CLI's own sandbox/approval flags; throw bad(...) for what it cannot express
  // map effort, session (resume/fork) and systemPrompt the same way
  if (o.extraArgs) a.push(...o.extraArgs);
  return a;
}

export default {
  name: 'myagent',
  async models() { /* parse `myagent models`, or return a static list */ return []; },
  async *run(opts) {
    const o = validateOptions(opts);
    const t0 = Date.now();
    const p = spawnProc('myagent', buildArgs(o), {
      cwd: o.cwd, env: { ...process.env, ...(o.env || {}) }, input: o.prompt,
      timeoutMs: o.timeoutMs, signal: o.signal, agent: 'myagent',
    });
    let text = '', sessionId, usage = { input: 0, output: 0 }, model = o.model;
    try {
      for await (const line of p.lines) {
        const m = parseJsonLine(line); if (!m) continue;
        // translate the CLI's events into ev.session / ev.text / ev.tool / ev.usage ...
        yield ev.raw(m);
      }
      const r = await p.wait();
      if (r.aborted) throw new AgentError('ABORTED', 'Aborted', { agent: 'myagent' });
      if (r.timedOut) throw new AgentError('TIMEOUT', `myagent timed out after ${o.timeoutMs}ms`, { agent: 'myagent' });
      if (r.exitCode !== 0) throw new AgentError(/not logged in|401/i.test(r.stderr) ? 'NOT_LOGGED_IN' : 'AGENT_FAILED', r.stderr.slice(0, 500), { agent: 'myagent', exitCode: r.exitCode });
      return { text, sessionId, usage, exitCode: r.exitCode, model, durationMs: Date.now() - t0, timedOut: false };
    } finally { p.kill(); }
  },
};
```

Also detect a missing binary (`resolveBinary('myagent')` from `src/core/spawn.mjs`) and throw `NOT_INSTALLED` with a useful hint.

### 2.4 Register it

Agent names are currently listed in several places. Update each one:

| File | What to change |
|---|---|
| `src/index.mjs` | add the name to `NAMES` and a lazy getter (`get myagent()`) |
| `src/adapters/endpoint.mjs` | add the name to `BUILTIN` so an endpoint cannot reuse it |
| `src/bridge/mcp.mjs` | add to `BUILTIN_AGENTS` and give it an entry in `DEFAULT_MODEL` (the cheap default model for delegation) |
| `src/bridge/attach.mjs` | add to the allowed caller list if it can act as a caller (needs MCP support, see 2.5) |
| `src/extras/doctor.mjs` | add a login/auth check and include it in the default `agents` list |
| `src/server/common.mjs` | add a model-routing rule (`myagent/<model>`) if you want it in the OpenAI/Anthropic proxy |
| `src/telemetry/stats.mjs` | add context-window defaults and, if the CLI stores sessions on disk, a reader so `contextOf()` is exact; otherwise it falls back to run-usage aggregates |
| `src/cli/install.mjs` | add a description in `BLURB` so `ab install claude` writes a good relay subagent |

(This list is long because the three built-in agents were wired in directly. A good first step before adding a fourth CLI is a small refactor to a single registry that these files read from.)

### 2.5 Using it as a caller (optional)

For `myagent` to delegate to other agents, it must be able to load an MCP server. `mcpConfigFor()` in `src/bridge/attach.mjs` produces the server entry; your adapter must pass it to the CLI in whatever way the CLI wants. Check how the CLI exposes environment variables to its MCP subprocesses: the bridge's anti-forgery key is delivered through the environment, and Codex needed a special HTTP transport because it does not pass parent environment variables to its MCP servers (see `acceptance/keydelivery.test.mjs`). If your CLI behaves like Codex, follow the same pattern in `src/bridge/mcp.mjs` and `src/bridge/subagent.mjs`.

If the CLI cannot load MCP servers, it can still be a **callee**: other agents can call it, it just cannot call back.

### 2.6 Test it for real

Acceptance tests in this project run the real CLI (never mocks). Copy the closest existing file in `acceptance/` (`claude.test.mjs` is the shortest) and cover at least:

- a basic run: text, usage, model, exit code, session id
- invalid model and not-installed/not-logged-in errors
- timeout and abort return promptly and leave no child process (include a test where a tool backgrounds a process)
- every session mode, including `session busy`
- `permissions` really restricts what the agent can do (try to make it write a file in `read-only`)
- `cwd` is honored
- streaming yields more than one `text` delta, or the limitation is documented in `acceptance/ADAPTER_NOTES.md`
- the bridge round trip: `ask_myagent` from Claude Code, Codex and OpenCode, with the attestation present

`npm run accept` runs every file; `node acceptance/run.mjs myagent` runs just yours.

### 2.7 Document the limits

If the CLI has a gap (no streaming, no fork, no read-only sandbox), say so in `acceptance/ADAPTER_NOTES.md` and in the README's "Known limitations", and make the unsupported option throw `BAD_OPTION`. Honest gaps are fine; faking support is not.

## 2.8 Rate limits
Map provider limits to `new AgentError('RATE_LIMITED', msg, { retryAfterMs })` (HTTP 429/529, or run the error text through `asRateLimited` from `src/core/errors.mjs`). That is all an adapter needs for `fallback` chains, the proxy 429 and the MCP `fallback` argument to work. `src/adapters/pi.mjs` is a worked example of a CLI that reports provider errors inside its JSON stream with exit code 0.
