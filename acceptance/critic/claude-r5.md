# claude round 5 critic
Suite: 34/34 pass (verified, spec reporter).
Probes: session lock ok (by inspection; bad-cwd fails pre-lock, continue after works); own-session ownership ok, foreign ignored, adoptForeign ok, foreign cwd BAD_OPTION;
grandchild dead on timeout AND abort (MCP + Bash child); stream: real token-level text_delta used (69 deltas); thinking_delta text is "" (confirmed, claim true).
FAILS:
1. plan+mcpServers -> BAD_OPTION rationale is FALSE. Raw CLI: --permission-mode plan --allowedTools 'mcp__x__*' returns the tool result (SECRET-8675309). Adapter blocks a working combo; plan should allow it (built-ins stay read-only).
2. Two concurrent no-id continue in one cwd both silently resolve to the last-arrived session (YANKEE,YANKEE) - ambiguous, should throw or require id.
3. No abort-grandchild test in suite; no streaming/partial-messages option in contract (always on).
Refs (ai-sdk-provider-claude-code) use SDK, no process-tree kill/isolation/ownership; ours wins there, but gaps 1-2 are real.
Verdict: fixing.
