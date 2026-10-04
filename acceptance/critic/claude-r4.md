# claude r4 critic
Verdict: NOT PASSED (real bug).
- BUG (probed with real stdio MCP server, haiku): adapter alone with mcpServers: read-only -> zap DENIED ("requested permissions"), plan -> "Cannot call ... in plan mode", edit -> DENIED, full -> works. Adapter never adds --allowedTools mcp__<server>__*; ADAPTER_NOTES requirement unmet. Fix: add allowedTools for each server in read-only/edit (and decide plan semantics).
- Test gap: mcpServers test only uses permissions:'full', so it cannot catch this.
- Weak test: thinking assertion is a for-loop over possibly zero events -> proves nothing.
- Suite: all listed tests passed on this run (21 lines).
- Not verified (quota/time): lock/finally under forced setup failure, concurrent no-id race, grandchild kill, blind ref comparison.
