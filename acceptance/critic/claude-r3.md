# claude r3 critic
Tests: 23/23 pass. Probes: unknown id -> AGENT_FAILED (ok), bogus config dir -> NOT_LOGGED_IN (ok).
Blind compare vs ai-sdk-provider-claude-code (SDK-wrapper): ours is stronger (isolation flags+env, plan tool whitelist, per-id lock). Ours wins overall.
Bugs:
1. claude.mjs L89-96: lock(resumeId) acquired BEFORE try/finally; mkdtempSync/writeFileSync for mcp.json throwing leaks the lock -> all later continues on that id hang forever.
2. No-id continue/fork: lastByCwd is one slot per cwd, overwritten by any concurrent run (incl. mode new) in same cwd; fallback latestSession picks newest mtime, which can be another live session. Not tested.
3. Locking only in-process, and only for continue (fork/continue racing not serialized) - acceptable but undocumented.
Test gaps: no NOT_LOGGED_IN test, no grandchild-kill test, no thinking delta test, no unknown-id test, no no-id race test. Canary test is discriminating (isolated:false sees it) but relies on env CLAUDE_CODE_DISABLE_CLAUDE_MDS, not the flags.
