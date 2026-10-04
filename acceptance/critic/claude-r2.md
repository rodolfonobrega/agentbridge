# Critic claude r2
Verdict: OURS (vs ai-sdk-provider-claude-code / claude-code-acp: theirs SDK-based with permission callbacks; ours leaner CLI driver but enforcement is tighter by default: --tools whitelist + empty strict MCP config). 20/20 tests pass (98s).
Verified: read-only no mcp/Bash; unicode+space cwd (`são paulo dir`) continue-without-id resolves correct session; fork noid new id; unknown id -> AGENT_FAILED; xhigh/max accepted on haiku; HOME/CLAUDE_CONFIG_DIR override -> NOT_LOGGED_IN; subagent (Task) works under isolation; login unaffected.
## Bugs
1. plan mode writes a file: `permissions:'plan'` + "run bash echo hi > x" created ~/.claude/plans/run-bash-echo-hi-recursive-bengio.md (outside cwd; cwd file not created). "plan blocks writes" is not literally true; document or deny Write to plans via --disallowedTools.
2. isolated:true still loads project CLAUDE.md (repro: CLAUDE.md "SECRETWORD=BANANA42" in cwd; isolated answered BANANA42). Name/docs imply full isolation; also user memory not verified. Surprising default naming, not a security hole.
3. latestSession = newest mtime jsonl in cwd: races with any concurrent session in same cwd (may resume someone else's). No lock on concurrent continue of one id.
4. models() only scrapes --help aliases; no per-model effort validity (xhigh/max on haiku accepted by CLI silently).
## Biggest gap
Plan-mode side-effect write + isolation that doesn't cover CLAUDE.md; no per-model effort validation.
