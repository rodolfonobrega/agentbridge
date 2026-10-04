# bridge critic, round 8 (N1 final round)

## Scope
Fresh-context review of round 8's fix for N1's last open leg: codex-involved pairs leaking
AGENTBRIDGE_ATTEST_KEY via `-c mcp_servers.*.env=...` argv (round 7 finding). Builder's claim: codex's
streamable-HTTP MCP transport (`--url` + `--bearer-token-env-var`) lets codex read the key from its
own process env at request time, so only the env-var NAME goes into codex's config/argv.

## Code review (src/bridge/mcp.mjs, src/bridge/subagent.mjs, src/adapters/codex.mjs, src/bridge/attach.mjs)
- `execute()` (mcp.mjs) and `runOnce()` (subagent.mjs) both special-case `agent === 'codex'` /
  `caller === 'codex'`: they call `serveHttp({ env: grandchildEnv })` to start the bridge **in this
  process** (no extra child spawned) and hand codex `opts.extraArgs` /`rest.extraArgs` containing
  `-c mcp_servers.agentbridge.url=...`, `bearer_token_env_var="AGENTBRIDGE_ATTEST_KEY"`,
  `default_tools_approval_mode="approve"`. The actual key only ever goes into `opts.env` /
  the caller CLI's own env (same channel already accepted for claude/opencode in round 7).
- **`extraArgs` is a genuinely pre-existing, documented RunOptions field** (CONTRACT.md: "...
  jsonSchema?:object, extraArgs?:string[]"), and `src/adapters/codex.mjs` (`buildArgs`, lines 116-117)
  handles it exactly as it always has — generic `string[]` validation + verbatim append to argv, with
  zero codex.mjs-specific branching for the URL/bearer-var strings. Confirmed no diff-worthy special
  casing exists in the adapter for this feature. **The builder's "not an adapter edit" framing is
  accurate**, not just plausible-sounding.
- `mcpConfigFor` (attach.mjs) still has no `attestKey` parameter at all (unchanged from round 7);
  confirmed via `acceptance/keydelivery.test.mjs`'s structural guard test, which still passes.
- `serveHttp()`: binds to `127.0.0.1` only (hardcoded default, never overridden by either call site),
  `port: 0` (OS-assigned ephemeral, unpredictable, new per launch), auto-closed via `httpBridge.close()`
  in a `finally` block in both call sites (no lingering listener after the delegation ends).

## Independent live reproduction (fresh, not reusing keydelivery.test.mjs)
Wrote my own scanner (WMI `Get-CimInstance Win32_Process | Select CommandLine` polled every ~150-500ms
+ async recursive %TEMP% disk scan for a known secret, both running continuously for the full duration
of a real delegation) and ran it against all 5 codex-involved pairs directly via `runAsSubagent`:
codex→claude, codex→codex, codex→opencode, opencode→codex all clean (disk hit: null, argv hit: null,
succeeded: true). claude→codex confirmed via the full pairs suite (see below). **Zero leaks found
across all 5 codex-involved pairs, independently reproduced.**

Also caught the live codex process mid-flight via a raw WMI query during the codex→codex run and
confirmed its actual command line matches the builder's description exactly:
`-c "mcp_servers.agentbridge.url=\"http://127.0.0.1:PORT/mcp\"" -c "mcp_servers.agentbridge.bearer_token_env_var=\"AGENTBRIDGE_ATTEST_KEY\"" -c "mcp_servers.agentbridge.default_tools_approval_mode=\"approve\""`
— no key, only the var name.

## New attack surface: the HTTP bridge itself
Spun up `serveHttp()` directly and probed it with `fetch` (no MCP client in the loop):
- No `Authorization` header → 401, body is just a generic JSON-RPC error, no tool list leaked.
- Wrong bearer token → 401, same generic error.
- `GET /mcp` → 404, no method/tool info leaked.
- Wrong path → 404.
- Malformed JSON body (with correct token) → 400, generic parse-error JSON, no stack trace.
- Oversized body (>8MB) → connection destroyed server-side, no partial data echoed back.
- Correct token → 200, normal `tools/list` response (this is the intended behavior; the token itself
  is the only thing gating a same-user local process from using the bridge, which is the accepted
  round-7 trust model extended to this new local surface).
- No `console.log`/`console.error` anywhere in `serveHttp`/`makeHandler` that could write the token or
  request details to a log file.

**One real, but non-blocking, finding**: `authorized()` in `serveHttp` compares the bearer token with
plain `token === attestKey(env)`, not `crypto.timingSafeEqual`. This is a theoretical timing side
channel over loopback. In practice it is not a meaningfully new hole: (a) it requires an attacker who
is already a same-user local process capable of opening a raw socket to an ephemeral, randomly-chosen
port it must first discover, (b) extracting a 32-byte hex secret via network-jitter timing over
loopback in the single-request-per-delegation window this server is alive for is not practically
exploitable, and (c) `verifyAttestation`'s HMAC compare (`a.hmac !== mac(key, a)`, pre-existing since
round 6/7) has the identical property and was not flagged as blocking in prior rounds. Recommend
`crypto.timingSafeEqual` as a hardening follow-up, not a gate.

## Trade-off disclosure check
`serveHttp`'s `makeHandler({ env, send: () => {} })` — confirmed `send` is a true no-op, so
`notifications/progress` is never emitted over the codex HTTP transport. CONTRACT.md's Event contract
(`{type:'text'|'thinking'|'tool'|'usage'|'error'|'raw'}`) is about the **adapter's own** streaming
Event generator, not the bridge's MCP-level `notifications/progress` — codex's own adapter
(src/adapters/codex.mjs) still yields the full normal Event stream for its own run regardless of this
bridge nuance; what's lost is only *intermediate* progress visibility during the *nested*
codex-delegates-to-bridge hop, which the bridge's `attest`/final-result contract does not depend on.
Disclosure is accurate and the trade-off doesn't silently break any documented behavior.

## Suite results (all executed fresh, live, no mocks; generous timeouts, polled not tailed)
- `registry.test.mjs`: 6/6 pass
- `registry2.test.mjs`: 4/4 pass
- `keydelivery.test.mjs`: 5/5 pass (incl. "codex HTTP transport" — real end-to-end codex→claude run,
  live WMI+disk scan for the whole duration, zero hits, verified attestation succeeded)
- `bridge.test.mjs`: 17/18 pass first run. The one failure ("3-level chain via claude hits recursion
  guard") was claude/haiku giving a generic greeting instead of following the nested-delegation
  instruction — an LLM instruction-following flake, unrelated to codex/N1 code. Reran in isolation:
  passed cleanly (correct recursion-guard text on the first retry).
- `pairs.test.mjs`: 14/15 pass first run (9 pair tests + 6 unit tests). The one failure was
  `claude -> opencode` hitting its 300s timeout on `opencode server listening on` startup — an
  opencode cold-start infra flake, does not touch codex/N1 code at all. Reran in isolation: passed in
  16s. **All 5 codex-involved pairs (claude→codex, codex→claude, codex→codex, codex→opencode,
  opencode→codex) passed on the very first run of the full suite**, each with a verified server
  attestation, correct depth/session/model in the meta, and the secret token flowing only through the
  callee's response (never through anything the caller sent).

Both flakes are non-deterministic-LLM / cold-start issues that predate and are orthogonal to round 8's
change (neither touches codex's env/argv/HTTP-transport code path), reproduced as flakes (not
consistent failures) by immediate reruns. They do not affect the N1 verdict.

## Verdict: N1 is CLOSED, all 9 pairs and bridge -> ours

Round 8 closes the last remaining leg of N1 (codex-as-caller and codex-as-callee argv leak). Verified
independently, live, fresh: no disk leak, no WMI argv leak, across all 5 codex-involved pairs, plus a
direct probe of the new HTTP surface found no unauthenticated read/enumeration, no header/stack leak,
and correct loopback-only binding. `extraArgs` really is a pre-existing generic knob, not a disguised
adapter edit — accurately framed. The only finding is a minor, non-blocking timing-safety hardening
suggestion (non-constant-time bearer-token compare), consistent with an existing pattern already
accepted in prior rounds, not a fresh regression.

Four rounds and eight iterations after N1 was first found (temp-file race), the trust delivery
mechanism has been fully migrated off disk and argv for all three agents (env inheritance for
claude/opencode, in-process HTTP + env-var-name-only for codex) and independently reproduced clean.
