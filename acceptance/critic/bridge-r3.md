# bridge r3 critic (interim, updated as tests finish)

Verified by me (own scripts, no agents):
- D1 cross-process cancel is LOST when the owner streams events: B calls cancelRun; owner's next onEvent save() rewrites the whole record with cancelRequested=false before its 500ms poll. Repro: owner emits an event every 5ms, B cancelRun -> after 3s still 'running' (6/6 trials). Real agents stream constantly.
- D2 attestation replay accepted: callId never tracked/bound; same attestation+text re-verifies any number of times (bridgeMeta). Attestation not bound to the caller's prompt/run, so one legit call can be replayed for fabricated results.
- D3 attest key delivered in the callee/caller MCP env: codex puts it on the command line (-c mcp_servers.*.env={...}), claude writes it to a temp mcp.json; visible to a caller with shell (edit/full) via process list/tmp file. Only "read-only" callers are protected.
- D4 bridge.test.mjs 'stdout guard' passes a raw Windows path to `node --import` (needs file:// URL on Node 26.3). The child dies with ERR_UNSUPPORTED_ESM_URL_SCHEME, init() waits forever, so the whole suite hangs until the 400s timeout (no output at all until then).
- D5 inbox check_messages read-modify-write races concurrent send_message appends (message loss); `from` is unauthenticated; any caller can cancel/retain any run id.
- D6 idempotency key is permanent for terminal runs (retry after error/cancelled returns the dead run); after GC the lock points at a missing run and creates an untracked new one.
OK: registry cross-process check/wait/dedupe (8-proc race -> 1 id), different-prompt rejection, owner-kill -> 'lost'.

## Suite results (my runs)
- bridge.test.mjs: 14 pass / 1 FAIL (stdout guard, hangs 400s; see D4). All REAL tests pass incl. cross-process, idempotency, 3 recursion chains (claude 18s, codex 59s, mixed 33s).
- pairs.test.mjs: 13 pass / 2 FAIL: codex->claude and codex->codex fail `callee session id` (attestation sessionId null when codex is caller; D7). Pair timings: opencode->claude 336s, opencode->opencode 318s of a 400s budget (flaky risk, D8). Attestation forging by callee text: rejected (unit test + my attempts); replay accepted (D2).
- D7 codex-caller pairs: meta.sessionId null (2/2 runs).
- D8 opencode-caller runs take ~320-335s for a trivial delegate.

## Verdict: theirs (Orca: worker lifecycle/fleet/attention, real child pid, robust cancel) — biggest gap: cancel/registry state is whole-file last-writer-wins so cross-process cancel/retain are lost under streaming (D1); plus 2/9 pairs red, suite hangs on Windows.
