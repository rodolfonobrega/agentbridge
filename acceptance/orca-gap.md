# Orca parity: what bridge covers vs. out of scope
Covered: async dispatch_<agent>, wait_run/check_run/cancel_run/list_runs (cross-process via ~/.agentbridge/runs), idempotency keys (atomic O_EXCL, bound to prompt hash), retain_run/release_run (GC exemption), send_message/check_messages (inbox files), timeouts, progress.
Out of scope (and why):
- Live message injection into a RUNNING agent: none of the three CLIs accept stdin input mid `-p`/exec run; inbox is pull-only (agents must call check_messages).
- Real child pid in registry (childPid null): adapters do not surface spawnProc's pid; cancel works via AbortSignal/cancel flag instead. Adapter fix: emit {type:'pid',pid} event.
- Fleet attention/status UI, dispatch refusal contracts, worker reuse across runs (each run is one process; continue via session).

## Round 5 update
Done since: cancel is race-free across processes (control files), no-op on finished runs, root-scoped cancel/retain, server-stamped message sender (fromVerified=false), one-file-per-message inbox.
Still out of scope: live message delivery into a running agent terminal (no CLI supports it), SQLite task/dispatch/gate DB + mutation-request retry identity + post-write settlement verification (file registry only), real childPid (needs adapter {type:'pid'} event).

## Round 7 update
N1 (attest-key exposure) is closed for claude and opencode (verified against the live adapter-mediated spawn path — key never touches disk or inherited-env config; see acceptance/keydelivery.test.mjs). For codex it is NOT closed: codex's own MCP-subprocess spawn provably does not support env inheritance, so the key still goes through codex's `-c mcp_servers.*.env=...` flag and is visible via a live WMI CommandLine query for that child's whole lifetime. This is disclosed as a genuine, tested limitation of the codex CLI's own MCP config transport, not swept under "out of scope."

## Round 8 update
N1 is now closed for all three agents (claude, opencode: env inheritance; codex: streamable-HTTP + bearer-token-env-var, in-process server, no adapter edit). Remaining known gap: progress notifications are not streamed over the codex HTTP transport (only affects live progress visibility during a codex-involved delegation, not correctness/security).
