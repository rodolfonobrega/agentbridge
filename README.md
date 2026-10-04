# agentbridge

**One interface for every coding agent on your machine.**
Drive **Claude Code**, **Codex**, **OpenCode**, **Antigravity CLI (`agy`)**, **pi** and local/remote **HTTP models (Ollama, vLLM, LM Studio...)** from the same CLI, library, MCP server and OpenAI/Anthropic-compatible proxy — using the logins you already have. **No API keys. No dependencies. No build step.**

```bash
ab ask claude   "Review src/auth.mjs for security bugs"
ab ask codex    "Write tests for it"                      --permissions edit
ab ask agy      "Explain the failing build"               --model gemini-3.8-flash
ab race "Fix the flaky test" claude:haiku codex opencode  # first answer wins, the rest are cancelled
ab ask claude   "Big refactor" --fallback codex,pi        # out of tokens? the next agent takes over
```

> Node ESM · Node ≥ 22 · Windows, macOS, Linux · MIT · zero runtime dependencies

![agentbridge dashboard: live runs, success rate, tokens, cost, fallbacks, per-agent breakdown and context pressure](docs/img/dashboard.png)

<sub>The built-in dashboard (`ab ui`), shown with sample data from `scripts/demo-data.mjs`.</sub>

---

## Why agentbridge?

You probably pay for more than one coding agent, and each has a different CLI, flags, output format, session model and permission system. Gluing them together means a pile of fragile scripts. agentbridge makes them **interchangeable building blocks**:

| You want to... | agentbridge gives you |
|---|---|
| Call any agent from code or a shell script | One `run()/ask()` API and one `ab` CLI with identical options, events and results |
| Let agents delegate to each other | A built-in **MCP bridge**: any agent can be a subagent of any other (`ask_claude`, `ask_codex`, `ask_opencode`, `ask_agy`, `ask_pi`, `ask_ollama`...) with model, effort, permissions, cwd, timeout and session control |
| Never be stopped by a token limit | **`RATE_LIMITED` detection + `fallback` chains** across agents |
| Compare or hedge models | **`fanout`** (ask many, collect all) and **`race`** (first accepted answer wins, the rest are cancelled) |
| Use your subscriptions from any SDK/app | An **OpenAI- and Anthropic-compatible local proxy** (`ab serve`) |
| Use local models as agents | **HTTP endpoints** (Ollama built in; any OpenAI/Anthropic-compatible URL) and the **pi** agent |
| See what your agents are doing | A live **dashboard** (`ab ui`): runs, tokens, cost, success rate, fallbacks, context pressure |
| Keep context under control | **Telemetry, context policy, auto-compaction** and cross-agent **`handoff()`** |
| Stay safe | Permission ceilings, depth guards and **HMAC-attested** delegation so a subagent cannot escalate |

---

## Quickstart (2 minutes)

**1. Requirements:** Node.js ≥ 22 and at least one of the agent CLIs installed **and logged in** (all optional — use what you have): `claude`, `codex`, `opencode`, `agy`, `pi`, or an Ollama server.

**2. Install**

```bash
git clone https://github.com/rodolfonobrega/agentbridge.git
cd agentbridge
npm install        # dev dependencies only (used by the proxy tests)
npm link           # optional: puts `ab` and `agentbridge` on your PATH
```

(Without `npm link`, use `node src/cli/main.mjs` instead of `ab`.)

**3. Check your setup**

```bash
ab doctor          # finds each CLI, checks logins, lists models
ab doctor --live   # also makes one tiny real call per agent
```

**4. Ask something**

```bash
ab ask claude "Reply with exactly: PONG"
ab ask codex  "Summarize this repo" --cwd ./my-project
ab run opencode "Explain main.js" --stream           # live events
```

**5. Use it from code**

```js
import { ask, run, fanout, race } from 'agentbridge';

const r = await ask('claude', { prompt: 'Say hi', model: 'haiku' });
console.log(r.text, r.usage, r.sessionId);

// first accepted answer wins; the losers are aborted
const { winner } = await race(['claude:haiku', 'codex', 'opencode'], { prompt: 'Name three prime numbers' });
console.log(winner.agent, winner.text);

// ask several agents and keep every answer
const { results } = await fanout(['claude:haiku', 'codex'], { prompt: 'Review src/auth.mjs' });
```

**6. Watch what is happening (optional)**

```bash
ab ui --open        # live dashboard on http://127.0.0.1:8788
```

**7. Let your agents delegate to each other**

```bash
ab install claude          # registers the MCP bridge, writes relay subagents and installs the `agentbridge-delegate` skill
ab install codex           # same for Codex
ab install opencode        # same for OpenCode (opencode.json)
ab install agy             # same for Antigravity
ab install all             # every one of the above that is installed
```

Now, from inside any of them, you can say "ask claude to review this" or "have pi write the tests": the agent calls the `ask_<agent>` tools (`ask_claude`, `ask_codex`, `ask_opencode`, `ask_agy`, `ask_pi`, `ask_ollama`, ...). `--scope user` installs globally; `--permissions` sets the ceiling a delegated agent can never exceed. pi can be a *target* (`ask_pi`) but has no installer yet.

---

## Everything it can do

### 1. Unified run API (library + CLI)
- `run()` (streaming async generator), `ask()` (final result), `fanout()`, `race()`.
- Identical options for every agent: `model`, `effort` (`low|medium|high|max`, mapped per agent), `permissions` (`read-only|plan|edit|full`), `cwd`, `timeoutMs`, `signal`, `systemPrompt`, `jsonSchema`, `session`, `mcpServers`, `env`, `extraArgs`, `fallback`.
- Normalized events (`text`, `tool`, `usage`, `fallback`, ...) and a normalized result (`text`, `sessionId`, `usage`, `model`, `structured`, `fallback`).
- Typed errors: `NOT_INSTALLED`, `NOT_LOGGED_IN`, `TIMEOUT`, `ABORTED`, `BAD_OPTION`, `RATE_LIMITED`, `AGENT_FAILED`.
- Structured output: `jsonSchema` validates (and repairs, with a retry) the model's JSON.

### 2. Sessions
`new`, `ephemeral`, `continue` (by id or "latest for this cwd") and `fork` (where the agent supports it) — the same vocabulary for all agents.

### 3. Agents calling agents (MCP bridge)
- `ab bridge` is a stdio MCP server exposing `ask_<agent>` and `dispatch_<agent>` (async job) tools.
- **All caller × callee pairs** are tested live (claude, codex, opencode, agy, pi, in both directions).
- **Safety rules:** recursion depth guard, permission ceiling (a subagent can never exceed the caller), HMAC attestation of results, the attestation key is delivered only through the process environment (never on disk or argv).
- Forced child working directory (`AGENTBRIDGE_CHILD_CWD`) so a caller cannot redirect where a subagent works.

### 4. Rate limits and fallback
```bash
ab ask claude "Refactor X" --fallback codex,opencode:opencode-go/glm-5.3-flash
```
HTTP 429/529, "usage limit", "quota exceeded", "credit balance too low", "overloaded"... become `RATE_LIMITED` (with `retryAfterMs`). The chain moves to the next agent, reports `fallback: { used, attempts, contextLost }`, and **refuses to re-run** a task that already made edits under `edit`/`full` permissions. Works in the library, CLI, MCP tools and proxy.

### 5. Parallel workflows
`fanout` runs the same prompt on many agents and collects all answers; `race` returns the first accepted answer and cancels the rest. `--worktree` runs an agent in an isolated git worktree; `--max-cost/--max-tokens/--max-time` enforce budgets.

### 6. HTTP endpoints as agents
```bash
ab endpoint add vllm http://localhost:8000/v1 --model my-model
ab ask ollama "hello" --model qwen3:14b
```
Ollama is built in. Any OpenAI- or Anthropic-compatible base URL works, and is exposed to other agents as `ask_<name>`.

### 7. OpenAI / Anthropic compatible proxy
```bash
ab serve --port 8787        # loopback only by default
```
Point any OpenAI or Anthropic SDK at `http://127.0.0.1:8787`. Route with the model name: `claude/haiku`, `codex/gpt-5`, `agy/gemini-3.8-flash`, `pi/ollama/glm-5.3-flash:cloud`, `opencode/<provider>/<model>`, `ollama/<model>`. Streaming supported; limits answer HTTP 429 with `retry-after`. See [docs/PROXY.md](docs/PROXY.md).

### 8. Telemetry, context policy and handoff
`ab ps`, `ab top`, `ab stats`, `ab context <session>`: live runs, token usage and context-window pressure per session, with warn/compact/hard thresholds, automatic compaction and `ab handoff <session> --to <agent>` to continue a conversation in a different agent. See [docs/TELEMETRY.md](docs/TELEMETRY.md).

### 9. Live dashboard (`ab ui`)
```bash
ab ui --open          # http://127.0.0.1:8788
```
A read-only local web UI over the telemetry agentbridge records: **runs in flight** (live timers), **success rate**, **tokens in/out**, **reported cost**, **runs rescued by fallback** and rate limits hit, median/p95 duration, activity over time (runs or tokens), per-agent breakdown, **context-window pressure** per session, top tools, where runs come from (CLI, proxy, MCP bridge, library), and a detail drawer per run (prompt, output tail, tool calls, files touched, error). Filter by time window, agent and status; dark/light theme. Everything the CLI, the proxy and the MCP `ask_*` tools run is recorded automatically. No dependencies, loopback only, never starts or cancels anything. See [docs/TELEMETRY.md](docs/TELEMETRY.md#dashboard).

### 10. Hooks, doctor, Claude Code integration
Lifecycle hooks, `ab doctor` diagnostics, and `ab install claude` (MCP registration plus relay subagents for Codex/OpenCode/Ollama).

### Agent capability overview

| Agent | Permissions enforced by | Sessions | Notes |
|---|---|---|---|
| Claude Code | the CLI's own permission modes | new / continue / fork / ephemeral | |
| Codex | the CLI's sandbox modes | new / continue / fork | |
| OpenCode | agentbridge + CLI | new / continue / fork | latency depends on backend model |
| Antigravity (`agy`) | **agentbridge** (private HOME, generated deny rules) | new / continue (no fork) | `edit` not confined to cwd |
| pi | **agentbridge** (tool denylist, project trust off) | new / continue / fork / ephemeral | no sandbox; `plan` = `read-only` |
| HTTP endpoints | n/a (plain chat) | emulated | no tools/MCP/files |

Full details, flags and caveats: **[docs/REFERENCE.md](docs/REFERENCE.md)**.

---

## Documentation

| Doc | What is in it |
|---|---|
| [docs/REFERENCE.md](docs/REFERENCE.md) | Complete reference: every CLI command, option, event, error, agent and environment variable |
| [docs/PROXY.md](docs/PROXY.md) | The OpenAI/Anthropic compatible proxy |
| [docs/TELEMETRY.md](docs/TELEMETRY.md) | Telemetry, the dashboard, context policy, compaction, handoff |
| [docs/EXTENDING.md](docs/EXTENDING.md) | Adding a new agent CLI or HTTP provider |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute, run the tests, the review rules |
| [acceptance/ADAPTER_NOTES.md](acceptance/ADAPTER_NOTES.md) | Verified facts about each CLI (quirks, workarounds) |
| [SECURITY.md](SECURITY.md) | Threat model and how to report vulnerabilities |

## How it works

```
 your code / ab CLI / SDK via proxy / another agent (MCP)
                     │
              ┌──────▼───────┐   events, results, errors, sessions,
              │  agentbridge │   permissions, fallback, telemetry
              └──────┬───────┘
   ┌────────┬────────┼─────────┬────────┬─────────────┐
 claude   codex   opencode    agy      pi      HTTP endpoints
 (spawned CLIs using their own local logins)   (Ollama, vLLM, ...)
```

Each adapter is a small module that spawns the real CLI and translates its output into the shared event model. Nothing is faked: the test suite drives the real agents.

## Testing

```bash
npm test               # offline suites (no agent or login required)
npm run accept         # the full acceptance run: drives the real, logged-in CLIs you have installed
```

Live suites skip agents that are not installed. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Terms of service and safety

agentbridge drives the CLIs with **your own consumer/subscription logins**. Providers may restrict automated use of those plans: use it for personal, local work, never expose the proxy to other people, and use API keys where your provider requires them. Agents can run commands and edit files — start with `--permissions read-only` and widen deliberately. See [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome — new adapters especially. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/EXTENDING.md](docs/EXTENDING.md).

## License

[MIT](LICENSE)
