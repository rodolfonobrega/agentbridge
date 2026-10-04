# bridge r2 critic
Verified live (pass): claude->claude, codex->codex, opencode->opencode, opencode->claude. codex default gpt-5.6-luna exists (models_cache: list).
## Proof strength
Mostly sound: fresh random product, requires non-error result with bridge meta, depth 1, session id, model regex. Weak: a caller LLM can compute the product itself and pass it inside the tool prompt; callee just echoes. Meta is regex-fallback parsed from raw output text, so callee text containing "[agentbridge] {...}" could spoof meta (structured parse tried first).
## Findings
1. Dispatched runs not aborted on stdin end (only inflight): bridge death leaves child agents orphaned; 'lost' state only computed on read, never persisted.
2. cancel_run/wait_run on a run owned by another bridge process silently no-ops (returns running/immediately); pid is bridge pid, not agent pid - cannot be killed by external tools, no child pid recorded.
3. cancelRun sets state before kill confirmed; no tree-kill verification in bridge (depends on adapter spawnProc).
4. Idempotency: check-then-write race across processes, key ignores prompt (same key different task returns old run), scans whole dir each dispatch; no TTL/GC of runs dir; list_runs exposes all runs+results to any bridge.
5. execute() mcpConfigFor omits models/home: relies on env inheritance; codex MCP env is explicit so AGENTBRIDGE_MODEL_* and HOME not propagated -> grandchild ignores calleeModel.
6. subagent.mjs still passes redundant --allowedTools mcp__agentbridge__*; adapter already adds it. Harmless duplicate but dead workaround.
7. Run-id traversal safe (/^[\w-]+$/). Codex adapter strips OPENAI keys but passes full process.env otherwise.
8. Batch JSON-RPC returns individual responses, not an array (spec deviation).
## vs Orca
Missing: messaging (send/check/reply/inbox), task DAG, decision gates/questions, worker start/stop/abandon/release/retain, coordinator role, dispatch preambles, keepalive.
