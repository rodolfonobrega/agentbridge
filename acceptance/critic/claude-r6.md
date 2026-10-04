# claude round 6 critic
Suite: 37/37 pass, spec reporter, run once, no flakes seen (mcp plan test 10s ok).
Prior defects: r5#1 plan+mcp now allowed (test passes, tool result returned); r5#2 concurrent no-id continue now distinct/BAD_OPTION busy (test passes); r5#3 abort-grandchild test exists and passes.
Plan+MCP loosened assertion: NOT masking a bug. Disk check (readdir == [srv.mjs]) is kept; only the "model attempted Write" output regex was relaxed, and unannotated MCP tools blocked in plan is CLI behavior.
Injection: prompt goes via stdin; model='--dangerously-skip-permissions' consumed as value (AGENT_FAILED model error, no escalation); session.id UUID-checked. extraArgs can override permissions by design (caller-trusted).
Remaining defects (minor):
1. `ours` map never pruned and records ids of sessions whose run failed; a later no-id continue may target a session that never persisted -> AGENT_FAILED instead of BAD_OPTION.
2. fork/continue no-id after a fork resolves to the fork child (newest), not the original; undocumented.
3. Always-on --include-partial-messages; thinking_delta text empty from CLI.
Ref (ai-sdk-provider-claude-code, SDK-based): no process-tree kill, isolation, or ownership guards. Ours better.
Verdict: ours. Gap: in-process-only session ownership (lost across restarts unless adoptForeign).
