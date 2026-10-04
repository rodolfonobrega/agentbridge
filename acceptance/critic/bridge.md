# bridge critic, round 1
Verified: 4 cheap tests pass; malformed JSON, batch, null msg, unknown protocol version, bad args all handled. Real probes (callee-computed 7919*104729=829348951 + callee model id, which the caller cannot know from the prompt): claude->codex, codex->opencode, opencode->claude all genuinely delegated (tool output shows callee model/session; depth=1). So the pairs work.
## Defects
1. pairs.test.mjs proof is weak: nonce is in the task prompt so a caller can echo it; `delegated` only checks a tool-call event name (a failed/denied call still counts). Should assert tool output is non-error and callee computes/holds a secret.
2. `calleeModel` is destructured in subagent.mjs and silently dropped: callee model never set in tests; claude callee ran claude-sonnet-5 (expensive) and codex reported model "default".
3. Permission "plan" ranks equal to read-only (no real plan mode semantic for codex/opencode); `edit`/`full` clamp only by env the launcher sets, no verification the callee adapter enforces it.
4. Codex tool event output normalizes to "[object Object]" (adapter event bug visible via bridge).
5. No default timeout on ask_* calls; cancelled request still emits a result; no stdout-pollution guard (any console.log in imported code corrupts protocol); line buffer O(n^2) on huge payloads. Untested: cancellation, progress, concurrency, large payloads, Windows-space paths.
6. ADAPTER_NOTES: adapters need mcpServers auto-approval; bridge patches via extraArgs (fragile).
## vs Orca (features missing)
Orca has async dispatch + wait/check-output polling, message passing between live agents, fleet status/attention, ask/wait timeout budgets, idempotent retry request ids, dispatch refusal contracts. Ours is synchronous ask/answer only, no worker lifecycle, no retries/idempotency.
