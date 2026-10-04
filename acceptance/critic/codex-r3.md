# codex r3 critic
Suite: 16/16 pass, 395s total, no hang/quota errors. Slowest: sessions 102s, edit/TEMP 64s, permissions 63s (model latency, not hang).
Executed attacks:
- perms: read-only/plan no writes; edit wrote cwd + writableRoot, NOT TEMP/outside; full wrote everywhere. OK.
- sessions: unknown id continue/fork -> BAD_OPTION; no-id with none -> BAD_OPTION; ephemeral leaves nothing resumable (but result.sessionId is still returned for ephemeral: misleading).
- BUG (confirmed): 2 concurrent no-id continues in same cwd both pick the same newest rollout: one AGENT_FAILED "thread-store conflict", other attached to the other run's thread (answered DELTA). Cross-attach by newest-mtime-by-cwd. Different-cwd runs are fine. Also continue result sessionId undefined when id omitted.
- tool events: one command emits two `tool` events with same id (start w/o output, completed w/ output); not typed start/end.
- bad model: rejected as BAD_OPTION after ~10s, one server 400 round trip (no tokens), 3 duplicate error events emitted.
- jsonSchema OK. mcpServers OK (suite). Timeout grandchild kill passes in suite (taskkill /T); my ad hoc probe inconclusive.
- Windows sandbox disclosure honest (unelevated, reads unrestricted, disclosed in event+result).
Reference: ai-sdk-provider-codex-cli lacks sessions/sandbox disclosure, SIGTERM-only kill; ours wins there.
