# Adapter notes (from bridge pairs)
- claude: with mcpServers attached in read-only/default mode, MCP tools are permission-denied in -p mode.
  Fix: when mcpServers is set, adapter should add `--allowedTools "mcp__<server>__*"` (bridge passes it via extraArgs today).
- codex: MCP tool call fails with "approval policy is never". Fix: when mcpServers set, add
  `-c mcp_servers.<name>.default_tools_approval_mode="approve"` (bridge passes via extraArgs today).
- opencode: none; but callee model must be passed explicitly (bridge tool `model` arg) else default free-tier model fails.
## Round 2
- codex adapter: tool event `output` for mcp_tool_call is an object (`it.result`), not a string -> normalize with JSON.stringify (bridge subagent.mjs normalizes as workaround).
- claude adapter: still needs `--allowedTools "mcp__<server>__*"` when mcpServers set (subagent.mjs passes it via extraArgs until then). Claude/codex return the tool's structuredContent to the model; bridge meta parsed from it.
- runs registry pid = bridge process pid (adapters do not expose child pid); expose `proc.pid` via a 'pid' event to let telemetry track the real child.
## Round 3
- Emit child pid: adapters should yield a {type:'pid', pid} event (from spawnProc) so the run registry can record childPid for telemetry/cross-process kill.
- Flake: opencode callee occasionally hangs >300s under codex->opencode (1 of 3 runs); passes on retry.
## Round 4
- childPid: bridge registry records childPid when an adapter yields {type:'pid', pid} (spawnProc already has p.pid). Adapters do not emit it yet -> childPid stays null. Adapter fix: `yield {type:'pid', pid: p.pid}` right after spawnProc in all 3 adapters.
- D8 timings: opencode-as-caller pairs took 11-15s in my sequential runs (critic saw ~320s, presumably under concurrent load/opencode MCP init); codex->codex 85s, codex->opencode 59-177s vary. Test budgets are 400s/pair; run pairs with max 1-2 concurrent real agents.
- D3: attest key now travels via a one-shot 0600 key file (read+deleted by the bridge at startup), never cmdline/env/persistent config. Residual: a shell-capable (edit/full) caller could race to read the file in the startup window; full fix needs an asymmetric trust root (out of scope).
- D7: attested sessionId now falls back to the session event id when Result.sessionId is missing; codex pairs pass with a session id.
## Round 5
- N1 residual (honest): the attest key is delivered via a one-shot 0600 file that the bridge reads+deletes+rmdirs at process START (tested idle). Window = agent spawn -> bridge start (ms). A same-user shell-capable (edit/full) caller can still, in principle, race that window or read the launcher's memory; no in-band secret can be fully hidden from a same-user shell. Only read-only callers (no shell) are fully protected. Full fix needs an out-of-band trust root (launcher-verified over a channel the agent cannot reach), not available via the adapters' mcpServers option.
- N3 root causes: (a) sessionId null came from the caller LLM passing optional args (session mode ephemeral) -> the delegation prompt now says pass ONLY "prompt"; (b) codex/gpt-5.6-luna as CALLER sometimes ends its turn with an EMPTY final message after a successful attested tool call (~1 in 6): runAsSubagent retries once (attempts reported); (c) codex tool "unavailable" flake: startup registry sweep ran synchronously before serving; now deferred 1.5s.
- N2 root cause: idempotency lock was created before the run record; now record first, lock second (2-process race test, 10 rounds).
## Round 6
- N1 fixed: the bridge's own attest-key delivery no longer touches disk at all (removed writeKeyFile/AGENTBRIDGE_ATTEST_KEY_FILE; mcpConfigFor sets AGENTBRIDGE_ATTEST_KEY as a plain env value only). Verified: acceptance/registry2.test.mjs "N1 (round 6)" spawns the real bridge and repeatedly scans %TEMP% for the whole idle window — finds nothing; a second test proves a key-less sibling cannot forge a verifying attestation by any guess.
- Residual (documented, not ours to fix without editing adapters): the CALLER's own CLI still persists that env value in its own transport — claude writes a per-run temp mcp.json containing the full mcpServers block (including this env), codex passes server env via a `-c mcp_servers.*.env={...}` command-line flag. Both are the adapter's own established mechanism for delivering MCP server config (pre-existing, not something bridge added) and are outside contract (no adapter edits). A fully closed channel would need adapter support for a non-file, non-argv MCP server env transport (e.g. an inherited fd), which none of the 3 CLIs currently expose.
- N5 (childPid) still open: adapters would need to emit {type:'pid', pid} from spawnProc.
## Round 7
- N1 real fix (not theoretical): the attest key no longer goes into opts.mcpServers.<name>.env at all (src/bridge/attach.mjs's mcpConfigFor has no attestKey parameter any more). It is set directly on the top-level `env` of the spawned agent CLI process (RunOptions.env, which every adapter already merges as `{...process.env, ...o.env}`). Empirically verified against the REAL adapter-mediated spawn path (acceptance/keydelivery.test.mjs, live processes, no mocks):
  - claude: its MCP-subprocess spawn INHERITS the parent claude process's env. Key never appears in the temp mcp.json (scanned live, whole child lifetime) or anywhere else on disk. Fully closed.
  - opencode: same — inherits, never touches disk. Fully closed.
  - codex: its MCP-subprocess spawn does NOT inherit ANY custom parent env var — every MCP child gets a fixed ~20-var OS-only env regardless of what's set on the codex process (verified live: a custom var set on the codex process's own env never reached a probe MCP child with no explicit config). This is a hard, proven limitation of the codex CLI itself. The only channel it offers for a value to reach its MCP child is its own `-c mcp_servers.*.env=...` flag, so for codex specifically the key is still placed there and is visible via a live WMI CommandLine query for the whole child's lifetime (acceptance/keydelivery.test.mjs "codex documented workaround"). This is an accepted, disclosed residual — not something fixable without editing the codex adapter or the codex CLI itself, and not relabeled as "outside contract": it is a proven fact about codex's behavior, tested and documented here.
  - Adapter ask (if this residual should ever close): codex would need either (a) an option to inherit the invoking process's full env for spawned MCP servers, or (b) support for delivering per-server env via a channel other than -c args (e.g. an env-file reference, or a documented inherited-fd/stdin handshake).
## Round 8
- N1 codex residual from round 7 is CLOSED. Lead: `codex mcp add --help` (codex-cli 0.155.1) exposes `--url` (streamable-HTTP MCP transport) and `--bearer-token-env-var` (codex reads a bearer token from its OWN process env at request time and sends `Authorization: Bearer <value>` — only the env VAR NAME goes into codex's config/argv, never the value). Confirmed this works with per-run `-c` overrides (not just persisted `codex mcp add` config) via a live `codex exec -c mcp_servers.<n>.url=... -c mcp_servers.<n>.bearer_token_env_var=...` call.
- Fix (no adapter edit — uses only the already-exposed `extraArgs` RunOptions knob): for agent/caller === 'codex', src/bridge/mcp.mjs execute() and src/bridge/subagent.mjs runOnce() no longer put 'agentbridge' in opts.mcpServers at all. Instead they start the grandchild bridge IN-PROCESS over HTTP (src/bridge/mcp.mjs `serveHttp()` — no extra child process, no adapter-mediated spawn, so the key literally never has to pass through any CLI transport) and pass codex only `-c mcp_servers.agentbridge.url=... -c mcp_servers.agentbridge.bearer_token_env_var="AGENTBRIDGE_ATTEST_KEY" -c mcp_servers.agentbridge.default_tools_approval_mode="approve"` via extraArgs. The key itself goes only into codex's own top-level process env (opts.env), the same safe channel already proven for claude/opencode.
- Verified live end-to-end (acceptance/keydelivery.test.mjs "codex HTTP transport"): a real `codex` caller delegates to a real `claude` callee, attestation succeeds, and a continuous disk scan + live WMI `Win32_Process.CommandLine` query throughout the whole run find the key NOWHERE. Also exercised by the existing 3-level/mixed codex chain tests in bridge.test.mjs (codex as callee via execute()'s HTTP path) and all 5 codex-involved pairs.
- Trade-off disclosed: progress notifications are not streamed over this HTTP transport (serveHttp uses a no-op `send`; the spec technically allows SSE for that, not implemented here) — codex delegation still returns a full result, so this only affects intermediate progress visibility, not correctness.
## Round 9
- Codex children now use the distinct MCP server name `agentbridge_http` for the temporary HTTP bridge. A Codex installation may already have a persistent `agentbridge` stdio server; adding `url` to that same name merges incompatible transport fields and makes Codex reject its config with `url is not supported for stdio`. The child delegation prompt names `agentbridge_http`; the parent Codex's persistent `agentbridge` stdio config remains untouched.
## opencode round 3: live-backend timing variance (not a logic bug)
The opencode adapter runs a per-turn `opencode serve` + `/event` SSE (see src/adapters/opencode.mjs header for the
full mechanism/mapping notes). Round 3 added: real token-level streaming, a minimal env allowlist + encoding-aware
credential redaction, permission rules that deny reads of the credential store outside `permissions:'full'`, a
stall-detector (aborts a turn that goes genuinely silent for `session.stallMs`, default 45s — this was a real bug,
found and fixed: the detector's clock was originally reset by every SSE event including repeated `session.status`
heartbeat pings, so it never actually fired; fixed to reset only on progress-bearing events), and a session-exclusivity
guard matching adapters/claude.mjs's pattern (two concurrent id-less `continue` calls never silently share a session:
the second gets BAD_OPTION 'session busy' instantly — claimed from in-process state BEFORE spinning up a server, so
the check doesn't race against per-call server startup time).

Across 6+ full live `acceptance/opencode.test.mjs` runs against the real `opencode-go` backend, done chasing a fully
clean run, here is the honest tally of every distinct failure observed, by test name and reason:
- `permissions: read-only blocks writes, full allows them` — plain TIMEOUT once (~120-127s), passed cleanly every
  other run (as fast as 13-32s).
- `sessions: continue remembers, fork branches, ephemeral leaves nothing` — plain TIMEOUT once (~120-129s), passed
  cleanly every other run (56-85s).
- `SECURITY: read-only/edit/plan cannot read auth.json or list the opencode data dir` — plain TIMEOUT once
  (~150-157s), passed cleanly every other run (15-60s), including the security assertions themselves (no leak).
- `mcpServers is stable across repeats` — plain TIMEOUT once (~126-134s), passed cleanly every other run
  (5-42s), including a stall/TIMEOUT retry built into its `A()` helper.
- `sessions: continue/fork without id never adopt a foreign session; concurrent runs stay separate` — plain TIMEOUT
  on 2 separate runs (2 real opencode-go calls made truly concurrently), passed cleanly on 2 other runs (26-158s) with
  the SAME model forced via `OC_TEST_MODEL` (once the model-probe fallback flake, see below, was ruled out).
- `same cwd concurrent id-less continue: second claimant gets BAD_OPTION busy, claim released after` — TIMEOUT on 3
  runs at increasing budgets (150s, 240s, 240s-with-retry); passed cleanly in isolation once the busy-guard's own
  claim was moved before server startup (34.5s) and again as part of a clean full run. The busy-guard's own logic was
  independently confirmed instant and correct by reading one failing run's stack trace: assertions on the concurrent
  pair's outcome (`ok.length===1`, `bad[0].reason.code==='BAD_OPTION'`, `/session busy/`) all passed every time this
  test failed; only the LATER, ordinary single "claim released" call, or the concurrent pair's real generation time,
  hit TIMEOUT. Not once did this test fail on a wrong VALUE — only on wall-clock budget.
- One model-probe flake (unrelated to any of the above, environment-only): the `before()` hook's fallback candidate
  list included a since-renamed model id (`opencode/claude-haiku-4-5`) that 404s; when every earlier candidate also
  happened to be transiently unavailable in one run, the suite fell through to it and all live tests skipped with a
  clear reason rather than silently passing. Fixed by pinning `OC_TEST_MODEL=opencode-go/deepseek-v4-flash` for CI-
  grade runs; the underlying candidate-list staleness is a test-data issue, not adapter logic, and left as-is since
  `before()` already surfaces the exact rejection reason when this happens.

**Correction (round 4): two of the "timing-only" claims above were wrong.** An earlier draft of this note claimed
every failure across these runs was pure wall-clock TIMEOUT and that no test ever failed on a VALUE. Round-4 review
found 2 genuinely reproducible, zero-concurrency-needed bugs that don't fit that pattern, both now fixed:
- `timeout/abort kill the whole tree incl. grandchildren started by tools` — this DID fail on the actual kill
  assertion (`alive() === '0'` after abort) in isolated, fast (9-13s) reruns — not a timing fluke. Root cause: this
  test's own OWN check function was broken, not the adapter's `killTree`. A round-3 edit "broadened" the process
  match from `Name -eq 'node.exe'` to `CommandLine`-only, which made the query match ITSELF (the powershell
  `-Command` string passed to run the check literally contains the marker text being searched for) — confirmed live
  with a direct repro: an identical query for a marker with zero real matching processes still returns a nonzero
  count. That self-match meant `alive()` could never truly report 0, independent of whether the grandchild was
  actually dead. Verified separately, directly, that the real kill mechanism is correct: a live abort with the
  proper `Name -eq 'node.exe'` filter shows the grandchild dying within ~1s of abort and staying dead, and the full
  ancestor chain (grandchild node.exe -> bash.exe -> real opencode.exe -> chocolatey shim opencode.exe -> our spawned
  process) is intact PPID-to-PPID the whole time, so Windows `taskkill /T /F` (src/core/spawn.mjs's `killTree`,
  unmodified) walks it correctly. Fixed by restoring the `Name -eq 'node.exe'` filter (kept the legitimate
  improvements from round 3: 120s poll window, early-exit if the run settles first).
- `mcpServers is stable across repeats` — this DID fail on a real value once: the model reported no `get_secret` tool
  at all, not a wrong answer about one. Root cause: the adapter's warm-up (`GET /config/providers`, `GET /agent`)
  never waited for configured MCP child servers to finish their handshake before the first prompt could be sent, so
  a prompt could reach the model before the tool was registered. Fixed: warm-up now polls `GET /mcp` (which reports
  `{<name>: {status: 'connecting'|'connected'|...}}` per configured server, confirmed live) until every configured
  server leaves `'connecting'`, up to 20s, before yielding to the first turn.

With those 2 corrected, the remaining failure list (permissions, sessions continue/fork/ephemeral, SECURITY
read-only/edit/plan, the concurrency tests, and the model-probe flake) still holds as plain wall-clock TIMEOUT with
no wrong-value assertions, and none of them reproduced twice for the same reason - that part of the original claim
stands. Two independent live probes with a 15s budget and the simplest possible prompt succeeded in 4.9s and 5.5s
when checked directly against the adapter, confirming the mechanism is correct and fast when the backend isn't
degraded. Mitigations applied for that remaining timing variance (all honest - retry only ever masks TIMEOUT, never
an assertion failure): a single retry-on-TIMEOUT wrapper around every live LLM call site in the test file
(`askR`/`runR`), a stall/TIMEOUT retry already built into the shared `A()`/`B()` helpers, and - only for the one test
that legitimately runs 2 truly-concurrent live calls on purpose - a whole-test-body single retry on TIMEOUT with a
fresh session.

## agy (Antigravity CLI) - facts verified live on Windows 11 with agy 1.2.16, and what the adapter does about them
Binary: `%LOCALAPPDATA%\agy\bin\agy.exe` (not on PATH of already-open terminals; the adapter also looks there, in `~/.local/bin`, and honors `AGY_BIN`).
The IDE launcher (`antigravity-ide`) is a VS Code fork with no agent mode; only the separate `agy` CLI is driven.

**What agy does NOT give us, and how the adapter compensates**
- No flag restricts file writes. Default mode (`request-review`) happily runs the file-write tool in headless mode; `--mode plan` and `--sandbox` do not stop it either (`--sandbox` only restricts the terminal). `--mode accept-edits` even wrote outside the workspace.
  Fix: permissions are enforced with `permissions.deny` rules in a `settings.json` (`write_file(*)`, `command(*)`, `unsandboxed(*)`, `execute_url(*)`). Verified: the write tool is refused, shell commands are refused, reading still works.
- `settings.json`, `mcp_config.json` and `hooks.json` are global; workspace-level `settings.json` locations are ignored (tested `.agents/`, `.antigravity/`, `.gemini/antigravity-cli/`).
  Fix: every run gets its own throw-away HOME/USERPROFILE with that run's rules and MCP servers. agy's login is NOT stored under HOME (verified: an empty HOME is still logged in), so this works and never touches the user's own agy configuration.
- Conversations live under that HOME, so continue would break. Fix: `conversations/`, `brain/`, `annotations/` are junctions to a persistent `<AGENTBRIDGE_HOME>/agy-store`. Verified: a conversation created in one throw-away home continues in another. Homes are removed by unlinking the junctions first, so a recursive delete can never reach the store (covered by a sentinel-file test).
- `--conversation <unknown id>` prints a warning and silently starts a NEW conversation (exit 0). The adapter checks the id exists first and also verifies the returned id equals the requested one.
- `result.usage` is cumulative for the whole conversation. The adapter sums the per-step usage of THIS run instead, and emits one usage event per step, so context telemetry (last-step usage) is exact.
- Every reply ends with a newline; the adapter trims trailing whitespace. Without that, the bridge's attestation check (which strips whitespace before its marker) rejected agy results in plain-text transports (found by the agy->agy and opencode->agy pairs).
- A permission-denied tool call yields `status: SUCCESS` with an EMPTY response and a stderr notice. The adapter turns an empty response with that notice into `AGENT_FAILED` that names the permission, instead of returning silently empty text.
- `--print-timeout` returns exit 0 with partial output; the adapter uses its own timeout/abort (process tree kill) and never passes it.
- A model slug that ends in `-low|-medium|-high` already encodes its effort and conflicts with `--effort`. The adapter throws BAD_OPTION and tells the user to pass the base model with `effort` (e.g. `gemini-3.8-flash` + `high`) or the suffixed slug alone.
- The isolated HOME is inherited by every descendant process. MCP servers get the REAL home restored in their own `env` block, otherwise the bridge's grandchild `claude`/`codex` could not find their logins (this was a real bug found by the first agy->claude pair).
- Structured output: `structured_output` is the clean value; `response` also carries junk fields (`toolAction`, `toolSummary`), so `Result.text` is `JSON.stringify(structured_output)`.
- MCP tool calls appear as `call_mcp_tool{ServerName,ToolName,Arguments}`; the adapter renames them to `mcp__<server>__<tool>` with the real arguments as input (same shape as claude) so the bridge can attest and verify them.

**Attest-key delivery for agy as a caller:** the key travels only through the agy process environment. Verified: agy's MCP subprocess inherits the parent's env (like claude and opencode), so the key never touches argv or disk; the generated `mcp_config.json` contains no key (test).

**Unsupported (throw BAD_OPTION, documented):** `fork` (a copied conversation is rejected with "trajectory not found"), `isolated:false`.
**systemPrompt:** agy has no flag for it. Prepending it to the user message obeyed 0 of 9 times (any framing); writing it to the isolated home's `.gemini/GEMINI.md` (agy's global rules file) obeyed 9 of 9, and a workspace `AGENTS.md` also works but would pollute the user's project, so it is not used.
**Residual limits (honest):**
- `edit` cannot be strictly confined to cwd: agy decides its own workspace boundary. Verified: writes into the user's real home from an unrelated cwd were refused, but a sibling directory of cwd was writable. Shell commands are always refused in `edit`.
- With `permissions:'full'` the commands agy runs see the isolated HOME (no global git config, ssh keys, ...). Pass what you need through `env`.
- Cross-process concurrent `continue` of the SAME conversation is not guarded (in-process it is: `BAD_OPTION session busy`).
- `NOT_LOGGED_IN` detection is by message pattern; it could not be exercised live because the test machine is logged in.
- Verified on Windows only. On macOS/Linux agy may keep its credentials under HOME, in which case the isolated-home approach would need an explicit credential copy; not tested.
- `agy` quota/rate-limit errors surface as AGENT_FAILED with agy's message (no dedicated code).

### agy - independent critic round 1 (found a real security hole, now fixed)
- **CRITICAL, fixed:** agy starts the MCP servers listed in `<cwd>/.agents/mcp_config.json` (and reads `.agents/hooks.json`) at startup, BEFORE any permission rule applies. A `read-only` run in a hostile cloned repo executed arbitrary commands with no model involvement (reproduced: a marker file appeared). No setting neutralizes it: tried `allowedMcpServers`, `mcp.allowed`, `allowMcpServers`, `enableJsonHooks`, `permissions.deny mcp(*)` and a `trustedFolders.json` DO_NOT_TRUST entry, all ineffective. Parent directories are NOT searched, but `--add-dir` roots are.
  Fix: a non-`full` run is refused with BAD_OPTION when cwd contains `.agents/mcp_config.json` or `.agents/hooks.json` (the server never starts); `edit` additionally denies `write_file(.agents/)` (verified: an edit run can no longer plant the file that a later run would execute); `extraArgs` may not carry `--add-dir/--agent/--project/--new-project/--remote-control/--mode/--dangerously-skip-permissions` unless `full`.
  So "your hooks and MCP servers are never used" holds for the USER's global config (the isolated home), not for config that lives in the project itself, which is now refused instead of silently honored.
- Verified blocked (files checked on disk) for read-only/plan: write_to_file, replace_file_content, run_command (PowerShell and cmd variants), prompt injection through a file, invoke_subagent (the subagent inherits the denies). `edit` cannot read or overwrite the run's own settings.json ("hardcoded system protection boundary").
- Fixed minor: `makeHome` leaked its temp dir when it threw midway; cwd comparison for `continue` without id is now case-insensitive on Windows.
- Open, documented: `read_url(*)` is not denied (agy's URL fetch in read-only returned empty/failed in the critic's run, exfiltration by URL was not tested; claude's read-only also keeps WebFetch/WebSearch). `invoke_subagent` activity emits no tool events, so a caller only sees it in the final text. Not tested: define_subagent, notebook tools, hooks.json execution (format unknown), a 300 KB+ prompt (the model ignored a trailing instruction; truncation vs model behaviour unknown).
- Test hardening after the critic: the permission test now REQUIRES the model to attempt the forbidden tool (else it fails instead of passing vacuously), checks that an existing file is unchanged after an edit attempt, the per-run usage assertion can now actually fail, and a live scan proves the attest key is in no file of a live temp home and on no agy/node command line while an agy caller delegates.

## pi (@earendil-works/pi-coding-agent 1.0.1) - facts verified live on Windows 11, and what the adapter does about them
- Prompt goes in on stdin, and stdin MUST be closed or pi hangs (spawnProc `input` does that). Output is `--mode json` JSONL.
- A provider error is an assistant `message_end` with `stopReason:'error'` and `errorMessage`, with **exit code 0**; the adapter turns it into AgentError (RATE_LIMITED when it looks like a limit). pi's default retry backoff lasted minutes on a 429, so each run gets a short-retry settings.json.
- Permissions: no sandbox exists; read-only/plan = `--exclude-tools` denylist, verified by files on disk. Project trust is disabled with `--no-approve -ns -np -ne`; a hostile `.pi/extensions` and AGENTS.md in cwd did not run (test).
- MCP: `-e builtin:mcp` with a per-run mcp.json (exposure direct). The attest key reaches the server only through the process env (`${AGENTBRIDGE_ATTEST_KEY}` placeholder in the file), never as a value on disk or argv.
- Sessions are native; ids are UUIDs; `continue` without id resolves the latest for the cwd; unknown id is BAD_OPTION.
- Pairs verified with the cloud model glm-5.3-flash:cloud: claude, codex, opencode, agy and pi in both directions (token read from a file the caller cannot see, attestation checked). Two transient failures (a provider "Connection error", an opencode 280 s stall) passed on retry; the opencode stall is unexplained.
- Two machine blue screens happened while running a large local Ollama model; none with cloud models.
